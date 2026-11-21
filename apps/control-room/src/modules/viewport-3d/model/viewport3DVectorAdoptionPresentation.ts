import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";

import type { Viewport3DVectorBuildReference } from "../viewport3dRenderModel";
import type { Viewport3DRenderAdoptionReceipt } from "./viewport3DRenderAdoptionRegistry";

export interface Viewport3DTargetVectorAdoptionPresentation {
  carrierId: string;
  fieldBufferId: string;
  itemCount: number;
  requestScopeEpoch: string;
  resourceKey: string;
  sessionEpoch: string;
  sessionId: string;
  targetId: string;
  vectorBuildKey: string;
}

export interface CurrentViewport3DVectorTarget {
  buildReference: Viewport3DVectorBuildReference | null;
  carrierIds: readonly string[];
  segments: Float32Array | null;
  targetId: string;
}

/**
 * Resolve only an actual WebGL adoption for the currently published target
 * build. The build key fences topology, field, scope, and sampling revisions.
 */
export function resolveCurrentViewport3DVectorAdoption({
  receipts,
  sessionIdentity,
  target,
}: {
  receipts: readonly Viewport3DRenderAdoptionReceipt[];
  sessionIdentity: SessionResourceIdentity | null;
  target: CurrentViewport3DVectorTarget;
}): Viewport3DTargetVectorAdoptionPresentation | null {
  const reference = target.buildReference;
  if (
    !sessionIdentity ||
    !target.targetId ||
    !reference?.buildKey ||
    !reference.fieldBufferId ||
    !reference.resourceKey ||
    !target.segments ||
    target.segments.length === 0 ||
    target.segments.length % 6 !== 0 ||
    target.carrierIds.length === 0
  ) {
    return null;
  }

  const matches = receipts.filter(
    (receipt) =>
      receipt.kind === "vector" &&
      receipt.targetId === target.targetId &&
      target.carrierIds.includes(receipt.carrierId) &&
      receipt.vectorBuildKey === reference.buildKey &&
      receipt.fieldBufferId === reference.fieldBufferId &&
      receipt.resourceKey === reference.resourceKey &&
      receipt.sessionId === sessionIdentity.sessionId &&
      receipt.sessionEpoch === sessionIdentity.sessionEpoch &&
      receipt.requestScopeEpoch === sessionIdentity.requestScopeEpoch,
  );
  if (matches.length !== 1) return null;

  const receipt = matches[0];
  const itemCount = receipt?.itemCount;
  if (
    !receipt ||
    typeof itemCount !== "number" ||
    !Number.isSafeInteger(itemCount) ||
    itemCount < 0
  ) {
    return null;
  }

  return Object.freeze({
    carrierId: receipt.carrierId,
    fieldBufferId: reference.fieldBufferId,
    itemCount,
    requestScopeEpoch: sessionIdentity.requestScopeEpoch,
    resourceKey: reference.resourceKey,
    sessionEpoch: sessionIdentity.sessionEpoch,
    sessionId: sessionIdentity.sessionId,
    targetId: target.targetId,
    vectorBuildKey: reference.buildKey,
  });
}
