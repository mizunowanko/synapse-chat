import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SystemMessageBadge } from "./SystemMessageBadge.js";

afterEach(() => cleanup());

const variants = {
  "gate-check": { label: "Gate Check", icon: "🔍", colorClass: "bg-indigo-100 text-indigo-800" },
  "alert": { label: "Alert", colorClass: "bg-red-100 text-red-800" },
};

describe("<SystemMessageBadge />", () => {
  it("renders label and icon for a known subtype", () => {
    render(<SystemMessageBadge subtype="gate-check" variants={variants} />);
    expect(screen.getByText("Gate Check")).toBeInTheDocument();
    expect(screen.getByText("🔍")).toBeInTheDocument();
  });

  it("renders label without icon when icon is omitted", () => {
    render(<SystemMessageBadge subtype="alert" variants={variants} />);
    expect(screen.getByText("Alert")).toBeInTheDocument();
  });

  it("renders fallback for unknown subtype", () => {
    render(
      <SystemMessageBadge
        subtype="unknown"
        variants={variants}
        fallback={<span data-testid="fb">fallback</span>}
      />,
    );
    expect(screen.getByTestId("fb")).toBeInTheDocument();
  });

  it("returns null when subtype is unknown and no fallback provided", () => {
    const { container } = render(
      <SystemMessageBadge subtype="unknown" variants={variants} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("applies className to the badge element", () => {
    const { container } = render(
      <SystemMessageBadge subtype="gate-check" variants={variants} className="extra-class" />,
    );
    expect(container.firstChild).toHaveClass("extra-class");
  });

  it("accepts message prop without type errors", () => {
    render(
      <SystemMessageBadge
        subtype="gate-check"
        variants={variants}
        message={{ type: "system", subtype: "gate-check" }}
      />,
    );
    expect(screen.getByText("Gate Check")).toBeInTheDocument();
  });
});
