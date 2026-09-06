import * as fs from 'fs';
import * as core from '@actions/core';
import { GitHubClient } from './github';
import { LLMClient } from './llm';
import { loadConfig, ReviewerConfig } from './config';
import { parseUnifiedDiff, filterByPaths, renderDiffForPrompt } from './diff-parser';
import { runPipeline } from './pipeline';
import { renderReview } from './render';
import { isReviewComplete } from './review-status';
import { isReviewTriggerAllowed, describePermissionDenial } from './permission';
import { hasReviewedSha, isForceRerunRequested } from './dedupe';
import { normalizePolicyPath, summarizePolicySource } from './policy-loader';
import { info, warn, debugLog } from './logging';

interface EventPayload {
  action?: string;
  pull_request?: { number?: number };
  issue?: { number?: number; pull_request?: unknown };
  comment?: { body?: string; user?: { login?: string } };
  repository?: { name?: string; owner?: { login?: string } };
}

/**
 * Structurally validate the parsed event payload. A malformed payload must
 * degrade to "no event info" rather than throwing — the run can still proceed
 * from environment variables and the pr_number input.
 */
function asEventPayload(value: unknown): EventPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as EventPayload;
}

function readEventPayload(): EventPayload {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    warn('No event payload found; falling back to environment variables.');
    return {};
  }
  try {
    return asEventPayload(JSON.parse(fs.readFileSync(eventPath, 'utf-8')));
  } catch (e) {
    warn(`Could not parse the event payload (${e instanceof Error ? e.message : String(e)}).`);
    return {};
  }
}

function resolveRepo(payload: EventPayload): { owner: string; repo: string } {
  const envRepo = process.env.GITHUB_REPOSITORY ?? '';
  const [envOwner, envName] = envRepo.includes('/') ? envRepo.split('/') : ['', ''];
  const owner = payload.repository?.owner?.login || process.env.GITHUB_REPOSITORY_OWNER || envOwner;
  const repo = payload.repository?.name || envName;
  if (!owner || !repo) {
    throw new Error(
      `Could not determine the repository (owner=${owner || '?'}, repo=${repo || '?'}, ` +
        `GITHUB_REPOSITORY=${envRepo || 'unset'}).`
    );
  }
  return { owner, repo };
}

function resolvePrNumber(payload: EventPayload): number {
  const fromInput = parseInt(core.getInput('pr_number') || process.env.PR_NUMBER || '', 10);
  const n =
    payload.pull_request?.number ??
    (payload.issue?.pull_request ? payload.issue?.number : undefined) ??
    (Number.isFinite(fromInput) ? fromInput : undefined);
  if (!n || n <= 0) {
    throw new Error('No pull request number found in the event payload, pr_number, or PR_NUMBER.');
  }
  return n;
}

/**
 * Decide whether this event should produce a review at all.
 *
 * The `/review` path is gated on write access on purpose: issue_comment runs
 * with the base repo's token, so without this check anyone who can comment
 * could burn the repository's Anthropic budget on demand.
 */
async function shouldRun(
  gh: GitHubClient,
  payload: EventPayload,
  eventName: string | undefined
): Promise<boolean> {
  if (eventName === 'pull_request') {
    const action = payload.action;
    if (action && !['opened', 'ready_for_review', 'synchronize', 'reopened'].includes(action)) {
      info(`Skipping: pull_request action '${action}' is not a review trigger.`);
      return false;
    }
    return true;
  }

  if (eventName === 'issue_comment') {
    const body = payload.comment?.body ?? '';
    if (!/\/review\b/.test(body)) {
      info('Skipping: comment does not contain /review.');
      return false;
    }
    const actor = payload.comment?.user?.login || process.env.GITHUB_ACTOR || '';
    if (!actor) {
      warn('Skipping /review: the commenting user could not be determined.');
      return false;
    }
    const permission = await gh.getUserPermission(actor);
    if (!isReviewTriggerAllowed(permission)) {
      info(describePermissionDenial(actor, permission));
      return false;
    }
    info(`/review authorized for @${actor} (permission=${permission}).`);
    return true;
  }

  return true;
}

/**
 * Load the review policy.
 *
 * `prompt_inline` lives in the workflow file, which only writers can change, so
 * it is trusted. `prompt_file` is read from the BASE ref rather than the PR
 * head, so a pull request cannot rewrite the standards it is about to be judged
 * against — that is the whole reason the base ref is used here.
 */
async function loadPolicy(
  gh: GitHubClient,
  cfg: ReviewerConfig,
  baseRef: string
): Promise<string> {
  if (cfg.promptInline) return cfg.promptInline;
  if (!cfg.promptFileRel) return '';
  let safePath: string;
  try {
    safePath = normalizePolicyPath(cfg.promptFileRel);
  } catch (e) {
    warn(`Ignoring prompt_file: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
  const content = await gh.getFileContent(safePath, baseRef);
  if (!content) {
    warn(`prompt_file '${safePath}' was not found on the base ref '${baseRef}'; continuing without a policy.`);
  }
  return content;
}

async function run(): Promise<void> {
  const githubToken = core.getInput('github_token') || process.env.GITHUB_TOKEN || '';
  const anthropicApiKey = core.getInput('anthropic_api_key') || process.env.ANTHROPIC_API_KEY || '';
  if (!githubToken) throw new Error('github_token (or GITHUB_TOKEN) is required.');
  if (!anthropicApiKey) throw new Error('anthropic_api_key (or ANTHROPIC_API_KEY) is required.');

  const payload = readEventPayload();
  const { owner, repo } = resolveRepo(payload);
  const eventName = process.env.GITHUB_EVENT_NAME;
  const gh = new GitHubClient(githubToken, owner, repo);

  if (!(await shouldRun(gh, payload, eventName))) return;

  const prNumber = resolvePrNumber(payload);
  const cfg = loadConfig();
  info(
    `iolite on ${owner}/${repo}#${prNumber} — lenses=[${cfg.lenses.join(',')}] ` +
      `skeptics=${cfg.adversarialRounds} threshold=${cfg.refuteThreshold} ` +
      `policy=${summarizePolicySource(cfg.promptInline, cfg.promptFileRel)}`
  );

  if (await gh.shouldSkipReview(prNumber)) {
    info('Skipping: [skip-ai-review] found in the PR body or a commit message.');
    return;
  }

  const prInfo = await gh.getPRInfo(prNumber);

  const force = isForceRerunRequested({
    commentBody: payload.comment?.body,
    prBody: prInfo.body,
  });
  if (!force) {
    const bodies = await gh.listReviewBodies(prNumber);
    if (hasReviewedSha(bodies, prInfo.headSha)) {
      info(`Skipping: ${prInfo.headSha.slice(0, 8)} has already been reviewed. Comment "/review force" to redo it.`);
      return;
    }
  } else {
    info('Force rerun requested; duplicate suppression bypassed.');
  }

  const [rawDiff, policy] = await Promise.all([
    gh.getPRDiff(prNumber, prInfo.headSha),
    loadPolicy(gh, cfg, prInfo.baseBranch),
  ]);

  const parsedAll = parseUnifiedDiff(rawDiff);
  const parsed = filterByPaths(parsedAll, cfg.includePaths, cfg.excludePaths);
  if (parsed.files.size === 0) {
    info('Nothing to review after path filtering.');
    return;
  }
  debugLog(`diff: ${parsedAll.files.size} file(s), ${parsed.files.size} in scope`);

  const rendered = renderDiffForPrompt(parsed);

  const issueNumber = await gh.getLinkedIssue(prInfo);
  const issueInfo = issueNumber ? await gh.getIssueInfo(issueNumber).catch(() => null) : null;
  if (issueInfo) info(`Linked issue #${issueInfo.number} loaded for acceptance-criteria checking.`);

  const model = core.getInput('model') || process.env.ANTHROPIC_MODEL || 'claude-opus-5';
  const maxTokens = parseInt(
    core.getInput('max_output_tokens') || process.env.ANTHROPIC_MAX_TOKENS || '16000',
    10
  );
  const llm = new LLMClient(
    anthropicApiKey,
    model,
    Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 16000,
    cfg.maxLlmCalls
  );

  const result = await runPipeline({
    llm,
    cfg,
    parsed,
    rendered,
    prInfo,
    issueInfo,
    policy,
    selfReview: cfg.reviewSelf,
  });

  const review = renderReview(result, cfg, prInfo.headSha, model);
  const posted = await gh.postReview(prNumber, {
    body: review.body,
    comments: review.comments,
    commitId: prInfo.headSha,
  });

  if (!isReviewComplete(result)) {
    core.setFailed('iolite review incomplete: one or more stages failed. No completed-review marker was recorded; this commit can be retried.');
  }
  core.setOutput('review_complete', isReviewComplete(result));
  core.setOutput('review_id', posted.id);
  core.setOutput('comment_count', posted.commentCount);
  core.setOutput('survived_count', result.stats.survived);
  core.setOutput('refuted_count', result.stats.refuted);
  core.setOutput('llm_calls', result.stats.llmCalls);

  info(
    `Posted review ${posted.id}: ${posted.commentCount} comment(s), ` +
      `${result.stats.survived} survived, ${result.stats.refuted} refuted, ` +
      `${result.stats.llmCalls} model call(s).`
  );
}

run().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.stack && process.env.RUNNER_DEBUG === '1') {
    console.error(error.stack);
  }
  core.setFailed(`iolite failed: ${msg}`);
});
