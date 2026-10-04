import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { REASON_PROJECT_CLOSED, resolveContinue } from "../model/continueModel";
import type { ContinueSession, RecentEntry } from "../model/types";

import { ContinueCard } from "./ContinueCard";

const session: ContinueSession = {
  projectId: "p",
  runId: "r",
  checkpointAt: "",
  resumable: true,
  progress: { fraction: 0.5, etaSeconds: null },
};

const entry: RecentEntry = {
  projectId: "p",
  name: "Vortex",
  path: "/v.fms",
  solver: "FDM",
  status: "running",
  lastOpenedAt: "2026-10-03T00:00:00Z",
};

const render = (resolution: ReturnType<typeof resolveContinue>, onDiscard?: () => void) =>
  renderToStaticMarkup(
    <ContinueCard
      busy={false}
      entry={entry}
      onDiscard={onDiscard}
      onOpen={vi.fn()}
      onResume={vi.fn()}
      resolution={resolution}
    />,
  );

describe("ContinueCard", () => {
  it("shows Resume disabled, with the reason, when the project is not open", () => {
    const html = render(resolveContinue(session, null));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Restore checkpoint/);
    expect(html).toContain(REASON_PROJECT_CLOSED);
    expect(html).toContain('data-continue-status="project-closed"');
  });

  it("removes Resume entirely when this machine cannot resume", () => {
    const html = render(
      resolveContinue({ ...session, resumable: false, notResumableReason: "Needs CUDA 12." }, null),
    );
    expect(html).not.toContain("Restore checkpoint");
    expect(html).toContain("Needs CUDA 12.");
    expect(html).toContain("Open project");
  });

  it("draws no Discard action unless the runtime can delete a checkpoint", () => {
    const resolution = resolveContinue(session, null);
    expect(render(resolution)).not.toContain("Discard");
    expect(render(resolution, vi.fn())).toContain("Discard checkpoint");
  });
});
