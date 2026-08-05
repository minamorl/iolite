import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The module under test is loaded through a dynamic import, because no single
 * static specifier satisfies both toolchains:
 *
 *   - `node --experimental-strip-types` reparses this file as ESM (it contains
 *     `import`), and the ESM resolver has no extension search — `./diff-parser`
 *     is ERR_MODULE_NOT_FOUND, only `./diff-parser.ts` resolves.
 *   - `tsc` with this repo's `module: commonjs` rejects a `.ts` extension
 *     outright (TS5097) unless `allowImportingTsExtensions` is set.
 *
 * Concatenating the specifier keeps the literal out of tsc's static analysis
 * while resolving relative to *this file* at runtime. Types are recovered from
 * `import(...)` type syntax, which is erased before Node sees it, so nothing
 * here is untyped.
 */
type DiffParserModule = typeof import('./diff-parser');
type ParsedDiff = import('./diff-parser').ParsedDiff;
type FileDiff = import('./diff-parser').FileDiff;
type DiffLine = import('./diff-parser').DiffLine;

let parseUnifiedDiff: DiffParserModule['parseUnifiedDiff'];
let filterByPaths: DiffParserModule['filterByPaths'];
let isCommentableLine: DiffParserModule['isCommentableLine'];
let snapToCommentableLine: DiffParserModule['snapToCommentableLine'];
let renderDiffForPrompt: DiffParserModule['renderDiffForPrompt'];

before(async () => {
  const mod = (await import('./diff-parser' + '.ts')) as DiffParserModule;
  parseUnifiedDiff = mod.parseUnifiedDiff;
  filterByPaths = mod.filterByPaths;
  isCommentableLine = mod.isCommentableLine;
  snapToCommentableLine = mod.snapToCommentableLine;
  renderDiffForPrompt = mod.renderDiffForPrompt;
});

/**
 * Fixtures are built from arrays of lines so that leading/trailing spaces —
 * which are load-bearing in a unified diff — survive editors and formatters.
 */
function diffOf(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

function fileOf(parsed: ParsedDiff, path: string): FileDiff {
  const fd = parsed.files.get(path);
  if (!fd) throw new Error(`expected ${path} in parsed diff, got [${[...parsed.files.keys()].join(', ')}]`);
  return fd;
}

function pairs(fd: FileDiff): Array<[number, string, string]> {
  return fd.lines.map((l: DiffLine) => [l.rightLine, l.type, l.content] as [number, string, string]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MULTI_HUNK = diffOf(
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,6 +1,7 @@',
  " import fs from 'fs';",
  '-const a = 1;',
  '+const a = 2;',
  '+const b = 3;',
  ' ',
  ' function main() {',
  '   return a;',
  ' }',
  '@@ -20,3 +21,4 @@ function main() {',
  ' const x = 10;',
  '-const y = 20;',
  '+const y = 21;',
  '+const z = 22;',
  ' export { main };',
);

// ---------------------------------------------------------------------------
// Line arithmetic
// ---------------------------------------------------------------------------

test('tracks the right-side cursor across multiple hunks', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK);
  assert.deepEqual([...parsed.files.keys()], ['src/app.ts']);

  const fd = fileOf(parsed, 'src/app.ts');
  assert.deepEqual(pairs(fd), [
    [1, 'context', "import fs from 'fs';"],
    [2, 'add', 'const a = 2;'],
    [3, 'add', 'const b = 3;'],
    [4, 'context', ''],
    [5, 'context', 'function main() {'],
    [6, 'context', '  return a;'],
    [7, 'context', '}'],
    // Second hunk restarts the cursor at its own `+21`, not wherever the first
    // hunk happened to stop.
    [21, 'context', 'const x = 10;'],
    [22, 'add', 'const y = 21;'],
    [23, 'add', 'const z = 22;'],
    [24, 'context', 'export { main };'],
  ]);

  assert.deepEqual([...fd.addedLines].sort((a, b) => a - b), [2, 3, 22, 23]);
  assert.deepEqual(
    [...fd.reachableLines].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 21, 22, 23, 24],
  );
});

test('deletions do not advance the right-side cursor', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/del.ts b/del.ts',
      'index 1111111..2222222 100644',
      '--- a/del.ts',
      '+++ b/del.ts',
      '@@ -1,4 +1,2 @@',
      ' keep1',
      '-drop1',
      '-drop2',
      ' keep2',
    ),
  );
  const fd = fileOf(parsed, 'del.ts');
  // keep2 is post-image line 2. A parser that advanced on `-` would say 4.
  assert.deepEqual(pairs(fd), [
    [1, 'context', 'keep1'],
    [2, 'context', 'keep2'],
  ]);
  assert.equal(fd.addedLines.size, 0);
});

test('a hunk that only deletes contributes no right-side lines', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/only-del.ts b/only-del.ts',
      '--- a/only-del.ts',
      '+++ b/only-del.ts',
      '@@ -5,2 +4,0 @@ ctx',
      '-gone1',
      '-gone2',
    ),
  );
  const fd = fileOf(parsed, 'only-del.ts');
  assert.deepEqual(fd.lines, []);
  assert.equal(fd.reachableLines.size, 0);
});

test('hunk header without counts means one line per side', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/one.ts b/one.ts',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ),
  );
  const fd = fileOf(parsed, 'one.ts');
  assert.deepEqual(pairs(fd), [[1, 'add', 'new']]);
});

test('mixed count/no-count hunk header', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/mix.ts b/mix.ts',
      '--- a/mix.ts',
      '+++ b/mix.ts',
      '@@ -3 +3,2 @@',
      '-old',
      '+new1',
      '+new2',
    ),
  );
  const fd = fileOf(parsed, 'mix.ts');
  assert.deepEqual(pairs(fd), [
    [3, 'add', 'new1'],
    [4, 'add', 'new2'],
  ]);
});

test('"\\ No newline at end of file" does not shift numbering', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/eof.txt b/eof.txt',
      'index 1111111..2222222 100644',
      '--- a/eof.txt',
      '+++ b/eof.txt',
      '@@ -1,2 +1,2 @@',
      ' first',
      '-second',
      '\\ No newline at end of file',
      '+second!',
      '\\ No newline at end of file',
    ),
  );
  const fd = fileOf(parsed, 'eof.txt');
  assert.deepEqual(pairs(fd), [
    [1, 'context', 'first'],
    [2, 'add', 'second!'],
  ]);
});

test('an empty line inside a hunk is a context line the transport trimmed', () => {
  // Same shape as MULTI_HUNK's blank context line, but with the single leading
  // space stripped. The hunk counts still owe a line there, so it is content.
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/trim.ts b/trim.ts',
      '--- a/trim.ts',
      '+++ b/trim.ts',
      '@@ -1,3 +1,4 @@',
      ' head',
      '',
      '+added',
      ' tail',
    ),
  );
  const fd = fileOf(parsed, 'trim.ts');
  assert.deepEqual(pairs(fd), [
    [1, 'context', 'head'],
    [2, 'context', ''],
    [3, 'add', 'added'],
    [4, 'context', 'tail'],
  ]);
});

test('hunk counts stop the body, so a diff of a diff parses as one file', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/fixtures/sample.diff b/fixtures/sample.diff',
      'index 1111111..2222222 100644',
      '--- a/fixtures/sample.diff',
      '+++ b/fixtures/sample.diff',
      '@@ -1,4 +1,5 @@',
      ' diff --git a/x.txt b/x.txt',
      ' --- a/x.txt',
      ' +++ b/x.txt',
      '-@@ -1 +1 @@',
      '+@@ -1,2 +1,2 @@',
      '+ extra context',
    ),
  );
  // The header-shaped lines inside the hunk body must not create files.
  assert.deepEqual([...parsed.files.keys()], ['fixtures/sample.diff']);
  const fd = fileOf(parsed, 'fixtures/sample.diff');
  assert.deepEqual(pairs(fd), [
    [1, 'context', 'diff --git a/x.txt b/x.txt'],
    [2, 'context', '--- a/x.txt'],
    [3, 'context', '+++ b/x.txt'],
    [4, 'add', '@@ -1,2 +1,2 @@'],
    [5, 'add', ' extra context'],
  ]);
});

test('CRLF line endings parse identically', () => {
  const lf = parseUnifiedDiff(MULTI_HUNK);
  const crlf = parseUnifiedDiff(MULTI_HUNK.split('\n').join('\r\n'));
  assert.deepEqual(pairs(fileOf(crlf, 'src/app.ts')), pairs(fileOf(lf, 'src/app.ts')));
});

// ---------------------------------------------------------------------------
// File-level shapes
// ---------------------------------------------------------------------------

test('new file: every line is an addition starting at 1', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..abcdef1',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,3 @@',
      '+alpha',
      '+beta',
      '+gamma',
    ),
  );
  const fd = fileOf(parsed, 'new.txt');
  assert.deepEqual(pairs(fd), [
    [1, 'add', 'alpha'],
    [2, 'add', 'beta'],
    [3, 'add', 'gamma'],
  ]);
});

test('deleted file is skipped entirely — it has no right side', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index abcdef1..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      'diff --git a/kept.txt b/kept.txt',
      '--- a/kept.txt',
      '+++ b/kept.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['kept.txt']);
});

test('+++ /dev/null alone is enough to drop a file', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-one',
    ),
  );
  assert.equal(parsed.files.size, 0);
});

test('rename with edits is keyed by the new path only', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 85%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      'index 1111111..2222222 100644',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = 4;',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['new/name.ts']);
  assert.deepEqual(pairs(fileOf(parsed, 'new/name.ts')), [
    [1, 'context', 'const a = 1;'],
    [2, 'add', 'const b = 3;'],
    [3, 'context', 'const c = 4;'],
  ]);
});

test('pure rename has no hunks and is keyed by "rename to"', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/docs/one.md b/guide/two.md',
      'similarity index 100%',
      'rename from docs/one.md',
      'rename to guide/two.md',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['guide/two.md']);
  assert.deepEqual(fileOf(parsed, 'guide/two.md').lines, []);
});

test('binary file appears with no lines', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/img/logo.png b/img/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/img/logo.png and b/img/logo.png differ',
    ),
  );
  const fd = fileOf(parsed, 'img/logo.png');
  assert.deepEqual(fd.lines, []);
  assert.equal(fd.reachableLines.size, 0);
  assert.equal(isCommentableLine(parsed, 'img/logo.png', 1), false);
});

test('GIT binary patch payload does not leak into the file list', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/img/logo.png b/img/logo.png',
      'index 1111111..2222222 100644',
      'GIT binary patch',
      'literal 12',
      'zcmZQzU|?VYVBlbTU}<3RVqjopVBlbTU|?VYVBlbT',
      '',
      'literal 0',
      'HcmV?d00001',
      '',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['img/logo.png']);
  assert.deepEqual(fileOf(parsed, 'img/logo.png').lines, []);
});

test('mode-only change is keyed from the "diff --git" header', () => {
  const parsed = parseUnifiedDiff(
    diffOf('diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'),
  );
  const fd = fileOf(parsed, 'run.sh');
  assert.deepEqual(fd.lines, []);
});

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

test('paths containing spaces survive the +++ header', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/my dir/some file.ts b/my dir/some file.ts',
      'index 1111111..2222222 100644',
      '--- a/my dir/some file.ts',
      '+++ b/my dir/some file.ts',
      '@@ -1,1 +1,2 @@',
      ' keep',
      '+added',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['my dir/some file.ts']);
  assert.deepEqual(pairs(fileOf(parsed, 'my dir/some file.ts')), [
    [1, 'context', 'keep'],
    [2, 'add', 'added'],
  ]);
});

test('paths containing spaces survive the "diff --git" fallback', () => {
  // No `+++` header exists for a binary file, so the ambiguous git header is
  // the only source. Both sides naming the same file resolves the ambiguity.
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/my dir/logo big.png b/my dir/logo big.png',
      'index 1111111..2222222 100644',
      'Binary files a/my dir/logo big.png and b/my dir/logo big.png differ',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['my dir/logo big.png']);
});

test('rename of a spaced path falls back to "rename to"', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/old dir/a b.txt b/new dir/c d.txt',
      'similarity index 100%',
      'rename from old dir/a b.txt',
      'rename to new dir/c d.txt',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['new dir/c d.txt']);
});

test('C-quoted path with an escaped quote is unquoted', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"',
      'index 1111111..2222222 100644',
      '--- "a/we\\"ird.txt"',
      '+++ "b/we\\"ird.txt"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['we"ird.txt']);
  assert.deepEqual(pairs(fileOf(parsed, 'we"ird.txt')), [[1, 'add', 'new']]);
});

test('C-quoted path with octal escapes decodes as UTF-8', () => {
  // git with core.quotePath=true writes `café.txt` as `caf\303\251.txt`.
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      '@@ -0,0 +1 @@',
      '+hello',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['café.txt']);
});

test('C-quoted path with a literal backslash and tab', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git "a/we\\\\ird\\ttab.txt" "b/we\\\\ird\\ttab.txt"',
      '--- "a/we\\\\ird\\ttab.txt"',
      '+++ "b/we\\\\ird\\ttab.txt"',
      '@@ -0,0 +1 @@',
      '+hello',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['we\\ird\ttab.txt']);
});

test('a trailing tab timestamp on the +++ header is stripped', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      '--- a/plain.txt\t2026-01-01 00:00:00.000000000 +0000',
      '+++ b/plain.txt\t2026-01-02 00:00:00.000000000 +0000',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['plain.txt']);
});

test('a plain (non-git) unified diff with several files splits on ---', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1 +1 @@',
      '-c',
      '+d',
    ),
  );
  assert.deepEqual([...parsed.files.keys()], ['one.txt', 'two.txt']);
  assert.deepEqual(pairs(fileOf(parsed, 'two.txt')), [[1, 'add', 'd']]);
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

test('malformed input never throws', () => {
  const garbage = [
    '',
    '\n',
    'not a diff at all',
    'diff --git',
    'diff --git a/x b/y\n@@ garbage @@\n+++\n',
    '@@ -1,2 +1,2 @@\n+orphan hunk with no file header\n',
    '+++ b/only-a-header.ts',
    '--- \n+++ \n@@ @@\n',
    'diff --git "a/unterminated b/unterminated\n+++ "b/unterminated\n',
    '@@ -1,999999 +1,999999 @@\n+one line only\n',
    '\u0000\u0001binary garbage\uFFFD',
    'diff --git a/x.ts b/x.ts\n@@ -1,2 +1,2 @@\n', // hunk header then EOF
  ];
  for (const g of garbage) {
    const parsed = parseUnifiedDiff(g);
    assert.ok(parsed.files instanceof Map, `expected a Map for ${JSON.stringify(g)}`);
    // Callers must survive whatever came back.
    assert.equal(isCommentableLine(parsed, 'x.ts', 1000), false);
    assert.equal(snapToCommentableLine(parsed, 'nope.ts', 1), null);
    renderDiffForPrompt(parsed, 1000);
  }
});

test('a hunk with no owning file header yields no files', () => {
  const parsed = parseUnifiedDiff(diffOf('@@ -1,2 +1,2 @@', ' ctx', '+added'));
  assert.equal(parsed.files.size, 0);
});

test('non-string input does not throw', () => {
  assert.equal(parseUnifiedDiff(null as unknown as string).files.size, 0);
  assert.equal(parseUnifiedDiff(undefined as unknown as string).files.size, 0);
  assert.equal(parseUnifiedDiff(42 as unknown as string).files.size, 0);
});

test('a combined (merge) diff is ignored rather than mis-numbered', () => {
  // `@@@ -1,2 -1,2 +1,2 @@@` has two left sides; guessing at right-side numbers
  // here would be worse than emitting nothing.
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --cc merged.ts',
      'index 1111111,2222222..3333333',
      '--- a/merged.ts',
      '+++ b/merged.ts',
      '@@@ -1,2 -1,2 +1,2 @@@',
      '  shared',
      '- ours',
      ' -theirs',
      '++resolved',
    ),
  );
  const fd = fileOf(parsed, 'merged.ts');
  assert.deepEqual(fd.lines, []);
  assert.equal(isCommentableLine(parsed, 'merged.ts', 1), false);
});

test('the same file appearing twice merges instead of clobbering', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/dup.ts b/dup.ts',
      '--- a/dup.ts',
      '+++ b/dup.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ) +
      diffOf(
        'diff --git a/dup.ts b/dup.ts',
        '--- a/dup.ts',
        '+++ b/dup.ts',
        '@@ -10 +10 @@',
        '-c',
        '+d',
      ),
  );
  assert.deepEqual([...parsed.files.keys()], ['dup.ts']);
  assert.deepEqual(pairs(fileOf(parsed, 'dup.ts')), [
    [1, 'add', 'b'],
    [10, 'add', 'd'],
  ]);
});

test('a hunk truncated mid-body keeps the lines it did see', () => {
  const parsed = parseUnifiedDiff(
    'diff --git a/cut.ts b/cut.ts\n--- a/cut.ts\n+++ b/cut.ts\n@@ -1,5 +1,5 @@\n ctx1\n+added',
  );
  assert.deepEqual(pairs(fileOf(parsed, 'cut.ts')), [
    [1, 'context', 'ctx1'],
    [2, 'add', 'added'],
  ]);
});

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

test('isCommentableLine accepts added and context lines only', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK);
  assert.equal(isCommentableLine(parsed, 'src/app.ts', 2), true); // added
  assert.equal(isCommentableLine(parsed, 'src/app.ts', 1), true); // context
  assert.equal(isCommentableLine(parsed, 'src/app.ts', 24), true);
  assert.equal(isCommentableLine(parsed, 'src/app.ts', 8), false); // between hunks
  assert.equal(isCommentableLine(parsed, 'src/app.ts', 0), false);
  assert.equal(isCommentableLine(parsed, 'src/app.ts', 1.5), false);
  assert.equal(isCommentableLine(parsed, 'src/app.ts', NaN), false);
  assert.equal(isCommentableLine(parsed, 'no/such/file.ts', 1), false);
});

test('a deleted line number is not commentable on the right side', () => {
  const parsed = parseUnifiedDiff(
    diffOf(
      'diff --git a/del.ts b/del.ts',
      '--- a/del.ts',
      '+++ b/del.ts',
      '@@ -1,4 +1,2 @@',
      ' keep1',
      '-drop1',
      '-drop2',
      ' keep2',
    ),
  );
  assert.equal(isCommentableLine(parsed, 'del.ts', 2), true); // keep2
  assert.equal(isCommentableLine(parsed, 'del.ts', 3), false);
  assert.equal(isCommentableLine(parsed, 'del.ts', 4), false);
});

test('snapToCommentableLine returns an exact hit unchanged', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK);
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', 2), 2); // added
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', 4), 4); // context
});

test('snapToCommentableLine prefers an added line over a nearer context line', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK);
  // 21 is context (distance 1); 22 is added (distance 2). A review comment
  // belongs on changed code, so the added line wins.
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', 20), 22);
});

test('snapToCommentableLine falls back to context when no added line is in range', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK);
  // Nearest added lines to 8 are 3 and 22, both out of tolerance; 7 is context.
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', 8), 7);
});

test('snapToCommentableLine returns null beyond the tolerance', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK);
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', 15), null);
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', 8, 0), null);
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', 12, 1), null);
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', 200), null);
});

test('snapToCommentableLine honours a widened tolerance', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK);
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', 15), null);
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', 15, 10), 22); // added beats context 7
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', 9, 10), 3); // both added; nearer wins
});

test('snapToCommentableLine rejects unknown files and non-finite input', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK);
  assert.equal(snapToCommentableLine(parsed, 'no/such/file.ts', 2), null);
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', NaN), null);
  assert.equal(snapToCommentableLine(parsed, 'src/app.ts', Infinity), null);
});

// ---------------------------------------------------------------------------
// Path filtering
// ---------------------------------------------------------------------------

function fileDiffFixture(path: string): string {
  return diffOf(
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1,2 @@',
    ' keep',
    '+added',
  );
}

const FILTER_PATHS = [
  'src/app.ts',
  'src/util/helper.ts',
  'src/__snapshots__/a.snap',
  'a.snap',
  'docs/readme.md',
  'yarn.lock',
  'sub/deps.lock',
];

const FILTER_DIFF = FILTER_PATHS.map(fileDiffFixture).join('');

function keysAfter(include: string[], exclude: string[]): string[] {
  const parsed = parseUnifiedDiff(FILTER_DIFF);
  return [...filterByPaths(parsed, include, exclude).files.keys()];
}

test('the filter fixture parses into every expected file', () => {
  assert.deepEqual([...parseUnifiedDiff(FILTER_DIFF).files.keys()], FILTER_PATHS);
});

test('an empty include list means everything', () => {
  assert.deepEqual(keysAfter([], []), FILTER_PATHS);
});

test('include matches by path prefix', () => {
  assert.deepEqual(keysAfter(['src/'], []), [
    'src/app.ts',
    'src/util/helper.ts',
    'src/__snapshots__/a.snap',
  ]);
  assert.deepEqual(keysAfter(['src/util'], []), ['src/util/helper.ts']);
  assert.deepEqual(keysAfter(['docs/', 'yarn.lock'], []), ['docs/readme.md', 'yarn.lock']);
});

test('exclusion beats inclusion', () => {
  assert.deepEqual(keysAfter(['src/app.ts'], ['src/']), []);
  assert.deepEqual(keysAfter(['src/'], ['src/util/']), [
    'src/app.ts',
    'src/__snapshots__/a.snap',
  ]);
});

test('glob exclusion: **/*.snap matches nested and root-level files', () => {
  assert.deepEqual(keysAfter([], ['**/*.snap']), [
    'src/app.ts',
    'src/util/helper.ts',
    'docs/readme.md',
    'yarn.lock',
    'sub/deps.lock',
  ]);
});

test('glob exclusion: a slash-free pattern also matches basenames', () => {
  assert.deepEqual(keysAfter([], ['*.lock']), [
    'src/app.ts',
    'src/util/helper.ts',
    'src/__snapshots__/a.snap',
    'a.snap',
    'docs/readme.md',
  ]);
});

test('a single * does not cross a directory boundary', () => {
  // `src/*.ts` must not pull in src/util/helper.ts.
  assert.deepEqual(keysAfter(['src/*.ts'], []), ['src/app.ts']);
  assert.deepEqual(keysAfter(['src/**/*.ts'], []), ['src/app.ts', 'src/util/helper.ts']);
});

test('glob include combines with glob exclude', () => {
  assert.deepEqual(keysAfter(['src/**'], ['**/*.snap']), ['src/app.ts', 'src/util/helper.ts']);
});

test('regex metacharacters in a pattern are literal', () => {
  const parsed = parseUnifiedDiff(fileDiffFixture('src/a+b(c).ts') + fileDiffFixture('src/axbxc.ts'));
  const kept = [...filterByPaths(parsed, ['src/a+b(c)*'], []).files.keys()];
  assert.deepEqual(kept, ['src/a+b(c).ts']);
});

test('blank filter entries are ignored rather than matching everything', () => {
  assert.deepEqual(keysAfter(['', '  '], []), FILTER_PATHS);
  assert.deepEqual(keysAfter([], ['', '   ']), FILTER_PATHS);
});

test('filterByPaths does not mutate its input', () => {
  const parsed = parseUnifiedDiff(FILTER_DIFF);
  const before = [...parsed.files.keys()];
  const beforeLines = fileOf(parsed, 'src/app.ts').lines.length;

  const filtered = filterByPaths(parsed, ['src/'], ['**/*.snap']);
  // Mutating the result must not reach back into the source.
  filtered.files.delete('src/app.ts');
  const other = fileOf(filtered, 'src/util/helper.ts');
  other.reachableLines.add(9999);
  other.addedLines.add(9999);
  other.lines.push({ path: 'x', rightLine: 1, type: 'add', content: 'x' });

  assert.deepEqual([...parsed.files.keys()], before);
  assert.equal(fileOf(parsed, 'src/app.ts').lines.length, beforeLines);
  assert.equal(fileOf(parsed, 'src/util/helper.ts').reachableLines.has(9999), false);
  assert.equal(fileOf(parsed, 'src/util/helper.ts').lines.length, 2);
  assert.notEqual(fileOf(parsed, 'src/util/helper.ts'), other);
});

test('filtering out everything yields an empty, usable ParsedDiff', () => {
  const parsed = parseUnifiedDiff(FILTER_DIFF);
  const filtered = filterByPaths(parsed, ['nothing/matches/'], []);
  assert.equal(filtered.files.size, 0);
  assert.equal(isCommentableLine(filtered, 'src/app.ts', 1), false);
  assert.deepEqual(renderDiffForPrompt(filtered), {
    text: '',
    truncated: false,
    filesEmitted: 0,
    filesOmitted: 0,
    truncatedFiles: [],
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Mirrors the renderer's line format, so the format itself is under test. */
function expectedLine(l: DiffLine): string {
  return `[${l.type === 'add' ? '+' : ' '} ${l.rightLine}] ${l.content}\n`;
}

function expectedBlockBytes(fd: FileDiff): number {
  let n = Buffer.byteLength(`## ${fd.path}\n`, 'utf8');
  for (const l of fd.lines) n += Buffer.byteLength(expectedLine(l), 'utf8');
  return n;
}

test('renders a line-numbered diff in the documented format', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK);
  const out = renderDiffForPrompt(parsed);

  assert.equal(out.truncated, false);
  assert.equal(out.filesEmitted, 1);
  assert.equal(out.filesOmitted, 0);
  assert.deepEqual(out.truncatedFiles, []);
  assert.equal(
    out.text,
    [
      '## src/app.ts',
      "[  1] import fs from 'fs';",
      '[+ 2] const a = 2;',
      '[+ 3] const b = 3;',
      '[  4] ',
      '[  5] function main() {',
      '[  6]   return a;',
      '[  7] }',
      '[  21] const x = 10;',
      '[+ 22] const y = 21;',
      '[+ 23] const z = 22;',
      '[  24] export { main };',
    ].join('\n') + '\n',
  );
});

test('renders several files separated by a header and a blank line', () => {
  const parsed = parseUnifiedDiff(fileDiffFixture('one.ts') + fileDiffFixture('two.ts'));
  const out = renderDiffForPrompt(parsed);
  assert.equal(
    out.text,
    '## one.ts\n[  1] keep\n[+ 2] added\n\n## two.ts\n[  1] keep\n[+ 2] added\n',
  );
  assert.equal(out.filesEmitted, 2);
});

test('a file with no lines renders as a bare header', () => {
  const parsed = parseUnifiedDiff(
    diffOf('diff --git a/img/logo.png b/img/logo.png', 'Binary files a/img/logo.png and b/img/logo.png differ'),
  );
  const out = renderDiffForPrompt(parsed);
  assert.equal(out.text, '## img/logo.png\n');
  assert.equal(out.filesEmitted, 1);
  assert.equal(out.truncated, false);
});

/** A file with `count` added lines, big enough to exercise the byte budget. */
function syntheticFile(path: string, count: number): string {
  const lines = [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${count} @@`,
  ];
  // Content is path-specific so that "this line came from that file" assertions
  // below cannot be satisfied by an identical line in a sibling file.
  for (let i = 1; i <= count; i++) lines.push(`+the quick brown fox jumps over ${path} line ${i}`);
  return lines.join('\n') + '\n';
}

const BIG_DIFF =
  syntheticFile('alpha.ts', 40) + syntheticFile('beta.ts', 40) + syntheticFile('gamma.ts', 40);

test('a budget that fits everything truncates nothing', () => {
  const parsed = parseUnifiedDiff(BIG_DIFF);
  const out = renderDiffForPrompt(parsed, 1_000_000);
  assert.equal(out.truncated, false);
  assert.equal(out.filesEmitted, 3);
  assert.equal(out.filesOmitted, 0);
  assert.deepEqual(out.truncatedFiles, []);
});

test('truncation accounting adds up and stays inside the budget', () => {
  const parsed = parseUnifiedDiff(BIG_DIFF);
  const full = renderDiffForPrompt(parsed, 1_000_000);
  const fullBytes = Buffer.byteLength(full.text, 'utf8');

  for (const maxBytes of [fullBytes - 1, Math.floor(fullBytes / 2), 600, 300, 200]) {
    const out = renderDiffForPrompt(parsed, maxBytes);
    assert.equal(out.truncated, true, `maxBytes=${maxBytes}`);
    assert.equal(out.filesEmitted + out.filesOmitted, 3, `maxBytes=${maxBytes}`);
    assert.ok(
      Buffer.byteLength(out.text, 'utf8') <= maxBytes,
      `maxBytes=${maxBytes} produced ${Buffer.byteLength(out.text, 'utf8')} bytes`,
    );
    assert.match(out.text, /\.\.\. \(diff truncated; \d+ more file\(s\) omitted\)/);
    for (const p of out.truncatedFiles) assert.ok(out.text.includes(`## ${p}\n`));
  }
});

test('a file that overflows is emitted partially and recorded', () => {
  const parsed = parseUnifiedDiff(BIG_DIFF);
  const files = [...parsed.files.values()];
  const alpha = files[0];
  const beta = files[1];

  const RESERVE = 128; // headroom the renderer holds back for its markers
  const CUT = Buffer.byteLength('... (rest of this file omitted)\n', 'utf8');
  const keep = 3;
  let budget =
    RESERVE +
    expectedBlockBytes(alpha) +
    1 /* separator */ +
    Buffer.byteLength(`## ${beta.path}\n`, 'utf8') +
    CUT;
  for (let i = 0; i < keep; i++) budget += Buffer.byteLength(expectedLine(beta.lines[i]), 'utf8');

  const out = renderDiffForPrompt(parsed, budget);
  assert.equal(out.truncated, true);
  assert.equal(out.filesEmitted, 2);
  assert.equal(out.filesOmitted, 1);
  assert.deepEqual(out.truncatedFiles, [beta.path]);

  // alpha survived whole; beta kept exactly `keep` lines; gamma is gone.
  assert.ok(out.text.includes(expectedLine(alpha.lines[39])));
  assert.ok(out.text.includes(expectedLine(beta.lines[keep - 1])));
  assert.ok(!out.text.includes(expectedLine(beta.lines[keep])));
  assert.ok(!out.text.includes('## gamma.ts'));
  assert.ok(out.text.includes('... (rest of this file omitted)'));
  assert.ok(out.text.endsWith('... (diff truncated; 1 more file(s) omitted)\n'));
  assert.ok(Buffer.byteLength(out.text, 'utf8') <= budget);
});

test('a budget too small for even one line omits every file honestly', () => {
  const parsed = parseUnifiedDiff(BIG_DIFF);
  const out = renderDiffForPrompt(parsed, 130);
  assert.equal(out.truncated, true);
  assert.equal(out.filesEmitted, 0);
  assert.equal(out.filesOmitted, 3);
  assert.deepEqual(out.truncatedFiles, []);
  assert.equal(out.text, '... (diff truncated; 3 more file(s) omitted)\n');
});

test('a nonsensical budget falls back to the default', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK);
  const expected = renderDiffForPrompt(parsed).text;
  for (const bad of [0, -5, NaN, Infinity, undefined as unknown as number]) {
    assert.equal(renderDiffForPrompt(parsed, bad).text, expected, `budget=${String(bad)}`);
  }
});

test('rendered line numbers are exactly the commentable ones', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK + fileDiffFixture('other.ts'));
  const out = renderDiffForPrompt(parsed);

  let currentPath = '';
  for (const line of out.text.split('\n')) {
    if (line.startsWith('## ')) {
      currentPath = line.slice(3);
      continue;
    }
    const m = /^\[([+ ]) (\d+)\] /.exec(line);
    if (!m) continue;
    const n = Number(m[2]);
    assert.equal(isCommentableLine(parsed, currentPath, n), true, `${currentPath}:${n}`);
    assert.equal(
      fileOf(parsed, currentPath).addedLines.has(n),
      m[1] === '+',
      `${currentPath}:${n} marker`,
    );
  }
});
