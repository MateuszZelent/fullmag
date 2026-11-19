import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ActiveSessions, sessionPillStatus, type ActiveSession } from "./ActiveSessions";

const session = (over: Partial<ActiveSession> = {}): ActiveSession => ({
  sessionId: "session-1",
  name: "fullmag-python-live",
  status: "awaiting_command",
  current: true,
  ...over,
});

describe("ActiveSessions", () => {
  it("renders nothing without sessions", () => {
    expect(renderToStaticMarkup(<ActiveSessions onOpen={vi.fn()} sessions={[]} />)).toBe("");
  });

  it("offers to open the current session and shows its status word", () => {
    const html = renderToStaticMarkup(<ActiveSessions onOpen={vi.fn()} sessions={[session()]} />);
    expect(html).toContain("Active simulations");
    expect(html).toContain("fullmag-python-live");
    expect(html).toContain("awaiting_command");
    expect(html).toContain("Open simulation");
    expect(html).toContain('data-session-current="true"');
  });

  it("does not offer to open a session the workspace does not show", () => {
    const html = renderToStaticMarkup(
      <ActiveSessions onOpen={vi.fn()} sessions={[session({ current: false, name: "" })]} />,
    );
    expect(html).toContain("Untitled simulation");
    expect(html).not.toContain("Open simulation");
  });

  it("colours lifecycle words by meaning", () => {
    expect(sessionPillStatus("running")).toBe("running");
    expect(sessionPillStatus("failed")).toBe("failed");
    expect(sessionPillStatus("awaiting_command")).toBe("ready");
    expect(sessionPillStatus("waiting_for_compute")).toBe("ready");
    expect(sessionPillStatus("activating")).toBe("draft");
    expect(sessionPillStatus("materializing_script")).toBe("draft");
    expect(sessionPillStatus("closed")).toBe("readonly");
    expect(sessionPillStatus("something_new")).toBe("draft");
  });
});
