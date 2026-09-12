import { describe, expect, it } from "vitest";

import {
  buildModeCompositionRenderPlan,
  type ModeCompositionModalResourceLifecycle,
  type ModeCompositionRenderPlanTargetInput,
} from "./modeCompositionRenderPlan";

interface TestTargetDetail {
  targetId: string;
  targetKind: "object";
}

interface TestBaseSurface {
  materialId: string;
  opacity: number;
}

interface TestModalBuffer {
  bufferId: string;
}

type TestTargetInput = ModeCompositionRenderPlanTargetInput<
  TestTargetDetail,
  TestBaseSurface,
  TestModalBuffer
>;

const modalIdentity = {
  compositionId: "composition:active",
  layerId: "mode-layer:film",
} as const;

const matchingCompatibility = {
  identity: "matching",
  topology: "matching",
} as const;

function targetInput(
  modal: ModeCompositionModalResourceLifecycle<TestModalBuffer>,
  overrides: Partial<TestTargetInput> = {},
): TestTargetInput {
  return {
    baseSurface: {
      kind: "surface",
      surface: { materialId: "base:film", opacity: 0.42 },
    },
    modal,
    target: { targetId: "object:film", targetKind: "object" },
    ...overrides,
  };
}

describe("modeCompositionRenderPlan", () => {
  it.each([
    {
      expectedDegraded: false,
      expectedOwner: "base",
      expectedReason: "base_no_modal_layer",
      modal: { state: "absent" },
      name: "removed layer",
    },
    {
      expectedDegraded: false,
      expectedOwner: "base",
      expectedReason: "base_modal_disabled",
      modal: { ...modalIdentity, state: "disabled" },
      name: "disabled layer",
    },
    {
      expectedDegraded: false,
      expectedOwner: "base",
      expectedReason: "base_modal_preparing",
      modal: { ...modalIdentity, state: "preparing" },
      name: "preparing before first ready",
    },
    {
      expectedDegraded: false,
      expectedOwner: "base",
      expectedReason: "base_modal_error_before_ready",
      modal: { ...modalIdentity, state: "error" },
      name: "error before first ready",
    },
    {
      expectedDegraded: false,
      expectedOwner: "modal",
      expectedReason: "modal_ready",
      modal: {
        ...matchingCompatibility,
        ...modalIdentity,
        buffer: { bufferId: "mode:current" },
        state: "ready",
      },
      name: "ready compatible buffer",
    },
    {
      expectedDegraded: true,
      expectedOwner: "modal",
      expectedReason: "modal_retained_refreshing",
      modal: {
        ...matchingCompatibility,
        ...modalIdentity,
        retainedBuffer: { bufferId: "mode:retained" },
        state: "refreshing",
      },
      name: "same-topology refresh with retained buffer",
    },
    {
      expectedDegraded: true,
      expectedOwner: "modal",
      expectedReason: "modal_retained_degraded",
      modal: {
        ...matchingCompatibility,
        ...modalIdentity,
        retainedBuffer: { bufferId: "mode:retained" },
        state: "degraded",
      },
      name: "same-topology degraded resource with retained buffer",
    },
    {
      expectedDegraded: false,
      expectedOwner: "base",
      expectedReason: "base_modal_identity_mismatch",
      modal: {
        identity: "mismatch",
        topology: "matching",
        ...modalIdentity,
        buffer: { bufferId: "mode:wrong-identity" },
        state: "ready",
      },
      name: "identity mismatch",
    },
    {
      expectedDegraded: false,
      expectedOwner: "base",
      expectedReason: "base_modal_topology_mismatch",
      modal: {
        identity: "matching",
        topology: "mismatch",
        ...modalIdentity,
        retainedBuffer: { bufferId: "mode:wrong-topology" },
        state: "refreshing",
      },
      name: "topology mismatch",
    },
  ] as const)(
    "selects one effective surface pass for $name",
    ({ expectedDegraded, expectedOwner, expectedReason, modal }) => {
      const [plan] = buildModeCompositionRenderPlan({
        targets: [targetInput(modal)],
      });

      expect(plan).toMatchObject({
        degraded: expectedDegraded,
        reasonCode: expectedReason,
        target: { targetId: "object:film", targetKind: "object" },
      });
      expect(plan?.surfacePass.owner).toBe(expectedOwner);
      expect(
        Object.keys(plan ?? {}).filter((key) => key === "surfacePass"),
      ).toHaveLength(1);
    },
  );

  it("restores the exact configured base surface after disable or removal", () => {
    const configuredSurface = { materialId: "base:custom", opacity: 0.17 };
    const baseSurface = { kind: "surface", surface: configuredSurface } as const;

    for (const modal of [
      { ...modalIdentity, state: "disabled" } as const,
      { state: "absent" } as const,
    ]) {
      const [plan] = buildModeCompositionRenderPlan({
        targets: [targetInput(modal, { baseSurface })],
      });

      expect(plan?.surfacePass).toEqual({
        owner: "base",
        surface: configuredSurface,
      });
      if (plan?.surfacePass.owner === "base") {
        expect(plan.surfacePass.surface).toBe(configuredSurface);
      }
    }

    const [hiddenPlan] = buildModeCompositionRenderPlan({
      targets: [
        targetInput(
          { ...modalIdentity, state: "disabled" },
          { baseSurface: { kind: "none" } },
        ),
      ],
    });
    expect(hiddenPlan?.surfacePass).toEqual({ owner: "none" });
  });

  it("fails closed to base when refresh has no retained compatible buffer", () => {
    const [plan] = buildModeCompositionRenderPlan({
      targets: [
        targetInput({
          ...matchingCompatibility,
          ...modalIdentity,
          retainedBuffer: null,
          state: "refreshing",
        }),
      ],
    });

    expect(plan).toMatchObject({
      degraded: false,
      reasonCode: "base_modal_refresh_without_retained_buffer",
      surfacePass: { owner: "base" },
    });
  });

  it("keeps target B unchanged and referentially stable when only target A changes", () => {
    const targetB = targetInput(
      {
        ...matchingCompatibility,
        compositionId: "composition:active",
        layerId: "mode-layer:b",
        buffer: { bufferId: "mode:b" },
        state: "ready",
      },
      {
        target: { targetId: "object:b", targetKind: "object" },
      },
    );
    const targetADetail = {
      targetId: "object:a",
      targetKind: "object",
    } as const;
    const first = buildModeCompositionRenderPlan({
      targets: [
        targetInput({ state: "absent" }, { target: targetADetail }),
        targetB,
      ],
    });
    const firstByTarget = new Map(first.map((plan) => [plan.target.targetId, plan]));

    const second = buildModeCompositionRenderPlan({
      previousPlan: first,
      targets: [
        targetInput(
          {
            ...matchingCompatibility,
            ...modalIdentity,
            buffer: { bufferId: "mode:a" },
            state: "ready",
          },
          { target: targetADetail },
        ),
        targetB,
      ],
    });
    const secondByTarget = new Map(
      second.map((plan) => [plan.target.targetId, plan]),
    );

    expect(secondByTarget.get("object:a")).not.toBe(
      firstByTarget.get("object:a"),
    );
    expect(secondByTarget.get("object:b")).toBe(firstByTarget.get("object:b"));
    expect(secondByTarget.get("object:b")?.surfacePass).toEqual({
      buffer: { bufferId: "mode:b" },
      compositionId: "composition:active",
      layerId: "mode-layer:b",
      owner: "modal",
    });
  });

  it("publishes a typed duplicate owner diagnostic and never plans a second pass", () => {
    const violations: unknown[] = [];
    const duplicateTarget = {
      targetId: "object:duplicate",
      targetKind: "object",
    } as const;

    const plan = buildModeCompositionRenderPlan({
      onInvariantViolation: (violation) => violations.push(violation),
      targets: [
        targetInput({ state: "absent" }, { target: duplicateTarget }),
        targetInput(
          {
            ...matchingCompatibility,
            ...modalIdentity,
            buffer: { bufferId: "mode:duplicate" },
            state: "ready",
          },
          { target: duplicateTarget },
        ),
      ],
    });

    expect(plan).toHaveLength(1);
    expect(plan[0]?.surfacePass.owner).toBe("base");
    expect(violations).toEqual([
      {
        code: "duplicate_surface_owner",
        target: duplicateTarget,
      },
    ]);
  });
});
