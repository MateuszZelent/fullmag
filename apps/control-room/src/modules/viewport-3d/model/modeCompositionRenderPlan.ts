export interface ModeCompositionRenderTargetDetail {
  targetId: string;
  targetKind: string;
}

export type ConfiguredBaseSurface<TBaseSurface> =
  | { kind: "none" }
  | { kind: "surface"; surface: TBaseSurface };

export interface ModeCompositionModalIdentity {
  compositionId: string;
  layerId: string;
}

export interface ModeCompositionModalCompatibility {
  identity: "matching" | "mismatch";
  topology: "matching" | "mismatch";
}

export type ModeCompositionModalResourceLifecycle<TModalBuffer> =
  | { state: "absent" }
  | ({ state: "disabled" } & ModeCompositionModalIdentity)
  | ({ state: "error" } & ModeCompositionModalIdentity)
  | ({ state: "preparing" } & ModeCompositionModalIdentity)
  | ({ buffer: TModalBuffer; state: "ready" } &
      ModeCompositionModalCompatibility &
      ModeCompositionModalIdentity)
  | ({ retainedBuffer: TModalBuffer | null; state: "degraded" } &
      ModeCompositionModalCompatibility &
      ModeCompositionModalIdentity)
  | ({ retainedBuffer: TModalBuffer | null; state: "refreshing" } &
      ModeCompositionModalCompatibility &
      ModeCompositionModalIdentity);

export interface ModeCompositionRenderPlanTargetInput<
  TTargetDetail extends ModeCompositionRenderTargetDetail,
  TBaseSurface,
  TModalBuffer,
> {
  baseSurface: ConfiguredBaseSurface<TBaseSurface>;
  modal: ModeCompositionModalResourceLifecycle<TModalBuffer>;
  target: TTargetDetail;
}

export type ModeCompositionSurfacePass<TBaseSurface, TModalBuffer> =
  | { owner: "base"; surface: TBaseSurface }
  | {
      buffer: TModalBuffer;
      compositionId: string;
      layerId: string;
      owner: "modal";
    }
  | { owner: "none" };

export type ModeCompositionRenderPlanReasonCode =
  | "base_modal_disabled"
  | "base_modal_error_before_ready"
  | "base_modal_identity_mismatch"
  | "base_modal_preparing"
  | "base_modal_refresh_without_retained_buffer"
  | "base_modal_topology_mismatch"
  | "base_no_modal_layer"
  | "modal_ready"
  | "modal_retained_degraded"
  | "modal_retained_refreshing";

export interface ModeCompositionTargetRenderPlan<
  TTargetDetail extends ModeCompositionRenderTargetDetail,
  TBaseSurface,
  TModalBuffer,
> {
  degraded: boolean;
  reasonCode: ModeCompositionRenderPlanReasonCode;
  surfacePass: ModeCompositionSurfacePass<TBaseSurface, TModalBuffer>;
  target: TTargetDetail;
}

export interface ModeCompositionRenderPlanInvariantViolation<
  TTargetDetail extends ModeCompositionRenderTargetDetail,
> {
  code: "duplicate_surface_owner";
  target: TTargetDetail;
}

export function buildModeCompositionRenderPlan<
  TTargetDetail extends ModeCompositionRenderTargetDetail,
  TBaseSurface,
  TModalBuffer,
>(input: {
  onInvariantViolation?: (
    violation: ModeCompositionRenderPlanInvariantViolation<TTargetDetail>,
  ) => void;
  previousPlan?: readonly ModeCompositionTargetRenderPlan<
    TTargetDetail,
    TBaseSurface,
    TModalBuffer
  >[];
  targets: readonly ModeCompositionRenderPlanTargetInput<
    TTargetDetail,
    TBaseSurface,
    TModalBuffer
  >[];
}): ModeCompositionTargetRenderPlan<
  TTargetDetail,
  TBaseSurface,
  TModalBuffer
>[] {
  const previousByTarget = new Map(
    (input.previousPlan ?? []).map((plan) => [plan.target.targetId, plan]),
  );
  const plannedTargetIds = new Set<string>();
  const plans: ModeCompositionTargetRenderPlan<
    TTargetDetail,
    TBaseSurface,
    TModalBuffer
  >[] = [];

  for (const targetInput of input.targets) {
    if (plannedTargetIds.has(targetInput.target.targetId)) {
      input.onInvariantViolation?.({
        code: "duplicate_surface_owner",
        target: targetInput.target,
      });
      continue;
    }
    plannedTargetIds.add(targetInput.target.targetId);
    const candidate = buildTargetRenderPlan(targetInput);
    const previous = previousByTarget.get(targetInput.target.targetId);
    plans.push(
      previous && sameTargetRenderPlan(previous, candidate)
        ? previous
        : candidate,
    );
  }

  return plans;
}

function buildTargetRenderPlan<
  TTargetDetail extends ModeCompositionRenderTargetDetail,
  TBaseSurface,
  TModalBuffer,
>(
  input: ModeCompositionRenderPlanTargetInput<
    TTargetDetail,
    TBaseSurface,
    TModalBuffer
  >,
): ModeCompositionTargetRenderPlan<
  TTargetDetail,
  TBaseSurface,
  TModalBuffer
> {
  const { modal } = input;
  if (modal.state === "absent") {
    return baseTargetRenderPlan(input, "base_no_modal_layer");
  }
  if (modal.state === "disabled") {
    return baseTargetRenderPlan(input, "base_modal_disabled");
  }
  if (modal.state === "preparing") {
    return baseTargetRenderPlan(input, "base_modal_preparing");
  }
  if (modal.state === "error") {
    return baseTargetRenderPlan(input, "base_modal_error_before_ready");
  }
  if (modal.identity === "mismatch") {
    return baseTargetRenderPlan(input, "base_modal_identity_mismatch");
  }
  if (modal.topology === "mismatch") {
    return baseTargetRenderPlan(input, "base_modal_topology_mismatch");
  }
  if (modal.state === "ready") {
    return {
      degraded: false,
      reasonCode: "modal_ready",
      surfacePass: {
        buffer: modal.buffer,
        compositionId: modal.compositionId,
        layerId: modal.layerId,
        owner: "modal",
      },
      target: input.target,
    };
  }
  if (!modal.retainedBuffer) {
    return baseTargetRenderPlan(
      input,
      "base_modal_refresh_without_retained_buffer",
    );
  }
  return {
    degraded: true,
    reasonCode:
      modal.state === "refreshing"
        ? "modal_retained_refreshing"
        : "modal_retained_degraded",
    surfacePass: {
      buffer: modal.retainedBuffer,
      compositionId: modal.compositionId,
      layerId: modal.layerId,
      owner: "modal",
    },
    target: input.target,
  };
}

function baseTargetRenderPlan<
  TTargetDetail extends ModeCompositionRenderTargetDetail,
  TBaseSurface,
  TModalBuffer,
>(
  input: ModeCompositionRenderPlanTargetInput<
    TTargetDetail,
    TBaseSurface,
    TModalBuffer
  >,
  reasonCode: Exclude<
    ModeCompositionRenderPlanReasonCode,
    "modal_ready" | "modal_retained_degraded" | "modal_retained_refreshing"
  >,
): ModeCompositionTargetRenderPlan<
  TTargetDetail,
  TBaseSurface,
  TModalBuffer
> {
  return {
    degraded: false,
    reasonCode,
    surfacePass:
      input.baseSurface.kind === "surface"
        ? { owner: "base", surface: input.baseSurface.surface }
        : { owner: "none" },
    target: input.target,
  };
}

function sameTargetRenderPlan<
  TTargetDetail extends ModeCompositionRenderTargetDetail,
  TBaseSurface,
  TModalBuffer,
>(
  left: ModeCompositionTargetRenderPlan<
    TTargetDetail,
    TBaseSurface,
    TModalBuffer
  >,
  right: ModeCompositionTargetRenderPlan<
    TTargetDetail,
    TBaseSurface,
    TModalBuffer
  >,
): boolean {
  if (
    left.target !== right.target ||
    left.degraded !== right.degraded ||
    left.reasonCode !== right.reasonCode ||
    left.surfacePass.owner !== right.surfacePass.owner
  ) {
    return false;
  }
  if (left.surfacePass.owner === "base") {
    return (
      right.surfacePass.owner === "base" &&
      left.surfacePass.surface === right.surfacePass.surface
    );
  }
  if (left.surfacePass.owner === "modal") {
    return (
      right.surfacePass.owner === "modal" &&
      left.surfacePass.buffer === right.surfacePass.buffer &&
      left.surfacePass.compositionId === right.surfacePass.compositionId &&
      left.surfacePass.layerId === right.surfacePass.layerId
    );
  }
  return right.surfacePass.owner === "none";
}
