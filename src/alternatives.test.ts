/**
 * Tests for the ALTERNATIVES stage.
 *
 * The thing being protected here is restraint. This stage is the one place in
 * the reviewer where producing output is easier than producing nothing, and
 * where a confident paragraph costs an author real time to argue against. So the
 * prompt has to say out loud that an empty array is a successful answer, and the
 * parser has to throw away the tell-tale of a manufactured alternative: a
 * "tradeoff" that names no cost.
 *
 * The vacuous tradeoffs below are the strings models actually write when they
 * have nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Alternative } from './types';
import type { ReviewerConfig } from './config';
import type { PRInfo, IssueInfo } from './github';
import type { AlternativesContext } from './alternatives';

/**
 * Node's type stripping resolves imports the way ESM does: `./alternatives` does
 * not resolve and only `./alternatives.ts` does — which `tsc` rejects as an
 * import path. A specifier held in a variable is the single form both accept;
 * the real types come back through `typeof import(...)`, a type position that is
 * erased before any of this runs.
 */
type AlternativesModule = typeof import('./alternatives');
const ALTERNATIVES_SPECIFIER = './alternatives.ts';
const altPromise = import(ALTERNATIVES_SPECIFIER) as Promise<AlternativesModule>;

const CFG: ReviewerConfig = {
  projectName: 'iolite',
  promptInline: '',
  promptFileRel: '',
  includePaths: [],
  excludePaths: [],
  reviewSelf: false,
  lenses: ['correctness', 'security'],
  adversarialRounds: 3,
  refuteThreshold: 2,
  completenessPass: true,
  exploreAlternatives: true,
  maxLlmCalls: 16,
  maxCommentsPerFile: 10,
  maxCommentsTotal: 40,
  maxCommentBodyChars: 700,
};

// Tokens that appear nowhere else, so "did this text reach that message?" is an
// exact question.
const DIFF_TOKEN = 'kqz-diff-marker-2207';
const PR_BODY_TOKEN = 'mbt-pr-marker-8814';
const ISSUE_BODY_TOKEN = 'vrl-issue-marker-3390';
const ISSUE_COMMENT_TOKEN = 'ntc-comment-marker-7725';
const POLICY_TOKEN = 'jwf-policy-marker-1163';

const DIFF = `## src/cache.ts
[+  4] const memo = new Map<string, User>();
[+  5] export function get(id: string) { ${DIFF_TOKEN}
[+  6]   if (!memo.has(id)) memo.set(id, load(id));
[+  7]   return memo.get(id);
[+  8] }`;

const PR: PRInfo = {
  number: 41,
  title: 'Cache user lookups in a module-level Map',
  body: `Lookups were hitting the database on every request. ${PR_BODY_TOKEN}`,
  headBranch: 'feat/cache',
  baseBranch: 'main',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  commits: 2,
  additions: 40,
  deletions: 3,
  changedFiles: 2,
  author: 'someone',
  draft: false,
};

const ISSUE: IssueInfo = {
  number: 17,
  title: 'User lookups are slow under load',
  body: `Every request re-reads the user row. ${ISSUE_BODY_TOKEN}`,
  labels: ['performance'],
  comments: [
    { author: 'maintainer', body: `We already have an LRU in src/lru.ts. ${ISSUE_COMMENT_TOKEN}`, createdAt: '2026-08-01T00:00:00Z' },
  ],
};

function ctx(over: Partial<AlternativesContext> = {}): AlternativesContext {
  return {
    cfg: CFG,
    numberedDiff: DIFF,
    policy: `Prefer reusing existing mechanisms. ${POLICY_TOKEN}`,
    prInfo: PR,
    issueInfo: ISSUE,
    ...over,
  };
}

function alt(over: Partial<Alternative> = {}): Alternative {
  return {
    title: 'Reuse the existing LRU',
    rationale: 'src/lru.ts already implements eviction; the new Map duplicates it and never evicts.',
    tradeoff: 'The LRU is synchronous, so the loader has to be reshaped around it.',
    sketch: 'import { lru } from "./lru";',
    strength: 'worth_considering',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

test('the prompt carries the linked issue, including its body and discussion', async () => {
  const { buildAlternativesCall } = await altPromise;
  const call = buildAlternativesCall(ctx());

  assert.ok(call.user.includes(ISSUE_BODY_TOKEN), 'the issue body never reached the prompt');
  assert.ok(call.user.includes('LINKED ISSUE #17'));
  assert.ok(call.user.includes('User lookups are slow under load'));
  assert.ok(call.user.includes(ISSUE_COMMENT_TOKEN), 'the issue discussion never reached the prompt');
  assert.ok(call.user.includes(PR_BODY_TOKEN));
  assert.ok(call.user.includes(DIFF_TOKEN));
});

test('with no issue the stage still runs, and says what to judge the approach against', async () => {
  const { buildAlternativesCall } = await altPromise;

  for (const issueInfo of [null, undefined]) {
    const call = buildAlternativesCall(ctx({ issueInfo }));
    assert.ok(call.system.length > 200);
    assert.ok(call.user.includes('LINKED ISSUE: none'));
    assert.match(call.user, /infer the problem from the diff itself/i);
    // The change itself is still there to reason about.
    assert.ok(call.user.includes(DIFF_TOKEN));
    assert.ok(call.user.includes(PR_BODY_TOKEN));
  }
});

test('untrusted material stays out of the channel that carries authority', async () => {
  const { buildAlternativesCall } = await altPromise;
  const call = buildAlternativesCall(ctx());

  // Policy is the repo's own, set by someone with write access: trusted, so it
  // travels in the system message. The diff and the PR text are written by the
  // author under review: data, so they travel in the user message.
  assert.ok(call.system.includes(POLICY_TOKEN));
  assert.ok(!call.system.includes(DIFF_TOKEN), 'the diff leaked into the system message');
  assert.ok(!call.system.includes(PR_BODY_TOKEN), 'the PR body leaked into the system message');
  assert.ok(!call.system.includes(ISSUE_BODY_TOKEN), 'the issue body leaked into the system message');
  assert.match(call.system, /TRUST BOUNDARY/);
  assert.match(call.user, /UNTRUSTED CONTENT BEGINS/);
  assert.match(call.user, /UNTRUSTED CONTENT ENDS/);

  // The label reaches the logs, so it names the call and nothing else.
  assert.equal(call.label, 'alternatives');
});

test('the prompt makes an empty answer a successful one, and bans the usual filler', async () => {
  const { buildAlternativesCall } = await altPromise;
  const { system } = buildAlternativesCall(ctx());

  assert.match(system, /INVENTING AN ALTERNATIVE TO\nLOOK USEFUL/);
  assert.match(system, /empty array is a complete, successful answer/);
  assert.match(system, /JUDGE THE APPROACH, NOT THE CODE/);

  // The four things it must never propose.
  assert.match(system, /"add tests"/);
  assert.match(system, /"add types"/);
  assert.match(system, /"extract a helper"/);
  assert.match(system, /rewriting it in another language, framework, or library ecosystem/);

  // Tradeoffs and the strength bar.
  assert.match(system, /EVERY ALTERNATIVE MUST HAVE A REAL TRADEOFF/);
  assert.match(system, /"None", "no downside", "nothing", "negligible" are not tradeoffs/);
  assert.match(system, /"strong" — only when the CURRENT approach has a concrete flaw/);
  assert.match(system, /At most 3 alternatives/);
  assert.match(system, /OUTPUT PURE JSON/);
});

// ---------------------------------------------------------------------------
// parseAlternatives
// ---------------------------------------------------------------------------

test('parseAlternatives reads the documented shape, a bare array, and fenced JSON', async () => {
  const { parseAlternatives } = await altPromise;

  const wrapped = parseAlternatives({ alternatives: [alt({ strength: 'strong' })] });
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].strength, 'strong');
  assert.equal(wrapped[0].title, 'Reuse the existing LRU');

  const bare = parseAlternatives([alt()]);
  assert.equal(bare.length, 1);

  const fenced = parseAlternatives(
    '```json\n{"alternatives":[{"title":"T","rationale":"R","tradeoff":"costs a migration","sketch":"s","strength":"strong"}]}\n```'
  );
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].strength, 'strong');
});

test('parseAlternatives drops entries whose tradeoff names no cost', async () => {
  const { parseAlternatives } = await altPromise;

  const vacuous = [
    'none',
    'None.',
    'None!',
    'nothing',
    'Nothing.',
    'no downside',
    'No downsides.',
    'no tradeoff',
    'No trade-offs',
    'n/a',
    'N/A',
    'not applicable',
    'negligible',
    'minimal',
    'unknown',
    'TBD',
    '-',
    '',
    '   ',
    'None really — it is strictly better',
    'No real downside here',
  ];

  for (const tradeoff of vacuous) {
    const out = parseAlternatives({ alternatives: [alt({ tradeoff })] });
    assert.deepEqual(out, [], `"${tradeoff}" should not have counted as a tradeoff`);
  }

  // And a real one survives.
  const kept = parseAlternatives({
    alternatives: [alt({ tradeoff: 'Adds a migration and a second write path during rollout.' })],
  });
  assert.equal(kept.length, 1);
});

test('parseAlternatives drops entries missing a title or a rationale', async () => {
  const { parseAlternatives } = await altPromise;

  const out = parseAlternatives({
    alternatives: [
      { rationale: 'r', tradeoff: 'costs a migration' },
      { title: 'T', tradeoff: 'costs a migration' },
      { title: '', rationale: 'r', tradeoff: 'costs a migration' },
      { title: 'T', rationale: '   ', tradeoff: 'costs a migration' },
      { title: 42, rationale: 'r', tradeoff: 'costs a migration' },
      null,
      'a string',
      [],
      alt({ title: 'survivor' }),
    ],
  });

  assert.deepEqual(
    out.map((a) => a.title),
    ['survivor']
  );
});

test('parseAlternatives caps at three, keeping the first three', async () => {
  const { parseAlternatives } = await altPromise;

  const out = parseAlternatives({
    alternatives: [
      alt({ title: 'one' }),
      alt({ title: 'two' }),
      alt({ title: 'three' }),
      alt({ title: 'four' }),
      alt({ title: 'five' }),
    ],
  });

  assert.deepEqual(
    out.map((a) => a.title),
    ['one', 'two', 'three']
  );
});

test('parseAlternatives coerces any strength it does not recognise down to worth_considering', async () => {
  const { parseAlternatives } = await altPromise;

  const cases: Array<[unknown, Alternative['strength']]> = [
    ['strong', 'strong'],
    ['STRONG', 'strong'],
    ['  Strong  ', 'strong'],
    ['worth_considering', 'worth_considering'],
    ['worth considering', 'worth_considering'],
    ['critical', 'worth_considering'],
    ['high', 'worth_considering'],
    ['very strong', 'worth_considering'],
    [undefined, 'worth_considering'],
    [7, 'worth_considering'],
    [null, 'worth_considering'],
  ];

  for (const [raw, expected] of cases) {
    const out = parseAlternatives({ alternatives: [{ ...alt(), strength: raw }] });
    assert.equal(out.length, 1, `strength ${JSON.stringify(raw)} dropped the entry`);
    assert.equal(out[0].strength, expected, `strength ${JSON.stringify(raw)}`);
  }
});

test('parseAlternatives returns [] for garbage and truncates long fields', async () => {
  const { parseAlternatives } = await altPromise;

  for (const raw of [null, undefined, 42, true, 'nope', '', { alternatives: 'soon' }, { other: [] }]) {
    assert.deepEqual(parseAlternatives(raw), [], `expected [] for ${JSON.stringify(raw)}`);
  }

  const long = parseAlternatives({
    alternatives: [
      alt({
        title: 'T'.repeat(500),
        rationale: 'R'.repeat(5000),
        tradeoff: 'C'.repeat(5000),
        sketch: 'S'.repeat(5000),
      }),
    ],
  });
  assert.equal(long.length, 1);
  assert.ok(long[0].title.length < 200);
  assert.ok(long[0].rationale.length < 1000);
  assert.ok(long[0].tradeoff.length < 600);
  assert.ok(long[0].sketch.length < 1000);
  assert.match(long[0].rationale, /truncated/);
});

test('parseAlternatives tolerates a missing sketch', async () => {
  const { parseAlternatives } = await altPromise;
  const out = parseAlternatives({
    alternatives: [{ title: 'T', rationale: 'R', tradeoff: 'costs a migration' }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].sketch, '');
});

// ---------------------------------------------------------------------------
// renderAlternatives
// ---------------------------------------------------------------------------

test('renderAlternatives returns an empty string when there is nothing to say', async () => {
  const { renderAlternatives } = await altPromise;
  assert.equal(renderAlternatives([]), '');
  // An "Alternative approaches" header with nothing under it reads like the
  // reviewer gave up, so the section must vanish entirely.
  assert.ok(!renderAlternatives([]).includes('Alternative'));
});

test('renderAlternatives marks strong entries and labels the rest', async () => {
  const { renderAlternatives } = await altPromise;

  const strong = renderAlternatives([alt({ title: 'Reuse the LRU', strength: 'strong' })]);
  assert.match(strong, /^### Alternative approaches/);
  assert.match(strong, /\*\*Reuse the LRU\*\* _\(strong\)_/);
  assert.match(strong, /- Tradeoff: The LRU is synchronous/);
  assert.match(strong, /- Sketch: import \{ lru \}/);

  const soft = renderAlternatives([alt({ title: 'Reuse the LRU' })]);
  assert.match(soft, /\*\*Reuse the LRU\*\* _\(worth considering\)_/);
  assert.ok(!soft.includes('_(strong)_'));
});

test('renderAlternatives renders every entry and keeps a multi-line sketch in a code block', async () => {
  const { renderAlternatives } = await altPromise;

  const out = renderAlternatives([
    alt({ title: 'First', strength: 'strong' }),
    alt({ title: 'Second', sketch: 'const cache = lru(500);\nreturn cache.get(id) ?? load(id);' }),
  ]);

  assert.ok(out.includes('**First**'));
  assert.ok(out.includes('**Second**'));
  assert.ok(out.includes('- Sketch:\n\n```\nconst cache = lru(500);'));
  // One header for the whole section, not one per entry.
  assert.equal(out.split('### Alternative approaches').length, 2);
  assert.equal(out, out.trim());
});

test('renderAlternatives survives a sketch containing its own fence', async () => {
  const { renderAlternatives } = await altPromise;
  const out = renderAlternatives([
    alt({ sketch: 'before\n```\nnested\n```\nafter' }),
  ]);
  // The block must not be closed by the sketch's own backticks, or the rest of
  // the review body spills out as prose.
  assert.ok(out.includes('````'));
  assert.ok(out.includes('nested'));
});

test('renderAlternatives keeps a multi-line title on one line', async () => {
  const { renderAlternatives } = await altPromise;
  const out = renderAlternatives([alt({ title: 'A title\nsplit over\nlines' })]);
  assert.match(out, /\*\*A title split over lines\*\* _\(worth considering\)_/);
});
