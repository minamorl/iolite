import { PipelineResult, JudgedFinding, Severity } from './types';
import { ReviewerConfig } from './config';
import { PostableComment, applyLimits, LimitResult } from './limits';
import { renderAlternatives } from './alternatives';
import { buildReviewMarker } from './dedupe';
import { SKEPTIC_QUESTIONS, SkepticLens } from './adversary';

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: '🔴 critical',
  major: '🟠 major',
  minor: '🟡 minor',
};

/**
 * Render one finding as a line comment body.
 *
 * The failure scenario leads, because that is the part a human can check in
 * seconds: if the described failure cannot happen, they dismiss the comment and
 * move on. Burying it under a paragraph of reasoning wastes their time.
 */
export function renderCommentBody(j: JudgedFinding): string {
  const f = j.finding;
  const lines: string[] = [];
  lines.push(`**${SEVERITY_LABEL[f.severity]} · ${f.category}** — ${f.claim}`);
  lines.push('');
  lines.push(`**Failure:** ${f.failure}`);
  if (f.evidence) lines.push(`**Evidence:** ${f.evidence}`);
  if (f.fix) lines.push(`**Fix:** ${f.fix}`);

  // Surface a contested survival. A finding that two skeptics waved through is
  // different from one that barely cleared the bar, and hiding that difference
  // would make the confident and the marginal look identical.
  const dissent = j.verdicts.filter((v) => v.refuted);
  if (dissent.length > 0) {
    const reason = dissent[0].reason.trim();
    lines.push('');
    lines.push(
      `_Contested: ${dissent.length}/${j.verdicts.length} skeptic(s) argued against this` +
        (reason ? ` — "${truncate(reason, 200)}"` : '') +
        '. It survived the vote; judge it yourself._'
    );
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export function toPostableComments(survived: JudgedFinding[]): PostableComment[] {
  return survived.map((j) => ({
    path: j.finding.path,
    line: j.finding.line,
    side: 'RIGHT' as const,
    body: renderCommentBody(j),
    severity: j.finding.severity,
    category: j.finding.category,
  }));
}

const RISK_BADGE = {
  low: '🟢 low',
  medium: '🟡 medium',
  high: '🔴 high',
} as const;

export interface RenderedReview {
  body: string;
  comments: PostableComment[];
  limitResult: LimitResult;
}

/**
 * Build the full review: a body that explains what was done and what was
 * rejected, plus the line comments that survived.
 */
export function renderReview(
  result: PipelineResult,
  cfg: ReviewerConfig,
  headSha: string,
  model: string
): RenderedReview {
  const limited = applyLimits(toPostableComments(result.survived), {
    maxCommentsPerFile: cfg.maxCommentsPerFile,
    maxCommentsTotal: cfg.maxCommentsTotal,
    maxCommentBodyChars: cfg.maxCommentBodyChars,
  });

  const s = result.stats;
  const parts: string[] = [];

  parts.push('## iolite review');
  parts.push('');
  parts.push(result.summary.summary);
  parts.push('');
  parts.push(`**Risk:** ${RISK_BADGE[result.summary.riskLevel]}`);
  parts.push('');

  if (result.survived.length === 0) {
    parts.push(
      s.rawFindings > 0
        ? `No findings survived adversarial verification. ${s.rawFindings} candidate(s) were raised ` +
            `and all of them were refuted — either the code does not say what the finder claimed, ` +
            `the case is already handled, or the consequence was theoretical.`
        : 'No findings. The lenses raised nothing on this diff.'
    );
    parts.push('');
  }

  const altSection = renderAlternatives(result.alternatives);
  if (altSection) {
    parts.push(altSection);
    parts.push('');
  }

  // Partial-coverage notices. A review that silently skipped half the diff is
  // worse than no review, because it reads as a clean bill of health.
  const notices: string[] = [];
  if (s.diffTruncated) {
    const names = s.truncatedFiles.slice(0, 8).join(', ');
    const more = s.truncatedFiles.length > 8 ? ` (+${s.truncatedFiles.length - 8} more)` : '';
    notices.push(
      `⚠️ **Partial review.** The diff exceeded the prompt budget, so these files were ` +
        `reviewed incompletely or not at all: ${names}${more}.`
    );
  }
  if (s.lensesFailed.length > 0) {
    notices.push(
      `⚠️ **Reduced coverage.** These lenses failed and contributed nothing: ` +
        `${s.lensesFailed.join(', ')}.`
    );
  }
  if (s.budgetExhausted) {
    notices.push(
      `⚠️ **Budget exhausted.** The model-call ceiling (\`max_llm_calls\`) was hit; ` +
        `later stages may have been skipped.`
    );
  }
  if (limited.droppedForTotalLimit > 0 || limited.droppedForFileLimit > 0) {
    notices.push(
      `⚠️ **Comments capped.** ${limited.droppedForTotalLimit + limited.droppedForFileLimit} ` +
        `surviving finding(s) were not posted to stay under the comment limits ` +
        `(lowest severity dropped first).`
    );
  }
  if (notices.length > 0) {
    parts.push(notices.join('\n\n'));
    parts.push('');
  }

  parts.push('<details><summary>How this review was produced</summary>');
  parts.push('');
  // Describe the skeptics that actually answered, not the ones that were
  // configured. The configured count is capped by how many lenses exist and
  // reduced by any call that failed, so quoting it would claim scrutiny the
  // review did not receive.
  const answered = s.skepticsRun;
  if (answered.length === 0) {
    parts.push(
      cfg.adversarialRounds === 0
        ? 'Adversarial verification was disabled for this run, so every finding below is ' +
            'a single model\'s unchallenged claim. Judge accordingly.'
        : 'No skeptic answered on this run, so nothing below was adversarially verified. ' +
            'Treat each finding as an unchallenged claim.'
    );
  } else {
    const lensList = answered
      .map((lens) => `**${lens}** (${SKEPTIC_QUESTIONS[lens as SkepticLens] ?? '?'})`)
      .join(', ');
    parts.push(
      `Findings are not posted on one model's say-so. Each candidate was attacked by ` +
        `${answered.length} independent skeptic(s), each on a different refutation lens: ` +
        `${lensList}. A finding was dropped when ${s.effectiveThreshold} of them refuted it, ` +
        `and skeptics are instructed to lean toward refuting when uncertain.`
    );
    if (s.skepticsFailed.length > 0) {
      parts.push('');
      parts.push(
        `_${s.skepticsFailed.length} skeptic(s) (${s.skepticsFailed.join(', ')}) failed to ` +
          `answer; their attacks did not run._`
      );
    }
  }
  parts.push('');
  parts.push(`| stage | count |`);
  parts.push(`|---|---|`);
  parts.push(`| lenses run | ${s.lensesRun.join(', ') || '—'} |`);
  parts.push(`| raw candidates | ${s.rawFindings} |`);
  parts.push(`| dropped — no anchor in diff | ${s.anchorDropped} |`);
  parts.push(`| merged as duplicates | ${s.duplicatesMerged} |`);
  parts.push(`| **refuted by skeptics** | **${s.refuted}** |`);
  parts.push(`| **survived** | **${s.survived}** |`);
  parts.push(`| posted | ${limited.kept.length} |`);
  parts.push(`| model calls | ${s.llmCalls} |`);
  parts.push('');
  parts.push(`Model: \`${model}\`. Style, naming, and formatting are deliberately not reviewed.`);
  parts.push('');
  parts.push('</details>');
  parts.push('');
  parts.push(buildReviewMarker(headSha));

  return { body: parts.join('\n'), comments: limited.kept, limitResult: limited };
}
