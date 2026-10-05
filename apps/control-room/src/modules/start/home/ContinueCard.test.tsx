import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CheckpointEntry } from "@/kernel/api/apiTypes";

import {
  findElement,
  installSimulationPreparationTestDom,
} from "../../../kernel/layout/simulationPreparationTestDom.test-support";
import {
  REASON_DISCARD_RESTORE_SOURCE,
  REASON_PROJECT_CLOSED,
  resolveContinue,
  type ContinueLiveInput,
} from "../model/continueModel";
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

  it("draws no Discard action without a handler or without an open session", () => {
    const closed = resolveContinue(session, null);
    expect(render(closed, vi.fn())).not.toContain("Discard");
    expect(render(openResolution())).not.toContain("Discard");
    expect(render(openResolution(), vi.fn())).toContain("Discard checkpoint");
  });

  it("shows a disabled Discard with the reason for the restore source", () => {
    const html = render(
      openResolution({
        run: { ...liveInput().run!, restoreSourceCheckpointIds: ["c-2"] },
      }),
      vi.fn(),
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-action="discard"|data-action="discard"[^>]*disabled/);
    expect(html).toContain(REASON_DISCARD_RESTORE_SOURCE);
  });
});

const checkpoint: CheckpointEntry = {
  artifact_ref: "a",
  backend_family: "fdm_cuda",
  checkpoint_id: "c-2",
  coordinate_frame: "solver_domain",
  created_at: "2026-10-03T12:04:02Z",
  dt: 1e-13,
  format: "fmstate",
  resume_class: "exact_resume",
  run_id: "r",
  source: "manual",
  step: 256,
  time_s: 3.2e-9,
  vector_count: 1000,
};

function liveInput(patch: Partial<ContinueLiveInput> = {}): ContinueLiveInput {
  return {
    catalog: { kind: "ready", checkpoints: [checkpoint] },
    run: { runId: "r", requestedDevice: "cpu", resolvedRuntimeFamily: "fdm_cuda", totalSteps: 400 },
    compute: null,
    restoring: false,
    ...patch,
  };
}

const openResolution = (patch: Partial<ContinueLiveInput> = {}) =>
  resolveContinue(session, liveInput(patch));

describe("ContinueCard discard confirmation", () => {
  let restoreDom: (() => void) | null = null;
  let mounted: Root[] = [];

  afterEach(async () => {
    await act(async () => mounted.forEach((root) => root.unmount()));
    mounted = [];
    restoreDom?.();
    restoreDom = null;
  });

  async function mount(onDiscard: (id: string) => void, busy = false) {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    mounted.push(root);
    const draw = (isBusy: boolean) =>
      act(async () =>
        root.render(
          <ContinueCard
            busy={isBusy}
            entry={entry}
            onDiscard={onDiscard}
            onOpen={vi.fn()}
            onResume={vi.fn()}
            resolution={openResolution()}
          />,
        ),
      );
    await draw(busy);
    const action = (name: string) =>
      findElement(container, (e) => e.getAttribute("data-action") === name, name);
    const has = (name: string) => container.innerHTML.includes(`data-action="${name}"`);
    return { action, draw, has, container };
  }

  it("asks before deleting: the first click only opens the question", async () => {
    const onDiscard = vi.fn();
    const view = await mount(onDiscard);
    await act(async () => view.action("discard").click());
    expect(onDiscard).not.toHaveBeenCalled();
    expect(view.container.innerHTML).toContain("Discard the checkpoint at step 256?");
    expect(view.has("discard")).toBe(false);

    await act(async () => view.action("discard-confirm").click());
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledWith("c-2");
  });

  it("Keep closes the question without calling the runtime", async () => {
    const onDiscard = vi.fn();
    const view = await mount(onDiscard);
    await act(async () => view.action("discard").click());
    await act(async () => view.action("discard-cancel").click());
    expect(onDiscard).not.toHaveBeenCalled();
    expect(view.has("discard")).toBe(true);
    expect(view.has("discard-confirm")).toBe(false);
  });

  it("shows busy while the runtime works and rests again once it answers", async () => {
    const view = await mount(vi.fn());
    await act(async () => view.action("discard").click());
    await view.draw(true);
    expect(view.container.innerHTML).toContain("Discarding…");
    expect(view.action("discard-confirm").getAttribute("disabled")).not.toBeNull();
    await view.draw(false);
    expect(view.has("discard-confirm")).toBe(false);
    expect(view.has("discard")).toBe(true);
  });
});
