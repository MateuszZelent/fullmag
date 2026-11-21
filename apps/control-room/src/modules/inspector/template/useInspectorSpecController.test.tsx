import { Atom, Layers, SlidersHorizontal } from "lucide-react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";

import type { InspectorSpec } from "./types";
import {
  resetPersistedInspectorModeTabs,
  useInspectorSpecController,
  type InspectorSpecController,
} from "./useInspectorSpecController";

interface MaterialDraft {
  ms: number;
  alpha: number;
  showVectors: boolean;
}

const SELECTION_A: Selection = {
  kind: "object.magnetic-parameters",
  label: "film",
  moduleSource: "explorer",
  nodeId: "model:objects:film:material",
  objectId: "film",
  ref: { type: "object", objectId: "film" },
};

function createMaterialSpec(
  onApply: (draft: MaterialDraft, baseline: MaterialDraft) => Promise<boolean>,
  withConfirm = false,
): InspectorSpec<MaterialDraft> {
  return {
    id: "object.material.controller-test",
    header: { breadcrumbs: [{ id: "film", label: "film" }] },
    identity: {
      domain: "material",
      icon: Atom,
      title: () => "Permalloy",
      kindLabel: "Material",
      statePill: () => ({ tone: "ok", label: "Committed" }),
    },
    facts: () => [],
    modeTabs: [
      { id: "core", label: "Core" },
      { id: "display", label: "Display", commitModeOverride: "liveViewport" },
    ],
    sections: [
      {
        id: "core",
        title: "Core",
        icon: SlidersHorizontal,
        modeTabId: "core",
        rows: [
          {
            type: "quantity",
            key: "ms",
            label: "Saturation magnetization",
            units: [{ unit: "kA/m", toSiFactor: 1e3 }],
            min: 0,
          },
          {
            type: "number",
            key: "alpha",
            label: "Gilbert damping",
            validate: (v) => (v < 0 ? "Damping must be non-negative." : null),
          },
        ],
      },
      {
        id: "live",
        title: "Viewport overlays",
        icon: Layers,
        modeTabId: "core",
        live: true,
        rows: [
          {
            type: "switch",
            key: "showVectors",
            label: "Show vectors",
          },
        ],
      },
    ],
    commitBar: {
      mode: "staged",
      confirmApply: withConfirm
        ? () => ({
            title: "Rebuild mesh?",
            description: "Updates material parameters.",
            confirmLabel: "Apply",
          })
        : undefined,
      onApply,
    },
  };
}

let restoreDom: (() => void) | null = null;

afterEach(() => {
  restoreDom?.();
  restoreDom = null;
  resetPersistedInspectorModeTabs();
  vi.useRealTimers();
});

describe("useInspectorSpecController", () => {
  it("rebases clean fields on incoming baseline updates while keeping dirty fields and animationKey stable", () => {
    const env = installSimulationPreparationTestDom();
    restoreDom = env.restore;
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const spec = createMaterialSpec(async () => true);
    const onLiveChange = vi.fn();
    let latest!: InspectorSpecController<MaterialDraft>;

    function Harness({ baseline }: { baseline: MaterialDraft }) {
      latest = useInspectorSpecController(spec, SELECTION_A, baseline, undefined, {
        onLiveFieldChange: onLiveChange,
      });
      return null;
    }

    act(() => {
      root.render(<Harness baseline={{ ms: 8e5, alpha: 0.008, showVectors: true }} />);
    });

    const initialAnimationKey = latest.animationKey;
    expect(latest.phase).toBe("stagedClean");
    expect(latest.dirty).toBe(false);

    // User edits ms (staged) and showVectors (live section).
    act(() => {
      latest.setField("ms", 8.2e5);
      latest.setField("showVectors", false);
    });
    expect(latest.dirty).toBe(true);
    expect(Array.from(latest.dirtyFields)).toEqual(["ms"]);
    expect(latest.dirtyFieldLabels).toEqual(["Saturation magnetization"]);
    expect(onLiveChange).toHaveBeenCalledWith("showVectors", false);
    expect(latest.phase).toBe("dirtyValid");

    // Incoming revision updates alpha while ms remains dirty.
    act(() => {
      root.render(<Harness baseline={{ ms: 8e5, alpha: 0.012, showVectors: true }} />);
    });
    expect(latest.draft.alpha).toBe(0.012);
    expect(latest.draft.ms).toBe(8.2e5);
    expect(Array.from(latest.dirtyFields)).toEqual(["ms"]);
    expect(latest.animationKey).toBe(initialAnimationKey);

    // Switching display unit never dirties the draft.
    act(() => {
      latest.setDisplayUnit("ms", "MA/m");
    });
    expect(latest.displayUnits.ms).toBe("MA/m");
    expect(Array.from(latest.dirtyFields)).toEqual(["ms"]);

    // Reverting single field returns to stagedClean.
    act(() => {
      latest.revertField("ms");
    });
    expect(latest.draft.ms).toBe(8e5);
    expect(latest.dirty).toBe(false);
    expect(latest.phase).toBe("stagedClean");

    act(() => {
      root.unmount();
    });
  });

  it("drives staged state transitions including confirmCostly, appliedFlash 3000ms, and applyRejected preservation", async () => {
    vi.useFakeTimers();
    const env = installSimulationPreparationTestDom();
    restoreDom = env.restore;
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    let applyOutcome = false;
    const onApply = vi.fn(async () => applyOutcome);
    const spec = createMaterialSpec(onApply, true);
    let latest!: InspectorSpecController<MaterialDraft>;

    function Harness({ baseline }: { baseline: MaterialDraft }) {
      latest = useInspectorSpecController(spec, SELECTION_A, baseline);
      return null;
    }

    act(() => {
      root.render(<Harness baseline={{ ms: 8e5, alpha: 0.008, showVectors: true }} />);
    });

    // Invalid edit transitions to dirtyInvalid.
    act(() => {
      latest.setField("alpha", -0.05);
    });
    expect(latest.phase).toBe("dirtyInvalid");
    expect(latest.invalidFields.get("alpha")).toBe("Damping must be non-negative.");

    // Fix invalid field -> dirtyValid, requestApply -> confirmCostly.
    act(() => {
      latest.setField("alpha", 0.02);
    });
    expect(latest.phase).toBe("dirtyValid");

    await act(async () => {
      await latest.requestApply();
    });
    expect(latest.phase).toBe("confirmCostly");
    expect(latest.pendingConfirm?.title).toBe("Rebuild mesh?");

    // Rejected apply preserves draft and dirtyFields!
    await act(async () => {
      await latest.confirmPendingApply();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(latest.phase).toBe("applyRejected");
    expect(latest.draft.alpha).toBe(0.02);
    expect(latest.dirtyFields.has("alpha")).toBe(true);

    // Succeeding apply enters appliedFlash for 3000ms then returns to stagedClean.
    applyOutcome = true;
    await act(async () => {
      await latest.requestApply();
    });
    await act(async () => {
      await latest.confirmPendingApply();
    });
    expect(latest.phase).toBe("appliedFlash");
    expect(latest.appliedFlash).toBe(true);
    expect(latest.dirty).toBe(false);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(latest.appliedFlash).toBe(false);
    expect(latest.phase).toBe("stagedClean");

    act(() => {
      root.unmount();
    });
  });
});
