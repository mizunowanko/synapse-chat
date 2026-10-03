import { describe, expect, it } from "vitest";
import { GLOBAL_SCOPE, agentScope, deskScope, mcpWriteRefusal, visibleScopes } from "./scope.js";

describe("mcpWriteRefusal — who may write which tier through MCP", () => {
  const a = agentScope("A");
  const ad = deskScope("A", "d1");

  it("an agent writes its own tier", () => {
    expect(mcpWriteRefusal(a, a)).toBeNull();
    expect(mcpWriteRefusal(ad, a)).toBeNull();
  });

  it("a desk session writes its own desk tier", () => {
    expect(mcpWriteRefusal(ad, ad)).toBeNull();
  });

  it("nobody writes the everyone tier through MCP", () => {
    expect(mcpWriteRefusal(a, GLOBAL_SCOPE)).toMatch(/全員/);
    expect(mcpWriteRefusal(ad, GLOBAL_SCOPE)).toMatch(/全員/);
  });

  it("an agent does not write another agent's tiers", () => {
    expect(mcpWriteRefusal(a, agentScope("B"))).toMatch(/B/);
    expect(mcpWriteRefusal(ad, deskScope("B", "d1"))).toMatch(/B/);
  });

  it("a session does not write a desk that is not its own", () => {
    expect(mcpWriteRefusal(a, ad)).toMatch(/Desk/);
    expect(mcpWriteRefusal(ad, deskScope("A", "d2"))).toMatch(/d2/);
  });

  it("a session without an agent writes nothing", () => {
    expect(mcpWriteRefusal(GLOBAL_SCOPE, GLOBAL_SCOPE)).toMatch(/--agent/);
    expect(mcpWriteRefusal(GLOBAL_SCOPE, a)).toMatch(/--agent/);
  });
});

describe("visibleScopes", () => {
  it("lists lowest first", () => {
    expect(visibleScopes(deskScope("A", "d"))).toEqual([deskScope("A", "d"), agentScope("A"), GLOBAL_SCOPE]);
    expect(visibleScopes(agentScope("A"))).toEqual([agentScope("A"), GLOBAL_SCOPE]);
    expect(visibleScopes(GLOBAL_SCOPE)).toEqual([GLOBAL_SCOPE]);
  });

  it("rejects names that would break the tier key", () => {
    expect(() => agentScope("")).toThrow();
    expect(() => agentScope("a/b")).toThrow();
    expect(() => deskScope("A", " d")).toThrow();
  });
});
