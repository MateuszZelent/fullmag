import { afterEach, describe, expect, it, vi } from "vitest";

import { parseStartSettings, startSettings } from "./startSettings";

afterEach(() => {
  vi.unstubAllGlobals();
  startSettings.resetForTests();
});

describe("parseStartSettings", () => {
  it("defaults to All, Last used and the list view", () => {
    expect(parseStartSettings(null)).toEqual({
      defaultView: "list",
      recentKind: "all",
      recentSort: "last_used",
    });
  });

  it("keeps valid remembered values", () => {
    expect(
      parseStartSettings({ defaultView: "grid", recentKind: "script", recentSort: "use_count" }),
    ).toEqual({ defaultView: "grid", recentKind: "script", recentSort: "use_count" });
  });

  it("replaces unknown values one by one, so an old settings file still loads", () => {
    expect(parseStartSettings({ defaultView: "grid" })).toEqual({
      defaultView: "grid",
      recentKind: "all",
      recentSort: "last_used",
    });
    expect(parseStartSettings({ recentKind: "everything", recentSort: "weight" })).toMatchObject({
      recentKind: "all",
      recentSort: "last_used",
    });
  });
});

describe("startSettings store", () => {
  function stubStorage(initial: string | null, failWrites = false) {
    const store = { value: initial };
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => store.value,
        setItem: (_key: string, value: string) => {
          if (failWrites) throw new Error("quota");
          store.value = value;
        },
      },
    });
    return store;
  }

  it("remembers the kind and the sort in storage", () => {
    const store = stubStorage(null);
    startSettings.update({ recentKind: "script", recentSort: "name" });
    expect(JSON.parse(store.value ?? "{}")).toMatchObject({ recentKind: "script", recentSort: "name" });

    startSettings.resetForTests();
    expect(startSettings.getSnapshot()).toMatchObject({ recentKind: "script", recentSort: "name" });
  });

  it("still applies a change for the session when storage refuses writes", () => {
    stubStorage(null, true);
    startSettings.update({ recentKind: "project" });
    expect(startSettings.getSnapshot().recentKind).toBe("project");
  });

  it("starts from the defaults when storage holds garbage", () => {
    stubStorage("{not json");
    expect(startSettings.getSnapshot().recentKind).toBe("all");
  });
});
