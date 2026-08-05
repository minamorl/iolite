/**
 * Who may spend the API budget.
 *
 * Anyone who can see a public repository can comment on it, and a comment is
 * enough to trigger a review. Without this gate, a stranger could post `/review`
 * in a loop and burn the repository owner's Anthropic budget — a real
 * cost-denial-of-service, paid for by someone who never agreed to it.
 *
 * So the default is deny. Only collaborator levels that already imply the right
 * to spend the repository's resources are allowed, and anything unrecognised
 * (a new GitHub level, a typo, an empty response from a failed API call) is
 * denied rather than guessed at.
 */

/** GitHub collaborator permission levels that may trigger a review. */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['admin', 'maintain', 'write']);

/** Human-readable form of the allowed set, for denial messages. */
const ALLOWED_LABEL = 'write, maintain, or admin';

export function isReviewTriggerAllowed(permission: string | null | undefined): boolean {
  if (typeof permission !== 'string') return false;
  return ALLOWED_PERMISSIONS.has(permission.trim().toLowerCase());
}

/**
 * Keep untrusted strings from turning a log line or a posted comment into
 * something else: no markup, no mentions, no newlines, bounded length.
 */
function sanitizeToken(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, maxLength);
  return cleaned === '' ? fallback : cleaned;
}

/**
 * One line explaining why a trigger was ignored.
 *
 * The actor is rendered as code rather than as `@name`: this string can end up
 * in a PR comment, and denying someone should not also ping them.
 */
export function describePermissionDenial(actor: string, permission: string): string {
  const who = sanitizeToken(actor, 'unknown-user', 64);
  const level = sanitizeToken(permission, 'none', 32).toLowerCase();
  return (
    `iolite: ignoring review request from \`${who}\` — repository permission ` +
    `\`${level}\` is not enough to spend this repository's review budget ` +
    `(requires ${ALLOWED_LABEL}).`
  );
}
