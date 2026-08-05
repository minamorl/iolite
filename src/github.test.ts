/**
 * Tests for the GitHub IO layer.
 *
 * Nothing here touches the network. `GitHubClient` takes an optional injected
 * client, and every test drives a hand-rolled Octokit double that records what
 * was asked of it. The double's `paginate` walks pages the way the real one
 * does — call until a short page comes back — so "does this code paginate?" is
 * an observable property rather than an assumption.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The module under test is loaded through a dynamic import rather than a static
 * one, because no single specifier satisfies both toolchains:
 *
 *   - `node --experimental-strip-types` reparses this file as ESM (it contains
 *     `import`), and the ESM resolver has no extension search — `./github`
 *     is ERR_MODULE_NOT_FOUND, only `./github.ts` resolves.
 *   - `tsc` with this repo's `module: commonjs` rejects a `.ts` extension
 *     outright (TS5097) unless `allowImportingTsExtensions` is set.
 *
 * Concatenating the specifier keeps the literal out of tsc's static analysis
 * while resolving relative to *this file* at runtime, so it does not care where
 * the test is invoked from. The types are recovered from `import(...)` type
 * syntax, which lives entirely in type space and is erased before Node sees it.
 */
type GitHubModule = typeof import('./github');
type PRInfo = import('./github').PRInfo;
type LineComment = import('./github').LineComment;

let GitHubClient: GitHubModule['GitHubClient'];
let SKIP_TOKEN: string;

before(async () => {
  const mod = (await import('./github' + '.ts')) as GitHubModule;
  GitHubClient = mod.GitHubClient;
  SKIP_TOKEN = mod.SKIP_TOKEN;
});

/**
 * `github.ts` reports degraded paths through @actions/core, which writes
 * workflow commands straight to stdout. Drop exactly those lines so the test
 * report stays readable; everything else passes through untouched.
 */
const realWrite = process.stdout.write.bind(process.stdout);
(process.stdout as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
  const text = typeof chunk === 'string' ? chunk : '';
  if (text.startsWith('::warning::') || text.startsWith('::debug::') || text.startsWith('iolite:')) {
    return true;
  }
  return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
};

// --------------------------------------------------------------------------
// Test double
// --------------------------------------------------------------------------

type Handler = (params: any) => any;

interface Fake {
  octokit: any;
  calls: Array<{ op: string; params: any }>;
  paramsFor(op: string): any[];
  countOf(op: string): number;
}

function fakeOctokit(handlers: Record<string, Handler>): Fake {
  const calls: Array<{ op: string; params: any }> = [];

  const dispatch = (op: string) => async (params: any) => {
    calls.push({ op, params });
    const handler = handlers[op];
    if (!handler) throw new Error(`test double: unexpected call to ${op}`);
    return await handler(params);
  };

  const octokit = {
    pulls: {
      get: dispatch('pulls.get'),
      listCommits: dispatch('pulls.listCommits'),
      listReviews: dispatch('pulls.listReviews'),
      createReview: dispatch('pulls.createReview'),
      createReviewComment: dispatch('pulls.createReviewComment'),
    },
    issues: {
      get: dispatch('issues.get'),
      listComments: dispatch('issues.listComments'),
    },
    repos: {
      getContent: dispatch('repos.getContent'),
      getCollaboratorPermissionLevel: dispatch('repos.getCollaboratorPermissionLevel'),
    },
    async paginate(fn: (p: any) => Promise<{ data: any[] }>, params: any): Promise<any[]> {
      const perPage = params?.per_page ?? 30;
      const out: any[] = [];
      for (let page = 1; page <= 100; page++) {
        const res = await fn({ ...params, page });
        const items = res?.data ?? [];
        out.push(...items);
        if (items.length < perPage) break;
      }
      return out;
    },
  };

  return {
    octokit,
    calls,
    paramsFor: (op) => calls.filter((c) => c.op === op).map((c) => c.params),
    countOf: (op) => calls.filter((c) => c.op === op).length,
  };
}

function client(handlers: Record<string, Handler> = {}) {
  const fake = fakeOctokit(handlers);
  const gh = new GitHubClient('ghs-secret-never-logged', 'acme', 'widget', fake.octokit);
  return { gh, fake };
}

function httpError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function prPayload(over: Record<string, any> = {}) {
  return {
    number: 9,
    title: 'Add a thing',
    body: null,
    head: { ref: 'feat/1-thing', sha: 'headsha1234' },
    base: { ref: 'main', sha: 'basesha5678' },
    commits: 3,
    additions: 40,
    deletions: 5,
    changed_files: 4,
    user: { login: 'alice' },
    draft: false,
    ...over,
  };
}

function prInfo(over: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    title: 'Add a thing',
    body: null,
    headBranch: 'main',
    baseBranch: 'main',
    headSha: 'headsha',
    baseSha: 'basesha',
    commits: 1,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    author: 'alice',
    draft: false,
    ...over,
  };
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

// --------------------------------------------------------------------------
// getPRDiff
// --------------------------------------------------------------------------

test('getPRDiff asks for the diff media type and returns the raw string', async () => {
  const raw = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const { gh, fake } = client({
    'pulls.get': async (params) => {
      assert.deepEqual(params.mediaType, { format: 'diff' });
      assert.equal(params.owner, 'acme');
      assert.equal(params.repo, 'widget');
      assert.equal(params.pull_number, 9);
      return { data: raw };
    },
  });

  assert.equal(await gh.getPRDiff(9), raw);
  assert.equal(fake.countOf('pulls.get'), 1);
});

test('getPRDiff refuses a non-string body instead of reviewing "[object Object]"', async () => {
  const { gh } = client({
    'pulls.get': async () => ({ data: prPayload() }),
  });

  await assert.rejects(
    () => gh.getPRDiff(9),
    (err: Error) => {
      assert.match(err.message, /raw unified diff/);
      assert.match(err.message, /object/);
      return true;
    },
  );
});

test('getPRDiff wraps transport failures with the operation name', async () => {
  const { gh } = client({
    'pulls.get': async () => {
      throw httpError(502, 'Bad gateway');
    },
  });

  await assert.rejects(
    () => gh.getPRDiff(9),
    (err: Error) => {
      assert.match(err.message, /diff for PR #9/);
      assert.match(err.message, /HTTP 502/);
      return true;
    },
  );
});

// --------------------------------------------------------------------------
// getPRInfo
// --------------------------------------------------------------------------

test('getPRInfo flattens the REST payload', async () => {
  const { gh } = client({
    'pulls.get': async () => ({ data: prPayload({ body: 'Closes #12', draft: true }) }),
  });

  const info = await gh.getPRInfo(9);
  assert.deepEqual(info, {
    number: 9,
    title: 'Add a thing',
    body: 'Closes #12',
    headBranch: 'feat/1-thing',
    baseBranch: 'main',
    headSha: 'headsha1234',
    baseSha: 'basesha5678',
    commits: 3,
    additions: 40,
    deletions: 5,
    changedFiles: 4,
    author: 'alice',
    draft: true,
  });
});

test('getPRInfo survives a payload with null body and missing author', async () => {
  const { gh } = client({
    'pulls.get': async () => ({ data: prPayload({ body: null, user: null }) }),
  });

  const info = await gh.getPRInfo(9);
  assert.equal(info.body, null);
  assert.equal(info.author, '');
  assert.equal(info.draft, false);
});

// --------------------------------------------------------------------------
// getLinkedIssue — closing keywords
// --------------------------------------------------------------------------

const KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
];

test('getLinkedIssue resolves every closing-keyword conjugation', async () => {
  const { gh } = client();
  for (const keyword of KEYWORDS) {
    const body = `Some prose about the change.\n\n${keyword} #12\n`;
    assert.equal(await gh.getLinkedIssue(prInfo({ body })), 12, `lowercase "${keyword}"`);
  }
});

test('getLinkedIssue matches closing keywords case-insensitively', async () => {
  const { gh } = client();
  for (const body of ['Closes #12', 'CLOSES #12', 'FiXeS #12', 'ReSoLvEd #12', 'Fix #12']) {
    assert.equal(await gh.getLinkedIssue(prInfo({ body })), 12, body);
  }
});

test('getLinkedIssue tolerates the colon and no-space spellings', async () => {
  const { gh } = client();
  for (const body of ['Closes: #12', 'closes:#12', 'closes  #12', '- fixes #12']) {
    assert.equal(await gh.getLinkedIssue(prInfo({ body })), 12, body);
  }
});

test('getLinkedIssue does not treat a word that merely contains a keyword as one', async () => {
  const { gh } = client();
  for (const body of ['unfixes #12', 'closest #12', 'prefixes #12']) {
    assert.equal(await gh.getLinkedIssue(prInfo({ body })), null, body);
  }
});

test('getLinkedIssue ignores a bare #reference with no closing keyword', async () => {
  const { gh } = client();
  // "related to #12" is a mention, not a declared link. Guessing here would
  // feed the reviewer the wrong requirements.
  assert.equal(await gh.getLinkedIssue(prInfo({ body: 'Related to #12, see also #13.' })), null);
});

test('getLinkedIssue accepts a closing keyword pointing at a full URL', async () => {
  const { gh } = client();
  const body = 'Fixes https://github.com/acme/widget/issues/12';
  assert.equal(await gh.getLinkedIssue(prInfo({ body })), 12);
});

// --------------------------------------------------------------------------
// getLinkedIssue — URL form
// --------------------------------------------------------------------------

test('getLinkedIssue falls back to a bare issue URL in the body', async () => {
  const { gh } = client();
  const body = 'Background: https://github.com/acme/widget/issues/34 has the details.';
  assert.equal(await gh.getLinkedIssue(prInfo({ body })), 34);
});

test('getLinkedIssue prefers this repository when several issue URLs appear', async () => {
  const { gh } = client();
  const body =
    'Upstream https://github.com/other/thing/issues/99 and ours https://github.com/acme/widget/issues/34';
  assert.equal(await gh.getLinkedIssue(prInfo({ body })), 34);
});

test('getLinkedIssue still takes a foreign issue URL when that is all there is', async () => {
  const { gh } = client();
  const body = 'See https://github.com/other/thing/issues/99';
  assert.equal(await gh.getLinkedIssue(prInfo({ body })), 99);
});

test('getLinkedIssue prefers a closing keyword over a URL mentioned elsewhere', async () => {
  const { gh } = client();
  const body = 'Closes #7\n\nContext: https://github.com/acme/widget/issues/99';
  assert.equal(await gh.getLinkedIssue(prInfo({ body })), 7);
});

// --------------------------------------------------------------------------
// getLinkedIssue — branch form
// --------------------------------------------------------------------------

test('getLinkedIssue reads a leading issue number out of the head branch', async () => {
  const { gh } = client();
  const cases: Array<[string, number]> = [
    ['feat/123-thing', 123],
    ['123-thing', 123],
    ['issue-123-thing', 123],
    ['issues/123-thing', 123],
    ['gh-123-thing', 123],
    ['gh_123', 123],
    ['fix/123', 123],
    ['123', 123],
    ['alice/feature/123-thing', 123],
  ];
  for (const [branch, expected] of cases) {
    assert.equal(await gh.getLinkedIssue(prInfo({ headBranch: branch })), expected, branch);
  }
});

test('getLinkedIssue does not invent an issue from a branch that merely starts with digits', async () => {
  const { gh } = client();
  for (const branch of ['main', 'release/1.2.3', 'feat/2fa-login', 'v2/rewrite', 'chore/deps']) {
    assert.equal(await gh.getLinkedIssue(prInfo({ headBranch: branch })), null, branch);
  }
});

test('getLinkedIssue prefers the body over the branch', async () => {
  const { gh } = client();
  const info = prInfo({ body: 'Closes #12', headBranch: 'feat/999-thing' });
  assert.equal(await gh.getLinkedIssue(info), 12);
});

test('getLinkedIssue returns null when nothing links anywhere', async () => {
  const { gh } = client();
  assert.equal(await gh.getLinkedIssue(prInfo({ body: null, headBranch: 'main' })), null);
  assert.equal(
    await gh.getLinkedIssue(prInfo({ body: 'Just a refactor, no ticket.', headBranch: 'refactor' })),
    null,
  );
});

// --------------------------------------------------------------------------
// getLinkedIssue — self-reference
// --------------------------------------------------------------------------

test('getLinkedIssue never returns the PR its own number', async () => {
  const { gh } = client();

  // Body keyword pointing at itself.
  assert.equal(await gh.getLinkedIssue(prInfo({ number: 7, body: 'Closes #7' })), null);

  // URL pointing at itself.
  assert.equal(
    await gh.getLinkedIssue(
      prInfo({ number: 7, body: 'See https://github.com/acme/widget/issues/7' }),
    ),
    null,
  );

  // Branch named after the PR number.
  assert.equal(
    await gh.getLinkedIssue(prInfo({ number: 123, body: null, headBranch: 'feat/123-thing' })),
    null,
  );
});

test('getLinkedIssue skips the self-reference and keeps looking', async () => {
  const { gh } = client();
  const info = prInfo({ number: 7, body: 'Closes #7 (typo)\nActually fixes #9' });
  assert.equal(await gh.getLinkedIssue(info), 9);
});

// --------------------------------------------------------------------------
// getIssueInfo
// --------------------------------------------------------------------------

test('getIssueInfo normalises labels and paginates comments', async () => {
  const allComments = Array.from({ length: 150 }, (_, i) => ({
    user: { login: `user${i}` },
    body: `comment ${i}`,
    created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
  }));

  const { gh, fake } = client({
    'issues.get': async () => ({
      data: {
        number: 12,
        title: 'It breaks',
        body: 'Steps to reproduce',
        labels: [{ name: 'bug' }, 'regression', { name: null }, { name: 'p1' }],
      },
    }),
    'issues.listComments': async (params) => {
      const start = (params.page - 1) * params.per_page;
      return { data: allComments.slice(start, start + params.per_page) };
    },
  });

  const info = await gh.getIssueInfo(12);
  assert.equal(info.number, 12);
  assert.equal(info.title, 'It breaks');
  assert.equal(info.body, 'Steps to reproduce');
  assert.deepEqual(info.labels, ['bug', 'regression', 'p1']);
  assert.equal(info.comments.length, 150);
  assert.equal(info.comments[0].author, 'user0');
  assert.equal(info.comments[149].body, 'comment 149');
  assert.equal(fake.countOf('issues.listComments'), 2);
});

test('getIssueInfo handles an anonymous comment author and a null body', async () => {
  const { gh } = client({
    'issues.get': async () => ({ data: { number: 12, title: 'T', body: null, labels: [] } }),
    'issues.listComments': async () => ({
      data: [{ user: null, body: null, created_at: '2026-01-01T00:00:00Z' }],
    }),
  });

  const info = await gh.getIssueInfo(12);
  assert.equal(info.body, null);
  assert.deepEqual(info.comments, [
    { author: 'unknown', body: '', createdAt: '2026-01-01T00:00:00Z' },
  ]);
});

test('getIssueInfo wraps a failure with the issue number', async () => {
  const { gh } = client({
    'issues.get': async () => {
      throw httpError(404, 'Not Found');
    },
  });

  await assert.rejects(
    () => gh.getIssueInfo(12),
    (err: Error) => {
      assert.match(err.message, /issue #12/);
      return true;
    },
  );
});

// --------------------------------------------------------------------------
// shouldSkipReview
// --------------------------------------------------------------------------

test('shouldSkipReview finds the marker in the PR body', async () => {
  const { gh, fake } = client({
    'pulls.get': async () => ({ data: prPayload({ body: `Draft work ${SKIP_TOKEN} for now` }) }),
  });

  assert.equal(await gh.shouldSkipReview(9), true);
  // The body already answered; no reason to page through commits.
  assert.equal(fake.countOf('pulls.listCommits'), 0);
});

test('shouldSkipReview finds the marker in a commit message on a later page', async () => {
  // 200 commits, marker on #150: a client that only read the first page would
  // review a PR whose author explicitly opted out.
  const commits = Array.from({ length: 200 }, (_, i) => ({
    commit: { message: i === 149 ? `wip ${SKIP_TOKEN}` : `commit ${i}` },
  }));

  const { gh, fake } = client({
    'pulls.get': async () => ({ data: prPayload({ body: 'nothing here' }) }),
    'pulls.listCommits': async (params) => {
      const start = (params.page - 1) * params.per_page;
      return { data: commits.slice(start, start + params.per_page) };
    },
  });

  assert.equal(await gh.shouldSkipReview(9), true);
  assert.equal(fake.countOf('pulls.listCommits'), 3);
  assert.equal(fake.paramsFor('pulls.listCommits')[0].per_page, 100);
});

test('shouldSkipReview matches the marker regardless of case', async () => {
  const { gh } = client({
    'pulls.get': async () => ({ data: prPayload({ body: null }) }),
    'pulls.listCommits': async () => ({ data: [{ commit: { message: '[SKIP-AI-REVIEW] wip' } }] }),
  });

  assert.equal(await gh.shouldSkipReview(9), true);
});

test('shouldSkipReview is false when nothing opts out', async () => {
  const { gh } = client({
    'pulls.get': async () => ({ data: prPayload({ body: 'Please review carefully.' }) }),
    'pulls.listCommits': async () => ({
      data: [{ commit: { message: 'fix the thing' } }, { commit: null }],
    }),
  });

  assert.equal(await gh.shouldSkipReview(9), false);
});

// --------------------------------------------------------------------------
// listReviewBodies
// --------------------------------------------------------------------------

test('listReviewBodies paginates and coerces empty bodies', async () => {
  const reviews = Array.from({ length: 120 }, (_, i) => ({ body: i === 5 ? null : `review ${i}` }));

  const { gh, fake } = client({
    'pulls.listReviews': async (params) => {
      const start = (params.page - 1) * params.per_page;
      return { data: reviews.slice(start, start + params.per_page) };
    },
  });

  const bodies = await gh.listReviewBodies(9);
  assert.equal(bodies.length, 120);
  assert.equal(bodies[0], 'review 0');
  assert.equal(bodies[5], '');
  assert.equal(bodies[119], 'review 119');
  assert.equal(fake.countOf('pulls.listReviews'), 2);
});

// --------------------------------------------------------------------------
// getUserPermission
// --------------------------------------------------------------------------

test('getUserPermission returns the effective collaborator permission', async () => {
  const { gh, fake } = client({
    'repos.getCollaboratorPermissionLevel': async () => ({ data: { permission: 'write' } }),
  });

  assert.equal(await gh.getUserPermission('alice'), 'write');
  assert.equal(fake.paramsFor('repos.getCollaboratorPermissionLevel')[0].username, 'alice');
});

test('getUserPermission maps 404 to "none" — a non-collaborator is not an error', async () => {
  const { gh } = client({
    'repos.getCollaboratorPermissionLevel': async () => {
      throw httpError(404, 'Not Found');
    },
  });

  assert.equal(await gh.getUserPermission('drive-by-contributor'), 'none');
});

test('getUserPermission returns "none" for an empty username without calling GitHub', async () => {
  const { gh, fake } = client();
  assert.equal(await gh.getUserPermission(''), 'none');
  assert.equal(fake.calls.length, 0);
});

test('getUserPermission does not swallow a real failure', async () => {
  const { gh } = client({
    'repos.getCollaboratorPermissionLevel': async () => {
      throw httpError(500, 'Internal Server Error');
    },
  });

  await assert.rejects(
    () => gh.getUserPermission('alice'),
    (err: Error) => {
      assert.match(err.message, /permission for alice/);
      assert.match(err.message, /HTTP 500/);
      return true;
    },
  );
});

// --------------------------------------------------------------------------
// getFileContent
// --------------------------------------------------------------------------

test('getFileContent decodes base64, including GitHub-style wrapped output', async () => {
  const text = '# Review policy\n\nBe adversarial.\n';
  const wrapped = b64(text).replace(/(.{4})/g, '$1\n'); // GitHub wraps at 60 chars

  const { gh, fake } = client({
    'repos.getContent': async () => ({
      data: { type: 'file', encoding: 'base64', size: text.length, content: wrapped },
    }),
  });

  assert.equal(await gh.getFileContent('.github/review-policy.md'), text);
  const params = fake.paramsFor('repos.getContent')[0];
  assert.equal(params.path, '.github/review-policy.md');
  assert.equal('ref' in params, false);
});

test('getFileContent reads at the requested ref', async () => {
  const { gh, fake } = client({
    'repos.getContent': async () => ({
      data: { type: 'file', encoding: 'base64', size: 5, content: b64('hello') },
    }),
  });

  assert.equal(await gh.getFileContent('policy.md', 'basesha5678'), 'hello');
  assert.equal(fake.paramsFor('repos.getContent')[0].ref, 'basesha5678');
});

test('getFileContent returns "" on 404 — a missing policy file is a normal state', async () => {
  const { gh } = client({
    'repos.getContent': async () => {
      throw httpError(404, 'Not Found');
    },
  });

  assert.equal(await gh.getFileContent('.github/review-policy.md'), '');
  assert.equal(await gh.getFileContent('.github/review-policy.md', 'main'), '');
});

test('getFileContent decodes UTF-8 beyond ASCII', async () => {
  const text = 'ポリシー: 反証できない指摘は捨てる\n';
  const { gh } = client({
    'repos.getContent': async () => ({
      data: { type: 'file', encoding: 'base64', content: b64(text) },
    }),
  });

  assert.equal(await gh.getFileContent('policy.md'), text);
});

test('getFileContent rejects a directory', async () => {
  const { gh } = client({
    'repos.getContent': async () => ({ data: [{ type: 'file', name: 'a.md' }] }),
  });

  await assert.rejects(
    () => gh.getFileContent('.github'),
    (err: Error) => {
      assert.match(err.message, /directory/);
      return true;
    },
  );
});

test('getFileContent rejects a file over the inline-read limit', async () => {
  const { gh } = client({
    'repos.getContent': async () => ({
      data: { type: 'file', encoding: 'base64', size: 5 * 1024 * 1024, content: '' },
    }),
  });

  await assert.rejects(
    () => gh.getFileContent('huge.md'),
    (err: Error) => {
      assert.match(err.message, /limit/);
      return true;
    },
  );
});

test('getFileContent rejects a blob GitHub refused to inline', async () => {
  const { gh } = client({
    'repos.getContent': async () => ({
      data: { type: 'file', encoding: 'none', size: 10, content: '' },
    }),
  });

  await assert.rejects(
    () => gh.getFileContent('big.bin'),
    (err: Error) => {
      assert.match(err.message, /encoding "none"/);
      return true;
    },
  );
});

test('getFileContent rejects a submodule or symlink entry', async () => {
  const { gh } = client({
    'repos.getContent': async () => ({ data: { type: 'symlink', target: '../x' } }),
  });

  await assert.rejects(() => gh.getFileContent('link'), /symlink/);
});

test('getFileContent does not hide a non-404 failure', async () => {
  const { gh } = client({
    'repos.getContent': async () => {
      throw httpError(403, 'Forbidden');
    },
  });

  await assert.rejects(
    () => gh.getFileContent('policy.md', 'main'),
    (err: Error) => {
      assert.match(err.message, /policy\.md at main/);
      assert.match(err.message, /HTTP 403/);
      return true;
    },
  );
});

// --------------------------------------------------------------------------
// postReview
// --------------------------------------------------------------------------

const COMMENTS: LineComment[] = [
  { path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'unbounded loop' },
  { path: 'src/a.ts', line: 20, side: 'RIGHT', body: 'anchor outside the diff' },
  { path: 'src/b.ts', line: 30, side: 'RIGHT', body: 'missing await' },
];

test('postReview posts one batched COMMENT review when GitHub accepts it', async () => {
  const { gh, fake } = client({
    'pulls.createReview': async () => ({ data: { id: 4242 } }),
  });

  const res = await gh.postReview(9, { body: 'SUMMARY', comments: COMMENTS });
  assert.deepEqual(res, { id: 4242, commentCount: 3 });
  assert.equal(fake.countOf('pulls.createReview'), 1);
  assert.equal(fake.countOf('pulls.createReviewComment'), 0);

  const params = fake.paramsFor('pulls.createReview')[0];
  assert.equal(params.event, 'COMMENT');
  assert.equal(params.body, 'SUMMARY');
  assert.equal(params.comments.length, 3);
  assert.deepEqual(params.comments[0], {
    path: 'src/a.ts',
    line: 10,
    side: 'RIGHT',
    body: 'unbounded loop',
  });
});

test('postReview posts a plain COMMENT review when there are no line comments', async () => {
  const { gh, fake } = client({
    'pulls.createReview': async () => ({ data: { id: 1 } }),
  });

  const res = await gh.postReview(9, { body: 'Nothing survived the skeptics.', comments: [] });
  assert.deepEqual(res, { id: 1, commentCount: 0 });

  const params = fake.paramsFor('pulls.createReview')[0];
  assert.equal(params.event, 'COMMENT');
  assert.equal(params.comments, undefined);
});

test('postReview never approves or requests changes', async () => {
  const { gh, fake } = client({
    'pulls.createReview': async () => ({ data: { id: 1 } }),
  });

  await gh.postReview(9, { body: 'a', comments: [] });
  await gh.postReview(9, { body: 'b', comments: COMMENTS });

  for (const params of fake.paramsFor('pulls.createReview')) {
    assert.equal(params.event, 'COMMENT');
  }
});

test('postReview: a 422 still lands the summary and every comment GitHub accepts', async () => {
  const rejectedLine = 20;
  const { gh, fake } = client({
    'pulls.createReview': async (params) => {
      // The batch dies on one bad anchor; the body-only review is fine.
      if (params.comments && params.comments.length > 0) {
        throw httpError(422, 'Unprocessable Entity: line must be part of the diff');
      }
      return { data: { id: 555 } };
    },
    'pulls.get': async () => ({ data: prPayload({ head: { ref: 'feat/1', sha: 'HEADSHA' } }) }),
    'pulls.createReviewComment': async (params) => {
      if (params.line === rejectedLine) throw httpError(422, 'line is not part of the diff');
      return { data: { id: 100 + params.line } };
    },
  });

  const res = await gh.postReview(9, { body: 'SUMMARY', comments: COMMENTS });

  // The summary is the highest-value part of the review; it must survive.
  assert.equal(res.id, 555);
  // Two of three anchors were valid, and the count reports what landed.
  assert.equal(res.commentCount, 2);

  const reviewCalls = fake.paramsFor('pulls.createReview');
  assert.equal(reviewCalls.length, 2);
  assert.equal(reviewCalls[1].body, 'SUMMARY');
  assert.equal(reviewCalls[1].event, 'COMMENT');
  assert.equal(reviewCalls[1].comments, undefined);

  const commentCalls = fake.paramsFor('pulls.createReviewComment');
  assert.equal(commentCalls.length, 3, 'every comment is retried, including after one fails');
  for (const call of commentCalls) {
    assert.equal(call.commit_id, 'HEADSHA');
    assert.equal(call.side, 'RIGHT');
    assert.equal(call.pull_number, 9);
  }
  assert.deepEqual(
    commentCalls.map((c) => c.line),
    [10, 20, 30],
  );
});

test('postReview keeps the line comments even when the summary itself fails', async () => {
  const { gh } = client({
    'pulls.createReview': async () => {
      throw httpError(422, 'Unprocessable Entity');
    },
    'pulls.get': async () => ({ data: prPayload({ head: { ref: 'f', sha: 'HEADSHA' } }) }),
    'pulls.createReviewComment': async () => ({ data: { id: 1 } }),
  });

  const res = await gh.postReview(9, { body: 'SUMMARY', comments: COMMENTS });
  assert.equal(res.id, 0, 'no review record exists');
  assert.equal(res.commentCount, 3);
});

test('postReview throws when the fallback lands absolutely nothing', async () => {
  const { gh } = client({
    'pulls.createReview': async () => {
      throw httpError(422, 'Unprocessable Entity');
    },
    'pulls.get': async () => ({ data: prPayload({ head: { ref: 'f', sha: 'HEADSHA' } }) }),
    'pulls.createReviewComment': async () => {
      throw httpError(422, 'line is not part of the diff');
    },
  });

  await assert.rejects(
    () => gh.postReview(9, { body: 'SUMMARY', comments: COMMENTS }),
    (err: Error) => {
      assert.match(err.message, /neither the summary nor any of the 3 line comments/);
      return true;
    },
  );
});

test('postReview does not fall back on a non-422 failure', async () => {
  const { gh, fake } = client({
    'pulls.createReview': async () => {
      throw httpError(503, 'Service Unavailable');
    },
  });

  await assert.rejects(
    () => gh.postReview(9, { body: 'SUMMARY', comments: COMMENTS }),
    (err: Error) => {
      assert.match(err.message, /posting the review on PR #9/);
      assert.match(err.message, /HTTP 503/);
      return true;
    },
  );
  assert.equal(fake.countOf('pulls.createReview'), 1);
  assert.equal(fake.countOf('pulls.createReviewComment'), 0);
});

test('postReview drops comments that could only ever produce a 422', async () => {
  const { gh, fake } = client({
    'pulls.createReview': async () => ({ data: { id: 7 } }),
  });

  const res = await gh.postReview(9, {
    body: 'SUMMARY',
    comments: [
      { path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'real' },
      { path: '', line: 5, side: 'RIGHT', body: 'no path' },
      { path: 'src/b.ts', line: 0, side: 'RIGHT', body: 'line 0 does not exist' },
      { path: 'src/c.ts', line: Number.NaN, side: 'RIGHT', body: 'not a line' },
      { path: 'src/d.ts', line: 4, side: 'RIGHT', body: '   ' },
    ],
  });

  assert.equal(res.commentCount, 1);
  assert.equal(fake.paramsFor('pulls.createReview')[0].comments.length, 1);
});

test('postReview posts a body-only review when every comment was unusable', async () => {
  const { gh, fake } = client({
    'pulls.createReview': async () => ({ data: { id: 8 } }),
  });

  const res = await gh.postReview(9, {
    body: 'SUMMARY',
    comments: [{ path: 'src/a.ts', line: -1, side: 'RIGHT', body: 'bad' }],
  });

  assert.deepEqual(res, { id: 8, commentCount: 0 });
  assert.equal(fake.paramsFor('pulls.createReview')[0].comments, undefined);
});
