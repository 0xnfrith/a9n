import { describe, expect, test } from 'bun:test';
import { parseJson, validate } from './schema.ts';

describe('validate', () => {
  test('passes a well-formed object', () => {
    const schema = {
      type: 'object',
      required: ['title', 'count'],
      properties: { title: { type: 'string' }, count: { type: 'integer' } },
    };
    expect(validate(schema, { title: 'x', count: 3 }).valid).toBe(true);
  });

  test('flags missing required + wrong type', () => {
    const schema = {
      type: 'object',
      required: ['title', 'count'],
      properties: { title: { type: 'string' }, count: { type: 'integer' } },
    };
    const r = validate(schema, { count: 1.5 });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('title'))).toBe(true);
    expect(r.errors.some(e => e.includes('count'))).toBe(true); // 1.5 is not integer
  });

  test('validates array items + enum', () => {
    const schema = {
      type: 'array',
      items: { type: 'string', enum: ['a', 'b'] },
    };
    expect(validate(schema, ['a', 'b']).valid).toBe(true);
    expect(validate(schema, ['a', 'c']).valid).toBe(false);
  });

  test('supports type unions and null', () => {
    const schema = { type: ['number', 'null'] };
    expect(validate(schema, 5).valid).toBe(true);
    expect(validate(schema, null).valid).toBe(true);
    expect(validate(schema, 'x').valid).toBe(false);
  });

  test('nested objects', () => {
    const schema = {
      type: 'object',
      properties: { inner: { type: 'object', required: ['v'], properties: { v: { type: 'boolean' } } } },
    };
    expect(validate(schema, { inner: { v: true } }).valid).toBe(true);
    expect(validate(schema, { inner: {} }).valid).toBe(false);
  });
});

describe('parseJson', () => {
  test('parses bare JSON', () => {
    const r = parseJson('{"a":1}');
    expect(r.ok && (r.value as any).a).toBe(1);
  });

  test('strips ```json fences', () => {
    const r = parseJson('```json\n{"a":2}\n```');
    expect(r.ok && (r.value as any).a).toBe(2);
  });

  test('recovers JSON embedded in prose', () => {
    const r = parseJson('Sure! Here you go: {"a":3} hope that helps');
    expect(r.ok && (r.value as any).a).toBe(3);
  });

  test('reports failure when there is no JSON', () => {
    expect(parseJson('no json here').ok).toBe(false);
  });
});
