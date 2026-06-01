# a9n

**AI-agnostic workflow orchestration** — a Claude Code plugin that ports Claude
Code's built-in `Workflow` tool to run against *any* OpenAI-compatible LLM
provider.

> `a9n` = `a`utomatio`n` with 9 letters between, the same numeronym pattern as
> `n8n` (`nodemation`). Where n8n wires nodes, a9n wires **agents**.

Claude Code's `Workflow` tool is excellent but Claude-only: every `agent()` call
spawns a Claude subagent. a9n keeps the entire script DSL — `agent()`,
`parallel()`, `pipeline()`, `phase()`, `log()`, `workflow()`, `args`, `budget` —
but `agent()` calls a configurable provider (OpenAI, Groq, Together, OpenRouter,
Ollama, vLLM, LM Studio, Anthropic-compatible gateways, …). Swapping models is a
base-URL + key + model change, no code change.

## What's in the box

- **One MCP server** (`a9n`, a bun stdio server) exposing **one tool**,
  `workflow`, whose input signature mirrors Claude Code's Workflow tool
  (`script` / `scriptPath` / `name` / `args` / `budget`).
- **One skill**, `/workflow-a9n`, that authors a script from a task and runs it.

## Requirements

- [`bun`](https://bun.sh) on `PATH`.
- An OpenAI-compatible chat-completions endpoint + (usually) an API key.

## Configure

Set via the plugin's user config (`base_url`, `api_key`, `model`,
`workflows_dir`) or environment variables:

| Setting        | Env (a9n)            | Falls back to        | Default                     |
| -------------- | -------------------- | -------------------- | --------------------------- |
| Base URL       | `A9N_BASE_URL`       | `OPENAI_BASE_URL`    | `https://api.openai.com/v1` |
| API key        | `A9N_API_KEY`        | `OPENAI_API_KEY`     | _(none)_                    |
| Default model  | `A9N_MODEL`          | `OPENAI_MODEL`       | `gpt-4o-mini`               |
| Workflows dir  | `A9N_WORKFLOWS_DIR`  | —                    | `<plugin>/workflows`        |

Examples:

```bash
# OpenAI
A9N_MODEL=gpt-4o-mini A9N_API_KEY=sk-...

# Groq
A9N_BASE_URL=https://api.groq.com/openai/v1 A9N_MODEL=llama-3.3-70b-versatile A9N_API_KEY=gsk_...

# Local Ollama (no key)
A9N_BASE_URL=http://localhost:11434/v1 A9N_MODEL=llama3.1
```

## The DSL

A workflow script is plain JavaScript that begins with a pure-literal `meta`:

```js
export const meta = {
  name: 'find-bugs',
  description: 'Fan out bug-finders, verify each finding',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
};

const FINDINGS = {
  type: 'object', required: ['bugs'],
  properties: { bugs: { type: 'array', items: { type: 'string' } } },
};

phase('Find');
const found = await agent('List likely bugs in:\n' + args.code, { schema: FINDINGS });

phase('Verify');
const verified = await parallel(found.bugs.map(b => () =>
  agent(`Is this a real bug? Answer yes/no and why: ${b}`)
));

return { bugs: found.bugs, verified };
```

| Helper | Behavior |
| --- | --- |
| `agent(prompt, opts?)` | One LLM call. With `opts.schema` returns a validated object (retried until valid); else returns text. `opts`: `label, phase, schema, model, system, temperature`. |
| `parallel(thunks)` | Barrier. Awaits all; a thrown thunk → `null`. |
| `pipeline(items, ...stages)` | Each item through all stages independently, no barrier. Stage `(prev, original, index)`. Throwing stage → item `null`. |
| `phase(title)` / `log(msg)` | Progress grouping / notes (returned in result). |
| `workflow(nameOrRef, args?)` | Run another a9n workflow inline (one level deep). |
| `args` | The tool's `args`, verbatim. |
| `budget` | `{ total, spent(), remaining() }`. `agent()` throws once `spent()` ≥ `total`. |

Concurrency is capped at ~`min(16, cores-2)` simultaneous LLM calls; total
agents per run are capped at 1000.

## Run it

```jsonc
// mcp__a9n__workflow
{ "script": "export const meta = {...}; ...", "args": { "code": "..." }, "budget": 200000 }
```

Returns `{ ok, meta, result, agents, tokens, phases, logs }` where `result` is
the script's top-level `return` value.

## Develop

```bash
bun install
bun test          # validator + engine (uses a local mock provider, no network)
bun run typecheck
bun run bump 0.2.0
```

## v1 limitations

- `agent()` `isolation` and `agentType` options are accepted for signature
  parity but are no-ops (no git worktrees / subagent registry here).
- No `resumeFromRunId` — runs are not journaled/resumable yet.

## License

Apache-2.0.
