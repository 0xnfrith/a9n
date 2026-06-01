# a9n

AI-agnostic workflow orchestration. A Claude Code plugin that ports Claude
Code's built-in `Workflow` tool so that every `agent()` call runs against any
**OpenAI-compatible** provider instead of Claude subagents.

`a9n` = `automation` with 9 letters between (the `n8n` / `nodemation` numeronym
pattern). n8n wires nodes; a9n wires **agents**.

## Shape

- **One MCP server** (`a9n`, a bun stdio server — `server.ts`) exposing **one
  tool**, `workflow` (`src/tool.ts`), whose input signature mirrors Claude
  Code's Workflow tool (`script` / `scriptPath` / `name` / `args` / `budget`).
- **One skill**, `/workflow-a9n` (`skills/workflow-a9n/SKILL.md`).
- The engine (`src/engine.ts`) runs a script in a `node:vm` sandbox and injects
  the DSL: `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`,
  `workflow()`, plus the `args` and `budget` globals.
- The AI-agnostic core (`src/llm.ts`) speaks OpenAI Chat Completions; structured
  output (`agent(..., { schema })`) validates against a compact JSON-Schema
  checker (`src/schema.ts`) and retries until valid.

```
server.ts            stdio MCP server, registers ListTools/CallTool
src/tool.ts          the `workflow` tool descriptor + input schema
src/engine.ts        sandbox + agent/parallel/pipeline/phase/log/workflow/budget
src/llm.ts           resolveConfig + callModel + callStructured (provider-agnostic)
src/schema.ts        JSON-Schema validate() + forgiving parseJson()
src/types.ts         shared types
workflows/           saved workflows resolved by name
```

Develop: `bun install` · `bun test` (validator + engine vs a local mock
provider, no network) · `bun run smoke` (real MCP stdio round-trip) ·
`bun run typecheck` · `bun run bump <semver>`.

## Provider configuration (current behavior)

The provider is resolved **once, at server boot**, from environment / plugin
`userConfig` — see `resolveConfig` in `src/llm.ts`:

| What           | Env (a9n → fallback)              | Plugin `userConfig` | Default                     |
| -------------- | --------------------------------- | ------------------- | --------------------------- |
| Endpoint       | `A9N_BASE_URL` → `OPENAI_BASE_URL`| `base_url`          | `https://api.openai.com/v1` |
| API key        | `A9N_API_KEY` → `OPENAI_API_KEY`  | `api_key`           | _(none)_                    |
| Default model  | `A9N_MODEL` → `OPENAI_MODEL`      | `model`             | `gpt-4o-mini`               |

Inside a script, an author can override only the **model string** per call:

```js
await agent(prompt, { model: "gpt-4o" });   // src/engine.ts:114 — agentOpts.model || cfg.model
```

…but this still hits the **same `base_url` + `api_key`**. So today an author can
pick a different model *on the one configured endpoint*, but **cannot** route
different agents to different providers (e.g. agent A → Groq, agent B → OpenAI)
from within a script. The provider is an **operator/deployment** concern, not an
authored one.

## OPEN DESIGN DECISION — author-level provider selection

> Status: **undecided.** This is the thing to settle before building more of the
> provider surface. Pick one and wire it.

Two related gaps motivate this:

1. A script cannot choose a *provider* (endpoint + key), only a model name on the
   single configured endpoint (above).
2. `WorkflowMeta.model` and `phases[].model` exist in `src/types.ts` but are
   **declared and unused** — the engine never reads them (`src/engine.ts` only
   reads `agentOpts.model || cfg.model`). Whatever we choose, these should be
   wired or removed so the types don't lie.

### Option A — Named provider registry  *(recommended)*

The operator declares a set of **named** providers in config (each with its own
endpoint + key + default model); the script selects one **by name**:

```js
export const meta = { name: '...', model: 'openai/gpt-4o' };   // run default
await agent(prompt, { provider: 'groq', model: 'llama-3.3-70b' });   // per-call
```

- Secrets/endpoints stay **server-side**; scripts reference only names → scripts
  are portable and safe to commit.
- Matches how Claude Code's Workflow `model` opt works (a tier/name, not a URL).
- Cost: a config schema for the registry + per-call provider resolution.

### Option B — Inline provider in `agent()` opts

```js
await agent(prompt, { baseUrl: '...', apiKey: '...', model: '...' });
```

- Maximum flexibility, smallest code change.
- But endpoints and **secrets end up inside authored scripts** (and version
  control). Conflicts with keeping secrets out of authored surfaces. Not advised
  for anything that gets committed.

### Option C — Keep operator-only (status quo, but honest)

Provider stays deployment config (one endpoint). We wire `meta.model` (run
default) + per-agent `model` (override) against that single endpoint, and
document that multi-provider routing is out of scope.

- Simplest. Loses the "any agent, any provider" promise; "AI-agnostic" then
  means "pick your one provider at deploy time," not "mix providers per agent."

### Recommendation

**Option A.** It's the only one that delivers per-agent provider freedom while
keeping keys out of scripts. Suggested shape: an `A9N_PROVIDERS` JSON (or a
`providers` block in `userConfig`) mapping `name → { baseUrl, apiKey, model }`,
a default provider, and a `provider/model` or `{ provider, model }` selector on
both `meta` and `agent()` opts. Resolve per call in `agent()`, falling back to
the default provider when none is named.

## v1 limitations

- `agent()` `isolation` and `agentType` options are accepted for signature
  parity with Claude Code but are no-ops (no git worktrees / subagent registry).
- No `resumeFromRunId` — runs are not journaled/resumable.
- `meta.model` / `phases[].model` are unwired (see the open decision above).
