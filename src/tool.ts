// The single MCP tool a9n exposes: `workflow`. Its input signature mirrors
// Claude Code's Workflow tool (script / scriptPath / name / args / title /
// description), so a script written for one runs on the other — the only
// difference is that agent() here is provider-agnostic.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { LlmConfig } from './types.ts';
import { makeNamedResolver, runWorkflow } from './engine.ts';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export function buildTools(cfg: LlmConfig, workflowDirs: string[]): ToolDescriptor[] {
  const resolveNamed = makeNamedResolver(workflowDirs);

  return [
    {
      name: 'workflow',
      description:
        'Run an AI-agnostic workflow script that orchestrates LLM agents deterministically (loops, fan-out, pipelines). ' +
        'Same script DSL as Claude Code\'s Workflow tool, but agent() calls the configured OpenAI-compatible provider instead of Claude subagents.\n\n' +
        'The script is plain JavaScript and MUST begin with `export const meta = { name, description, phases? }` (a pure literal). ' +
        'The body runs in an async sandbox and can use:\n' +
        '- agent(prompt, opts?) → Promise<string|object>. Without `schema` returns the model\'s text; with `opts.schema` (a JSON Schema) returns a validated object (retried until valid). opts: {label, phase, schema, model, system, temperature}.\n' +
        '- parallel(thunks) → Promise<any[]>. Barrier: awaits all; a thrown thunk resolves to null (filter with .filter(Boolean)).\n' +
        '- pipeline(items, ...stages) → Promise<any[]>. Each item flows through every stage independently, NO barrier. Stage signature (prev, original, index). A throwing stage drops that item to null.\n' +
        '- phase(title), log(message) — progress grouping/notes (surfaced in the result).\n' +
        '- workflow(nameOrRef, args?) — run another a9n workflow inline (one level deep).\n' +
        '- args — the value passed as this tool\'s `args`, verbatim.\n' +
        '- budget — { total, spent(), remaining() } token target (set via this tool\'s `budget`; total is null when unset).\n\n' +
        'Concurrency is capped automatically; total agents are capped at 1000. agent()/parallel()/pipeline() may run up to ~min(16, cores-2) LLM calls at once. ' +
        'Returns { ok, meta, result, agents, tokens, phases, logs }, where `result` is the script\'s top-level return value.\n\n' +
        'Provide exactly one of `script`, `scriptPath`, or `name`. Configure the provider via the plugin\'s base_url / api_key / model (or OPENAI_* env).',
      inputSchema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description:
              'Inline workflow script. Must start with `export const meta = {...}` followed by the body using agent()/parallel()/pipeline()/phase()/log().',
          },
          scriptPath: {
            type: 'string',
            description: 'Path to a .workflow.js / .js file on disk. Takes precedence over `script` and `name`.',
          },
          name: {
            type: 'string',
            description:
              'Name of a saved workflow (<name>.workflow.js) found in the configured workflows directory or the plugin\'s bundled workflows/.',
          },
          args: {
            description:
              'Arbitrary JSON value exposed to the script as the global `args`, verbatim. Pass arrays/objects as real JSON, not a stringified blob.',
          },
          budget: {
            type: ['number', 'null'],
            description:
              'Optional output-token target exposed as budget.total. Once spent reaches it, further agent() calls throw. Omit/null for unbounded.',
          },
          title: { type: 'string', description: 'Ignored — set the title in the script\'s meta block.' },
          description: { type: 'string', description: 'Ignored — set the description in the script\'s meta block.' },
        },
      },
      async handler(args) {
        const source = await resolveSource(args, workflowDirs, resolveNamed);
        const budget =
          typeof args.budget === 'number' ? args.budget : args.budget === null ? null : null;
        return runWorkflow({
          source,
          args: args.args,
          budget,
          cfg,
          resolveNamed,
        });
      },
    },
  ];
}

async function resolveSource(
  args: Record<string, unknown>,
  workflowDirs: string[],
  resolveNamed: (name: string) => Promise<string>
): Promise<string> {
  if (typeof args.scriptPath === 'string' && args.scriptPath) {
    const abs = isAbsolute(args.scriptPath) ? args.scriptPath : resolve(process.cwd(), args.scriptPath);
    if (!existsSync(abs)) throw new Error(`scriptPath not found: ${args.scriptPath}`);
    return readFile(abs, 'utf8');
  }
  if (typeof args.name === 'string' && args.name) {
    return resolveNamed(args.name);
  }
  if (typeof args.script === 'string' && args.script) {
    return args.script;
  }
  throw new Error('provide one of `script`, `scriptPath`, or `name`');
}

/** Workflow search dirs: an explicit env dir first, then the plugin's bundled workflows/. */
export function resolveWorkflowDirs(env: NodeJS.ProcessEnv, pluginRoot: string): string[] {
  const dirs: string[] = [];
  if (env.A9N_WORKFLOWS_DIR?.trim()) dirs.push(env.A9N_WORKFLOWS_DIR.trim());
  dirs.push(join(pluginRoot, 'workflows'));
  return dirs;
}
