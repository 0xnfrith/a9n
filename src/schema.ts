// A compact JSON Schema validator + prompt-instruction builder.
//
// Workflow `schema` options are almost always a simple object/array shape, so
// we implement the common subset rather than pull in a full validator:
//   type (incl. unions), properties, required, items, enum, anyOf/oneOf, const.
// Anything we don't understand is treated as "no constraint" — we never reject
// a value for a keyword we didn't check, only for ones we did.

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type Schema = Record<string, unknown>;

export function validate(schema: unknown, value: unknown): ValidationResult {
  const errors: string[] = [];
  walk(schema, value, '$', errors);
  return { valid: errors.length === 0, errors };
}

function walk(schema: unknown, value: unknown, path: string, errors: string[]): void {
  if (!isObject(schema)) return;
  const s = schema as Schema;

  if ('const' in s && !deepEqual(s.const, value)) {
    errors.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  }

  if (Array.isArray(s.enum) && !s.enum.some(e => deepEqual(e, value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
  }

  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const branches = (s.anyOf ?? s.oneOf) as unknown[];
    const ok = branches.some(b => validate(b, value).valid);
    if (!ok) errors.push(`${path}: did not match any of the allowed schemas`);
  }

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some(t => typeMatches(t, value))) {
      errors.push(`${path}: expected ${types.join(' | ')}, got ${jsType(value)}`);
      return; // shape checks below would be noise once the base type is wrong
    }
  }

  if (isObject(value)) {
    for (const req of (s.required as string[]) ?? []) {
      if (!(req in (value as object))) errors.push(`${path}.${req}: required property missing`);
    }
    if (isObject(s.properties)) {
      for (const [k, sub] of Object.entries(s.properties as Schema)) {
        if (k in (value as object)) walk(sub, (value as Record<string, unknown>)[k], `${path}.${k}`, errors);
      }
    }
  }

  if (Array.isArray(value) && isObject(s.items)) {
    value.forEach((item, i) => walk(s.items, item, `${path}[${i}]`, errors));
  }
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: return true; // unknown type keyword → don't constrain
  }
}

function jsType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// `isObject` is intentionally realm-safe: a plain object created inside the vm
// sandbox is still `typeof 'object'` and not an array, so this holds across realms.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Build the system instruction that forces an LLM to return JSON matching
 * `schema`. Provider-agnostic: we both ask for JSON in the prompt AND set
 * response_format=json_object on the wire (when the provider supports it), so
 * even providers without structured-output modes produce parseable output.
 */
export function schemaInstruction(schema: unknown): string {
  return [
    'You are a function whose entire output is a single JSON value.',
    'Return ONLY JSON that validates against this JSON Schema — no prose, no explanation, no markdown code fences:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

/** Forgiving JSON extraction: tolerate ```json fences and surrounding prose. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = stripFences(text).trim();
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // Fall back to the first balanced {...} or [...] span in the text.
    const span = firstJsonSpan(trimmed);
    if (span) {
      try {
        return { ok: true, value: JSON.parse(span) };
      } catch (e) {
        return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
      }
    }
    return { ok: false, error: 'no JSON object or array found in output' };
  }
}

function stripFences(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1] : text;
}

function firstJsonSpan(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
