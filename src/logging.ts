/**
 * Logging that cannot leak.
 *
 * Two hazards, both handled here rather than at every call site:
 *
 *  1. **Credentials.** The Anthropic key and the GitHub token pass through this
 *     process, and Action logs are world-readable on a public repository. Every
 *     message is run through {@link redact} on the way out, so a caller cannot
 *     leak a token by logging the wrong variable.
 *  2. **Content.** Raw model responses, diffs, and PR bodies are never logged,
 *     verbose or not. They are the user's code and the model's unreviewed
 *     output; neither belongs in a build log. {@link preview} exists for short,
 *     deliberate snippets and is hard-capped so it cannot be used to dump a
 *     diff one call at a time.
 */

import * as core from '@actions/core';

/** Carriage return, spelled without an escape sequence on purpose. */
const CR = String.fromCharCode(13);

// ---------------------------------------------------------------------------
// verbosity
// ---------------------------------------------------------------------------

let verboseCache: boolean | null = null;

function readDebugInput(): string {
  try {
    const fromInput = core.getInput('debug');
    if (fromInput) return fromInput;
  } catch {
    // Not running under the Action runtime. Fall back to the env var.
  }
  return process.env.INPUT_DEBUG ?? process.env.IOLITE_DEBUG ?? '';
}

function computeVerbose(): boolean {
  // The runner sets this when a maintainer re-runs a job with debug logging.
  if (process.env.RUNNER_DEBUG === '1') return true;
  const raw = readDebugInput().trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/** Verbose diagnostics are opt-in: the `debug` input, or `RUNNER_DEBUG=1`. */
export function isVerbose(): boolean {
  if (verboseCache === null) verboseCache = computeVerbose();
  return verboseCache;
}

/** Drop the memoized answer. Exists so tests can change the environment. */
export function resetVerboseCache(): void {
  verboseCache = null;
}

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

/**
 * Credential shapes, most specific first. The last rule is the catch-all: a long
 * unbroken run of base64/base64url characters is a secret far more often than it
 * is prose, and masking an occasional long path is a cheap price for never
 * printing a key.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Anthropic API keys.
  [/sk-ant-[A-Za-z0-9_-]+/g, '***'],
  // GitHub tokens: ghp_ (classic PAT), gho_ (OAuth), ghs_ (server-to-server,
  // what GITHUB_TOKEN is), plus ghu_/ghr_ from the same family.
  [/(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]+/g, '***'],
  [/(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]+/g, '***'],
  // Authorization headers. The scheme survives so the log still reads sensibly.
  [/(?<![A-Za-z0-9_])bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***'],
  // Anything else long and token-shaped.
  [/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}(?![A-Za-z0-9+/_-])/g, '***'],
];

/** Mask anything that looks like a credential. Ordinary prose is left alone. */
export function redact(s: string): string {
  if (typeof s !== 'string') return s === undefined || s === null ? '' : String(s);
  let out = s;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    // Each pattern is /g; exec state is never carried because replace() resets
    // lastIndex itself, but the regex objects are module-level and shared, so
    // nothing here may use exec/test on them.
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Redact, then defuse workflow commands.
 *
 * The runner interprets a line beginning with `::` as a command, so an
 * attacker-controlled string reaching the log must not be able to open one.
 */
function sanitizeForLog(message: unknown): string {
  const text = typeof message === 'string' ? message : String(message ?? '');
  return redact(text).split(CR).join('').replace(/^::/gm, ' ::');
}

// ---------------------------------------------------------------------------
// emission
// ---------------------------------------------------------------------------

function write(kind: 'info' | 'warn', message: string): void {
  const safe = sanitizeForLog(message);
  try {
    if (kind === 'warn') core.warning(safe);
    else core.info(safe);
    return;
  } catch {
    // @actions/core is unavailable or the runner rejected the write; the log
    // line still has to come out somewhere.
  }
  if (kind === 'warn') console.error(safe);
  else console.log(safe);
}

/** Diagnostic detail. Silent unless verbose is on. Never carries content. */
export function debugLog(message: string): void {
  if (!isVerbose()) return;
  write('info', `[iolite:debug] ${message}`);
}

export function info(message: string): void {
  write('info', `[iolite] ${message}`);
}

export function warn(message: string): void {
  write('warn', `[iolite] ${message}`);
}

// ---------------------------------------------------------------------------
// previews
// ---------------------------------------------------------------------------

/**
 * Hard ceiling, independent of what the caller asks for. `preview` is for
 * snippets; the cap is what stops it from becoming a way to log a whole diff.
 */
const PREVIEW_HARD_MAX = 240;

/** A short, redacted, single-line snippet. Never a diff, body, or model reply. */
export function preview(s: string, max = 120): string {
  if (typeof s !== 'string' || s === '') return '';
  const requested =
    typeof max === 'number' && Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 120;
  const limit = Math.min(PREVIEW_HARD_MAX, requested);
  if (limit === 0) return '';

  const collapsed = redact(s).replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, Math.max(0, limit - 1))}…`;
}
