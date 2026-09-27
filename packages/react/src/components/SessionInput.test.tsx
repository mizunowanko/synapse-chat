import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SessionInput } from "./SessionInput.js";

afterEach(() => cleanup());

describe("<SessionInput />", () => {
  it("calls onChange when the textarea changes", () => {
    const onChange = vi.fn();
    render(
      <SessionInput value="" onChange={onChange} onSend={() => {}} />,
    );
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(onChange).toHaveBeenCalledWith("hi");
  });

  it("sends on Enter without shift and clears value via onChange", () => {
    const onSend = vi.fn();
    const onChange = vi.fn();
    render(
      <SessionInput value="hi" onChange={onChange} onSend={onSend} />,
    );
    const textarea = screen.getByRole("textbox");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hi", undefined);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("does NOT send on Shift+Enter", () => {
    const onSend = vi.fn();
    render(
      <SessionInput value="hi" onChange={() => {}} onSend={onSend} />,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      shiftKey: true,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables send button when value is empty and no images attached", () => {
    render(
      <SessionInput value="" onChange={() => {}} onSend={() => {}} />,
    );
    const buttons = screen.getAllByRole("button");
    const sendButton = buttons[buttons.length - 1]!;
    expect(sendButton).toBeDisabled();
  });

  describe("actions (#64)", () => {
    it("stacks the actions directly above the send button in one column", () => {
      render(
        <SessionInput
          value="hi"
          onChange={() => {}}
          onSend={() => {}}
          actions={<button type="button" data-testid="extra-action">T</button>}
        />,
      );
      const column = screen.getByTestId("session-input-actions");
      const children = Array.from(column.children);
      expect(children).toHaveLength(2);
      expect(children[0]).toBe(screen.getByTestId("extra-action"));
      expect(children[1]).toBe(screen.getByTestId("session-input-send"));
      expect(column).toHaveClass("flex-col");
      // Two 24px rows == two text lines, so the column matches minRows={2}.
      expect(screen.getByTestId("session-input-send")).toHaveClass("h-6");
      // Same row as the textarea: the column is a sibling of it.
      expect(column.parentElement).toBe(
        screen.getByTestId("session-input-textarea").parentElement,
      );
    });

    it("keeps the single 36px send button when no actions are given", () => {
      render(<SessionInput value="" onChange={() => {}} onSend={() => {}} />);
      expect(screen.queryByTestId("session-input-actions")).toBeNull();
      const send = screen.getByTestId("session-input-send");
      expect(send).toHaveClass("h-9");
      expect(send.parentElement).toBe(
        screen.getByTestId("session-input-textarea").parentElement,
      );
    });

    it("still sends from the send button inside the column", () => {
      const onSend = vi.fn();
      render(
        <SessionInput
          value="hi"
          onChange={() => {}}
          onSend={onSend}
          actions={<button type="button">T</button>}
        />,
      );
      fireEvent.click(screen.getByTestId("session-input-send"));
      expect(onSend).toHaveBeenCalledWith("hi", undefined);
    });
  });

  describe("minRows (#64)", () => {
    it("defaults to a single row", () => {
      render(<SessionInput value="" onChange={() => {}} onSend={() => {}} />);
      expect(screen.getByTestId("session-input-textarea")).toHaveAttribute("rows", "1");
    });

    it("shows minRows lines while empty", () => {
      render(
        <SessionInput value="" onChange={() => {}} onSend={() => {}} minRows={2} />,
      );
      expect(screen.getByTestId("session-input-textarea")).toHaveAttribute("rows", "2");
    });
  });
});
