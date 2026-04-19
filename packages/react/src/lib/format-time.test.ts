import { describe, it, expect } from "vitest";
import { formatTime } from "./format-time.js";

describe("formatTime", () => {
  it("returns null for undefined", () => {
    expect(formatTime(undefined)).toBeNull();
  });

  it("returns null for 0 (truthy-checked)", () => {
    expect(formatTime(0)).toBeNull();
  });

  it("formats a timestamp as HH:MM in the local timezone", () => {
    const d = new Date();
    d.setHours(3, 7, 42, 0);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    expect(formatTime(d.getTime())).toBe(`${hh}:${mm}`);
  });
});
