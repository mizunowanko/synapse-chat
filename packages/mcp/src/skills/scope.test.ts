import { describe, expect, it } from "vitest";
import {
  GLOBAL_SCOPE,
  agentScope,
  deskScope,
  deskViewer,
  isOwnDeskScope,
  mcpWriteRefusal,
  visibleScopes,
} from "./scope.js";

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

describe("deskViewer — the desk tier keyed on the desk id, with the name read beneath it (agt-215)", () => {
  it("reads the legacy key between the desk tier and the agent tier", () => {
    expect(visibleScopes(deskViewer("A", "desk-1", "main"))).toEqual([
      deskScope("A", "desk-1"),
      deskScope("A", "main"),
      agentScope("A"),
      GLOBAL_SCOPE,
    ]);
  });

  it("without a legacy key (or with the id itself) is a plain desk scope", () => {
    expect(deskViewer("A", "desk-1")).toEqual(deskScope("A", "desk-1"));
    expect(deskViewer("A", "desk-1", "desk-1")).toEqual(deskScope("A", "desk-1"));
    expect(visibleScopes(deskViewer("A", "desk-1", "desk-1"))).toEqual([deskScope("A", "desk-1"), agentScope("A"), GLOBAL_SCOPE]);
  });

  it("checks both keys", () => {
    expect(() => deskViewer("A", "a/b", "main")).toThrow();
    expect(() => deskViewer("A", "desk-1", " main")).toThrow();
  });

  it("writes only to the desk id: the legacy key is not a tier the session may write", () => {
    const v = deskViewer("A", "desk-1", "main");
    expect(mcpWriteRefusal(v, deskScope("A", "desk-1"))).toBeNull();
    expect(mcpWriteRefusal(v, deskScope("A", "main"))).toMatch(/main/);
  });

  it("knows its own desk tiers", () => {
    const v = deskViewer("A", "desk-1", "main");
    expect(isOwnDeskScope(v, deskScope("A", "desk-1"))).toBe(true);
    expect(isOwnDeskScope(v, deskScope("A", "main"))).toBe(true);
    expect(isOwnDeskScope(v, deskScope("A", "other"))).toBe(false);
    expect(isOwnDeskScope(v, deskScope("B", "desk-1"))).toBe(false);
    expect(isOwnDeskScope(v, agentScope("A"))).toBe(false);
  });
});
