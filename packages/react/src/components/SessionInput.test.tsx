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
});
