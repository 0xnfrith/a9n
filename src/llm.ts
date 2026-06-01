// The AI-agnostic core: every agent() call ultimately lands here.
//
// We speak the OpenAI Chat Completions wire format, which is the de-facto
// lingua franca — OpenAI, Anthropic-compatible gateways, Groq, Together,
// OpenRouter, Ollama, vLLM, LM Studio and most others expose it. Swapping
// providers is a base-URL + key + model change, no code change. That is the
// whole point of a9n versus Claude Code's Claude-only Workflow tool.

import type { LlmConfig, LlmResult } from './types.ts';
import { parseJson, schemaInstruction, validate } from './schema.ts';

export class LlmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = (env.A9N_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
    .trim()
    .replace(/\/+$/, '');
  const apiKey = (env.A9N_API_KEY || env.OPENAI_API_KEY || '').trim();
  const model = (env.A9N_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  return { baseUrl, apiKey, model };
}

interface CallOptions {
  model: string;
  prompt: string;
  system?: string;
  jsonMode?: boolean;
  temperature?: number;
}

export async function callModel(cfg: LlmConfig, opts: CallOptions): Promise<LlmResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });

  const body: Record<string, unknown> = { model: opts.model, messages };
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new LlmError(res.status, `${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 500)}` : ''}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? '';
  return {
    text,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Call the model and coerce a schema-valid JSON value out of it. Validation
 * happens here (not in the script) so the retry loop can feed the error back
 * to the model — the same contract Claude Code's Workflow tool gives you: a
 * `schema` option means agent() returns a validated object, never a string.
 */
export async function callStructured(
  cfg: LlmConfig,
  opts: { model: string; prompt: string; system?: string; schema: unknown; maxRetries?: number }
): Promise<{ value: unknown; usage: LlmResult['usage'] }> {
  const maxRetries = opts.maxRetries ?? 3;
  const system = [opts.system, schemaInstruction(opts.schema)].filter(Boolean).join('\n\n');
  const usage = { promptTokens: 0, completionTokens: 0 };

  let jsonMode = true;
  let triedFallback = false;
  let lastError = 'no attempts made';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const prompt =
      attempt === 0
        ? opts.prompt
        : `${opts.prompt}\n\n[Your previous output was rejected: ${lastError}]\nReturn ONLY valid JSON matching the schema.`;

    let res: LlmResult;
    try {
      res = await callModel(cfg, { model: opts.model, system, prompt, jsonMode, temperature: 0 });
    } catch (e) {
      // Some providers reject response_format=json_object. Fall back once to a
      // plain call (we still instruct JSON via the system prompt) and re-try.
      if (e instanceof LlmError && e.status === 400 && jsonMode && !triedFallback) {
        jsonMode = false;
        triedFallback = true;
        attempt--;
        continue;
      }
      throw e;
    }

    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;

    const parsed = parseJson(res.text);
    if (!parsed.ok) {
      lastError = parsed.error;
      continue;
    }
    const verdict = validate(opts.schema, parsed.value);
    if (verdict.valid) return { value: parsed.value, usage };
    lastError = verdict.errors.join('; ');
  }

  throw new Error(
    `agent failed to produce schema-valid JSON after ${maxRetries + 1} attempt(s): ${lastError}`
  );
}
