---
name: workflow-a9n
description: >-
  Author and run an AI-agnostic workflow with the a9n engine. Use when the user
  types /workflow-a9n <task>, or asks to "run an a9n workflow", "orchestrate
  this across LLM agents", "fan out / pipeline this over a provider-agnostic
  model", or wants Claude Code's Workflow-tool style of multi-agent
  orchestration but running against a configurable OpenAI-compatible provider
  (OpenAI, Groq, OpenRouter, Ollama, etc.) instead of Claude subagents.
disable-model-invocation: true
user-invocable: true
---

# /workflow-a9n — run an AI-agnostic workflow

a9n is a port of Claude Code's built-in Workflow tool. Same script DSL, same
fan-out/pipeline/verify patterns — but every `agent()` call hits the
OpenAI-compatible LLM provider configured in the plugin (`base_url` / `api_key`
/ `model`, or `OPENAI_*` env), so the workflow is portable across models and
providers.

You drive it by authoring a JavaScript workflow script and calling the
`mcp__a9n__workflow` MCP tool with it.

## Step 1 — Confirm the engine is available

The `mcp__a9n__workflow` tool must be present. If it isn't, the a9n plugin is
not active (or `bun` isn't on PATH); tell the user and stop. A provider key is
also required — if runs fail with auth errors, the user needs to set the
plugin's `api_key` (or `OPENAI_API_KEY`).

## Step 2 — Turn the user's `<task>` into a workflow script

Write a plain-JavaScript script (NOT TypeScript). It MUST begin with a pure
literal `meta`, then use the in-scope helpers. Available in the script:

- `agent(prompt, opts?)` → `Promise<string | object>`. Without `schema` returns
  the model's text. With `opts.schema` (a JSON Schema) returns a **validated**
  object — the engine retries the model until the output validates. `opts`:
  `{ label, phase, schema, model, system, temperature }`. `model` overrides the
  default per call; `system` prepends a system prompt.
- `parallel(thunks)` → `Promise<any[]>`. **Barrier** — awaits all. A thunk that
  throws resolves to `null`; `.filter(Boolean)` before use.
- `pipeline(items, ...stages)` → `Promise<any[]>`. Each item flows through every
  stage independently, **no barrier**. Stage signature `(prev, original, index)`.
  A throwing stage drops that item to `null`. **Default** for multi-stage work.
- `phase(title)`, `log(message)` — progress grouping and notes (returned in the
  result for the user to read).
- `workflow(nameOrRef, args?)` — run another a9n workflow inline (one level deep).
- `args` — the JSON value passed as the tool's `args`, verbatim.
- `budget` — `{ total, spent(), remaining() }`. `total` is the tool's `budget`
  input (output-token target) or `null`. Once `spent()` reaches it, `agent()`
  throws.

Standard JS built-ins are available (`JSON`, `Math`, `Array`, …). There is no
filesystem or network access from inside the script — only `agent()` reaches
the model.

### Patterns (compose freely; scale to the ask)

Default to `pipeline()` — only use a `parallel()` barrier when a stage genuinely
needs ALL prior results at once (dedup, early-exit on zero, cross-item compare).

```js
export const meta = {
  name: 'review-and-verify',
  description: 'Review across dimensions, adversarially verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
};
const DIMENSIONS = [
  { key: 'bugs', prompt: 'List likely bugs in:\n' + args.code },
  { key: 'perf', prompt: 'List performance issues in:\n' + args.code },
];
const FINDINGS = {
  type: 'object', required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } },
};
const VERDICT = {
  type: 'object', required: ['isReal'],
  properties: { isReal: { type: 'boolean' }, reason: { type: 'string' } },
};
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS }),
  (review, d) => parallel((review.findings || []).map(f => () =>
    agent('Adversarially verify, default to false if unsure: ' + f.title,
          { label: 'verify:' + d.key, phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, verdict: v })))),
);
return { confirmed: results.flat().filter(Boolean).filter(f => f.verdict?.isReal) };
```

Other shapes: loop-until-count (`while (out.length < N) out.push(...await agent(...))`),
loop-until-budget (`while (budget.total && budget.remaining() > 50_000) {...}`),
judge panel (N attempts → parallel judges → synthesize), adversarial verify
(N skeptics per claim, majority refute → kill).

## Step 3 — Run it

Call `mcp__a9n__workflow` with `{ script, args?, budget? }`. Prefer passing data
through `args` (real JSON) over interpolating large blobs into the script text.

For something you'll re-run, save it as `<name>.workflow.js` in the configured
workflows dir and invoke with `{ name: "<name>" }`, or pass `{ scriptPath }`.

## Step 4 — Report

The tool returns `{ ok, meta, result, agents, tokens, phases, logs }`. Summarize
`result` for the user; surface `agents`/`tokens` if they care about cost, and
quote relevant `logs` if a run partially failed.

Notes / v1 limits: `isolation` and `agentType` agent options are accepted for
signature parity with Claude Code but are no-ops here (no worktrees / subagent
registry). There is no `resumeFromRunId`.
