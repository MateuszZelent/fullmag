"use client";

import { Box, Plus, Shapes, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";

import {
  ANGLE_UNITS,
  formatLengthAuto,
  LENGTH_UNITS,
} from "../../../panels/model-roots/SpecInspectorHost";
import type { InspectorSectionSpec } from "../../../template";

import {
  createPolygonVertexRow,
  validateArchWaveguide,
  validateSimplePolygon,
  validateTorusRadii,
  validateTubeRadii,
  type ObjectGeometrySpecDraft,
  type PolygonVertexRow,
} from "./geometryShared";

/* ── Controlled Polygon Vertex Input (0 defaultValue) ── */

function formatVertexNm(meters: number): string {
  return String(Number((meters * 1e9).toFixed(3)));
}

function PolygonVertexAxisInput({
  ariaLabel,
  valueMeters,
  onChangeMeters,
}: {
  ariaLabel: string;
  valueMeters: number;
  onChangeMeters: (nextMeters: number) => void;
}) {
  const canonicalText = formatVertexNm(valueMeters);
  const [rawText, setRawText] = useState(canonicalText);
  const [prevMeters, setPrevMeters] = useState(valueMeters);
  const [lastCommittedMeters, setLastCommittedMeters] = useState(valueMeters);

  if (!Object.is(valueMeters, prevMeters)) {
    setPrevMeters(valueMeters);
    if (!Object.is(valueMeters, lastCommittedMeters)) {
      setLastCommittedMeters(valueMeters);
      setRawText(canonicalText);
    }
  }

  return (
    <Input
      aria-label={ariaLabel}
      inputMode="decimal"
      spellCheck={false}
      type="text"
      value={rawText}
      onBlur={() => {
        const trimmed = rawText.trim();
        const parsed = trimmed.length > 0 ? Number(trimmed) : Number.NaN;
        if (Number.isFinite(parsed)) {
          const nextMeters = parsed * 1e-9;
          setLastCommittedMeters(nextMeters);
          if (!Object.is(nextMeters, valueMeters)) {
            onChangeMeters(nextMeters);
          }
          setRawText(formatVertexNm(nextMeters));
        } else {
          setRawText(canonicalText);
        }
      }}
      onChange={(event) => {
        const nextText = event.target.value;
        setRawText(nextText);
        const trimmed = nextText.trim();
        const parsed = trimmed.length > 0 ? Number(trimmed) : Number.NaN;
        if (Number.isFinite(parsed)) {
          const nextMeters = parsed * 1e-9;
          setLastCommittedMeters(nextMeters);
          if (!Object.is(nextMeters, valueMeters)) {
            onChangeMeters(nextMeters);
          }
        }
      }}
    />
  );
}

export interface GeometryShapeSectionOptions {
  materialOptions: readonly { id: string; label: string }[];
}

export function buildGeometryShapeSections({
  materialOptions,
}: GeometryShapeSectionOptions): InspectorSectionSpec<ObjectGeometrySpecDraft>[] {
  return [
    {
      id: "geometry-shape-kind",
      modeTabId: "shape",
      title: "Primitive family",
      icon: Shapes,
      defaultOpen: true,
      showWhen: (d) => !d.compositeSummary,
      summary: (d) => d.primitiveKind,
      rows: [
        {
          key: "draftName",
          type: "text",
          label: "New object name",
          showWhen: (d) => d.mode === "draft-new",
          validate: (val) => (val.trim().length === 0 ? "Object name is required." : null),
        },
        {
          key: "materialRef",
          type: "reference",
          label: "Material",
          targetKindLabel: "Material",
          showWhen: (d) => d.mode === "draft-new",
          allowNone: { label: "Unassigned" },
          options: () => materialOptions,
        },
        {
          key: "regionName",
          type: "text",
          label: "Region",
          placeholder: "Optional region name",
          showWhen: (d) => d.mode === "draft-new",
        },
        {
          key: "primitiveKind",
          type: "select",
          label: "Primitive kind",
          structural: true,
          options: [
            { value: "Box", label: "Box (rectangular prism)", group: "Analytic solids" },
            { value: "Cylinder", label: "Cylinder / disk", group: "Analytic solids" },
            { value: "Ellipsoid", label: "Ellipsoid", group: "Analytic solids" },
            { value: "Sphere", label: "Sphere", group: "Analytic solids" },
            { value: "Tube", label: "Tube (hollow cylinder / ring)", group: "Shells & rings" },
            { value: "Cone", label: "Cone / truncated frustum", group: "Shells & rings" },
            { value: "Torus", label: "Torus", group: "Shells & rings" },
            {
              value: "ArchWaveguide",
              label: "Arch waveguide (3D curved strip)",
              group: "Waveguides & extrusions",
            },
            {
              value: "PolygonExtrusion",
              label: "Polygon extrusion (2D contour)",
              group: "Waveguides & extrusions",
            },
            {
              value: "ImportedMesh",
              label: "Imported surface / CAD mesh",
              group: "External assets",
            },
          ],
        },
        {
          key: "symmetryAxis",
          type: "segmented",
          label: "Principal axis",
          showWhen: (d) =>
            d.primitiveKind === "Cylinder" ||
            d.primitiveKind === "Tube" ||
            d.primitiveKind === "Cone" ||
            d.primitiveKind === "Torus" ||
            d.primitiveKind === "PolygonExtrusion",
          options: [
            { value: "x", label: "X" },
            { value: "y", label: "Y" },
            { value: "z", label: "Z" },
          ],
        },
      ],
    },
    {
      id: "geometry-shape-dimensions",
      modeTabId: "shape",
      title: "Parametric dimensions",
      icon: Box,
      defaultOpen: true,
      showWhen: (d) => !d.compositeSummary,
      rows: [
        /* Box & Ellipsoid */
        {
          key: "sizeX",
          type: "quantity",
          label: "Extent X",
          symbol: (
            <>
              L<sub>x</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
          validate: (v) => (v > 0 ? null : "Extent X must be strictly positive."),
        },
        {
          key: "sizeY",
          type: "quantity",
          label: "Extent Y",
          symbol: (
            <>
              L<sub>y</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
          validate: (v) => (v > 0 ? null : "Extent Y must be strictly positive."),
        },
        {
          key: "sizeZ",
          type: "quantity",
          label: "Thickness Z",
          symbol: (
            <>
              L<sub>z</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
          validate: (v) => (v > 0 ? null : "Thickness Z must be strictly positive."),
        },

        /* Cylinder & Sphere */
        {
          key: "radius",
          type: "quantity",
          label: "Radius",
          symbol: <>R</>,
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.primitiveKind === "Cylinder" || d.primitiveKind === "Sphere",
          validate: (v) => (v > 0 ? null : "Radius R must be strictly positive."),
        },
        {
          key: "height",
          type: "quantity",
          label: "Height / thickness",
          symbol: <>h</>,
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) =>
            d.primitiveKind === "Cylinder" ||
            d.primitiveKind === "Tube" ||
            d.primitiveKind === "Cone" ||
            d.primitiveKind === "ArchWaveguide" ||
            d.primitiveKind === "PolygonExtrusion",
          validate: (v) => (v > 0 ? null : "Height h must be strictly positive."),
        },

        /* Tube */
        {
          key: "innerRadius",
          type: "quantity",
          label: "Inner radius",
          symbol: (
            <>
              R<sub>in</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.primitiveKind === "Tube",
          validate: (v, d) => validateTubeRadii(v, d.outerRadius),
        },
        {
          key: "outerRadius",
          type: "quantity",
          label: "Outer radius",
          symbol: (
            <>
              R<sub>out</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.primitiveKind === "Tube",
          validate: (v, d) => validateTubeRadii(d.innerRadius, v),
        },

        /* Cone */
        {
          key: "bottomRadius",
          type: "quantity",
          label: "Bottom radius",
          symbol: (
            <>
              R<sub>1</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          showWhen: (d) => d.primitiveKind === "Cone",
          validate: (v, d) =>
            v < 0
              ? "Bottom radius must be non-negative."
              : v + d.topRadius <= 0
                ? "At least one cone radius must be strictly positive."
                : null,
        },
        {
          key: "topRadius",
          type: "quantity",
          label: "Top radius",
          symbol: (
            <>
              R<sub>2</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          showWhen: (d) => d.primitiveKind === "Cone",
          validate: (v, d) =>
            v < 0
              ? "Top radius must be non-negative."
              : d.bottomRadius + v <= 0
                ? "At least one cone radius must be strictly positive."
                : null,
        },

        /* Torus */
        {
          key: "majorRadius",
          type: "quantity",
          label: "Major ring radius",
          symbol: (
            <>
              R<sub>maj</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.primitiveKind === "Torus",
          validate: (v, d) => validateTorusRadii(v, d.minorRadius),
        },
        {
          key: "minorRadius",
          type: "quantity",
          label: "Minor tube radius",
          symbol: (
            <>
              r<sub>min</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.primitiveKind === "Torus",
          validate: (v, d) => validateTorusRadii(d.majorRadius, v),
        },

        /* ArchWaveguide */
        {
          key: "archProfile",
          type: "segmented",
          label: "Arch profile",
          structural: true,
          showWhen: (d) => d.primitiveKind === "ArchWaveguide",
          options: [
            { value: "parabolic_arch", label: "Parabolic arch" },
            { value: "circular_arc", label: "Circular arc" },
          ],
        },
        {
          key: "length",
          type: "quantity",
          label: "Span length",
          symbol: <>L</>,
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.primitiveKind === "ArchWaveguide",
          validate: (v, d) => validateArchWaveguide({ ...d, length: v }).errors.length ?? null,
        },
        {
          key: "width",
          type: "quantity",
          label: "Strip width",
          symbol: <>w</>,
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.primitiveKind === "ArchWaveguide",
          validate: (v, d) => {
            const res = validateArchWaveguide({ ...d, width: v });
            return res.errors.width ?? res.errors.archRadius ?? null;
          },
        },
        {
          key: "archHeight",
          type: "quantity",
          label: "Apex arch height",
          symbol: (
            <>
              h<sub>arch</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          showWhen: (d) =>
            d.primitiveKind === "ArchWaveguide" && d.archProfile === "parabolic_arch",
          validate: (v, d) =>
            validateArchWaveguide({ ...d, archHeight: v }).errors.archHeight ?? null,
        },
        {
          key: "archRadius",
          type: "quantity",
          label: "Centerline arc radius",
          symbol: (
            <>
              R<sub>arc</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) =>
            d.primitiveKind === "ArchWaveguide" && d.archProfile === "circular_arc",
          validate: (v, d) =>
            validateArchWaveguide({ ...d, archRadius: v }).errors.archRadius ?? null,
        },
        {
          key: "archAngleRad",
          type: "quantity",
          label: "Opening angle",
          symbol: <>&Delta;&theta;</>,
          units: ANGLE_UNITS,
          defaultDisplayUnit: "deg",
          showWhen: (d) =>
            d.primitiveKind === "ArchWaveguide" && d.archProfile === "circular_arc",
          validate: (v, d) =>
            validateArchWaveguide({ ...d, archAngleRad: v }).errors.archAngleRad ?? null,
        },
        {
          key: "z0",
          type: "quantity",
          label: "Base elevation",
          symbol: (
            <>
              z<sub>0</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          showWhen: (d) => d.primitiveKind === "ArchWaveguide",
        },
        {
          type: "readonly",
          label: "Derived apex rise",
          mono: true,
          showWhen: (d) =>
            d.primitiveKind === "ArchWaveguide" && d.archProfile === "circular_arc",
          format: (d) => {
            const rise = d.archRadius * (1 - Math.cos(Math.abs(d.archAngleRad) / 2));
            return formatLengthAuto(rise) ?? "0 nm";
          },
        },

        /* PolygonExtrusion — Single Controlled Vertex Editor */
        {
          key: "polygonVertices",
          type: "custom",
          label: "2D contour vertices (nm)",
          wide: true,
          showWhen: (d) => d.primitiveKind === "PolygonExtrusion",
          validate: (verts) => validateSimplePolygon(verts as readonly PolygonVertexRow[]),
          render: (ctx) => (
            <div className="flex flex-col gap-1.5" data-slot="polygon-vertex-editor">
              {ctx.draft.polygonVertices.map((vtx, idx) => (
                <div key={vtx._rowId} className="flex items-center gap-1.5">
                  <span className="w-6 font-mono text-xs text-[var(--fm-text-muted)]">
                    V{idx + 1}
                  </span>
                  <PolygonVertexAxisInput
                    ariaLabel={`Vertex ${idx + 1} X (nm)`}
                    valueMeters={vtx.x_m}
                    onChangeMeters={(nextXm) =>
                      ctx.setField(
                        "polygonVertices",
                        ctx.draft.polygonVertices.map((item) =>
                          item._rowId === vtx._rowId ? { ...item, x_m: nextXm } : item,
                        ),
                      )
                    }
                  />
                  <PolygonVertexAxisInput
                    ariaLabel={`Vertex ${idx + 1} Y (nm)`}
                    valueMeters={vtx.y_m}
                    onChangeMeters={(nextYm) =>
                      ctx.setField(
                        "polygonVertices",
                        ctx.draft.polygonVertices.map((item) =>
                          item._rowId === vtx._rowId ? { ...item, y_m: nextYm } : item,
                        ),
                      )
                    }
                  />
                  <Button
                    aria-label={`Remove vertex ${idx + 1}`}
                    disabled={ctx.draft.polygonVertices.length <= 3}
                    size="icon"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      ctx.setField(
                        "polygonVertices",
                        ctx.draft.polygonVertices.filter((item) => item._rowId !== vtx._rowId),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" size={12} />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => {
                  const last = ctx.draft.polygonVertices.at(-1);
                  ctx.setField("polygonVertices", [
                    ...ctx.draft.polygonVertices,
                    createPolygonVertexRow((last?.x_m ?? 0) + 20e-9, last?.y_m ?? 0),
                  ]);
                }}
              >
                <Plus aria-hidden="true" size={12} />
                <span>Add Polygon Vertex</span>
              </Button>
            </div>
          ),
        },

        /* ImportedMesh */
        {
          key: "meshAssetPath",
          type: "expression",
          label: "Surface mesh asset ID / path",
          placeholder: "assets/waveguide_manifold.stl",
          showWhen: (d) => d.primitiveKind === "ImportedMesh",
          validate: (v) =>
            v.trim().length === 0 ? "Provide a session mesh asset identifier or path." : null,
        },
        {
          key: "meshUnitScale",
          type: "quantity",
          label: "Coordinate unit scale",
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.primitiveKind === "ImportedMesh",
          validate: (v) =>
            Number.isFinite(v) && v > 0
              ? null
              : "Coordinate unit scale must be strictly positive.",
        },
      ],
    },
  ];
}
