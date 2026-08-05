import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore -- node's type stripper needs the explicit extension; tsconfig has no allowImportingTsExtensions
import { applyLimits, clampBody } from './limits.ts';
import type { PostableComment, LimitConfig } from './limits';
import type { Severity } from './types';

function c(
  path: string,
  line: number,
  severity: Severity,
  body = 'body',
  category = 'bug',
): PostableComment {
  return { path, line, side: 'RIGHT', body, severity, category };
}

function limits(
  maxCommentsPerFile: number,
  maxCommentsTotal: number,
  maxCommentBodyChars = 0,
): LimitConfig {
  return { maxCommentsPerFile, maxCommentsTotal, maxCommentBodyChars };
}

function backtickCount(s: string): number {
  return (s.match(/`/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// selection: severity decides what survives
// ---------------------------------------------------------------------------

test('a tight total cap keeps the most severe comments', () => {
  const input = [
    c('a.ts', 10, 'minor', 'minor-1'),
    c('a.ts', 20, 'major', 'major-1'),
    c('a.ts', 30, 'critical', 'critical-1'),
  ];
  const r = applyLimits(input, limits(10, 2));

  assert.equal(r.kept.length, 2);
  assert.deepEqual(
    r.kept.map((k) => k.body).sort(),
    ['critical-1', 'major-1'],
  );
  assert.equal(r.droppedForTotalLimit, 1);
  assert.equal(r.droppedForFileLimit, 0);
});

test('selection is stable within a severity (input order wins)', () => {
  const input = [
    c('a.ts', 30, 'major', 'first'),
    c('a.ts', 20, 'major', 'second'),
    c('a.ts', 10, 'major', 'third'),
  ];
  const r = applyLimits(input, limits(10, 2));

  // "first" and "second" are selected; "third" loses on input order.
  assert.deepEqual(
    r.kept.map((k) => k.body).sort(),
    ['first', 'second'],
  );
  // ...and they come out in document order, line 20 before line 30.
  assert.deepEqual(
    r.kept.map((k) => k.line),
    [20, 30],
  );
});

test('unknown severity labels sort last but are not crashed on', () => {
  const input = [
    c('a.ts', 1, 'weird' as Severity, 'unknown'),
    c('a.ts', 2, 'critical', 'critical'),
  ];
  const r = applyLimits(input, limits(10, 1));
  assert.deepEqual(
    r.kept.map((k) => k.body),
    ['critical'],
  );
});

// ---------------------------------------------------------------------------
// emission: document order, not severity order
// ---------------------------------------------------------------------------

test('kept comments are emitted in document order after severity selection', () => {
  const input = [
    c('src/z.ts', 5, 'minor', 'z5'),
    c('src/a.ts', 90, 'critical', 'a90'),
    c('src/a.ts', 12, 'minor', 'a12'),
    c('src/m.ts', 3, 'major', 'm3'),
  ];
  const r = applyLimits(input, limits(10, 10));

  assert.deepEqual(
    r.kept.map((k) => `${k.path}:${k.line}`),
    ['src/a.ts:12', 'src/a.ts:90', 'src/m.ts:3', 'src/z.ts:5'],
  );
  // The classic bug: emitting severity-grouped output would start with a90.
  assert.notEqual(r.kept[0]!.body, 'a90');
});

test('duplicate (path, line) pairs survive the re-sort intact', () => {
  const input = [
    c('a.ts', 5, 'minor', 'dup-minor'),
    c('a.ts', 5, 'critical', 'dup-critical'),
    c('a.ts', 5, 'major', 'dup-major'),
    c('a.ts', 6, 'major', 'other'),
  ];
  const r = applyLimits(input, limits(10, 10));

  assert.equal(r.kept.length, 4);
  const atFive = r.kept.filter((k) => k.line === 5).map((k) => k.body);
  assert.equal(atFive.length, 3);
  assert.deepEqual(atFive.slice().sort(), ['dup-critical', 'dup-major', 'dup-minor']);
  // Same anchor: severity still decides the local order.
  assert.deepEqual(atFive, ['dup-critical', 'dup-major', 'dup-minor']);
  assert.equal(r.kept[3]!.body, 'other');
});

test('duplicates are not deduplicated away when only some of them fit', () => {
  const input = [
    c('a.ts', 5, 'minor', 'd1'),
    c('a.ts', 5, 'minor', 'd2'),
    c('a.ts', 5, 'minor', 'd3'),
  ];
  const r = applyLimits(input, limits(10, 2));
  assert.deepEqual(
    r.kept.map((k) => k.body),
    ['d1', 'd2'],
  );
});

// ---------------------------------------------------------------------------
// caps
// ---------------------------------------------------------------------------

test('the per-file cap is enforced and counted separately', () => {
  const input = [
    c('a.ts', 1, 'major', 'a1'),
    c('a.ts', 2, 'major', 'a2'),
    c('a.ts', 3, 'major', 'a3'),
    c('b.ts', 1, 'minor', 'b1'),
  ];
  const r = applyLimits(input, limits(2, 10));

  assert.deepEqual(
    r.kept.map((k) => k.body),
    ['a1', 'a2', 'b1'],
  );
  assert.equal(r.droppedForFileLimit, 1);
  assert.equal(r.droppedForTotalLimit, 0);
});

test('both caps can bite in the same run and are counted independently', () => {
  const input = [
    c('a.ts', 1, 'critical', 'a1'),
    c('a.ts', 2, 'critical', 'a2'),
    c('a.ts', 3, 'critical', 'a3'), // over the per-file cap
    c('b.ts', 1, 'minor', 'b1'),
    c('c.ts', 1, 'minor', 'c1'), // over the total cap
  ];
  const r = applyLimits(input, limits(2, 3));

  assert.equal(r.kept.length, 3);
  assert.equal(r.droppedForFileLimit, 1);
  assert.equal(r.droppedForTotalLimit, 1);
});

test('a zero total cap posts nothing', () => {
  const input = [c('a.ts', 1, 'critical'), c('b.ts', 2, 'major')];
  const r = applyLimits(input, limits(10, 0));
  assert.equal(r.kept.length, 0);
  assert.equal(r.droppedForTotalLimit, 2);
});

test('an empty input is not an error', () => {
  const r = applyLimits([], limits(10, 40, 100));
  assert.deepEqual(r, {
    kept: [],
    droppedForFileLimit: 0,
    droppedForTotalLimit: 0,
    bodiesClamped: 0,
  });
});

// ---------------------------------------------------------------------------
// bodies
// ---------------------------------------------------------------------------

test('over-long bodies are clamped and counted', () => {
  const long = 'x'.repeat(100);
  const input = [c('a.ts', 1, 'major', long), c('a.ts', 2, 'major', 'short body')];
  const r = applyLimits(input, limits(10, 10, 20));

  assert.equal(r.bodiesClamped, 1);
  assert.ok(r.kept[0]!.body.length <= 20);
  assert.equal(r.kept[1]!.body, 'short body');
});

test('applyLimits does not mutate its input', () => {
  const long = 'y'.repeat(100);
  const input = [c('a.ts', 1, 'major', long)];
  const snapshot = JSON.parse(JSON.stringify(input));
  applyLimits(input, limits(10, 10, 20));
  assert.deepEqual(input, snapshot);
});

// ---------------------------------------------------------------------------
// clampBody
// ---------------------------------------------------------------------------

test('clampBody leaves short bodies alone', () => {
  assert.equal(clampBody('short', 100), 'short');
  assert.equal(clampBody('exactly-ten', 11), 'exactly-ten');
});

test('clampBody with maxChars <= 0 disables truncation', () => {
  const long = 'z'.repeat(5000);
  assert.equal(clampBody(long, 0), long);
  assert.equal(clampBody(long, -1), long);
});

test('clampBody truncates at a nearby word boundary', () => {
  const body = 'the quick brown fox jumps over the lazy dog';
  const out = clampBody(body, 20);
  assert.equal(out, 'the quick brown …');
  assert.ok(out.length <= 20);
});

test('clampBody hard-cuts when no word boundary is nearby', () => {
  const body = `${'a'.repeat(60)} tail`;
  const out = clampBody(body, 20);
  assert.ok(out.length <= 20);
  assert.ok(out.endsWith(' …'));
  assert.ok(out.startsWith('aaaa'));
});

test('clampBody never leaves an unmatched inline-code backtick', () => {
  const body = 'Use `someExtremelyLongFunctionName(arg)` before calling it again.';
  const out = clampBody(body, 30);
  assert.ok(out.length <= 30, `length ${out.length}`);
  assert.equal(backtickCount(out) % 2, 0, out);
  assert.ok(out.includes('`'));
  assert.ok(out.endsWith(' …'));
});

test('clampBody closes a fenced block with a matching run', () => {
  const body = '```js\nconst x = averyveryverylongthing();\n```';
  const out = clampBody(body, 20);
  assert.ok(out.length <= 20, `length ${out.length}`);
  assert.equal(backtickCount(out), 6, out);
  assert.ok(out.endsWith(' …'));
});

test('clampBody drops a trailing opener instead of emitting an empty span', () => {
  const out = clampBody('abcdefghij`klmnopqrst', 13);
  assert.equal(out, 'abcdefghij …');
  assert.equal(backtickCount(out), 0);
});

test('clampBody keeps balanced spans balanced', () => {
  const body = 'call `a` then `b` then a very long trailing explanation goes here';
  const out = clampBody(body, 24);
  assert.ok(out.length <= 24);
  assert.equal(backtickCount(out) % 2, 0, out);
});

test('clampBody degrades to a hard cut when there is no room for the ellipsis', () => {
  assert.equal(clampBody('abcdef', 2), 'ab');
  assert.equal(clampBody('abcdef', 1), 'a');
});
