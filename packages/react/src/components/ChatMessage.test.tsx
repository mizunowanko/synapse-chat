import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ChatMessage } from "./ChatMessage.js";

afterEach(() => cleanup());

describe("<ChatMessage />", () => {
  it("renders user message content as plain text", () => {
    render(<ChatMessage message={{ type: "user", content: "hello world" }} />);
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("renders assistant markdown content", () => {
    render(
      <ChatMessage message={{ type: "assistant", content: "**bold**" }} />,
    );
    const bold = screen.getByText("bold");
    expect(bold.tagName).toBe("STRONG");
  });

  it("returns null for system messages without a renderer", () => {
    const { container } = render(
      <ChatMessage message={{ type: "system", subtype: "unknown", content: "x" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("delegates system rendering when renderSystem is provided", () => {
    render(
      <ChatMessage
        message={{ type: "system", subtype: "status", content: "OK" }}
        renderSystem={(m) => <span data-testid="status">{m.content}</span>}
      />,
    );
    expect(screen.getByTestId("status")).toHaveTextContent("OK");
  });

  it("delegates meta rendering when renderMeta returns a node", () => {
    render(
      <ChatMessage
        message={{
          type: "assistant",
          content: "log",
          meta: { category: "log" },
        }}
        renderMeta={(m) => <em data-testid="log">{m.content}</em>}
      />,
    );
    expect(screen.getByTestId("log")).toHaveTextContent("log");
  });

  it("renders collapsed tool_use by default", () => {
    render(
      <ChatMessage
        message={{ type: "tool_use", tool: "Bash", content: "ls -la" }}
      />,
    );
    expect(screen.getByText("[Bash]")).toBeInTheDocument();
    expect(screen.queryByText("ls -la")).not.toBeInTheDocument();
  });
});
