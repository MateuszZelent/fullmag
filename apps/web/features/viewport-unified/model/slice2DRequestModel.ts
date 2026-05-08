import type { ResourceRevisionMap } from "@/src/api/types";
import {
  createFdmSlice2DAdapter,
  createFemSlice2DAdapter,
} from "@/src/features/slice2d/adapters";
import type {
  Slice2DModel,
  Slice2DToolbarState,
} from "@/src/features/slice2d/types";

function numericRevision(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function resolveSlice2DFieldRevision(args: {
  runtimeResourceRevisions?: Partial<ResourceRevisionMap> | null;
  fieldDataRevision?: number | string | null;
  liveFieldSourceStep?: number | string | null;
  effectiveStep?: number | string | null;
}): number | null {
  return (
    numericRevision(args.runtimeResourceRevisions?.fields_revision) ??
    numericRevision(args.runtimeResourceRevisions?.field_revision) ??
    numericRevision(args.fieldDataRevision) ??
    numericRevision(args.liveFieldSourceStep) ??
    numericRevision(args.effectiveStep) ??
    null
  );
}

export function rebuildSlice2DModelFrame(args: {
  base: Slice2DModel;
  toolbar: Slice2DToolbarState;
  adapterKind: "fdm" | "fem";
}): Pick<Slice2DModel, "render" | "diagnostics"> {
  const adapter =
    args.adapterKind === "fem"
      ? createFemSlice2DAdapter(args.base.capabilities)
      : createFdmSlice2DAdapter(args.base.capabilities);
  const frame = adapter.buildSlice({
    quantity: {
      ...args.base.quantity,
      activeQuantityId: args.toolbar.quantityId,
      component: args.toolbar.component,
    },
    plane: {
      ...args.base.plane,
      axis: args.toolbar.axis,
      mode: args.toolbar.mode,
      layerIndex: args.toolbar.layerIndex,
      positionPercent: args.toolbar.positionPercent,
      thicknessPercent: args.toolbar.thicknessPercent,
    },
    toolbar: args.toolbar,
    revisions: args.base.revisions,
  });

  return {
    render: {
      ...args.base.render,
      query: frame.query,
      resourceKind: frame.resourceKind,
      sampling: frame.sampling,
    },
    diagnostics: {
      ...args.base.diagnostics,
      messages: frame.diagnostics,
    },
  };
}

export function resolveSlice2DFieldRequestState(args: {
  enabled: boolean;
  model: Slice2DModel;
}): {
  kind: Slice2DModel["render"]["resourceKind"];
  query: Slice2DModel["render"]["query"];
  unsupportedReason: string | null;
} {
  if (!args.enabled) {
    return {
      kind: null,
      query: null,
      unsupportedReason: null,
    };
  }
  if (args.model.render.query && args.model.render.resourceKind) {
    return {
      kind: args.model.render.resourceKind,
      query: args.model.render.query,
      unsupportedReason: null,
    };
  }
  return {
    kind: null,
    query: null,
    unsupportedReason:
      args.model.render.sampling === "unavailable"
        ? (args.model.diagnostics.messages[0] ??
          "2D mode is not implemented for the current renderer path")
        : null,
  };
}
