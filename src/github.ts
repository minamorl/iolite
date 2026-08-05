/**
 * GitHub IO for the iolite reviewer.
 *
 * Everything that touches the GitHub API lives here, behind one class, so the
 * rest of the pipeline never sees an Octokit type and never has to reason about
 * REST failure modes.
 *
 * Two rules shape this file:
 *
 *   1. A partial review is better than no review. GitHub rejects an ENTIRE
 *      review with a 422 when a single line comment lands on a line that is not
 *      part of the diff. Losing forty comments and the summary because one
 *      anchor was off by one is not acceptable, so `postReview` degrades:
 *      batch first, then body-alone plus comment-by-comment.
 *   2. Nothing secret is ever logged. No tokens, no diffs, no PR/issue bodies.
 *      Error text is limited to the operation name, the HTTP status, and
 *      GitHub's own message.
 */

import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';

export interface PRInfo {
  number: number;
  title: string;
  body: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  commits: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  author: string;
  draft: boolean;
}

export interface IssueInfo {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  comments: Array<{ author: string; body: string; createdAt: string }>;
}

export interface LineComment {
  path: string;
  line: number;
  /**
   * Always the post-image. A reviewer that comments on deleted lines is
   * commenting on code that no longer exists.
   */
  side: 'RIGHT';
  body: string;
}

/** Opt-out marker, honoured in the PR body or in any commit message. */
export const SKIP_TOKEN = '[skip-ai-review]';

/**
 * GitHub's contents API refuses to inline anything larger than this, and a
 * policy file that big is a configuration mistake rather than a policy.
 */
const MAX_FILE_BYTES = 1024 * 1024;

const PER_PAGE = 100;

/**
 * Closing keywords, every conjugation GitHub accepts, pointing either at `#12`
 * or at a full issue URL. Case-insensitive.
 */
const CLOSING_KEYWORD_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*(?:#(\d+)\b|https?:\/\/(?:www\.)?github\.com\/([^\s/]+)\/([^\s/]+)\/issues\/(\d+)\b)/gi;

/** A bare issue URL anywhere in the body, used only when no keyword matched. */
const ISSUE_URL_RE =
  /https?:\/\/(?:www\.)?github\.com\/([^\s/]+)\/([^\s/]+)\/issues\/(\d+)\b/gi;

/**
 * A branch segment that leads with an issue number: `123`, `123-thing`,
 * `issue-123-thing`, `gh_123`. Deliberately strict about what may follow the
 * number so that `release/1.2.3` and `feat/2fa-login` are not mistaken for
 * issue references.
 */
const BRANCH_SEGMENT_RE = /^(?:issues?[-_]?|gh[-_]?|#)?(\d+)(?:[-_].*)?$/i;

/** Pull an HTTP status off whatever Octokit (or a test double) threw. */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const anyErr = err as { status?: unknown; response?: { status?: unknown } };
  if (typeof anyErr.status === 'number') return anyErr.status;
  if (anyErr.response && typeof anyErr.response.status === 'number') {
    return anyErr.response.status;
  }
  return undefined;
}

/** Short, secret-free description of a failure. */
function describeError(err: unknown): string {
  const status = statusOf(err);
  let message: string;
  if (err instanceof Error) message = err.message;
  else if (typeof err === 'string') message = err;
  else {
    try {
      message = JSON.stringify(err) ?? String(err);
    } catch {
      message = String(err);
    }
  }
  return status === undefined ? message : `HTTP ${status}: ${message}`;
}

/**
 * Wrap a raw Octokit error so the caller learns which operation failed. A bare
 * `HttpError: Not Found` in an Action log tells nobody anything.
 */
function wrapError(operation: string, err: unknown): Error {
  return new Error(`iolite: ${operation} failed — ${describeError(err)}`, { cause: err });
}

function firstIssueNumberInBranch(branch: string): number | null {
  if (!branch) return null;
  for (const segment of branch.split('/')) {
    const m = BRANCH_SEGMENT_RE.exec(segment);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;

  /**
   * `octokit` is an internal seam for tests only. Production callers pass three
   * arguments and get a real client.
   */
  constructor(token: string, owner: string, repo: string, octokit?: any) {
    this.owner = owner;
    this.repo = repo;
    this.octokit = octokit ?? new Octokit({ auth: token, userAgent: 'iolite-reviewer' });
  }

  private get base(): { owner: string; repo: string } {
    return { owner: this.owner, repo: this.repo };
  }

  /**
   * Raw unified diff for the PR.
   *
   * Octokit's types claim `data` is the PR object because they are keyed off
   * the default media type; with `format: 'diff'` the runtime value is a
   * string. Trusting the type here would hand a `[object Object]` to the
   * diff parser and produce a review of nothing, so the shape is asserted.
   */
  async getPRDiff(prNumber: number): Promise<string> {
    let data: unknown;
    try {
      const res = await this.octokit.pulls.get({
        ...this.base,
        pull_number: prNumber,
        mediaType: { format: 'diff' },
      });
      data = res.data;
    } catch (err) {
      throw wrapError(`fetching the diff for PR #${prNumber}`, err);
    }

    if (typeof data !== 'string') {
      throw new Error(
        `iolite: fetching the diff for PR #${prNumber} returned ${
          data === null ? 'null' : typeof data
        } instead of a raw unified diff. ` +
          `The request must be made with mediaType: { format: 'diff' } and the response used as a string.`,
      );
    }
    return data;
  }

  async getPRInfo(prNumber: number): Promise<PRInfo> {
    try {
      const { data } = await this.octokit.pulls.get({ ...this.base, pull_number: prNumber });
      return {
        number: data.number,
        title: data.title ?? '',
        body: data.body ?? null,
        headBranch: data.head?.ref ?? '',
        baseBranch: data.base?.ref ?? '',
        headSha: data.head?.sha ?? '',
        baseSha: data.base?.sha ?? '',
        commits: data.commits ?? 0,
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
        changedFiles: data.changed_files ?? 0,
        author: data.user?.login ?? '',
        draft: data.draft === true,
      };
    } catch (err) {
      throw wrapError(`fetching PR #${prNumber}`, err);
    }
  }

  /**
   * Resolve the issue this PR is about, in descending order of how deliberate
   * the signal is:
   *
   *   1. a closing keyword in the body (`closes #12`, `Fixed #12`, `resolve #12`)
   *   2. a full issue URL in the body, this repository's URLs preferred
   *   3. a leading issue number in the head branch (`feat/123-thing`)
   *
   * The PR's own number is never returned: `#7` on PR 7 is a self-reference,
   * and feeding the PR back to the reviewer as its own "requirements" would
   * make the review argue with itself.
   */
  async getLinkedIssue(prInfo: PRInfo): Promise<number | null> {
    const body = prInfo.body ?? '';
    const candidates: number[] = [];

    for (const m of body.matchAll(CLOSING_KEYWORD_RE)) {
      const n = Number.parseInt(m[1] ?? m[4] ?? '', 10);
      if (Number.isInteger(n) && n > 0) candidates.push(n);
    }

    const sameRepo: number[] = [];
    const otherRepo: number[] = [];
    for (const m of body.matchAll(ISSUE_URL_RE)) {
      const n = Number.parseInt(m[3] ?? '', 10);
      if (!Number.isInteger(n) || n <= 0) continue;
      const owner = (m[1] ?? '').toLowerCase();
      const repo = (m[2] ?? '').toLowerCase();
      if (owner === this.owner.toLowerCase() && repo === this.repo.toLowerCase()) sameRepo.push(n);
      else otherRepo.push(n);
    }
    candidates.push(...sameRepo, ...otherRepo);

    const fromBranch = firstIssueNumberInBranch(prInfo.headBranch);
    if (fromBranch !== null) candidates.push(fromBranch);

    for (const candidate of candidates) {
      if (candidate !== prInfo.number) return candidate;
    }
    return null;
  }

  async getIssueInfo(issueNumber: number): Promise<IssueInfo> {
    try {
      const { data } = await this.octokit.issues.get({
        ...this.base,
        issue_number: issueNumber,
      });

      const rawComments = await this.octokit.paginate(this.octokit.issues.listComments, {
        ...this.base,
        issue_number: issueNumber,
        per_page: PER_PAGE,
      });

      const labels = (data.labels ?? [])
        .map((label: unknown) =>
          typeof label === 'string' ? label : ((label as { name?: string | null })?.name ?? ''),
        )
        .filter((name: string) => name.length > 0);

      return {
        number: data.number,
        title: data.title ?? '',
        body: data.body ?? null,
        labels,
        comments: rawComments.map((c) => ({
          author: c.user?.login ?? 'unknown',
          body: c.body ?? '',
          createdAt: c.created_at ?? '',
        })),
      };
    } catch (err) {
      throw wrapError(`fetching issue #${issueNumber}`, err);
    }
  }

  /**
   * True when the author asked to be left alone, either in the PR body or in
   * any commit message. Commit messages are paginated: a long PR must not lose
   * the opt-out just because it landed on commit 130.
   */
  async shouldSkipReview(prNumber: number): Promise<boolean> {
    const needle = SKIP_TOKEN.toLowerCase();
    try {
      const { data } = await this.octokit.pulls.get({ ...this.base, pull_number: prNumber });
      if ((data.body ?? '').toLowerCase().includes(needle)) return true;

      const commits = await this.octokit.paginate(this.octokit.pulls.listCommits, {
        ...this.base,
        pull_number: prNumber,
        per_page: PER_PAGE,
      });
      for (const commit of commits) {
        const message = commit.commit?.message ?? '';
        if (message.toLowerCase().includes(needle)) return true;
      }
      return false;
    } catch (err) {
      throw wrapError(`checking the skip marker on PR #${prNumber}`, err);
    }
  }

  /** Every review body on the PR, oldest first. Paginated. */
  async listReviewBodies(prNumber: number): Promise<string[]> {
    try {
      const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
        ...this.base,
        pull_number: prNumber,
        per_page: PER_PAGE,
      });
      return reviews.map((r) => r.body ?? '');
    } catch (err) {
      throw wrapError(`listing reviews on PR #${prNumber}`, err);
    }
  }

  /**
   * Effective permission of a user on this repository: `admin`, `write`,
   * `read`, or `none`.
   *
   * This asks the collaborators API rather than reading `author_association`
   * off the PR payload. `author_association` reports things like CONTRIBUTOR
   * for anyone who ever had a commit merged, which says nothing about current
   * write access — using it as a trust signal is a privilege-escalation bug
   * waiting to happen.
   */
  async getUserPermission(username: string): Promise<string> {
    if (!username) return 'none';
    try {
      const { data } = await this.octokit.repos.getCollaboratorPermissionLevel({
        ...this.base,
        username,
      });
      return data.permission ?? 'none';
    } catch (err) {
      // 404 here means "not a collaborator", which is a normal answer.
      if (statusOf(err) === 404) return 'none';
      throw wrapError(`reading repository permission for ${username}`, err);
    }
  }

  /**
   * File contents at `ref` (default branch when omitted), decoded to UTF-8.
   *
   * A missing file returns `''`. The main caller is the review-policy file,
   * which is optional by design: "the repo has no policy" is a normal state,
   * not a reason to fail the run.
   */
  async getFileContent(path: string, ref?: string): Promise<string> {
    let data: unknown;
    try {
      const res = await this.octokit.repos.getContent({
        ...this.base,
        path,
        ...(ref ? { ref } : {}),
      });
      data = res.data;
    } catch (err) {
      if (statusOf(err) === 404) return '';
      throw wrapError(`reading ${path}${ref ? ` at ${ref}` : ''}`, err);
    }

    const where = `${path}${ref ? ` at ${ref}` : ''}`;

    if (Array.isArray(data)) {
      throw new Error(`iolite: ${where} is a directory, not a file.`);
    }
    if (typeof data !== 'object' || data === null) {
      throw new Error(`iolite: reading ${where} returned an unexpected response shape.`);
    }

    const file = data as {
      type?: string;
      size?: number;
      content?: string;
      encoding?: string;
    };

    if (file.type && file.type !== 'file') {
      throw new Error(`iolite: ${where} is a ${file.type}, not a regular file.`);
    }
    if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) {
      throw new Error(
        `iolite: ${where} is ${file.size} bytes, over the ${MAX_FILE_BYTES}-byte limit for inline reads.`,
      );
    }
    if (typeof file.content !== 'string') {
      throw new Error(`iolite: ${where} returned no inline content.`);
    }
    if (file.encoding !== undefined && file.encoding !== 'base64') {
      // GitHub answers `encoding: "none"` for blobs it refuses to inline.
      throw new Error(
        `iolite: ${where} came back with encoding "${file.encoding}", which usually means the file is too large to read inline.`,
      );
    }

    return Buffer.from(file.content, 'base64').toString('utf8');
  }

  /**
   * Post the review.
   *
   * `event` is always `COMMENT`. A bot must never APPROVE or REQUEST_CHANGES:
   * approving would let an automated pass satisfy a branch protection rule
   * meant for a human, and requesting changes would block a merge on a
   * machine's opinion. Both take a decision away from the people accountable
   * for the code.
   *
   * The 422 fallback exists because GitHub validates line anchors for the whole
   * batch at once: one comment on a line outside the diff kills the request and
   * every other comment with it. When that happens the summary is posted alone
   * (it is the part with the most value per byte) and the comments are retried
   * one at a time, keeping whatever GitHub accepts.
   *
   * The returned `commentCount` is what actually landed, never what was asked
   * for — the Action's output would otherwise claim comments nobody can see.
   */
  async postReview(
    prNumber: number,
    args: { body: string; comments: LineComment[] },
  ): Promise<{ id: number; commentCount: number }> {
    const body = args.body ?? '';
    const comments = (args.comments ?? []).filter(isPostableComment);

    if (comments.length === 0) {
      try {
        const res = await this.octokit.pulls.createReview({
          ...this.base,
          pull_number: prNumber,
          body,
          event: 'COMMENT',
        });
        return { id: res.data.id, commentCount: 0 };
      } catch (err) {
        throw wrapError(`posting the review on PR #${prNumber}`, err);
      }
    }

    try {
      const res = await this.octokit.pulls.createReview({
        ...this.base,
        pull_number: prNumber,
        body,
        event: 'COMMENT',
        comments: comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
        })),
      });
      return { id: res.data.id, commentCount: comments.length };
    } catch (err) {
      if (statusOf(err) !== 422) {
        throw wrapError(`posting the review on PR #${prNumber}`, err);
      }
      core.warning(
        `iolite: GitHub rejected the batched review on PR #${prNumber} (${describeError(err)}). ` +
          `Falling back to posting the summary and each comment separately.`,
      );
      return this.postReviewPiecewise(prNumber, body, comments);
    }
  }

  /**
   * Degraded path for a 422. Posts the summary alone, then each line comment
   * individually, dropping only the ones GitHub refuses.
   */
  private async postReviewPiecewise(
    prNumber: number,
    body: string,
    comments: LineComment[],
  ): Promise<{ id: number; commentCount: number }> {
    let reviewId = 0;
    try {
      const res = await this.octokit.pulls.createReview({
        ...this.base,
        pull_number: prNumber,
        body,
        event: 'COMMENT',
      });
      reviewId = res.data.id;
    } catch (err) {
      core.warning(
        `iolite: could not post the review summary on PR #${prNumber} (${describeError(err)}).`,
      );
    }

    // createReviewComment needs the commit the comment is anchored to.
    let headSha = '';
    try {
      headSha = (await this.getPRInfo(prNumber)).headSha;
    } catch (err) {
      core.warning(
        `iolite: could not resolve the head SHA for PR #${prNumber} (${describeError(err)}); ` +
          `line comments will be skipped.`,
      );
    }

    let posted = 0;
    let dropped = 0;
    if (headSha) {
      for (const comment of comments) {
        try {
          await this.octokit.pulls.createReviewComment({
            ...this.base,
            pull_number: prNumber,
            commit_id: headSha,
            path: comment.path,
            line: comment.line,
            side: comment.side,
            body: comment.body,
          });
          posted += 1;
        } catch (err) {
          // Almost always "line is not part of the diff". One bad anchor must
          // not cost the other comments, so it is dropped and counted.
          dropped += 1;
          core.warning(
            `iolite: dropped a line comment on ${comment.path}:${comment.line} (${describeError(err)}).`,
          );
        }
      }
    } else {
      dropped = comments.length;
    }

    if (reviewId === 0 && posted === 0) {
      throw new Error(
        `iolite: posting the review on PR #${prNumber} failed — GitHub rejected the batched review ` +
          `and neither the summary nor any of the ${comments.length} line comments could be posted separately.`,
      );
    }

    core.info(
      `iolite: posted the review summary and ${posted}/${comments.length} line comments ` +
        `(${dropped} dropped by GitHub).`,
    );
    return { id: reviewId, commentCount: posted };
  }
}

/**
 * Drop comments that GitHub is certain to reject anyway. A NaN line or an empty
 * path guarantees a 422 for the whole batch, so it never gets to make the trip.
 */
function isPostableComment(c: LineComment | undefined | null): c is LineComment {
  return (
    !!c &&
    typeof c.path === 'string' &&
    c.path.length > 0 &&
    Number.isInteger(c.line) &&
    c.line > 0 &&
    typeof c.body === 'string' &&
    c.body.trim().length > 0
  );
}
