import { describe, expect, it } from "vitest";

import { fromToml, toToml } from "./toml.js";

describe("toToml / fromToml", () => {
  it("round-trips the keys Codex reads", () => {
    const table = {
      name: "number-cruncher",
      description: "集計を回す。",
      developer_instructions: 'まず定義を確認する。\n"引用" と \\ を含む。\n',
    };
    expect(fromToml(toToml(table))).toEqual(table);
  });

  it("round-trips values that break naive multi-line emitters", () => {
    // A closing delimiter inside the content, a trailing quote against the
    // terminator, tabs, CRs — each of these produces an unparseable file if the
    // writer takes the obvious shortcut.
    const table = {
      developer_instructions: '"""\nnot the end\n"""\ntrailing quote →"\n\ttabbed\r\nline\n',
    };
    const emitted = toToml(table);
    expect(emitted.match(/"""/g)).toHaveLength(2);
    expect(fromToml(emitted)).toEqual(table);
  });

  it("round-trips scalars and arrays", () => {
    const table = { flag: true, off: false, count: 3, ratio: -1.5, tools: ["Read", "Grep"] };
    expect(fromToml(toToml(table))).toEqual(table);
  });

  it("round-trips an empty string and a lone newline", () => {
    expect(fromToml(toToml({ a: "", b: "\n" }))).toEqual({ a: "", b: "\n" });
  });

  it("ignores comment lines", () => {
    expect(fromToml('# a comment\nname = "x"\n# another\n')).toEqual({ name: "x" });
  });

  it("rejects TOML shapes it does not actually understand", () => {
    // Half-reading a table header would silently drop keys into the wrong
    // place; a file containing one was not written by us.
    expect(() => fromToml('[section]\nname = "x"\n')).toThrow(/table headers/);
    expect(() => fromToml("a.b = 1\n")).toThrow(/dotted keys/);
    expect(() => fromToml("a = { b = 1 }\n")).toThrow(/inline tables/);
    expect(() => fromToml("a = 'literal'\n")).toThrow(/literal strings/);
    expect(() => fromToml('a = "unterminated\n')).toThrow(/unterminated/);
  });
});
