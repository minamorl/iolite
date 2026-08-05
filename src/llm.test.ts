// @ts-ignore -- the .ts extension is required by `node --experimental-strip-types`
import { LLMClient, BudgetExhaustedError } from './llm.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * No network anywhere in here: every test drives the `deps.client` seam with a
 * hand-built responder and an injected `sleep` that records instead of waiting.
 */

type Responder = (params: any, attempt: number) => unknown;

function fakeClient(responder: Responder): { calls: any[]; messages: { create: (p: any) => Promise<any> } } {
  const calls: any[] = [];
  return {
    calls,
    messages: {
      create: async (params: any): Promise<any> => {
        calls.push(params);
        return responder(params, calls.length);
      },
    },
  };
}

function textResponse(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 11, output_tokens: 22 },
    ...over,
  };
}

function httpError(status: number, extra: Record<string, unknown> = {}): Error {
  const err = new Error(`http ${status}`) as Error & Record<string, unknown>;
  err.name = 'APIError';
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function harness(responder: Responder, maxCalls = 10) {
  const client = fakeClient(responder);
  const sleeps: number[] = [];
  const llm = new LLMClient('test-key', 'claude-test-model', 2048, maxCalls, {
    client,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  return { llm, client, sleeps };
}

const CALL = { system: 'system prompt', user: 'user prompt', label: 'lens:test' };

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

test('budget is a hard ceiling: 5 calls with 3 slots makes exactly 3 requests', async () => {
  const { llm, client } = harness(() => textResponse('{"ok": true}'), 3);
  const calls = [0, 1, 2, 3, 4].map((i) => ({ system: 's', user: 'u', label: `lens:${i}` }));

  const results = await llm.generateJsonAll<{ ok: boolean }>(calls);

  assert.equal(client.calls.length, 3, 'exactly three requests reached the API');
  assert.equal(results.length, 5, 'the result array stays positional');
  assert.deepEqual(results.slice(0, 3), [{ ok: true }, { ok: true }, { ok: true }]);
  assert.deepEqual(results.slice(3), [null, null], 'unfunded calls resolve to null');
  assert.equal(llm.callsMade(), 3);
  assert.equal(llm.callsRemaining(), 0);
  assert.equal(llm.budgetExhausted(), true);
});

test('generate throws BudgetExhaustedError once the budget is gone', async () => {
  const { llm, client } = harness(() => textResponse('{"a": 1}'), 1);

  await llm.generate(CALL);
  await assert.rejects(
    () => llm.generate(CALL),
    (err: unknown) => err instanceof BudgetExhaustedError,
  );
  // ...and generateJson turns that into a null instead of a crash.
  assert.equal(await llm.generateJson(CALL), null);
  assert.equal(client.calls.length, 1);
  assert.equal(llm.callsMade(), 1);
});

test('budget accounting starts empty and reports remaining slots', () => {
  const { llm } = harness(() => textResponse('{}'), 4);
  assert.equal(llm.callsMade(), 0);
  assert.equal(llm.callsRemaining(), 4);
  assert.equal(llm.budgetExhausted(), false);
  assert.equal(llm.getModel(), 'claude-test-model');
});

// ---------------------------------------------------------------------------
// retries
// ---------------------------------------------------------------------------

test('retries a 429 and then succeeds, without spending a second budget slot', async () => {
  const { llm, client, sleeps } = harness((_params, attempt) => {
    if (attempt === 1) throw httpError(429);
    return textResponse('{"a": 1}');
  });

  const out = await llm.generateJson<{ a: number }>(CALL);

  assert.deepEqual(out, { a: 1 });
  assert.equal(client.calls.length, 2);
  assert.deepEqual(sleeps, [500], 'first backoff is 500ms');
  assert.equal(llm.callsMade(), 1, 'retries of one logical call are free');
});

test('honours a retry-after header', async () => {
  const { llm, sleeps } = harness((_params, attempt) => {
    if (attempt === 1) throw httpError(429, { headers: { 'Retry-After': '2' } });
    return textResponse('{"a": 1}');
  });

  await llm.generate(CALL);
  assert.deepEqual(sleeps, [2000]);
});

test('honours a retry-after on a Headers-like object', async () => {
  const headers = { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '3' : null) };
  const { llm, sleeps } = harness((_params, attempt) => {
    if (attempt === 1) throw httpError(503, { headers });
    return textResponse('{"a": 1}');
  });

  await llm.generate(CALL);
  assert.deepEqual(sleeps, [3000]);
});

test('does not retry a 400', async () => {
  const { llm, client, sleeps } = harness(() => {
    throw httpError(400);
  });

  await assert.rejects(() => llm.generate(CALL), /http 400/);
  assert.equal(client.calls.length, 1, 'a permanent error is not retried');
  assert.deepEqual(sleeps, []);
  assert.equal(llm.callsMade(), 1);
});

test('does not retry 401, 403 or 404', async () => {
  for (const status of [401, 403, 404]) {
    const { llm, client } = harness(() => {
      throw httpError(status);
    });
    await assert.rejects(() => llm.generate(CALL));
    assert.equal(client.calls.length, 1, `status ${status} must not be retried`);
  }
});

test('retries an overloaded 529 up to three attempts, then gives up', async () => {
  const { llm, client, sleeps } = harness(() => {
    throw httpError(529);
  });

  await assert.rejects(() => llm.generate(CALL), /http 529/);
  assert.equal(client.calls.length, 3, 'three attempts total');
  assert.deepEqual(sleeps, [500, 1000], 'exponential backoff between attempts');
});

test('retries a 500 and finds the status on alternative error shapes', async () => {
  const { llm, client } = harness((_params, attempt) => {
    if (attempt === 1) {
      const err = new Error('server') as Error & Record<string, unknown>;
      err.statusCode = 500;
      throw err;
    }
    if (attempt === 2) {
      const err = new Error('server') as Error & Record<string, unknown>;
      err.response = { status: 503 };
      throw err;
    }
    return textResponse('{"a": 1}');
  });

  const res = await llm.generate(CALL);
  assert.equal(res.text, '{"a": 1}');
  assert.equal(client.calls.length, 3);
});

test('does not retry a 403 hidden in response.status', async () => {
  const { llm, client } = harness(() => {
    const err = new Error('forbidden') as Error & Record<string, unknown>;
    err.response = { status: 403 };
    throw err;
  });

  await assert.rejects(() => llm.generate(CALL));
  assert.equal(client.calls.length, 1);
});

test('retries a connection error that carries no status', async () => {
  const { llm, client } = harness((_params, attempt) => {
    if (attempt === 1) {
      const err = new Error('socket hang up') as Error & Record<string, unknown>;
      err.code = 'ECONNRESET';
      throw err;
    }
    return textResponse('{"a": 1}');
  });

  await llm.generate(CALL);
  assert.equal(client.calls.length, 2);
});

// ---------------------------------------------------------------------------
// response shapes
// ---------------------------------------------------------------------------

test('surfaces a max_tokens stop reason and still returns the text', async () => {
  const { llm } = harness(() =>
    textResponse('[{"a": 1}, {"b": ', { stop_reason: 'max_tokens' }),
  );

  const res = await llm.generate(CALL);
  assert.equal(res.stopReason, 'max_tokens');
  assert.equal(res.text, '[{"a": 1}, {"b": ');
  assert.equal(res.inputTokens, 11);
  assert.equal(res.outputTokens, 22);
  assert.equal(res.label, 'lens:test');
});

test('generateJson salvages a max_tokens body instead of losing it', async () => {
  const { llm } = harness(() =>
    textResponse('[{"id": "a-1"}, {"id": "a-2"}, {"id": ', { stop_reason: 'max_tokens' }),
  );

  const out = await llm.generateJson<{ id: string }[]>(CALL);
  assert.deepEqual(out, [{ id: 'a-1' }, { id: 'a-2' }]);
});

test('handles an empty content array', async () => {
  const { llm } = harness(() => ({ content: [], stop_reason: 'end_turn', usage: {} }));

  const res = await llm.generate(CALL);
  assert.equal(res.text, '');
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.inputTokens, 0);
  assert.equal(res.outputTokens, 0);

  assert.equal(await llm.generateJson(CALL), null, 'an empty body is not a crash');
});

test('handles a missing or non-array content field', async () => {
  const { llm } = harness((_params, attempt) => (attempt === 1 ? {} : { content: 'nope' }));
  assert.equal((await llm.generate(CALL)).text, '');
  assert.equal((await llm.generate(CALL)).text, '');
});

test('skips non-text blocks and concatenates multiple text blocks', async () => {
  const { llm } = harness(() => ({
    content: [
      { type: 'thinking', thinking: 'ignored' },
      { type: 'text', text: '{"a":' },
      { type: 'tool_use', name: 'ignored' },
      { type: 'text', text: ' 1}' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 2 },
  }));

  const res = await llm.generate(CALL);
  assert.equal(res.text, '{"a": 1}');
  assert.deepEqual(await llm.generateJson<{ a: number }>(CALL), { a: 1 });
});

// ---------------------------------------------------------------------------
// generateJson never throws
// ---------------------------------------------------------------------------

test('generateJson returns null on an unparseable body', async () => {
  const { llm } = harness(() => textResponse('I will not be answering in JSON today.'));
  assert.equal(await llm.generateJson(CALL), null);
});

test('generateJson returns null when the API keeps failing', async () => {
  const { llm } = harness(() => {
    throw httpError(400);
  });
  assert.equal(await llm.generateJson(CALL), null);
  assert.equal(llm.callsMade(), 1);
});

test('generateJson unwraps a fenced body', async () => {
  const { llm } = harness(() => textResponse('Sure:\n```json\n{"a": [1, 2]}\n```'));
  assert.deepEqual(await llm.generateJson<{ a: number[] }>(CALL), { a: [1, 2] });
});

// ---------------------------------------------------------------------------
// request shape and concurrency
// ---------------------------------------------------------------------------

test('sends the configured model, prompts and token cap', async () => {
  const { llm, client } = harness(() => textResponse('{}'));

  await llm.generate({ system: 'SYS', user: 'USR', label: 'lens:a' });
  await llm.generate({ system: 'SYS', user: 'USR', label: 'lens:b', maxTokens: 99 });

  assert.equal(client.calls[0].model, 'claude-test-model');
  assert.equal(client.calls[0].max_tokens, 2048, 'falls back to the default cap');
  assert.equal(client.calls[0].system, 'SYS');
  assert.deepEqual(client.calls[0].messages, [{ role: 'user', content: 'USR' }]);
  assert.equal(client.calls[1].max_tokens, 99, 'per-call cap wins');
});

test('generateJsonAll keeps results positional when some calls fail', async () => {
  const { llm } = harness((params) =>
    params.messages[0].content === 'bad' ? textResponse('not json at all') : textResponse('{"ok": 1}'),
  );

  const out = await llm.generateJsonAll<{ ok: number }>([
    { system: 's', user: 'good', label: 'a' },
    { system: 's', user: 'bad', label: 'b' },
    { system: 's', user: 'good', label: 'c' },
  ]);

  assert.deepEqual(out, [{ ok: 1 }, null, { ok: 1 }]);
});

test('generateJsonAll respects the concurrency cap', async () => {
  let inFlight = 0;
  let peak = 0;
  const client = {
    messages: {
      create: async (): Promise<any> => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return textResponse('{"a": 1}');
      },
    },
  };
  const llm = new LLMClient('k', 'm', 1024, 100, { client, sleep: async () => {} });

  const calls = Array.from({ length: 6 }, (_v, i) => ({ system: 's', user: 'u', label: `l${i}` }));
  const out = await llm.generateJsonAll(calls, 2);

  assert.equal(out.length, 6);
  assert.ok(peak <= 2, `peak concurrency was ${peak}, expected at most 2`);
  assert.equal(llm.callsMade(), 6);
});

test('generateJsonAll on an empty list makes no calls', async () => {
  const { llm, client } = harness(() => textResponse('{}'));
  assert.deepEqual(await llm.generateJsonAll([]), []);
  assert.equal(client.calls.length, 0);
  assert.equal(llm.callsMade(), 0);
});

// ---------------------------------------------------------------------------
// logging discipline
// ---------------------------------------------------------------------------

test('never logs the prompt or the response body', async () => {
  const systemMarker = 'SYSTEM-MARKER-9f3a';
  const userMarker = 'USER-MARKER-2b7c';
  const responseMarker = 'RESPONSE-MARKER-77e1';

  const { llm } = harness((_params, attempt) => {
    if (attempt === 1) throw httpError(429, { message: `rate limited on ${userMarker}` });
    // Unparseable on purpose: the "could not parse" path is where a naive
    // implementation dumps the body into the log.
    return textResponse(`sorry, no JSON. ${responseMarker}`, { stop_reason: 'max_tokens' });
  });

  const captured: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const capture =
    (original: typeof stdout) =>
    (chunk: any, ...rest: any[]): boolean => {
      captured.push(String(chunk));
      return (original as any)(chunk, ...rest);
    };

  process.stdout.write = capture(stdout) as typeof process.stdout.write;
  process.stderr.write = capture(stderr) as typeof process.stderr.write;
  try {
    await llm.generateJson({ system: systemMarker, user: userMarker, label: 'lens:secret' });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }

  const log = captured.join('');
  assert.ok(!log.includes(systemMarker), 'system prompt leaked into the log');
  assert.ok(!log.includes(userMarker), 'user prompt leaked into the log');
  assert.ok(!log.includes(responseMarker), 'response body leaked into the log');
  assert.ok(log.includes('lens:secret'), 'the label is what makes a log line useful');
});

test('logs token counts, stop reason and duration for a successful call', async () => {
  const { llm } = harness(() => textResponse('{"a": 1}', { stop_reason: 'end_turn' }));

  const captured: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...rest: any[]): boolean => {
    captured.push(String(chunk));
    return (stdout as any)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    await llm.generate({ system: 's', user: 'u', label: 'lens:counted' });
  } finally {
    process.stdout.write = stdout;
  }

  const log = captured.join('');
  assert.match(log, /lens:counted/);
  assert.match(log, /11 in \/ 22 out/);
  assert.match(log, /stop=end_turn/);
  assert.match(log, /\d+ms/);
});
