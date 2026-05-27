import type { ModuleManifest } from "@/kernel/types";
import { DEFAULT_CAMERA_REGISTRY_STATE } from "@/kernel/visualization/CameraRegistryController";

import { viewport3dStore } from "./viewport3dStore";
import type {
  Viewport3DDimensionFrameDensity,
  Viewport3DDimensionFrameMode,
  Viewport3DFdmTopographyComponent,
  Viewport3DScaleUnitMode,
} from "./viewport3dStore";
import type { Viewport3DVisualProfileId } from "./viewport3dVisualProfile";

const VISUAL_PROFILE_COMMANDS: Array<{
  id: string;
  profileId: Viewport3DVisualProfileId;
  title: string;
}> = [
  {
    id: "viewport-3d.profile-interactive-lite",
    profileId: "interactive-lite",
    title: "Use Interactive Lite 3D Profile",
  },
  {
    id: "viewport-3d.profile-interactive",
    profileId: "interactive",
    title: "Use Interactive 3D Profile",
  },
  {
    id: "viewport-3d.profile-balanced",
    profileId: "balanced",
    title: "Use Balanced 3D Profile",
  },
  {
    id: "viewport-3d.profile-figure",
    profileId: "figure",
    title: "Use Figure 3D Profile",
  },
  {
    id: "viewport-3d.profile-capture",
    profileId: "capture",
    title: "Use Capture 3D Profile",
  },
];
const DIMENSION_FRAME_MODE_COMMANDS: Array<{
  id: string;
  mode: Viewport3DDimensionFrameMode;
  title: string;
}> = [
  {
    id: "viewport-3d.dimension-frame-off",
    mode: "off",
    title: "Hide 3D Dimension Frame",
  },
  {
    id: "viewport-3d.dimension-frame-floor",
    mode: "floor",
    title: "Show 3D Floor Grid",
  },
  {
    id: "viewport-3d.dimension-frame-cage",
    mode: "cage",
    title: "Show 3D Dimension Cage",
  },
];
const DIMENSION_FRAME_DENSITY_COMMANDS: Array<{
  density: Viewport3DDimensionFrameDensity;
  id: string;
  title: string;
}> = [
  {
    density: "auto",
    id: "viewport-3d.dimension-density-auto",
    title: "Use Auto Dimension Grid Density",
  },
  {
    density: "coarse",
    id: "viewport-3d.dimension-density-coarse",
    title: "Use Coarse Dimension Grid Density",
  },
  {
    density: "fine",
    id: "viewport-3d.dimension-density-fine",
    title: "Use Fine Dimension Grid Density",
  },
];
const SCALE_UNIT_COMMANDS: Array<{
  id: string;
  title: string;
  unitMode: Viewport3DScaleUnitMode;
}> = [
  {
    id: "viewport-3d.scale-unit-auto",
    title: "Use Automatic Scale Units",
    unitMode: "auto",
  },
  {
    id: "viewport-3d.scale-unit-nm",
    title: "Use Nanometer Scale Units",
    unitMode: "nm",
  },
  {
    id: "viewport-3d.scale-unit-um",
    title: "Use Micrometer Scale Units",
    unitMode: "um",
  },
  {
    id: "viewport-3d.scale-unit-mm",
    title: "Use Millimeter Scale Units",
    unitMode: "mm",
  },
  {
    id: "viewport-3d.scale-unit-m",
    title: "Use Meter Scale Units",
    unitMode: "m",
  },
];
const FDM_TOPOGRAPHY_COMPONENT_COMMANDS: Array<{
  component: Viewport3DFdmTopographyComponent;
  id: string;
  title: string;
}> = [
  {
    component: "z",
    id: "viewport-3d.fdm-topography-component-z",
    title: "Use Z FDM Topography",
  },
  {
    component: "magnitude",
    id: "viewport-3d.fdm-topography-component-magnitude",
    title: "Use Magnitude FDM Topography",
  },
  {
    component: "x",
    id: "viewport-3d.fdm-topography-component-x",
    title: "Use X FDM Topography",
  },
  {
    component: "y",
    id: "viewport-3d.fdm-topography-component-y",
    title: "Use Y FDM Topography",
  },
];

export const viewport3dManifest: ModuleManifest = {
  id: "viewport-3d",
  title: "3D Viewport",
  version: "0.1.0",
  slots: ["viewport-main"],
  component: () => import("./Viewport3DModule"),
  contributes: {
    commands: [
      {
        id: "viewport-3d.fit",
        title: "Fit 3D View",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        run: () => {
          viewport3dStore.requestFit();
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.reset-camera",
        title: "Reset 3D Camera",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        run: (context) => {
          viewport3dStore.resetCamera();
          context.cameraRegistry?.patchCamera(DEFAULT_CAMERA_REGISTRY_STATE);
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.open-camera-dialog",
        title: "Open 3D Camera Controls",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () => viewport3dStore.getSnapshot().widgets.cameraDialogOpen,
        run: () => {
          viewport3dStore.setCameraDialogOpen(true);
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.capture-frame",
        title: "Capture 3D Frame",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        run: () => {
          viewport3dStore.requestCapture();
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.toggle-viewcube",
        title: "Toggle ViewCube",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () => viewport3dStore.getSnapshot().widgets.viewCubeVisible,
        run: () => {
          viewport3dStore.toggleViewCube();
          return { status: "completed" };
        },
      },
      {
        id: "workspace.visualization-settings",
        title: "Visualization Settings",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        run: () => {
          viewport3dStore.setSettingsDialogOpen(true);
          return { status: "completed" };
        },
      },
      {
        id: "view-projection",
        title: "Toggle projection",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.cameraProjection ===
          "orthographic",
        run: (context) => {
          // Use the local store for the immediate toggle state. Resource data can
          // lag behind queued patches, which would make repeated clicks compute
          // the same "next" projection and leave the button stuck.
          const currentProjection =
            viewport3dStore.getSnapshot().widgets.cameraProjection;
          const nextProjection =
            currentProjection === "orthographic" ? "perspective" : "orthographic";
          // Update the local store immediately so the viewport responds without
          // waiting for the backend round-trip.
          viewport3dStore.setCameraProjection(nextProjection);
          context.cameraRegistry?.patchCamera({ projection: nextProjection });
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.hsl-reference-auto",
        title: "HSL Reference Auto",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.hslReferenceMode === "auto",
        run: () => {
          viewport3dStore.setHslReferenceMode("auto");
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.hsl-reference-on",
        title: "Show HSL Reference",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.hslReferenceMode === "on",
        run: () => {
          viewport3dStore.setHslReferenceMode("on");
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.hsl-reference-off",
        title: "Hide HSL Reference",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.hslReferenceMode === "off",
        run: () => {
          viewport3dStore.setHslReferenceMode("off");
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.rotation-camera",
        title: "Use Free Camera Rotation",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.rotationMode === "camera",
        run: () => {
          viewport3dStore.setRotationMode("camera");
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.rotation-object",
        title: "Use Object-Bound Rotation",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.rotationMode === "object",
        run: () => {
          viewport3dStore.setRotationMode("object");
          return { status: "completed" };
        },
      },
      ...DIMENSION_FRAME_MODE_COMMANDS.map((command) => ({
        id: command.id,
        title: command.title,
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport" as const,
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.dimensionFrameMode ===
          command.mode,
        run: () => {
          viewport3dStore.setDimensionFrameMode(command.mode);
          return { status: "completed" as const };
        },
      })),
      ...DIMENSION_FRAME_DENSITY_COMMANDS.map((command) => ({
        id: command.id,
        title: command.title,
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport" as const,
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.dimensionFrameDensity ===
          command.density,
        run: () => {
          viewport3dStore.setDimensionFrameDensity(command.density);
          return { status: "completed" as const };
        },
      })),
      {
        id: "viewport-3d.scale-labels-toggle",
        title: "Toggle 3D Scale Labels",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () => viewport3dStore.getSnapshot().widgets.scaleLabelsVisible,
        run: () => {
          const current =
            viewport3dStore.getSnapshot().widgets.scaleLabelsVisible;
          viewport3dStore.setScaleLabelsVisible(!current);
          return { status: "completed" };
        },
      },
      ...SCALE_UNIT_COMMANDS.map((command) => ({
        id: command.id,
        title: command.title,
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport" as const,
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.scaleUnitMode ===
          command.unitMode,
        run: () => {
          viewport3dStore.setScaleUnitMode(command.unitMode);
          return { status: "completed" as const };
        },
      })),
      {
        id: "viewport-3d.fdm-topography-toggle",
        title: "Toggle FDM Voxel Topography",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.fdmTopographyEnabled,
        run: () => {
          const current =
            viewport3dStore.getSnapshot().widgets.fdmTopographyEnabled;
          viewport3dStore.setFdmTopographyEnabled(!current);
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.fdm-topography-amplitude",
        title: "Set FDM Voxel Topography Amplitude",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        run: (context) => {
          const value = Number(context.input);
          viewport3dStore.setFdmTopographyAmplitudeCells(value);
          return { status: "completed" };
        },
      },
      ...FDM_TOPOGRAPHY_COMPONENT_COMMANDS.map((command) => ({
        id: command.id,
        title: command.title,
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport" as const,
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.fdmTopographyComponent ===
          command.component,
        run: () => {
          viewport3dStore.setFdmTopographyComponent(command.component);
          return { status: "completed" as const };
        },
      })),
      ...VISUAL_PROFILE_COMMANDS.map((command) => ({
        id: command.id,
        title: command.title,
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport" as const,
        isActive: () =>
          viewport3dStore.getSnapshot().visualProfileId === command.profileId,
        run: () => {
          viewport3dStore.setVisualProfile(command.profileId);
          return { status: "completed" as const };
        },
      })),
    ],
  },
  emits: ["workspace:selection-changed"],
  listens: ["resource:invalidated", "workspace:selection-changed"],
};
