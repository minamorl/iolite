/**
 * Shared types for the iolite adversarial reviewer.
 *
 * Design note: this reviewer does NOT report code style. There is no `nit`
 * severity and no `style` category — those exist to make reviews look busy.
 * What survives here is the set of things that can actually be wrong: the code
 * breaks, the code is exploitable, the code is slow, the code is the wrong
 * design, or the change is untested where it matters.
 */

export type Severity = 'critical' | 'major' | 'minor';

export type Category = 'security' | 'bug' | 'design' | 'performance' | 'test';

export const SEVERITIES: readonly Severity[] = ['critical', 'major', 'minor'];
export const CATEGORIES: readonly Category[] = [
  'security',
  'bug',
  'design',
  'performance',
  'test',
];

/**
 * A single claim about the diff, produced by one lens.
 *
 * `evidence` is mandatory and must quote the diff. A finding whose evidence
 * cannot be tied back to a real changed line is dropped before it ever reaches
 * the adversary stage: an assertion with no anchor is not a finding, it is a
 * guess.
 */
export interface Finding {
  /** Stable id assigned by the pipeline (`<lens>-<n>`). Used to match verdicts. */
  id: string;
  path: string;
  /** Absolute RIGHT-side line number in the post-image of the diff. */
  line: number;
  severity: Severity;
  category: Category;
  /** What is wrong, in one sentence. */
  claim: string;
  /** The concrete code/state that makes the claim true. Quotes the diff. */
  evidence: string;
  /** A concrete failure: inputs or state → wrong behavior. */
  failure: string;
  /** How to fix it, short. */
  fix: string;
  /** Which lens produced this. */
  lens: string;
}

/** One skeptic's judgement on one finding. */
export interface Verdict {
  id: string;
  /** true when the skeptic believes the finding is wrong, already handled, or harmless. */
  refuted: boolean;
  /** 0..1 — how sure the skeptic is. Low confidence non-refutals do not save a finding. */
  confidence: number;
  reason: string;
  /** Which skeptic lens produced this. */
  skeptic: string;
}

/** A finding that has been through the adversary stage. */
export interface JudgedFinding {
  finding: Finding;
  verdicts: Verdict[];
  refuteVotes: number;
  survived: boolean;
}

/**
 * A proposal that the change, as designed, is not the best available shape.
 * These are never line comments — they are design-level and go in the review
 * body, because attaching an architecture argument to line 42 is noise.
 */
export interface Alternative {
  title: string;
  /** Why the current approach is worth reconsidering. Cites the diff. */
  rationale: string;
  /** What the alternative costs. An alternative with no tradeoff is a fantasy. */
  tradeoff: string;
  /** A few lines sketching the shape. Not a full implementation. */
  sketch: string;
  /** 'strong' when the author should probably change course; 'worth_considering' otherwise. */
  strength: 'strong' | 'worth_considering';
}

export interface ReviewSummary {
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
}

/** Everything the pipeline produces, before it is rendered into a GitHub review. */
export interface PipelineResult {
  summary: ReviewSummary;
  survived: JudgedFinding[];
  killed: JudgedFinding[];
  alternatives: Alternative[];
  stats: PipelineStats;
}

export interface PipelineStats {
  llmCalls: number;
  lensesRun: string[];
  lensesFailed: string[];
  failedStages: string[];
  rawFindings: number;
  anchorDropped: number;
  duplicatesMerged: number;
  refuted: number;
  survived: number;
  diffTruncated: boolean;
  truncatedFiles: string[];
  budgetExhausted: boolean;

  /**
   * Skeptics that actually ran and answered, and the threshold actually applied.
   *
   * These are recorded rather than re-derived from config because the configured
   * values are requests, not outcomes: the number of skeptics is capped by how
   * many lenses exist, and a skeptic whose call failed contributes nothing. A
   * review body that quoted the config would claim scrutiny that never happened.
   */
  skepticsRun: string[];
  skepticsFailed: string[];
  effectiveThreshold: number;
}
