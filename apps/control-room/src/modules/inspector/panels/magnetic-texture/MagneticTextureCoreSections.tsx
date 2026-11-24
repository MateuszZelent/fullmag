"use client";

import {
  Compass,
  Crosshair,
  Eye,
  FolderOpen,
  Grid3x3,
  Move3D,
  Scan,
  Scaling,
  SearchCheck,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  formatQuantityDisplay,
  parseQuantityInputToSI,
  type InspectorActionContext,
  type InspectorRowSpec,
  type InspectorSectionSpec,
  type UnitOption,
} from "@/modules/inspector/template";
import type { TargetMetricBounds, Vec3 } from "@/shared/domain/magnetization-texture/boundsResolver";
import {
  axisAngleToQuaternion,
  eulerDegreesToQuaternion,
  fallbackDomainWallDirection,
  quaternionToEulerDegrees,
  type PresetTextureSpecV2,
} from "@/shared/domain/magnetization-texture/evaluateV2Client";
import {
  centerDraftInTargetBounds,
  fitCharacteristicSizeToTarget,
  orthonormalizeSecondBasis,
  resolveLargestFacePlane,
  switchDraftPresetPatch,
  THREE_DIMENSIONAL_OBJECT_LOCAL_PRESETS,
  validateMagneticTextureDraft,
  validateScaleMultiplier,
  type MagneticTextureDraft,
  type PlaneSelectionMode,
} from "@/shared/domain/magnetization-texture/presetDefaults";
import {
  canonicalPresetKind,
  humanPresetLabel,
} from "@/shared/domain/magnetization-texture/texturePresets";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/shared/ui/InputGroup";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { cn } from "@/shared/utils/className";

import { PresetGallery } from "./PresetGallery";
import { TexturePreviewCanvas } from "./TexturePreviewCanvas";

export const METRIC_LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "µm", toSiFactor: 1e-6 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

export const ANGLE_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "deg", toSiFactor: Math.PI / 180 },
  { unit: "rad", toSiFactor: 1 },
];

export const WAVEVECTOR_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "rad/nm", toSiFactor: 1e9 },
  { unit: "rad/µm", toSiFactor: 1e6 },
  { unit: "1/m", toSiFactor: 1 },
];

export interface FieldImportInspectionSummary {
  vectorCount: number;
  frameCount: number;
  sourceGridShape: readonly [number, number, number] | null;
  minNorm: number;
  maxNorm: number;
  compatible: boolean;
  datasets: readonly string[];
}

const FORMAT_LABELS: Readonly<Record<string, string>> = {
  field_state_json: "Field-State JSON (.json)",
  ovf: "OOMMF / Mumax3 OVF (.ovf)",
  npz: "NumPy archive (.npz)",
  zarr: "Zarr v2/v3 (.zarr.zip)",
  h5: "HDF5 (.h5)",
};

export function formatSupportedFieldFormatBadge(formatId: string): string {
  switch (formatId) {
    case "field_state_json":
      return "Field-State JSON";
    case "ovf":
      return "OVF 1.0/2.0";
    case "npz":
      return "NPZ";
    case "zarr":
      return "Zarr";
    case "h5":
      return "HDF5";
    default:
      return formatId;
  }
}

function SignSegmentedRow({
  label,
  symbol,
  value,
  options,
  onChange,
}: {
  label: string;
  symbol?: ReactNode;
  value: -1 | 1;
  options: readonly [{ value: "-1" | "1"; label: string }, { value: "-1" | "1"; label: string }];
  onChange: (next: -1 | 1) => void;
}) {
  return (
    <div className="grid min-w-0 gap-1.5 @[22rem]/insp:grid-cols-[minmax(8rem,1fr)_minmax(10rem,1.25fr)] @[22rem]/insp:items-center">
      <div className="flex items-center justify-between gap-1.5">
        <span className="text-xs font-medium text-fm-primary">{label}</span>
        {symbol ? <span className="fm-sym text-xs text-fm-secondary">{symbol}</span> : null}
      </div>
      <SegmentedControl<"-1" | "1">
        aria-label={label}
        columns={2}
        options={options}
        value={value === -1 ? "-1" : "1"}
        onValueChange={(next) => onChange(next === "-1" ? -1 : 1)}
      />
    </div>
  );
}

function QuickOrientationBar({
  ctx,
  bounds,
}: {
  ctx: InspectorActionContext<MagneticTextureDraft>;
  bounds: TargetMetricBounds;
}) {
  const applyEuler = (eulerDeg: Vec3) => {
    const quat = eulerDegreesToQuaternion(eulerDeg);
    ctx.patchDraft({
      rotationMode: "euler_xyz",
      eulerDeg,
      rotationQuat: quat,
    });
  };

  const stepAxis = (axisIndex: 0 | 1 | 2, deltaDeg: number) => {
    const nextEuler: Vec3 = [...ctx.draft.eulerDeg];
    nextEuler[axisIndex] = ((nextEuler[axisIndex] + deltaDeg + 180) % 360) - 180;
    applyEuler(nextEuler);
  };

  const largestPlane = resolveLargestFacePlane(bounds.size);

  return (
    <div className="flex flex-wrap items-center gap-1" data-slot="quick-orientation-bar">
      {(
        [
          ["+Z", [0, 0, 0]],
          ["−Z", [180, 0, 0]],
          ["+X", [0, 90, 0]],
          ["−X", [0, -90, 0]],
          ["+Y", [-90, 0, 0]],
          ["−Y", [90, 0, 0]],
        ] as const
      ).map(([lbl, deg]) => (
        <Button
          key={lbl}
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => applyEuler([deg[0], deg[1], deg[2]])}
        >
          {lbl}
        </Button>
      ))}
      <Button
        size="sm"
        type="button"
        variant="ghost"
        onClick={() => {
          if (largestPlane === "xy") applyEuler([0, 0, 0]);
          else if (largestPlane === "xz") applyEuler([90, 0, 0]);
          else applyEuler([0, 90, 0]);
        }}
      >
        In-plane
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={() => stepAxis(2, 90)}>
        +90° Z
      </Button>
    </div>
  );
}

function RelativeAxisScalarInput({
  axis,
  axisTone,
  ariaLabel,
  value,
  onCommit,
}: {
  axis: "x" | "y" | "z";
  axisTone: "x" | "y" | "z";
  ariaLabel: string;
  value: number;
  onCommit: (nextValue: number) => void;
}) {
  const formatted = formatQuantityDisplay(value, 1);
  const [rawText, setRawText] = useState(formatted);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setRawText(formatted);
    }
  }, [formatted]);

  return (
    <InputGroup className="fm-inspector-vector3__cell">
      <InputGroupAddon align="inline-start">
        <InputGroupText
          className={cn(
            "fm-inspector-vector3__axis",
            axisTone === "x" && "text-fm-axis-x",
            axisTone === "y" && "text-fm-axis-y",
            axisTone === "z" && "text-fm-axis-z",
          )}
        >
          {axis}
        </InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        aria-label={ariaLabel}
        autoComplete="off"
        className="fm-inspector-vector3__input"
        inputMode="decimal"
        spellCheck={false}
        type="text"
        value={rawText}
        onBlur={() => {
          focusedRef.current = false;
          const parsed = parseQuantityInputToSI(rawText, 1);
          if (parsed !== null) {
            if (!Object.is(parsed, value)) {
              onCommit(parsed);
            }
            setRawText(formatQuantityDisplay(parsed, 1));
          } else {
            setRawText(formatted);
          }
        }}
        onChange={(event) => {
          const next = event.target.value;
          setRawText(next);
          const parsed = parseQuantityInputToSI(next, 1);
          if (parsed !== null && !Object.is(parsed, value)) {
            onCommit(parsed);
          }
        }}
        onFocus={() => {
          focusedRef.current = true;
        }}
      />
    </InputGroup>
  );
}

function RelativeBoundsOffsetField({
  bounds,
  ctx,
}: {
  bounds: TargetMetricBounds;
  ctx: InspectorActionContext<MagneticTextureDraft>;
}) {
  const isPct = ctx.draft.translationUnitMode === "bounds_pct";
  // bounds_pct: [-50% .. +50%] of bounds.size; bounds_norm: [-1 .. +1] normalized half-extent
  const factor = isPct ? 100 : 2;
  const origin: Vec3 =
    ctx.draft.mappingSpace === "region"
      ? [0, 0, 0]
      : ctx.draft.mappingSpace === "world"
        ? [...bounds.worldCenter]
        : [...bounds.localCenter];

  const spans: Vec3 = [
    Math.max(bounds.size[0], 1e-18),
    Math.max(bounds.size[1], 1e-18),
    Math.max(bounds.size[2], 1e-18),
  ];

  const rel: Vec3 = [
    ((ctx.draft.translationM[0] - origin[0]) / spans[0]) * factor,
    ((ctx.draft.translationM[1] - origin[1]) / spans[1]) * factor,
    ((ctx.draft.translationM[2] - origin[2]) / spans[2]) * factor,
  ];

  const updateAxis = (axisIndex: 0 | 1 | 2, nextRel: number) => {
    const nextTranslation: Vec3 = [...ctx.draft.translationM];
    nextTranslation[axisIndex] = origin[axisIndex] + (nextRel / factor) * spans[axisIndex];
    ctx.setField("translationM", nextTranslation);
  };

  return (
    <div className="fm-inspector-vector3" data-testid="relative-center-offset-vector3">
      <div className="fm-inspector-vector3__row">
        <div className="fm-inspector-vector3__grid">
          <RelativeAxisScalarInput
            ariaLabel={`Center offset x (${isPct ? "%" : "norm"})`}
            axis="x"
            axisTone="x"
            value={rel[0]}
            onCommit={(nextX) => updateAxis(0, nextX)}
          />
          <RelativeAxisScalarInput
            ariaLabel={`Center offset y (${isPct ? "%" : "norm"})`}
            axis="y"
            axisTone="y"
            value={rel[1]}
            onCommit={(nextY) => updateAxis(1, nextY)}
          />
          <RelativeAxisScalarInput
            ariaLabel={`Center offset z (${isPct ? "%" : "norm"})`}
            axis="z"
            axisTone="z"
            value={rel[2]}
            onCommit={(nextZ) => updateAxis(2, nextZ)}
          />
        </div>
        <span className="fm-inspector-vector3__unit">{isPct ? "%" : "norm"}</span>
      </div>
    </div>
  );
}

export interface BuildMagneticTextureSectionsOptions {
  hostContext: "object" | "region";
  bounds: TargetMetricBounds;
  objectBounds: TargetMetricBounds;
  parentObjectName: string;
  parentPresetLabel: string;
  parentPreviewSpec: PresetTextureSpecV2 | null;
  regionRecord?: unknown;
  supportedFieldFormats: readonly string[];
  inspectionSummary: FieldImportInspectionSummary | null;
  inspectingFieldFile: boolean;
  onInspectFieldFile: (draft: MagneticTextureDraft) => void | Promise<void>;
  onCopyParentTextureToRegion?: (ctx: InspectorActionContext<MagneticTextureDraft>) => void;
  showObjectAssignmentSection?: boolean;
  defaultMagnetizationRefPlaceholder?: string;
  gizmoEnabled?: boolean;
  onToggleGizmo?: () => void;
  canLoadFieldState?: boolean;
  loadFieldStateDisabledReason?: string | null;
  loadingFieldState?: boolean;
  onLoadFieldState?: () => void | Promise<void>;
}

const PLANAR_2D_PRESETS = new Set<string>([
  "vortex",
  "antivortex",
  "bloch_skyrmion",
  "neel_skyrmion",
  "antiskyrmion",
  "skyrmionium",
  "bimeron",
  "skyrmion_lattice",
  "vortex_wall",
  "artificial_spin_ice",
]);

export function buildMagneticTextureInspectorSections({
  hostContext,
  bounds,
  objectBounds,
  parentObjectName,
  parentPresetLabel,
  parentPreviewSpec,
  regionRecord,
  supportedFieldFormats,
  inspectionSummary,
  inspectingFieldFile,
  onInspectFieldFile,
  onCopyParentTextureToRegion,
  showObjectAssignmentSection = false,
  defaultMagnetizationRefPlaceholder,
  gizmoEnabled = false,
  onToggleGizmo,
  canLoadFieldState = false,
  loadFieldStateDisabledReason = null,
  loadingFieldState = false,
  onLoadFieldState,
}: BuildMagneticTextureSectionsOptions): readonly InspectorSectionSpec<MagneticTextureDraft>[] {
  const autoFace = resolveLargestFacePlane(bounds.size).toUpperCase();
  const targetWord = hostContext === "region" ? "region" : "object";
  const fitTargetLabel = hostContext === "region" ? "Fit to Region" : "Fit to Object";

  const fieldError = (key: string) => (_value: unknown, draft: MagneticTextureDraft) =>
    validateMagneticTextureDraft(draft).get(key) ?? null;

  const sections: InspectorSectionSpec<MagneticTextureDraft>[] = [];

  if (hostContext === "region") {
    sections.push({
      id: "region-inheritance",
      title: "Region source",
      icon: Compass,
      defaultOpen: true,
      summary: (d) =>
        d.inheritanceMode === "inherit"
          ? `Inherited from ${parentObjectName}`
          : `Override (${humanPresetLabel(d.presetKind, d.sourceMode === "field-file" ? "sampled" : "preset_texture")})`,
      rows: [
        {
          key: "inheritanceMode",
          label: "Source",
          type: "segmented",
          structural: true,
          wide: true,
          options: [
            { value: "inherit", label: "Inherit from object" },
            { value: "override", label: "Override in region" },
          ],
        },
        {
          key: "sourceMode",
          label: "Override mode",
          type: "segmented",
          structural: true,
          showWhen: (d) => d.inheritanceMode === "override",
          options: [
            { value: "preset", label: "Analytical preset" },
            { value: "field-file", label: "Field file" },
          ],
        },
      ],
    });

    sections.push({
      id: "inherited-preview",
      title: "Inherited preview in region",
      icon: Eye,
      defaultOpen: true,
      showWhen: (d) => d.inheritanceMode === "inherit",
      rows: [
        {
          type: "custom",
          wide: true,
          render: (ctx) => (
            <TexturePreviewCanvas
              bounds={bounds}
              draft={ctx.draft}
              interactiveCenterDrag={false}
              objectBounds={objectBounds}
              overrideSpec={parentPreviewSpec}
              regionRecord={regionRecord}
            />
          ),
        },
        {
          type: "readonly",
          label: "Inherited from",
          format: () => `${parentObjectName} (${parentPresetLabel})`,
        },
        {
          type: "readonly",
          label: "Region containment",
          format: () =>
            `Clipped strictly to region mask (${(bounds.size[0] * 1e9).toPrecision(3)} × ${(bounds.size[1] * 1e9).toPrecision(3)} × ${(bounds.size[2] * 1e9).toPrecision(3)} nm)`,
        },
        {
          type: "custom",
          wide: true,
          render: (ctx) => (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => ctx.setField("inheritanceMode", "override")}
              >
                Customize texture in this region
              </Button>
              {onCopyParentTextureToRegion ? (
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => onCopyParentTextureToRegion(ctx)}
                >
                  Copy object texture & edit
                </Button>
              ) : null}
            </div>
          ),
        },
      ],
    });
  }

  const showPresetAuthoring = (d: MagneticTextureDraft) =>
    (hostContext === "object" || d.inheritanceMode === "override") &&
    (hostContext === "object" ? true : d.sourceMode === "preset");

  const showFieldFileAuthoring = (d: MagneticTextureDraft) =>
    hostContext === "object"
      ? true
      : d.inheritanceMode === "override" && d.sourceMode === "field-file";

  // Section 1: Texture Preset Gallery + Live 2D <TexturePreviewCanvas>
  sections.push({
    id: "texture-preset",
    title: "Texture preset",
    icon: Compass,
    modeTabId: hostContext === "object" ? "preset" : undefined,
    defaultOpen: true,
    showWhen: showPresetAuthoring,
    summary: (d) => `${humanPresetLabel(d.presetKind)} · ${d.resolvedPlane.toUpperCase()}`,
    rows: [
      {
        key: "presetKind",
        type: "custom",
        wide: true,
        structural: true,
        render: (ctx) => (
          <div className="grid min-w-0 gap-2.5">
            <PresetGallery
              value={ctx.draft.presetKind}
              onSelect={(nextPreset) => {
                ctx.patchDraft(switchDraftPresetPatch(ctx.draft, nextPreset, bounds));
              }}
            />
            <TexturePreviewCanvas
              bounds={bounds}
              draft={ctx.draft}
              objectBounds={hostContext === "region" ? objectBounds : null}
              regionRecord={hostContext === "region" ? regionRecord : undefined}
              onTranslateInSlice={(nextTranslation) =>
                ctx.setField("translationM", nextTranslation)
              }
            />
            <div
              className="flex flex-wrap items-center gap-1.5"
              data-slot="texture-preview-3d-actions"
            >
              {onToggleGizmo ? (
                <Button
                  aria-pressed={gizmoEnabled}
                  data-active={gizmoEnabled ? "true" : "false"}
                  data-testid="texture-gizmo-btn"
                  size="sm"
                  type="button"
                  variant={gizmoEnabled ? "secondary" : "ghost"}
                  onClick={onToggleGizmo}
                >
                  <Move3D aria-hidden="true" size={13} />
                  <span>{gizmoEnabled ? "Hide 3D Gizmo (T)" : "3D Gizmo (T)"}</span>
                </Button>
              ) : null}
              <Button
                data-testid="texture-center-btn"
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => ctx.patchDraft(centerDraftInTargetBounds(ctx.draft, bounds))}
              >
                <Crosshair aria-hidden="true" size={13} />
                <span>Center</span>
              </Button>
              <Button
                data-testid="texture-fit-btn"
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => ctx.patchDraft(fitCharacteristicSizeToTarget(ctx.draft, bounds))}
              >
                <Scaling aria-hidden="true" size={13} />
                <span>{fitTargetLabel}</span>
              </Button>
            </div>
          </div>
        ),
      },
    ],
  });

  // Section 2: Preset Parameters (all 20 presets!)
  const parameterRows: InspectorRowSpec<MagneticTextureDraft>[] = [
    // Shared Plane selector for all 2D planar presets (eliminates ConflictingPlane)
    {
      key: "planeMode",
      label: "Texture plane",
      symbol: <>(e<sub>u</sub>, e<sub>v</sub>)</>,
      symbolInfo: {
        name: "Texture reference plane",
        definition: "Right-handed in-plane basis (eu, ev, en); Auto selects the largest AABB face.",
        siUnit: "dimensionless",
      },
      type: "segmented",
      structural: true,
      showWhen: (d) => PLANAR_2D_PRESETS.has(canonicalPresetKind(d.presetKind)),
      options: [
        { value: "auto", label: `Auto (${autoFace})` },
        { value: "xy", label: "XY" },
        { value: "xz", label: "XZ" },
        { value: "yz", label: "YZ" },
      ],
    },

    // 1. Uniform
    {
      key: "direction",
      label: "Direction",
      symbol: <>m̂</>,
      symbolInfo: {
        name: "Uniform magnetization direction",
        definition: "Unit spin vector normalized on apply across all active cells or nodes.",
        siUnit: "dimensionless",
      },
      type: "vector3",
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "uniform",
      validate: fieldError("direction"),
      vectorNote: (vec) => {
        const len = Math.hypot(vec[0], vec[1], vec[2]);
        if (len > 1e-12 && Math.abs(len - 1) > 1e-4) {
          return { tone: "warn", text: `Normalized on apply, ‖d‖ = ${len.toPrecision(4)}` };
        }
        return null;
      },
    },

    // 2. Random
    {
      key: "seed",
      label: "Random seed",
      symbol: <>s</>,
      symbolInfo: {
        name: "Deterministic SplitMix64 seed",
        definition: "Reproducible PRNG seed hashed per sample coordinate bit pattern.",
        siUnit: "dimensionless",
      },
      type: "number",
      integer: true,
      min: 0,
      step: 1,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "random",
      validate: fieldError("seed"),
    },
    {
      type: "custom",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "random",
      render: (ctx) => (
        <div className="flex justify-end">
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => ctx.setField("seed", Math.floor(Math.random() * 100000) + 1)}
          >
            <Sparkles aria-hidden="true" size={14} />
            <span>Roll seed</span>
          </Button>
        </div>
      ),
    },

    // 3 & 4. Vortex & Antivortex
    {
      key: "circulation",
      type: "custom",
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "vortex" || k === "antivortex";
      },
      render: (ctx) => (
        <SignSegmentedRow
          label={canonicalPresetKind(ctx.draft.presetKind) === "antivortex" ? "Quadrupole phase" : "Circulation"}
          options={[
            { value: "1", label: "CCW (+1)" },
            { value: "-1", label: "CW (−1)" },
          ]}
          symbol={<>c</>}
          value={ctx.draft.circulation}
          onChange={(next) => ctx.setField("circulation", next)}
        />
      ),
    },
    {
      key: "corePolarity",
      type: "custom",
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return (
          k === "vortex" ||
          k === "antivortex" ||
          k === "bloch_skyrmion" ||
          k === "neel_skyrmion" ||
          k === "antiskyrmion" ||
          k === "skyrmion_lattice" ||
          k === "vortex_wall"
        );
      },
      render: (ctx) => (
        <SignSegmentedRow
          label="Core polarity"
          options={[
            { value: "1", label: "Up (+1)" },
            { value: "-1", label: "Down (−1)" },
          ]}
          symbol={<>p</>}
          value={ctx.draft.corePolarity}
          onChange={(next) => ctx.setField("corePolarity", next)}
        />
      ),
    },
    {
      key: "coreRadiusM",
      label: "Core radius",
      symbol: <>r<sub>c</sub></>,
      symbolInfo: {
        name: "Gaussian core radius",
        definition: "Characteristic radius of the out-of-plane exchange core.",
        siUnit: "m",
        typicalRange: "3 nm – 15 nm",
      },
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      scrub: "log",
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "vortex" || k === "antivortex" || k === "vortex_wall" || k === "bloch_point";
      },
      validate: fieldError("coreRadiusM"),
    },

    // 5, 6, 7, 9, 10, 15: Skyrmions, Bimeron, Skyrmion lattice, Hopfion radius
    {
      key: "latticeSymmetry",
      label: "Lattice symmetry",
      type: "segmented",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "skyrmion_lattice",
      options: [
        { value: "hexagonal", label: "Hexagonal C6" },
        { value: "square", label: "Square C4" },
      ],
    },
    {
      key: "latticeConstantM",
      label: "Lattice constant",
      symbol: <>a</>,
      symbolInfo: {
        name: "Bravais lattice period",
        definition: "Center-to-center distance between neighboring skyrmions (must exceed 2R).",
        siUnit: "m",
      },
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      scrub: "log",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "skyrmion_lattice",
      validate: fieldError("latticeConstantM"),
    },
    {
      key: "radiusM",
      label: "Characteristic radius",
      symbol: <>R</>,
      symbolInfo: {
        name: "Characteristic contour radius",
        definition: "Radius of the m_n = 0 domain-wall contour or soliton ring.",
        siUnit: "m",
        typicalRange: "10 nm – 100 nm",
      },
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      scrub: "log",
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return (
          k === "bloch_skyrmion" ||
          k === "neel_skyrmion" ||
          k === "antiskyrmion" ||
          k === "bimeron" ||
          k === "skyrmion_lattice" ||
          k === "hopfion"
        );
      },
      validate: fieldError("radiusM"),
    },

    // 8. Skyrmionium radii & wall type
    {
      key: "wallKind",
      label: "Wall type",
      type: "segmented",
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "skyrmionium" || k === "skyrmion_lattice" || k === "domain_wall";
      },
      options: [
        { value: "neel", label: "Néel" },
        { value: "bloch", label: "Bloch" },
      ],
    },
    {
      key: "innerRadiusM",
      label: "Inner radius",
      symbol: <>R<sub>in</sub></>,
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      scrub: "log",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "skyrmionium",
      validate: fieldError("innerRadiusM"),
    },
    {
      key: "outerRadiusM",
      label: "Outer radius",
      symbol: <>R<sub>out</sub></>,
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      scrub: "log",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "skyrmionium",
      validate: fieldError("outerRadiusM"),
    },

    // Shared wall width Δ
    {
      key: "wallWidthM",
      label: "Wall width",
      symbol: <>Δ</>,
      symbolInfo: {
        name: "Domain-wall transition width",
        definition: "Characteristic exchange-anisotropy transition scale √(Aex / Keff).",
        siUnit: "m",
        typicalRange: "2 nm – 25 nm",
      },
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      scrub: "log",
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return (
          k === "bloch_skyrmion" ||
          k === "neel_skyrmion" ||
          k === "antiskyrmion" ||
          k === "skyrmionium" ||
          k === "bimeron" ||
          k === "skyrmion_lattice" ||
          k === "domain_wall" ||
          (k === "two_domain" && !d.twoDomainSharp)
        );
      },
      validate: fieldError("wallWidthM"),
    },

    // Chirality / Vorticity / Helicity / Background sign
    {
      key: "chirality",
      type: "custom",
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return (
          k === "bloch_skyrmion" ||
          k === "neel_skyrmion" ||
          k === "antiskyrmion" ||
          k === "skyrmionium" ||
          k === "skyrmion_lattice" ||
          k === "spiral"
        );
      },
      render: (ctx) => (
        <SignSegmentedRow
          label="Chirality"
          options={[
            { value: "1", label: canonicalPresetKind(ctx.draft.presetKind) === "neel_skyrmion" ? "Outward (+1)" : "CCW (+1)" },
            { value: "-1", label: canonicalPresetKind(ctx.draft.presetKind) === "neel_skyrmion" ? "Inward (−1)" : "CW (−1)" },
          ]}
          symbol={<>c</>}
          value={ctx.draft.chirality}
          onChange={(next) => ctx.setField("chirality", next)}
        />
      ),
    },
    {
      key: "vorticity",
      type: "custom",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "bimeron",
      render: (ctx) => (
        <SignSegmentedRow
          label="Vorticity"
          options={[
            { value: "1", label: "Meron pair (+1)" },
            { value: "-1", label: "Reversed (−1)" },
          ]}
          symbol={<>Q<sub>v</sub></>}
          value={ctx.draft.vorticity}
          onChange={(next) => ctx.setField("vorticity", next)}
        />
      ),
    },
    {
      key: "helicityRad",
      label: "Helicity angle",
      symbol: <>η</>,
      type: "quantity",
      units: ANGLE_UNITS,
      defaultDisplayUnit: "deg",
      step: 15,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "bimeron",
    },
    {
      key: "backgroundSign",
      type: "custom",
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "skyrmionium" || k === "bimeron" || k === "hopfion";
      },
      render: (ctx) => (
        <SignSegmentedRow
          label="Background sign"
          options={[
            { value: "1", label: "Positive (+1)" },
            { value: "-1", label: "Negative (−1)" },
          ]}
          symbol={<>s<sub>bg</sub></>}
          value={ctx.draft.backgroundSign}
          onChange={(next) => ctx.setField("backgroundSign", next)}
        />
      ),
    },

    // 10 & 11. Domain Wall & Two-Domain
    {
      key: "normalAxis",
      label: "Normal axis",
      symbol: <>n̂</>,
      type: "segmented",
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "domain_wall" || k === "two_domain";
      },
      options: [
        { value: "x", label: "X" },
        { value: "y", label: "Y" },
        { value: "z", label: "Z" },
      ],
    },
    {
      key: "twoDomainSharp",
      type: "custom",
      structural: true,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "two_domain",
      render: (ctx) => (
        <div className="grid min-w-0 gap-1.5 @[22rem]/insp:grid-cols-[minmax(8rem,1fr)_minmax(10rem,1.25fr)] @[22rem]/insp:items-center">
          <span className="text-xs font-medium text-fm-primary">Boundary profile</span>
          <SegmentedControl<"sharp" | "smooth">
            aria-label="Boundary profile"
            columns={2}
            options={[
              { value: "sharp", label: "Sharp step" },
              { value: "smooth", label: "Smooth tanh" },
            ]}
            value={ctx.draft.twoDomainSharp ? "sharp" : "smooth"}
            onValueChange={(next) => ctx.setField("twoDomainSharp", next === "sharp")}
          />
        </div>
      ),
    },
    {
      key: "centerOffsetM",
      label: "Wall position offset",
      symbol: <>s<sub>0</sub></>,
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      scrub: "lin",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "domain_wall",
    },
    {
      key: "leftDomain",
      label: "Left domain",
      symbol: <>m̂<sub>L</sub></>,
      type: "vector3",
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "domain_wall" || k === "two_domain";
      },
      validate: fieldError("leftDomain"),
    },
    {
      key: "lockAntiparallelRight",
      label: "Lock antiparallel (−Left)",
      type: "switch",
      structural: true,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "domain_wall",
    },
    {
      key: "rightDomain",
      label: "Right domain",
      symbol: <>m̂<sub>R</sub></>,
      type: "vector3",
      axisPresets: true,
      normalizeAction: true,
      disabledReason: (d) =>
        canonicalPresetKind(d.presetKind) === "domain_wall" && d.lockAntiparallelRight
          ? "Locked to −Left domain for 180° domain_wall."
          : null,
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "domain_wall" || k === "two_domain";
      },
      validate: fieldError("rightDomain"),
    },
    {
      key: "wallCenterMode",
      label: "Wall center spin",
      type: "segmented",
      structural: true,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "domain_wall",
      options: [
        { value: "auto", label: "Auto (from wall type)" },
        { value: "custom", label: "Custom vector" },
      ],
    },
    {
      key: "wallCenterDirection",
      label: "Midpoint / center spin",
      symbol: <>b̂</>,
      type: "vector3",
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "two_domain" || (k === "domain_wall" && d.wallCenterMode === "custom");
      },
      validate: fieldError("wallCenterDirection"),
    },
    {
      type: "custom",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "domain_wall" && d.wallCenterMode === "custom",
      render: (ctx) => (
        <div className="flex justify-end">
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              const projected = orthonormalizeSecondBasis(
                ctx.draft.leftDomain,
                ctx.draft.wallCenterDirection,
              );
              ctx.setField("wallCenterDirection", projected);
            }}
          >
            Project ⊥ left
          </Button>
        </div>
      ),
    },
    {
      type: "custom",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "domain_wall",
      render: (ctx) => {
        const ax: Vec3 =
          ctx.draft.normalAxis === "x"
            ? [1, 0, 0]
            : ctx.draft.normalAxis === "y"
              ? [0, 1, 0]
              : [0, 0, 1];
        const perp: Vec3 = ctx.draft.normalAxis === "x" ? [0, 1, 0] : [1, 0, 0];
        return (
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() =>
                ctx.patchDraft({
                  wallKind: "neel",
                  leftDomain: perp,
                  rightDomain: [-perp[0], -perp[1], -perp[2]],
                  lockAntiparallelRight: true,
                  wallCenterMode: "auto",
                })
              }
            >
              Transverse Néel
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() =>
                ctx.patchDraft({
                  wallKind: "bloch",
                  leftDomain: perp,
                  rightDomain: [-perp[0], -perp[1], -perp[2]],
                  lockAntiparallelRight: true,
                  wallCenterMode: "auto",
                })
              }
            >
              Transverse Bloch
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() =>
                ctx.patchDraft({
                  leftDomain: ax,
                  rightDomain: [-ax[0], -ax[1], -ax[2]],
                  lockAntiparallelRight: true,
                  wallCenterDirection: fallbackDomainWallDirection(ax, ax, ctx.draft.wallKind),
                })
              }
            >
              Head-to-head
            </Button>
          </div>
        );
      },
    },

    // 12. Vortex Wall
    {
      key: "wallHalfWidthM",
      label: "Wall half-width",
      symbol: <>w</>,
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      scrub: "log",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "vortex_wall",
      validate: fieldError("wallHalfWidthM"),
    },
    {
      key: "leftMxSign",
      type: "custom",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "vortex_wall",
      render: (ctx) => (
        <SignSegmentedRow
          label="Left wire domain"
          options={[
            { value: "1", label: "+u (+1)" },
            { value: "-1", label: "−u (−1)" },
          ]}
          symbol={<>s<sub>L</sub></>}
          value={ctx.draft.leftMxSign}
          onChange={(next) => ctx.setField("leftMxSign", next)}
        />
      ),
    },
    {
      key: "rightMxSign",
      type: "custom",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "vortex_wall",
      render: (ctx) => (
        <SignSegmentedRow
          label="Right wire domain"
          options={[
            { value: "-1", label: "−u (−1)" },
            { value: "1", label: "+u (+1)" },
          ]}
          symbol={<>s<sub>R</sub></>}
          value={ctx.draft.rightMxSign}
          onChange={(next) => ctx.setField("rightMxSign", next)}
        />
      ),
    },

    // Artificial Spin Ice
    {
      key: "asiLattice",
      label: "Lattice geometry",
      type: "segmented",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "artificial_spin_ice",
      options: [
        { value: "square", label: "Square ASI" },
        { value: "kagome", label: "Kagome ASI" },
      ],
    },
    {
      key: "asiVertexState",
      label: "Vertex ice state",
      type: "select",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "artificial_spin_ice",
      options: [
        { value: "type_i_ground", label: "Type-I ground state (2-in / 2-out)" },
        { value: "type_ii_polarized", label: "Type-II polarized remanence" },
        { value: "monopole_pair", label: "Excited monopole defect" },
      ],
    },
    {
      key: "asiPitchM",
      label: "Vertex pitch",
      symbol: <>a</>,
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      scrub: "log",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "artificial_spin_ice",
      validate: fieldError("asiPitchM"),
    },

    // 13, 14, Spiral: Helical, Conical, Spiral
    {
      key: "spiralKind",
      label: "Spiral mode",
      type: "segmented",
      structural: true,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "spiral",
      options: [
        { value: "cycloidal", label: "Cycloidal" },
        { value: "proper_screw", label: "Proper screw" },
        { value: "custom_plane", label: "Custom plane" },
      ],
    },
    {
      key: "waveMode",
      label: "Wave input mode",
      type: "segmented",
      structural: true,
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "helical" || k === "conical";
      },
      options: [
        { value: "wavelength_axis", label: "Pitch λ + axis" },
        { value: "wavevector", label: "Wavevector q" },
      ],
    },
    {
      key: "wavelengthM",
      label: "Spatial period (pitch)",
      symbol: <>λ</>,
      symbolInfo: {
        name: "Spatial modulation period",
        definition: "Full 2π spatial wavelength λ = 2π / ‖q‖.",
        siUnit: "m",
        typicalRange: "20 nm – 250 nm",
      },
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      scrub: "log",
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "spiral" || ((k === "helical" || k === "conical") && d.waveMode === "wavelength_axis");
      },
      validate: fieldError("wavelengthM"),
    },
    {
      key: "propagationAxis",
      label: "Propagation axis",
      symbol: <>q̂</>,
      type: "vector3",
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "spiral" || ((k === "helical" || k === "conical") && d.waveMode === "wavelength_axis");
      },
      validate: fieldError("propagationAxis"),
    },
    {
      key: "wavevectorPerM",
      label: "Wavevector",
      symbol: <>q</>,
      type: "vector3",
      units: WAVEVECTOR_UNITS,
      defaultDisplayUnit: "rad/nm",
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return (k === "helical" || k === "conical") && d.waveMode === "wavevector";
      },
      validate: fieldError("wavevectorPerM"),
    },
    {
      key: "spinPlaneNormal",
      label: "Spin-plane normal",
      symbol: <>n̂<sub>s</sub></>,
      type: "vector3",
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d) =>
        canonicalPresetKind(d.presetKind) === "spiral" && d.spiralKind !== "proper_screw",
      validate: fieldError("spinPlaneNormal"),
    },
    {
      key: "e1",
      label: "Spin basis 1",
      symbol: <>ê<sub>1</sub></>,
      type: "vector3",
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "helical",
      validate: fieldError("e1"),
    },
    {
      key: "e2",
      label: "Spin basis 2",
      symbol: <>ê<sub>2</sub></>,
      type: "vector3",
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "helical",
      validate: fieldError("e2"),
    },
    {
      type: "custom",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "helical",
      render: (ctx) => (
        <div className="flex justify-end">
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() =>
              ctx.setField("e2", orthonormalizeSecondBasis(ctx.draft.e1, ctx.draft.e2))
            }
          >
            Orthonormalize e₂ ⊥ e₁
          </Button>
        </div>
      ),
    },
    {
      key: "coneAxis",
      label: "Cone axis",
      symbol: <>â</>,
      type: "vector3",
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "conical",
      validate: fieldError("coneAxis"),
    },
    {
      key: "coneAngleRad",
      label: "Cone half-angle",
      symbol: <>β</>,
      symbolInfo: {
        name: "Conical opening half-angle",
        definition: "Angle between spins and cone axis (0° = uniform, 90° = flat helix).",
        siUnit: "rad",
        typicalRange: "0° – 180°",
      },
      type: "quantity",
      units: ANGLE_UNITS,
      defaultDisplayUnit: "deg",
      min: 0,
      max: Math.PI,
      step: 5,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "conical",
      validate: fieldError("coneAngleRad"),
    },
    {
      key: "phaseRad",
      label: "Phase offset",
      symbol: <>φ<sub>0</sub></>,
      type: "quantity",
      units: ANGLE_UNITS,
      defaultDisplayUnit: "deg",
      step: 15,
      showWhen: (d) => {
        const k = canonicalPresetKind(d.presetKind);
        return k === "helical" || k === "conical" || k === "spiral" || k === "hopfion";
      },
    },

    // 15, 16, Bloch Point: 3D Topological
    {
      key: "hopfCharge",
      type: "custom",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "hopfion",
      render: (ctx) => (
        <SignSegmentedRow
          label="Hopf charge"
          options={[
            { value: "1", label: "Right-linked (+1)" },
            { value: "-1", label: "Left-linked (−1)" },
          ]}
          symbol={<>Q<sub>H</sub></>}
          value={ctx.draft.hopfCharge}
          onChange={(next) => ctx.setField("hopfCharge", next)}
        />
      ),
    },
    {
      key: "axialScale",
      label: "Axial scale",
      symbol: <>γ<sub>z</sub></>,
      type: "number",
      min: 0.05,
      step: 0.1,
      scrub: "lin",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "hopfion",
      validate: fieldError("axialScale"),
    },
    {
      key: "majorRadiusM",
      label: "Major radius",
      symbol: <>R<sub>H</sub></>,
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      scrub: "log",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "hopfion_compact_support",
      validate: fieldError("majorRadiusM"),
    },
    {
      key: "minorRadiusM",
      label: "Minor tube radius",
      symbol: <>r<sub>H</sub></>,
      type: "quantity",
      units: METRIC_LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      scrub: "log",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "hopfion_compact_support",
      validate: fieldError("minorRadiusM"),
    },
    {
      key: "bpKind",
      label: "Morphology",
      type: "segmented",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "bloch_point",
      options: [
        { value: "radial", label: "Radial" },
        { value: "circulating", label: "Circulating" },
        { value: "hyperbolic", label: "Hyperbolic" },
      ],
    },
    {
      key: "bpPolarity",
      type: "custom",
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "bloch_point",
      render: (ctx) => (
        <SignSegmentedRow
          label="Topological charge"
          options={[
            { value: "1", label: "+1 (+Z upper)" },
            { value: "-1", label: "−1 (−Z upper)" },
          ]}
          symbol={<>p</>}
          value={ctx.draft.bpPolarity}
          onChange={(next) => ctx.setField("bpPolarity", next)}
        />
      ),
    },
    {
      key: "bpTwistRad",
      label: "Equatorial twist",
      symbol: <>γ</>,
      type: "quantity",
      units: ANGLE_UNITS,
      defaultDisplayUnit: "deg",
      min: -Math.PI,
      max: Math.PI,
      step: 15,
      showWhen: (d) => canonicalPresetKind(d.presetKind) === "bloch_point",
      validate: fieldError("bpTwistRad"),
    },
  ];

  sections.push({
    id: "preset-parameters",
    title: "Preset parameters",
    icon: SlidersHorizontal,
    modeTabId: hostContext === "object" ? "preset" : undefined,
    defaultOpen: true,
    showWhen: showPresetAuthoring,
    summary: (d) => formatCharacteristicSizeSummary(d),
    rows: parameterRows,
  });

  // Section 3: Placement & Transform in Target (collapsed by default)
  sections.push({
    id: "placement-transform",
    title: `Placement & transform in ${targetWord}`,
    icon: Move3D,
    modeTabId: hostContext === "object" ? "preset" : undefined,
    defaultOpen: false,
    showWhen: showPresetAuthoring,
    summary: (d) => {
      const offsetNm = d.translationM.map((v) => Number((v * 1e9).toFixed(1))).join(", ");
      const rotDeg = d.eulerDeg.map((a) => `${Math.round(a)}°`).join(", ");
      const isUniformScale =
        Math.abs(d.scale[0] - d.scale[1]) < 1e-3 && Math.abs(d.scale[1] - d.scale[2]) < 1e-3;
      const scaleText = isUniformScale
        ? `${Number(d.scale[0].toFixed(2))}×`
        : `(${d.scale.map((s) => Number(s.toFixed(2))).join(", ")})`;
      const thicknessText =
        d.axisExtentMode === "thickness"
          ? ` · tz ${(d.axisThicknessM * 1e9).toPrecision(3)} nm`
          : "";
      return `Offset (${offsetNm}) nm · Rot (${rotDeg}) · Scale ${scaleText}${thicknessText}`;
    },
    rows: [
      {
        key: "translationUnitMode",
        label: "Offset coordinate mode",
        type: "select",
        structural: true,
        options: [
          { value: "nm", label: "Metric SI (nm / µm / m)" },
          { value: "bounds_pct", label: "% of target bounds [−50% .. +50%]" },
          { value: "bounds_norm", label: "Normalized bounds [−1 .. +1]" },
        ],
      },
      {
        key: "translationM",
        label: "Center offset",
        symbol: <>Δr</>,
        type: "vector3",
        units: METRIC_LENGTH_UNITS,
        defaultDisplayUnit: "nm",
        showWhen: (d) =>
          d.translationUnitMode !== "bounds_pct" && d.translationUnitMode !== "bounds_norm",
      },
      {
        key: "translationM",
        label: "Center offset",
        symbol: <>Δr</>,
        type: "custom",
        wide: true,
        showWhen: (d) =>
          d.translationUnitMode === "bounds_pct" || d.translationUnitMode === "bounds_norm",
        render: (ctx) => <RelativeBoundsOffsetField bounds={bounds} ctx={ctx} />,
      },
      {
        key: "axisExtentMode",
        label: "Through-axis extent",
        type: "segmented",
        structural: true,
        options: [
          { value: "uniform", label: "Uniform through axis" },
          { value: "thickness", label: "Finite thickness" },
        ],
      },
      {
        key: "axisThicknessM",
        label: "Axis thickness",
        symbol: <>t<sub>z</sub></>,
        symbolInfo: {
          name: "Out-of-plane slab thickness",
          definition:
            "Confines the texture to |z'| ≤ t_z / 2 along the local texture normal axis; outside the slab spins assume the background orientation.",
          siUnit: "m",
          typicalRange: "0.5 nm – 20 nm",
        },
        type: "quantity",
        units: METRIC_LENGTH_UNITS,
        defaultDisplayUnit: "nm",
        min: 1e-12,
        scrub: "log",
        showWhen: (d) => d.axisExtentMode === "thickness",
        validate: fieldError("axisThicknessM"),
      },
      {
        key: "rotationMode",
        label: "Rotation representation",
        type: "segmented",
        structural: true,
        options: [
          { value: "euler_xyz", label: "Euler XYZ" },
          { value: "axis_angle", label: "Axis–angle" },
        ],
      },
      {
        key: "eulerDeg",
        label: "Orientation",
        symbol: <>θ<sub>xyz</sub></>,
        type: "vector3",
        unitSuffix: "deg",
        showWhen: (d) => d.rotationMode === "euler_xyz",
      },
      {
        key: "axisAngleAxis",
        label: "Rotation axis",
        symbol: <>û</>,
        type: "vector3",
        axisPresets: true,
        normalizeAction: true,
        showWhen: (d) => d.rotationMode === "axis_angle",
      },
      {
        key: "axisAngleDeg",
        label: "Rotation angle",
        symbol: <>α</>,
        type: "number",
        unitSuffix: "deg",
        step: 15,
        showWhen: (d) => d.rotationMode === "axis_angle",
      },
      {
        type: "custom",
        wide: true,
        render: (ctx) => <QuickOrientationBar bounds={bounds} ctx={ctx} />,
      },
      {
        key: "rotateVectorsMode",
        label: "Rotate vectors with frame",
        type: "segmented",
        options: [
          { value: "space_and_spins", label: "Space + spins" },
          { value: "space_only", label: "Space only" },
        ],
      },
      {
        key: "uniformScaleLocked",
        label: "Lock uniform aspect ratio",
        type: "switch",
      },
      {
        key: "scale",
        label: "Scale multiplier",
        symbol: <>s</>,
        symbolInfo: {
          name: "Dimensionless coordinate scale multiplier",
          definition: "Pure coordinate stretch around 1.0 (never enter physical meter lengths here).",
          siUnit: "dimensionless",
          typicalRange: "0.25 – 4.0 (neutral = 1, 1, 1)",
        },
        type: "vector3",
        validate: (val) => validateScaleMultiplier(val),
      },
      {
        key: "pivotMode",
        label: "Pivot point",
        symbol: <>p</>,
        type: "segmented",
        structural: true,
        options:
          hostContext === "region"
            ? [
                { value: "region_center", label: "Region center" },
                { value: "object_center", label: "Object center" },
                { value: "custom", label: "Custom" },
              ]
            : [
                { value: "object_center", label: "Object center" },
                { value: "world_origin", label: "World [0,0,0]" },
                { value: "custom", label: "Custom" },
              ],
      },
      {
        key: "pivotM",
        label: "Custom pivot coordinates",
        type: "vector3",
        units: METRIC_LENGTH_UNITS,
        defaultDisplayUnit: "nm",
        showWhen: (d) => d.pivotMode === "custom",
      },
    ],
  });

  // Section 4: Coordinate Mapping, Bounds & Asset ID (collapsed by default)
  sections.push({
    id: "coordinate-mapping",
    title:
      hostContext === "object" && showObjectAssignmentSection
        ? "Coordinate mapping, bounds & asset ID"
        : "Coordinate mapping & bounds",
    icon: Scan,
    modeTabId: hostContext === "object" ? "preset" : undefined,
    defaultOpen: false,
    showWhen: showPresetAuthoring,
    summary: (d) => {
      const base = `${d.mappingSpace === "region" ? "Region local" : d.mappingSpace === "world" ? "World" : "Object local"} · ${d.clampMode === "none" ? "Unbounded" : d.clampMode}`;
      if (hostContext === "object" && showObjectAssignmentSection) {
        const refVal = typeof d.magnetizationRef === "string" ? d.magnetizationRef.trim() : "";
        return refVal ? `${base} · ${refVal}` : base;
      }
      return base;
    },
    rows: [
      ...(hostContext === "object" && showObjectAssignmentSection
        ? ([
            {
              key: "magnetizationRef",
              label: "Magnetization ref",
              type: "expression",
              placeholder: defaultMagnetizationRefPlaceholder ?? "mag:object:uniform",
              hint: "Custom asset IDs are preserved across saves; leave blank to auto-name.",
            },
          ] as InspectorRowSpec<MagneticTextureDraft>[])
        : []),
      {
        key: "mappingSpace",
        label: "Mapping space",
        type: "segmented",
        options:
          hostContext === "region"
            ? [
                { value: "region", label: "Region box" },
                { value: "object", label: "Object box" },
                { value: "world", label: "World" },
              ]
            : [
                { value: "object", label: "Object box" },
                { value: "world", label: "World" },
              ],
      },
      {
        key: "clampMode",
        label: "Out-of-bounds / clamp mode",
        type: "select",
        structural: true,
        options: [
          { value: "none", label: "Unbounded analytic (none)" },
          { value: "clamp", label: "Extend / clamp to box" },
          { value: "repeat", label: "Periodic tile (repeat)" },
          { value: "mirror", label: "Symmetric mirror tile" },
          { value: "background", label: "Uniform background spin" },
        ],
      },
      {
        key: "tilePeriodM",
        label: "Tile / box size",
        symbol: <>P</>,
        type: "vector3",
        units: METRIC_LENGTH_UNITS,
        defaultDisplayUnit: "nm",
        showWhen: (d) => d.clampMode !== "none",
        validate: fieldError("tilePeriodM"),
      },
      {
        type: "custom",
        showWhen: (d) => d.clampMode !== "none",
        render: (ctx) => (
          <div className="flex justify-end">
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => ctx.setField("tilePeriodM", [...bounds.size])}
            >
              Use target bounds
            </Button>
          </div>
        ),
      },
      {
        key: "backgroundVector",
        label: "Background spin",
        symbol: <>m̂<sub>bg</sub></>,
        type: "vector3",
        axisPresets: true,
        normalizeAction: true,
        showWhen: (d) => d.clampMode === "background",
        validate: fieldError("backgroundVector"),
      },
    ],
  });

  // Field File Mode Sections (honesty-gated by capabilities.field_state_import_formats)
  const activeFormatOptions = [
    { value: "auto", label: "Auto (detect from file)" },
    ...supportedFieldFormats.map((fmt) => ({
      value: fmt,
      label: FORMAT_LABELS[fmt] ?? fmt,
    })),
  ];

  sections.push({
    id: "field-file-source",
    title: "Field source & dataset",
    icon: FolderOpen,
    modeTabId: hostContext === "object" ? "field-file" : undefined,
    defaultOpen: true,
    showWhen: showFieldFileAuthoring,
    rows: [
      {
        type: "custom",
        wide: true,
        render: () => (
          <div
            className="flex flex-wrap items-center gap-1.5"
            data-testid="supported-field-formats"
          >
            <span className="text-xs text-fm-secondary">Accepted formats:</span>
            {supportedFieldFormats.map((fmt) => (
              <Badge key={fmt} className="text-xs">
                {formatSupportedFieldFormatBadge(fmt)}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        key: "fieldOrigin",
        label: "Source origin",
        type: "segmented",
        structural: true,
        options: [
          { value: "file", label: "Project file" },
          { value: "artifact", label: "Session artifact" },
        ],
      },
      {
        key: "fieldSourcePath",
        label: "Field file path",
        type: "expression",
        placeholder: "checkpoints/relaxed_state.ovf",
        showWhen: (d) => d.fieldOrigin === "file",
        validate: fieldError("fieldSourcePath"),
      },
      {
        key: "fieldArtifactRef",
        label: "Session artifact ID",
        type: "expression",
        placeholder: "field-states/body-m.field-state.json",
        showWhen: (d) => d.fieldOrigin === "artifact",
        validate: fieldError("fieldArtifactRef"),
      },
      {
        type: "custom",
        wide: true,
        render: (ctx) => (
          <div className="flex flex-wrap justify-end gap-1.5">
            {onLoadFieldState ? (
              <Button
                data-testid="load-field-state-btn"
                disabled={!canLoadFieldState || loadingFieldState}
                disabledReason={loadFieldStateDisabledReason ?? undefined}
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => void onLoadFieldState()}
              >
                <Upload aria-hidden="true" size={14} />
                <span>{loadingFieldState ? "Loading…" : "Load File"}</span>
              </Button>
            ) : null}
            <Button
              data-testid="inspect-field-file-btn"
              disabled={inspectingFieldFile}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => void onInspectFieldFile(ctx.draft)}
            >
              <SearchCheck aria-hidden="true" size={14} />
              <span>{inspectingFieldFile ? "Inspecting…" : "Inspect field file"}</span>
            </Button>
          </div>
        ),
      },
      {
        key: "fieldSourceFormat",
        label: "Container format",
        type: "select",
        options: activeFormatOptions,
      },
      {
        key: "fieldDataset",
        label: "Dataset / array key",
        type: "expression",
        placeholder: "fields/m",
      },
      {
        key: "fieldSampleIndex",
        label: "Frame / sample index",
        symbol: <>k</>,
        type: "number",
        integer: true,
        min: -1,
        step: 1,
        hint: "Use −1 to select the final saved frame.",
        validate: fieldError("fieldSampleIndex"),
      },
    ],
  });

  sections.push({
    id: "field-file-resampling",
    title: "Grid compatibility & resampling",
    icon: Grid3x3,
    modeTabId: hostContext === "object" ? "field-file" : undefined,
    defaultOpen: true,
    showWhen: showFieldFileAuthoring,
    rows: [
      ...(inspectionSummary
        ? ([
            {
              type: "readonly",
              label: "Inspected vectors",
              format: () =>
                `${inspectionSummary.vectorCount.toLocaleString()} vectors · ${inspectionSummary.frameCount} frame(s)`,
            },
            {
              type: "readonly",
              label: "Norm range",
              format: () =>
                `${inspectionSummary.minNorm.toFixed(4)} .. ${inspectionSummary.maxNorm.toFixed(4)}`,
            },
          ] as InspectorRowSpec<MagneticTextureDraft>[])
        : []),
      {
        key: "fieldInterpolation",
        label: "Interpolation mode",
        type: "segmented",
        options: [
          {
            value: "exact",
            label: "Exact",
            disabledReason:
              inspectionSummary && !inspectionSummary.compatible
                ? "Source and target discretizations differ; choose Nearest or Trilinear."
                : undefined,
          },
          { value: "nearest", label: "Nearest" },
          { value: "trilinear", label: "Trilinear" },
        ],
      },
      {
        key: "fieldRenormalize",
        label: "Renormalize unit norm ‖m‖ = 1",
        type: "switch",
      },
    ],
  });

  return sections;
}

export function formatCharacteristicSizeSummary(draft: MagneticTextureDraft): string {
  if (draft.sourceMode === "field-file") {
    return draft.fieldOrigin === "artifact"
      ? draft.fieldArtifactRef || "Session artifact"
      : draft.fieldSourcePath || "Field file";
  }
  const kind = canonicalPresetKind(draft.presetKind);
  switch (kind) {
    case "uniform":
      return `m̂ (${draft.direction.map((c) => Number(c.toFixed(2))).join(", ")})`;
    case "random":
      return `Seed ${draft.seed}`;
    case "vortex":
    case "antivortex":
      return `rc ${(draft.coreRadiusM * 1e9).toPrecision(3)} nm`;
    case "bloch_skyrmion":
    case "neel_skyrmion":
    case "antiskyrmion":
    case "bimeron":
      return `R ${(draft.radiusM * 1e9).toPrecision(3)} nm, Δ ${(draft.wallWidthM * 1e9).toPrecision(3)} nm`;
    case "skyrmionium":
      return `Rin ${(draft.innerRadiusM * 1e9).toPrecision(3)} nm, Rout ${(draft.outerRadiusM * 1e9).toPrecision(3)} nm`;
    case "skyrmion_lattice":
      return `a ${(draft.latticeConstantM * 1e9).toPrecision(3)} nm, R ${(draft.radiusM * 1e9).toPrecision(3)} nm`;
    case "domain_wall":
      return `Δ ${(draft.wallWidthM * 1e9).toPrecision(3)} nm (${draft.wallKind === "bloch" ? "Bloch" : "Néel"})`;
    case "two_domain":
      return draft.twoDomainSharp
        ? "Sharp step"
        : `Δ ${(draft.wallWidthM * 1e9).toPrecision(3)} nm`;
    case "vortex_wall":
      return `2w ${(2 * draft.wallHalfWidthM * 1e9).toPrecision(3)} nm`;
    case "artificial_spin_ice":
      return `a ${(draft.asiPitchM * 1e9).toPrecision(3)} nm (${draft.asiLattice})`;
    case "helical":
    case "conical":
    case "spiral":
      return `λ ${(draft.wavelengthM * 1e9).toPrecision(3)} nm`;
    case "hopfion":
      return `R ${(draft.radiusM * 1e9).toPrecision(3)} nm, γz ${draft.axialScale.toPrecision(2)}`;
    case "hopfion_compact_support":
      return `RH ${(draft.majorRadiusM * 1e9).toPrecision(3)} nm, rH ${(draft.minorRadiusM * 1e9).toPrecision(3)} nm`;
    case "bloch_point":
      return `Q ${draft.bpPolarity > 0 ? "+1" : "−1"} (${draft.bpKind})`;
  }
}

export function applyCoupledDraftFieldChange<K extends keyof MagneticTextureDraft & string>(
  current: MagneticTextureDraft,
  key: K,
  value: MagneticTextureDraft[K],
  bounds: TargetMetricBounds,
): Partial<MagneticTextureDraft> {
  if (key === "scale" && current.uniformScaleLocked && Array.isArray(value)) {
    const nextScale = value as unknown as Vec3;
    const prevScale = current.scale;
    let changedIdx = -1;
    for (let i = 0; i < 3; i += 1) {
      if (Math.abs(nextScale[i]! - prevScale[i]!) > 1e-12) {
        changedIdx = i;
        break;
      }
    }
    if (changedIdx >= 0 && Math.abs(prevScale[changedIdx]!) > 1e-12) {
      const ratio = nextScale[changedIdx]! / prevScale[changedIdx]!;
      return {
        scale: [
          changedIdx === 0 ? nextScale[0] : prevScale[0] * ratio,
          changedIdx === 1 ? nextScale[1] : prevScale[1] * ratio,
          changedIdx === 2 ? nextScale[2] : prevScale[2] * ratio,
        ],
      };
    }
  }

  if (key === "eulerDeg" && Array.isArray(value)) {
    const euler = value as unknown as Vec3;
    return {
      eulerDeg: euler,
      rotationQuat: eulerDegreesToQuaternion(euler),
    };
  }

  if (key === "axisAngleAxis" && Array.isArray(value)) {
    const axis = value as unknown as Vec3;
    const quat = axisAngleToQuaternion(axis, current.axisAngleDeg);
    return {
      axisAngleAxis: axis,
      rotationQuat: quat,
      eulerDeg: quaternionToEulerDegrees(quat, current.eulerDeg),
    };
  }

  if (key === "axisAngleDeg" && typeof value === "number") {
    const quat = axisAngleToQuaternion(current.axisAngleAxis, value);
    return {
      axisAngleDeg: value,
      rotationQuat: quat,
      eulerDeg: quaternionToEulerDegrees(quat, current.eulerDeg),
    };
  }

  if (key === "planeMode" && typeof value === "string") {
    const mode = value as PlaneSelectionMode;
    const resolvedPlane =
      mode === "auto" ? resolveLargestFacePlane(bounds.size) : mode;
    return {
      planeMode: mode,
      resolvedPlane,
    };
  }

  if (key === "leftDomain" && Array.isArray(value) && current.lockAntiparallelRight) {
    const left = value as unknown as Vec3;
    return {
      leftDomain: left,
      rightDomain: [-left[0], -left[1], -left[2]],
    };
  }

  if (key === "lockAntiparallelRight" && value === true) {
    return {
      lockAntiparallelRight: true,
      rightDomain: [
        -current.leftDomain[0],
        -current.leftDomain[1],
        -current.leftDomain[2],
      ],
    };
  }

  if (key === "wavelengthM" && typeof value === "number" && value > 1e-15) {
    const qLen = Math.hypot(...current.propagationAxis);
    const qHat: Vec3 =
      qLen > 1e-12
        ? [
            current.propagationAxis[0] / qLen,
            current.propagationAxis[1] / qLen,
            current.propagationAxis[2] / qLen,
          ]
        : [1, 0, 0];
    const qMag = (2.0 * Math.PI) / value;
    return {
      wavelengthM: value,
      wavevectorPerM: [qHat[0] * qMag, qHat[1] * qMag, qHat[2] * qMag],
    };
  }

  if (key === "propagationAxis" && Array.isArray(value)) {
    const axis = value as unknown as Vec3;
    const qLen = Math.hypot(axis[0], axis[1], axis[2]);
    if (qLen > 1e-12 && current.wavelengthM > 1e-15) {
      const qMag = (2.0 * Math.PI) / current.wavelengthM;
      return {
        propagationAxis: axis,
        wavevectorPerM: [
          (axis[0] / qLen) * qMag,
          (axis[1] / qLen) * qMag,
          (axis[2] / qLen) * qMag,
        ],
      };
    }
  }

  if (key === "wavevectorPerM" && Array.isArray(value)) {
    const q = value as unknown as Vec3;
    const qLen = Math.hypot(q[0], q[1], q[2]);
    if (qLen > 1e-14) {
      return {
        wavevectorPerM: q,
        wavelengthM: (2.0 * Math.PI) / qLen,
        propagationAxis: [q[0] / qLen, q[1] / qLen, q[2] / qLen],
      };
    }
  }

  if (key === "pivotMode" && typeof value === "string") {
    if (value === "object_center" || value === "region_center" || value === "world_origin") {
      return {
        pivotMode: value as MagneticTextureDraft["pivotMode"],
        pivotM: [0, 0, 0],
      };
    }
  }

  const canonicalKind = canonicalPresetKind(current.presetKind);

  // Coupled auto-clamping for skyrmion_lattice: keep latticeConstantM > 2 * radiusM smoothly
  if (
    canonicalKind === "skyrmion_lattice" &&
    key === "radiusM" &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  ) {
    const minLattice = value * 2.1;
    if (!Number.isFinite(current.latticeConstantM) || current.latticeConstantM < minLattice) {
      return {
        ...(current.sourceMode !== "preset" ? { sourceMode: "preset" as const } : {}),
        radiusM: value,
        latticeConstantM: minLattice,
      };
    }
  }

  if (
    canonicalKind === "skyrmion_lattice" &&
    key === "latticeConstantM" &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  ) {
    const maxRadius = value * 0.45;
    if (!Number.isFinite(current.radiusM) || current.radiusM > maxRadius) {
      return {
        ...(current.sourceMode !== "preset" ? { sourceMode: "preset" as const } : {}),
        latticeConstantM: value,
        radiusM: maxRadius,
      };
    }
  }

  // Coupled auto-clamping for skyrmionium: keep outerRadiusM >= innerRadiusM * 1.1 smoothly
  if (
    canonicalKind === "skyrmionium" &&
    key === "innerRadiusM" &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  ) {
    const minOuter = value * 1.1;
    if (!Number.isFinite(current.outerRadiusM) || current.outerRadiusM < minOuter) {
      return {
        ...(current.sourceMode !== "preset" ? { sourceMode: "preset" as const } : {}),
        innerRadiusM: value,
        outerRadiusM: minOuter,
      };
    }
  }

  if (
    canonicalKind === "skyrmionium" &&
    key === "outerRadiusM" &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  ) {
    const maxInner = value / 1.1;
    if (!Number.isFinite(current.innerRadiusM) || current.innerRadiusM > maxInner) {
      return {
        ...(current.sourceMode !== "preset" ? { sourceMode: "preset" as const } : {}),
        outerRadiusM: value,
        innerRadiusM: maxInner,
      };
    }
  }

  if (THREE_DIMENSIONAL_OBJECT_LOCAL_PRESETS.has(current.presetKind) && key === "planeMode") {
    return { planeMode: "auto", resolvedPlane: "xy" };
  }

  if (
    current.sourceMode !== "field-file" &&
    (key === "fieldOrigin" ||
      key === "fieldSourcePath" ||
      key === "fieldArtifactRef" ||
      key === "fieldSourceFormat" ||
      key === "fieldDataset" ||
      key === "fieldSampleIndex" ||
      key === "fieldInterpolation" ||
      key === "fieldRenormalize")
  ) {
    return {
      sourceMode: "field-file",
      [key]: value,
    } as Partial<MagneticTextureDraft>;
  }

  return { [key]: value } as Partial<MagneticTextureDraft>;
}
