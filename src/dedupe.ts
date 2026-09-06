/**
 * Do not review the same commit twice.
 *
 * Every review iolite posts carries a hidden marker naming the head sha it
 * judged. Before spending a single model call, the pipeline reads the existing
 * review bodies: if this exact head sha has already been reviewed, there is
 * nothing new to say and the run stops. A `synchronize` event that only touched
 * the base branch, a re-run of the workflow, or a second `/review` comment on an
 * unchanged head all land here.
 *
 * The escape hatch is explicit — a human asks for a rerun, and it is honoured.
 */

const MARKER_KEY = 'iolite:reviewed-sha';

/**
 * Reduce a sha to the characters that can appear in one.
 *
 * This is also the injection guard: the marker is embedded in an HTML comment,
 * so a "sha" containing `-->` (or a newline, or markup) must never survive into
 * the review body.
 */
function normalizeSha(sha: unknown): string {
  if (typeof sha !== 'string') return '';
  return sha.trim().toLowerCase().replace(/[^0-9a-z]/g, '');
}

/** The hidden marker written into every review body iolite posts. */
export function buildReviewMarker(headSha: string): string {
  return `<!-- ${MARKER_KEY}=${normalizeSha(headSha)} -->`;
}

/**
 * True when one of the given review bodies already claims this exact head sha.
 *
 * The comparison is on the *parsed* sha, not on a substring of the body: a
 * substring test would let a short sha match a longer one that merely starts
 * with it, and iolite would then skip a commit it has never seen.
 */
export function hasReviewedSha(existingReviewBodies: string[], headSha: string): boolean {
  const target = normalizeSha(headSha);
  if (!target) return false;
  if (!Array.isArray(existingReviewBodies)) return false;

  // Built per call: a /g regex carries lastIndex, and module-level state here
  // would make the answer depend on the previous question.
  const markerRe = new RegExp(`<!--\\s*${MARKER_KEY}\\s*=\\s*([0-9a-zA-Z]+)\\s*-->`, 'g');

  for (const body of existingReviewBodies) {
    if (typeof body !== 'string' || body.length === 0) continue;
    // Older versions marked total API failures as completed reviews.
    if (/\| lenses run \| (?:—|-) \|/.test(body) || body.includes('**Review incomplete.**')) continue;
    markerRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = markerRe.exec(body)) !== null) {
      if (match[1] !== undefined && match[1].toLowerCase() === target) return true;
    }
  }
  return false;
}

/**
 * `/review force` (or `/review --force`) in a comment, or `[force-ai-review]` in
 * the PR body.
 *
 * The command must stand on its own: `/reviewforce` and `/review forced` are not
 * requests to spend the budget again.
 */
const FORCE_COMMAND_RE = /(?:^|\s)\/review\s+(?:--)?force(?![\w-])/i;
const FORCE_BODY_MARKER = '[force-ai-review]';

export function isForceRerunRequested(opts: {
  commentBody?: string | null;
  prBody?: string | null;
}): boolean {
  const commentBody = typeof opts?.commentBody === 'string' ? opts.commentBody : '';
  const prBody = typeof opts?.prBody === 'string' ? opts.prBody : '';

  if (commentBody && FORCE_COMMAND_RE.test(commentBody)) return true;
  if (prBody && prBody.toLowerCase().includes(FORCE_BODY_MARKER)) return true;
  return false;
}
