/**
 * Tests for the FINDER stage.
 *
 * Two things are worth pinning here and they are not the wording of the
 * prompts. First, the trust boundary: the repo's own policy and the review
 * rules live in the system message, the pull request's text and diff live in
 * the user message, and the diff must never leak into the channel that carries
 * authority. Second, lens blindness: a lens prompt must not contain another
 * lens's brief, because the moment they share context the sweep stops covering
 * different ground.
 *
 * `parseFindings` is tested as what it is — a filter standing between a
 * non-deterministic generator and a review that gets posted to a human's pull
 * request. Every case below is a shape a model has actually produced.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Finding } from './types';
import type { LensName, ReviewerConfig } from './config';
import type { PRInfo, IssueInfo } from './github';
import type { FinderContext } from './lenses';

/**
 * Node's type stripping resolves imports the way ESM does: `./lenses` does not
 * resolve and only `./lenses.ts` does — which `tsc` rejects as an import path.
 * A specifier held in a variable is the single form both accept. The module's
 * real types come back through `typeof import(...)`, which is a type position
 * and therefore erased before any of this runs.
 */
type LensesModule = typeof import('./lenses');
const LENSES_SPECIFIER = './lenses.ts';
const lensesPromise = import(LENSES_SPECIFIER) as Promise<LensesModule>;

const ALL_LENSES: LensName[] = [
  'correctness',
  'security',
  'performance',
  'integration',
  'test',
];

// A token that appears nowhere else, so "is the diff in this message?" is an
// exact question rather than a fuzzy one.
const DIFF_TOKEN = 'zqx-diff-marker-9931';

const DIFF = `## src/handler.ts
[  10] export async function handle(req: Request) {
[+ 11]   const user = await lookup(req.headers.get('x-user')); // ${DIFF_TOKEN}
[+ 12]   return respond(user.id);
[  13] }

## src/queue.ts
[+  4] for (const id of ids) { await db.query('SELECT * FROM t WHERE id = ' + id); }`;

const POLICY_TOKEN = 'wvy-policy-marker-4417';
const POLICY = `Never approve a migration without a rollback. ${POLICY_TOKEN}`;

const CFG: ReviewerConfig = {
  projectName: 'acme-gateway',
  promptInline: '',
  promptFileRel: '',
  includePaths: [],
  excludePaths: [],
  reviewSelf: false,
  lenses: ALL_LENSES,
  adversarialRounds: 3,
  refuteThreshold: 2,
  completenessPass: true,
  exploreAlternatives: true,
  maxLlmCalls: 16,
  maxCommentsPerFile: 10,
  maxCommentsTotal: 40,
  maxCommentBodyChars: 700,
};

/**
 * The finder reads PR and issue metadata structurally — bodies come back null
 * from the GitHub API often enough that a missing field has to degrade to an
 * empty section. These fixtures pin only the fields the prompts render, so this
 * suite does not break every time the IO layer grows a field.
 */
const PR = {
  number: 7,
  title: 'Add rate limiting to the webhook handler',
  body: 'Closes #4. Should reject bursts above 100 rps.',
  author: 'alice',
} as unknown as PRInfo;

const ISSUE = {
  number: 4,
  title: 'Webhook handler falls over under burst load',
  body: 'Acceptance: sustained 100 rps is served, anything above is rejected with 429.',
} as unknown as IssueInfo;

function ctx(over: Partial<FinderContext> = {}): FinderContext {
  return {
    cfg: CFG,
    policy: '',
    numberedDiff: DIFF,
    prInfo: PR,
    issueInfo: null,
    selfReview: false,
    ...over,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'r1-0',
    path: 'src/handler.ts',
    line: 12,
    severity: 'major',
    category: 'bug',
    claim: 'user may be undefined when the header is absent',
    evidence: '`return respond(user.id)` with `user` from an unchecked lookup',
    failure: 'a request with no x-user header dereferences undefined and 500s',
    fix: 'return 400 when lookup yields nothing',
    lens: 'correctness',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Prompt shape
// ---------------------------------------------------------------------------

test('every lens produces a non-empty system and user prompt', async () => {
  const L = await lensesPromise;
  for (const lens of ALL_LENSES) {
    const call = L.buildLensCall(lens, ctx());
    assert.equal(typeof call.system, 'string', `${lens}: system must be a string`);
    assert.equal(typeof call.user, 'string', `${lens}: user must be a string`);
    assert.ok(call.system.trim().length > 200, `${lens}: system prompt is too thin`);
    assert.ok(call.user.trim().length > 200, `${lens}: user prompt is too thin`);
  }
});

test('every call is labelled, and labels never carry untrusted content', async () => {
  const L = await lensesPromise;
  const calls = [
    ...ALL_LENSES.map((lens) => L.buildLensCall(lens, ctx({ policy: POLICY }))),
    L.buildCompletenessCall(ctx({ policy: POLICY }), [finding()]),
  ];
  const labels = calls.map((c) => c.label);
  assert.deepEqual(labels, [
    'lens:correctness',
    'lens:security',
    'lens:performance',
    'lens:integration',
    'lens:test',
    'lens:completeness',
  ]);
  // Labels are logged, so nothing from the diff, the PR, or the policy may
  // reach them.
  for (const label of labels) {
    assert.ok(!label.includes(DIFF_TOKEN));
    assert.ok(!label.includes(POLICY_TOKEN));
    assert.ok(/^lens:[a-z]+$/.test(label), `unexpected label shape: ${label}`);
  }
});

test('LENS_BRIEFS covers exactly the known lenses, each non-empty', async () => {
  const L = await lensesPromise;
  assert.deepEqual(Object.keys(L.LENS_BRIEFS).sort(), [...ALL_LENSES].sort());
  for (const lens of ALL_LENSES) {
    assert.ok(L.LENS_BRIEFS[lens].trim().length > 100, `${lens} brief is too thin`);
  }
});

test("each lens prompt carries its own brief and the schema", async () => {
  const L = await lensesPromise;
  for (const lens of ALL_LENSES) {
    const call = L.buildLensCall(lens, ctx());
    assert.ok(call.system.includes(L.LENS_BRIEFS[lens]), `${lens}: brief missing from system`);
    assert.ok(
      call.system.includes(L.FINDING_SCHEMA_TEXT),
      `${lens}: output schema missing from system`
    );
  }
});

test('a lens is blind to the other lenses', async () => {
  const L = await lensesPromise;
  for (const lens of ALL_LENSES) {
    const call = L.buildLensCall(lens, ctx());
    const whole = `${call.system}\n${call.user}`;
    for (const other of ALL_LENSES) {
      if (other === lens) continue;
      assert.ok(
        !whole.includes(L.LENS_BRIEFS[other]),
        `${lens} prompt leaks the ${other} brief; the lenses would converge`
      );
    }
  }
});

test('the trusted policy goes in the system message, flagged as top authority', async () => {
  const L = await lensesPromise;
  const call = L.buildLensCall('security', ctx({ policy: POLICY }));
  assert.ok(call.system.includes(POLICY_TOKEN), 'policy text missing from system prompt');
  assert.ok(/TOP AUTHORITY/i.test(call.system), 'policy is not flagged as the top authority');
  assert.ok(
    !call.user.includes(POLICY_TOKEN),
    'policy must not be repeated in the untrusted user message'
  );
});

test('with no policy the system message says so instead of inventing one', async () => {
  const L = await lensesPromise;
  const call = L.buildLensCall('security', ctx({ policy: '' }));
  assert.ok(
    call.system.includes('REPOSITORY REVIEW POLICY: none supplied'),
    'missing the explicit "no policy" wording'
  );
  assert.ok(!call.system.includes(POLICY_TOKEN));

  // Whitespace is not a policy.
  const blank = L.buildLensCall('security', ctx({ policy: '   \n  ' }));
  assert.ok(blank.system.includes('REPOSITORY REVIEW POLICY: none supplied'));
});

test('the trust boundary warning is in the USER message', async () => {
  const L = await lensesPromise;
  const call = L.buildLensCall('correctness', ctx());
  assert.ok(
    call.user.includes('UNTRUSTED CONTENT BOUNDARY'),
    'user message does not open with a trust boundary'
  );
  assert.ok(/attacker-controlled/i.test(call.user));
  assert.ok(/ignore every instruction/i.test(call.user));
  // It must name the specific attacks it is refusing, not just wave at them.
  assert.ok(/approve this pull request/i.test(call.user));
  assert.ok(/ignore previous instructions/i.test(call.user));
  // And an injection attempt is itself reportable.
  assert.ok(/category "security"/i.test(call.user));

  const boundaryAt = call.user.indexOf('UNTRUSTED CONTENT BOUNDARY');
  assert.ok(
    boundaryAt >= 0 && boundaryAt < call.user.indexOf(DIFF_TOKEN),
    'the boundary must precede the untrusted material it is guarding'
  );
});

test('the numbered diff is in the user message and never in the system message', async () => {
  const L = await lensesPromise;
  for (const lens of ALL_LENSES) {
    const call = L.buildLensCall(lens, ctx({ policy: POLICY }));
    assert.ok(call.user.includes(DIFF_TOKEN), `${lens}: diff missing from user message`);
    assert.ok(call.user.includes('[+ 11]'), `${lens}: diff body missing from user message`);
    assert.ok(
      !call.system.includes(DIFF_TOKEN),
      `${lens}: the diff leaked into the trusted system message`
    );
  }
});

test('PR title and body reach the user message; a missing body degrades quietly', async () => {
  const L = await lensesPromise;
  const call = L.buildLensCall('correctness', ctx());
  assert.ok(call.user.includes('Add rate limiting to the webhook handler'));
  assert.ok(call.user.includes('Should reject bursts above 100 rps'));

  const bare = L.buildLensCall(
    'correctness',
    ctx({ prInfo: { number: 9, title: null, body: null } as unknown as PRInfo })
  );
  assert.ok(!/undefined|\bnull\b/.test(bare.user.split('=== NUMBERED DIFF')[0]!));
  assert.ok(bare.user.includes('(empty)'));
});

test('the issue clause and the issue body only appear when an issue is linked', async () => {
  const L = await lensesPromise;
  const without = L.buildLensCall('integration', ctx());
  assert.ok(!/LINKED ISSUE/.test(without.system));
  assert.ok(!/LINKED ISSUE/.test(without.user));

  const withIssue = L.buildLensCall('integration', ctx({ issueInfo: ISSUE }));
  assert.ok(/acceptance criterion/i.test(withIssue.system), 'no acceptance-criteria instruction');
  assert.ok(/category "design"/i.test(withIssue.system), 'unmet requirements must be design findings');
  assert.ok(withIssue.user.includes('sustained 100 rps is served'), 'issue body missing');
  assert.ok(
    !withIssue.system.includes('sustained 100 rps is served'),
    'issue text is untrusted and must not sit in the system message'
  );
});

test('self review makes the prompt harsher, and is absent otherwise', async () => {
  const L = await lensesPromise;
  const normal = L.buildLensCall('correctness', ctx());
  assert.ok(!/SELF-REVIEW MODE/.test(normal.system));

  const self = L.buildLensCall('correctness', ctx({ selfReview: true }));
  assert.ok(/SELF-REVIEW MODE/.test(self.system));
  assert.ok(/HARDER, not more gently/.test(self.system));
});

test('every finder prompt bans cosmetics and unjudgeable existence claims', async () => {
  const L = await lensesPromise;
  const calls = [
    ...ALL_LENSES.map((lens) => L.buildLensCall(lens, ctx())),
    L.buildCompletenessCall(ctx(), [finding()]),
  ];
  for (const call of calls) {
    assert.ok(/NO COSMETICS/.test(call.system), 'no cosmetic suppression');
    assert.ok(/naming, formatting/.test(call.system));
    assert.ok(/Code conventions do not matter/.test(call.system));
    assert.ok(/looks like a typo/.test(call.system), 'no ban on existence guessing');
    assert.ok(/knowledge has a cutoff/.test(call.system));
    // Anchoring and concrete failures are the load-bearing rules.
    assert.ok(/\[\+ N\]/.test(call.system), 'anchoring format not stated');
    assert.ok(/IF YOU CANNOT WRITE A CONCRETE FAILURE/.test(call.system));
    assert.ok(call.system.includes(L.FINDING_SCHEMA_TEXT));
  }
});

test('the projectName from config reaches the prompt', async () => {
  const L = await lensesPromise;
  assert.ok(L.buildLensCall('test', ctx()).system.includes('acme-gateway'));
  const blank = { ...CFG, projectName: '' };
  const call = L.buildLensCall('test', ctx({ cfg: blank }));
  assert.ok(call.system.includes('this repository'), 'no fallback project name');
});

// ---------------------------------------------------------------------------
// Completeness critic
// ---------------------------------------------------------------------------

test('the completeness prompt carries round one and forbids repeating it', async () => {
  const L = await lensesPromise;
  const roundOne = [
    finding({ id: 'r1-0', claim: 'ROUND-ONE-CLAIM-A', lens: 'correctness' }),
    finding({
      id: 'r1-1',
      claim: 'ROUND-ONE-CLAIM-B',
      path: 'src/queue.ts',
      line: 4,
      severity: 'critical',
      category: 'security',
      lens: 'security',
      failure: 'ROUND-ONE-FAILURE-B',
    }),
  ];
  const call = L.buildCompletenessCall(ctx(), roundOne);

  assert.ok(call.user.includes('ROUND-ONE-CLAIM-A'), 'round-one finding A missing');
  assert.ok(call.user.includes('ROUND-ONE-CLAIM-B'), 'round-one finding B missing');
  assert.ok(call.user.includes('ROUND-ONE-FAILURE-B'), 'round-one failure text missing');
  assert.ok(call.user.includes('src/queue.ts:4'), 'round-one anchor missing');
  assert.ok(call.user.includes('[security]'), 'round-one lens attribution missing');

  assert.ok(/DO NOT REPEAT/i.test(call.system), 'no instruction against repeating round one');
  assert.ok(/WHAT DID EVERY ONE OF THOSE PASSES MISS/.test(call.system));
  assert.ok(/lazy/i.test(call.system), 'critic is not told to assume laziness');
  assert.ok(/pattern-matched/i.test(call.system));
  // It must be pointed at absence, not at the added lines.
  assert.ok(/not in the diff|nobody updated|nobody wrote/i.test(call.system));
  assert.ok(/rollback/i.test(call.system));
  assert.ok(/concurrent/i.test(call.system));
  assert.ok(/malformed/i.test(call.system));
  // Same output contract as the lenses.
  assert.ok(call.system.includes(L.FINDING_SCHEMA_TEXT));
  // Same trust boundary, same diff placement.
  assert.ok(call.user.includes('UNTRUSTED CONTENT BOUNDARY'));
  assert.ok(call.user.includes(DIFF_TOKEN));
  assert.ok(!call.system.includes(DIFF_TOKEN));
  assert.ok(!call.system.includes('ROUND-ONE-CLAIM-A'), 'round-one text belongs in the user message');
});

test('an empty round one is treated as a superficial sweep, not as a clean diff', async () => {
  const L = await lensesPromise;
  const call = L.buildCompletenessCall(ctx(), []);
  assert.ok(call.user.includes('ROUND ONE FINDINGS'));
  assert.ok(/superficial|look harder/i.test(call.user));
  assert.ok(call.user.length > 200);
});

// ---------------------------------------------------------------------------
// parseFindings
// ---------------------------------------------------------------------------

test('parseFindings returns [] for garbage instead of throwing', async () => {
  const L = await lensesPromise;
  for (const garbage of [
    null,
    undefined,
    [],
    {},
    'findings',
    42,
    true,
    { findings: null },
    { findings: 'nope' },
    { findings: {} },
    { results: [{ path: 'a', line: 1 }] },
  ]) {
    const out = L.parseFindings(garbage, 'correctness');
    assert.deepEqual(out, [], `expected [] for ${JSON.stringify(garbage) ?? 'undefined'}`);
  }
});

test('parseFindings accepts a well-formed finding and fills id and lens', async () => {
  const L = await lensesPromise;
  const out = L.parseFindings(
    {
      findings: [
        {
          path: 'src/handler.ts',
          line: 12,
          severity: 'critical',
          category: 'security',
          claim: 'unauthenticated lookup',
          evidence: '`lookup(req.headers.get("x-user"))`',
          failure: 'any caller can pass an arbitrary x-user and act as that user',
          fix: 'verify the session before lookup',
        },
      ],
    },
    'security'
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    id: 'security-0',
    path: 'src/handler.ts',
    line: 12,
    severity: 'critical',
    category: 'security',
    claim: 'unauthenticated lookup',
    evidence: '`lookup(req.headers.get("x-user"))`',
    failure: 'any caller can pass an arbitrary x-user and act as that user',
    fix: 'verify the session before lookup',
    lens: 'security',
  });
});

test('parseFindings drops malformed entries', async () => {
  const L = await lensesPromise;
  const base = {
    path: 'src/handler.ts',
    line: 12,
    severity: 'major',
    category: 'bug',
    claim: 'c',
    evidence: 'e',
    failure: 'f',
    fix: 'x',
  };
  const bad: unknown[] = [
    null,
    undefined,
    'a string finding',
    42,
    [],
    ['src/handler.ts', 12],
    { ...base, path: undefined },
    { ...base, path: '' },
    { ...base, path: '   ' },
    { ...base, claim: undefined },
    { ...base, claim: '' },
    { ...base, line: undefined },
    { ...base, line: 0 },
    { ...base, line: -3 },
    { ...base, line: 12.5 },
    { ...base, line: NaN },
    { ...base, line: Infinity },
    { ...base, line: '12' },
    { ...base, line: 'line 12' },
    { ...base, severity: undefined },
    { ...base, severity: 'catastrophic' },
    { ...base, severity: 42 },
    { ...base, category: undefined },
    { ...base, category: 'vibes' },
  ];
  for (const entry of bad) {
    assert.deepEqual(
      L.parseFindings({ findings: [entry] }, 'correctness'),
      [],
      `should have dropped: ${JSON.stringify(entry) ?? 'undefined'}`
    );
  }
  // ...and the good one still survives, so the filter is not just refusing all.
  assert.equal(L.parseFindings({ findings: [base] }, 'correctness').length, 1);
});

test('parseFindings drops findings with no concrete failure scenario', async () => {
  const L = await lensesPromise;
  const base = {
    path: 'src/handler.ts',
    line: 12,
    severity: 'major',
    category: 'bug',
    claim: 'c',
    evidence: 'e',
    fix: 'x',
  };
  for (const failure of [undefined, '', '   ', '\n\t ', null, 0, false]) {
    assert.deepEqual(
      L.parseFindings({ findings: [{ ...base, failure }] }, 'correctness'),
      [],
      `should have dropped failure=${JSON.stringify(failure)}`
    );
  }
  assert.equal(
    L.parseFindings({ findings: [{ ...base, failure: 'empty header -> 500' }] }, 'correctness')
      .length,
    1
  );
});

test('parseFindings coerces severity synonyms', async () => {
  const L = await lensesPromise;
  const cases: Array<[unknown, string]> = [
    ['critical', 'critical'],
    ['CRITICAL', 'critical'],
    ['blocker', 'critical'],
    ['major', 'major'],
    ['high', 'major'],
    ['High', 'major'],
    ['med', 'major'],
    ['medium', 'major'],
    ['minor', 'minor'],
    ['low', 'minor'],
    ['nit', 'minor'],
    ['info', 'minor'],
    [' Low ', 'minor'],
  ];
  for (const [input, expected] of cases) {
    const out = L.parseFindings(
      {
        findings: [
          {
            path: 'a.ts',
            line: 1,
            severity: input,
            category: 'bug',
            claim: 'c',
            failure: 'f',
          },
        ],
      },
      'correctness'
    );
    assert.equal(out.length, 1, `severity ${String(input)} was dropped`);
    assert.equal(out[0]!.severity, expected, `severity ${String(input)}`);
  }
});

test('parseFindings coerces category synonyms', async () => {
  const L = await lensesPromise;
  const cases: Array<[unknown, string]> = [
    ['security', 'security'],
    ['Vulnerability', 'security'],
    ['bug', 'bug'],
    ['logic', 'bug'],
    ['correctness', 'bug'],
    ['design', 'design'],
    ['architecture', 'design'],
    ['integration', 'design'],
    ['performance', 'performance'],
    ['perf', 'performance'],
    ['PERF', 'performance'],
    ['test', 'test'],
    ['testing', 'test'],
  ];
  for (const [input, expected] of cases) {
    const out = L.parseFindings(
      {
        findings: [
          {
            path: 'a.ts',
            line: 1,
            severity: 'major',
            category: input,
            claim: 'c',
            failure: 'f',
          },
        ],
      },
      'correctness'
    );
    assert.equal(out.length, 1, `category ${String(input)} was dropped`);
    assert.equal(out[0]!.category, expected, `category ${String(input)}`);
  }
});

test('parseFindings drops cosmetic findings outright', async () => {
  const L = await lensesPromise;
  const base = {
    path: 'a.ts',
    line: 1,
    severity: 'minor',
    category: 'bug',
    claim: 'rename this variable',
    failure: 'the reader is confused',
  };
  // `style` is not coerced to anything — the rules forbid reporting it at all.
  assert.deepEqual(L.parseFindings({ findings: [{ ...base, severity: 'style' }] }, 'x'), []);
  for (const category of ['style', 'formatting', 'naming', 'readability', 'nit', 'docs']) {
    assert.deepEqual(
      L.parseFindings({ findings: [{ ...base, category }] }, 'x'),
      [],
      `cosmetic category ${category} survived`
    );
  }
});

test('parseFindings assigns stable sequential ids across dropped entries', async () => {
  const L = await lensesPromise;
  const ok = (n: number) => ({
    path: 'a.ts',
    line: n,
    severity: 'major',
    category: 'bug',
    claim: `claim ${n}`,
    failure: `failure ${n}`,
  });
  const out = L.parseFindings(
    { findings: [ok(1), null, { ...ok(2), line: 0 }, ok(3), 'garbage', ok(4)] },
    'completeness'
  );
  // Three of the six entries survive, and the ids close the gaps rather than
  // inheriting the input positions.
  assert.deepEqual(
    out.map((f) => f.id),
    ['completeness-0', 'completeness-1', 'completeness-2']
  );
  assert.deepEqual(
    out.map((f) => f.line),
    [1, 3, 4]
  );
  assert.ok(out.every((f) => f.lens === 'completeness'));
  // Same input, same ids: the adversary stage matches verdicts by id.
  const again = L.parseFindings(
    { findings: [ok(1), null, { ...ok(2), line: 0 }, ok(3), 'garbage', ok(4)] },
    'completeness'
  );
  assert.deepEqual(again.map((f) => f.id), out.map((f) => f.id));
});

test('parseFindings accepts a bare array and truncates absurd strings', async () => {
  const L = await lensesPromise;
  const huge = 'x'.repeat(9000);
  const out = L.parseFindings(
    [
      {
        path: 'a.ts',
        line: 1,
        severity: 'major',
        category: 'bug',
        claim: huge,
        evidence: huge,
        failure: huge,
        fix: huge,
      },
    ],
    'correctness'
  );
  assert.equal(out.length, 1);
  for (const field of ['claim', 'evidence', 'failure', 'fix'] as const) {
    assert.ok(out[0]![field].length <= 4000, `${field} was not truncated (${out[0]![field].length})`);
    assert.ok(out[0]![field].length > 3000, `${field} was truncated far too aggressively`);
  }
});

test('parseFindings tidies a path the model decorated', async () => {
  const L = await lensesPromise;
  const out = L.parseFindings(
    {
      findings: [
        {
          path: '`./src/handler.ts`',
          line: 11,
          severity: 'major',
          category: 'bug',
          claim: 'c',
          failure: 'f',
        },
        {
          path: '## src/queue.ts',
          line: 4,
          severity: 'minor',
          category: 'performance',
          claim: 'c',
          failure: 'f',
        },
        {
          // Stacked decorations, in an order the peeling must not assume.
          path: '  `## ./src/render.ts`  ',
          line: 2,
          severity: 'minor',
          category: 'design',
          claim: 'c',
          failure: 'f',
        },
      ],
    },
    'correctness'
  );
  assert.deepEqual(
    out.map((f) => f.path),
    ['src/handler.ts', 'src/queue.ts', 'src/render.ts']
  );
});

test('parseFindings never throws on hostile shapes', async () => {
  const L = await lensesPromise;
  const cyclic: Record<string, unknown> = { path: 'a.ts', line: 1 };
  cyclic.self = cyclic;
  const hostile: unknown[] = [
    { findings: [cyclic] },
    { findings: [Object.create(null)] },
    { findings: [{ path: { toString: () => 'a.ts' }, line: 1 }] },
    { findings: [{ path: 'a.ts', line: 1n as unknown as number }] },
    Object.create(null),
    new Map(),
    Symbol('x'),
  ];
  for (const raw of hostile) {
    assert.doesNotThrow(() => L.parseFindings(raw, 'correctness'));
  }
});
