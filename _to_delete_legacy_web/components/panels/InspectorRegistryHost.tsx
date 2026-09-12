"use client";

import type { ReactNode } from "react";
import { resolveNodeHandle } from "@/features/model-builder/registry/nodeHandleResolver";
import {
  inspectorForNodeKind,
  type InspectorContext,
  type InspectorDescriptor,
} from "@/features/model-builder/registry/inspectorRegistry";

interface InspectorRegistryHostProps {
  nodeId: string;
  selectedObjectId?: string | null;
  selectedObjectNodeId?: string;
  selectedObjectMeshNodeId?: string;
  children: (payload: {
    descriptor: InspectorDescriptor;
    inspectorCtx: InspectorContext;
    panelProps: Record<string, unknown>;
  }) => ReactNode;
}

export default function InspectorRegistryHost({
  nodeId,
  selectedObjectId,
  selectedObjectNodeId,
  selectedObjectMeshNodeId,
  children,
}: InspectorRegistryHostProps) {
  const handle = resolveNodeHandle(nodeId);
  const descriptor = inspectorForNodeKind(handle);
  const inspectorCtx: InspectorContext = {
    nodeId,
    nodeHandle: handle,
    selectedObjectId,
    selectedObjectNodeId,
    selectedObjectMeshNodeId,
  };
  return <>{children({ descriptor, inspectorCtx, panelProps: descriptor.props(inspectorCtx) })}</>;
}
