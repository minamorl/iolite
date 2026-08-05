import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore -- node's type stripper needs the explicit extension; tsconfig has no allowImportingTsExtensions
import { redact, preview, isVerbose, resetVerboseCache, debugLog, info, warn } from './logging.ts';

const LF = String.fromCharCode(10);

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  resetVerboseCache();
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetVerboseCache();
  }
}

function captureStdout(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  (process.stdout as unknown as { write: unknown }).write = (chunk: unknown) => {
    buffer += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout as unknown as { write: unknown }).write = original;
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------

test('redact masks Anthropic keys', () => {
  const key = `sk-ant-api03-${'Ab3_x'.repeat(8)}`;
  const out = redact(`calling with ${key} now`);
  assert.equal(out, 'calling with *** now');
  assert.ok(!out.includes('sk-ant'));
});

test('redact masks a short sk-ant-shaped string too', () => {
  assert.equal(redact('sk-ant-abc123'), '***');
});

test('redact masks GitHub token shapes', () => {
  const shapes = [
    `ghp_${'A1b2C3d4'.repeat(4)}`,
    `gho_${'A1b2C3d4'.repeat(4)}`,
    `ghs_${'A1b2C3d4'.repeat(4)}`,
    `github_pat_${'A1b2C3d4'.repeat(4)}`,
  ];
  for (const token of shapes) {
    const out = redact(`token=${token} end`);
    assert.ok(!out.includes(token), out);
    assert.ok(out.includes('***'), out);
  }
});

test('redact masks Bearer credentials but keeps the scheme readable', () => {
  const out = redact('Authorization: Bearer abc.def-ghi_jkl123');
  assert.equal(out, 'Authorization: Bearer ***');
  assert.ok(!out.includes('abc.def'));
  assert.equal(redact('authorization: bearer shortTOKEN'), 'authorization: Bearer ***');
});

test('redact masks long base64-ish runs', () => {
  const blob = 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldA';
  assert.ok(blob.length >= 32);
  assert.equal(redact(`payload ${blob} end`), 'payload *** end');
  assert.equal(redact('A'.repeat(32)), '***');
  assert.equal(redact('A'.repeat(31)), 'A'.repeat(31));
});

test('redact masks a bare 40-char hex token', () => {
  const legacy = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(redact(`x-token: ${legacy}`), 'x-token: ***');
});

test('redact leaves ordinary text alone', () => {
  const ordinary = [
    'Fixed a null check in src/limits.ts line 42 (major).',
    'The quick brown fox jumps over the lazy dog.',
    'applyLimits() drops 3 comments for the per-file cap',
    'see .github/workflows/review.yml for the wiring',
    'critical: unbounded loop in parseHunkHeader',
    '',
  ];
  for (const text of ordinary) {
    assert.equal(redact(text), text, text);
  }
});

test('redact handles several credentials in one string', () => {
  const out = redact(`key sk-ant-abc123 and token ghp_${'Zz9'.repeat(6)} done`);
  assert.ok(!out.includes('sk-ant-abc123'), out);
  assert.ok(!out.includes('ghp_Zz9'), out);
});

test('redact tolerates non-string input', () => {
  assert.equal(redact(undefined as unknown as string), '');
  assert.equal(redact(null as unknown as string), '');
  assert.equal(redact(42 as unknown as string), '42');
});

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

test('preview redacts, collapses whitespace, and truncates', () => {
  const out = preview(`line one${LF}line two   with   spaces`, 20);
  assert.ok(out.length <= 20, out);
  assert.ok(!out.includes(LF));
  assert.ok(out.startsWith('line one line two'));
});

test('preview cannot be used to dump a whole diff', () => {
  const diff = 'x'.repeat(100000);
  assert.ok(preview(diff, 100000).length <= 240);
  assert.ok(preview(diff).length <= 121);
});

test('preview redacts credentials inside the snippet', () => {
  const out = preview('token is sk-ant-abc123 ok', 200);
  assert.ok(!out.includes('sk-ant'), out);
});

test('preview handles empty and non-string input', () => {
  assert.equal(preview(''), '');
  assert.equal(preview(undefined as unknown as string), '');
  assert.equal(preview('abc', 0), '');
});

// ---------------------------------------------------------------------------
// verbosity
// ---------------------------------------------------------------------------

test('verbose is off by default', () => {
  withEnv({ RUNNER_DEBUG: undefined, INPUT_DEBUG: undefined, IOLITE_DEBUG: undefined }, () => {
    assert.equal(isVerbose(), false);
  });
});

test('RUNNER_DEBUG=1 turns verbose on', () => {
  withEnv({ RUNNER_DEBUG: '1', INPUT_DEBUG: undefined, IOLITE_DEBUG: undefined }, () => {
    assert.equal(isVerbose(), true);
  });
});

test('the debug action input turns verbose on', () => {
  withEnv({ RUNNER_DEBUG: undefined, INPUT_DEBUG: 'true', IOLITE_DEBUG: undefined }, () => {
    assert.equal(isVerbose(), true);
  });
  withEnv({ RUNNER_DEBUG: undefined, INPUT_DEBUG: 'false', IOLITE_DEBUG: undefined }, () => {
    assert.equal(isVerbose(), false);
  });
});

test('the answer is memoized until the cache is reset', () => {
  withEnv({ RUNNER_DEBUG: undefined, INPUT_DEBUG: undefined, IOLITE_DEBUG: undefined }, () => {
    assert.equal(isVerbose(), false);
    process.env.RUNNER_DEBUG = '1';
    assert.equal(isVerbose(), false, 'memoized');
    resetVerboseCache();
    assert.equal(isVerbose(), true, 'after reset');
    delete process.env.RUNNER_DEBUG;
  });
});

// ---------------------------------------------------------------------------
// emission
// ---------------------------------------------------------------------------

test('debugLog is silent unless verbose', () => {
  withEnv({ RUNNER_DEBUG: undefined, INPUT_DEBUG: undefined, IOLITE_DEBUG: undefined }, () => {
    const out = captureStdout(() => debugLog('quiet please'));
    assert.equal(out, '');
  });
  withEnv({ RUNNER_DEBUG: '1', INPUT_DEBUG: undefined, IOLITE_DEBUG: undefined }, () => {
    const out = captureStdout(() => debugLog('now speaking'));
    assert.ok(out.includes('now speaking'), out);
  });
});

test('debugLog, info, and warn all redact', () => {
  withEnv({ RUNNER_DEBUG: '1', INPUT_DEBUG: undefined, IOLITE_DEBUG: undefined }, () => {
    const secret = 'sk-ant-abc123';
    const out = captureStdout(() => {
      debugLog(`debug ${secret}`);
      info(`info ${secret}`);
      warn(`warn ${secret}`);
    });
    assert.ok(!out.includes(secret), out);
    assert.equal((out.match(/\*\*\*/g) ?? []).length, 3, out);
  });
});

test('a logged message cannot open a workflow command', () => {
  const out = captureStdout(() => info(`ok${LF}::error::injected`));
  assert.ok(!out.includes(`${LF}::error::`), out);
});
