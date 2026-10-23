import { describe, expect, it } from "vitest";
import { acceptObservationFramePage, initialObservationFramePages, mergeObservationFramePages, validateObservationFramePage } from "./observationFramePagination";
import { observationFramePage } from "./observationFramePagination.test-support";

describe("observation frame pagination", () => {
  it("appends without replacing previously selected immutable descriptors", () => {
    const first = observationFramePage(["1", "2"], "2");
    const initial = acceptObservationFramePage(initialObservationFramePages("owner-a"), first);
    const next = acceptObservationFramePage({ ...initial, cursor: "2" }, observationFramePage(["3"], "3"));
    const merged = mergeObservationFramePages(next.pages)!;
    expect(merged.frames.map((frame) => frame.frame_id)).toEqual(["1", "2", "3"]);
    expect(merged.frames[0]).toBe(first.frames[0]);
    expect(merged.next_cursor).toBe("3");
    expect(next.cursor).toBe("2"); // A further page still needs an explicit action.
  });

  it("refreshes a bounded window along new cursors while retaining the old pages until complete", () => {
    const first = acceptObservationFramePage(initialObservationFramePages("owner-a"), observationFramePage(["1"], "1"));
    const loaded = acceptObservationFramePage({ ...first, cursor: "1" }, observationFramePage(["2"], "2"));
    const refreshing = acceptObservationFramePage({ ...loaded, cursor: null, refresh: { remaining: 2, pages: [] } }, observationFramePage(["1", "new"], "new"));
    expect(refreshing.pages).toBe(loaded.pages);
    expect(refreshing.cursor).toBe("new");
    expect(refreshing.refresh?.remaining).toBe(1);
    const complete = acceptObservationFramePage(refreshing, observationFramePage(["2"], "2"));
    expect(complete.refresh).toBeNull();
    expect(mergeObservationFramePages(complete.pages)?.frames.map((frame) => frame.frame_id)).toEqual(["1", "new", "2"]);
    expect(complete.cursor).toBe("new");
  });

  it("stops refresh at the end even if more pages had previously been loaded", () => {
    const state = acceptObservationFramePage({ ...initialObservationFramePages("owner-a"), refresh: { remaining: 4, pages: [] } }, observationFramePage(["only"]));
    expect(state.refresh).toBeNull();
    expect(state.pages).toHaveLength(1);
  });

  it("retains an earlier selection displaced beyond a bounded refresh and deduplicates it on Load more", () => {
    const first = acceptObservationFramePage(initialObservationFramePages("owner-a"), observationFramePage(["1", "2"], "2"));
    const old = acceptObservationFramePage({ ...first, cursor: "2" }, observationFramePage(["3", "4"], "4"));
    const selected = old.pages[1].data.frames[1];
    const refresh = acceptObservationFramePage({ ...old, cursor: null, refresh: { remaining: 2, pages: [] } }, observationFramePage(["0", "1"], "1"));
    const refreshed = acceptObservationFramePage(refresh, observationFramePage(["2", "3"], "3"));
    expect(mergeObservationFramePages(refreshed.pages, refreshed.retained)?.frames.map((frame) => frame.frame_id)).toEqual(["0", "1", "2", "3", "4"]);
    expect(refreshed.retained).toEqual([selected]);
    const loaded = acceptObservationFramePage({ ...refreshed, cursor: "3" }, observationFramePage(["4", "5"]));
    expect(loaded.retained).toEqual([]);
    expect(mergeObservationFramePages(loaded.pages, loaded.retained)?.frames.map((frame) => frame.frame_id)).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it.each(["run", "stage", "duplicate", "limit", "cursor", "cursor-not-last", "empty-next"])("rejects a malformed page: %s", (reason) => {
    const page = observationFramePage(["1", "2"], "2");
    if (reason === "run") page.run_id = "run-b";
    if (reason === "stage") page.frames[0].stage_id = "stage-b";
    if (reason === "duplicate") page.frames[1] = page.frames[0];
    if (reason === "limit") page.frames.push({ ...page.frames[0], frame_id: "3" });
    if (reason === "cursor") page.frames[0].frame_id = "before";
    if (reason === "cursor-not-last") page.next_cursor = "1";
    if (reason === "empty-next") { page.frames = []; page.next_cursor = "next"; }
    expect(() => validateObservationFramePage(page, { run_id: "run-a", stage_id: "stage-a", cursor: "before", limit: 2 })).toThrow();
  });

  it("rejects duplicate identities and broken chains across pages", () => {
    const first = acceptObservationFramePage(initialObservationFramePages("owner-a"), observationFramePage(["1", "2"], "2"));
    expect(() => acceptObservationFramePage({ ...first, cursor: "2" }, observationFramePage(["1"]))).toThrow(/repeated a frame/);
    expect(() => acceptObservationFramePage({ ...first, cursor: "other" }, observationFramePage(["3"]))).toThrow(/cursor chain/);
    expect(() => acceptObservationFramePage({ ...first, cursor: "2" }, observationFramePage(["3"], null, "run-b"))).toThrow(/different runs/);
  });
});
