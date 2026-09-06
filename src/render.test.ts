/**
 * Tests for the render stage — the last thing that runs before a human reads
 * the review.
 *
 * Nothing here throws either, so every mistake in this module ships as a review
 * that looks finished. The properties worth pinning are the ones that decide
 * whether the review is honest about itself:
 *
 *   - "no findings" and "findings, all of them refuted" are different outcomes
 *     and must not read the same.
 *   - A review that skipped half the diff, lost a lens, ran out of budget, or
 *     dropped comments to stay under a cap has to say so. Silence there reads as
 *     a clean bill of health.
 *   - Comments come back in document order, whatever order severity selection
 *     put them in internally.
 *   - Model-written text lands inside markdown and inside an HTML comment's
 *     neighbourhood. It must not be able to break either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';

import { buildReviewMarker, hasReviewedSha } from './dedupe.ts';

import type { ReviewerConfig } from './config';
import type { Finding, JudgedFinding, PipelineResult, PipelineStats, Verdict } from './types';

// ---------------------------------------------------------------------------
// loading the module under test
// ---------------------------------------------------------------------------

/**
 * `render.ts` cannot be imported as written under `node --test
 * --experimental-strip-types`, and that — not the difficulty of the module — is
 * why it had no tests. Two independent reasons:
 *
 *   1. `from './types'` carries no extension. Node's ESM resolver does no
 *      extension search, so the specifier does not resolve at all.
 *   2. `import { PipelineResult } from './types'` is a *value* import of an
 *      interface. Type stripping leaves the binding in the import statement,
 *      and linking then fails with "does not provide an export named
 *      'PipelineResult'".
 *
 * Every other module in this repository already avoids both: `import type` for
 * types (`adversary.ts`, `lenses.ts`, `limits.ts`, `alternatives.ts`) and an
 * explicit `.ts` for genuine runtime imports (`llm.ts` -> `./json-repair.ts`).
 * Making `render.ts` follow the same convention is a change to that file, so
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
      if (!url.endsWith('/render.ts') || result.source === undefined) return result;
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
const renderPromise = import('./render.ts');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const MARKER = buildReviewMarker(HEAD_SHA);
const MODEL = 'claude-test-model';

const BASE_CFG: ReviewerConfig = {
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
  // Generous on purpose: the tests that care about clamping set their own.
  maxCommentBodyChars: 4000,
};

function cfg(over: Partial<ReviewerConfig> = {}): ReviewerConfig {
  return { ...BASE_CFG, ...over };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f-0',
    path: 'src/auth.ts',
    line: 14,
    severity: 'major',
    category: 'bug',
    claim: 'the expiry check compares seconds against milliseconds',
    evidence: 'claims.exp < Date.now()',
    failure: 'every token minted with a seconds-based exp is rejected as expired',
    fix: 'multiply exp by 1000, or compare in seconds',
    lens: 'correctness',
    ...over,
  };
}

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    id: 'f-0',
    refuted: false,
    confidence: 0.9,
    reason: 'the guard the finding asks for is genuinely absent',
    skeptic: 'fact',
    ...over,
  };
}

function judged(f: Finding, verdicts: Verdict[] = [], survived = true): JudgedFinding {
  return {
    finding: f,
    verdicts,
    refuteVotes: verdicts.filter((v) => v.refuted).length,
    survived,
  };
}

function stats(over: Partial<PipelineStats> = {}): PipelineStats {
  return {
    llmCalls: 6,
    lensesRun: ['correctness', 'security'],
    lensesFailed: [],
    failedStages: [],
    rawFindings: 0,
    anchorDropped: 0,
    duplicatesMerged: 0,
    refuted: 0,
    survived: 0,
    diffTruncated: false,
    truncatedFiles: [],
    budgetExhausted: false,
    skepticsRun: ['fact', 'context', 'impact'],
    skepticsFailed: [],
    effectiveThreshold: 2,
    ...over,
  };
}

function result(over: Partial<PipelineResult> = {}): PipelineResult {
  return {
    summary: { summary: 'Replaces decode with verify.', riskLevel: 'medium' },
    survived: [],
    killed: [],
    alternatives: [],
    stats: stats(),
    ...over,
  };
}

async function render(r: PipelineResult, c: ReviewerConfig = cfg()) {
  const mod = await renderPromise;
  return mod.renderReview(r, c, HEAD_SHA, MODEL);
}

function anchors(comments: Array<{ path: string; line: number }>): string[] {
  return comments.map((c) => `${c.path}:${c.line}`);
}

// ---------------------------------------------------------------------------
// the body: summary, risk, marker
// ---------------------------------------------------------------------------

test('the body carries the summary, the risk badge and the dedupe marker', async () => {
  const r = await render(
    result({
      summary: { summary: 'SUMMARY-SENTINEL: rewrites token verification.', riskLevel: 'medium' },
      survived: [judged(finding(), [verdict()])],
      stats: stats({ rawFindings: 1, survived: 1 }),
    })
  );

  assert.ok(r.body.startsWith('## iolite review'), r.body.slice(0, 40));
  assert.ok(r.body.includes('SUMMARY-SENTINEL: rewrites token verification.'));
  assert.ok(r.body.includes('**Risk:** 🟡 medium'), r.body);
  assert.ok(r.body.trimEnd().endsWith(MARKER), r.body.slice(-120));
  // The marker is the one thing a later run reads back.
  assert.equal(hasReviewedSha([r.body], HEAD_SHA), true);
});

test('each risk level gets its own badge', async () => {
  const badges: Array<[PipelineResult['summary']['riskLevel'], string]> = [
    ['low', '**Risk:** 🟢 low'],
    ['medium', '**Risk:** 🟡 medium'],
    ['high', '**Risk:** 🔴 high'],
  ];
  for (const [level, badge] of badges) {
    const r = await render(result({ summary: { summary: 'x', riskLevel: level } }));
    assert.ok(r.body.includes(badge), `${level}: ${r.body}`);
  }
});

test('alternatives are rendered into the body, and omitted when there are none', async () => {
  const withAlts = await render(
    result({
      alternatives: [
        {
          title: 'Verify in the middleware',
          rationale: 'the header is already parsed there',
          tradeoff: 'handlers that never read claims pay for the verification',
          sketch: 'app.use(verifyToken)',
          strength: 'strong',
        },
      ],
    })
  );
  assert.ok(withAlts.body.includes('### Alternative approaches'));
  assert.ok(withAlts.body.includes('Verify in the middleware'));

  const without = await render(result());
  assert.equal(without.body.includes('### Alternative approaches'), false);
});

// ---------------------------------------------------------------------------
// nothing survived: two different states, two different sentences
// ---------------------------------------------------------------------------

test('candidates that were all refuted read differently from no candidates at all', async () => {
  const refutedAll = await render(
    result({
      killed: [judged(finding(), [verdict({ refuted: true })], false)],
      stats: stats({ rawFindings: 6, refuted: 6 }),
    })
  );
  assert.ok(
    refutedAll.body.includes('No findings survived adversarial verification. 6 candidate(s) were raised'),
    refutedAll.body
  );
  assert.ok(refutedAll.body.includes('all of them were refuted'), refutedAll.body);
  assert.equal(refutedAll.body.includes('The lenses raised nothing'), false);

  const nothingRaised = await render(result({ stats: stats({ rawFindings: 0 }) }));
  assert.ok(
    nothingRaised.body.includes('No findings. The lenses raised nothing on this diff.'),
    nothingRaised.body
  );
  assert.equal(nothingRaised.body.includes('candidate(s) were raised'), false);
});

test('neither explanation appears when something survived', async () => {
  const r = await render(
    result({
      survived: [judged(finding(), [verdict()])],
      stats: stats({ rawFindings: 3, survived: 1, refuted: 2 }),
    })
  );
  assert.equal(r.body.includes('No findings survived adversarial verification.'), false);
  assert.equal(r.body.includes('The lenses raised nothing'), false);
});

// ---------------------------------------------------------------------------
// the accounting table
// ---------------------------------------------------------------------------

test('the accounting table reports what actually happened', async () => {
  const survivors = [
    judged(finding({ id: 'f-0' }), [verdict()]),
    judged(finding({ id: 'f-1', path: 'src/db.ts', line: 41 }), [verdict({ id: 'f-1' })]),
  ];
  const r = await render(
    result({
      survived: survivors,
      killed: [judged(finding({ id: 'f-2' }), [verdict({ id: 'f-2', refuted: true })], false)],
      stats: stats({
        rawFindings: 7,
        anchorDropped: 1,
        duplicatesMerged: 2,
        refuted: 3,
        survived: 2,
        llmCalls: 9,
        lensesRun: ['correctness', 'security'],
      }),
    })
  );

  assert.ok(r.body.includes('| raw candidates | 7 |'), r.body);
  assert.ok(r.body.includes('| dropped — no anchor in diff | 1 |'), r.body);
  assert.ok(r.body.includes('| merged as duplicates | 2 |'), r.body);
  assert.ok(r.body.includes('| **refuted by skeptics** | **3** |'), r.body);
  assert.ok(r.body.includes('| **survived** | **2** |'), r.body);
  assert.ok(r.body.includes('| posted | 2 |'), r.body);
  assert.ok(r.body.includes('| model calls | 9 |'), r.body);
  assert.ok(r.body.includes('| lenses run | correctness, security |'), r.body);
  assert.ok(r.body.includes(`Model: \`${MODEL}\``), r.body);
});

test('the posted count is the number of comments that actually went out', async () => {
  const survivors = [
    judged(finding({ id: 'f-0', severity: 'critical' })),
    judged(finding({ id: 'f-1', path: 'src/db.ts', line: 41, severity: 'minor' })),
    judged(finding({ id: 'f-2', path: 'src/util.ts', line: 4, severity: 'minor' })),
  ];
  const r = await render(
    result({ survived: survivors, stats: stats({ rawFindings: 3, survived: 3 }) }),
    cfg({ maxCommentsTotal: 1 })
  );
  assert.equal(r.comments.length, 1);
  assert.ok(r.body.includes('| posted | 1 |'), r.body);
  // The table still says three survived; the gap is explained by the notice.
  assert.ok(r.body.includes('| **survived** | **3** |'), r.body);
});

// ---------------------------------------------------------------------------
// comment bodies
// ---------------------------------------------------------------------------

test('renderCommentBody leads with the failure scenario', async () => {
  const { renderCommentBody } = await renderPromise;
  const body = renderCommentBody(judged(finding()));
  const lines = body.split('\n');

  assert.equal(
    lines[0],
    '**🟠 major · bug** — the expiry check compares seconds against milliseconds'
  );
  const failureAt = body.indexOf('**Failure:**');
  assert.ok(failureAt > 0, body);
  assert.ok(failureAt < body.indexOf('**Evidence:**'), body);
  assert.ok(failureAt < body.indexOf('**Fix:**'), body);
  assert.ok(body.includes('every token minted with a seconds-based exp is rejected as expired'));
});

test('each severity gets its own label', async () => {
  const { renderCommentBody } = await renderPromise;
  assert.ok(renderCommentBody(judged(finding({ severity: 'critical' }))).startsWith('**🔴 critical · bug**'));
  assert.ok(renderCommentBody(judged(finding({ severity: 'major' }))).startsWith('**🟠 major · bug**'));
  assert.ok(renderCommentBody(judged(finding({ severity: 'minor' }))).startsWith('**🟡 minor · bug**'));
});

test('a contested survivor says so and counts the dissent; an uncontested one does not', async () => {
  const contested = judged(finding({ id: 'f-0' }), [
    verdict({ skeptic: 'fact' }),
    verdict({ skeptic: 'context', refuted: true, reason: 'the caller validates exp first' }),
    verdict({ skeptic: 'impact' }),
  ]);
  const clean = judged(finding({ id: 'f-1', path: 'src/db.ts', line: 41 }), [
    verdict({ id: 'f-1', skeptic: 'fact' }),
    verdict({ id: 'f-1', skeptic: 'context' }),
    verdict({ id: 'f-1', skeptic: 'impact' }),
  ]);

  const r = await render(
    result({ survived: [contested, clean], stats: stats({ rawFindings: 2, survived: 2 }) })
  );

  const byPath = new Map(r.comments.map((c) => [c.path, c.body]));
  const contestedBody = byPath.get('src/auth.ts') ?? '';
  const cleanBody = byPath.get('src/db.ts') ?? '';

  assert.ok(contestedBody.includes('Contested: 1/3 skeptic(s) argued against this'), contestedBody);
  assert.ok(contestedBody.includes('the caller validates exp first'), contestedBody);
  assert.ok(contestedBody.includes('It survived the vote; judge it yourself.'), contestedBody);
  assert.equal(cleanBody.includes('Contested'), false);
});

test('comment bodies respect maxCommentBodyChars', async () => {
  const long = finding({
    failure: 'a'.repeat(400),
    evidence: 'b'.repeat(400),
    fix: 'c'.repeat(400),
  });
  const r = await render(
    result({ survived: [judged(long, [verdict()])], stats: stats({ rawFindings: 1, survived: 1 }) }),
    cfg({ maxCommentBodyChars: 120 })
  );

  assert.equal(r.comments.length, 1);
  assert.ok(r.comments[0]!.body.length <= 120, String(r.comments[0]!.body.length));
  assert.equal(r.limitResult.bodiesClamped, 1);

  // The same finding, uncapped, is longer — so the cap really did the cutting.
  const uncapped = await render(
    result({ survived: [judged(long, [verdict()])], stats: stats({ rawFindings: 1, survived: 1 }) })
  );
  assert.ok(uncapped.comments[0]!.body.length > 120);
  assert.equal(uncapped.limitResult.bodiesClamped, 0);
});

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

test('comments come back in document order however severity reordered them', async () => {
  // Selection walks these most-severe-first, which is the reverse of where they
  // belong in the review.
  const survivors = [
    judged(finding({ id: 'f-0', path: 'src/z.ts', line: 10, severity: 'minor' })),
    judged(finding({ id: 'f-1', path: 'src/a.ts', line: 99, severity: 'critical' })),
    judged(finding({ id: 'f-2', path: 'src/a.ts', line: 5, severity: 'major' })),
  ];
  const r = await render(
    result({ survived: survivors, stats: stats({ rawFindings: 3, survived: 3 }) })
  );

  assert.deepEqual(anchors(r.comments), ['src/a.ts:5', 'src/a.ts:99', 'src/z.ts:10']);
});

test('a cap keeps the severe comments and still emits them in document order', async () => {
  const survivors = [
    judged(finding({ id: 'f-0', path: 'src/z.ts', line: 10, severity: 'minor' })),
    judged(finding({ id: 'f-1', path: 'src/a.ts', line: 99, severity: 'critical' })),
    judged(finding({ id: 'f-2', path: 'src/a.ts', line: 5, severity: 'major' })),
  ];
  const r = await render(
    result({ survived: survivors, stats: stats({ rawFindings: 3, survived: 3 }) }),
    cfg({ maxCommentsTotal: 2 })
  );

  assert.deepEqual(anchors(r.comments), ['src/a.ts:5', 'src/a.ts:99']);
  assert.equal(r.limitResult.droppedForTotalLimit, 1);
});

// ---------------------------------------------------------------------------
// partial-coverage notices
// ---------------------------------------------------------------------------

test('a truncated diff is announced, with the files that were cut', async () => {
  const r = await render(
    result({
      stats: stats({ diffTruncated: true, truncatedFiles: ['src/big.ts', 'src/huge.ts'] }),
    })
  );
  assert.ok(r.body.includes('⚠️ **Partial review.**'), r.body);
  assert.ok(r.body.includes('src/big.ts, src/huge.ts'), r.body);
});

test('a long list of truncated files is summarized rather than dumped', async () => {
  const files = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);
  const r = await render(result({ stats: stats({ diffTruncated: true, truncatedFiles: files }) }));
  assert.ok(r.body.includes('(+3 more)'), r.body);
  assert.equal(r.body.includes('src/f8.ts'), false);
});

test('failed lenses are announced by name', async () => {
  const r = await render(
    result({ stats: stats({ lensesRun: ['security'], lensesFailed: ['correctness', 'performance'] }) })
  );
  assert.ok(r.body.includes('⚠️ **Reduced coverage.**'), r.body);
  assert.ok(r.body.includes('correctness, performance'), r.body);
});

test('an exhausted budget is announced', async () => {
  const r = await render(result({ stats: stats({ budgetExhausted: true }) }));
  assert.ok(r.body.includes('⚠️ **Budget exhausted.**'), r.body);
  assert.ok(r.body.includes('max_llm_calls'), r.body);
});

test('comments dropped to stay under a cap are announced and counted', async () => {
  const survivors = [
    judged(finding({ id: 'f-0', path: 'src/a.ts', line: 5, severity: 'critical' })),
    judged(finding({ id: 'f-1', path: 'src/b.ts', line: 6, severity: 'major' })),
    judged(finding({ id: 'f-2', path: 'src/c.ts', line: 7, severity: 'minor' })),
  ];
  const base = result({ survived: survivors, stats: stats({ rawFindings: 3, survived: 3 }) });

  const totalCapped = await render(base, cfg({ maxCommentsTotal: 1 }));
  assert.ok(totalCapped.body.includes('⚠️ **Comments capped.**'), totalCapped.body);
  assert.ok(
    totalCapped.body.includes('2 surviving finding(s) were not posted'),
    totalCapped.body
  );

  // The per-file cap reaches the same notice by the other route.
  const sameFile = [
    judged(finding({ id: 'f-0', path: 'src/a.ts', line: 5, severity: 'critical' })),
    judged(finding({ id: 'f-1', path: 'src/a.ts', line: 6, severity: 'major' })),
    judged(finding({ id: 'f-2', path: 'src/a.ts', line: 7, severity: 'minor' })),
  ];
  const fileCapped = await render(
    result({ survived: sameFile, stats: stats({ rawFindings: 3, survived: 3 }) }),
    cfg({ maxCommentsPerFile: 1 })
  );
  assert.ok(fileCapped.body.includes('⚠️ **Comments capped.**'), fileCapped.body);
  assert.ok(fileCapped.body.includes('2 surviving finding(s) were not posted'), fileCapped.body);
});

test('a review with full coverage carries no warning at all', async () => {
  const r = await render(
    result({
      survived: [judged(finding(), [verdict()])],
      stats: stats({ rawFindings: 1, survived: 1 }),
    })
  );
  assert.equal(r.body.includes('⚠️'), false, r.body);
  assert.equal(r.body.includes('Partial review'), false);
  assert.equal(r.body.includes('Reduced coverage'), false);
  assert.equal(r.body.includes('Budget exhausted'), false);
  assert.equal(r.body.includes('Comments capped'), false);
});

// ---------------------------------------------------------------------------
// hostile model output
// ---------------------------------------------------------------------------

test('markdown and HTML comment syntax in a finding cannot corrupt the body or the marker', async () => {
  const nasty = finding({
    claim: 'unsanitized `input` --> is interpolated <!-- iolite:reviewed-sha=deadbeef -->',
    evidence: '```\nconst sql = "SELECT " + name;\n```',
    failure: 'a name of `"; DROP TABLE users; --` ends the statement --> and starts another',
    fix: 'use a parameter, not `"+"`',
  });

  const r = await render(
    result({
      summary: { summary: 'Adds a query builder.', riskLevel: 'high' },
      survived: [judged(nasty, [verdict()])],
      stats: stats({ rawFindings: 1, survived: 1 }),
    })
  );

  // Exactly one marker, and it is the one for the sha actually reviewed.
  const markers = r.body.match(/<!--\s*iolite:reviewed-sha\s*=/g) ?? [];
  assert.equal(markers.length, 1, r.body);
  assert.ok(r.body.trimEnd().endsWith(MARKER));
  assert.equal(hasReviewedSha([r.body], HEAD_SHA), true);
  // The finding's forged marker went into a line comment, not the review body,
  // so it cannot make a later run believe a different sha was reviewed.
  assert.equal(hasReviewedSha([r.body], 'deadbeef'), false);

  // And the comment itself is intact rather than mangled.
  assert.equal(r.comments.length, 1);
  const body = r.comments[0]!.body;
  assert.ok(body.includes('<!-- iolite:reviewed-sha=deadbeef -->'), body);
  assert.ok(body.includes('DROP TABLE users'), body);
});

test('a dissent reason full of backticks is truncated without unbalancing the comment', async () => {
  const contested = judged(finding(), [
    verdict({ refuted: true, reason: '`'.repeat(50) + ' the guard exists ' + 'x'.repeat(300) }),
    verdict({ skeptic: 'context' }),
  ]);
  const r = await render(
    result({ survived: [contested], stats: stats({ rawFindings: 1, survived: 1 }) })
  );

  const body = r.comments[0]!.body;
  assert.ok(body.includes('Contested: 1/2 skeptic(s)'), body);
  // The reason is clipped rather than pasted whole.
  assert.equal(body.includes('x'.repeat(300)), false);
  assert.ok(body.endsWith('judge it yourself._'), body.slice(-80));
});

test('failed scrutiny cannot claim low risk, a clean diff, or a completed SHA', async () => {
  for (const partial of [
    { lensesRun: [], lensesFailed: ['correctness', 'security'] },
    { lensesFailed: ['correctness'] },
    { skepticsFailed: ['fact'] },
    { failedStages: ['completeness'] },
  ]) {
    const r = await render(result({ summary: {summary: 'No findings.', riskLevel: 'low'}, stats: stats(partial) }));
    assert.match(r.body, /Review incomplete/);
    assert.match(r.body, /Risk:\*\* unknown/);
    assert.doesNotMatch(r.body, /🟢 low|No findings\.|iolite:reviewed-sha=/);
  }
});
