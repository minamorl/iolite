/**
 * Getting JSON back out of model output.
 *
 * A language model asked for JSON will, sooner or later, hand back JSON wrapped
 * in a code fence, JSON with a sentence of apology in front of it, JSON with a
 * trailing comma, or — most often and most expensively — JSON that simply stops
 * because the response hit `max_tokens` in the middle of the twenty-eighth
 * finding. Throwing that away costs real review findings, so this module tries
 * increasingly aggressive strategies and reports which one it needed.
 *
 * The ladder, in order:
 *   1. parse it as-is;
 *   2. strip markdown fences;
 *   3. slice out the outermost balanced `{...}` / `[...]` from surrounding prose
 *      (string- and escape-aware, so a `}` inside a string literal is inert);
 *   4. rewrite the usual model tics — trailing commas, `//` comments, curly
 *      quotes used as string delimiters — and re-parse strictly;
 *   5. tolerant re-parse that closes unterminated strings, drops incomplete
 *      trailing members/elements, and closes open brackets in the right order.
 *
 * Nothing here throws. Callers get `ok: false` and a diagnostic instead.
 *
 * Salvage policy for truncated output (deliberate, and the reason step 5 exists
 * at all): a trailing element that holds at least one *complete* member is kept
 * with its unterminated string closed, because the cut usually lands in the last
 * field of an otherwise complete record and dropping it silently loses a finding
 * that was ninety percent delivered. A trailing element with no complete member
 * carries no information and is dropped. Consumers still validate required
 * fields — that is where an incomplete record should die, not here.
 *
 * Notes returned by this module never quote the model's text: they are structural
 * only, so a caller can log them without leaking prompt or response content.
 */

export interface RepairResult<T> {
  ok: boolean;
  value: T | null;
  /**
   * true when the JSON text had to be *rewritten* (sanitized or completed) to
   * parse. Merely locating an intact value — unwrapping a fence, slicing it out
   * of prose — is not a repair. `ok && repaired` means "treat this with care":
   * it is the flag that says the model was cut off.
   */
  repaired: boolean;
  note: string;
}

/** Straight and curly double quotes, all of which a model may use as a delimiter. */
const LEFT_CURLY_DQ = '“';
const RIGHT_CURLY_DQ = '”';

function isOpenQuote(ch: string): boolean {
  return ch === '"' || ch === LEFT_CURLY_DQ || ch === RIGHT_CURLY_DQ;
}

/**
 * A curly-delimited string is closed by either curly form — but *not* by a
 * straight quote: a model that opens with `“` is usually quoting prose, and
 * prose contains `"`. Treating that as the terminator truncates the value.
 */
function closesString(ch: string, opener: string): boolean {
  if (opener === '"') return ch === '"';
  return ch === LEFT_CURLY_DQ || ch === RIGHT_CURLY_DQ;
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * Describe a thrown parse error without repeating any of the text that caused
 * it. V8 embeds a snippet of the offending input in `SyntaxError.message`; that
 * snippet is model output and must not end up in a log line.
 */
function errorShape(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null;
  const name = e && typeof e.name === 'string' ? e.name : 'Error';
  const message = e && typeof e.message === 'string' ? e.message : '';
  const position = /position (\d+)/.exec(message);
  if (position) return `${name} at position ${position[1]}`;
  const lineCol = /line (\d+) column (\d+)/.exec(message);
  if (lineCol) return `${name} at line ${lineCol[1]} column ${lineCol[2]}`;
  return name;
}

// ---------------------------------------------------------------------------
// Candidate extraction (ladder steps 1-3)
// ---------------------------------------------------------------------------

interface Candidate {
  text: string;
  note: string;
}

const MAX_BALANCED_SLICES = 8;

/** Pull the body out of every fenced block, complete or not (truncation eats the closing fence). */
function fenceBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```[ \t]*[A-Za-z0-9_+.#-]*[ \t]*\r?\n?([\s\S]*?)(?:```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = (m[1] ?? '').trim();
    if (body) blocks.push(body);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  const jsonish = (s: string): boolean => s.startsWith('{') || s.startsWith('[');
  return [...blocks.filter(jsonish), ...blocks.filter((b) => !jsonish(b))];
}

/**
 * Walk from `start` looking for the closer that balances the opener there.
 * Strings (straight or curly), escapes and `//` / block comments are skipped so
 * their brackets cannot move the depth. Returns the index of the matching
 * closer, or -1 when the value never closes (truncated) or is malformed.
 */
function matchingCloser(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let quote = '"';

  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (closesString(ch, quote)) inString = false;
      continue;
    }

    if (isOpenQuote(ch)) {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '/' && text.charAt(i + 1) === '/') {
      while (i < text.length && text.charAt(i) !== '\n') i++;
      continue;
    }
    if (ch === '/' && text.charAt(i + 1) === '*') {
      i += 2;
      while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) i++;
      i += 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if (open === undefined) return -1;
      if ((open === '{') !== (ch === '}')) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

interface Slice {
  text: string;
  complete: boolean;
}

/**
 * The top-level JSON values inside `text`, largest first. Slices never overlap:
 * scanning resumes *after* each value, so an inner object can never be offered
 * as a rival to the array that contains it — otherwise a truncated
 * `[{...},{...},{"x":` would happily "parse" as just its first element and the
 * rest of the findings would vanish.
 *
 * When a value never closes, the tail from its opener is offered anyway — that
 * is the truncated candidate the tolerant parser exists for.
 */
function balancedSlices(text: string): Slice[] {
  const complete: Slice[] = [];
  let truncated: Slice | null = null;
  let from = 0;

  for (let attempt = 0; attempt < MAX_BALANCED_SLICES; attempt++) {
    let start = -1;
    for (let i = from; i < text.length; i++) {
      const ch = text.charAt(i);
      if (ch === '{' || ch === '[') {
        start = i;
        break;
      }
    }
    if (start < 0) break;

    const end = matchingCloser(text, start);
    if (end >= 0) {
      complete.push({ text: text.slice(start, end + 1), complete: true });
      from = end + 1;
      continue;
    }
    truncated = { text: text.slice(start), complete: false };
    break;
  }

  // Longest first: prose sometimes contains a small decoy (`{}`) ahead of the
  // real payload, and the payload is the bigger object every time.
  complete.sort((a, b) => b.text.length - a.text.length);
  return truncated ? [...complete, truncated] : complete;
}

function buildCandidates(raw: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();

  const push = (text: string, note: string): void => {
    const trimmed = text.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ text: trimmed, note });
  };

  // The raw text carries no extraction note: nothing was done to it yet.
  const trimmed = raw.trim();
  push(trimmed, '');

  const fences = fenceBlocks(raw);
  for (const block of fences) push(block, 'stripped markdown code fence');

  for (const base of [trimmed, ...fences]) {
    for (const slice of balancedSlices(base)) {
      push(
        slice.text,
        slice.complete
          ? 'sliced the JSON value out of surrounding text'
          : 'sliced an unterminated JSON value out of surrounding text',
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sanitizing (ladder step 4)
// ---------------------------------------------------------------------------

interface Sanitized {
  text: string;
  changed: boolean;
  notes: string[];
}

/**
 * Remove comments and normalize curly-quote delimiters in one string-aware pass.
 * Curly quotes *inside* a straight-quoted string are content and are left alone;
 * only quotes used as delimiters are rewritten.
 */
function stripCommentsAndCurlyQuotes(text: string): Sanitized {
  let out = '';
  let comments = 0;
  let curly = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text.charAt(i);

    if (isOpenQuote(ch)) {
      const opener = ch;
      const curlyDelimited = opener !== '"';
      if (curlyDelimited) curly++;
      out += '"';
      i++;
      while (i < text.length) {
        const c = text.charAt(i);
        if (c === '\\') {
          out += c + text.charAt(i + 1);
          i += 2;
          continue;
        }
        if (closesString(c, opener)) {
          out += '"';
          i++;
          break;
        }
        // Delimiters became straight quotes, so a straight quote in the body has
        // to be escaped or it would close the string early.
        out += curlyDelimited && c === '"' ? '\\"' : c;
        i++;
      }
      continue;
    }

    if (ch === '/' && text.charAt(i + 1) === '/') {
      comments++;
      while (i < text.length && text.charAt(i) !== '\n') i++;
      continue;
    }
    if (ch === '/' && text.charAt(i + 1) === '*') {
      comments++;
      i += 2;
      while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  const notes: string[] = [];
  if (comments) notes.push(`removed ${comments} comment${comments === 1 ? '' : 's'}`);
  if (curly) notes.push(`replaced ${curly} curly-quote delimiter${curly === 1 ? '' : 's'}`);
  return { text: out, changed: out !== text, notes };
}

/** Drop `,` that sits directly before `}` or `]`. String-aware; assumes comments are gone. */
function removeTrailingCommas(text: string): Sanitized {
  let out = '';
  let removed = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text.charAt(i);

    if (isOpenQuote(ch)) {
      const opener = ch;
      out += ch;
      i++;
      while (i < text.length) {
        const c = text.charAt(i);
        if (c === '\\') {
          out += c + text.charAt(i + 1);
          i += 2;
          continue;
        }
        out += c;
        i++;
        if (closesString(c, opener)) break;
      }
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && isWhitespace(text.charAt(j))) j++;
      const next = text.charAt(j);
      if (next === '}' || next === ']') {
        removed++;
        i++;
        continue;
      }
    }

    out += ch;
    i++;
  }

  const notes = removed ? [`removed ${removed} trailing comma${removed === 1 ? '' : 's'}`] : [];
  return { text: out, changed: out !== text, notes };
}

function sanitize(text: string): Sanitized {
  const first = stripCommentsAndCurlyQuotes(text);
  const second = removeTrailingCommas(first.text);
  return {
    text: second.text,
    changed: first.changed || second.changed,
    notes: [...first.notes, ...second.notes],
  };
}

// ---------------------------------------------------------------------------
// Tolerant parse (ladder step 5 — truncation)
// ---------------------------------------------------------------------------

interface Flags {
  unterminatedStrings: number;
  droppedMembers: number;
  droppedElements: number;
  closedContainers: number;
  trailingCommas: number;
  comments: number;
  bareKeys: number;
}

type Parsed = { ok: true; value: unknown } | { ok: false };

const NO_VALUE: Parsed = { ok: false };

interface TolerantOutcome {
  ok: boolean;
  value: unknown;
  note: string;
}

/**
 * Parse as much of `text` as is structurally sound, closing what the model left
 * open. Only ever reached after strict parsing has failed on every candidate.
 */
function tolerantParse(text: string): TolerantOutcome {
  const n = text.length;
  let i = 0;
  const flags: Flags = {
    unterminatedStrings: 0,
    droppedMembers: 0,
    droppedElements: 0,
    closedContainers: 0,
    trailingCommas: 0,
    comments: 0,
    bareKeys: 0,
  };

  const skipTrivia = (): void => {
    for (;;) {
      while (i < n && isWhitespace(text.charAt(i))) i++;
      if (text.charAt(i) === '/' && text.charAt(i + 1) === '/') {
        flags.comments++;
        while (i < n && text.charAt(i) !== '\n') i++;
        continue;
      }
      if (text.charAt(i) === '/' && text.charAt(i + 1) === '*') {
        flags.comments++;
        i += 2;
        while (i < n && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) i++;
        i = Math.min(i + 2, n);
        continue;
      }
      return;
    }
  };

  /** Always succeeds once an opening quote is consumed: an unterminated string keeps what arrived. */
  const parseString = (): Parsed => {
    const opener = text.charAt(i);
    i++;
    let out = '';
    while (i < n) {
      const ch = text.charAt(i);
      if (ch === '\\') {
        if (i + 1 >= n) {
          // Cut in the middle of an escape: drop the dangling backslash.
          i = n;
          flags.unterminatedStrings++;
          return { ok: true, value: out };
        }
        const esc = text.charAt(i + 1);
        i += 2;
        if (esc === 'u') {
          const hex = text.slice(i, i + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            i = n;
            flags.unterminatedStrings++;
            return { ok: true, value: out };
          }
          continue;
        }
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else out += esc; // covers \" \\ \/ and anything else the model invented
        continue;
      }
      if (closesString(ch, opener)) {
        i++;
        return { ok: true, value: out };
      }
      // Raw control characters (a literal newline inside a string) are tolerated here.
      out += ch;
      i++;
    }
    flags.unterminatedStrings++;
    return { ok: true, value: out };
  };

  const parseNumberOrLiteral = (): Parsed => {
    const start = i;
    while (i < n && /[-+0-9eE.A-Za-z]/.test(text.charAt(i))) i++;
    const token = text.slice(start, i);
    if (!token) return NO_VALUE;
    if (token === 'true') return { ok: true, value: true };
    if (token === 'false') return { ok: true, value: false };
    if (token === 'null') return { ok: true, value: null };
    // A number that runs to the end of the input may have been cut in half —
    // `100` truncated to `10` still parses, and a plausible-but-wrong line
    // number is worse than a dropped one. Literals cannot be extended, so only
    // numbers are suspect here.
    if (i >= n) return NO_VALUE;
    try {
      const value = JSON.parse(token) as unknown;
      if (typeof value === 'number') return { ok: true, value };
    } catch {
      /* partial literal (`tru`) or garbage — treat as no value */
    }
    return NO_VALUE;
  };

  type Sync = 'comma' | 'close' | 'eof';

  /** Skip forward past junk to the next separator at this depth so one bad element cannot eat the rest. */
  const resync = (): Sync => {
    let depth = 0;
    while (i < n) {
      const ch = text.charAt(i);
      if (isOpenQuote(ch)) {
        parseString();
        continue;
      }
      if (ch === '{' || ch === '[') {
        depth++;
        i++;
        continue;
      }
      if (ch === '}' || ch === ']') {
        if (depth === 0) {
          i++;
          return 'close';
        }
        depth--;
        i++;
        continue;
      }
      if (ch === ',' && depth === 0) {
        i++;
        return 'comma';
      }
      i++;
    }
    return 'eof';
  };

  const parseArray = (): Parsed => {
    i++; // '['
    const items: unknown[] = [];
    let closed = false;

    for (;;) {
      skipTrivia();
      if (i >= n) break;
      if (text.charAt(i) === ']') {
        i++;
        closed = true;
        break;
      }

      const value = parseValue();
      if (value.ok) {
        items.push(value.value);
      } else {
        flags.droppedElements++;
        const sync = resync();
        if (sync === 'comma') continue;
        if (sync === 'close') closed = true;
        break;
      }

      skipTrivia();
      if (i >= n) break;
      const ch = text.charAt(i);
      if (ch === ',') {
        i++;
        skipTrivia();
        if (text.charAt(i) === ']') {
          flags.trailingCommas++;
          i++;
          closed = true;
          break;
        }
        continue;
      }
      if (ch === ']') {
        i++;
        closed = true;
        break;
      }
      const sync = resync();
      if (sync === 'comma') continue;
      if (sync === 'close') closed = true;
      break;
    }

    if (!closed) {
      flags.closedContainers++;
      if (items.length === 0) return NO_VALUE;
    }
    return { ok: true, value: items };
  };

  const parseKey = (): { ok: true; key: string } | { ok: false } => {
    const ch = text.charAt(i);
    if (isOpenQuote(ch)) {
      const parsed = parseString();
      return parsed.ok ? { ok: true, key: String(parsed.value) } : { ok: false };
    }
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i, i + 128));
    if (m) {
      i += m[0].length;
      flags.bareKeys++;
      return { ok: true, key: m[0] };
    }
    return { ok: false };
  };

  const parseObject = (): Parsed => {
    i++; // '{'
    const obj: Record<string, unknown> = {};
    let members = 0;
    let closed = false;

    for (;;) {
      skipTrivia();
      if (i >= n) break;
      if (text.charAt(i) === '}') {
        i++;
        closed = true;
        break;
      }

      const key = parseKey();
      if (!key.ok) {
        flags.droppedMembers++;
        const sync = resync();
        if (sync === 'comma') continue;
        if (sync === 'close') closed = true;
        break;
      }

      skipTrivia();
      if (i >= n || text.charAt(i) !== ':') {
        // A key with no value is not a member. This is the classic cut point.
        flags.droppedMembers++;
        if (i >= n) break;
        const sync = resync();
        if (sync === 'comma') continue;
        if (sync === 'close') closed = true;
        break;
      }
      i++; // ':'

      const value = parseValue();
      if (!value.ok) {
        flags.droppedMembers++;
        const sync = resync();
        if (sync === 'comma') continue;
        if (sync === 'close') closed = true;
        break;
      }
      obj[key.key] = value.value;
      members++;

      skipTrivia();
      if (i >= n) break;
      const ch = text.charAt(i);
      if (ch === ',') {
        i++;
        skipTrivia();
        if (text.charAt(i) === '}') {
          flags.trailingCommas++;
          i++;
          closed = true;
          break;
        }
        continue;
      }
      if (ch === '}') {
        i++;
        closed = true;
        break;
      }
      const sync = resync();
      if (sync === 'comma') continue;
      if (sync === 'close') closed = true;
      break;
    }

    if (!closed) {
      flags.closedContainers++;
      // Nothing complete inside: the element carries no information, so drop it.
      if (members === 0) return NO_VALUE;
    }
    return { ok: true, value: obj };
  };

  function parseValue(): Parsed {
    skipTrivia();
    if (i >= n) return NO_VALUE;
    const ch = text.charAt(i);
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (isOpenQuote(ch)) return parseString();
    return parseNumberOrLiteral();
  }

  const top = parseValue();
  if (!top.ok) return { ok: false, value: null, note: 'no salvageable JSON structure' };

  const parts: string[] = [];
  if (flags.unterminatedStrings) {
    parts.push(
      `closed ${flags.unterminatedStrings} unterminated string${flags.unterminatedStrings === 1 ? '' : 's'}`,
    );
  }
  if (flags.droppedMembers) {
    parts.push(
      `dropped ${flags.droppedMembers} incomplete object member${flags.droppedMembers === 1 ? '' : 's'}`,
    );
  }
  if (flags.droppedElements) {
    parts.push(
      `dropped ${flags.droppedElements} incomplete element${flags.droppedElements === 1 ? '' : 's'}`,
    );
  }
  if (flags.closedContainers) {
    parts.push(
      `closed ${flags.closedContainers} open bracket${flags.closedContainers === 1 ? '' : 's'}`,
    );
  }
  if (flags.trailingCommas) parts.push(`removed ${flags.trailingCommas} trailing comma(s)`);
  if (flags.comments) parts.push(`removed ${flags.comments} comment(s)`);
  if (flags.bareKeys) parts.push(`quoted ${flags.bareKeys} bare key(s)`);

  const truncated =
    flags.unterminatedStrings > 0 ||
    flags.closedContainers > 0 ||
    flags.droppedElements > 0 ||
    flags.droppedMembers > 0;
  const prefix = truncated
    ? 'model output was truncated and was repaired'
    : 'malformed JSON was repaired';
  const note = parts.length ? `${prefix}: ${parts.join(', ')}` : prefix;
  return { ok: true, value: top.value, note };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function strictParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: errorShape(err) };
  }
}

function joinNotes(...notes: string[]): string {
  return notes.filter((note) => note.length > 0).join('; ');
}

function failure<T>(note: string): RepairResult<T> {
  return { ok: false, value: null, repaired: false, note };
}

function runLadder<T>(raw: string): RepairResult<T> {
  if (typeof raw !== 'string') return failure('model output was not a string');
  if (raw.trim().length === 0) return failure('model output was empty');

  const candidates = buildCandidates(raw);
  if (candidates.length === 0) {
    return failure(`no JSON value found in ${raw.length} chars of model output`);
  }

  let lastError = 'none';

  // Steps 1-3: the JSON is intact somewhere in there.
  for (const candidate of candidates) {
    const parsed = strictParse(candidate.text);
    if (parsed.ok) {
      return {
        ok: true,
        value: parsed.value as T,
        repaired: false,
        note: candidate.note || 'model output was valid JSON',
      };
    }
    lastError = parsed.error;
  }

  // Step 4: rewrite the usual tics, then insist on strict JSON.
  for (const candidate of candidates) {
    const cleaned = sanitize(candidate.text);
    if (!cleaned.changed) continue;
    const parsed = strictParse(cleaned.text);
    if (parsed.ok) {
      return {
        ok: true,
        value: parsed.value as T,
        repaired: true,
        note: joinNotes(candidate.note, cleaned.notes.join(', ')),
      };
    }
  }

  // Step 5: truncation and anything else structural.
  for (const candidate of candidates) {
    const salvaged = tolerantParse(candidate.text);
    if (salvaged.ok) {
      return {
        ok: true,
        value: salvaged.value as T,
        repaired: true,
        note: joinNotes(candidate.note, salvaged.note),
      };
    }
  }

  return failure(
    `no parseable JSON in ${raw.length} chars of model output ` +
      `(${candidates.length} candidate${candidates.length === 1 ? '' : 's'} tried, last error: ${lastError})`,
  );
}

/**
 * Best-effort JSON extraction from raw model output. Never throws: a caller that
 * has to defend against this function is a caller that will drop findings.
 */
export function extractJson<T = unknown>(raw: string): RepairResult<T> {
  try {
    return runLadder<T>(raw);
  } catch (err) {
    // A bug in the repair ladder must not take down a review.
    return failure(`json repair failed unexpectedly (${errorShape(err)})`);
  }
}
