import type { HttpToolDefinition, JsonSchema, ToolArgs, ToolResult } from "./types.js";

const CONFIRMED_PROPERTY_DESCRIPTION =
  "Must be set to `true` to execute this destructive action. If you invoke without confirmed=true, the tool will return an error and no HTTP request is issued.";

/**
 * Shape of the input schema after confirmation augmentation.
 *
 * Exported for tests and consumers that want to inspect what the MCP server
 * will advertise to the LLM.
 */
export interface ConfirmationAugmentedSchema extends JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

/**
 * Return a new JSON Schema with a `confirmed: boolean` property injected and
 * marked `required`. If the tool does not opt in to confirmation, the input
 * schema is returned untouched (still coerced to object form for MCP).
 */
export function augmentSchemaForConfirmation(
  tool: HttpToolDefinition,
): JsonSchema {
  const baseline: JsonSchema =
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? { ...tool.inputSchema }
      : { type: "object", properties: {} };

  if (!tool.confirmation) {
    if (baseline.type === undefined) baseline.type = "object";
    if (baseline.properties === undefined) baseline.properties = {};
    return baseline;
  }

  const properties =
    (baseline.properties as Record<string, unknown> | undefined) ?? {};
  const required = Array.isArray(baseline.required)
    ? [...(baseline.required as string[])]
    : [];

  const augmented: ConfirmationAugmentedSchema = {
    ...baseline,
    type: "object",
    properties: {
      ...properties,
      confirmed: {
        type: "boolean",
        description: CONFIRMED_PROPERTY_DESCRIPTION,
      },
    },
    required: required.includes("confirmed") ? required : [...required, "confirmed"],
  };

  return augmented;
}

/**
 * If the tool requires confirmation and the incoming args do not carry
 * `confirmed: true`, short-circuit with an MCP error response.
 *
 * Returns `null` when the call is allowed to proceed. Callers should pass
 * through to the underlying HTTP client on `null`.
 */
export function checkConfirmation(
  tool: HttpToolDefinition,
  args: ToolArgs,
): ToolResult | null {
  if (!tool.confirmation) return null;
  if (args.confirmed === true) return null;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Tool "${tool.name}" requires explicit confirmation. Re-invoke with confirmed=true (as a boolean, not a string) to proceed.`,
      },
    ],
  };
}

/**
 * Strip the helper-managed `confirmed` flag from the args bag before it is
 * forwarded to the HTTP layer. Returns a new object so callers never mutate
 * the original.
 */
export function stripConfirmation(args: ToolArgs): ToolArgs {
  const { confirmed: _ignored, ...rest } = args;
  return rest;
}
