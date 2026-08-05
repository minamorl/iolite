/**
 * Post-time budget enforcement.
 *
 * The model is *asked* to respect comment budgets in its prompt, but a prompt is
 * a request, not a guarantee. A runaway response must never flood a human's pull
 * request, so the budget is enforced here, in code, immediately before posting.
 *
 * Two rules matter and they pull in different directions:
 *
 *  1. When the budget forces a cut, the *most important* comments must survive
 *     (critical > major > minor).
 *  2. The comments that survive must be emitted in document order, so the review
 *     reads top-to-bottom like a human wrote it.
 *
 * So selection is done in severity order and emission is done in position order.
 * Collapsing those two passes into one is the classic bug in this module.
 */

import type { Severity } from './types';

export interface PostableComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
  severity: Severity;
  category: string;
}

export interface LimitConfig {
  maxCommentsPerFile: number;
  maxCommentsTotal: number;
  maxCommentBodyChars: number;
}

export interface LimitResult {
  kept: PostableComment[];
  droppedForFileLimit: number;
  droppedForTotalLimit: number;
  bodiesClamped: number;
}

/** Appended to a truncated body. Two characters: a space and a horizontal ellipsis. */
const TRUNCATION_SUFFIX = ' …';

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

/** Unknown severities sort last rather than throwing: a weird label is not a reason to drop a finding silently. */
function severityRank(severity: unknown): number {
  const key = typeof severity === 'string' ? severity.trim().toLowerCase() : '';
  const rank = SEVERITY_RANK[key];
  return rank === undefined ? SEVERITY_RANK.minor + 1 : rank;
}

/**
 * Caps come from user configuration, so treat them defensively.
 *
 * A non-finite / missing cap means "no cap" (the config parser already supplies
 * defaults, so this only fires on hand-built configs). An explicit 0 means zero
 * comments — that is a coherent thing to ask for, and it is the safe direction.
 */
function normalizeCap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(value));
}

function lineOf(comment: PostableComment): number {
  const line = comment.line;
  return typeof line === 'number' && Number.isFinite(line) ? line : 0;
}

function pathOf(comment: PostableComment): string {
  return typeof comment.path === 'string' ? comment.path : '';
}

interface OpenSpan {
  open: boolean;
  /** Number of backticks that opened the span. */
  delimLength: number;
  /** Index of the first backtick of the opening run. */
  openStart: number;
  /** Index just past the last backtick of the opening run. */
  openEnd: number;
}

/**
 * Walk markdown backtick runs and report whether an inline code span is still
 * open at the end of the text.
 *
 * A span opened by a run of N backticks is closed only by another run of N, so
 * this handles both `inline` spans and ``` fences without special-casing them.
 */
function scanCodeSpans(text: string): OpenSpan {
  let i = 0;
  let delimLength = 0;
  let openStart = -1;
  let openEnd = -1;

  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] === '`') j += 1;
    const runLength = j - i;

    if (delimLength === 0) {
      delimLength = runLength;
      openStart = i;
      openEnd = j;
    } else if (runLength === delimLength) {
      delimLength = 0;
      openStart = -1;
      openEnd = -1;
    }
    // A run of a different length while a span is open is literal content.
    i = j;
  }

  return { open: delimLength > 0, delimLength, openStart, openEnd };
}

/**
 * Make backticks balance again after a cut.
 *
 * If the opening run is the very tail of the text there is nothing inside the
 * span, so the opener is dropped instead of being closed into an empty ``.
 */
function repairCodeSpan(text: string): string {
  const span = scanCodeSpans(text);
  if (!span.open) return text;
  if (span.openEnd >= text.length) {
    return text.slice(0, span.openStart).replace(/\s+$/, '');
  }
  return text + '`'.repeat(span.delimLength);
}

/** Cut at the last whitespace if one is close to the budget; otherwise cut hard. */
function cutAtWordBoundary(body: string, budget: number): string {
  const raw = body.slice(0, budget);
  if (raw.length === 0) return raw;

  // Already at a boundary: the next character is whitespace, so nothing is split.
  const next = body[budget];
  if (next !== undefined && /\s/.test(next)) return raw.replace(/\s+$/, '');

  const window = Math.min(60, Math.max(12, Math.floor(budget * 0.25)));
  let lastWs = -1;
  for (let i = raw.length - 1; i >= 0 && raw.length - i <= window; i -= 1) {
    if (/\s/.test(raw[i]!)) {
      lastWs = i;
      break;
    }
  }
  if (lastWs > 0) return raw.slice(0, lastWs);
  return raw;
}

/**
 * Truncate a comment body to `maxChars`, preferring a word boundary and never
 * leaving markdown inline code unbalanced.
 *
 * `maxChars <= 0` disables truncation. The returned string is never longer than
 * `maxChars` (the ellipsis and any repair backticks are paid for out of the same
 * budget).
 */
export function clampBody(body: string, maxChars: number): string {
  const text = typeof body === 'string' ? body : String(body ?? '');
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || maxChars <= 0) return text;

  const limit = Math.floor(maxChars);
  if (text.length <= limit) return text;
  // Not enough room for the ellipsis itself: a hard cut is all that is left.
  if (limit <= TRUNCATION_SUFFIX.length) return text.slice(0, limit);

  let budget = limit - TRUNCATION_SUFFIX.length;
  for (let attempt = 0; attempt < 6 && budget > 0; attempt += 1) {
    const cut = cutAtWordBoundary(text, budget).replace(/\s+$/, '');
    const candidate = repairCodeSpan(cut) + TRUNCATION_SUFFIX;
    if (candidate.length <= limit) return candidate;
    budget -= candidate.length - limit;
  }
  return text.slice(0, limit);
}

/**
 * Enforce the per-file cap, the total cap, and the per-body character cap.
 *
 * Selection is by severity (stable within a severity, so the model's own
 * ordering is preserved); emission is by document position. Input is never
 * mutated.
 */
export function applyLimits(comments: PostableComment[], limits: LimitConfig): LimitResult {
  const list = Array.isArray(comments) ? comments.filter((c): c is PostableComment => !!c) : [];
  const perFileCap = normalizeCap(limits?.maxCommentsPerFile);
  const totalCap = normalizeCap(limits?.maxCommentsTotal);
  const bodyCap =
    typeof limits?.maxCommentBodyChars === 'number' && Number.isFinite(limits.maxCommentBodyChars)
      ? limits.maxCommentBodyChars
      : 0;

  // --- pass 1: pick what survives, most important first -------------------
  const byPriority = list.map((_, index) => index);
  byPriority.sort((a, b) => {
    const bySeverity = severityRank(list[a]!.severity) - severityRank(list[b]!.severity);
    if (bySeverity !== 0) return bySeverity;
    return a - b; // stable: input order inside a severity
  });

  const keptIndices: number[] = [];
  const usedPerFile = new Map<string, number>();
  let droppedForFileLimit = 0;
  let droppedForTotalLimit = 0;

  for (const index of byPriority) {
    const comment = list[index]!;
    const path = pathOf(comment);
    const used = usedPerFile.get(path) ?? 0;
    if (used >= perFileCap) {
      droppedForFileLimit += 1;
      continue;
    }
    if (keptIndices.length >= totalCap) {
      droppedForTotalLimit += 1;
      continue;
    }
    usedPerFile.set(path, used + 1);
    keptIndices.push(index);
  }

  // --- pass 2: emit in document order -------------------------------------
  // Sort the *indices* we selected. Nothing is looked up by value, so duplicate
  // (path, line) pairs cannot collapse into one another or go missing.
  const selectionOrder = new Map<number, number>();
  keptIndices.forEach((index, position) => selectionOrder.set(index, position));

  const ordered = keptIndices.slice().sort((a, b) => {
    const pa = pathOf(list[a]!);
    const pb = pathOf(list[b]!);
    if (pa < pb) return -1;
    if (pa > pb) return 1;
    const la = lineOf(list[a]!);
    const lb = lineOf(list[b]!);
    if (la !== lb) return la - lb;
    // Same anchor: fall back to selection order, so the more severe comment
    // still comes first and the result stays deterministic.
    return (selectionOrder.get(a) ?? 0) - (selectionOrder.get(b) ?? 0);
  });

  // --- pass 3: clamp bodies of what is actually going out -----------------
  let bodiesClamped = 0;
  const kept = ordered.map((index) => {
    const comment = list[index]!;
    const original = typeof comment.body === 'string' ? comment.body : String(comment.body ?? '');
    const clamped = clampBody(original, bodyCap);
    if (clamped !== original) bodiesClamped += 1;
    return { ...comment, body: clamped };
  });

  return { kept, droppedForFileLimit, droppedForTotalLimit, bodiesClamped };
}
