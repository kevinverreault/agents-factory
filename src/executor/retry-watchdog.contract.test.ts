// Seam 3: the CLI's retry watchdog and its wait caps (ADR 0008). Runs the
// bundled CLI against a local fake Messages API, with an API key and an empty
// config dir, so it spends no usage and no real credential is loaded.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type Reply = (response: ServerResponse) => void;

// A usage-limit rejection, as the subscription API sends it.
const usageLimited = (resetInSeconds: number): Reply => (response) => {
  response.writeHead(429, {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(Math.ceil(Date.now() / 1000 + resetInSeconds)),
  });
  response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } }));
};

const overloaded: Reply = (response) => {
  response.writeHead(529, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
};

function answer(stream: boolean): Reply {
  const message = {
    id: 'msg_skeleton',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [] as unknown[],
    stop_reason: null as string | null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  return (response) => {
    if (!stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'WINDOW-RESET' }], stop_reason: 'end_turn' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events: [string, unknown][] = [
      ['message_start', { type: 'message_start', message }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'WINDOW-RESET' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  };
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

// Serves the scripted replies to model requests in order, then answers.
async function fakeApi(script: Reply[]) {
  let modelRequests = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
        response.writeHead(404).end();
        return;
      }
      const reply = script[modelRequests++] ?? answer(JSON.parse(body).stream === true);
      reply(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => modelRequests };
}

async function runAgainst(baseUrl: string, watchdog: Record<string, string>) {
  const { ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ...env } = process.env;
  const messages: SDKMessage[] = [];
  const started = Date.now();
  let failure: string | undefined;
  const run = query({
    prompt: 'Say hello.',
    options: {
      model: 'claude-haiku-5-5',
      permissionMode: 'default',
      tools: [],
      maxTurns: 1,
      settingSources: [],
      env: {
        ...env,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'sk-ant-skeleton-fake',
        CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'factory-watchdog-')),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ...watchdog,
      },
    },
  });
  try {
    for await (const message of run) messages.push(message);
  } catch (error) {
    // The SDK throws once the CLI returns an error result.
    failure = String(error);
  }
  const result = messages.find((message) => message.type === 'result');
  const retries = messages.filter((message) => message.type === 'system' && message.subtype === 'api_retry');
  return { result, retries, failure, elapsedMs: Date.now() - started };
}

describe('retry watchdog on usage limits', () => {
  test('a usage limit that resets within the cap is waited out inside the run', async () => {
    const api = await fakeApi([usageLimited(4)]);

    const outcome = await runAgainst(api.url, {
      CLAUDE_CODE_RETRY_WATCHDOG: '1',
      CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: '60000',
      CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: '60000',
    });

    // One sleep until the reset, not the ordinary backoff.
    expect(outcome.retries).toHaveLength(1);
    expect(outcome.retries[0]).toMatchObject({ error: 'rate_limit', retry_delay_ms: expect.toSatisfy((ms: number) => ms >= 3_000) });
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(3_000);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.result).toMatchObject({ subtype: 'success', result: expect.stringContaining('WINDOW-RESET') });
  });

  test('a usage limit that resets beyond the cap fails the run at once instead of waiting', async () => {
    const api = await fakeApi(Array.from({ length: 20 }, () => usageLimited(3 * 24 * 3600)));

    const outcome = await runAgainst(api.url, {
      CLAUDE_CODE_RETRY_WATCHDOG: '1',
      CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: '60000',
      CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: '60000',
    });

    // No sleep at all: the CLI gives up as soon as it sees the reset is too far.
    expect(outcome.retries).toEqual([]);
    expect(outcome.elapsedMs).toBeLessThan(10_000);
    expect(outcome.failure).toMatch(/429/);
  });

  test('the total wait cap also bounds endless overloaded retries', async () => {
    const api = await fakeApi(Array.from({ length: 1_000 }, () => overloaded));

    const outcome = await runAgainst(api.url, {
      CLAUDE_CODE_RETRY_WATCHDOG: '1',
      CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: '60000',
      CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: '20000',
    });

    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(15_000);
    expect(outcome.elapsedMs).toBeLessThan(90_000);
    expect(outcome.failure).toMatch(/529/);
  });

  test('without the watchdog (HITL runs), a usage limit gets only the ordinary bounded retries', async () => {
    const api = await fakeApi([usageLimited(4)]);

    const outcome = await runAgainst(api.url, {});

    expect(outcome.retries[0]).toMatchObject({ error: 'rate_limit', max_retries: 10, retry_delay_ms: expect.toSatisfy((ms: number) => ms < 3_000) });
  });
});
