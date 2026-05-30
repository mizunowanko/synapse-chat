import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CollapsibleThinking } from "./CollapsibleThinking.js";

afterEach(() => cleanup());

describe("<CollapsibleThinking />", () => {
  it("renders expanded while incomplete and shows the thinking content", () => {
    render(
      <CollapsibleThinking content="line a\nline b" isComplete={false} />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/line a/)).toBeInTheDocument();
    expect(screen.getByText(/Thinking\.\.\./)).toBeInTheDocument();
  });

  it("auto-collapses once isComplete flips to true", () => {
    const { rerender } = render(
      <CollapsibleThinking content="reasoning" isComplete={false} />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");

    rerender(<CollapsibleThinking content="reasoning" isComplete={true} />);

    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText("reasoning")).not.toBeInTheDocument();
  });

  it("respects manual user toggles after auto state changes", () => {
    const { rerender } = render(
      <CollapsibleThinking content="reasoning" isComplete={false} />,
    );

    rerender(<CollapsibleThinking content="reasoning" isComplete={true} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("reasoning")).toBeInTheDocument();
  });

  it("hides the content pane while collapsed", () => {
    render(<CollapsibleThinking content="secret" isComplete={true} />);
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("secret")).toBeInTheDocument();
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
