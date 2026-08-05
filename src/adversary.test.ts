/**
 * Tests for the ADVERSARY stage.
 *
 * What is pinned here is not the wording of the skeptic prompts. It is the
 * arithmetic that decides whether a finding reaches a human, and the properties
 * that make that arithmetic honest:
 *
 *   - The skeptics attack differently. If their prompts converged, N calls would
 *     buy one opinion at N times the price.
 *   - The first three lenses stay first, because `adversarial_rounds` takes a
 *     prefix of the list and its default is 3.
 *   - A hedged refutation does not kill anything, and a skeptic that never
 *     answered does not vote at all — in either direction. An API timeout must
 *     not be able to change what gets posted.
 *   - `critical` is earned twice: once by surviving, once by surviving cleanly —
 *     and "cleanly" scales with how many skeptics actually answered.
 *
 * Every malformed shape fed to `parseVerdicts` below is a shape a model has
 * actually produced.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Finding, Verdict } from './types';
import type { ReviewerConfig } from './config';
import type { AdversaryContext, SkepticLens } from './adversary';

/**
 * Node's type stripping resolves imports the way ESM does: `./adversary` does
 * not resolve and only `./adversary.ts` does — which `tsc` rejects as an import
 * path. A specifier held in a variable is the single form both accept. The real
 * types come back through `typeof import(...)`, which is a type position and is
 * erased before any of this runs.
 */
type AdversaryModule = typeof import('./adversary');
const ADVERSARY_SPECIFIER = './adversary.ts';
const adversaryPromise = import(ADVERSARY_SPECIFIER) as Promise<AdversaryModule>;

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

function cfg(over: Partial<ReviewerConfig> = {}): ReviewerConfig {
  return { ...CFG, ...over };
}

// A token that appears nowhere else, so "did the diff reach this message?" is an
// exact question rather than a fuzzy one.
const DIFF_TOKEN = 'pqr-diff-marker-5518';

const DIFF = `## src/handler.ts
[  10] export async function handle(req: Request) {
[+ 11]   const user = await lookup(req.headers.get('x-user')); // ${DIFF_TOKEN}
[+ 12]   return respond(user.id);
[  13] }`;

const CTX: AdversaryContext = {
  cfg: CFG,
  numberedDiff: DIFF,
  policy: 'Never approve a migration without a rollback.',
  projectName: 'iolite',
};

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'correctness-0',
    path: 'src/handler.ts',
    line: 12,
    severity: 'major',
    category: 'bug',
    claim: 'user may be null',
    evidence: '[+ 12]   return respond(user.id);',
    failure: 'A request with no x-user header returns 500 instead of 401.',
    fix: 'Return 401 when lookup misses.',
    lens: 'correctness',
    ...over,
  };
}

function verdict(
  id: string,
  skeptic: string,
  refuted: boolean,
  confidence = 0.9,
  reason = 'because'
): Verdict {
  return { id, refuted, confidence, reason, skeptic };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

test('the first three skeptic lenses are fact, context, impact, in that order', async () => {
  const { SKEPTIC_LENSES } = await adversaryPromise;

  // `pipeline.ts` runs `SKEPTIC_LENSES.slice(0, adversarialRounds)`, and the
  // default is 3. So this prefix IS the default behaviour of every install that
  // never touched the setting: reordering it, or inserting a new lens in front,
  // would silently change what those repositories run without changing a single
  // line of their configuration. New lenses are appended, never inserted.
  assert.deepEqual(SKEPTIC_LENSES.slice(0, 3), ['fact', 'context', 'impact']);
});

test('every skeptic prompt attacks from a genuinely different angle', async () => {
  const { buildSkepticCall, SKEPTIC_LENSES } = await adversaryPromise;
  assert.deepEqual(
    [...SKEPTIC_LENSES],
    ['fact', 'context', 'impact', 'reachability', 'precedent']
  );

  const systems = SKEPTIC_LENSES.map((lens) => buildSkepticCall(lens, [finding()], CTX).system);

  for (const s of systems) assert.ok(s.length > 200, 'skeptic system prompt is missing');

  // Pairwise distinct. N copies of "are you sure?" would be one skeptic billed
  // N times.
  for (let i = 0; i < systems.length; i++) {
    for (let j = i + 1; j < systems.length; j++) {
      assert.notEqual(systems[i], systems[j], `${SKEPTIC_LENSES[i]} and ${SKEPTIC_LENSES[j]} are the same prompt`);
    }
  }

  // And distinct in substance: each carries its own brief and nobody else's, so
  // no skeptic can quietly double-count another's attack.
  SKEPTIC_LENSES.forEach((lens, i) => {
    const own = `YOUR LENS: ${lens.toUpperCase()}`;
    assert.ok(systems[i].includes(own), `${lens} is missing its own brief`);
    for (const other of SKEPTIC_LENSES) {
      if (other === lens) continue;
      const foreign = `YOUR LENS: ${other.toUpperCase()}`;
      assert.ok(!systems[i].includes(foreign), `${lens} carries the ${other} brief too`);
    }
  });
});

test('every skeptic is told to lean toward refuting when uncertain', async () => {
  const { buildSkepticCall, SKEPTIC_LENSES } = await adversaryPromise;

  for (const lens of SKEPTIC_LENSES) {
    const { system } = buildSkepticCall(lens, [finding()], CTX);
    assert.match(
      system,
      /WHEN YOU ARE GENUINELY UNCERTAIN, LEAN TOWARD "refuted": true/,
      `${lens} skeptic is missing the asymmetry instruction`
    );
    assert.match(system, /YOUR JOB IS TO REFUTE/, `${lens} skeptic is not told to refute`);
    // The reason the asymmetry exists has to travel with the instruction, or it
    // reads as a bias to be corrected rather than a rule to be followed.
    assert.match(system, /credibility|trust/i);
  }
});

test('the impact skeptic is the one that kills style wearing a bug costume', async () => {
  const { buildSkepticCall } = await adversaryPromise;
  const impact = buildSkepticCall('impact', [finding()], CTX).system;
  assert.match(impact, /WEARING A BUG COSTUME/);
  assert.match(impact, /does not report style/i);
});

test('the reachability skeptic attacks whether control flow can get there at all', async () => {
  const { buildSkepticCall } = await adversaryPromise;
  const reach = buildSkepticCall('reachability', [finding()], CTX).system;

  assert.match(reach, /YOUR LENS: REACHABILITY/);
  // The specific ways a state turns out to be unenterable. Without these the
  // lens degenerates into a second `context` skeptic.
  assert.match(reach, /dead\b/i);
  assert.match(reach, /impossible/i);
  assert.match(reach, /caller/i);
  assert.match(reach, /test/i);

  // Rare is not unreachable. A lens that refutes anything hard to hit would
  // delete most real vulnerabilities, which is the failure mode to guard.
  assert.match(reach, /Rare is not unreachable/i);

  // It shares the discipline every skeptic carries.
  assert.match(reach, /WHEN YOU ARE GENUINELY UNCERTAIN, LEAN TOWARD "refuted": true/);
  assert.match(reach, /RETURN A VERDICT FOR EVERY ID YOU WERE GIVEN/);
  assert.match(reach, /JUDGE EACH FINDING INDEPENDENTLY/);
  assert.match(reach, /TRUST BOUNDARY/);
  assert.match(reach, /OUTPUT PURE JSON/);
});

test('the precedent skeptic attacks findings that are objections to house style', async () => {
  const { buildSkepticCall } = await adversaryPromise;
  const prec = buildSkepticCall('precedent', [finding()], CTX).system;

  assert.match(prec, /YOUR LENS: PRECEDENT/);
  assert.match(prec, /convention/i);
  // Where the precedent is looked for: the surrounding diff, the repo policy,
  // and a check the project centralised somewhere else on purpose.
  assert.match(prec, /surrounding code/i);
  assert.match(prec, /review policy/i);
  assert.match(prec, /centralis|centraliz/i);

  assert.match(prec, /WHEN YOU ARE GENUINELY UNCERTAIN, LEAN TOWARD "refuted": true/);
  assert.match(prec, /RETURN A VERDICT FOR EVERY ID YOU WERE GIVEN/);
  assert.match(prec, /JUDGE EACH FINDING INDEPENDENTLY/);
  assert.match(prec, /TRUST BOUNDARY/);
  assert.match(prec, /OUTPUT PURE JSON/);
});

test('the precedent skeptic refuses to excuse a real failure on convention grounds', async () => {
  const { buildSkepticCall } = await adversaryPromise;
  const prec = buildSkepticCall('precedent', [finding()], CTX).system;

  // This is the lens's own failure mode, and it is the worst one in the whole
  // stage: a skeptic that accepts "we always do it this way" would refute
  // exactly the findings that matter most, because an unsafe pattern copied
  // across a codebase looks more conventional the more places it has spread to.
  assert.match(prec, /CONVENTION IS NOT A DEFENCE FOR AN UNSAFE\s+PATTERN/);
  assert.match(prec, /NEVER EXCUSE A REAL\s+SECURITY OR CORRECTNESS FAILURE/);
  // Named instances, so the rule is not abstract enough to reason around.
  assert.match(prec, /unescaped/i);
  assert.match(prec, /swallow/i);
  // And the positive instruction: say it out loud rather than staying silent.
  assert.match(prec, /leave the finding standing/i);
});

test('every skeptic carries the batch rules: all ids, independent, JSON, untrusted diff', async () => {
  const { buildSkepticCall, SKEPTIC_LENSES } = await adversaryPromise;

  for (const lens of SKEPTIC_LENSES) {
    const { system } = buildSkepticCall(lens, [finding()], CTX);
    assert.match(system, /RETURN A VERDICT FOR EVERY ID YOU WERE GIVEN/);
    assert.match(system, /Omitting an id is a failure/);
    assert.match(system, /JUDGE EACH FINDING INDEPENDENTLY/);
    assert.match(system, /TRUST BOUNDARY/);
    assert.match(system, /OUTPUT PURE JSON/);
    assert.match(system, /"verdicts"/);
  }
});

test('every finding id reaches the prompt, and so does the diff', async () => {
  const { buildSkepticCall } = await adversaryPromise;

  const findings = [
    finding({ id: 'correctness-0', line: 11 }),
    finding({ id: 'security-3', line: 12, category: 'security' }),
    finding({ id: 'completeness-7', line: 13, category: 'design' }),
  ];
  const call = buildSkepticCall('fact', findings, CTX);

  for (const f of findings) {
    assert.ok(call.user.includes(f.id), `id ${f.id} never reached the skeptic`);
  }
  assert.ok(call.user.includes(DIFF_TOKEN), 'the diff never reached the skeptic');
  assert.match(call.user, /Return exactly 3 verdict\(s\)/);

  // The diff is data. It must not travel in the channel that carries authority.
  assert.ok(!call.system.includes(DIFF_TOKEN), 'the diff leaked into the system message');

  // The label reaches the logs, so it names the call and nothing else.
  assert.equal(call.label, 'skeptic:fact');
  assert.ok(!call.label.includes(DIFF_TOKEN));
});

test('a skeptic prompt survives an empty finding list without inventing work', async () => {
  const { buildSkepticCall } = await adversaryPromise;
  const call = buildSkepticCall('context', [], CTX);
  assert.match(call.user, /FINDINGS TO JUDGE \(0\)/);
  assert.ok(call.system.length > 0);
});

// ---------------------------------------------------------------------------
// parseVerdicts
// ---------------------------------------------------------------------------

test('parseVerdicts reads the documented shape, a bare array, and fenced JSON', async () => {
  const { parseVerdicts } = await adversaryPromise;

  const wrapped = parseVerdicts(
    { verdicts: [{ id: 'a-0', refuted: true, confidence: 0.8, reason: 'misquoted' }] },
    'fact'
  );
  assert.equal(wrapped.length, 1);
  assert.deepEqual(wrapped[0], {
    id: 'a-0',
    refuted: true,
    confidence: 0.8,
    reason: 'misquoted',
    skeptic: 'fact',
  });

  const bare = parseVerdicts([{ id: 'a-0', refuted: false, confidence: 0.7, reason: 'real' }], 'impact');
  assert.equal(bare.length, 1);
  assert.equal(bare[0].skeptic, 'impact');

  const fenced = parseVerdicts(
    '```json\n{"verdicts":[{"id":"a-1","refuted":true,"confidence":0.9,"reason":"guarded"}]}\n```',
    'context'
  );
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].id, 'a-1');
});

test('parseVerdicts drops garbage entries and entries with no usable id', async () => {
  const { parseVerdicts } = await adversaryPromise;

  const out = parseVerdicts(
    {
      verdicts: [
        null,
        'a string',
        42,
        [],
        {},                                            // no id at all
        { id: 5, refuted: true },                      // id is not a string
        { id: '   ', refuted: true },                  // id is blank
        { id: 'no-verdict-0' },                        // never said whether it refutes
        { id: 'unparseable-0', refuted: 'maybe' },     // refuted is not boolean-ish
        { id: 'good-0', refuted: true, confidence: 0.9, reason: 'ok' },
      ],
    },
    'fact'
  );

  assert.deepEqual(
    out.map((v) => v.id),
    ['good-0']
  );
});

test('parseVerdicts returns [] for anything that is not a verdict list', async () => {
  const { parseVerdicts } = await adversaryPromise;

  for (const raw of [null, undefined, 42, true, 'nope', '', { verdicts: 'soon' }, { other: [] }]) {
    assert.deepEqual(parseVerdicts(raw, 'fact'), [], `expected [] for ${JSON.stringify(raw)}`);
  }
});

test('parseVerdicts coerces confidence and refuses to let one skeptic vote twice', async () => {
  const { parseVerdicts } = await adversaryPromise;

  const out = parseVerdicts(
    {
      verdicts: [
        { id: 'a-0', refuted: true },                             // no confidence stated
        { id: 'a-0', refuted: true, confidence: 1 },              // same skeptic, same finding
        { id: 'a-1', refuted: 'true', confidence: '0.75' },       // strings
        { id: 'a-2', refuted: true, confidence: 42 },             // out of range high
        { id: 'a-3', refuted: false, confidence: -3 },            // out of range low
      ],
    },
    'fact'
  );

  assert.deepEqual(
    out.map((v) => [v.id, v.refuted, v.confidence]),
    [
      ['a-0', true, 0.5],
      ['a-1', true, 0.75],
      ['a-2', true, 1],
      ['a-3', false, 0],
    ]
  );
});

test('parseVerdicts stamps the skeptic from the caller, not from the response', async () => {
  const { parseVerdicts } = await adversaryPromise;
  // Otherwise one call could cast votes under all three skeptics' names and
  // reach the refute threshold by itself.
  const out = parseVerdicts(
    { verdicts: [{ id: 'a-0', refuted: true, confidence: 0.9, skeptic: 'impact' }] },
    'fact'
  );
  assert.equal(out[0].skeptic, 'fact');
});

// ---------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------

test('judge kills at exactly the threshold and not one vote below it', async () => {
  const { judge } = await adversaryPromise;
  const f = finding({ id: 'f-0' });
  const c = cfg({ refuteThreshold: 2 });

  const below = judge([f], [verdict('f-0', 'fact', true)], c);
  assert.equal(below[0].refuteVotes, 1);
  assert.equal(below[0].survived, true);

  const at = judge([f], [verdict('f-0', 'fact', true), verdict('f-0', 'context', true)], c);
  assert.equal(at[0].refuteVotes, 2);
  assert.equal(at[0].survived, false);

  // Both are returned either way: the caller has to be able to say how many
  // were killed.
  assert.equal(at.length, 1);
});

test('judge honours a threshold of 3 and of 1', async () => {
  const { judge } = await adversaryPromise;
  const f = finding({ id: 'f-0' });
  const votes = [verdict('f-0', 'fact', true), verdict('f-0', 'context', true)];

  assert.equal(judge([f], votes, cfg({ refuteThreshold: 3 }))[0].survived, true);
  assert.equal(judge([f], [votes[0]], cfg({ refuteThreshold: 1 }))[0].survived, false);
});

test('five skeptics at threshold 3 kill at exactly three refutations, not at two', async () => {
  const { judge } = await adversaryPromise;
  const f = finding({ id: 'f-0' });
  const c = cfg({ adversarialRounds: 5, refuteThreshold: 3 });

  // Two of the five confident refutations: below the bar, so it lives. This is
  // the case a 3-lens ceiling could never express — with only three skeptics
  // available, `refute_threshold: 3` meant unanimity.
  const two = judge(
    [f],
    [
      verdict('f-0', 'fact', true),
      verdict('f-0', 'context', true),
      verdict('f-0', 'impact', false),
      verdict('f-0', 'reachability', false),
      verdict('f-0', 'precedent', false),
    ],
    c
  );
  assert.equal(two[0].refuteVotes, 2);
  assert.equal(two[0].survived, true);

  const three = judge(
    [f],
    [
      verdict('f-0', 'fact', true),
      verdict('f-0', 'context', true),
      verdict('f-0', 'reachability', true),
      verdict('f-0', 'impact', false),
      verdict('f-0', 'precedent', false),
    ],
    c
  );
  assert.equal(three[0].refuteVotes, 3);
  assert.equal(three[0].survived, false);

  // All five are counted, including the two new lenses: a verdict from
  // `reachability` or `precedent` is a vote like any other.
  assert.equal(three[0].verdicts.length, 5);
});

test('the two new skeptics can kill a finding on their own votes', async () => {
  const { judge } = await adversaryPromise;
  const f = finding({ id: 'f-0' });

  // The refute threshold does not care which lenses cast the votes. A finding
  // about code nothing can reach, flagged against a pattern the project chose,
  // dies on those two objections alone.
  const judged = judge(
    [f],
    [verdict('f-0', 'reachability', true), verdict('f-0', 'precedent', true)],
    cfg({ adversarialRounds: 5, refuteThreshold: 2 })
  );
  assert.equal(judged[0].refuteVotes, 2);
  assert.equal(judged[0].survived, false);
});

test('a hedged refutation does not count as a vote', async () => {
  const { judge } = await adversaryPromise;
  const f = finding({ id: 'f-0' });
  const c = cfg({ refuteThreshold: 2 });

  const hedged = judge(
    [f],
    [verdict('f-0', 'fact', true, 0.4), verdict('f-0', 'context', true, 0.49)],
    c
  );
  assert.equal(hedged[0].refuteVotes, 0);
  assert.equal(hedged[0].survived, true);
  // The hedges are still recorded — they are evidence even when they are not votes.
  assert.equal(hedged[0].verdicts.length, 2);

  // Exactly 0.5 is a vote; the cut is at "unsure", not "slightly unsure".
  const atCut = judge(
    [f],
    [verdict('f-0', 'fact', true, 0.5), verdict('f-0', 'context', true, 0.5)],
    c
  );
  assert.equal(atCut[0].refuteVotes, 2);
  assert.equal(atCut[0].survived, false);
});

test('a skeptic that never answered neither saves nor kills anything', async () => {
  const { judge } = await adversaryPromise;
  const c = cfg({ adversarialRounds: 3, refuteThreshold: 2 });

  // Three skeptics were configured; only `fact` came back. Two findings, one
  // verdict between them.
  const findings = [finding({ id: 'f-0' }), finding({ id: 'f-1' })];
  const judged = judge(findings, [verdict('f-0', 'fact', true)], c);

  // Not killed: one present vote is below the threshold, and the two silent
  // skeptics did not add votes to reach it.
  assert.equal(judged[0].refuteVotes, 1);
  assert.equal(judged[0].survived, true);

  // Not saved either: the finding with no verdicts at all is not marked as
  // approved by anyone.
  assert.equal(judged[1].refuteVotes, 0);
  assert.deepEqual(judged[1].verdicts, []);
  assert.equal(judged[1].survived, true);

  // And a finding that reached the threshold among the verdicts that DO exist
  // still dies, even though a third skeptic is missing.
  const dead = judge(
    findings,
    [verdict('f-1', 'fact', true), verdict('f-1', 'context', true)],
    c
  );
  assert.equal(dead[1].survived, false);
});

test('judge ignores verdicts for ids no finding carries', async () => {
  const { judge } = await adversaryPromise;
  const f = finding({ id: 'f-0' });

  const judged = judge(
    [f],
    [
      verdict('hallucinated-9', 'fact', true),
      verdict('hallucinated-9', 'context', true),
      verdict('f-0', 'impact', true),
    ],
    cfg({ refuteThreshold: 2 })
  );

  assert.equal(judged.length, 1);
  assert.equal(judged[0].refuteVotes, 1);
  assert.equal(judged[0].survived, true);
});

test('one skeptic cannot cast the same vote twice', async () => {
  const { judge } = await adversaryPromise;
  const f = finding({ id: 'f-0' });

  const judged = judge(
    [f],
    [verdict('f-0', 'fact', true), verdict('f-0', 'fact', true), verdict('f-0', 'fact', true)],
    cfg({ refuteThreshold: 2 })
  );

  assert.equal(judged[0].refuteVotes, 1);
  assert.equal(judged[0].survived, true);
});

test('adversarialRounds 0 makes everything survive, with no verdicts invented', async () => {
  const { judge } = await adversaryPromise;
  const findings = [finding({ id: 'f-0' }), finding({ id: 'f-1', severity: 'critical' })];

  const judged = judge(
    findings,
    // Even if verdicts somehow exist, the disabled adversary does not use them.
    [verdict('f-0', 'fact', true), verdict('f-0', 'context', true)],
    cfg({ adversarialRounds: 0, refuteThreshold: 0 })
  );

  assert.equal(judged.length, 2);
  for (const j of judged) {
    assert.equal(j.survived, true);
    assert.deepEqual(j.verdicts, []);
    assert.equal(j.refuteVotes, 0);
  }
  // No skeptic ran, so nothing was earned and nothing is downgraded either.
  assert.equal(judged[1].finding.severity, 'critical');
});

test('a critical that survives cleanly with two concurring skeptics stays critical', async () => {
  const { judge } = await adversaryPromise;
  const f = finding({ id: 'f-0', severity: 'critical' });

  // Two answered and both concurred: that is a majority of the panel that
  // actually looked at it, and it clears the floor of 2.
  const judged = judge(
    [f],
    [verdict('f-0', 'fact', false, 0.9), verdict('f-0', 'context', false, 0.8)],
    cfg({ refuteThreshold: 2 })
  );

  assert.equal(judged[0].survived, true);
  assert.equal(judged[0].refuteVotes, 0);
  assert.equal(judged[0].finding.severity, 'critical');
});

test('concurrence scales: with five answering skeptics a critical needs three, not two', async () => {
  const { judge } = await adversaryPromise;
  const f = finding({ id: 'f-0', severity: 'critical' });
  const c = cfg({ adversarialRounds: 5, refuteThreshold: 3 });

  // Two confident concurrences and three shrugs. Under the old fixed "≥2" this
  // kept `critical` — a majority of the skeptics that read it declined to stand
  // behind it, and it shouted anyway. Raising `adversarial_rounds` is a request
  // for MORE scrutiny; it must not make the loudest severity cheaper to earn.
  const thin = judge(
    [f],
    [
      verdict('f-0', 'fact', false, 0.9),
      verdict('f-0', 'context', false, 0.9),
      verdict('f-0', 'impact', false, 0.2),
      verdict('f-0', 'reachability', false, 0.3),
      verdict('f-0', 'precedent', false, 0.1),
    ],
    c
  );
  assert.equal(thin[0].survived, true);
  assert.equal(thin[0].refuteVotes, 0);
  assert.equal(thin[0].finding.severity, 'major');

  // Three of the five stand behind it: a majority of the panel that answered.
  const earned = judge(
    [f],
    [
      verdict('f-0', 'fact', false, 0.9),
      verdict('f-0', 'context', false, 0.9),
      verdict('f-0', 'impact', false, 0.8),
      verdict('f-0', 'reachability', false, 0.3),
      verdict('f-0', 'precedent', false, 0.1),
    ],
    c
  );
  assert.equal(earned[0].finding.severity, 'critical');
});

test('the concurrence bar is a majority of who answered, floored at two', async () => {
  const { judge } = await adversaryPromise;
  const c = cfg({ adversarialRounds: 5, refuteThreshold: 3 });
  const lenses = ['fact', 'context', 'impact', 'reachability', 'precedent'];

  // answered -> concurrences needed: 1->2, 2->2, 3->2, 4->3, 5->3.
  const needed = [0, 2, 2, 2, 3, 3];

  for (let answered = 1; answered <= 5; answered++) {
    for (let concurring = 0; concurring <= answered; concurring++) {
      const votes = lenses
        .slice(0, answered)
        // Everyone answers; only the first `concurring` of them stand behind it.
        // The rest shrug, which is an answer and not a vote.
        .map((lens, i) => verdict('f-0', lens, false, i < concurring ? 0.9 : 0.2));

      const judged = judge([finding({ id: 'f-0', severity: 'critical' })], votes, c);
      const expected = concurring >= needed[answered] ? 'critical' : 'major';
      assert.equal(
        judged[0].finding.severity,
        expected,
        `${concurring} concurrence(s) out of ${answered} answering should be ${expected}`
      );
      // Nothing here refutes, so survival is never in question — only volume is.
      assert.equal(judged[0].survived, true);
      assert.equal(judged[0].refuteVotes, 0);
    }
  }

  // A silent panel does not lower the bar: one voice is a second opinion, not
  // corroboration, however many skeptics were configured.
  const alone = judge(
    [finding({ id: 'f-0', severity: 'critical' })],
    [verdict('f-0', 'fact', false, 1)],
    c
  );
  assert.equal(alone[0].finding.severity, 'major');
});

test('a critical that survived by one vote is downgraded to major', async () => {
  const { judge } = await adversaryPromise;
  const f = finding({ id: 'f-0', severity: 'critical' });
  const c = cfg({ refuteThreshold: 2 });

  // threshold - 1 refutations: it lived, but it has no business shouting.
  const judged = judge(
    [f],
    [verdict('f-0', 'fact', true, 0.9), verdict('f-0', 'context', false, 0.9), verdict('f-0', 'impact', false, 0.9)],
    c
  );

  assert.equal(judged[0].survived, true);
  assert.equal(judged[0].refuteVotes, 1);
  assert.equal(judged[0].finding.severity, 'major');
  // The caller's own finding object is not rewritten under it.
  assert.equal(f.severity, 'critical');
});

test('a critical with too little concurrence is downgraded even at zero refutations', async () => {
  const { judge } = await adversaryPromise;
  const f = finding({ id: 'f-0', severity: 'critical' });
  const c = cfg({ refuteThreshold: 2 });

  // Only one skeptic actually engaged.
  const one = judge([f], [verdict('f-0', 'fact', false, 0.9)], c);
  assert.equal(one[0].survived, true);
  assert.equal(one[0].finding.severity, 'major');

  // Two answered, but both shrugged: a hedged non-refutal is not concurrence.
  const hedged = judge(
    [f],
    [verdict('f-0', 'fact', false, 0.2), verdict('f-0', 'context', false, 0.3)],
    c
  );
  assert.equal(hedged[0].finding.severity, 'major');
});

test('killed findings keep their severity and are returned alongside survivors', async () => {
  const { judge } = await adversaryPromise;
  const findings = [
    finding({ id: 'f-0', severity: 'critical' }),
    finding({ id: 'f-1', severity: 'minor' }),
  ];

  const judged = judge(
    findings,
    [verdict('f-0', 'fact', true), verdict('f-0', 'context', true)],
    cfg({ refuteThreshold: 2 })
  );

  assert.equal(judged.length, 2);
  assert.equal(judged[0].survived, false);
  assert.equal(judged[0].finding.severity, 'critical');
  assert.equal(judged[1].survived, true);
});

// ---------------------------------------------------------------------------
// dedupeFindings
// ---------------------------------------------------------------------------

test('dedupe merges the same defect seen by two lenses and keeps the higher severity', async () => {
  const { dedupeFindings } = await adversaryPromise;

  const a = finding({
    id: 'correctness-0',
    path: 'src/handler.ts',
    line: 12,
    severity: 'minor',
    category: 'bug',
    lens: 'correctness',
    failure: 'short',
  });
  const b = finding({
    id: 'security-1',
    path: 'src/handler.ts',
    line: 13,
    severity: 'critical',
    category: 'bug',
    lens: 'security',
    failure: 'a much more concrete failure description',
  });

  const { merged, mergedCount } = dedupeFindings([a, b]);

  assert.equal(mergedCount, 1);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'security-1');
  assert.equal(merged[0].severity, 'critical');
  assert.equal(merged[0].lens, 'security+correctness');
});

test('dedupe does not merge across categories, paths, or a gap wider than two lines', async () => {
  const { dedupeFindings } = await adversaryPromise;

  const base = { path: 'src/handler.ts', line: 12, category: 'bug' as const, lens: 'correctness' };

  // Same line, different category: the same code, two different problems.
  const categories = dedupeFindings([
    finding({ ...base, id: 'a', category: 'bug' }),
    finding({ ...base, id: 'b', category: 'security' }),
  ]);
  assert.equal(categories.mergedCount, 0);
  assert.equal(categories.merged.length, 2);

  const paths = dedupeFindings([
    finding({ ...base, id: 'a' }),
    finding({ ...base, id: 'b', path: 'src/other.ts' }),
  ]);
  assert.equal(paths.mergedCount, 0);

  const far = dedupeFindings([
    finding({ ...base, id: 'a', line: 12 }),
    finding({ ...base, id: 'b', line: 15 }),
  ]);
  assert.equal(far.mergedCount, 0);

  const near = dedupeFindings([
    finding({ ...base, id: 'a', line: 12 }),
    finding({ ...base, id: 'b', line: 14 }),
  ]);
  assert.equal(near.mergedCount, 1);
});

test('dedupe breaks a severity tie on the more concrete failure text', async () => {
  const { dedupeFindings } = await adversaryPromise;

  const { merged } = dedupeFindings([
    finding({ id: 'a', severity: 'major', failure: 'it breaks', lens: 'correctness' }),
    finding({
      id: 'b',
      line: 13,
      severity: 'major',
      failure: 'a POST with an empty body writes a row with a null tenant_id',
      lens: 'integration',
    }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'b');
  assert.equal(merged[0].lens, 'integration+correctness');
});

test('dedupe preserves the original order and reports the count over three lenses', async () => {
  const { dedupeFindings } = await adversaryPromise;

  const { merged, mergedCount } = dedupeFindings([
    finding({ id: 'a', path: 'src/handler.ts', line: 12, lens: 'correctness' }),
    finding({ id: 'b', path: 'src/queue.ts', line: 4, lens: 'performance', category: 'performance' }),
    finding({ id: 'c', path: 'src/handler.ts', line: 11, lens: 'integration' }),
    finding({ id: 'd', path: 'src/handler.ts', line: 13, lens: 'test', severity: 'minor' }),
  ]);

  assert.equal(mergedCount, 2);
  assert.deepEqual(
    merged.map((f) => f.path),
    ['src/handler.ts', 'src/queue.ts']
  );
  assert.equal(merged[0].lens, 'correctness+integration+test');
});

test('dedupe leaves a single finding untouched', async () => {
  const { dedupeFindings } = await adversaryPromise;
  const f = finding();
  const { merged, mergedCount } = dedupeFindings([f]);
  assert.equal(mergedCount, 0);
  assert.equal(merged[0], f);
  assert.equal(merged[0].lens, 'correctness');

  const empty = dedupeFindings([]);
  assert.deepEqual(empty.merged, []);
  assert.equal(empty.mergedCount, 0);
});

test('dedupe does not double-count a lens it has already absorbed', async () => {
  const { dedupeFindings } = await adversaryPromise;
  // Running the pipeline twice (round one, then round one plus completeness)
  // feeds already-merged findings back in.
  const { merged } = dedupeFindings([
    finding({ id: 'a', line: 12, lens: 'correctness+security' }),
    finding({ id: 'b', line: 12, lens: 'security' }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].lens, 'correctness+security');
});

// A guard on the one property the whole stage rests on: an unattacked finding is
// not the same thing as a verified one, and only the tally decides.
test('survival is decided by the tally alone, never by the finding itself', async () => {
  const { judge } = await adversaryPromise;
  const c = cfg({ refuteThreshold: 2 });

  for (const severity of ['critical', 'major', 'minor'] as const) {
    const f = finding({ id: 'f-0', severity });
    const killed = judge([f], [verdict('f-0', 'fact', true), verdict('f-0', 'impact', true)], c);
    assert.equal(killed[0].survived, false, `${severity} should not survive two refutations`);
  }
});

// Keeps the lens union honest: adding a fourth skeptic without a brief would
// otherwise fail at runtime rather than here.
test('every declared skeptic lens can build a call', async () => {
  const { buildSkepticCall, SKEPTIC_LENSES } = await adversaryPromise;
  const lenses: readonly SkepticLens[] = SKEPTIC_LENSES;
  for (const lens of lenses) {
    const call = buildSkepticCall(lens, [finding()], CTX);
    assert.ok(call.system.includes(`YOUR LENS: ${lens.toUpperCase()}`));
    assert.ok(call.user.length > 0);
  }
});
