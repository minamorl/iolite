import {
  Finding,
  Verdict,
  JudgedFinding,
  Alternative,
  PipelineResult,
  PipelineStats,
  ReviewSummary,
} from './types';
import { ReviewerConfig, clampRefuteThreshold } from './config';
import { LLMClient, LLMCallOptions } from './llm';
import { ParsedDiff, RenderedDiff, snapToCommentableLine, isCommentableLine } from './diff-parser';
import { PRInfo, IssueInfo } from './github';
import { buildLensCall, buildCompletenessCall, parseFindings, FinderContext } from './lenses';
import {
  SKEPTIC_LENSES,
  buildSkepticCall,
  parseVerdicts,
  judge,
  dedupeFindings,
  AdversaryContext,
} from './adversary';
import { buildAlternativesCall, parseAlternatives } from './alternatives';
import { debugLog, info, warn } from './logging';

export interface PipelineDeps {
  llm: LLMClient;
  cfg: ReviewerConfig;
  parsed: ParsedDiff;
  rendered: RenderedDiff;
  prInfo: PRInfo;
  issueInfo: IssueInfo | null;
  policy: string;
  selfReview: boolean;
}

/**
 * Anchor a finding to a line GitHub will actually accept a comment on.
 *
 * Models cite line numbers that are close but not exact often enough that
 * dropping every near miss would throw away real bugs; accepting them blindly
 * would put comments on unrelated code. So: exact hits pass, near misses snap
 * to the closest commentable line, and anything further out is dropped.
 */
function anchorFinding(finding: Finding, parsed: ParsedDiff): Finding | null {
  if (isCommentableLine(parsed, finding.path, finding.line)) return finding;
  const snapped = snapToCommentableLine(parsed, finding.path, finding.line, 5);
  if (snapped === null) return null;
  return { ...finding, line: snapped };
}

function anchorAll(
  findings: Finding[],
  parsed: ParsedDiff
): { anchored: Finding[]; dropped: number } {
  const anchored: Finding[] = [];
  let dropped = 0;
  for (const f of findings) {
    const a = anchorFinding(f, parsed);
    if (a) anchored.push(a);
    else dropped++;
  }
  return { anchored, dropped };
}

/**
 * Re-key findings so ids stay unique across rounds. The adversary stage matches
 * verdicts to findings by id, so a collision between a round-one and a
 * round-two finding would silently transfer one finding's verdicts to another.
 */
function rekey(findings: Finding[], prefix: string): Finding[] {
  return findings.map((f, i) => ({ ...f, id: `${prefix}-${i}` }));
}

interface FindingsResponse {
  findings?: unknown;
}

interface VerdictsResponse {
  verdicts?: unknown;
}

interface AlternativesResponse {
  alternatives?: unknown;
  summary?: unknown;
  risk_level?: unknown;
}

function coerceRisk(value: unknown): 'low' | 'medium' | 'high' {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (s === 'high' || s === 'critical') return 'high';
  if (s === 'medium' || s === 'moderate') return 'medium';
  return 'low';
}

/**
 * Derive the headline risk from what actually survived, not from what the model
 * claimed. A model that says "low risk" while three critical findings survived
 * adversarial verification is simply wrong, and the surviving findings are the
 * harder evidence.
 */
function deriveRisk(survived: JudgedFinding[], modelClaim: unknown): 'low' | 'medium' | 'high' {
  const claimed = coerceRisk(modelClaim);
  const hasCritical = survived.some((j) => j.finding.severity === 'critical');
  const majors = survived.filter((j) => j.finding.severity === 'major').length;
  if (hasCritical || majors >= 3) return 'high';
  if (majors >= 1) return claimed === 'high' ? 'high' : 'medium';
  return claimed;
}

export async function runPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const { llm, cfg, parsed, rendered, prInfo, issueInfo, policy, selfReview } = deps;

  const stats: PipelineStats = {
    llmCalls: 0,
    lensesRun: [],
    lensesFailed: [],
    rawFindings: 0,
    anchorDropped: 0,
    duplicatesMerged: 0,
    refuted: 0,
    survived: 0,
    diffTruncated: rendered.truncated,
    truncatedFiles: rendered.truncatedFiles,
    budgetExhausted: false,
    skepticsRun: [],
    skepticsFailed: [],
    effectiveThreshold: 0,
  };

  const finderCtx: FinderContext = {
    cfg,
    policy,
    numberedDiff: rendered.text,
    prInfo,
    issueInfo,
    selfReview,
  };

  // ---- Stage 1: independent multi-lens sweep -----------------------------
  // Each lens is blind to the others. That blindness is the point: shared
  // context would make them converge on the same obvious defect instead of
  // covering different ground.
  const lensCalls: LLMCallOptions[] = cfg.lenses.map((lens) => buildLensCall(lens, finderCtx));
  const lensResults = await llm.generateJsonAll<FindingsResponse>(lensCalls);

  let round1: Finding[] = [];
  lensResults.forEach((res, i) => {
    const lens = cfg.lenses[i];
    if (res === null) {
      stats.lensesFailed.push(lens);
      return;
    }
    stats.lensesRun.push(lens);
    round1.push(...parseFindings(res.findings, lens));
  });
  stats.rawFindings += round1.length;

  const anchored1 = anchorAll(round1, parsed);
  stats.anchorDropped += anchored1.dropped;
  round1 = anchored1.anchored;

  const merged1 = dedupeFindings(round1);
  stats.duplicatesMerged += merged1.mergedCount;
  round1 = rekey(merged1.merged, 'r1');

  info(
    `finder: ${stats.lensesRun.length}/${cfg.lenses.length} lenses ok, ` +
      `${round1.length} findings after anchoring and dedupe`
  );

  // ---- Stage 2: completeness critic --------------------------------------
  // Sees round one and hunts for what every lens missed. Run even when round
  // one is empty: "nothing found" is exactly the case where a second look pays.
  let allFindings = round1;
  if (cfg.completenessPass && !llm.budgetExhausted()) {
    const critic = await llm.generateJson<FindingsResponse>(
      buildCompletenessCall(finderCtx, round1)
    );
    if (critic) {
      const extra = parseFindings(critic.findings, 'completeness');
      stats.rawFindings += extra.length;
      const anchored2 = anchorAll(extra, parsed);
      stats.anchorDropped += anchored2.dropped;
      const combined = dedupeFindings([...round1, ...anchored2.anchored]);
      stats.duplicatesMerged += combined.mergedCount;
      allFindings = rekey(combined.merged, 'f');
      info(`completeness: +${anchored2.anchored.length} raw, ${allFindings.length} total`);
    } else {
      warn('completeness pass produced nothing usable; continuing with round one');
      allFindings = rekey(round1, 'f');
    }
  } else {
    allFindings = rekey(round1, 'f');
  }

  // ---- Stage 3 & 4: adversarial verification, and the design question -----
  // These are independent, so they run together. Alternatives also carries the
  // summary, which saves a call: the model that just reasoned about the whole
  // change is the one best placed to describe it.
  // The configured round count is a request, not an outcome: only as many
  // skeptics can run as there are lenses. The threshold must be clamped against
  // what will ACTUALLY run rather than against the request — otherwise
  // `adversarial_rounds: 8` produces five skeptics and a threshold of eight,
  // which five verdicts can never reach, silently disabling the adversary stage
  // in precisely the configuration that asked for more of it.
  const effectiveRounds = Math.min(cfg.adversarialRounds, SKEPTIC_LENSES.length);
  const effectiveThreshold = clampRefuteThreshold(cfg.refuteThreshold, effectiveRounds);
  const advCfg: ReviewerConfig = {
    ...cfg,
    adversarialRounds: effectiveRounds,
    refuteThreshold: effectiveThreshold,
  };
  stats.effectiveThreshold = effectiveThreshold;

  const advCtx: AdversaryContext = {
    cfg: advCfg,
    numberedDiff: rendered.text,
    policy,
    projectName: cfg.projectName,
  };

  const skepticLenses =
    effectiveRounds > 0 && allFindings.length > 0 ? SKEPTIC_LENSES.slice(0, effectiveRounds) : [];
  const skepticCalls: LLMCallOptions[] = skepticLenses.map((lens) =>
    buildSkepticCall(lens, allFindings, advCtx)
  );

  const wantAlternatives = cfg.exploreAlternatives;
  const alternativesCall = wantAlternatives
    ? buildAlternativesCall({ cfg, numberedDiff: rendered.text, policy, prInfo, issueInfo })
    : null;

  const combinedCalls: LLMCallOptions[] = [...skepticCalls];
  if (alternativesCall) combinedCalls.push(alternativesCall);

  const combinedResults = await llm.generateJsonAll<unknown>(combinedCalls);

  const verdicts: Verdict[] = [];
  skepticLenses.forEach((lens, i) => {
    const res = combinedResults[i] as VerdictsResponse | null;
    if (res === null) {
      stats.skepticsFailed.push(lens);
      warn(`skeptic '${lens}' failed; its votes are absent (findings are not saved by default)`);
      return;
    }
    stats.skepticsRun.push(lens);
    verdicts.push(...parseVerdicts(res.verdicts, lens));
  });

  const altRes = alternativesCall
    ? (combinedResults[skepticCalls.length] as AlternativesResponse | null)
    : null;

  const alternatives: Alternative[] = altRes ? parseAlternatives(altRes.alternatives) : [];

  // ---- Stage 5: judge ----------------------------------------------------
  const judged = judge(allFindings, verdicts, advCfg);
  const survived = judged.filter((j) => j.survived);
  const killed = judged.filter((j) => !j.survived);
  stats.survived = survived.length;
  stats.refuted = killed.length;
  stats.llmCalls = llm.callsMade();
  stats.budgetExhausted = llm.budgetExhausted();

  debugLog(
    `adversary: ${verdicts.length} verdicts over ${allFindings.length} findings, ` +
      `${killed.length} killed at threshold ${effectiveThreshold}`
  );

  const summaryText =
    typeof altRes?.summary === 'string' && altRes.summary.trim().length > 0
      ? altRes.summary.trim()
      : fallbackSummary(prInfo, survived.length);

  const summary: ReviewSummary = {
    summary: summaryText,
    riskLevel: deriveRisk(survived, altRes?.risk_level),
  };

  return { summary, survived, killed, alternatives, stats };
}

function fallbackSummary(prInfo: PRInfo, survivedCount: number): string {
  const scale = `+${prInfo.additions} -${prInfo.deletions} across ${prInfo.changedFiles} file(s)`;
  return survivedCount === 0
    ? `${prInfo.title} (${scale}). No findings survived adversarial verification.`
    : `${prInfo.title} (${scale}). ${survivedCount} finding(s) survived adversarial verification.`;
}
