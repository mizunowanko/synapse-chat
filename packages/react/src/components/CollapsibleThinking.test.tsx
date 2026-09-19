import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CollapsibleThinking } from "./CollapsibleThinking.js";

afterEach(() => cleanup());

/** Comfortably above the default 300-char auto-collapse threshold. */
const LONG = "long reasoning ".repeat(40);
/** A one-line progress note like the ones Claude writes into thinking. */
const SHORT = "次はパーサに通してどこで混ざるか調べます";

describe("<CollapsibleThinking />", () => {
  it("renders expanded while incomplete and shows the thinking content", () => {
    render(
      <CollapsibleThinking content="line a\nline b" isComplete={false} />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/line a/)).toBeInTheDocument();
    expect(screen.getByText(/Thinking\.\.\./)).toBeInTheDocument();
  });

  it("auto-collapses a long thinking once isComplete flips to true", () => {
    const { rerender } = render(
      <CollapsibleThinking content={LONG} isComplete={false} />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");

    rerender(<CollapsibleThinking content={LONG} isComplete={true} />);

    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText(/long reasoning/)).not.toBeInTheDocument();
  });

  it("respects manual user toggles after auto state changes", () => {
    const { rerender } = render(
      <CollapsibleThinking content={LONG} isComplete={false} />,
    );

    rerender(<CollapsibleThinking content={LONG} isComplete={true} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/long reasoning/)).toBeInTheDocument();
  });

  it("hides the content pane while collapsed", () => {
    const secret = `secret ${LONG}`;
    render(<CollapsibleThinking content={secret} isComplete={true} />);
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/secret/)).toBeInTheDocument();
  });

  describe("short thinking (#62)", () => {
    it("stays expanded after completion when at or under 300 chars", () => {
      const { rerender } = render(
        <CollapsibleThinking content={SHORT} isComplete={false} />,
      );
      rerender(<CollapsibleThinking content={SHORT} isComplete={true} />);

      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(screen.getByText(SHORT)).toBeInTheDocument();
    });

    it("treats exactly 300 chars as short and 301 as long", () => {
      const at = "a".repeat(300);
      const over = "a".repeat(301);
      render(<CollapsibleThinking content={at} isComplete={true} />);
      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      cleanup();
      render(<CollapsibleThinking content={over} isComplete={true} />);
      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("stays expanded when rendered already complete (history reload)", () => {
      render(<CollapsibleThinking content={SHORT} isComplete={true} />);
      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    it("keeps a manually collapsed short thinking collapsed through completion", () => {
      const { rerender } = render(
        <CollapsibleThinking content={SHORT} isComplete={false} />,
      );
      fireEvent.click(screen.getByRole("button"));
      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-expanded",
        "false",
      );

      rerender(<CollapsibleThinking content={SHORT} isComplete={true} />);

      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(screen.queryByText(SHORT)).not.toBeInTheDocument();
    });

    it("keeps a manually collapsed completed short thinking collapsed on content updates", () => {
      const { rerender } = render(
        <CollapsibleThinking content={SHORT} isComplete={true} />,
      );
      fireEvent.click(screen.getByRole("button"));
      rerender(
        <CollapsibleThinking content={`${SHORT}。`} isComplete={true} />,
      );
      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("collapses a thinking that grows past the threshold while streaming", () => {
      const { rerender } = render(
        <CollapsibleThinking content={SHORT} isComplete={false} />,
      );
      rerender(<CollapsibleThinking content={LONG} isComplete={false} />);
      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      rerender(<CollapsibleThinking content={LONG} isComplete={true} />);
      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("honours a custom autoCollapseThreshold", () => {
      render(
        <CollapsibleThinking
          content={SHORT}
          isComplete={true}
          autoCollapseThreshold={5}
        />,
      );
      expect(screen.getByRole("button")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
  });

  it("uses a custom label when provided", () => {
    render(
      <CollapsibleThinking
        content="x"
        isComplete={true}
        label="Reasoning"
      />,
    );
    expect(screen.getByText("Reasoning")).toBeInTheDocument();
  });
});
