import type { HttpToolDefinition } from "./types.js";

const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Identity helper for declaring an HTTP-backed MCP tool.
 *
 * Returns the same object back so that tool registries can be written as
 * `const tools = [defineHttpTool({...}), defineHttpTool({...})];`. The helper
 * validates the definition at author time so mistakes surface during module
 * load rather than at first invocation.
 */
export function defineHttpTool<T extends HttpToolDefinition>(def: T): T {
  if (!def.name || typeof def.name !== "string") {
    throw new Error("defineHttpTool: `name` is required and must be a string");
  }
  if (!TOOL_NAME_PATTERN.test(def.name)) {
    throw new Error(
      `defineHttpTool: invalid tool name \`${def.name}\`. Allowed characters: A-Z, a-z, 0-9, underscore, hyphen; must start with a letter or underscore.`,
    );
  }
  if (!def.method) {
    throw new Error(`defineHttpTool(${def.name}): \`method\` is required`);
  }
  if (!def.path || typeof def.path !== "string") {
    throw new Error(
      `defineHttpTool(${def.name}): \`path\` is required and must be a string`,
    );
  }
  if (!def.path.startsWith("/")) {
    throw new Error(
      `defineHttpTool(${def.name}): \`path\` must start with "/" (got "${def.path}")`,
    );
  }
  return def;
}
