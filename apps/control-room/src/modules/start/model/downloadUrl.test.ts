import { afterEach, describe, expect, it, vi } from "vitest";

import { startDownload } from "./downloadUrl";

describe("startDownload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clicks a temporary anchor on the URL and removes it again", () => {
    const events: string[] = [];
    const anchor = {
      href: "",
      rel: "",
      style: { display: "" },
      click: () => events.push(`click ${anchor.href}`),
      remove: () => events.push("remove"),
    };
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { append: () => events.push("append") },
    });
    startDownload("http://host/v2/workspace/items/7/archive");
    expect(events).toEqual(["append", "click http://host/v2/workspace/items/7/archive", "remove"]);
    expect(anchor.rel).toBe("noopener");
  });
});
