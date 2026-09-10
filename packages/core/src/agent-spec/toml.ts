/**
 * The minimum TOML writer needed for `.codex/agents/*.toml`. Codex reads three
 * keys — `name`, `description`, `developer_instructions` — plus whatever
 * provider frontmatter the spec carries. Pulling in a TOML dependency to emit a
 * handful of string keys would be more surface than the format we need.
 */

// Built from a string so this source file stays free of control bytes.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g");

/**
 * Multi-line basic string. Backslashes and every `"` are escaped, which makes
 * the `"""` terminator unreachable from the content and removes the
 * trailing-quote ambiguity — the two ways a naive multi-line emitter produces a
 * file that no longer parses.
 */
function multilineBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(CONTROL_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"""\n${escaped}\n"""`;
}

function scalar(value: unknown): string {
  if (typeof value === "string") {
    return value.includes("\n") ? multilineBasicString(value) : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(scalar).join(", ")}]`;
  return JSON.stringify(String(value));
}

/** Serializes a flat table. Nested tables are not needed and are not supported. */
export function toToml(table: Record<string, unknown>): string {
  return `${Object.entries(table)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key} = ${scalar(value)}`)
    .join("\n")}\n`;
}

/**
 * The matching reader, scoped to exactly what {@link toToml} emits: a flat
 * table of strings, numbers, booleans and arrays.
 *
 * `absorb()` needs this so a hand-edited `.codex/agents/*.toml` comes back the
 * same way a hand-edited `.claude/agents/*.md` does. Without it Codex would be
 * the one provider whose subagents are write-only, and "edit any provider's
 * files and it propagates" would quietly have an exception in it.
 *
 * Table headers (`[section]`), dotted keys and inline tables are rejected
 * rather than half-understood: nothing here writes them, so a file containing
 * one was not produced by us and guessing at its shape would be worse than
 * saying so.
 */
export function fromToml(text: string): Record<string, unknown> {
  const parser = new TomlReader(text);
  return parser.parseTable();
}

class TomlError extends Error {
  constructor(message: string) {
    super(`agent-spec: invalid TOML — ${message}`);
    this.name = "TomlError";
  }
}

const BARE_KEY_RE = /^[A-Za-z0-9_-]+/;
const NUMBER_RE = /^[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/;

class TomlReader {
  private index = 0;

  constructor(private readonly text: string) {}

  parseTable(): Record<string, unknown> {
    const table: Record<string, unknown> = {};
    for (;;) {
      this.skipTrivia();
      if (this.index >= this.text.length) return table;
      if (this.peek() === "[") throw new TomlError("table headers are not supported.");

      const key = this.readKey();
      this.skipInlineTrivia();
      if (this.peek() !== "=") throw new TomlError(`expected "=" after key "${key}".`);
      this.index += 1;
      this.skipInlineTrivia();
      table[key] = this.readValue();
    }
  }

  private peek(): string {
    return this.text[this.index] ?? "";
  }

  private startsWith(token: string): boolean {
    return this.text.startsWith(token, this.index);
  }

  /** Whitespace, newlines and whole-line comments between statements. */
  private skipTrivia(): void {
    for (;;) {
      const char = this.peek();
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.index += 1;
        continue;
      }
      if (char === "#") {
        while (this.index < this.text.length && this.peek() !== "\n") this.index += 1;
        continue;
      }
      return;
    }
  }

  /** Spaces and tabs only — a newline ends the statement. */
  private skipInlineTrivia(): void {
    while (this.peek() === " " || this.peek() === "\t") this.index += 1;
  }

  private readKey(): string {
    if (this.peek() === '"') return this.readBasicString();
    const match = BARE_KEY_RE.exec(this.text.slice(this.index));
    if (!match) throw new TomlError(`expected a key at offset ${this.index}.`);
    this.index += match[0].length;
    if (this.peek() === ".") throw new TomlError("dotted keys are not supported.");
    return match[0];
  }

  private readValue(): unknown {
    if (this.startsWith('"""')) return this.readMultilineBasicString();
    if (this.peek() === '"') return this.readBasicString();
    if (this.peek() === "'") throw new TomlError("literal strings are not supported.");
    if (this.peek() === "[") return this.readArray();
    if (this.peek() === "{") throw new TomlError("inline tables are not supported.");
    if (this.startsWith("true")) {
      this.index += 4;
      return true;
    }
    if (this.startsWith("false")) {
      this.index += 5;
      return false;
    }
    const match = NUMBER_RE.exec(this.text.slice(this.index));
    if (!match || match[0] === "") throw new TomlError(`unrecognized value at offset ${this.index}.`);
    this.index += match[0].length;
    return Number(match[0].replace(/_/g, ""));
  }

  private readArray(): unknown[] {
    this.index += 1; // "["
    const items: unknown[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.peek() === "]") {
        this.index += 1;
        return items;
      }
      if (this.index >= this.text.length) throw new TomlError("unterminated array.");
      items.push(this.readValue());
      this.skipTrivia();
      if (this.peek() === ",") this.index += 1;
      else if (this.peek() !== "]") throw new TomlError("expected \",\" or \"]\" in array.");
    }
  }

  private readBasicString(): string {
    this.index += 1; // opening quote
    let out = "";
    while (this.index < this.text.length) {
      const char = this.peek();
      if (char === '"') {
        this.index += 1;
        return out;
      }
      if (char === "\n") throw new TomlError("unterminated string.");
      if (char === "\\") {
        out += this.readEscape();
        continue;
      }
      out += char;
      this.index += 1;
    }
    throw new TomlError("unterminated string.");
  }

  /**
   * `"""` … `"""`. The writer escapes every `"`, so the closing delimiter is
   * the only unescaped `"""` in the value — the ambiguity that makes naive
   * multi-line TOML readers wrong is not reachable from our own output.
   */
  private readMultilineBasicString(): string {
    this.index += 3;
    // A newline immediately after the opening delimiter is not part of the value.
    if (this.startsWith("\r\n")) this.index += 2;
    else if (this.peek() === "\n") this.index += 1;

    let out = "";
    while (this.index < this.text.length) {
      if (this.startsWith('"""')) {
        this.index += 3;
        // The writer puts the delimiter on its own line, so the newline before
        // it is delimiter punctuation rather than content.
        return out.endsWith("\n") ? out.slice(0, -1) : out;
      }
      if (this.peek() === "\\") {
        out += this.readEscape();
        continue;
      }
      out += this.peek();
      this.index += 1;
    }
    throw new TomlError("unterminated multi-line string.");
  }

  private readEscape(): string {
    const code = this.text[this.index + 1] ?? "";
    this.index += 2;
    switch (code) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "u":
      case "U": {
        const width = code === "u" ? 4 : 8;
        const hex = this.text.slice(this.index, this.index + width);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) {
          throw new TomlError(`bad \\${code} escape.`);
        }
        this.index += width;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      default:
        throw new TomlError(`unknown escape "\\${code}".`);
    }
  }
}
