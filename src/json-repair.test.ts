// @ts-ignore -- the .ts extension is required by `node --experimental-strip-types`
import { extractJson } from './json-repair.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The findings shape the reviewer actually asks for. Truncation fixtures are cut
 * out of this so the tests exercise the real thing rather than a toy.
 */
const FINDINGS = [
  { path: 'src/a.ts', line: 10, claim: 'first claim' },
  { path: 'src/b.ts', line: 220, claim: 'second claim' },
  { path: 'src/c.ts', line: 3300, claim: 'third claim, cut off right about here' },
];
const FULL = JSON.stringify(FINDINGS);

function asArray(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// 1. clean JSON
// ---------------------------------------------------------------------------

test('parses clean JSON without claiming a repair', () => {
  const r = extractJson<{ a: number; b: string[] }>('{"a": 1, "b": ["x", "y"]}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: 1, b: ['x', 'y'] });
  assert.equal(r.repaired, false);
  assert.ok(r.note.length > 0);
});

test('parses a clean array with surrounding whitespace', () => {
  const r = extractJson('\n\n  [1, 2, 3]\n  ');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [1, 2, 3]);
  assert.equal(r.repaired, false);
});

// ---------------------------------------------------------------------------
// 2. markdown fences
// ---------------------------------------------------------------------------

test('strips a ```json fence', () => {
  const r = extractJson('Here is the result:\n```json\n{"a": [1, 2]}\n```\nHope that helps.');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: [1, 2] });
  assert.equal(r.repaired, false);
  assert.match(r.note, /fence|sliced/i);
});

test('strips a bare ``` fence', () => {
  const r = extractJson('```\n[{"id": "x"}]\n```');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [{ id: 'x' }]);
  assert.equal(r.repaired, false);
});

test('handles a fence whose closing marker never arrived', () => {
  const r = extractJson('```json\n{"a": 1, "b": 2}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: 1, b: 2 });
});

// ---------------------------------------------------------------------------
// 3. prose around the JSON, and the balanced scan
// ---------------------------------------------------------------------------

test('finds JSON with prose before and after it', () => {
  const r = extractJson('Sure. {"ok": true, "n": 2} Let me know if you want more.');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { ok: true, n: 2 });
  assert.equal(r.repaired, false);
});

test('a } inside a string literal does not fool the balanced scan', () => {
  const raw = 'Note: {"claim": "the handler returns } early", "line": 42} <- that one.';
  const r = extractJson<{ claim: string; line: number }>(raw);
  assert.equal(r.ok, true);
  assert.equal(r.value?.line, 42);
  assert.equal(r.value?.claim, 'the handler returns } early');
});

test('an escaped quote before a } does not fool the balanced scan', () => {
  const raw = 'x {"claim": "he said \\"}\\" and left", "n": 1} y';
  const r = extractJson<{ claim: string; n: number }>(raw);
  assert.equal(r.ok, true);
  assert.equal(r.value?.n, 1);
  assert.equal(r.value?.claim, 'he said "}" and left');
});

test('prefers the real payload over a decoy brace in the prose', () => {
  const r = extractJson('I checked {} and found: [{"a": 1}, {"a": 2}]');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [{ a: 1 }, { a: 2 }]);
});

// ---------------------------------------------------------------------------
// 4. truncation — the expensive case
// ---------------------------------------------------------------------------

test('truncation mid-string keeps every complete element and invents nothing', () => {
  const cut = FULL.slice(0, FULL.indexOf('third claim, cut off') + 'third claim,'.length);
  assert.ok(!cut.endsWith('"'), 'fixture must really be cut inside a string');

  const r = extractJson(cut);
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.match(r.note, /truncat/i);

  const items = asArray(r.value);
  // The completed prefix survives byte for byte.
  assert.deepEqual(items[0], FINDINGS[0]);
  assert.deepEqual(items[1], FINDINGS[1]);
  // The cut element is salvaged, never fabricated: only fields that arrived,
  // and the cut string is a prefix of what was being written.
  assert.deepEqual(Object.keys(items[2]!), ['path', 'line', 'claim']);
  assert.equal(items[2]!.path, FINDINGS[2].path);
  assert.equal(items[2]!.line, FINDINGS[2].line);
  assert.ok(
    FINDINGS[2].claim.startsWith(items[2]!.claim as string),
    'salvaged claim must be a prefix of the real one',
  );
});

test('truncation right after a key drops that member and keeps the rest', () => {
  const cut = FULL.slice(0, FULL.lastIndexOf('"claim":') + '"claim":'.length);

  const r = extractJson(cut);
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);

  const items = asArray(r.value);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], FINDINGS[0]);
  assert.deepEqual(items[1], FINDINGS[1]);
  // A key with no value is not a member.
  assert.deepEqual(items[2], { path: 'src/c.ts', line: 3300 });
  assert.match(r.note, /dropped .*member|truncat/i);
});

test('truncation right after an opening brace drops the empty tail element', () => {
  const cut = FULL.slice(0, FULL.lastIndexOf('{') + 1);
  const r = extractJson(cut);
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, [FINDINGS[0], FINDINGS[1]]);
});

test('truncation right after a comma keeps the completed elements', () => {
  const cut = FULL.slice(0, FULL.lastIndexOf('{'));
  assert.ok(cut.endsWith(','), 'fixture must end on the separator');
  const r = extractJson(cut);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [FINDINGS[0], FINDINGS[1]]);
});

test('truncation mid-number drops the half-written number rather than guessing', () => {
  const cut = '[{"path": "src/a.ts", "line": 33';
  const r = extractJson(cut);
  assert.equal(r.ok, true);
  // 33 could have been 3300; the member goes, the element stays.
  assert.deepEqual(r.value, [{ path: 'src/a.ts' }]);
});

test('truncation inside an unterminated fence still yields the finished elements', () => {
  const r = extractJson('```json\n[{"a": 1}, {"b": ');
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, [{ a: 1 }]);
});

test('truncation inside a nested findings array keeps the outer object', () => {
  const raw =
    '{"summary": "two problems", "findings": [{"id": "a-1", "line": 4}, {"id": "a-2", "line": ';
  const r = extractJson<{ summary: string; findings: unknown[] }>(raw);
  assert.equal(r.ok, true);
  assert.equal(r.value?.summary, 'two problems');
  // The tail element had one complete member, so it is kept minus the member
  // that never arrived — the caller validates required fields and drops it if
  // it is unusable. Only a tail element with nothing complete in it is dropped.
  assert.deepEqual(r.value?.findings, [{ id: 'a-1', line: 4 }, { id: 'a-2' }]);
  assert.match(r.note, /truncat/i);
});

test('an unterminated escape at the cut point does not break the salvage', () => {
  const r = extractJson('[{"a": "x"}, {"b": "line one\\');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [{ a: 'x' }, { b: 'line one' }]);
});

test('nothing salvageable reports failure instead of half an object', () => {
  const r = extractJson('[{');
  assert.equal(r.ok, false);
  assert.equal(r.value, null);
});

// ---------------------------------------------------------------------------
// 5. trailing commas and comments
// ---------------------------------------------------------------------------

test('removes trailing commas in objects and arrays', () => {
  const r = extractJson('{"a": 1, "b": [1, 2, 3,], }');
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { a: 1, b: [1, 2, 3] });
  assert.match(r.note, /trailing comma/i);
});

test('removes // comments without touching // inside strings', () => {
  const raw = [
    '{',
    '  // the model explaining itself',
    '  "a": 1, // and again',
    '  "url": "http://example.com/a//b"',
    '}',
  ].join('\n');
  const r = extractJson<{ a: number; url: string }>(raw);
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.equal(r.value?.a, 1);
  assert.equal(r.value?.url, 'http://example.com/a//b');
});

test('removes /* block */ comments', () => {
  const r = extractJson('{/* preamble */ "a": 1 /* tail */}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: 1 });
  assert.equal(r.repaired, true);
});

// ---------------------------------------------------------------------------
// 6. curly quotes
// ---------------------------------------------------------------------------

test('accepts curly quotes used as string delimiters', () => {
  const r = extractJson<{ claim: string; n: number }>('{“claim”: “it leaks”, “n”: 3}');
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { claim: 'it leaks', n: 3 });
  assert.match(r.note, /curly/i);
});

test('a straight quote inside a curly-quoted string survives', () => {
  const r = extractJson<{ claim: string }>('{“claim”: “he said "hi" loudly”}');
  assert.equal(r.ok, true);
  assert.equal(r.value?.claim, 'he said "hi" loudly');
});

test('curly quotes inside a normal string are left alone', () => {
  const r = extractJson<{ claim: string }>('{"claim": "he said “hi” loudly"}');
  assert.equal(r.ok, true);
  assert.equal(r.repaired, false);
  assert.equal(r.value?.claim, 'he said “hi” loudly');
});

// ---------------------------------------------------------------------------
// failure paths — never throw, never leak
// ---------------------------------------------------------------------------

test('reports failure on prose with no JSON in it', () => {
  const r = extractJson('I could not find anything wrong with this diff.');
  assert.equal(r.ok, false);
  assert.equal(r.value, null);
  assert.equal(r.repaired, false);
  assert.ok(r.note.length > 0);
  // The note is logged; it must describe the shape of the failure, not quote
  // the model's text back into a public Action log.
  assert.ok(!r.note.includes('could not find anything'));
});

test('reports failure on empty and whitespace-only output', () => {
  for (const raw of ['', '   ', '\n\t']) {
    const r = extractJson(raw);
    assert.equal(r.ok, false);
    assert.equal(r.value, null);
  }
});

test('never throws on non-string input', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    const r = extractJson(bad as unknown as string);
    assert.equal(typeof r.ok, 'boolean');
    if (!r.ok) assert.equal(r.value, null);
  }
});

test('never throws, and never invents data, for any prefix of a real payload', () => {
  const payload = JSON.stringify({ summary: 'a summary', findings: FINDINGS });
  for (let cut = 0; cut <= payload.length; cut++) {
    const prefix = payload.slice(0, cut);
    const r = extractJson<{ summary?: string; findings?: unknown[] }>(prefix);
    assert.equal(typeof r.ok, 'boolean', `prefix length ${cut}`);
    if (!r.ok || r.value === null) continue;

    const value = r.value;
    if (typeof value.summary === 'string') {
      assert.ok('a summary'.startsWith(value.summary), `prefix length ${cut}: summary invented`);
    }
    for (const [i, item] of (value.findings ?? []).entries()) {
      const original = FINDINGS[i]!;
      const got = item as Record<string, unknown>;
      for (const key of Object.keys(got)) {
        assert.ok(key in original, `prefix length ${cut}: invented key ${key}`);
        const expected = original[key as keyof typeof original];
        if (typeof expected === 'string') {
          assert.ok(
            expected.startsWith(got[key] as string),
            `prefix length ${cut}: ${key} is not a prefix of the real value`,
          );
        } else {
          assert.equal(got[key], expected, `prefix length ${cut}: ${key} was altered`);
        }
      }
    }
  }
});

test('the whole payload survives every prefix boundary once it is complete', () => {
  const r = extractJson(FULL);
  assert.equal(r.ok, true);
  assert.equal(r.repaired, false);
  assert.deepEqual(r.value, FINDINGS);
});
