import { compile, type Schema } from "@earendil-works/pi-schema";
export const properties = (schema: Schema) =>
  (schema as { properties?: Record<string, unknown> }).properties ?? {};

export function withDefaults(schema: Schema, value: Record<string, unknown>) {
  const out = { ...value };
  for (const [k, p] of Object.entries(properties(schema)))
    if (out[k] === undefined && p && typeof p === "object" && "default" in p)
      out[k] = p.default;
  return out;
}

export function defineTool<I extends Schema, O extends Schema>(
  input: I,
  output: O,
) {
  const parser = compile(input, { coerce: true }),
    checker = compile(output);
  return {
    parse: (args: unknown) => {
      const result = parser.parse(args);
      return result.ok
        ? {
            ...result,
            value: withDefaults(input, result.value as Record<string, unknown>),
          }
        : result;
    },
    errors: (value: unknown) => checker.errors(value),
  };
}

export const readOnly = (title: string) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
export const mutating = (title: string) => ({
  ...readOnly(title),
  readOnlyHint: false,
  destructiveHint: true,
});
export const exportTransfer = (title: string) => ({
  ...readOnly(title),
  readOnlyHint: false,
  idempotentHint: false,
  openWorldHint: true,
});
