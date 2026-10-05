import { describe, expect, it } from "vitest";

import { openLabel, selectBanner, selectResultBanner, selectScriptBanner } from "./bannerModel";
import type { ContinueSession, RecentEntry } from "./types";

const base: RecentEntry = {
  projectId: "p1",
  name: "YIG",
  path: "D:\sim\yig.fms",
  solver: "FDM",
  status: "ready",
  lastOpenedAt: "2026-10-03T10:00:00Z",
};

const session: ContinueSession = {
  projectId: "p1",
  runId: "r-1",
  checkpointAt: "2026-10-03T10:00:00Z",
  device: "RTX 4090",
  resumable: true,
  progress: {
    fraction: 0.64,
    simTimeS: 3.2e-9,
    simTimeTotalS: 5e-9,
    etaSeconds: 720,
  },
};

describe("selectBanner", () => {
  it("returns nothing for an ordinary ready project", () => {
    expect(selectBanner({ entry: base })).toBeNull();
  });

  it("describes a run in progress with time, device and estimate", () => {
    const banner = selectBanner({ entry: { ...base, status: "running" }, session });
    expect(banner).toMatchObject({ id: "running", tone: "warning" });
    expect(banner?.title).toBe("Run in progress — 64%.");
    expect(banner?.body).toBe("t = 3.20 ns of 5.00 ns; on RTX 4090; ≈ 12 min remaining.");
  });

  it("ignores a session that belongs to another project", () => {
    const other = { ...session, projectId: "p2" };
    expect(selectBanner({ entry: { ...base, status: "running" }, session: other })).toBeNull();
  });

  it("omits the estimate rather than guessing it", () => {
    const noEta = { ...session, progress: { ...session.progress, etaSeconds: null } };
    const banner = selectBanner({ entry: { ...base, status: "running" }, session: noEta });
    expect(banner?.body).not.toContain("remaining");
  });

  it("shows the solver error verbatim when the last run failed", () => {
    const lastError = "Run r-0027 diverged at t = 0.41 ns. Likely cause: dt too large.";
    const banner = selectBanner({ entry: { ...base, status: "failed", lastError } });
    expect(banner).toMatchObject({ id: "failed", tone: "danger", body: lastError });
  });

  it("does not invent a failure banner without an error string", () => {
    expect(selectBanner({ entry: { ...base, status: "failed" } })).toBeNull();
  });

  it("names both schema versions for a migration", () => {
    const banner = selectBanner({
      entry: { ...base, status: "migrate", manifestSchemaVersion: "1.0" },
      supportedSchemaVersion: "1.2",
      migrationSteps: ["add history", "add runs"],
    });
    expect(banner?.title).toBe("Archive schema 1.0 → 1.2.");
    expect(banner?.detail).toBe("add history · add runs");
  });

  it("uses the host's reason for a read-only project", () => {
    const banner = selectBanner({
      entry: { ...base, mode: "read_only", modeReason: "Shipped benchmark." },
    });
    expect(banner).toMatchObject({ id: "readonly", tone: "info", body: "Shipped benchmark." });
  });

  it("ranks missing above read-only and failure above read-only", () => {
    expect(
      selectBanner({ entry: { ...base, status: "missing", mode: "read_only" } })?.id,
    ).toBe("missing");
    expect(
      selectBanner({ entry: { ...base, status: "failed", lastError: "x", mode: "read_only" } })?.id,
    ).toBe("failed");
  });

  it("offers removal, not a dead Locate button, for a missing file", () => {
    const banner = selectBanner({ entry: { ...base, status: "missing" } });
    expect(banner?.actions.map((a) => a.id)).toEqual(["forget"]);
  });
});

describe("openLabel", () => {
  it("reflects what opening will do", () => {
    expect(openLabel(base)).toBe("Open project");
    expect(openLabel({ ...base, status: "migrate" })).toBe("Migrate & open");
    expect(openLabel({ ...base, status: "running" })).toBe("Open running project");
  });
});

describe("selectBanner with a waiting checkpoint and an unreadable file", () => {
  it("says a run is paused when a checkpoint of this project waits and nothing runs", () => {
    const banner = selectBanner({ entry: base, session });
    expect(banner).toMatchObject({ id: "paused", tone: "warning", title: "Run paused — 64%." });
    expect(banner?.body).toContain("Open the project");
  });

  it("ignores a checkpoint of another project", () => {
    expect(selectBanner({ entry: base, session: { ...session, projectId: "other" } })).toBeNull();
  });

  it("shows a read error last, after every state of the project itself", () => {
    expect(selectBanner({ entry: base, readError: "truncated archive" })).toMatchObject({
      id: "unreadable",
      detail: "truncated archive",
    });
    expect(
      selectBanner({ entry: { ...base, status: "failed", lastError: "NaN" }, readError: "x" })?.id,
    ).toBe("failed");
    expect(selectBanner({ entry: { ...base, mode: "read_only" }, readError: "x" })?.id).toBe("readonly");
  });

  it("lists the migration steps the backend reported", () => {
    const banner = selectBanner({
      entry: { ...base, status: "migrate", manifestSchemaVersion: "1.0" },
      migrationSteps: ["terms to interactions", "mesh quality added"],
    });
    expect(banner?.detail).toBe("terms to interactions · mesh quality added");
  });
});

describe("selectScriptBanner", () => {
  it("is empty for a healthy script", () => {
    expect(selectScriptBanner({ status: "ready", path: "/a.py" })).toBeNull();
    expect(selectScriptBanner({ status: "ready", path: "/a.py", syntax: { ok: true } })).toBeNull();
  });

  it("reports a missing file with its path", () => {
    expect(selectScriptBanner({ status: "missing", path: "/a.py" })).toMatchObject({
      id: "missing",
      detail: "/a.py",
    });
  });

  it("reports a syntax error verbatim, with the line when known", () => {
    expect(
      selectScriptBanner({
        status: "ready",
        path: "/a.py",
        syntax: { ok: false, line: 14, message: "unexpected indent" },
      }),
    ).toMatchObject({ id: "syntax", tone: "danger", title: "Syntax error at line 14.", body: "unexpected indent" });
    expect(
      selectScriptBanner({ status: "ready", path: "/a.py", syntax: { ok: false } })?.title,
    ).toBe("Syntax error.");
  });

  it("ranks missing above a syntax error, and a read error last", () => {
    expect(
      selectScriptBanner({ status: "missing", path: "/a.py", syntax: { ok: false } })?.id,
    ).toBe("missing");
    expect(selectScriptBanner({ status: "ready", path: "/a.py", readError: "denied" })?.id).toBe(
      "unreadable",
    );
  });
});

describe("selectResultBanner", () => {
  const input = { status: "ready" as const, path: "/r.zarr" };

  it("is empty for a completed folder", () => {
    expect(selectResultBanner(input)).toBeNull();
    expect(selectResultBanner({ ...input, runStatus: "completed" })).toBeNull();
  });

  it("offers removal for a missing folder", () => {
    const banner = selectResultBanner({ ...input, status: "missing" });
    expect(banner).toMatchObject({ id: "missing", tone: "danger", detail: "/r.zarr" });
    expect(banner?.actions.map((a) => a.id)).toEqual(["forget"]);
  });

  it.each([
    ["running", "running", "warning"],
    ["failed", "failed", "danger"],
    ["partial", "incomplete", "warning"],
    ["cancelled", "incomplete", "warning"],
  ])("describes a %s run", (runStatus, id, tone) => {
    expect(selectResultBanner({ ...input, runStatus })).toMatchObject({ id, tone });
  });

  it("treats the folder's own failed state like a failed run, and a read error last", () => {
    expect(selectResultBanner({ ...input, status: "failed" })?.id).toBe("failed");
    expect(selectResultBanner({ ...input, readError: "zarr metadata is missing" })).toMatchObject({
      id: "unreadable",
      detail: "zarr metadata is missing",
    });
  });
});
