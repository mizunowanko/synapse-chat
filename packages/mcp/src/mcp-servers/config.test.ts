import { describe, expect, it } from "vitest";
import {
  assertMcpServerName,
  envReferences,
  expandMcpServerConfig,
  parseMcpServerConfig,
  parseMcpServerSpec,
  plaintextSecretKeys,
} from "./config.js";

describe("names", () => {
  it("takes what every CLI can carry and refuses the rest", () => {
    for (const ok of ["artiflow", "a-b", "a_b", "A1"]) expect(() => assertMcpServerName(ok)).not.toThrow();
    for (const bad of ["", "a__b", "-a", "a.b", "a b", "a/b", "x".repeat(65), 1]) {
      expect(() => assertMcpServerName(bad)).toThrow(/invalid MCP server name/);
    }
    expect(() => assertMcpServerName("skills")).toThrow(/reserved/);
  });
});

describe("parseMcpServerConfig", () => {
  it("canonicalises: fixed key order, empty args / env / headers dropped", () => {
    const a = parseMcpServerConfig({ env: {}, args: [], command: "node", transport: "stdio" });
    expect(a).toEqual({ transport: "stdio", command: "node" });
    const b = parseMcpServerConfig({ cwd: "/w", env: { B: "2", A: "1" }, command: "node", transport: "stdio", args: ["x"] });
    expect(Object.keys(b)).toEqual(["transport", "command", "args", "env", "cwd"]);
    expect(parseMcpServerConfig({ transport: "http", url: "https://h/mcp", headers: {} })).toEqual({ transport: "http", url: "https://h/mcp" });
  });

  it("refuses unknown keys, wrong types and unusable plain values", () => {
    expect(() => parseMcpServerConfig({ transport: "stdio", command: "x", url: "http://h" })).toThrow(/unknown key "url"/);
    expect(() => parseMcpServerConfig({ transport: "sse", url: "http://h" })).toThrow(/transport/);
    expect(() => parseMcpServerConfig({ transport: "stdio", command: "" })).toThrow(/command/);
    expect(() => parseMcpServerConfig({ transport: "stdio", command: "x", args: [1] })).toThrow(/args/);
    expect(() => parseMcpServerConfig({ transport: "stdio", command: "x", env: { "A-B": "1" } })).toThrow(/invalid key/);
    expect(() => parseMcpServerConfig({ transport: "stdio", command: "x", cwd: "rel" })).toThrow(/absolute/);
    expect(() => parseMcpServerConfig({ transport: "http", url: "ftp://h" })).toThrow(/http\(s\)/);
    expect(() => parseMcpServerConfig({ transport: "http", url: "https://h", headers: { A: "x\ny" } })).toThrow(/line break/);
  });

  it("defers the checks of a value that refers to the environment", () => {
    expect(parseMcpServerConfig({ transport: "stdio", command: "x", cwd: "${HOME_DIR}/w" })).toMatchObject({ cwd: "${HOME_DIR}/w" });
    expect(parseMcpServerConfig({ transport: "http", url: "${URL}" })).toMatchObject({ url: "${URL}" });
  });

  it("refuses malformed references", () => {
    expect(() => envReferences("${}")).toThrow(/invalid/);
    expect(() => envReferences("${1A}")).toThrow(/invalid/);
    expect(() => envReferences("${A")).toThrow(/unclosed/);
    expect(envReferences("$A $${B} ${C}x${D_1}")).toEqual(["C", "D_1"]);
  });

  it("a spec defaults to enabled", () => {
    expect(parseMcpServerSpec({ name: "a", transport: "http", url: "https://h" }).enabled).toBe(true);
    expect(() => parseMcpServerSpec({ name: "a", enabled: "no", transport: "http", url: "https://h" })).toThrow(/enabled/);
  });
});

describe("expandMcpServerConfig", () => {
  it("expands every string value; $${ stays a literal ${", () => {
    const r = expandMcpServerConfig(
      { transport: "stdio", command: "${BIN}", args: ["--t=${TOKEN}", "$${KEEP}"], env: { T: "${TOKEN}" }, cwd: "${ROOT}/w" },
      { BIN: "/bin/node", TOKEN: "s3cret", ROOT: "/r" },
    );
    expect(r).toEqual({
      ok: true,
      config: { transport: "stdio", command: "/bin/node", args: ["--t=s3cret", "${KEEP}"], env: { T: "s3cret" }, cwd: "/r/w" },
    });
    const h = expandMcpServerConfig(
      { transport: "http", url: "http://localhost:1/${PASS}/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
      { PASS: "p", TOKEN: "t" },
    );
    expect(h).toEqual({ ok: true, config: { transport: "http", url: "http://localhost:1/p/mcp", headers: { Authorization: "Bearer t" } } });
  });

  it("names the missing variables and nothing of the values", () => {
    const r = expandMcpServerConfig({ transport: "http", url: "${URL}", headers: { A: "${B}", C: "${URL}" } }, {});
    expect(r).toEqual({ ok: false, missing: ["B", "URL"] });
  });

  it("an empty variable is present", () => {
    expect(expandMcpServerConfig({ transport: "stdio", command: "x", env: { A: "${E}" } }, { E: "" })).toMatchObject({ ok: true });
  });

  it("checks the expanded values without quoting them", () => {
    const bad = expandMcpServerConfig({ transport: "http", url: "${U}" }, { U: "not a url s3cret" });
    expect(bad).toMatchObject({ ok: false, missing: [] });
    expect(JSON.stringify(bad)).not.toContain("s3cret");
    expect(expandMcpServerConfig({ transport: "http", url: "https://h", headers: { A: "${V}" } }, { V: "a\r\nb" })).toMatchObject({ ok: false });
    expect(expandMcpServerConfig({ transport: "stdio", command: "x", cwd: "${D}" }, { D: "rel" })).toMatchObject({ ok: false });
  });
});

describe("plaintextSecretKeys", () => {
  it("points at secret-looking keys written in the clear", () => {
    expect(plaintextSecretKeys({ transport: "stdio", command: "x", env: { API_TOKEN: "abc", MODE: "x", KEY: "${K}" } })).toEqual(["env.API_TOKEN"]);
    expect(plaintextSecretKeys({ transport: "http", url: "https://h", headers: { Authorization: "Bearer abc" } })).toEqual(["headers.Authorization"]);
  });
});
