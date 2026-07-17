"use client";

import { useCallback, useMemo, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import type { JsonObject } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  resolveObjectMeshPolicyResourceKey,
  resolveObjectMeshQualityResourceKey,
  resolveObjectMeshReportResourceKey,
  useObjectMeshPolicyResource,
  useObjectMeshQualityResource,
  useObjectMeshReportResource,
  useObjectMeshSizeFieldResource,
  useObjectTopologyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";
import { Accordion } from "@/shared/ui/Accordion";
import { Tabs, TabsContent } from "@/shared/ui/Tabs";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { useInspectorActiveTab } from "../InspectorTabState";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField, type FormFieldHelp } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  asRecord,
  formatCount,
  JsonResourceSection,
  MeshResourceFields,
  recordField,
} from "./MeshResourceView";
import type { MeshSizeDistributionHoverBin } from "./MeshQualityChart";
import { MeshQualityStatisticsView } from "./MeshQualityStatisticsView";
import { emitMeshSizeHistogramHover } from "./meshSizeHistogramHover";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
  type InspectorDraftState,
} from "./inspectorDraftState";
import {
  buildObjectMeshPolicyReplaceRequest,
  defaultObjectMeshPolicyResource,
  draftFromObjectMeshPolicyResource,
  draftIdentityKeyForObjectMeshPolicyResource,
  draftKeyForObjectMeshPolicyResource,
  objectMeshPolicyDraftDirty,
  type ObjectMeshPolicyDraft,
} from "./ObjectMeshPolicyPanelModel";

type Feedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type UpdateObjectMeshPolicyDraft = (
  patch: Partial<ObjectMeshPolicyDraft>,
) => void;

const OBJECT_MESH_HELP: Record<string, FormFieldHelp> = {
  algorithm2d: {
    description: "Gmsh 2D surface meshing algorithm used before tetrahedralization.",
    details: [
      "6 is the Frontal-Delaunay default used by the current mesh policy.",
      "Change only when debugging surface triangulation or reproducing a backend-specific mesh.",
    ],
  },
  algorithm3d: {
    description: "Gmsh 3D volume meshing algorithm for tetrahedra.",
    details: [
      "1 selects Delaunay in the current FEM shared-domain path.",
      "HXT and other methods can be faster or stricter, but may fail on thin-film geometries.",
    ],
  },
  boundaryLayerCount: {
    description: "Number of boundary-layer elements generated on selected curves or surfaces.",
    details: ["Requires boundary-layer selectors or explicit Gmsh tags."],
  },
  boundaryLayerStretching: {
    description: "Growth ratio between consecutive boundary-layer elements.",
  },
  boundaryLayerTags: {
    description: "Raw Gmsh entity tags used as boundary-layer targets.",
    details: ["Prefer selectors when possible; raw tags are fragile across geometry rebuilds."],
  },
  boundaryLayerSelectors: {
    description: "JSON selector list that resolves boundary-layer target entities from geometry semantics.",
  },
  boundaryLayerThickness: {
    description: "Total physical thickness of the boundary-layer stack.",
  },
  calibrateFor: {
    description: "High-level calibration family for automatic mesh-size presets.",
  },
  computeQuality: {
    description: "Requests aggregate mesh quality diagnostics after mesh generation.",
  },
  coreRelaxation: {
    description: "Adds an object-local size field that relaxes from fine surface/edge sizing to a coarser object core.",
  },
  cornerExtent: {
    description: "Near-corner region that receives corner refinement before the corner transition ramp starts.",
    details: ["For rectangular thin films this targets the in-plane corner features."],
  },
  cornerMaximumElementSize: {
    description: "Maximum element size requested at object corners.",
    details: ["Must be less than or equal to the edge maximum element size."],
  },
  cornerTransitionDistance: {
    description: "Distance over which corner refinement grows back to the far-field size.",
    details: [
      "Use a positive length in meters for a fixed ramp.",
      "Use airbox_boundary to automatically extend the ramp to the outer airbox boundary.",
    ],
  },
  curvatureFactor: {
    description: "Curvature-driven sizing factor. Lower values generally add more elements on curved surfaces.",
  },
  edgeMaximumElementSize: {
    description: "Maximum element size requested along object edges.",
    details: ["This is the main parameter for densifying the airbox near waveguide edges."],
  },
  edgeThickness: {
    description: "Thickness of the finest edge-refinement band before the transition ramp starts.",
  },
  edgeTransitionDistance: {
    description: "Distance over which edge refinement grows back to the far-field size.",
    details: [
      "Use a positive length in meters for a fixed ramp.",
      "Use airbox_boundary to automatically extend the ramp to the outer airbox boundary.",
    ],
  },
  interfaceMaximumElementSize: {
    description: "Maximum element size at the magnetic object and air interface.",
  },
  interfaceThickness: {
    description: "Thickness of the near-interface band that keeps interface sizing active.",
  },
  manualBox: {
    description: "Adds or edits one explicit Gmsh Box size field in the object policy.",
  },
  maximumElementGrowthRate: {
    description: "Maximum requested element-size growth between neighboring refinement regions.",
  },
  maximumElementSize: {
    description: "Coarse object-volume target size away from local refinement zones.",
  },
  meshStrategy: {
    description: "Requested meshing strategy for the selected object.",
    details: ["thin_film_tetrahedral is the current feature-aware path for thin films."],
  },
  minimumElementSize: {
    description: "Lower bound for object mesh sizing. Local requests below this can be clamped.",
  },
  narrowRegionResolution: {
    description: "Resolution target for narrow geometric regions when automatic narrow-region sizing is active.",
  },
  narrowRegions: {
    description: "Gmsh narrow-region option. 0 disables it; positive values enable Gmsh narrow-region sizing.",
  },
  optimize: {
    description: "Optional Gmsh optimizer to run after mesh generation.",
  },
  optimizeIterations: {
    description: "Number of optimizer iterations requested when an optimizer is selected.",
  },
  order: {
    description: "Finite-element order for the generated object mesh.",
  },
  perElementQuality: {
    description: "Requests per-element quality arrays in addition to aggregate quality diagnostics.",
  },
  sizeFactor: {
    description: "Multiplier applied to preset-derived mesh sizes.",
  },
  sizeFromCurvature: {
    description: "Gmsh curvature sizing option. 0 disables curvature-derived sizing.",
  },
  sizePreset: {
    description: "Named mesh-size preset that fills common hmin/hmax/growth settings.",
  },
  smoothingSteps: {
    description: "Number of Gmsh smoothing passes after meshing.",
  },
  source: {
    description: "Optional external mesh source path for imported mesh workflows.",
  },
  sweep: {
    description: "Thin-film through-thickness sweep controls. These determine how many layers are placed across film thickness.",
  },
  transitionDistance: {
    description: "Interface transition distance from near-interface sizing to bulk/far-field sizing.",
    details: [
      "Use a positive length in meters for a fixed ramp.",
      "Use airbox_boundary to grade to the outer airbox boundary when supported.",
    ],
  },
  transitionGrowth: {
    description: "Requested growth rate for transition sizing fields.",
  },
};

function ObjectMeshPolicySummarySection({
  hasConfig,
  objectId,
  policyRevision,
  policyStatus,
  qualityStatus,
  reportStatus,
}: {
  hasConfig: boolean;
  objectId: string | null | undefined;
  policyRevision: number;
  policyStatus: string;
  qualityStatus: string;
  reportStatus: string;
}) {
  return (
    <InspectorSection title="Object Mesh Policy" badge={policyStatus} collapsible defaultCollapsed={false}>
      <FieldRow label="Object ID" value={objectId ?? "no object selection"} />
      <FieldRow label="Revision" value={String(policyRevision)} />
      <FieldRow label="Policy" value={hasConfig ? "object override" : "inherited"} />
      <FieldRow label="Report state" value={reportStatus} />
      <FieldRow label="Quality state" value={qualityStatus} />
    </InspectorSection>
  );
}

function ObjectMeshOverrideSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection title="Override">
      <FormField
        checked={draft.present}
        label="Use object policy"
        type="checkbox"
        onChange={(event) => updateDraft({ present: event.target.checked })}
      />
    </InspectorSection>
  );
}

const MESH_SIZE_CALIBRATIONS = [
  "",
  "general_physics",
  "micromagnetics_static",
  "micromagnetics_relaxation",
  "micromagnetics_frequency_domain",
  "magnetostatics_dominated",
  "imported_surface_cleanup",
] as const;

const MESH_SIZE_PRESETS = [
  "",
  "extremely_fine",
  "extra_fine",
  "finer",
  "fine",
  "normal",
  "coarse",
  "coarser",
  "extra_coarse",
  "extremely_coarse",
] as const;

function ObjectMeshPresetSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection title="Mesh Size Presets" collapsible defaultCollapsed={true}>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.calibrateFor} label="Calibrate for" type="select" value={draft.calibrateFor} onChange={(event) => updateDraft({ calibrateFor: event.target.value })}>
        {MESH_SIZE_CALIBRATIONS.map((cal) => (
          <option key={cal} value={cal}>
            {cal || "Inherited"}
          </option>
        ))}
      </FormField>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.sizePreset} label="Size preset" type="select" value={draft.sizePreset} onChange={(event) => updateDraft({ sizePreset: event.target.value })}>
        {MESH_SIZE_PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {preset ? preset.replace(/_/g, " ") : "Inherited"}
          </option>
        ))}
      </FormField>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.sizeFactor} label="Size factor" type="number" value={draft.sizeFactor} onChange={(event) => updateDraft({ sizeFactor: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshSizeSemanticsSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection title="Element Size Parameters" badge="solver policy">
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.maximumElementSize} label="Maximum element size" type="number" unit="m" value={draft.maximumElementSize} onChange={(event) => updateDraft({ maximumElementSize: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.minimumElementSize} label="Minimum element size" type="number" unit="m" value={draft.minimumElementSize} onChange={(event) => updateDraft({ minimumElementSize: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.maximumElementGrowthRate} label="Maximum growth rate" type="number" value={draft.maximumElementGrowthRate} onChange={(event) => updateDraft({ maximumElementGrowthRate: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.curvatureFactor} label="Curvature factor" type="number" value={draft.curvatureFactor} onChange={(event) => updateDraft({ curvatureFactor: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.sizeFromCurvature} label="Size from curvature" type="number" value={draft.sizeFromCurvature} onChange={(event) => updateDraft({ sizeFromCurvature: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.narrowRegions} label="Narrow regions" type="number" value={draft.narrowRegions} onChange={(event) => updateDraft({ narrowRegions: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.narrowRegionResolution} label="Narrow region resolution" type="number" value={draft.narrowRegionResolution} onChange={(event) => updateDraft({ narrowRegionResolution: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.order} label="FEM order" type="number" value={draft.order} onChange={(event) => updateDraft({ order: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.source} label="Mesh source" type="text" value={draft.source} onChange={(event) => updateDraft({ source: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshSweepStrategySection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection title="Thin-Film Sweep Strategy" collapsible defaultCollapsed={true}>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.meshStrategy} label="Mesh strategy" type="select" value={draft.meshStrategy} onChange={(event) => updateDraft({ meshStrategy: event.target.value })}>
        <option value="">Inherited</option>
        <option>Auto</option>
        <option>Free tetrahedral</option>
        <option>Swept prism</option>
        <option>Swept hex</option>
        <option>Thin-film tetrahedral</option>
      </FormField>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.sweep} label="Through-thickness elements" type="number" value={draft.throughThicknessElements} onChange={(event) => updateDraft({ throughThicknessElements: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.sweep} label="Thickness distribution" type="select" value={draft.throughThicknessDistribution} onChange={(event) => updateDraft({ throughThicknessDistribution: event.target.value })}>
        <option value="">Inherited</option>
        <option>Fixed</option>
        <option>Linear</option>
        <option>Exponential</option>
      </FormField>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.sweep} label="Thickness element ratio" type="number" value={draft.throughThicknessElementRatio} onChange={(event) => updateDraft({ throughThicknessElementRatio: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.sweep} label="Symmetric thickness" type="select" value={draft.throughThicknessSymmetric} onChange={(event) => updateDraft({ throughThicknessSymmetric: event.target.value })}>
        <option value="">Inherited</option>
        <option>Enabled</option>
        <option>Disabled</option>
      </FormField>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.sweep} label="Sweep face meshing" type="select" value={draft.sweepFaceMeshing} onChange={(event) => updateDraft({ sweepFaceMeshing: event.target.value })}>
        <option value="">Inherited</option>
        <option>Triangular</option>
        <option>Quadrilateral</option>
      </FormField>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.sweep} label="Sweep source" type="text" value={draft.sweepSource} onChange={(event) => updateDraft({ sweepSource: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.sweep} label="Sweep destination" type="text" value={draft.sweepDestination} onChange={(event) => updateDraft({ sweepDestination: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshInterfaceTransitionSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection title="Interface And Transition Refinement" collapsible defaultCollapsed={true}>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.interfaceMaximumElementSize} label="Interface max. element size" type="number" unit="m" value={draft.interfaceMaximumElementSize} onChange={(event) => updateDraft({ interfaceMaximumElementSize: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.interfaceThickness} label="Interface thickness" type="number" unit="m" value={draft.interfaceThickness} onChange={(event) => updateDraft({ interfaceThickness: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.transitionDistance} hint="Positive meters or airbox_boundary" label="Transition distance" mono={false} type="text" value={draft.transitionDistance} onChange={(event) => updateDraft({ transitionDistance: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.transitionGrowth} label="Transition growth" type="number" value={draft.transitionGrowth} onChange={(event) => updateDraft({ transitionGrowth: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshBackendParametersSection({
  draft,
  updateDraft,
  sizeFieldKinds,
  sizeFieldsLength,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
  sizeFieldKinds: string[];
  sizeFieldsLength: number;
}) {
  return (
    <InspectorSection title="Backend Mesh Parameters" badge="structured">
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.algorithm2d} label="Gmsh 2D algorithm" type="number" value={draft.algorithm2d} onChange={(event) => updateDraft({ algorithm2d: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.algorithm3d} label="Gmsh 3D algorithm" type="number" value={draft.algorithm3d} onChange={(event) => updateDraft({ algorithm3d: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.smoothingSteps} label="Smoothing steps" type="number" value={draft.smoothingSteps} onChange={(event) => updateDraft({ smoothingSteps: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.optimize} label="Optimizer" type="select" value={draft.optimize} onChange={(event) => updateDraft({ optimize: event.target.value })}>
        <option value="">Inherited</option>
        <option>Netgen</option>
        <option>High order</option>
        <option>Relocate 3D</option>
      </FormField>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.optimizeIterations} label="Optimizer iterations" type="number" value={draft.optimizeIterations} onChange={(event) => updateDraft({ optimizeIterations: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.computeQuality} label="Compute quality" type="select" value={draft.computeQuality} onChange={(event) => updateDraft({ computeQuality: event.target.value })}>
        <option value="">Inherited</option>
        <option>Enabled</option>
        <option>Disabled</option>
      </FormField>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.perElementQuality} label="Per-element quality" type="select" value={draft.perElementQuality} onChange={(event) => updateDraft({ perElementQuality: event.target.value })}>
        <option value="">Inherited</option>
        <option>Enabled</option>
        <option>Disabled</option>
      </FormField>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.boundaryLayerCount} label="Boundary-layer count" type="number" value={draft.boundaryLayerCount} onChange={(event) => updateDraft({ boundaryLayerCount: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.boundaryLayerThickness} label="Boundary-layer thickness" type="number" unit="m" value={draft.boundaryLayerThickness} onChange={(event) => updateDraft({ boundaryLayerThickness: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.boundaryLayerStretching} label="Boundary-layer stretching" type="number" value={draft.boundaryLayerStretching} onChange={(event) => updateDraft({ boundaryLayerStretching: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.boundaryLayerTags} label="Boundary-layer surface tags" type="text" value={draft.boundaryLayerTargetSurfaceTags} onChange={(event) => updateDraft({ boundaryLayerTargetSurfaceTags: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.boundaryLayerTags} label="Boundary-layer curve tags" type="text" value={draft.boundaryLayerTargetCurveTags} onChange={(event) => updateDraft({ boundaryLayerTargetCurveTags: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.boundaryLayerSelectors} label="Boundary-layer surface selectors" rows={4} type="textarea" value={draft.boundaryLayerTargetSurfaceSelectors} onChange={(event) => updateDraft({ boundaryLayerTargetSurfaceSelectors: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.boundaryLayerSelectors} label="Boundary-layer curve selectors" rows={4} type="textarea" value={draft.boundaryLayerTargetCurveSelectors} onChange={(event) => updateDraft({ boundaryLayerTargetCurveSelectors: event.target.value })} />
      <MeshResourceFields
        fields={[
          { label: "Size-field count", value: String(sizeFieldsLength) },
          { label: "Size-field kinds", value: sizeFieldKinds.length ? sizeFieldKinds.join(", ") : "none" },
        ]}
      />
    </InspectorSection>
  );
}

function ObjectMeshCoreRelaxationSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  const disabled = !draft.present || !draft.coreRelaxationEnabled;
  return (
    <InspectorSection title="Object Core Relaxation" badge="size field">
      <FormField
        checked={draft.coreRelaxationEnabled}
        disabled={!draft.present}
        label="Use object core relaxation"
        type="checkbox"
        onChange={(event) =>
          updateDraft({ coreRelaxationEnabled: event.target.checked })
        }
      />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.coreRelaxation} label="Geometry name" type="text" value={draft.coreRelaxationGeometryName} onChange={(event) => updateDraft({ coreRelaxationGeometryName: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.coreRelaxation} label="Core maximum element size" type="number" unit="m" value={draft.coreRelaxationMaximumElementSize} onChange={(event) => updateDraft({ coreRelaxationMaximumElementSize: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.coreRelaxation} label="Surface maximum element size" type="number" unit="m" value={draft.coreRelaxationSurfaceMaximumElementSize} onChange={(event) => updateDraft({ coreRelaxationSurfaceMaximumElementSize: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.coreRelaxation} label="Surface distance" type="number" unit="m" value={draft.coreRelaxationSurfaceDistance} onChange={(event) => updateDraft({ coreRelaxationSurfaceDistance: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.coreRelaxation} label="Edge maximum element size" type="number" unit="m" value={draft.coreRelaxationEdgeMaximumElementSize} onChange={(event) => updateDraft({ coreRelaxationEdgeMaximumElementSize: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.coreRelaxation} label="Edge distance" type="number" unit="m" value={draft.coreRelaxationEdgeDistance} onChange={(event) => updateDraft({ coreRelaxationEdgeDistance: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.coreRelaxation} label="Surface sampling" type="number" value={draft.coreRelaxationSamplingSurface} onChange={(event) => updateDraft({ coreRelaxationSamplingSurface: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.coreRelaxation} label="Edge sampling" type="number" value={draft.coreRelaxationSamplingEdge} onChange={(event) => updateDraft({ coreRelaxationSamplingEdge: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshManualSizeFieldSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  const disabled = !draft.present || !draft.manualBoxSizeFieldEnabled;
  return (
    <InspectorSection title="Manual Size Field" badge="Box">
      <FormField
        checked={draft.manualBoxSizeFieldEnabled}
        disabled={!draft.present}
        label="Use Box size field"
        type="checkbox"
        onChange={(event) =>
          updateDraft({ manualBoxSizeFieldEnabled: event.target.checked })
        }
      />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.manualBox} label="Box VIn" type="number" unit="m" value={draft.manualBoxSizeFieldVIn} onChange={(event) => updateDraft({ manualBoxSizeFieldVIn: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.manualBox} label="Box VOut" type="number" unit="m" value={draft.manualBoxSizeFieldVOut} onChange={(event) => updateDraft({ manualBoxSizeFieldVOut: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.manualBox} label="Box X min" type="number" unit="m" value={draft.manualBoxSizeFieldXMin} onChange={(event) => updateDraft({ manualBoxSizeFieldXMin: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.manualBox} label="Box X max" type="number" unit="m" value={draft.manualBoxSizeFieldXMax} onChange={(event) => updateDraft({ manualBoxSizeFieldXMax: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.manualBox} label="Box Y min" type="number" unit="m" value={draft.manualBoxSizeFieldYMin} onChange={(event) => updateDraft({ manualBoxSizeFieldYMin: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.manualBox} label="Box Y max" type="number" unit="m" value={draft.manualBoxSizeFieldYMax} onChange={(event) => updateDraft({ manualBoxSizeFieldYMax: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.manualBox} label="Box Z min" type="number" unit="m" value={draft.manualBoxSizeFieldZMin} onChange={(event) => updateDraft({ manualBoxSizeFieldZMin: event.target.value })} />
      <FormField disabled={disabled} help={OBJECT_MESH_HELP.manualBox} label="Box Z max" type="number" unit="m" value={draft.manualBoxSizeFieldZMax} onChange={(event) => updateDraft({ manualBoxSizeFieldZMax: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshEdgeCornerSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection title="Edge And Corner Refinement" collapsible defaultCollapsed={true}>
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.edgeMaximumElementSize} label="Edge max. element size" type="number" unit="m" value={draft.edgeMaximumElementSize} onChange={(event) => updateDraft({ edgeMaximumElementSize: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.edgeThickness} label="Edge thickness" type="number" unit="m" value={draft.edgeThickness} onChange={(event) => updateDraft({ edgeThickness: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.edgeTransitionDistance} hint="Positive meters or airbox_boundary" label="Edge transition distance" mono={false} type="text" value={draft.edgeTransitionDistance} onChange={(event) => updateDraft({ edgeTransitionDistance: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.cornerMaximumElementSize} label="Corner max. element size" type="number" unit="m" value={draft.cornerMaximumElementSize} onChange={(event) => updateDraft({ cornerMaximumElementSize: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.cornerExtent} label="Corner extent" type="number" unit="m" value={draft.cornerExtent} onChange={(event) => updateDraft({ cornerExtent: event.target.value })} />
      <FormField disabled={!draft.present} help={OBJECT_MESH_HELP.cornerTransitionDistance} hint="Positive meters or airbox_boundary" label="Corner transition distance" mono={false} type="text" value={draft.cornerTransitionDistance} onChange={(event) => updateDraft({ cornerTransitionDistance: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshEffectiveTargetSection({
  effectiveTarget,
  reportStatus,
}: {
  effectiveTarget: Record<string, unknown> | null;
  reportStatus: string;
}) {
  return (
    <InspectorSection title="Effective Target" badge={reportStatus}>
      <MeshResourceFields
        fields={[
          { label: "Maximum element", value: String(recordField(effectiveTarget, "maximum_element_size") ?? "unset") },
          { label: "Minimum element", value: String(recordField(effectiveTarget, "minimum_element_size") ?? "unset") },
          { label: "Source", value: String(recordField(effectiveTarget, "source") ?? "not resolved") },
          { label: "Transition realization", value: String(recordField(effectiveTarget, "transition_realization") ?? "none") },
        ]}
      />
    </InspectorSection>
  );
}

function ObjectMeshTopologyQualitySection({
  qualityRecord,
  qualityRevision,
  qualityStatus,
  topology,
}: {
  qualityRecord: Record<string, unknown> | null;
  qualityRevision: number | undefined;
  qualityStatus: string;
  topology: ReturnType<typeof useObjectTopologyResource>;
}) {
  return (
    <InspectorSection title="Topology And Quality" badge={topology.status}>
      <MeshResourceFields
        fields={[
          { label: "Topology fetch", value: topology.status },
          { label: "Nodes", value: formatCount(topology.data?.nodeCount) },
          { label: "Elements", value: formatCount(topology.data?.elementCount) },
          { label: "Boundary faces", value: formatCount(topology.data?.boundaryFaceCount) },
          { label: "Quality revision", value: String(qualityRevision ?? "unknown") },
          { label: "Quality status", value: String(recordField(qualityRecord, "status") ?? qualityStatus) },
        ]}
      />
    </InspectorSection>
  );
}

function ObjectMeshQualityStatisticsSection({
  onHoverSizeDistributionBin,
  statistics,
}: {
  onHoverSizeDistributionBin: (bin: MeshSizeDistributionHoverBin | null) => void;
  statistics: ReturnType<typeof normalizeMeshQualityStatistics>;
}) {
  return (
    <InspectorSection

      title="Object Quality Distributions"
      badge={statistics ? formatCount(statistics.elementCount) : "missing"}
      collapsible
      defaultCollapsed={false}
    >
      <MeshQualityStatisticsView
        statistics={statistics}
        onHoverSizeDistributionBin={onHoverSizeDistributionBin}
      />
    </InspectorSection>
  );
}

function ObjectMeshAdvancedJsonSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection title="Advanced JSON" collapsible defaultCollapsed={true}>
      <FormField disabled={!draft.present} label="Policy JSON" rows={8} type="textarea" value={draft.configText} onChange={(event) => updateDraft({ configText: event.target.value })} />
    </InspectorSection>
  );
}

export function ObjectMeshTransactionsSection({
  feedback,
  isDirty,
  objectId,
  onApply,
  onBuild,
  buildLabel,
  onRevert,
  pending,
}: {
  buildLabel: string;
  feedback: Feedback;
  isDirty: boolean;
  objectId: string | null | undefined;
  onApply: () => void;
  onBuild: () => void;
  onRevert: () => void;
  pending: boolean;
}) {
  return (
    <InspectorSection title="Transactions">
      {isDirty ? (
        <FeedbackBanner
          kind="warning"
          message="Unapplied changes. Apply Policy or Apply & Build Mesh before trusting the current mesh."
        />
      ) : null}
      <div className="fm-inspector-toolbar">
        <Button disabled={pending || !objectId} size="sm" type="button" variant="primary" onClick={onApply}>
          Apply Policy
        </Button>
        <Button disabled={pending || !objectId} size="sm" type="button" variant="secondary" onClick={onBuild}>
          {buildLabel}
        </Button>
        <Button disabled={pending} size="sm" type="button" variant="ghost" onClick={onRevert}>
          Revert
        </Button>
      </div>
      {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    </InspectorSection>
  );
}

export function ObjectMeshPolicyPanel({ selection }: InspectorPanelProps) {
  const objectId = selection.objectId;
  const kernel = useKernel();
  const { api, commands, resources } = kernel;
  const policy = useObjectMeshPolicyResource(objectId);
  const report = useObjectMeshReportResource(objectId);
  const quality = useObjectMeshQualityResource(objectId);
  const sizeField = useObjectMeshSizeFieldResource(objectId);
  const topology = useObjectTopologyResource(objectId);
  const resource = policy.data ?? defaultObjectMeshPolicyResource(objectId ?? "");
  const reportRecord = asRecord(report.data?.report);
  const effectiveTarget = asRecord(recordField(reportRecord, "effective_target")) as JsonObject | null;
  const baseDraft = useMemo(
    () =>
      draftFromObjectMeshPolicyResource(resource, {
        effectiveTarget,
      }),
    [effectiveTarget, resource],
  );
  const draftKey = draftKeyForObjectMeshPolicyResource(objectId, resource, {
    effectiveTarget,
  });
  const draftIdentityKey = draftIdentityKeyForObjectMeshPolicyResource(objectId);
  const [draftState, setDraftState] = useState<
    InspectorDraftState<ObjectMeshPolicyDraft>
  >(() =>
    initialInspectorDraftState({
      baseDraft,
      baseKey: draftKey,
      identityKey: draftIdentityKey,
    }),
  );
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const { dirty: isDirty, draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey: draftKey,
    identityKey: draftIdentityKey,
    isDirty: objectMeshPolicyDraftDirty,
    state: draftState,
  });
  const sizeFieldRecord = asRecord(sizeField.data?.size_field);
  const sizeFields = Array.isArray(recordField(sizeFieldRecord, "size_fields"))
    ? (recordField(sizeFieldRecord, "size_fields") as unknown[])
    : [];
  const sizeFieldKinds: string[] = [];
  for (const field of sizeFields) {
    const kind = asRecord(field)?.kind;
    if (typeof kind === "string" && kind.length > 0) {
      sizeFieldKinds.push(kind);
    }
  }
  const qualityRecord = asRecord(quality.data?.quality);
  const qualityStatistics = normalizeMeshQualityStatistics(quality.data?.quality);
  const commandContext = useMemo(
    () =>
      createCommandContext("inspector", kernel, {
        sourceDetail: "object-mesh-policy",
      }),
    [kernel],
  );
  const hoverSizeDistributionBin = useCallback(
    (bin: MeshSizeDistributionHoverBin | null) => {
      emitMeshSizeHistogramHover({
        bin,
        kernel,
        scope: objectId ? { kind: "object", objectId } : { kind: "all" },
      });
    },
    [kernel, objectId],
  );

  function updateDraft(patch: Partial<ObjectMeshPolicyDraft>): void {
    setDraftState(
      updateInspectorDraftState({
        baseDraft,
        baseKey: draftKey,
        currentDraft: draft,
        identityKey: draftIdentityKey,
        isDirty: objectMeshPolicyDraftDirty,
        patch,
      }),
    );
  }

  const applyPolicy = useCallback(async ({
    silentSuccess = false,
  }: {
    silentSuccess?: boolean;
  } = {}): Promise<{ ok: boolean }> => {
    if (!objectId) {
      setFeedback({ kind: "error", message: "No selected scene object." });
      return { ok: false };
    }

    const result = buildObjectMeshPolicyReplaceRequest(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return { ok: false };
    }

    setPending(true);
    try {
      const next = await api.meshing.replaceObjectPolicy(
        objectId,
        result.request,
      );
      const revision = next.revision;
      resources.invalidate(resolveObjectMeshPolicyResourceKey(objectId), revision);
      resources.invalidate(resolveObjectMeshReportResourceKey(objectId), revision);
      resources.invalidate(resolveObjectMeshQualityResourceKey(objectId), revision);
      resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, revision);
      resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, revision);
      resources.invalidate(SCENE_RESOURCE_KEY, revision);
      if (!silentSuccess) {
        setFeedback({
          kind: "success",
          message: "Policy saved. Current solver mesh is stale until a mesh build completes.",
        });
      }
      return { ok: true };
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
      return { ok: false };
    } finally {
      setPending(false);
    }
  }, [api, draft, objectId, resources]);

  async function buildMesh(): Promise<void> {
    if (!objectId) {
      setFeedback({ kind: "error", message: "No selected scene object." });
      return;
    }

    if (isDirty) {
      const applied = await applyPolicy({ silentSuccess: true });
      if (!applied.ok) return;
    }

    try {
      await commands.execute("mesh.build-selected", commandContext);
      setFeedback({
        kind: "success",
        message: isDirty
          ? "Policy saved. Object mesh build submitted."
          : "Object mesh build submitted. The Mesh Build monitor will track the command.",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    }
  }

  const validation = buildObjectMeshPolicyReplaceRequest(draft);
  const applyInspectorDraft = useCallback(
    async () => (await applyPolicy()).ok,
    [applyPolicy],
  );
  const resetInspectorDraft = useCallback(() => {
    setDraftState(
      initialInspectorDraftState({
        baseDraft,
        baseKey: draftKey,
        identityKey: draftIdentityKey,
      }),
    );
    setFeedback(null);
  }, [baseDraft, draftIdentityKey, draftKey]);
  useRegisterInspectorEditSession(
    "staged",
    pending,
    isDirty,
    !("error" in validation),
    undefined,
    applyInspectorDraft,
    resetInspectorDraft,
  );
  const activeTab = useInspectorActiveTab();

  return (
    <div className="fm-inspector-panel">
      <Tabs value={activeTab} className="fm-inspector-tabs">

        <TabsContent value="overview" className="fm-tabs-content">
          <ObjectMeshPolicySummarySection
            hasConfig={Boolean(resource.config)}
            objectId={objectId}
            policyRevision={resource.revision}
            policyStatus={policy.status}
            qualityStatus={quality.status}
            reportStatus={report.status}
          />
          <ObjectMeshEffectiveTargetSection
            effectiveTarget={effectiveTarget}
            reportStatus={report.status}
          />
        </TabsContent>

        <TabsContent value="properties" className="fm-tabs-content">
          <ObjectMeshPresetSection draft={draft} updateDraft={updateDraft} />
          <ObjectMeshSizeSemanticsSection draft={draft} updateDraft={updateDraft} />
          <ObjectMeshSweepStrategySection draft={draft} updateDraft={updateDraft} />
          <ObjectMeshInterfaceTransitionSection draft={draft} updateDraft={updateDraft} />
          <ObjectMeshBackendParametersSection
            draft={draft}
            updateDraft={updateDraft}
            sizeFieldKinds={sizeFieldKinds}
            sizeFieldsLength={sizeFields.length}
          />
          <ObjectMeshCoreRelaxationSection draft={draft} updateDraft={updateDraft} />
          <ObjectMeshManualSizeFieldSection draft={draft} updateDraft={updateDraft} />
          <ObjectMeshEdgeCornerSection draft={draft} updateDraft={updateDraft} />
          <ObjectMeshOverrideSection draft={draft} updateDraft={updateDraft} />
          <ObjectMeshAdvancedJsonSection draft={draft} updateDraft={updateDraft} />
        </TabsContent>

        <TabsContent value="diagnostics" className="fm-tabs-content">
          <ObjectMeshTopologyQualitySection
            qualityRecord={qualityRecord}
            qualityRevision={quality.data?.revision}
            qualityStatus={quality.status}
            topology={topology}
          />
          <ObjectMeshQualityStatisticsSection
            statistics={qualityStatistics}
            onHoverSizeDistributionBin={hoverSizeDistributionBin}
          />
          <ObjectMeshTransactionsSection
            buildLabel={isDirty ? "Apply & Build Mesh" : "Build Mesh"}
            feedback={feedback}
            isDirty={isDirty}
            objectId={objectId}
            onApply={() => void applyPolicy()}
            onBuild={() => void buildMesh()}
            onRevert={() => {
              setDraftState(
                initialInspectorDraftState({
                  baseDraft,
                  baseKey: draftKey,
                  identityKey: draftIdentityKey,
                }),
              );
              setFeedback(null);
            }}
            pending={pending}
          />

          <Accordion type="multiple">
            <JsonResourceSection sectionValue="json-report" title="Object Mesh Report JSON" value={report.data} />
            <JsonResourceSection sectionValue="json-quality" title="Object Mesh Quality JSON" value={quality.data} />
            <JsonResourceSection sectionValue="json-size-field" title="Object Size Field JSON" value={sizeField.data} />
          </Accordion>
        </TabsContent>
      </Tabs>
    </div>
  );
}
