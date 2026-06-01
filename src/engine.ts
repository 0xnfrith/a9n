// The workflow engine: run a workflow script in a sandbox with the same DSL
// Claude Code's Workflow tool exposes — agent(), parallel(), pipeline(),
// phase(), log(), workflow(), plus the `args` and `budget` globals — but with
// an AI-agnostic agent() that hits any configured LLM provider.

import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import type { AgentOptions, LlmConfig, RunResult, SharedState, WorkflowMeta } from './types.ts';
import { callModel, callStructured } from './llm.ts';

const HARD_AGENT_CAP = 1000;

/** Concurrency limiter: at most `max` agent() calls run their LLM request at once. */
class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>(res => this.waiters.push(res));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the held slot straight to the next waiter
    else this.active--; // nobody waiting → free a slot
  }
}

export interface RunWorkflowOptions {
  source: string;
  args?: unknown;
  budget?: number | null;
  cfg: LlmConfig;
  /** Resolve a workflow name (from workflow("name")) to its script source. */
  resolveNamed?: (name: string) => Promise<string>;
  /** Internal: shared state + depth threaded through nested workflow() calls. */
  shared?: SharedState;
  depth?: number;
  /** Collectors shared with the parent run so nested logs/phases surface too. */
  logs?: string[];
  phases?: string[];
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunResult> {
  const logs = opts.logs ?? [];
  const phasesSeen = opts.phases ?? [];
  const depth = opts.depth ?? 0;

  const shared: SharedState =
    opts.shared ?? {
      agentCounter: 0,
      spent: 0,
      budgetTotal: opts.budget ?? null,
      semaphore: new Semaphore(Math.max(1, Math.min(16, availableParallelism() - 2))),
      maxAgents: HARD_AGENT_CAP,
    };

  if (!/(^|\n)\s*export\s+const\s+meta\s*=/.test(opts.source)) {
    return {
      ok: false,
      agents: shared.agentCounter,
      tokens: shared.spent,
      phases: phasesSeen,
      logs,
      error: 'workflow script must begin with `export const meta = { name, description, ... }`',
    };
  }

  let currentPhase = '';

  const log = (message: string): void => {
    const line = String(message);
    logs.push(line);
    // stderr only — stdout is the MCP JSON-RPC channel.
    console.error(`[a9n] ${line}`);
  };

  const phase = (title: string): void => {
    currentPhase = String(title);
    if (!phasesSeen.includes(currentPhase)) phasesSeen.push(currentPhase);
    log(`◆ phase: ${currentPhase}`);
  };

  const budget = {
    get total() {
      return shared.budgetTotal;
    },
    spent() {
      return shared.spent;
    },
    remaining() {
      return shared.budgetTotal == null ? Infinity : Math.max(0, shared.budgetTotal - shared.spent);
    },
  };

  const agent = async (prompt: string, agentOpts: AgentOptions = {}): Promise<unknown> => {
    if (typeof prompt !== 'string') throw new Error('agent(prompt, opts?) requires a string prompt');
    if (shared.agentCounter >= shared.maxAgents) {
      throw new Error(`a9n agent cap (${shared.maxAgents}) reached — likely a runaway loop`);
    }
    if (shared.budgetTotal != null && shared.spent >= shared.budgetTotal) {
      throw new Error(`a9n token budget exhausted (${shared.spent}/${shared.budgetTotal})`);
    }
    shared.agentCounter++;
    const n = shared.agentCounter;
    const label = agentOpts.label || `agent-${n}`;
    const ph = agentOpts.phase || currentPhase;
    const model = agentOpts.model || opts.cfg.model;
    if (agentOpts.isolation || agentOpts.agentType) {
      log(`note: agent "${label}" requested isolation/agentType — ignored in a9n v1`);
    }
    log(`▸ ${ph ? `${ph} / ` : ''}${label} (${model})`);

    await shared.semaphore.acquire();
    try {
      if (agentOpts.schema) {
        const { value, usage } = await callStructured(opts.cfg, {
          model,
          prompt,
          system: agentOpts.system,
          schema: agentOpts.schema,
        });
        shared.spent += usage.completionTokens;
        return value;
      }
      const { text, usage } = await callModel(opts.cfg, {
        model,
        prompt,
        system: agentOpts.system,
        temperature: agentOpts.temperature,
      });
      shared.spent += usage.completionTokens;
      return text;
    } finally {
      shared.semaphore.release();
    }
  };

  // parallel(): barrier. Awaits all thunks; a thunk that throws resolves to null
  // so the call itself never rejects (filter with .filter(Boolean)).
  const parallel = (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(
      (thunks ?? []).map(async t => {
        try {
          return await t();
        } catch (e) {
          log(`parallel task failed: ${(e as Error).message}`);
          return null;
        }
      })
    );

  // pipeline(): each item flows through every stage independently, NO barrier
  // between stages. Concurrency is bounded at the agent() layer, so we can
  // launch every item's chain at once. A stage that throws drops that item to
  // null and skips its remaining stages.
  const pipeline = (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => Promise<unknown>>
  ): Promise<unknown[]> =>
    Promise.all(
      (items ?? []).map(async (original, index) => {
        let value: unknown = original;
        for (const stage of stages) {
          try {
            value = await stage(value, original, index);
          } catch (e) {
            log(`pipeline item ${index} dropped: ${(e as Error).message}`);
            return null;
          }
        }
        return value;
      })
    );

  // workflow(): run another a9n workflow inline, sharing this run's counter,
  // budget, concurrency and abort scope. Nesting is one level only.
  const workflow = async (nameOrRef: string | { scriptPath: string }, childArgs?: unknown): Promise<unknown> => {
    if (depth >= 1) throw new Error('workflow() nesting is one level only');
    const childSource = await resolveChildSource(nameOrRef, opts.resolveNamed);
    log(`▸ nested workflow: ${typeof nameOrRef === 'string' ? nameOrRef : nameOrRef.scriptPath}`);
    const child = await runWorkflow({
      source: childSource,
      args: childArgs,
      cfg: opts.cfg,
      resolveNamed: opts.resolveNamed,
      shared,
      depth: depth + 1,
      logs,
      phases: phasesSeen,
    });
    if (!child.ok) throw new Error(child.error ?? 'nested workflow failed');
    return child.result;
  };

  const sandbox: Record<string, unknown> = {
    __a9n: { meta: undefined as WorkflowMeta | undefined },
    agent,
    parallel,
    pipeline,
    phase,
    log,
    workflow,
    budget,
    args: opts.args,
    console: { log, error: log, warn: log, info: log },
  };

  // Transform: the script declares `export const meta = {...}` at module top.
  // We can't run a real ES module here, so rewrite that one declaration into an
  // assignment onto our sandbox object. Script bodies never *read* `meta`, only
  // the harness does — so nothing downstream breaks.
  const transformed = opts.source.replace(/(^|\n)(\s*)export\s+const\s+meta\s*=/, '$1$2__a9n.meta =');
  const wrapped = `(async () => {\n${transformed}\n})()`;

  const context = vm.createContext(sandbox);
  let result: unknown;
  try {
    const script = new vm.Script(wrapped, { filename: 'workflow.a9n.js' });
    result = await script.runInContext(context);
  } catch (e) {
    return {
      ok: false,
      meta: (sandbox.__a9n as { meta?: WorkflowMeta }).meta,
      agents: shared.agentCounter,
      tokens: shared.spent,
      phases: phasesSeen,
      logs,
      error: (e as Error).message,
    };
  }

  const meta = (sandbox.__a9n as { meta?: WorkflowMeta }).meta;
  if (depth === 0 && (!meta || !meta.name)) {
    return {
      ok: false,
      agents: shared.agentCounter,
      tokens: shared.spent,
      phases: phasesSeen,
      logs,
      error: '`meta` is missing required field `name` — declare `export const meta = { name, description }`',
    };
  }

  return {
    ok: true,
    meta,
    result,
    agents: shared.agentCounter,
    tokens: shared.spent,
    phases: phasesSeen,
    logs,
  };
}

async function resolveChildSource(
  nameOrRef: string | { scriptPath: string },
  resolveNamed?: (name: string) => Promise<string>
): Promise<string> {
  if (typeof nameOrRef === 'object' && nameOrRef && 'scriptPath' in nameOrRef) {
    const p = nameOrRef.scriptPath;
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
    if (!existsSync(abs)) throw new Error(`workflow scriptPath not found: ${p}`);
    return readFile(abs, 'utf8');
  }
  if (typeof nameOrRef === 'string') {
    if (!resolveNamed) throw new Error(`no workflows directory configured to resolve workflow("${nameOrRef}")`);
    return resolveNamed(nameOrRef);
  }
  throw new Error('workflow() takes a name string or { scriptPath }');
}

/**
 * Build a resolver that maps a workflow name to its script source by searching
 * a list of directories for `<name>.workflow.js` (or `<name>.js`).
 */
export function makeNamedResolver(dirs: string[]): (name: string) => Promise<string> {
  return async (name: string) => {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '');
    for (const dir of dirs) {
      if (!dir) continue;
      for (const candidate of [`${safe}.workflow.js`, `${safe}.js`]) {
        const p = join(dir, candidate);
        if (existsSync(p)) return readFile(p, 'utf8');
      }
    }
    throw new Error(`saved workflow "${name}" not found in: ${dirs.filter(Boolean).join(', ') || '(none)'}`);
  };
}
