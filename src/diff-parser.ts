/**
 * Unified-diff parser for the iolite reviewer.
 *
 * Everything downstream trusts the RIGHT-side (post-image) line numbers this
 * module produces: a finding anchored to the wrong line is worse than no
 * finding at all, because it reads as authoritative and is not. So the rules
 * here are followed literally rather than approximated:
 *
 *   - `@@ -a,b +c,d @@` seeds the right-side cursor at `c`.
 *   - `+` and ` ` advance the cursor; `-` and `\ No newline...` do not.
 *   - Hunk line counts are authoritative. They are what lets us parse a diff
 *     whose *content* is itself a diff without mistaking `+++ b/x` inside a
 *     hunk body for a file header.
 *   - Deleted files have no right side at all, so they are dropped whole.
 *
 * Nothing in here throws. A malformed diff yields whatever could be recovered,
 * which for pure garbage is an empty result.
 */

export interface DiffLine {
  path: string;
  rightLine: number;
  type: 'add' | 'context';
  content: string;
}

export interface FileDiff {
  path: string;
  /** Every right-side line number GitHub will accept a comment on (adds + context). */
  reachableLines: Set<number>;
  addedLines: Set<number>;
  lines: DiffLine[];
}

export interface ParsedDiff {
  files: Map<string, FileDiff>;
}

export interface RenderedDiff {
  text: string;
  truncated: boolean;
  /** Files present in `text`, counting partially emitted ones. */
  filesEmitted: number;
  /** Files absent from `text` entirely. `filesEmitted + filesOmitted` is the total. */
  filesOmitted: number;
  /** Files that were emitted but cut short. */
  truncatedFiles: string[];
}

const DEFAULT_MAX_BYTES = 120_000;
const DEFAULT_SNAP_TOLERANCE = 3;

/** Headroom held back so the truncation markers still fit inside `maxBytes`. */
const MARKER_RESERVE = 128;

const FILE_CUT_MARKER = '... (rest of this file omitted)';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface PendingLine {
  rightLine: number;
  type: 'add' | 'context';
  content: string;
}

interface PendingFile {
  fromPlusHeader: string | null;
  fromRenameTo: string | null;
  fromGitHeader: string | null;
  deleted: boolean;
  sawPlusHeader: boolean;
  lines: PendingLine[];
}

interface HunkHeader {
  oldCount: number;
  newStart: number;
  newCount: number;
}

function newPendingFile(): PendingFile {
  return {
    fromPlusHeader: null,
    fromRenameTo: null,
    fromGitHeader: null,
    deleted: false,
    sawPlusHeader: false,
    lines: [],
  };
}

/** A count-less range (`@@ -1 +1 @@`) means exactly one line, per the unified diff format. */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(line: string): HunkHeader | null {
  const m = HUNK_RE.exec(line);
  if (!m) return null;
  const oldCount = m[2] === undefined ? 1 : Number(m[2]);
  const newStart = Number(m[3]);
  const newCount = m[4] === undefined ? 1 : Number(m[4]);
  if (!Number.isFinite(oldCount) || !Number.isFinite(newStart) || !Number.isFinite(newCount)) {
    return null;
  }
  return { oldCount, newStart, newCount };
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Index of the closing quote of a C-quoted token starting at index 0, or -1. */
function findClosingQuote(s: string): number {
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"') return i;
  }
  return -1;
}

/**
 * Reverse git's `quote_c_style`. The octal escapes encode raw *bytes*, so the
 * whole token is rebuilt as bytes and decoded as UTF-8 at the end — decoding
 * escape by escape would mangle any multi-byte character.
 */
function unquoteCStyle(quoted: string): string {
  const body = quoted.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let plain = '';

  const flushPlain = (): void => {
    if (plain.length === 0) return;
    for (const b of encoder.encode(plain)) bytes.push(b);
    plain = '';
  };

  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      plain += c;
      continue;
    }
    flushPlain();
    i++;
    const e = body[i];
    if (e === undefined) break;
    switch (e) {
      case 'a': bytes.push(0x07); break;
      case 'b': bytes.push(0x08); break;
      case 'f': bytes.push(0x0c); break;
      case 'n': bytes.push(0x0a); break;
      case 'r': bytes.push(0x0d); break;
      case 't': bytes.push(0x09); break;
      case 'v': bytes.push(0x0b); break;
      case '\\': bytes.push(0x5c); break;
      case '"': bytes.push(0x22); break;
      default: {
        if (e >= '0' && e <= '7') {
          let oct = e;
          while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') {
            i++;
            oct += body[i];
          }
          bytes.push(parseInt(oct, 8) & 0xff);
        } else {
          // Unknown escape: keep the character as written rather than dropping it.
          plain += e;
        }
      }
    }
  }
  flushPlain();
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

/**
 * Read a path off a `---`/`+++` header. Handles C-quoting and the optional
 * tab-separated timestamp that non-git unified diffs carry. Trailing spaces are
 * deliberately NOT trimmed — a path may legitimately end in one, and this
 * module's whole job is to be byte-exact about identity.
 */
function parseHeaderPath(raw: string): string {
  if (raw.startsWith('"')) {
    const end = findClosingQuote(raw);
    if (end > 0) return unquoteCStyle(raw.slice(0, end + 1));
  }
  const tab = raw.indexOf('\t');
  return tab >= 0 ? raw.slice(0, tab) : raw;
}

function stripSidePrefix(path: string, side: 'a/' | 'b/'): string {
  if (path === '/dev/null') return path;
  return path.startsWith(side) ? path.slice(2) : path;
}

/**
 * Split the two paths out of a `diff --git ` line. Unquoted paths may contain
 * spaces, which makes the split point genuinely ambiguous; prefer the split
 * where both sides name the same file, which is every case except a rename.
 */
function splitDiffGitPaths(rest: string): { a: string; b: string } | null {
  if (rest.startsWith('"')) {
    const end = findClosingQuote(rest);
    if (end < 0) return null;
    const a = unquoteCStyle(rest.slice(0, end + 1));
    const after = rest.slice(end + 1);
    if (!after.startsWith(' ')) return null;
    const bRaw = after.slice(1);
    if (bRaw.startsWith('"')) {
      const end2 = findClosingQuote(bRaw);
      if (end2 < 0) return null;
      return { a, b: unquoteCStyle(bRaw.slice(0, end2 + 1)) };
    }
    return { a, b: bRaw };
  }

  const candidates: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === ' ' && rest.startsWith('b/', i + 1)) candidates.push(i);
  }
  if (candidates.length === 0) return null;

  for (const i of candidates) {
    const a = rest.slice(0, i);
    const b = rest.slice(i + 1);
    if (a.startsWith('a/') && a.slice(2) === b.slice(2)) return { a, b };
  }
  const first = candidates[0];
  return { a: rest.slice(0, first), b: rest.slice(first + 1) };
}

/**
 * Consume a hunk body starting at `start`, appending right-side lines to `file`.
 * Returns the index of the first line after the hunk.
 */
function consumeHunk(
  raw: string[],
  start: number,
  header: HunkHeader,
  file: PendingFile,
): number {
  let i = start;
  let right = header.newStart;
  let remainingOld = header.oldCount;
  let remainingNew = header.newCount;

  while (i < raw.length && (remainingOld > 0 || remainingNew > 0)) {
    const line = stripCarriageReturn(raw[i]);

    // `\ No newline at end of file` annotates the previous line and belongs to
    // neither side's count.
    if (line.startsWith('\\')) {
      i++;
      continue;
    }

    const marker = line[0];
    if (marker === '+') {
      file.lines.push({ rightLine: right, type: 'add', content: line.slice(1) });
      right++;
      remainingNew--;
      i++;
      continue;
    }
    if (marker === '-') {
      // Deletions exist only on the left side; the right cursor stays put.
      remainingOld--;
      i++;
      continue;
    }
    if (marker === ' ') {
      file.lines.push({ rightLine: right, type: 'context', content: line.slice(1) });
      right++;
      remainingNew--;
      remainingOld--;
      i++;
      continue;
    }
    if (line === '') {
      // An empty context line whose single leading space was eaten by a
      // whitespace-trimming transport. The hunk counts say a line is still
      // owed here, so it is content rather than the end of the hunk.
      file.lines.push({ rightLine: right, type: 'context', content: '' });
      right++;
      remainingNew--;
      remainingOld--;
      i++;
      continue;
    }
    // Anything else means the counts lied; stop rather than guess.
    break;
  }
  return i;
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const files = new Map<string, FileDiff>();
  if (typeof diff !== 'string' || diff.length === 0) return { files };

  const commit = (pending: PendingFile | null): void => {
    if (!pending) return;
    if (pending.deleted) return;
    const path = pending.fromPlusHeader ?? pending.fromRenameTo ?? pending.fromGitHeader;
    if (!path) return;

    let fd = files.get(path);
    if (!fd) {
      fd = { path, reachableLines: new Set<number>(), addedLines: new Set<number>(), lines: [] };
      files.set(path, fd);
    }
    for (const l of pending.lines) {
      fd.lines.push({ path, rightLine: l.rightLine, type: l.type, content: l.content });
      fd.reachableLines.add(l.rightLine);
      if (l.type === 'add') fd.addedLines.add(l.rightLine);
    }
  };

  let current: PendingFile | null = null;

  try {
    const raw = diff.split('\n');
    let i = 0;

    while (i < raw.length) {
      const line = stripCarriageReturn(raw[i]);

      if (line.startsWith('diff --git ')) {
        commit(current);
        current = newPendingFile();
        const paths = splitDiffGitPaths(line.slice('diff --git '.length));
        if (paths) current.fromGitHeader = stripSidePrefix(paths.b, 'b/');
        i++;
        continue;
      }

      if (line.startsWith('deleted file mode')) {
        if (!current) current = newPendingFile();
        current.deleted = true;
        i++;
        continue;
      }

      if (line.startsWith('rename to ')) {
        if (!current) current = newPendingFile();
        current.fromRenameTo = parseHeaderPath(line.slice('rename to '.length));
        i++;
        continue;
      }

      if (line.startsWith('--- ')) {
        // A plain `diff -u` stream has no `diff --git` lines, so `---` is what
        // starts each new file there.
        if (!current || current.sawPlusHeader) {
          commit(current);
          current = newPendingFile();
        }
        i++;
        continue;
      }

      if (line.startsWith('+++ ')) {
        if (!current) current = newPendingFile();
        current.sawPlusHeader = true;
        const path = parseHeaderPath(line.slice(4));
        if (path === '/dev/null') current.deleted = true;
        else current.fromPlusHeader = stripSidePrefix(path, 'b/');
        i++;
        continue;
      }

      if (line.startsWith('@@')) {
        const header = parseHunkHeader(line);
        if (!header) {
          i++;
          continue;
        }
        if (!current) current = newPendingFile();
        i = consumeHunk(raw, i + 1, header, current);
        continue;
      }

      // `index`, `new file mode`, `old mode`, `similarity index`, `rename from`,
      // `Binary files ... differ`, `GIT binary patch` and its base85 payload all
      // carry nothing we need; the payload alphabet cannot spoof a header.
      i++;
    }
  } catch {
    // Never throw on malformed input: keep whatever was recovered.
  }

  commit(current);
  return { files };
}

// ---------------------------------------------------------------------------
// Path filtering
// ---------------------------------------------------------------------------

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegExpChar(c: string): string {
  return c.replace(REGEX_META, '\\$&');
}

const globCache = new Map<string, RegExp | null>();

function globToRegExp(pattern: string): RegExp | null {
  const cached = globCache.get(pattern);
  if (cached !== undefined) return cached;

  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c !== '*') {
      source += escapeRegExpChar(c);
      continue;
    }
    if (pattern[i + 1] === '*') {
      let j = i + 1;
      while (pattern[j + 1] === '*') j++;
      if (pattern[j + 1] === '/') {
        // `**/` spans any number of directories, including zero, so `**/*.snap`
        // still matches a snapshot sitting at the repo root.
        source += '(?:.*/)?';
        i = j + 1;
      } else {
        source += '.*';
        i = j;
      }
      continue;
    }
    source += '[^/]*';
  }

  let re: RegExp | null = null;
  try {
    re = new RegExp('^' + source + '$');
  } catch {
    re = null;
  }
  globCache.set(pattern, re);
  return re;
}

function matchesEntry(path: string, entry: string): boolean {
  if (entry.includes('*')) {
    const re = globToRegExp(entry);
    if (!re) return false;
    if (re.test(path)) return true;
    // gitignore-style convenience: a slash-free pattern also matches basenames,
    // so `*.lock` excludes `web/pnpm-lock.yaml`-style nested files too.
    if (!entry.includes('/')) {
      const base = path.slice(path.lastIndexOf('/') + 1);
      if (re.test(base)) return true;
    }
    return false;
  }
  return path.startsWith(entry);
}

function normalizeEntries(entries: string[] | null | undefined): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (typeof e !== 'string') continue;
    const trimmed = e.trim();
    // An empty entry is a prefix of everything, which would silently turn an
    // include list into "all files" or an exclude list into "no files".
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

function cloneFileDiff(fd: FileDiff): FileDiff {
  return {
    path: fd.path,
    reachableLines: new Set(fd.reachableLines),
    addedLines: new Set(fd.addedLines),
    lines: fd.lines.map((l) => ({ ...l })),
  };
}

export function filterByPaths(
  parsed: ParsedDiff,
  includePaths: string[],
  excludePaths: string[],
): ParsedDiff {
  const includes = normalizeEntries(includePaths);
  const excludes = normalizeEntries(excludePaths);
  const files = new Map<string, FileDiff>();

  for (const [path, fd] of parsed.files) {
    if (excludes.some((e) => matchesEntry(path, e))) continue;
    if (includes.length > 0 && !includes.some((e) => matchesEntry(path, e))) continue;
    files.set(path, cloneFileDiff(fd));
  }
  return { files };
}

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

export function isCommentableLine(parsed: ParsedDiff, path: string, line: number): boolean {
  const fd = parsed.files.get(path);
  if (!fd) return false;
  if (!Number.isInteger(line)) return false;
  return fd.reachableLines.has(line);
}

/**
 * Pull a near-miss line number onto a line GitHub will actually take.
 *
 * Added lines win over context lines across the whole tolerance window, not just
 * as a tie-break at equal distance: a review comment belongs on code the pull
 * request changed, so an added line two away beats an untouched line one away.
 */
export function snapToCommentableLine(
  parsed: ParsedDiff,
  path: string,
  line: number,
  tolerance: number = DEFAULT_SNAP_TOLERANCE,
): number | null {
  const fd = parsed.files.get(path);
  if (!fd) return null;
  if (typeof line !== 'number' || !Number.isFinite(line)) return null;

  const target = Math.round(line);
  if (fd.reachableLines.has(target)) return target;

  const tol =
    typeof tolerance === 'number' && Number.isFinite(tolerance)
      ? Math.max(0, Math.floor(tolerance))
      : DEFAULT_SNAP_TOLERANCE;
  if (tol <= 0) return null;

  for (const pool of [fd.addedLines, fd.reachableLines]) {
    for (let d = 1; d <= tol; d++) {
      if (pool.has(target - d)) return target - d;
      if (pool.has(target + d)) return target + d;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderLine(l: DiffLine): string {
  const mark = l.type === 'add' ? '+' : ' ';
  return `[${mark} ${l.rightLine}] ${l.content}\n`;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Render a line-numbered diff for the model, under a byte budget.
 *
 * The line numbers in the output are the same right-side numbers the pipeline
 * will post comments on, so the model can quote a number back and have it land.
 */
export function renderDiffForPrompt(
  parsed: ParsedDiff,
  maxBytes: number = DEFAULT_MAX_BYTES,
): RenderedDiff {
  const budget =
    typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes)
      : DEFAULT_MAX_BYTES;

  const files = [...parsed.files.values()];
  if (files.length === 0) {
    return { text: '', truncated: false, filesEmitted: 0, filesOmitted: 0, truncatedFiles: [] };
  }

  const blocks = files.map((f) => {
    const header = `## ${f.path}\n`;
    const lineTexts = f.lines.map(renderLine);
    let bytes = byteLength(header);
    for (const t of lineTexts) bytes += byteLength(t);
    return { path: f.path, header, headerBytes: byteLength(header), lineTexts, bytes };
  });

  const SEP = '\n';
  const sepBytes = byteLength(SEP);

  let totalBytes = 0;
  for (let i = 0; i < blocks.length; i++) {
    totalBytes += blocks[i].bytes + (i > 0 ? sepBytes : 0);
  }

  if (totalBytes <= budget) {
    const text = blocks.map((b) => b.header + b.lineTexts.join('')).join(SEP);
    return {
      text,
      truncated: false,
      filesEmitted: blocks.length,
      filesOmitted: 0,
      truncatedFiles: [],
    };
  }

  // Something has to be cut, so hold back room for the markers that say so.
  const limit = Math.max(0, budget - MARKER_RESERVE);

  let text = '';
  let used = 0;
  let emitted = 0;
  const truncatedFiles: string[] = [];

  for (const block of blocks) {
    const sep = text.length > 0 ? SEP : '';
    const sepCost = text.length > 0 ? sepBytes : 0;

    if (used + sepCost + block.bytes <= limit) {
      text += sep + block.header + block.lineTexts.join('');
      used += sepCost + block.bytes;
      emitted++;
      continue;
    }

    // Partial emission: only worth it if the header and at least one line fit.
    const cutMarkerCost = byteLength(FILE_CUT_MARKER + '\n');
    let partialUsed = sepCost + block.headerBytes + cutMarkerCost;
    const kept: string[] = [];
    for (const t of block.lineTexts) {
      const b = byteLength(t);
      if (used + partialUsed + b > limit) break;
      kept.push(t);
      partialUsed += b;
    }
    if (kept.length > 0) {
      text += sep + block.header + kept.join('') + FILE_CUT_MARKER + '\n';
      used += partialUsed;
      emitted++;
      truncatedFiles.push(block.path);
    }
    break;
  }

  const filesOmitted = blocks.length - emitted;
  const marker = `... (diff truncated; ${filesOmitted} more file(s) omitted)`;
  text += (text.length > 0 ? SEP : '') + marker + '\n';

  return { text, truncated: true, filesEmitted: emitted, filesOmitted, truncatedFiles };
}
