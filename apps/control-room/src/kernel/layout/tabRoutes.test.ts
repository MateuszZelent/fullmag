import { describe, expect, it } from "vitest";

import type { DiscoveredInstance } from "../api/apiTypes";
import {
  activeTabRoute,
  formatTabRoute,
  parseTabRoute,
  resolveTabRoute,
  sessionSlug,
  tabRouteChangePushes,
  tabRouteHref,
} from "./tabRoutes";

function instance(port: number, name: string | null, isSelf = false): DiscoveredInstance {
  return {
    api_instance_id: `api-${port}`,
    is_self: isSelf,
    port,
    sessions: name === null
      ? []
      : [{ current: true, name, session_id: `session-${port}`, status: "awaiting_command" }],
  };
}

describe("tab addresses", () => {
  it("slugs session names into readable, URL-safe segments", () => {
    expect(sessionSlug("Viewport R7 QA CPU 2026-10-24")).toBe("viewport-r7-qa-cpu-2026-10-24");
    expect(sessionSlug("permalloy_layer_relax_300nm_fdm")).toBe("permalloy_layer_relax_300nm_fdm");
    expect(sessionSlug("Pętla histerezy — łączenie")).toBe("petla-histerezy-laczenie");
    expect(sessionSlug("  ")).toBe("untitled");
    expect(sessionSlug("a".repeat(200))).toHaveLength(96);
  });

  it("parses and formats every tab address", () => {
    expect(parseTabRoute("/home", "")).toEqual({ kind: "home" });
    expect(parseTabRoute("/home/", "")).toEqual({ kind: "home" });
    expect(parseTabRoute("/session/rings_fdm", "")).toEqual({ kind: "session", slug: "rings_fdm", port: null });
    expect(parseTabRoute("/session/Rings%20FDM", "?port=3219")).toEqual({
      kind: "session",
      slug: "rings-fdm",
      port: 3219,
    });
    expect(parseTabRoute("/instance/3201", "")).toEqual({ kind: "instance", port: 3201 });
    for (const pathname of ["/", "/workspace", "/instance/99999", "/session/%E0%A4%A", "/unknown"]) {
      expect(parseTabRoute(pathname, "")).toEqual({ kind: "default" });
    }
    expect(parseTabRoute("/session/x", "?port=0")).toEqual({ kind: "session", slug: "x", port: null });

    expect(formatTabRoute({ kind: "home" })).toBe("/home");
    expect(formatTabRoute({ kind: "session", slug: "rings-fdm", port: null })).toBe("/session/rings-fdm");
    expect(formatTabRoute({ kind: "session", slug: "rings-fdm", port: 3219 })).toBe("/session/rings-fdm?port=3219");
    expect(formatTabRoute({ kind: "instance", port: 3201 })).toBe("/instance/3201");
  });

  it("keeps query parameters the tab address does not own", () => {
    const session = { kind: "session", slug: "rings", port: null } as const;
    expect(tabRouteHref(session, "")).toBe("/session/rings");
    expect(tabRouteHref(session, "?inspectorRealtimeFixture=1")).toBe(
      "/session/rings?inspectorRealtimeFixture=1",
    );
    expect(tabRouteHref({ ...session, port: 3219 }, "?debug=1&port=3198")).toBe(
      "/session/rings?debug=1&port=3219",
    );
    expect(tabRouteHref({ kind: "home" }, "?port=3198")).toBe("/home");
  });

  it("names the tab the strip has in front", () => {
    const instances = new Map([[3219, instance(3219, "Viewport QA")], [3201, instance(3201, null)]]);
    const base = { homeOpen: false, activePort: null, currentSessionName: "Rings", instances };
    expect(activeTabRoute(base)).toEqual({ kind: "session", slug: "rings", port: null });
    expect(activeTabRoute({ ...base, homeOpen: true })).toEqual({ kind: "home" });
    expect(activeTabRoute({ ...base, currentSessionName: null })).toEqual({ kind: "home" });
    expect(activeTabRoute({ ...base, activePort: 3219 })).toEqual({
      kind: "session",
      slug: "viewport-qa",
      port: 3219,
    });
    expect(activeTabRoute({ ...base, activePort: 3201 })).toEqual({ kind: "instance", port: 3201 });
    expect(activeTabRoute({ ...base, activePort: 3201, instances: null })).toEqual({ kind: "instance", port: 3201 });
  });

  it("resolves an address to this session, another instance or Home", () => {
    const context = {
      currentSessionName: "Rings",
      instances: [instance(3258, "Rings", true), instance(3219, "Viewport QA")],
    };
    expect(resolveTabRoute({ kind: "home" }, context)).toEqual({ kind: "home" });
    expect(resolveTabRoute({ kind: "default" }, context)).toEqual({ kind: "none" });
    expect(resolveTabRoute({ kind: "session", slug: "rings", port: null }, context)).toEqual({ kind: "session" });
    expect(resolveTabRoute({ kind: "session", slug: "viewport-qa", port: null }, context)).toEqual({
      kind: "instance",
      port: 3219,
    });
    expect(resolveTabRoute({ kind: "session", slug: "anything", port: 3206 }, context)).toEqual({
      kind: "instance",
      port: 3206,
    });
    expect(resolveTabRoute({ kind: "session", slug: "gone", port: null }, context)).toEqual({ kind: "home" });
    expect(
      resolveTabRoute({ kind: "session", slug: "viewport-qa", port: null }, { ...context, instances: null }),
    ).toBe("wait");
    // This instance's own entry is not another tab.
    expect(
      resolveTabRoute(
        { kind: "session", slug: "rings", port: null },
        { currentSessionName: null, instances: [instance(3258, "Rings", true)] },
      ),
    ).toEqual({ kind: "home" });
  });

  it("adds history entries only when the tab changes", () => {
    const session = { kind: "session", slug: "rings", port: null } as const;
    const other = { kind: "session", slug: "viewport-qa", port: 3219 } as const;
    expect(tabRouteChangePushes({ kind: "home" }, session, [])).toBe(true);
    expect(tabRouteChangePushes(session, other, [3219])).toBe(true);
    expect(tabRouteChangePushes(session, { ...session, slug: "renamed" }, [])).toBe(false);
    expect(tabRouteChangePushes({ kind: "default" }, session, [])).toBe(false);
    expect(tabRouteChangePushes({ kind: "instance", port: 3219 }, other, [3219])).toBe(false);
    // Closing the tab in front corrects the address instead of keeping it in history.
    expect(tabRouteChangePushes(other, session, [])).toBe(false);
  });
});
