/**
 * Integration tests for the five-stage pipeline.
 *
 * Every leaf module the pipeline calls has its own tests. What is only testable
 * here is the wiring, and the wiring is where a mistake is silent: nothing in
 * this module throws. A lens that failed, a finding anchored to a line the diff
 * does not contain, an id reused between rounds so one finding inherits
 * another's verdicts — each of those degrades the review while still producing a
 * review, which is the failure mode that reaches a human unnoticed.
 *
 * Two choices keep these tests honest:
 *
 *   - The diff is a real unified diff run through the real `parseUnifiedDiff`
 *     and `renderDiffForPrompt`. Anchoring is checked against line sets the
 *     parser actually produced, not against a hand-made `Set` that agrees with
 *     the test by construction.
 *   - The model is a fake that answers per call label. Nothing here touches the
 *     network, and every scripted answer is a shape a model could really return.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';

import { parseUnifiedDiff, renderDiffForPrompt } from './diff-parser.ts';
import { SKEPTIC_LENSES } from './adversary.ts';

import type { PipelineDeps } from './pipeline';
import type { LLMClient, LLMCallOptions } from './llm';
import type { ReviewerConfig } from './config';
import type { PRInfo } from './github';
import type { JudgedFinding } from './types';

// ---------------------------------------------------------------------------
// loading the module under test
// ---------------------------------------------------------------------------

/**
 * `pipeline.ts` cannot be imported as written under `node --test
 * --experimental-strip-types`, and that — not the difficulty of the module — is
 * why it had no tests. Two independent reasons:
 *
 *   1. `from './types'` carries no extension. Node's ESM resolver does no
 *      extension search, so the specifier does not resolve at all.
 *   2. `import { Finding } from './types'` is a *value* import of an interface.
 *      Type stripping leaves the binding in the import statement, and linking
 *      then fails with "does not provide an export named 'Finding'".
 *
 * Every other module in this repository already avoids both: `import type` for
 * types (`adversary.ts`, `lenses.ts`, `limits.ts`, `alternatives.ts`) and an
 * explicit `.ts` for genuine runtime imports (`llm.ts` -> `./json-repair.ts`).
 * Making `pipeline.ts` follow the same convention is a change to that file, so
 * this test rewrites the two import forms in memory instead of editing it.
 *
 * The rewrite is conditional and self-retiring: the moment the source uses
 * `import type` and `.ts` specifiers, nothing matches and the hook is a no-op.
 */
interface LoadResult {
  format?: string;
  source?: string | Uint8Array;
  shortCircuit?: boolean;
}

type RegisterHooks = (hooks: {
  load?: (
    url: string,
    context: unknown,
    nextLoad: (url: string, context: unknown) => LoadResult
  ) => LoadResult;
}) => void;

// `registerHooks` is newer than the pinned @types/node, so it is reached
// dynamically. Without it the import below fails loudly rather than silently
// testing nothing.
const registerHooks = (nodeModule as unknown as { registerHooks?: RegisterHooks }).registerHooks;

function rewriteImports(source: string): string {
  let n = 0;
  return source.replace(
    /import\s*\{([^}]*)\}\s*from\s*'(\.\/[^']+)';/g,
    (_match, names: string, specifier: string) => {
      const ns = `__iolite_test_ns_${n++}`;
      const withExtension = specifier.endsWith('.ts') ? specifier : `${specifier}.ts`;
      // A namespace import cannot fail the named-export check, and a binding
      // that was only ever a type comes out `undefined` — which is precisely
      // what the stripped code does with it: nothing.
      return `import * as ${ns} from '${withExtension}';\nconst { ${names.trim()} } = ${ns};`;
    }
  );
}

if (registerHooks) {
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.endsWith('/pipeline.ts') || result.source === undefined) return result;
      const source =
        typeof result.source === 'string'
          ? result.source
          : Buffer.from(result.source).toString('utf8');
      const rewritten = rewriteImports(source);
      return rewritten === source ? result : { ...result, source: rewritten };
    },
  });
}

// Loaded after the hook is registered, and awaited inside each test: the
// tsconfig targets CommonJS, which rules out top-level await.
const pipelinePromise = import('./pipeline.ts');

async function runPipeline(deps: PipelineDeps) {
  const mod = await pipelinePromise;
  return mod.runPipeline(deps);
}

// ---------------------------------------------------------------------------
// the diff under review
// ---------------------------------------------------------------------------

/**
 * A real unified diff. The line sets it produces are load-bearing for the
 * anchoring tests, so they are named here once:
 *
 *   src/auth.ts  reachable 10–20        added 13–17
 *   src/db.ts    reachable 40–44        added 41,42
 *   src/util.ts  reachable 3–6, 60–62   added 4, 62
 *
 * `src/util.ts` has two hunks and its second one ends on an added line, which is
 * what makes line 63 both unreachable and one line away from a real added line —
 * the near miss the snapping test needs.
 */
const DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index 1111111..2222222 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,7 +10,11 @@ export function authenticate(req) {',
  "   const token = req.headers.get('authorization');",
  '   if (!token) return null;',
  ' ',
  '-  const claims = decode(token);',
  '+  const claims = verify(token, SECRET);',
  '+  if (claims.exp < Date.now()) {',
  '+    return null;',
  '+  }',
  '+',
  '   return claims;',
  ' }',
  ' ',
  'diff --git a/src/db.ts b/src/db.ts',
  'index 3333333..4444444 100644',
  '--- a/src/db.ts',
  '+++ b/src/db.ts',
  '@@ -40,4 +40,5 @@ export async function findUser(name) {',
  '   const conn = await pool.connect();',
  "-  return conn.query('SELECT * FROM users WHERE name = $1', [name]);",
  '+  const sql = "SELECT * FROM users WHERE name = \'" + name + "\'";',
  '+  return conn.query(sql);',
  ' }',
  ' ',
  'diff --git a/src/util.ts b/src/util.ts',
  'index 5555555..6666666 100644',
  '--- a/src/util.ts',
  '+++ b/src/util.ts',
  '@@ -3,3 +3,4 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' const c = 3;',
  ' const d = 4;',
  '@@ -60,2 +60,3 @@',
  ' function tail() {',
  '   return 1;',
  '+  // trailing comment',
  '',
].join('\n');

const PARSED = parseUnifiedDiff(DIFF);
const RENDERED = renderDiffForPrompt(PARSED);

// The parse is an input to almost every assertion below, so it is checked once
// rather than assumed.
test('the test diff parses into the line sets the anchoring tests assume', () => {
  const auth = PARSED.files.get('src/auth.ts');
  const db = PARSED.files.get('src/db.ts');
  const util = PARSED.files.get('src/util.ts');
  assert.ok(auth && db && util);
  assert.deepEqual([...auth.addedLines].sort((a, b) => a - b), [13, 14, 15, 16, 17]);
  assert.deepEqual([...db.addedLines].sort((a, b) => a - b), [41, 42]);
  assert.deepEqual([...util.addedLines].sort((a, b) => a - b), [4, 62]);
  assert.equal(util.reachableLines.has(63), false);
  assert.equal(RENDERED.truncated, false);
});

// ---------------------------------------------------------------------------
// the fake model
// ---------------------------------------------------------------------------

type Reply =
  | Record<string, unknown>
  | null
  | ((call: LLMCallOptions) => Record<string, unknown> | null);

/** label -> reply. `skeptic:*` answers every skeptic lens. */
type Script = Record<string, Reply>;

/**
 * Stands in for `LLMClient` with exactly the surface `pipeline.ts` uses.
 *
 * The budget is modelled the way the real client models it: a slot is spent per
 * logical call, and a call made with no budget left comes back `null` rather
 * than throwing — that is what makes budget exhaustion a quiet degradation
 * instead of a crash.
 */
class FakeLLM {
  /** Every call handed to the client, funded or not, in order. */
  readonly requested: LLMCallOptions[] = [];
  private readonly script: Script;
  private readonly maxCalls: number;
  private used = 0;

  constructor(script: Script, maxCalls = 32) {
    this.script = script;
    this.maxCalls = maxCalls;
  }

  callsMade(): number {
    return this.used;
  }

  callsRemaining(): number {
    return Math.max(0, this.maxCalls - this.used);
  }

  budgetExhausted(): boolean {
    return this.callsRemaining() <= 0;
  }

  async generateJson<T>(call: LLMCallOptions): Promise<T | null> {
    this.requested.push(call);
    if (this.budgetExhausted()) return null;
    this.used += 1;
    return this.reply(call) as T | null;
  }

  async generateJsonAll<T>(calls: LLMCallOptions[]): Promise<(T | null)[]> {
    const out: (T | null)[] = [];
    for (const call of calls) out.push(await this.generateJson<T>(call));
    return out;
  }

  labels(): string[] {
    return this.requested.map((c) => c.label);
  }

  callFor(label: string): LLMCallOptions | undefined {
    return this.requested.find((c) => c.label === label);
  }

  private reply(call: LLMCallOptions): Record<string, unknown> | null {
    let entry: Reply | undefined;
    if (Object.prototype.hasOwnProperty.call(this.script, call.label)) {
      entry = this.script[call.label];
    } else if (call.label.startsWith('skeptic:')) {
      entry = this.script['skeptic:*'];
    }
    // An unscripted call is a call that produced nothing usable, which is how
    // the real client reports every failure.
    if (entry === undefined || entry === null) return null;
    return typeof entry === 'function' ? entry(call) : entry;
  }
}

/** `LLMClient` has private fields, so a structural stand-in needs the cast. */
function asClient(fake: FakeLLM): LLMClient {
  return fake as unknown as LLMClient;
}

// ---------------------------------------------------------------------------
// reading the findings back out of a skeptic prompt
// ---------------------------------------------------------------------------

/** Index of the bracket/brace closing the one at `start`, skipping strings. */
function matchingBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The findings as the skeptic was shown them, ids included.
 *
 * Scripting verdicts from the prompt instead of from a guessed id scheme is the
 * point: the test says "refute the finding that claims X" and the pipeline's own
 * ids decide where that vote lands. If two findings shared an id, the vote would
 * land in the wrong place and the assertions would notice.
 */
function findingsShownTo(call: LLMCallOptions): Array<Record<string, unknown>> {
  const text = call.user;
  for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i + 1)) {
    const end = matchingBracket(text, i);
    if (end < 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(text.slice(i, end + 1));
    } catch {
      continue;
    }
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((v) => !!v && typeof v === 'object' && typeof (v as any).id === 'string')
    ) {
      return value as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/** A skeptic that attacks every finding and fails to break any of them. */
function concurs(call: LLMCallOptions): Record<string, unknown> {
  return {
    verdicts: findingsShownTo(call).map((f) => ({
      id: f.id,
      refuted: false,
      confidence: 0.9,
      reason: 'the quoted line is present and the guard is not',
    })),
  };
}

/** A skeptic that refutes exactly the findings matching `pick`. */
function refutes(pick: (f: Record<string, unknown>) => boolean) {
  return (call: LLMCallOptions): Record<string, unknown> => ({
    verdicts: findingsShownTo(call).map((f) => ({
      id: f.id,
      refuted: pick(f),
      confidence: 0.9,
      reason: pick(f) ? 'the diff does not say this' : 'stands up',
    })),
  });
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const BASE_CFG: ReviewerConfig = {
  projectName: 'iolite',
  promptInline: '',
  promptFileRel: '',
  includePaths: [],
  excludePaths: [],
  reviewSelf: false,
  lenses: ['correctness', 'security'],
  adversarialRounds: 2,
  refuteThreshold: 2,
  completenessPass: true,
  exploreAlternatives: true,
  maxLlmCalls: 16,
  maxCommentsPerFile: 10,
  maxCommentsTotal: 40,
  maxCommentBodyChars: 700,
};

const PR: PRInfo = {
  number: 41,
  title: 'Verify tokens instead of decoding them',
  body: 'closes #7',
  headBranch: 'harden-auth',
  baseBranch: 'main',
  headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  baseSha: '0000000000000000000000000000000000000000',
  commits: 3,
  additions: 9,
  deletions: 2,
  changedFiles: 3,
  author: 'contributor',
  draft: false,
};

/** One finding as a model would emit it, before the pipeline touches it. */
function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'src/auth.ts',
    line: 14,
    severity: 'major',
    category: 'bug',
    claim: 'expiry is compared against the wrong clock',
    evidence: 'claims.exp < Date.now()',
    failure: 'a token whose exp is in seconds is treated as expired for the next 50 years',
    fix: 'compare in the same unit',
    ...over,
  };
}

function harness(script: Script, over: Partial<ReviewerConfig> = {}, maxCalls = 32) {
  const llm = new FakeLLM(script, maxCalls);
  const deps: PipelineDeps = {
    llm: asClient(llm),
    cfg: { ...BASE_CFG, ...over },
    parsed: PARSED,
    rendered: RENDERED,
    prInfo: PR,
    issueInfo: null,
    policy: '',
    selfReview: false,
  };
  return { llm, deps };
}

function claims(judged: JudgedFinding[]): string[] {
  return judged.map((j) => j.finding.claim);
}

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test('findings that survive every skeptic come back with the stats to match', async () => {
  const { llm, deps } = harness({
    'lens:correctness': { findings: [raw({ claim: 'CLAIM-EXPIRY' })] },
    'lens:security': {
      findings: [raw({ path: 'src/db.ts', line: 41, category: 'security', claim: 'CLAIM-SQLI' })],
    },
    'lens:completeness': { findings: [] },
    'skeptic:*': concurs,
    alternatives: { alternatives: [], summary: 'Two real defects, both worth fixing.', risk_level: 'medium' },
  });

  const result = await runPipeline(deps);

  assert.deepEqual(claims(result.survived).sort(), ['CLAIM-EXPIRY', 'CLAIM-SQLI']);
  assert.equal(result.killed.length, 0);

  const s = result.stats;
  assert.equal(s.rawFindings, 2);
  assert.equal(s.survived, 2);
  assert.equal(s.refuted, 0);
  assert.equal(s.anchorDropped, 0);
  assert.equal(s.duplicatesMerged, 0);
  assert.deepEqual(s.lensesRun, ['correctness', 'security']);
  assert.deepEqual(s.lensesFailed, []);
  assert.equal(s.budgetExhausted, false);
  assert.equal(s.diffTruncated, false);
  assert.deepEqual(s.truncatedFiles, []);
  // Nothing was dropped or merged, so every candidate is accounted for.
  assert.equal(s.rawFindings, s.survived + s.refuted + s.anchorDropped + s.duplicatesMerged);

  // 2 lenses + completeness + 2 skeptics + alternatives.
  assert.equal(s.llmCalls, 6);
  assert.deepEqual(llm.labels(), [
    'lens:correctness',
    'lens:security',
    'lens:completeness',
    `skeptic:${SKEPTIC_LENSES[0]}`,
    `skeptic:${SKEPTIC_LENSES[1]}`,
    'alternatives',
  ]);

  assert.equal(result.summary.summary, 'Two real defects, both worth fixing.');
  // Two survivors, both major: the model's "medium" is not contradicted.
  assert.equal(result.summary.riskLevel, 'medium');

  // Every survivor carries the votes that saved it.
  for (const j of result.survived) {
    assert.equal(j.verdicts.length, 2);
    assert.equal(j.refuteVotes, 0);
  }
});

test('the render stats are carried through to the caller', async () => {
  const truncated = renderDiffForPrompt(PARSED, 400);
  const { deps } = harness({
    'lens:correctness': { findings: [] },
    'lens:security': { findings: [] },
    'lens:completeness': { findings: [] },
    alternatives: { alternatives: [], summary: 'nothing to report' },
  });
  deps.rendered = truncated;

  const result = await runPipeline(deps);
  assert.equal(result.stats.diffTruncated, true);
  assert.deepEqual(result.stats.truncatedFiles, ['src/auth.ts']);
});

// ---------------------------------------------------------------------------
// anchoring
// ---------------------------------------------------------------------------

test('a finding on a line the diff does not contain is dropped and counted', async () => {
  const { deps } = harness({
    'lens:correctness': {
      findings: [
        raw({ claim: 'ANCHORED', line: 14 }),
        raw({ claim: 'FAR-AWAY', line: 900 }),
        raw({ claim: 'WRONG-FILE', path: 'src/ghost.ts', line: 3 }),
      ],
    },
    'lens:security': { findings: [] },
    'lens:completeness': { findings: [] },
    'skeptic:*': concurs,
    alternatives: { alternatives: [], summary: 'one real finding' },
  });

  const result = await runPipeline(deps);

  assert.deepEqual(claims(result.survived), ['ANCHORED']);
  assert.equal(result.stats.rawFindings, 3);
  assert.equal(result.stats.anchorDropped, 2);
  assert.equal(result.stats.survived, 1);
  // A dropped finding is not a refuted one: nobody voted on it.
  assert.equal(result.stats.refuted, 0);
});

test('a finding one or two lines off a real added line is snapped, not dropped', async () => {
  const { deps } = harness({
    'lens:correctness': {
      findings: [
        // 63 and 64 are unreachable; 62 is the added line they are near.
        raw({ claim: 'OFF-BY-ONE', path: 'src/util.ts', line: 63, category: 'performance' }),
        raw({ claim: 'OFF-BY-TWO', path: 'src/util.ts', line: 64, category: 'design' }),
      ],
    },
    'lens:security': { findings: [] },
    'lens:completeness': { findings: [] },
    'skeptic:*': concurs,
    alternatives: { alternatives: [], summary: 'near misses' },
  });

  const result = await runPipeline(deps);

  assert.equal(result.stats.anchorDropped, 0);
  const byClaim = new Map(result.survived.map((j) => [j.finding.claim, j.finding.line]));
  assert.equal(byClaim.get('OFF-BY-ONE'), 62);
  assert.equal(byClaim.get('OFF-BY-TWO'), 62);
  // 62 is a line the parser really produced, not a number the test invented.
  assert.equal(PARSED.files.get('src/util.ts')?.addedLines.has(62), true);
});

// ---------------------------------------------------------------------------
// partial failure
// ---------------------------------------------------------------------------

test('a lens that returns nothing usable is recorded and the others still count', async () => {
  const { deps } = harness(
    {
      'lens:correctness': null,
      'lens:security': {
        findings: [raw({ path: 'src/db.ts', line: 41, category: 'security', claim: 'FROM-SECURITY' })],
      },
      'lens:performance': {
        findings: [raw({ path: 'src/util.ts', line: 4, category: 'performance', claim: 'FROM-PERF' })],
      },
      'lens:completeness': { findings: [] },
      'skeptic:*': concurs,
      alternatives: { alternatives: [], summary: 'two lenses reported' },
    },
    { lenses: ['correctness', 'security', 'performance'] }
  );

  const result = await runPipeline(deps);

  assert.deepEqual(result.stats.lensesFailed, ['correctness']);
  assert.deepEqual(result.stats.lensesRun, ['security', 'performance']);
  assert.deepEqual(claims(result.survived).sort(), ['FROM-PERF', 'FROM-SECURITY']);
  assert.equal(result.stats.rawFindings, 2);
});

test('every lens failing still produces a result, and it says so', async () => {
  const { llm, deps } = harness({
    'lens:correctness': null,
    'lens:security': null,
    'lens:completeness': null,
    alternatives: null,
  });

  const result = await runPipeline(deps);

  assert.deepEqual(result.stats.lensesRun, []);
  assert.deepEqual(result.stats.lensesFailed, ['correctness', 'security']);
  assert.equal(result.stats.rawFindings, 0);
  assert.equal(result.survived.length, 0);
  assert.equal(result.killed.length, 0);
  assert.deepEqual(result.alternatives, []);
  // No findings means nothing for a skeptic to attack.
  assert.equal(llm.labels().some((l) => l.startsWith('skeptic:')), false);
  // The summary is the pipeline's own, and it does not claim the diff is clean
  // on the strength of a total model failure.
  assert.ok(result.summary.summary.includes(PR.title), result.summary.summary);
  assert.ok(result.summary.summary.includes('No findings survived'), result.summary.summary);
  assert.equal(result.summary.riskLevel, 'low');
});

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

test('two lenses reporting one defect are merged into one finding', async () => {
  const { deps } = harness({
    'lens:correctness': {
      findings: [raw({ path: 'src/db.ts', line: 41, category: 'security', claim: 'FROM-CORRECTNESS' })],
    },
    'lens:security': {
      findings: [
        raw({
          path: 'src/db.ts',
          line: 42,
          category: 'security',
          severity: 'critical',
          claim: 'FROM-SECURITY',
          failure: 'a crafted name ends the string literal and appends a second statement',
        }),
      ],
    },
    'lens:completeness': { findings: [] },
    'skeptic:*': concurs,
    alternatives: { alternatives: [], summary: 'one defect, seen twice' },
  });

  const result = await runPipeline(deps);

  assert.equal(result.stats.rawFindings, 2);
  assert.equal(result.stats.duplicatesMerged, 1);
  assert.equal(result.survived.length, 1);
  // The overlap is kept as evidence: the survivor names both lenses.
  const lens = result.survived[0]!.finding.lens;
  assert.ok(lens.includes('security') && lens.includes('correctness'), lens);
});

// ---------------------------------------------------------------------------
// ids across rounds
// ---------------------------------------------------------------------------

test('completeness findings cannot inherit round-one verdicts', async () => {
  // Round one produces two findings; the completeness pass produces two more.
  // A naive re-key would number each round from zero and hand the second round
  // the same ids as the first, which would route these refutations onto the
  // wrong findings.
  const { llm, deps } = harness({
    'lens:correctness': {
      findings: [
        raw({ claim: 'ROUND1-A', path: 'src/auth.ts', line: 14 }),
        raw({ claim: 'ROUND1-B', path: 'src/db.ts', line: 41, category: 'security' }),
      ],
    },
    'lens:security': { findings: [] },
    'lens:completeness': {
      findings: [
        raw({ claim: 'PASS2-A', path: 'src/util.ts', line: 4, category: 'performance' }),
        raw({ claim: 'PASS2-B', path: 'src/util.ts', line: 62, category: 'design' }),
      ],
    },
    'skeptic:*': refutes((f) => String(f.claim).startsWith('PASS2')),
    alternatives: { alternatives: [], summary: 'round one held up' },
  });

  const result = await runPipeline(deps);

  // What the skeptics were shown: four findings, four distinct ids.
  const shown = findingsShownTo(llm.callFor(`skeptic:${SKEPTIC_LENSES[0]}`)!);
  assert.equal(shown.length, 4);
  assert.equal(new Set(shown.map((f) => f.id)).size, 4);

  // And the votes landed where they were aimed.
  assert.deepEqual(claims(result.survived).sort(), ['ROUND1-A', 'ROUND1-B']);
  assert.deepEqual(claims(result.killed).sort(), ['PASS2-A', 'PASS2-B']);
  assert.equal(result.stats.survived, 2);
  assert.equal(result.stats.refuted, 2);
  for (const j of result.survived) assert.equal(j.refuteVotes, 0);
  for (const j of result.killed) assert.equal(j.refuteVotes, 2);
});

test('ids handed to the skeptics are unique even when both rounds are crowded', async () => {
  const { llm, deps } = harness({
    'lens:correctness': {
      findings: [
        raw({ claim: 'R1-0', path: 'src/auth.ts', line: 13 }),
        raw({ claim: 'R1-1', path: 'src/auth.ts', line: 18, category: 'design' }),
        raw({ claim: 'R1-2', path: 'src/db.ts', line: 41, category: 'security' }),
      ],
    },
    'lens:security': { findings: [] },
    'lens:completeness': {
      findings: [
        raw({ claim: 'C2-0', path: 'src/util.ts', line: 4, category: 'performance' }),
        raw({ claim: 'C2-1', path: 'src/util.ts', line: 62, category: 'test' }),
        raw({ claim: 'C2-2', path: 'src/db.ts', line: 44, category: 'design' }),
      ],
    },
    'skeptic:*': concurs,
    alternatives: { alternatives: [], summary: 'six findings' },
  });

  const result = await runPipeline(deps);

  const ids = result.survived.concat(result.killed).map((j) => j.finding.id);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6);
  const shown = findingsShownTo(llm.callFor(`skeptic:${SKEPTIC_LENSES[1]}`)!);
  assert.deepEqual(
    shown.map((f) => f.id),
    ids
  );
});

// ---------------------------------------------------------------------------
// stages that can be switched off
// ---------------------------------------------------------------------------

test('completeness_pass: false skips the call entirely', async () => {
  const { llm, deps } = harness(
    {
      'lens:correctness': { findings: [raw({ claim: 'ONLY-ROUND-ONE' })] },
      'lens:security': { findings: [] },
      'lens:completeness': { findings: [raw({ claim: 'MUST-NOT-APPEAR', line: 16 })] },
      'skeptic:*': concurs,
      alternatives: { alternatives: [], summary: 'round one only' },
    },
    { completenessPass: false }
  );

  const result = await runPipeline(deps);

  assert.equal(llm.labels().includes('lens:completeness'), false);
  assert.deepEqual(claims(result.survived), ['ONLY-ROUND-ONE']);
  assert.equal(result.stats.rawFindings, 1);
  // 2 lenses + 2 skeptics + alternatives, and no completeness call.
  assert.equal(result.stats.llmCalls, 5);
});

test('no findings means no skeptic calls, and that is not a failure', async () => {
  const { llm, deps } = harness({
    'lens:correctness': { findings: [] },
    'lens:security': { findings: [] },
    'lens:completeness': { findings: [] },
    alternatives: { alternatives: [], summary: 'nothing to attack', risk_level: 'low' },
  });

  const result = await runPipeline(deps);

  assert.equal(llm.labels().some((l) => l.startsWith('skeptic:')), false);
  // Every lens answered; none of them failed.
  assert.deepEqual(result.stats.lensesRun, ['correctness', 'security']);
  assert.deepEqual(result.stats.lensesFailed, []);
  assert.equal(result.stats.survived, 0);
  assert.equal(result.stats.refuted, 0);
  // The design question is still asked.
  assert.ok(llm.labels().includes('alternatives'));
  assert.equal(result.summary.summary, 'nothing to attack');
});

test('adversarial_rounds: 0 lets everything through with no verdicts', async () => {
  const { llm, deps } = harness(
    {
      'lens:correctness': {
        findings: [
          raw({ claim: 'KEPT-A' }),
          raw({ claim: 'KEPT-B', path: 'src/db.ts', line: 41, category: 'security' }),
        ],
      },
      'lens:security': { findings: [] },
      'lens:completeness': { findings: [] },
      'skeptic:*': refutes(() => true),
      alternatives: { alternatives: [], summary: 'no adversary configured' },
    },
    { adversarialRounds: 0, refuteThreshold: 0 }
  );

  const result = await runPipeline(deps);

  assert.equal(llm.labels().some((l) => l.startsWith('skeptic:')), false);
  assert.deepEqual(claims(result.survived).sort(), ['KEPT-A', 'KEPT-B']);
  assert.equal(result.killed.length, 0);
  assert.equal(result.stats.refuted, 0);
  for (const j of result.survived) {
    assert.deepEqual(j.verdicts, []);
    assert.equal(j.refuteVotes, 0);
  }
});

// ---------------------------------------------------------------------------
// risk is derived, not accepted
// ---------------------------------------------------------------------------

test('a surviving critical overrides a model that claimed low risk', async () => {
  const { deps } = harness({
    'lens:correctness': {
      findings: [
        raw({
          claim: 'SQLI',
          path: 'src/db.ts',
          line: 41,
          category: 'security',
          severity: 'critical',
        }),
      ],
    },
    'lens:security': { findings: [] },
    'lens:completeness': { findings: [] },
    // Two clean concurrences: the critical is earned twice and stays critical.
    'skeptic:*': concurs,
    alternatives: { alternatives: [], summary: 'reads fine to me', risk_level: 'low' },
  });

  const result = await runPipeline(deps);

  assert.equal(result.survived.length, 1);
  assert.equal(result.survived[0]!.finding.severity, 'critical');
  assert.equal(result.summary.riskLevel, 'high');
});

test('three surviving majors are high risk however low the model called it', async () => {
  const { deps } = harness({
    'lens:correctness': {
      findings: [
        raw({ claim: 'M1', path: 'src/auth.ts', line: 14 }),
        raw({ claim: 'M2', path: 'src/db.ts', line: 41, category: 'security' }),
        raw({ claim: 'M3', path: 'src/util.ts', line: 4, category: 'performance' }),
      ],
    },
    'lens:security': { findings: [] },
    'lens:completeness': { findings: [] },
    'skeptic:*': concurs,
    alternatives: { alternatives: [], summary: 'small change', risk_level: 'low' },
  });

  const result = await runPipeline(deps);

  assert.equal(result.survived.length, 3);
  assert.ok(result.survived.every((j) => j.finding.severity === 'major'));
  assert.equal(result.summary.riskLevel, 'high');
});

test('one surviving major is medium risk, not the low the model claimed', async () => {
  const { deps } = harness({
    'lens:correctness': { findings: [raw({ claim: 'M1' })] },
    'lens:security': { findings: [] },
    'lens:completeness': { findings: [] },
    'skeptic:*': concurs,
    alternatives: { alternatives: [], summary: 'small change', risk_level: 'low' },
  });

  const result = await runPipeline(deps);

  assert.equal(result.survived.length, 1);
  assert.equal(result.summary.riskLevel, 'medium');
});

test('with nothing surviving, the model\'s own risk level stands', async () => {
  const { deps } = harness({
    'lens:correctness': { findings: [] },
    'lens:security': { findings: [] },
    'lens:completeness': { findings: [] },
    alternatives: { alternatives: [], summary: 'large but mechanical', risk_level: 'medium' },
  });

  const result = await runPipeline(deps);
  assert.equal(result.survived.length, 0);
  assert.equal(result.summary.riskLevel, 'medium');
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

test('an exhausted budget is reported and the run still returns', async () => {
  // Two slots: the lens sweep spends both, and every later stage comes back
  // empty-handed rather than throwing.
  const { llm, deps } = harness(
    {
      'lens:correctness': { findings: [raw({ claim: 'FOUND-BEFORE-THE-CEILING' })] },
      'lens:security': { findings: [] },
      'lens:completeness': { findings: [raw({ claim: 'NEVER-ASKED', line: 16 })] },
      'skeptic:*': refutes(() => true),
      alternatives: { alternatives: [], summary: 'never delivered' },
    },
    {},
    2
  );

  const result = await runPipeline(deps);

  assert.equal(result.stats.budgetExhausted, true);
  assert.equal(result.stats.llmCalls, 2);
  // The completeness pass is not even attempted once the budget is gone.
  assert.equal(llm.labels().includes('lens:completeness'), false);
  // The skeptic and alternatives calls were attempted and came back unfunded.
  assert.ok(llm.labels().some((l) => l.startsWith('skeptic:')));
  assert.ok(llm.labels().includes('alternatives'));

  assert.deepEqual(claims(result.survived), ['FOUND-BEFORE-THE-CEILING']);
  // No verdicts arrived, so nothing was refuted by silence.
  assert.equal(result.stats.refuted, 0);
  assert.deepEqual(result.survived[0]!.verdicts, []);
  assert.ok(result.summary.summary.includes(PR.title), result.summary.summary);
});

// ---------------------------------------------------------------------------
// the summary
// ---------------------------------------------------------------------------

test('the summary and alternatives come from the alternatives call', async () => {
  const { deps } = harness({
    'lens:correctness': { findings: [] },
    'lens:security': { findings: [] },
    'lens:completeness': { findings: [] },
    alternatives: {
      alternatives: [
        {
          title: 'Verify at the edge',
          rationale: 'the middleware already parses the header',
          tradeoff: 'one more hop for handlers that do not need claims',
          sketch: 'app.use(verifyToken)',
          strength: 'worth_considering',
        },
      ],
      summary: '  Replaces decode with verify.  ',
      risk_level: 'high',
    },
  });

  const result = await runPipeline(deps);

  // Trimmed, and used instead of the generated fallback.
  assert.equal(result.summary.summary, 'Replaces decode with verify.');
  assert.equal(result.summary.riskLevel, 'high');
  assert.equal(result.alternatives.length, 1);
  assert.equal(result.alternatives[0]!.title, 'Verify at the edge');
});

test('a blank summary falls back to one built from the pull request', async () => {
  const { deps } = harness({
    'lens:correctness': { findings: [raw({ claim: 'STILL-HERE' })] },
    'lens:security': { findings: [] },
    'lens:completeness': { findings: [] },
    'skeptic:*': concurs,
    alternatives: { alternatives: [], summary: '   ', risk_level: 'low' },
  });

  const result = await runPipeline(deps);

  assert.ok(result.summary.summary.includes(PR.title), result.summary.summary);
  assert.ok(result.summary.summary.includes('+9 -2 across 3 file(s)'), result.summary.summary);
  assert.ok(result.summary.summary.includes('1 finding(s) survived'), result.summary.summary);
});

test('a missing summary field falls back too', async () => {
  const { deps } = harness({
    'lens:correctness': { findings: [] },
    'lens:security': { findings: [] },
    'lens:completeness': { findings: [] },
    alternatives: { alternatives: [] },
  });

  const result = await runPipeline(deps);
  assert.ok(result.summary.summary.includes(PR.title), result.summary.summary);
  assert.ok(result.summary.summary.includes('No findings survived'), result.summary.summary);
});

// ---------------------------------------------------------------------------
// the configured round count is a request, not an outcome
// ---------------------------------------------------------------------------

test('asking for more skeptics than there are lenses does not disable the adversary', async () => {
  // The bug this pins: `adversarialRounds` above the lens count used to leave
  // the threshold clamped against the REQUEST (8) while only five skeptics ran.
  // Five verdicts can never reach eight, so nothing could ever be refuted —
  // asking for more scrutiny silently bought none at all.
  const { llm, deps } = harness(
    {
      'lens:correctness': { findings: [raw({ claim: 'DOOMED' })] },
      'lens:security': { findings: [] },
      'lens:completeness': { findings: [] },
      'skeptic:*': refutes(() => true),
      alternatives: { alternatives: [] },
    },
    { adversarialRounds: 8, refuteThreshold: 8 }
  );

  const result = await runPipeline(deps);

  const skepticCalls = llm.requested.filter((c) => c.label.startsWith('skeptic:'));
  assert.equal(skepticCalls.length, SKEPTIC_LENSES.length, 'capped at the number of lenses');
  assert.equal(result.stats.effectiveThreshold, SKEPTIC_LENSES.length);
  assert.deepEqual(claims(result.survived), [], 'a unanimously refuted finding must die');
  assert.deepEqual(claims(result.killed), ['DOOMED']);
});

test('the threshold is clamped to the skeptics that can actually run', async () => {
  // Same shape, one refutation short of unanimity: with the threshold correctly
  // clamped to 5 this survives, which proves the clamp lands on the lens count
  // rather than silently dropping to something lower.
  const target = (f: Record<string, unknown>) => f.claim === 'CONTESTED';
  const { deps } = harness(
    {
      'lens:correctness': { findings: [raw({ claim: 'CONTESTED' })] },
      'lens:security': { findings: [] },
      'lens:completeness': { findings: [] },
      'skeptic:fact': concurs,
      'skeptic:context': refutes(target),
      'skeptic:impact': refutes(target),
      'skeptic:reachability': refutes(target),
      'skeptic:precedent': refutes(target),
      alternatives: { alternatives: [] },
    },
    { adversarialRounds: 99, refuteThreshold: 99 }
  );

  const result = await runPipeline(deps);
  assert.equal(result.stats.effectiveThreshold, 5);
  assert.deepEqual(claims(result.killed), [], 'four of five refutations is below a threshold of 5');
  assert.deepEqual(claims(result.survived), ['CONTESTED']);
});

test('stats record the skeptics that answered, not the ones that were asked for', async () => {
  const { deps } = harness(
    {
      'lens:correctness': { findings: [raw({ claim: 'X' })] },
      'lens:security': { findings: [] },
      'lens:completeness': { findings: [] },
      'skeptic:fact': concurs,
      'skeptic:context': null,
      'skeptic:impact': concurs,
      alternatives: { alternatives: [] },
    },
    { adversarialRounds: 3, refuteThreshold: 2 }
  );

  const result = await runPipeline(deps);

  assert.deepEqual(result.stats.skepticsRun, ['fact', 'impact']);
  assert.deepEqual(result.stats.skepticsFailed, ['context']);
  assert.equal(result.stats.effectiveThreshold, 2);
});
