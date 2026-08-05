import * as core from '@actions/core';

/**
 * Read an Action input, falling back to a plain env var so the reviewer can be
 * driven outside the Action runtime (local runs, tests).
 */
function input(name: string, legacyEnv?: string): string {
  const fromInput = core.getInput(name);
  if (fromInput) return fromInput;
  if (legacyEnv && process.env[legacyEnv]) return process.env[legacyEnv]!;
  return '';
}

function bool(name: string, legacyEnv: string, fallback: boolean): boolean {
  const raw = input(name, legacyEnv).trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function splitList(s: string): string[] {
  return s
    .split(/\r?\n|,/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function positiveInt(s: string | undefined, fallback: number): number {
  const n = parseInt(s ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(s: string | undefined, fallback: number): number {
  const n = parseInt(s ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Lenses the finder stage knows how to run. Unknown names are ignored. */
export const KNOWN_LENSES = [
  'correctness',
  'security',
  'performance',
  'integration',
  'test',
] as const;

export type LensName = (typeof KNOWN_LENSES)[number];

export interface ReviewerConfig {
  projectName: string;
  promptInline: string;
  promptFileRel: string;
  includePaths: string[];
  excludePaths: string[];
  reviewSelf: boolean;

  lenses: LensName[];
  adversarialRounds: number;
  refuteThreshold: number;
  completenessPass: boolean;
  exploreAlternatives: boolean;
  maxLlmCalls: number;

  maxCommentsPerFile: number;
  maxCommentsTotal: number;
  maxCommentBodyChars: number;
}

/**
 * Parse the lens list, keeping only names the finder implements and preserving
 * the caller's order. Falls back to the full default set when nothing valid is
 * given — an empty lens list would mean "review nothing", which is never what
 * someone meant to configure.
 */
export function parseLenses(raw: string): LensName[] {
  const requested = splitList(raw).map((s) => s.toLowerCase());
  const known = new Set<string>(KNOWN_LENSES);
  const picked = requested.filter((s): s is LensName => known.has(s));
  const deduped = [...new Set(picked)];
  if (deduped.length > 0) return deduped;
  return ['correctness', 'security', 'performance', 'integration'];
}

/**
 * Clamp the refute threshold into a range that is actually meaningful for the
 * configured number of skeptics. A threshold above the skeptic count would make
 * refutation impossible (nothing could ever be dropped); a threshold of 0 would
 * drop everything.
 */
export function clampRefuteThreshold(threshold: number, rounds: number): number {
  if (rounds <= 0) return 0;
  if (threshold < 1) return 1;
  if (threshold > rounds) return rounds;
  return threshold;
}

export function loadConfig(): ReviewerConfig {
  const adversarialRounds = nonNegativeInt(input('adversarial_rounds', 'ADVERSARIAL_ROUNDS'), 3);
  const rawThreshold = positiveInt(input('refute_threshold', 'REFUTE_THRESHOLD'), 2);

  return {
    projectName: (input('project_name', 'PROJECT_NAME') || 'this repository').trim(),
    promptInline: input('prompt_inline', 'PROMPT_INLINE').trim(),
    promptFileRel: input('prompt_file', 'PROMPT_FILE').trim(),
    includePaths: splitList(input('include_paths', 'INCLUDE_PATHS')),
    excludePaths: splitList(input('exclude_paths', 'EXCLUDE_PATHS')),
    reviewSelf: bool('review_self', 'REVIEW_SELF', false),

    lenses: parseLenses(input('lenses', 'LENSES')),
    adversarialRounds,
    refuteThreshold: clampRefuteThreshold(rawThreshold, adversarialRounds),
    completenessPass: bool('completeness_pass', 'COMPLETENESS_PASS', true),
    exploreAlternatives: bool('explore_alternatives', 'EXPLORE_ALTERNATIVES', true),
    maxLlmCalls: positiveInt(input('max_llm_calls', 'MAX_LLM_CALLS'), 16),

    maxCommentsPerFile: positiveInt(input('max_comments_per_file', 'MAX_COMMENTS_PER_FILE'), 10),
    maxCommentsTotal: positiveInt(input('max_comments_total', 'MAX_COMMENTS_TOTAL'), 40),
    maxCommentBodyChars: positiveInt(input('max_comment_body_chars', 'MAX_COMMENT_BODY_CHARS'), 700),
  };
}
