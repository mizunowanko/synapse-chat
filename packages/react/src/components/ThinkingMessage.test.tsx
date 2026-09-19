import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ThinkingMessage } from "./ThinkingMessage.js";
import type { ThinkingGroupItem } from "../lib/group-tool-messages.js";

afterEach(() => cleanup());

const LONG = "long reasoning ".repeat(40);

function group(content: string, isComplete: boolean): ThinkingGroupItem {
  return { kind: "thinking-group", content, isComplete };
}

describe("<ThinkingMessage />", () => {
  it("renders group content expanded while incomplete", () => {
    render(<ThinkingMessage group={group("step 1\nstep 2", false)} />);
    expect(screen.getByText(/step 1/)).toBeInTheDocument();
    expect(screen.getByText(/Thinking\.\.\./)).toBeInTheDocument();
  });

  it("renders collapsed when the group reports complete and is long", () => {
    render(<ThinkingMessage group={group(`hidden ${LONG}`, true)} />);
    expect(screen.queryByText(/hidden/)).not.toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("keeps a short completed group expanded", () => {
    render(<ThinkingMessage group={group("short note", true)} />);
    expect(screen.getByText("short note")).toBeInTheDocument();
  });

  it("forwards autoCollapseThreshold", () => {
    render(
      <ThinkingMessage
        group={group("short note", true)}
        autoCollapseThreshold={3}
      />,
    );
    expect(screen.queryByText("short note")).not.toBeInTheDocument();
  });

  it("honors an explicit isComplete override", () => {
    render(
      <ThinkingMessage group={group(`shown ${LONG}`, false)} isComplete={true} />,
    );
    expect(screen.queryByText(/shown/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/shown/)).toBeInTheDocument();
  });
});
