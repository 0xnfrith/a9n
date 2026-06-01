// Shared types for the a9n workflow engine.

/** Resolved LLM provider configuration. AI-agnostic: any OpenAI-compatible endpoint. */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
}

/** The `meta` block every workflow script must declare at the top. */
export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
  model?: string;
}

/** Options accepted by the in-script `agent()` helper. Mirrors Claude Code's Workflow tool. */
export interface AgentOptions {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  /** a9n extension: a per-call system prompt prepended to the agent's context. */
  system?: string;
  /** a9n extension: sampling temperature for this call. */
  temperature?: number;
  /** Accepted for signature parity with Claude Code; no-ops in a9n v1 (see README). */
  isolation?: 'worktree';
  agentType?: string;
}

/** The structured value returned to the MCP caller after a run. */
export interface RunResult {
  ok: boolean;
  meta?: WorkflowMeta;
  result?: unknown;
  agents: number;
  tokens: number;
  phases: string[];
  logs: string[];
  error?: string;
}

/** State shared across a run and any nested workflow() calls (counter, budget, concurrency). */
export interface SharedState {
  agentCounter: number;
  spent: number;
  budgetTotal: number | null;
  semaphore: { acquire(): Promise<void>; release(): void };
  maxAgents: number;
}
