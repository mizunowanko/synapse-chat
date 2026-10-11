/**
 * `node:sqlite` is loaded at run time rather than imported: it exists only as
 * `node:sqlite` (no bare `sqlite` alias), and bundlers / vite-node that strip
 * the `node:` prefix fail to resolve a static import of it. This also gives a
 * readable error on a Node without it.
 *
 * Shared by the skill store and the instruction store, which live in the same
 * SQLite file (docs/design/skills-mcp.md, docs/design/instructions.md).
 */
export function loadSqlite(): typeof import("node:sqlite") {
  const mod = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite");
  if (!mod) {
    throw new Error(`the skill store needs node:sqlite (Node 22.13 or later); this is Node ${process.versions.node}`);
  }
  return mod as typeof import("node:sqlite");
}
