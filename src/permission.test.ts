import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore -- node's type stripper needs the explicit extension; tsconfig has no allowImportingTsExtensions
import { isReviewTriggerAllowed, describePermissionDenial } from './permission.ts';

test('admin, maintain, and write may trigger a review', () => {
  for (const level of ['admin', 'maintain', 'write']) {
    assert.equal(isReviewTriggerAllowed(level), true, level);
  }
});

test('triage, read, and none may not', () => {
  for (const level of ['triage', 'read', 'none']) {
    assert.equal(isReviewTriggerAllowed(level), false, level);
  }
});

test('empty, null, and undefined are denied', () => {
  assert.equal(isReviewTriggerAllowed(''), false);
  assert.equal(isReviewTriggerAllowed('   '), false);
  assert.equal(isReviewTriggerAllowed(null), false);
  assert.equal(isReviewTriggerAllowed(undefined), false);
});

test('unknown strings are denied rather than guessed at', () => {
  for (const level of [
    'push',
    'pull',
    'owner',
    'collaborator',
    'writer',
    'admin-ish',
    'write ',
    'w r i t e',
    'ADMINISTRATOR',
    '0',
    'true',
  ]) {
    const expected = level.trim().toLowerCase() === 'write';
    assert.equal(isReviewTriggerAllowed(level), expected, level);
  }
});

test('non-string values are denied', () => {
  assert.equal(isReviewTriggerAllowed(1 as unknown as string), false);
  assert.equal(isReviewTriggerAllowed({} as unknown as string), false);
  assert.equal(isReviewTriggerAllowed(['admin'] as unknown as string), false);
});

test('comparison is case-insensitive and trimmed', () => {
  for (const level of ['ADMIN', 'Admin', '  admin  ', 'MAINTAIN', ' Write ', 'wRiTe']) {
    assert.equal(isReviewTriggerAllowed(level), true, level);
  }
  assert.equal(isReviewTriggerAllowed('  READ  '), false);
});

test('describePermissionDenial names the actor, the level, and what is required', () => {
  const msg = describePermissionDenial('octocat', 'read');
  assert.ok(msg.includes('octocat'), msg);
  assert.ok(msg.includes('read'), msg);
  assert.ok(msg.includes('write'), msg);
  assert.ok(msg.includes('maintain'), msg);
  assert.ok(msg.includes('admin'), msg);
});

test('describePermissionDenial does not @-mention the denied actor', () => {
  assert.ok(!describePermissionDenial('octocat', 'read').includes('@octocat'));
});

test('describePermissionDenial sanitizes hostile actor and permission strings', () => {
  const msg = describePermissionDenial(
    '<img src=x onerror=alert(1)>',
    'read\n::error::pwned',
  );
  // The letters may survive; the characters that make them dangerous may not.
  for (const ch of ['<', '>', '=', '(', ')', ':', ' ', String.fromCharCode(10)]) {
    assert.ok(!msg.split('`')[1]!.includes(ch), `actor kept ${JSON.stringify(ch)}: ${msg}`);
  }
  assert.ok(!msg.includes('<img'), msg);
  assert.ok(!msg.includes('::error::'), msg);
  assert.ok(!msg.includes(String.fromCharCode(10)), msg);
});

test('describePermissionDenial bounds the length of a hostile actor', () => {
  const msg = describePermissionDenial('a'.repeat(5000), 'read');
  assert.ok(msg.length < 300, `length ${msg.length}`);
});

test('describePermissionDenial copes with empty inputs', () => {
  const msg = describePermissionDenial('', '');
  assert.ok(msg.includes('unknown-user'), msg);
  assert.ok(msg.includes('none'), msg);
});
