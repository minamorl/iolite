import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore -- node's type stripper needs the explicit extension; tsconfig has no allowImportingTsExtensions
import { normalizePolicyPath, isPolicyPathSafe, summarizePolicySource } from './policy-loader.ts';

const NUL = String.fromCharCode(0);

const ESCAPES: string[] = [
  '/etc/passwd',
  '/.github/iolite/prompt.md',
  '//evil.example.com/policy.md',
  '../secret.md',
  '../../etc/passwd',
  'a/../../b.md',
  'docs/../../../../etc/shadow',
  '..',
  '../',
  './../x.md',
  'a/..',
  '.',
  './',
  'http://evil.example.com/policy.md',
  'https://evil.example.com/policy.md',
  'file:///etc/passwd',
  'HTTP://EVIL.EXAMPLE.COM/p.md',
  `docs/${NUL}/policy.md`,
  `${NUL}etc/passwd`,
  'docs/pol' + String.fromCharCode(10) + 'icy.md',
  'C:\\Windows\\system32\\config',
  'c:/windows/system32',
  '..\\..\\evil.md',
  '..\\evil.md',
  'a\\..\\..\\b.md',
  '\\\\server\\share\\policy.md',
];

const ACCEPTED: Array<[string, string]> = [
  ['.github/iolite/prompt.md', '.github/iolite/prompt.md'],
  ['docs/review.md', 'docs/review.md'],
  ['./policy.md', 'policy.md'],
  ['policy.md', 'policy.md'],
  ['  docs/review.md  ', 'docs/review.md'],
  ['a/./b/c.md', 'a/b/c.md'],
  ['a/b/../c.md', 'a/c.md'],
  ['a//b.md', 'a/b.md'],
  ['./.github/iolite/prompt.md', '.github/iolite/prompt.md'],
  ['docs\\review.md', 'docs/review.md'],
  ['..hidden/policy.md', '..hidden/policy.md'],
];

// ---------------------------------------------------------------------------
// rejection
// ---------------------------------------------------------------------------

test('normalizePolicyPath throws on every escaping form', () => {
  for (const bad of ESCAPES) {
    assert.throws(
      () => normalizePolicyPath(bad),
      /unsafe policy path/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test('isPolicyPathSafe is the non-throwing form of the same rule', () => {
  for (const bad of ESCAPES) {
    assert.equal(isPolicyPathSafe(bad), false, `expected unsafe: ${JSON.stringify(bad)}`);
  }
});

test('a rejection message never contains control characters', () => {
  try {
    normalizePolicyPath(`docs/${NUL}x.md`);
    assert.fail('should have thrown');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes(NUL));
    assert.ok(!message.includes(String.fromCharCode(10)));
  }
});

// ---------------------------------------------------------------------------
// acceptance
// ---------------------------------------------------------------------------

test('normalizePolicyPath accepts and normalizes repo-relative paths', () => {
  for (const [input, expected] of ACCEPTED) {
    assert.equal(normalizePolicyPath(input), expected, `for ${JSON.stringify(input)}`);
    assert.equal(isPolicyPathSafe(input), true, `for ${JSON.stringify(input)}`);
  }
});

test('empty input means no policy, not an error', () => {
  assert.equal(normalizePolicyPath(''), '');
  assert.equal(normalizePolicyPath('   '), '');
  assert.equal(normalizePolicyPath(undefined as unknown as string), '');
  assert.equal(normalizePolicyPath(null as unknown as string), '');
  assert.equal(isPolicyPathSafe(''), true);
  assert.equal(isPolicyPathSafe(undefined as unknown as string), true);
});

test('normalization is idempotent', () => {
  for (const [input] of ACCEPTED) {
    const once = normalizePolicyPath(input);
    assert.equal(normalizePolicyPath(once), once, `for ${JSON.stringify(input)}`);
  }
});

// ---------------------------------------------------------------------------
// summarizePolicySource
// ---------------------------------------------------------------------------

test('summarizePolicySource reports the source, never the content', () => {
  assert.equal(summarizePolicySource('be harsh about SQL injection', ''), 'inline');
  assert.equal(summarizePolicySource('', '.github/iolite/prompt.md'), 'file:.github/iolite/prompt.md');
  assert.equal(summarizePolicySource('', ''), 'none');
  assert.equal(summarizePolicySource('   ', '   '), 'none');
});

test('inline policy wins over a file path, and its text is never echoed', () => {
  const secretish = 'INTERNAL: never approve changes to billing/*';
  const out = summarizePolicySource(secretish, 'docs/review.md');
  assert.equal(out, 'inline');
  assert.ok(!out.includes('billing'));
  assert.ok(!out.includes('INTERNAL'));
});

test('summarizePolicySource normalizes the path it reports', () => {
  assert.equal(summarizePolicySource('', './policy.md'), 'file:policy.md');
  assert.equal(summarizePolicySource('', ' docs\\review.md '), 'file:docs/review.md');
});

test('an unsafe path is summarized without being echoed', () => {
  for (const bad of ['../../etc/passwd', 'http://evil.example.com/p.md', `x${NUL}y`]) {
    const out = summarizePolicySource('', bad);
    assert.equal(out, 'file:<invalid>');
  }
});

test('summarizePolicySource tolerates non-string inputs', () => {
  assert.equal(summarizePolicySource(undefined as unknown as string, undefined as unknown as string), 'none');
  assert.equal(summarizePolicySource(null as unknown as string, 'docs/review.md'), 'file:docs/review.md');
});
