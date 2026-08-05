/**
 * The Anthropic client the whole reviewer runs through.
 *
 * Three things this module is responsible for, in order of how badly they hurt
 * when they are wrong:
 *
 *   1. **The call budget is a hard ceiling.** A slot is reserved *before* the
 *      request is issued, so concurrent callers cannot collectively overshoot
 *      `maxCalls`. Retries of one logical call are free — the budget counts
 *      work items, not HTTP attempts.
 *   2. **One bad stage cannot take down the review.** `generateJson` swallows
 *      every failure mode into `null`; a lens that fails is a lens that is
 *      missing, not a review that crashed.
 *   3. **Nothing sensitive is logged.** Label, token counts, stop reason and
 *      duration go to the log. The prompt and the response never do — a review
 *      runs on someone else's diff, and Action logs are frequently public.
 */

import * as core from '@actions/core';
import Anthropic from '@anthropic-ai/sdk';
// @ts-ignore -- the .ts extension is required by `node --experimental-strip-types`
import { extractJson } from './json-repair.ts';

export interface LLMCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
  /** Short identifier for logs, e.g. `lens:security`. Never contains diff content. */
  label: string;
}

export interface LLMResult {
  text: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  label: string;
}

export interface LLMDeps {
  /** Injected Anthropic-shaped client. Only `messages.create` is used. */
  client?: any;
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown by `generate` when the call budget has no slot left. */
export class BudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

/** Attempts per logical call, including the first one. */
const MAX_ATTEMPTS = 3;
/** Backoff before attempt n+1. */
const BACKOFF_MS = [500, 1000, 2000];
/**
 * A cooperative `retry-after` is honoured, but not indefinitely: a workflow that
 * sits idle for ten minutes on a rate limit is a workflow nobody will keep.
 */
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_CONCURRENCY = 4;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Dig an HTTP status out of an error of unknown shape. SDK versions disagree
 * about where they put it, and a fake in a test may put it somewhere else again.
 */
function statusOf(err: unknown): number | null {
  const e = err as Record<string, any> | null;
  if (!e) return null;
  const candidates = [e.status, e.statusCode, e.response?.status, e.cause?.status, e.code];
  for (const candidate of candidates) {
    const n = typeof candidate === 'string' ? Number.parseInt(candidate, 10) : candidate;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 100 && n < 600) return n;
  }
  return null;
}

function headerValue(err: unknown, name: string): string | null {
  const e = err as Record<string, any> | null;
  const headers = e?.headers ?? e?.response?.headers ?? e?.responseHeaders;
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') {
      const value = headers.get(name);
      return value === null || value === undefined ? null : String(value);
    }
    const wanted = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) {
        const value = headers[key];
        return value === null || value === undefined ? null : String(value);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function retryAfterMs(err: unknown): number | null {
  const raw = headerValue(err, 'retry-after');
  if (raw === null) return null;
  const clamp = (ms: number): number => Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.round(ms)));

  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return clamp(seconds * 1000);

  const at = Date.parse(raw);
  if (Number.isFinite(at)) return clamp(at - Date.now());
  return null;
}

/** Connection-level failures have no status but are worth another go. */
function isConnectionError(err: unknown): boolean {
  const e = err as Record<string, any> | null;
  const bits = [e?.name, e?.code, e?.message]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  return /econnreset|econnrefused|etimedout|epipe|enotfound|eai_again|socket hang up|network|fetch failed|connection error|timed? ?out/.test(
    bits,
  );
}

/**
 * 429 (rate limit), 5xx and 529 (overloaded) are worth retrying. 400/401/403/404
 * are the API telling us the request itself is wrong — retrying just burns time
 * and quota to be told the same thing again.
 */
function isRetriableStatus(status: number | null, err: unknown): boolean {
  if (status === null) return isConnectionError(err);
  if (status === 408 || status === 409 || status === 429) return true;
  return status >= 500;
}

/**
 * A log-safe description. Deliberately excludes `message`: API error bodies can
 * echo parts of the request, and the request is someone's source code.
 */
function describeError(err: unknown): string {
  const e = err as Record<string, any> | null;
  const name = typeof e?.name === 'string' && e.name ? e.name : 'Error';
  const status = statusOf(err);
  return status === null ? name : `${name} status=${status}`;
}

/**
 * Join every text block in a response. Handles the shapes that break naive
 * `content[0].text` code: an empty array (a model that said nothing), a first
 * block that is `thinking` or `tool_use`, and several text blocks in a row.
 */
function textFromContent(response: unknown): string {
  const content = (response as Record<string, any> | null)?.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

export class LLMClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly maxCalls: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Slots handed out. Never given back: a failed call still cost API quota. */
  private reserved = 0;
  private client: any;

  constructor(
    apiKey: string,
    model: string,
    defaultMaxTokens: number,
    maxCalls: number,
    deps?: LLMDeps,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.defaultMaxTokens = defaultMaxTokens > 0 ? defaultMaxTokens : 4096;
    this.maxCalls = maxCalls > 0 ? maxCalls : 0;
    this.client = deps?.client ?? null;
    this.sleep =
      deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  getModel(): string {
    return this.model;
  }

  callsMade(): number {
    return this.reserved;
  }

  callsRemaining(): number {
    return Math.max(0, this.maxCalls - this.reserved);
  }

  budgetExhausted(): boolean {
    return this.callsRemaining() <= 0;
  }

  /**
   * Take a budget slot. Synchronous on purpose: the check and the increment
   * happen in one turn of the event loop, so ten concurrent callers with three
   * slots left produce exactly three calls.
   */
  private reserve(): boolean {
    if (this.reserved >= this.maxCalls) return false;
    this.reserved += 1;
    return true;
  }

  private getClient(): any {
    if (!this.client) {
      // maxRetries: 0 — retry policy lives here, and two retry layers multiply.
      this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: 0 });
    }
    return this.client;
  }

  /** One logical call. Throws `BudgetExhaustedError` when no budget is left. */
  async generate(opts: LLMCallOptions): Promise<LLMResult> {
    if (!this.reserve()) {
      throw new BudgetExhaustedError(
        `llm call budget exhausted (${this.maxCalls} calls); "${opts.label}" was not sent`,
      );
    }
    return this.execute(opts);
  }

  private async execute(opts: LLMCallOptions): Promise<LLMResult> {
    const maxTokens = opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : this.defaultMaxTokens;
    let lastError: unknown = new Error('llm call never ran');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      try {
        const response = await this.getClient().messages.create({
          model: this.model,
          max_tokens: maxTokens,
          system: opts.system,
          messages: [{ role: 'user', content: opts.user }],
        });

        const result: LLMResult = {
          text: textFromContent(response),
          stopReason: typeof response?.stop_reason === 'string' ? response.stop_reason : null,
          inputTokens: numberOr(response?.usage?.input_tokens, 0),
          outputTokens: numberOr(response?.usage?.output_tokens, 0),
          label: opts.label,
        };

        core.info(
          `[iolite] llm ${result.label}: ${result.inputTokens} in / ${result.outputTokens} out, ` +
            `stop=${result.stopReason ?? 'unknown'}, ${Date.now() - startedAt}ms`,
        );
        if (result.stopReason === 'max_tokens') {
          // Returned anyway: json-repair salvages what did arrive.
          core.warning(
            `[iolite] llm ${result.label}: hit max_tokens (${maxTokens}); output is truncated`,
          );
        }
        return result;
      } catch (err) {
        lastError = err;
        const status = statusOf(err);
        const isLast = attempt >= MAX_ATTEMPTS;
        if (!isRetriableStatus(status, err) || isLast) {
          core.warning(
            `[iolite] llm ${opts.label}: failed after ${attempt} attempt(s) ` +
              `(${describeError(err)}, ${Date.now() - startedAt}ms)`,
          );
          throw err;
        }
        const wait = retryAfterMs(err) ?? BACKOFF_MS[attempt - 1] ?? 2000;
        core.warning(
          `[iolite] llm ${opts.label}: attempt ${attempt} failed (${describeError(err)}); ` +
            `retrying in ${wait}ms`,
        );
        await this.sleep(wait);
      }
    }

    throw lastError;
  }

  /**
   * Call, then parse the body as JSON. Returns `null` on every failure — budget,
   * API error, empty body, unparseable output — so a single broken stage costs
   * one stage instead of the whole review.
   */
  async generateJson<T>(opts: LLMCallOptions): Promise<T | null> {
    let result: LLMResult;
    try {
      result = await this.generate(opts);
    } catch (err) {
      core.warning(
        `[iolite] llm ${opts.label}: call failed (${describeError(err)}); continuing without it`,
      );
      return null;
    }

    if (result.text.trim().length === 0) {
      core.warning(`[iolite] llm ${opts.label}: empty response body; continuing without it`);
      return null;
    }

    const parsed = extractJson<T>(result.text);
    if (!parsed.ok) {
      core.warning(`[iolite] llm ${opts.label}: unusable JSON (${parsed.note}); continuing without it`);
      return null;
    }
    if (parsed.repaired) {
      core.info(`[iolite] llm ${opts.label}: json repaired (${parsed.note})`);
    }
    return parsed.value;
  }

  /**
   * Run several JSON calls at once. Positional: `result[i]` belongs to
   * `calls[i]`, and a failed or unfunded call is `null` in place. Calls are
   * started in order, so when the budget runs out it is the *later* calls that
   * go unfunded rather than an arbitrary subset.
   */
  async generateJsonAll<T>(
    calls: LLMCallOptions[],
    concurrency: number = DEFAULT_CONCURRENCY,
  ): Promise<(T | null)[]> {
    const results: (T | null)[] = new Array(calls.length).fill(null);
    if (calls.length === 0) return results;

    const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, calls.length));
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= calls.length) return;
        const call = calls[index];
        if (!call) continue;
        results[index] = await this.generateJson<T>(call);
      }
    };

    await Promise.all(Array.from({ length: lanes }, () => worker()));
    return results;
  }
}
