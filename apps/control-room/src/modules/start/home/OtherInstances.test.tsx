import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OtherInstances } from "./OtherInstances";

describe("OtherInstances", () => {
  it("renders nothing without other instances", () => {
    expect(renderToStaticMarkup(<OtherInstances instances={[]} onOpen={vi.fn()} />)).toBe("");
  });

  it("lists each instance with its session, status and port", () => {
    const html = renderToStaticMarkup(
      <OtherInstances
        instances={[
          { port: 3206, session: { name: "fullmag-python-live", status: "awaiting_command" } },
          { port: 3210, session: null },
        ]}
        onOpen={vi.fn()}
      />,
    );
    expect(html).toContain("Other instances on this computer");
    expect(html).toContain("fullmag-python-live");
    expect(html).toContain("awaiting_command");
    expect(html).toContain("Port 3206");
    expect(html).toContain("No open session");
    expect(html).toContain('data-instance-port="3210"');
    expect(html.match(/Open in tab/g)).toHaveLength(2);
  });
});
