#!/usr/bin/env bun
// End-to-end smoke test of the MCP server over a real stdio transport:
// spawn `bun server.ts`, complete the MCP handshake, list tools, and run a
// workflow that uses NO agent() calls — so the full MCP round-trip + engine is
// exercised without needing an LLM provider. Exits non-zero on any mismatch.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SCRIPT = `
export const meta = { name: 'smoke', description: 'no-LLM round trip', phases: [{ title: 'ping' }] };
phase('ping');
log('pong');
return { echo: args, sum: (args.nums || []).reduce((a, b) => a + b, 0) };
`;

async function main() {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['server.ts'],
    cwd: process.cwd(),
  });
  const client = new Client({ name: 'a9n-smoke', version: '0' }, { capabilities: {} });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  console.error('[smoke] tools:', names.join(', '));
  if (!names.includes('workflow')) throw new Error('expected a `workflow` tool');

  const res = (await client.callTool({
    name: 'workflow',
    arguments: { script: SCRIPT, args: { nums: [1, 2, 3], hi: 'there' } },
  })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

  if (res.isError) throw new Error(`tool returned error: ${res.content?.[0]?.text}`);
  const payload = JSON.parse(res.content[0].text) as {
    ok: boolean;
    result: { sum: number; echo: { hi: string } };
    phases: string[];
  };
  console.error('[smoke] result:', JSON.stringify(payload.result));

  if (!payload.ok) throw new Error('workflow did not succeed');
  if (payload.result.sum !== 6) throw new Error(`expected sum 6, got ${payload.result.sum}`);
  if (payload.result.echo.hi !== 'there') throw new Error('args did not round-trip');
  if (!payload.phases.includes('ping')) throw new Error('phase not recorded');

  console.error('[smoke] OK — MCP round-trip + engine verified');
  await client.close();
  process.exit(0);
}

main().catch(err => {
  console.error('[smoke] FAILED:', err.message);
  process.exit(1);
});
