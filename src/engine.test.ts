import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { LlmConfig } from './types.ts';
import { runWorkflow } from './engine.ts';

// A minimal OpenAI-compatible mock so the agent() path is exercised end-to-end
// (engine → llm → schema retry) with zero external network.
let server: ReturnType<typeof Bun.serve>;
let cfg: LlmConfig;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        response_format?: { type?: string };
        messages: Array<{ role: string; content: string }>;
      };
      const lastUser = [...body.messages].reverse().find(m => m.role === 'user')?.content ?? '';
      const wantsJson = body.response_format?.type === 'json_object';
      const content = wantsJson ? '{"ok":true,"n":7}' : `MOCK:${lastUser}`;
      return Response.json({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  });
  cfg = { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: 'test', model: 'mock' };
});

afterAll(() => server.stop(true));

describe('runWorkflow sandbox', () => {
  test('extracts meta, runs phases/log, returns the script value', async () => {
    const source = `
export const meta = { name: 'demo', description: 'd', phases: [{ title: 'Work' }] };
phase('Work');
log('hello');
return { doubled: args.n * 2 };
`;
    const r = await runWorkflow({ source, args: { n: 21 }, cfg });
    expect(r.ok).toBe(true);
    expect(r.meta?.name).toBe('demo');
    expect((r.result as any).doubled).toBe(42);
    expect(r.phases).toContain('Work');
  });

  test('rejects a script with no meta', async () => {
    const r = await runWorkflow({ source: `return 1;`, cfg });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('meta');
  });

  test('parallel is a barrier and swallows failures to null', async () => {
    const source = `
export const meta = { name: 'p', description: 'd' };
const out = await parallel([
  () => Promise.resolve('a'),
  () => { throw new Error('boom'); },
  () => Promise.resolve('c'),
]);
return out;
`;
    const r = await runWorkflow({ source, cfg });
    expect(r.result).toEqual(['a', null, 'c']);
  });

  test('pipeline runs each item through stages and drops throwers', async () => {
    const source = `
export const meta = { name: 'pl', description: 'd' };
return await pipeline(
  [1, 2, 3],
  (n) => n + 1,
  (n) => { if (n === 3) throw new Error('skip'); return n * 10; },
);
`;
    const r = await runWorkflow({ source, cfg });
    // 1->2->20, 2->3->throw->null, 3->4->40
    expect(r.result).toEqual([20, null, 40]);
  });

  test('agent() returns model text without a schema', async () => {
    const source = `
export const meta = { name: 'a', description: 'd' };
return await agent('say hi');
`;
    const r = await runWorkflow({ source, cfg });
    expect(r.result).toBe('MOCK:say hi');
    expect(r.agents).toBe(1);
    expect(r.tokens).toBe(5);
  });

  test('agent() with schema returns a validated object', async () => {
    const source = `
export const meta = { name: 's', description: 'd' };
return await agent('give me json', {
  schema: { type: 'object', required: ['ok', 'n'], properties: { ok: { type: 'boolean' }, n: { type: 'integer' } } },
});
`;
    const r = await runWorkflow({ source, cfg });
    expect(r.result).toEqual({ ok: true, n: 7 });
  });

  test('budget exhaustion stops further agents', async () => {
    const source = `
export const meta = { name: 'b', description: 'd' };
await agent('one');   // spends 5
await agent('two');   // budget is 4 -> should throw
return 'unreached';
`;
    const r = await runWorkflow({ source, budget: 4, cfg });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('budget');
    expect(r.agents).toBe(1); // second call rejected before incrementing past the cap check
  });
});
