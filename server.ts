#!/usr/bin/env bun
// a9n MCP server — a single stdio MCP server exposing one tool, `workflow`.
// Mirrors the shape of the visualize plugin's server, minus the HTTP/canvas
// bits: read version from package.json, register ListTools/CallTool, run over
// a StdioServerTransport. All diagnostics go to stderr — stdout is the
// JSON-RPC channel and any stray write corrupts it.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolveConfig } from './src/llm.ts';
import { buildTools, resolveWorkflowDirs } from './src/tool.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = await readPackageVersion();

async function main() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT?.trim() || resolve(__dirname);
  const cfg = resolveConfig(process.env);
  const workflowDirs = resolveWorkflowDirs(process.env, pluginRoot);
  const tools = buildTools(cfg, workflowDirs);

  if (!cfg.apiKey) {
    console.error(
      '[a9n] warning: no API key set (A9N_API_KEY / OPENAI_API_KEY). agent() calls will fail until one is configured.'
    );
  }
  console.error(`[a9n] provider: ${cfg.baseUrl} · default model: ${cfg.model}`);

  const server = new Server(
    { name: 'a9n', version: PKG_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'AI-agnostic workflow orchestration. Call `workflow` with a `script` that begins with ' +
        '`export const meta = {...}` and uses agent()/parallel()/pipeline()/phase()/log(). ' +
        'agent() runs against the configured OpenAI-compatible provider, so the same script is ' +
        'portable across LLMs. Use it to fan out, pipeline, and verify across many model calls ' +
        'deterministically. See the /workflow-a9n skill for authoring guidance.',
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const tool = tools.find(t => t.name === req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] };
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool ${tool.name} failed: ${(err as Error).message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const cleanup = () => process.exit(0);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

async function readPackageVersion(): Promise<string> {
  const url = new URL('./package.json', import.meta.url);
  const pkg = JSON.parse(await Bun.file(url).text()) as { version?: string };
  return pkg.version ?? '0.0.0';
}

main().catch(err => {
  console.error('[a9n] fatal:', err);
  process.exit(1);
});
