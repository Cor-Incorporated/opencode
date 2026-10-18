// 1.x-compatible `tool()` helper for the 2.x port.
//
// The fork's plugins declared tools with `tool({ description, args: { x: tool.schema.string() }, execute })` from
// `@opencode-ai/plugin` (1.x), where `tool.schema` was zod. The 2.x `@opencode/plugin` has no such helper: tools are
// added through `ctx.tool.transform(editor => editor.add({ name, description, input, execute }))` and `input` may be a
// JSON Schema (`Tool.ValueSchema` = effect Schema | Standard Schema | JsonSchema). This file keeps the 1.x call shape
// so team.ts stays byte-identical in its tool declarations, and emits JSON Schema instead of depending on zod.
// Only the builder subset the guardrails plugins use is implemented (string, boolean, number().int().min().max(),
// enum, array, object, .optional(), .default()). Defaults are applied by the adapter before `execute` runs, because a
// JSON Schema `default` is documentation for the validator, not a value the 2.x runtime fills in.

export type JsonSchema = Record<string, unknown>

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: unknown } }): void
  ask(input: { permission: string; patterns: string[]; always: string[]; metadata: { [key: string]: unknown } }): Promise<void>
  /** 1.x exposed the parent session's permission rules; the 2.x tool context has none. Always undefined here. */
  permission?: undefined
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: { [key: string]: unknown }
      attachments?: { type: "file"; mime: string; url: string; filename?: string }[]
    }

export interface Shape<T> {
  readonly json: JsonSchema
  /** Required by the object builder: optional() and default() both make a key non-required. */
  readonly required: boolean
  readonly fallback: T | undefined
  optional(): Shape<T | undefined>
  default(value: NonNullable<T>): Shape<NonNullable<T>>
  /** Phantom carrier for inference only; never set at runtime. */
  readonly _type?: T
}

class Base<T> implements Shape<T> {
  constructor(
    readonly json: JsonSchema,
    readonly required = true,
    readonly fallback: T | undefined = undefined,
  ) {}
  optional(): Shape<T | undefined> {
    return new Base<T | undefined>(this.json, false, this.fallback)
  }
  default(value: NonNullable<T>): Shape<NonNullable<T>> {
    return new Base<NonNullable<T>>({ ...this.json, default: value }, false, value)
  }
}

class Num extends Base<number> {
  int(): Num {
    return new Num({ ...this.json, type: "integer" }, this.required, this.fallback)
  }
  min(n: number): Num {
    return new Num({ ...this.json, minimum: n }, this.required, this.fallback)
  }
  max(n: number): Num {
    return new Num({ ...this.json, maximum: n }, this.required, this.fallback)
  }
}

export type Infer<S extends Record<string, Shape<unknown>>> = { [K in keyof S]: S[K] extends Shape<infer T> ? T : never }

function objectSchema(shape: Record<string, Shape<unknown>>): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [key, item] of Object.entries(shape)) {
    properties[key] = item.json
    if (item.required) required.push(key)
  }
  return { type: "object", properties, required, additionalProperties: false }
}

export const schema = {
  string: () => new Base<string>({ type: "string" }),
  boolean: () => new Base<boolean>({ type: "boolean" }),
  number: () => new Num({ type: "number" }),
  enum: <const V extends readonly [string, ...string[]]>(values: V) =>
    new Base<V[number]>({ type: "string", enum: [...values] }),
  array: <T>(item: Shape<T>) => new Base<T[]>({ type: "array", items: item.json }),
  object: <S extends Record<string, Shape<unknown>>>(shape: S) => new ObjectShape<Infer<S>>(objectSchema(shape), shape),
}

class ObjectShape<T> extends Base<T> {
  constructor(
    json: JsonSchema,
    readonly shape: Record<string, Shape<unknown>>,
  ) {
    super(json)
  }
}

export type ToolDefinition<Args extends Record<string, Shape<unknown>> = Record<string, Shape<unknown>>> = {
  description: string
  args: Args
  execute(args: Infer<Args>, context: ToolContext): Promise<ToolResult>
}

export function tool<Args extends Record<string, Shape<unknown>>>(input: ToolDefinition<Args>): ToolDefinition<Args> {
  return input
}
tool.schema = schema

/** The JSON Schema for a tool's `args` record, as 2.x `ToolEditor.add({ input })` accepts it. */
export function inputSchema(args: Record<string, Shape<unknown>>): JsonSchema {
  return objectSchema(args)
}

/**
 * Fill top-level `.default()` values the 2.x validator does not apply. Nested defaults inside object arrays
 * (e.g. tasks[].write) are left to the tool: team.ts already treats undefined as the documented default there.
 */
export function withDefaults(args: Record<string, Shape<unknown>>, input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(input && typeof input === "object" ? (input as Record<string, unknown>) : {}) }
  for (const [key, item] of Object.entries(args)) {
    if (out[key] === undefined && item.fallback !== undefined) out[key] = item.fallback
  }
  return out
}
