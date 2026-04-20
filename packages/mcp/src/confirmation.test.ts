import { describe, it, expect } from "vitest";
import {
  augmentSchemaForConfirmation,
  checkConfirmation,
  stripConfirmation,
} from "./confirmation.js";
import type { HttpToolDefinition } from "./types.js";

const baseTool: HttpToolDefinition = {
  name: "delete_thing",
  method: "DELETE",
  path: "/api/thing/{id}",
  confirmation: true,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
};

describe("augmentSchemaForConfirmation", () => {
  it("adds confirmed property and marks it required when confirmation=true", () => {
    const schema = augmentSchemaForConfirmation(baseTool) as {
      type: string;
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(schema.properties.confirmed).toEqual({
      type: "boolean",
      description: expect.stringContaining("destructive action"),
    });
    expect(schema.required).toContain("confirmed");
    expect(schema.required).toContain("id");
  });

  it("does not clobber existing properties on the schema", () => {
    const schema = augmentSchemaForConfirmation(baseTool) as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.id).toEqual({ type: "string" });
  });

  it("leaves non-confirmation tools untouched (still object-typed)", () => {
    const schema = augmentSchemaForConfirmation({
      ...baseTool,
      confirmation: false,
    }) as { type: string; properties: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(schema.properties.confirmed).toBeUndefined();
  });

  it("coerces tools without inputSchema to object form", () => {
    const tool: HttpToolDefinition = {
      name: "ping",
      method: "GET",
      path: "/ping",
    };
    const schema = augmentSchemaForConfirmation(tool);
    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({});
  });

  it("does not duplicate confirmed when already required", () => {
    const schema = augmentSchemaForConfirmation({
      ...baseTool,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, confirmed: { type: "boolean" } },
        required: ["confirmed"],
      },
    }) as { required: string[] };
    const confirmedCount = schema.required.filter((r) => r === "confirmed").length;
    expect(confirmedCount).toBe(1);
  });
});

describe("checkConfirmation", () => {
  it("returns null when tool does not require confirmation", () => {
    const result = checkConfirmation(
      { ...baseTool, confirmation: false },
      {},
    );
    expect(result).toBeNull();
  });

  it("returns null when confirmed is true", () => {
    const result = checkConfirmation(baseTool, { id: "x", confirmed: true });
    expect(result).toBeNull();
  });

  it("returns an isError result when confirmed is missing", () => {
    const result = checkConfirmation(baseTool, { id: "x" });
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0]!.text).toMatch(/confirmed=true/);
  });

  it("returns an isError result when confirmed is false", () => {
    const result = checkConfirmation(baseTool, { id: "x", confirmed: false });
    expect(result?.isError).toBe(true);
  });

  it("treats string 'true' as not confirmed (booleans only)", () => {
    const result = checkConfirmation(baseTool, { id: "x", confirmed: "true" });
    expect(result?.isError).toBe(true);
  });
});

describe("stripConfirmation", () => {
  it("removes confirmed from the args without mutating input", () => {
    const input = { id: "x", confirmed: true };
    const stripped = stripConfirmation(input);
    expect(stripped).toEqual({ id: "x" });
    expect(input).toEqual({ id: "x", confirmed: true });
  });

  it("is a no-op when confirmed is absent", () => {
    const input = { id: "x" };
    expect(stripConfirmation(input)).toEqual(input);
  });
});
