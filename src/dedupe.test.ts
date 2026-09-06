import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore -- node's type stripper needs the explicit extension; tsconfig has no allowImportingTsExtensions
import { buildReviewMarker, hasReviewedSha, isForceRerunRequested } from './dedupe.ts';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

// ---------------------------------------------------------------------------
// marker
// ---------------------------------------------------------------------------

test('buildReviewMarker emits a hidden HTML comment', () => {
  assert.equal(buildReviewMarker(SHA), `<!-- iolite:reviewed-sha=${SHA} -->`);
});

test('buildReviewMarker normalizes case and whitespace', () => {
  assert.equal(buildReviewMarker(`  ${SHA.toUpperCase()}  `), `<!-- iolite:reviewed-sha=${SHA} -->`);
});

test('buildReviewMarker cannot be used to break out of the comment', () => {
  const marker = buildReviewMarker('abc --> <script>alert(1)</script>');
  assert.equal(marker.split('-->').length, 2, marker);
  assert.ok(!marker.includes('<script>'));
});

// ---------------------------------------------------------------------------
// hasReviewedSha
// ---------------------------------------------------------------------------

test('hasReviewedSha finds its own marker', () => {
  const bodies = ['## iolite review\n\nsome text\n' + buildReviewMarker(SHA)];
  assert.equal(hasReviewedSha(bodies, SHA), true);
});

test('hasReviewedSha is case-insensitive on the sha', () => {
  assert.equal(hasReviewedSha([buildReviewMarker(SHA)], SHA.toUpperCase()), true);
});

test('hasReviewedSha returns false for a missing or empty sha', () => {
  const bodies = [buildReviewMarker(SHA)];
  assert.equal(hasReviewedSha(bodies, ''), false);
  assert.equal(hasReviewedSha(bodies, '   '), false);
  assert.equal(hasReviewedSha(bodies, undefined as unknown as string), false);
  assert.equal(hasReviewedSha(bodies, null as unknown as string), false);
});

test('a short sha does not match a longer marker that starts with it', () => {
  const bodies = [buildReviewMarker(SHA)];
  assert.equal(hasReviewedSha(bodies, SHA.slice(0, 7)), false);
  assert.equal(hasReviewedSha(bodies, SHA.slice(0, 39)), false);
});

test('a long sha does not match a shorter marker', () => {
  const bodies = [buildReviewMarker(SHA.slice(0, 7))];
  assert.equal(hasReviewedSha(bodies, SHA), false);
  assert.equal(hasReviewedSha(bodies, SHA.slice(0, 7)), true);
});

test('a different sha of the same length does not match', () => {
  const other = `${SHA.slice(0, 39)}9`;
  assert.equal(hasReviewedSha([buildReviewMarker(other)], SHA), false);
});

test('hasReviewedSha scans every body and tolerates junk entries', () => {
  const bodies = [
    'a plain review with no marker',
    '',
    null as unknown as string,
    undefined as unknown as string,
    123 as unknown as string,
    `stale ${buildReviewMarker('deadbeef')}`,
    `current ${buildReviewMarker(SHA)}`,
  ];
  assert.equal(hasReviewedSha(bodies, SHA), true);
  assert.equal(hasReviewedSha(bodies, 'deadbeef'), true);
  assert.equal(hasReviewedSha(bodies, 'cafebabe'), false);
});

test('hasReviewedSha handles a missing list', () => {
  assert.equal(hasReviewedSha([], SHA), false);
  assert.equal(hasReviewedSha(undefined as unknown as string[], SHA), false);
});

test('hasReviewedSha does not carry regex state between calls', () => {
  const bodies = [`${buildReviewMarker(SHA)} ${buildReviewMarker('deadbeef')}`];
  for (let i = 0; i < 5; i += 1) {
    assert.equal(hasReviewedSha(bodies, SHA), true);
    assert.equal(hasReviewedSha(bodies, 'deadbeef'), true);
  }
});

test('a sha mentioned in prose is not a marker', () => {
  assert.equal(hasReviewedSha([`we already reviewed ${SHA} by hand`], SHA), false);
});

// ---------------------------------------------------------------------------
// force rerun
// ---------------------------------------------------------------------------

test('/review force in a comment requests a rerun', () => {
  assert.equal(isForceRerunRequested({ commentBody: '/review force' }), true);
  assert.equal(isForceRerunRequested({ commentBody: '/review   force' }), true);
  assert.equal(isForceRerunRequested({ commentBody: '/review\tforce' }), true);
  assert.equal(isForceRerunRequested({ commentBody: 'please /review force again' }), true);
  assert.equal(isForceRerunRequested({ commentBody: 'hi\n/review force\nthanks' }), true);
});

test('/review --force is accepted', () => {
  assert.equal(isForceRerunRequested({ commentBody: '/review --force' }), true);
  assert.equal(isForceRerunRequested({ commentBody: '/review    --force' }), true);
});

test('force detection is case-insensitive', () => {
  assert.equal(isForceRerunRequested({ commentBody: '/REVIEW FORCE' }), true);
  assert.equal(isForceRerunRequested({ commentBody: '/Review --Force' }), true);
});

test('/reviewforce does not request a rerun', () => {
  assert.equal(isForceRerunRequested({ commentBody: '/reviewforce' }), false);
  assert.equal(isForceRerunRequested({ commentBody: '/reviewforce please' }), false);
});

test('near misses do not request a rerun', () => {
  assert.equal(isForceRerunRequested({ commentBody: '/review' }), false);
  assert.equal(isForceRerunRequested({ commentBody: '/review forced the issue' }), false);
  assert.equal(isForceRerunRequested({ commentBody: 'force' }), false);
  assert.equal(isForceRerunRequested({ commentBody: 'x/review force' }), false);
});

test('[force-ai-review] in the PR body requests a rerun', () => {
  assert.equal(isForceRerunRequested({ prBody: 'closes #12\n\n[force-ai-review]' }), true);
  assert.equal(isForceRerunRequested({ prBody: '[FORCE-AI-REVIEW]' }), true);
  assert.equal(isForceRerunRequested({ prBody: 'no marker here' }), false);
});

test('missing, null, and empty inputs mean no rerun', () => {
  assert.equal(isForceRerunRequested({}), false);
  assert.equal(isForceRerunRequested({ commentBody: null, prBody: null }), false);
  assert.equal(isForceRerunRequested({ commentBody: '', prBody: '' }), false);
  assert.equal(
    isForceRerunRequested(undefined as unknown as { commentBody?: string | null }),
    false,
  );
});

test('legacy zero-lens failure markers do not suppress a retry', () => {
  const sha = 'abcdef123456';
  assert.equal(hasReviewedSha([`| lenses run | — |\n${buildReviewMarker(sha)}`], sha), false);
});
