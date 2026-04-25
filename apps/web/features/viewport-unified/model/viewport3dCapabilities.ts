import type { CapabilityMap } from "@/src/api/types";
import type {
  Viewport3DCapabilities,
  Viewport3DCapability,
  Viewport3DControlState,
} from "./viewport3dContracts";

export interface ResolveViewport3DCapabilitiesInput {
  capabilities: CapabilityMap | null;
  authoringEnabled?: boolean;
  diagnosticsEnabled?: boolean;
}

function available(enabled: boolean, reason?: string): Viewport3DCapability {
  if (enabled) {
    return { enabled: true };
  }
  return { enabled: false, reason };
}

function requirePreview3D(
  preview3d: boolean,
  reason: string,
): Viewport3DCapability {
  return available(preview3d, reason);
}

export function resolveViewport3DCapabilities({
  capabilities,
  authoringEnabled = false,
  diagnosticsEnabled = false,
}: ResolveViewport3DCapabilitiesInput): Viewport3DCapabilities {
  const preview3d = Boolean(capabilities?.preview_3d);
  const structuredGrid = Boolean(capabilities?.structured_grid);
  const explicitTopology = Boolean(capabilities?.explicit_topology);

  const preview3dCap = available(preview3d, "Requires preview_3d capability.");
  const structuredGridCap = preview3d
    ? available(structuredGrid, "Requires structured_grid capability.")
    : requirePreview3D(false, "Requires preview_3d capability.");
  const explicitTopologyCap = preview3d
    ? available(explicitTopology, "Requires explicit_topology capability.")
    : requirePreview3D(false, "Requires preview_3d capability.");
  const authoringCap = preview3d
    ? explicitTopology
      ? available(authoringEnabled, "Requires Geometry Authoring mode.")
      : available(false, "Requires explicit_topology capability.")
    : requirePreview3D(false, "Requires preview_3d capability.");
  const vectorFieldCap = preview3d
    ? available(
        structuredGrid || explicitTopology,
        "Requires structured_grid or explicit_topology capability.",
      )
    : requirePreview3D(false, "Requires preview_3d capability.");
  const clipCap = preview3d
    ? available(explicitTopology, "Requires explicit_topology capability.")
    : requirePreview3D(false, "Requires preview_3d capability.");
  const screenshotCap = preview3dCap.enabled
    ? available(true)
    : requirePreview3D(false, "Requires preview_3d capability.");
  const diagnosticsCap = preview3dCap.enabled
    ? available(diagnosticsEnabled, "Requires render diagnostics flag.")
    : requirePreview3D(false, "Requires preview_3d capability.");

  return {
    preview3d: preview3dCap,
    structuredGrid: structuredGridCap,
    explicitTopology: explicitTopologyCap,
    authoringPrimitives: authoringCap,
    vectorField: vectorFieldCap,
    clip: clipCap,
    screenshot: screenshotCap,
    diagnostics: diagnosticsCap,
  };
}

export function toLegacyBooleanCapabilities(
  capabilities: Viewport3DCapabilities,
): {
  preview_3d: boolean;
  structured_grid: boolean;
  explicit_topology: boolean;
} {
  return {
    preview_3d: capabilities.preview3d.enabled,
    structured_grid: capabilities.structuredGrid.enabled,
    explicit_topology: capabilities.explicitTopology.enabled,
  };
}

export function controlStateFromCapability(
  capability: Viewport3DCapability,
): Viewport3DControlState {
  return capability.enabled ? "inactive" : "disabled";
}
