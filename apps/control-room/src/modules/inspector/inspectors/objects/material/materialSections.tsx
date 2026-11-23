"use client";

import {
  Atom,
  BookOpen,
  Compass,
  CopyPlus,
  Cpu,
  History,
  Magnet,
  RefreshCw,
} from "lucide-react";

import type {
  MaterialReferenceResource,
  SceneMaterialResource,
  SceneMaterialSource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import {
  formatMaterialSourceChange,
  materialSourceChanges,
  materialSourceStatus,
} from "@/shared/domain/material/materialLibrary";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import {
  ANISOTROPY_UNITS,
  CONDUCTIVITY_UNITS,
  DENSITY_UNITS,
  DMI_UNITS,
  ELASTIC_MODULUS_UNITS,
  ELECTRON_GAMMA_PER_G,
  EXCHANGE_UNITS,
  GYRO_UNITS,
  MAGNETIZATION_UNITS,
  MAGNETOELASTIC_B_UNITS,
  MU0_SI,
  normalizeVector3,
  vectorNorm,
} from "../../../panels/model-roots/SpecInspectorHost";
import type {
  InspectorActionContext,
  InspectorRowSpec,
  InspectorSectionSpec,
} from "../../../template";
import { MaterialLibraryPickerDialog } from "./MaterialLibraryPickerDialog";
import { computePendingPhysicsActivations } from "./materialPhysicsAutoActivation";
import {
  classifyUniaxialAnisotropyRegime,
  computeExchangeLengthMeters,
  formatAnisotropyFieldReadout,
  formatReferencesSummary,
  orthogonalizeAxisGramSchmidt,
  resolveMaterialPropertiesFromDraft,
  type RevisionConflictState,
  suggestNewMaterialId,
  type UnifiedObjectMaterialDraft,
  validateBornCubicStability,
} from "./materialShared";

export interface SessionMaterialOption {
  readonly id: string;
  readonly label: string;
  readonly subtitle: string;
}

export interface BuildMaterialSectionsParams {
  readonly baseline: UnifiedObjectMaterialDraft;
  readonly sceneData: SceneResource | null | undefined;
  readonly sessionMaterials: readonly SessionMaterialOption[];
  readonly existingMaterialIds: ReadonlySet<string>;
  readonly dialogModelMaterial: SceneMaterialResource | undefined;
  readonly activeSourceSnapshot: SceneMaterialSource | null;
  readonly activeReferences: readonly MaterialReferenceResource[];
  readonly conflictState: RevisionConflictState | null;
  readonly onOpenCatalog: () => void;
  readonly onRefreshAndRebase: () => void;
  readonly onRetryFailedAssignment: (
    ctx: InspectorActionContext<UnifiedObjectMaterialDraft>,
  ) => Promise<void>;
  readonly onDuplicateAndUnlink: (
    ctx: InspectorActionContext<UnifiedObjectMaterialDraft>,
  ) => Promise<void>;
}

export function buildMaterialSpecSections({
  baseline,
  sceneData,
  sessionMaterials,
  existingMaterialIds,
  dialogModelMaterial,
  activeSourceSnapshot,
  activeReferences,
  conflictState,
  onOpenCatalog,
  onRefreshAndRebase,
  onRetryFailedAssignment,
  onDuplicateAndUnlink,
}: BuildMaterialSectionsParams): readonly InspectorSectionSpec<UnifiedObjectMaterialDraft>[] {
  const computeChangesForDraft = (d: UnifiedObjectMaterialDraft) => {
    if (!activeSourceSnapshot || !d.materialId || d.pendingNewMaterial) {
      return [];
    }
    return materialSourceChanges(
      resolveMaterialPropertiesFromDraft(d, baseline),
      activeReferences,
      activeSourceSnapshot,
    );
  };

  const sourceChangeRows: InspectorRowSpec<UnifiedObjectMaterialDraft>[] =
    activeSourceSnapshot
      ? [
          {
            type: "readonly",
            label: "Changes from source",
            showWhen: (d) => computeChangesForDraft(d).length > 0,
            format: (d) =>
              computeChangesForDraft(d)
                .map((change) => formatMaterialSourceChange(change))
                .join(" \u00b7 "),
          },
        ]
      : [];

  return [
    /* ── Section 1: Assignment & Library ── */
    {
      id: "material-assignment",
      title: "Material assignment & catalog",
      icon: BookOpen,
      defaultOpen: true,
      summary: (d) => (d.materialId ? d.materialName : "Unassigned"),
      rows: [
        {
          key: "materialId",
          type: "reference",
          label: "Assigned session material",
          targetKindLabel: "Material",
          allowNone: { label: "Unassigned" },
          options: (d) => {
            const base = [...sessionMaterials];
            if (d.materialId && !base.some((m) => m.id === d.materialId)) {
              base.unshift({
                id: d.materialId,
                label: d.materialName,
                subtitle: "Staged custom / library material",
              });
            }
            return base;
          },
          sharedUsageWarning: (d) =>
            d.sharedWithObjects.length > 1 && !d.pendingNewMaterial && d.materialId
              ? `Shared by ${d.sharedWithObjects.length} objects`
              : null,
          onCreateNew: (ctx) => {
            const nextId = suggestNewMaterialId(
              `custom-${ctx.draft.objectId || "mat"}`,
              existingMaterialIds,
            );
            ctx.patchDraft({
              materialId: nextId,
              newMaterialId: nextId,
              materialName: `Custom (${ctx.draft.objectName})`,
              pendingNewMaterial: true,
            });
          },
          onDuplicateUnlink: baseline.materialId
            ? (ctx) => onDuplicateAndUnlink(ctx)
            : undefined,
        },
        {
          key: "newMaterialId",
          type: "text",
          mono: true,
          label: "New material ID",
          showWhen: (d) =>
            d.pendingNewMaterial || (!d.materialId && !baseline.materialId),
          validate: (v, d) => {
            if (
              !(d.pendingNewMaterial || (!d.materialId && !baseline.materialId))
            ) {
              return null;
            }
            const trimmed = v.trim();
            if (!trimmed) {
              return "New material ID cannot be empty.";
            }
            if (existingMaterialIds.has(trimmed)) {
              return `Material ID "${trimmed}" already exists in this model.`;
            }
            return null;
          },
        },
        {
          key: "materialName",
          type: "text",
          label: "Material display name",
          showWhen: (d) =>
            Boolean(d.materialId) || d.pendingNewMaterial || !baseline.materialId,
          validate: (v, d) => {
            if (!d.materialId && !d.pendingNewMaterial && baseline.materialId) {
              return null;
            }
            return v.trim().length === 0 ? "Material name cannot be empty." : null;
          },
        },
        {
          key: "activateRequiredPhysics",
          type: "switch",
          label: "Also enable required physics modules on Apply",
          hint: "Explicit opt-in: off by default so material edits never silently activate physics modules.",
          showWhen: (d) => d.isMagneticBody,
        },
        {
          type: "custom",
          wide: true,
          label: "Physics modules to enable",
          showWhen: (d) => d.isMagneticBody,
          render: (ctx) => {
            const pending = computePendingPhysicsActivations(ctx.draft, sceneData);
            return (
              <div
                className="flex flex-col gap-1.5 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] px-2.5 py-2"
                data-slot="material-physics-optin-summary"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-[var(--fm-text)]">
                    {ctx.draft.activateRequiredPhysics
                      ? "Will enable on Apply"
                      : "Pending physics modules (opt-in off)"}
                  </span>
                  <span className="font-mono text-xs text-[var(--fm-text-muted)]">
                    {pending.length}
                  </span>
                </div>
                {pending.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {pending.map((item) => (
                      <Badge
                        key={item.id}
                        variant={
                          ctx.draft.activateRequiredPhysics ? "accent" : "secondary"
                        }
                      >
                        {item.label}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-[var(--fm-text-muted)]">
                    All required physics modules are already active.
                  </span>
                )}
              </div>
            );
          },
        },
      ],
      footer: (ctx) => (
        <div className="flex flex-col gap-2">
          <MaterialLibraryPickerDialog
            ctx={ctx}
            existingIds={existingMaterialIds}
            hasActiveModelMaterial={Boolean(dialogModelMaterial)}
            onOpenFullCatalog={onOpenCatalog}
          />
          {conflictState ? (
            <div
              className="flex flex-wrap gap-1.5"
              data-slot="material-conflict-actions"
            >
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={onRefreshAndRebase}
              >
                <RefreshCw aria-hidden="true" size={12} />
                <span>Refresh &amp; Rebase</span>
              </Button>
              {conflictState.pendingAssignmentError ? (
                <Button
                  size="sm"
                  type="button"
                  variant="primary"
                  onClick={() => void onRetryFailedAssignment(ctx)}
                >
                  <span>Retry Assignment</span>
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ),
    },

    /* ── Section 1B: Material Source & Changes from Source Provenance ── */
    {
      id: "material-source",
      title: "Material Source",
      icon: History,
      defaultOpen: true,
      showWhen: (d) =>
        Boolean(
          d.materialId &&
            !d.pendingNewMaterial &&
            (activeSourceSnapshot !== null || activeReferences.length > 0),
        ),
      summary: (d) => {
        if (!activeSourceSnapshot) {
          return `${activeReferences.length} reference(s)`;
        }
        const status = materialSourceStatus(
          resolveMaterialPropertiesFromDraft(d, baseline),
          activeReferences,
          activeSourceSnapshot,
        );
        return status === "modified" ? "Modified in model" : "Unmodified copy";
      },
      rows: [
        {
          type: "readonly",
          label: "Origin",
          showWhen: () => activeSourceSnapshot !== null,
          format: (d) => {
            const status = materialSourceStatus(
              resolveMaterialPropertiesFromDraft(d, baseline),
              activeReferences,
              activeSourceSnapshot,
            );
            return status === "modified" ? "Modified in model" : "Unmodified copy";
          },
        },
        {
          type: "readonly",
          label: "Catalog source",
          showWhen: () => activeSourceSnapshot !== null,
          format: () =>
            activeSourceSnapshot
              ? `${activeSourceSnapshot.name} \u00b7 revision ${activeSourceSnapshot.catalog_revision}`
              : "\u2014",
        },
        {
          type: "readonly",
          label: "Catalog entry",
          showWhen: () => activeSourceSnapshot !== null,
          format: () => {
            if (!activeSourceSnapshot) return "\u2014";
            if (activeSourceSnapshot.kind === "builtin") return "Built-in";
            if (activeSourceSnapshot.kind === "modified") return "Modified variant";
            return "Custom";
          },
        },
        {
          type: "readonly",
          label: "Published version",
          mono: true,
          showWhen: () => Boolean(activeSourceSnapshot?.version),
          format: () =>
            activeSourceSnapshot?.version
              ? `${activeSourceSnapshot.version.family}.${activeSourceSnapshot.version.version}`
              : "\u2014",
        },
        {
          type: "readonly",
          label: "Source project",
          showWhen: () => Boolean(activeSourceSnapshot?.version?.source_project),
          format: () => activeSourceSnapshot?.version?.source_project ?? "\u2014",
        },
        {
          type: "readonly",
          label: "Literature references",
          showWhen: () => activeReferences.length > 0,
          format: () => formatReferencesSummary(activeReferences),
        },
        ...sourceChangeRows,
      ],
    },

    /* ── Section 2: Intrinsic Magnetic & LLG Constants ── */
    {
      id: "material-intrinsic-llg",
      title: "Intrinsic magnetization, exchange & damping",
      icon: Magnet,
      defaultOpen: true,
      showWhen: (d) => d.isMagneticBody,
      summary: (d) =>
        `${d.msSet ? `Ms = ${(d.ms / 1e3).toFixed(0)} kA/m` : "Ms unset"} \u00b7 ${d.aexSet ? `Aex = ${(d.aex * 1e12).toFixed(1)} pJ/m` : "Aex unset"} \u00b7 \u03b1 = ${d.alpha}`,
      rows: [
        {
          key: "msSet",
          type: "switch",
          label: "Specify saturation magnetization (Ms)",
          structural: true,
        },
        {
          key: "ms",
          type: "quantity",
          label: "Saturation magnetization",
          symbol: (
            <>
              M<sub>s</sub>
            </>
          ),
          symbolInfo: {
            name: "Saturation magnetization",
            definition: "Spontaneous magnetic dipole moment per unit volume.",
            siUnit: "A/m",
            typicalRange: "YIG \u2248 140 kA/m, Permalloy \u2248 800 kA/m, Fe \u2248 1.71 MA/m",
          },
          units: MAGNETIZATION_UNITS,
          defaultDisplayUnit: "kA/m",
          min: 0,
          showWhen: (d) => d.msSet,
          validate: (v, d) =>
            d.msSet && v <= 0
              ? "Ms must be positive (> 0 A/m) when specified; turn off Specify Ms to leave unset."
              : null,
        },
        {
          type: "readonly",
          label: "Saturation polarization",
          symbol: (
            <>
              &mu;<sub>0</sub>M<sub>s</sub>
            </>
          ),
          mono: true,
          showWhen: (d) => d.msSet,
          format: (d) =>
            `${(MU0_SI * d.ms).toFixed(4)} T (${(MU0_SI * d.ms * 1e3).toFixed(1)} mT)`,
        },
        {
          key: "aexSet",
          type: "switch",
          label: "Specify exchange stiffness (Aex)",
          structural: true,
        },
        {
          key: "aex",
          type: "quantity",
          label: "Exchange stiffness",
          symbol: (
            <>
              A<sub>ex</sub>
            </>
          ),
          symbolInfo: {
            name: "Heisenberg exchange stiffness",
            definition:
              "Continuum symmetric exchange energy constant penalizing spin gradients.",
            siUnit: "J/m",
            typicalRange: "YIG \u2248 3.7 pJ/m, Permalloy \u2248 13 pJ/m, Co \u2248 30 pJ/m",
          },
          units: EXCHANGE_UNITS,
          defaultDisplayUnit: "pJ/m",
          min: 0,
          showWhen: (d) => d.aexSet,
          validate: (v, d) =>
            d.aexSet && v < 0 ? "Aex must be non-negative." : null,
        },
        {
          type: "readonly",
          label: "Magnetostatic exchange length",
          symbol: (
            <>
              l<sub>ex</sub>
            </>
          ),
          mono: true,
          format: (d) => {
            const lex =
              d.msSet && d.aexSet
                ? computeExchangeLengthMeters(d.ms, d.aex)
                : null;
            return lex !== null
              ? `${(lex * 1e9).toFixed(2)} nm`
              : "Requires Ms > 0 and Aex > 0";
          },
        },
        {
          key: "alpha",
          type: "number",
          label: "Gilbert damping",
          symbol: <>&alpha;</>,
          symbolInfo: {
            name: "Gilbert damping parameter",
            definition:
              "Dimensionless viscous spin-relaxation rate in the Landau-Lifshitz-Gilbert equation.",
            siUnit: "dimensionless",
            typicalRange: "YIG \u2248 10\u207b\u2074, CoFeB \u2248 0.004, Permalloy \u2248 0.008",
          },
          min: 0,
          step: 0.001,
          validate: (v) => (v < 0 ? "Gilbert damping \u03b1 must be non-negative." : null),
        },
        {
          key: "gamma",
          type: "quantity",
          label: "Gyromagnetic ratio",
          symbol: <>&gamma;</>,
          units: GYRO_UNITS,
          defaultDisplayUnit: "GHz/T",
          min: 0,
          minExclusive: true,
          validate: (v) => (v > 0 ? null : "Gyromagnetic ratio \u03b3 must be positive."),
        },
        {
          key: "landeG",
          type: "number",
          label: "Spectroscopic Land\u00e9 factor",
          symbol: <>g</>,
          min: 0.1,
          step: 0.01,
          validate: (v) => (v >= 0.1 ? null : "Land\u00e9 factor g must be at least 0.1."),
        },
      ],
      footer: (ctx) => (
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() =>
            ctx.setField("gamma", ctx.draft.landeG * ELECTRON_GAMMA_PER_G)
          }
        >
          Sync &gamma; from Land&eacute; g (
          {(
            (ctx.draft.landeG * ELECTRON_GAMMA_PER_G) /
            (2 * Math.PI * 1e9)
          ).toFixed(2)}{" "}
          GHz/T)
        </Button>
      ),
    },

    /* ── Section 3: Uniaxial Anisotropy (with P0 Ku2 & Bk Readout!) ── */
    {
      id: "material-uniaxial-anisotropy",
      title: "Uniaxial magnetocrystalline anisotropy",
      icon: Compass,
      defaultOpen: true,
      showWhen: (d) => d.isMagneticBody,
      summary: (d) =>
        d.uniaxialEnabled
          ? `Ku1 = ${(d.ku1 / 1e3).toFixed(1)} kJ/m\u00b3 \u00b7 Ku2 = ${(d.ku2 / 1e3).toFixed(1)} kJ/m\u00b3`
          : "Disabled",
      rows: [
        {
          key: "uniaxialEnabled",
          type: "switch",
          label: "Enable uniaxial anisotropy",
          structural: true,
        },
        {
          key: "ku1",
          type: "quantity",
          label: "First-order uniaxial constant",
          symbol: (
            <>
              K<sub>u1</sub>
            </>
          ),
          symbolInfo: {
            name: "First-order uniaxial anisotropy constant",
            definition:
              "Leading cos\u00b2\u03b8 magnetocrystalline energy density: E_u = -Ku1 (m\u00b7u)\u00b2 - Ku2 (m\u00b7u)\u2074.",
            siUnit: "J/m\u00b3",
          },
          units: ANISOTROPY_UNITS,
          defaultDisplayUnit: "kJ/m\u00b3",
          showWhen: (d) => d.uniaxialEnabled,
        },
        {
          key: "ku2",
          type: "quantity",
          label: "Second-order uniaxial constant",
          symbol: (
            <>
              K<sub>u2</sub>
            </>
          ),
          symbolInfo: {
            name: "Second-order uniaxial anisotropy constant",
            definition:
              "Fourth-order cos\u2074\u03b8 uniaxial term in E_u = -Ku1 (m\u00b7u)\u00b2 - Ku2 (m\u00b7u)\u2074; easy-cone equilibrium requires Ku2 < 0 and 0 < -Ku1/(2\u00b7Ku2) < 1.",
            siUnit: "J/m\u00b3",
            typicalRange: "hcp Co \u2248 150 kJ/m\u00b3",
          },
          units: ANISOTROPY_UNITS,
          defaultDisplayUnit: "kJ/m\u00b3",
          showWhen: (d) => d.uniaxialEnabled,
        },
        {
          key: "uniaxialAxis",
          type: "vector3",
          label: "Uniaxial symmetry axis",
          symbol: <>{"u\u0302"}</>,
          axisPresets: true,
          normalizeAction: true,
          showWhen: (d) => d.uniaxialEnabled,
          validate: (vec) =>
            vectorNorm(vec) < 1e-12 ? "Uniaxial symmetry axis must be non-zero." : null,
        },
        {
          type: "readonly",
          label: "Anisotropy field (Bk = 2\u00b7Ku1/Ms)",
          symbol: (
            <>
              B<sub>k</sub>
            </>
          ),
          mono: true,
          showWhen: (d) => d.uniaxialEnabled,
          format: (d) => formatAnisotropyFieldReadout(d),
        },
        {
          type: "readonly",
          label: "Equilibrium anisotropy regime",
          showWhen: (d) => d.uniaxialEnabled,
          format: (d) => classifyUniaxialAnisotropyRegime(d.ku1, d.ku2).label,
        },
      ],
    },

    /* ── Section 4: Cubic Anisotropy & Chiral DMI ── */
    {
      id: "material-cubic-dmi",
      title: "Cubic anisotropy & chiral DMI",
      icon: Atom,
      defaultOpen: false,
      showWhen: (d) => d.isMagneticBody,
      summary: (d) =>
        `Kc1 = ${(d.kc1 / 1e3).toFixed(1)} kJ/m\u00b3 \u00b7 ${d.dindSet ? `Dind = ${(d.dind * 1e3).toFixed(2)} mJ/m\u00b2` : "Dind unset"}`,
      rows: [
        {
          key: "cubicEnabled",
          type: "switch",
          label: "Enable cubic anisotropy",
          structural: true,
        },
        {
          key: "kc1",
          type: "quantity",
          label: "First-order cubic constant",
          symbol: (
            <>
              K<sub>c1</sub>
            </>
          ),
          units: ANISOTROPY_UNITS,
          defaultDisplayUnit: "kJ/m\u00b3",
          showWhen: (d) => d.cubicEnabled,
        },
        {
          key: "kc2",
          type: "quantity",
          label: "Second-order cubic constant",
          symbol: (
            <>
              K<sub>c2</sub>
            </>
          ),
          units: ANISOTROPY_UNITS,
          defaultDisplayUnit: "kJ/m\u00b3",
          showWhen: (d) => d.cubicEnabled,
        },
        {
          key: "kc3",
          type: "quantity",
          label: "Third-order cubic constant",
          symbol: (
            <>
              K<sub>c3</sub>
            </>
          ),
          units: ANISOTROPY_UNITS,
          defaultDisplayUnit: "kJ/m\u00b3",
          showWhen: (d) => d.cubicEnabled,
        },
        {
          key: "cubicAxis1",
          type: "vector3",
          label: "Crystal axis [100]",
          symbol: (
            <>
              {"c\u0302"}<sub>1</sub>
            </>
          ),
          axisPresets: true,
          normalizeAction: true,
          showWhen: (d) => d.cubicEnabled,
          validate: (vec) =>
            vectorNorm(vec) < 1e-12 ? "Crystal axis c1 must be non-zero." : null,
        },
        {
          key: "cubicAxis2",
          type: "vector3",
          label: "Crystal axis [010]",
          symbol: (
            <>
              {"c\u0302"}<sub>2</sub>
            </>
          ),
          axisPresets: true,
          normalizeAction: true,
          showWhen: (d) => d.cubicEnabled,
          validate: (vec, d) => {
            if (vectorNorm(vec) < 1e-12) return "Crystal axis c2 must be non-zero.";
            const u1 = normalizeVector3(d.cubicAxis1);
            const u2 = normalizeVector3(vec);
            const dot = Math.abs(u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]);
            return dot > 1e-4
              ? "Crystal axes c1 and c2 must be mutually orthogonal (c1 \u00b7 c2 = 0)."
              : null;
          },
        },
        {
          key: "dindSet",
          type: "switch",
          label: "Specify interfacial DMI (Dind)",
          structural: true,
        },
        {
          key: "dind",
          type: "quantity",
          label: "Interfacial DMI constant",
          symbol: (
            <>
              D<sub>ind</sub>
            </>
          ),
          units: DMI_UNITS,
          defaultDisplayUnit: "mJ/m\u00b2",
        },
        {
          key: "dbulkSet",
          type: "switch",
          label: "Specify bulk DMI (Dbulk)",
          structural: true,
        },
        {
          key: "dbulk",
          type: "quantity",
          label: "Bulk DMI constant",
          symbol: (
            <>
              D<sub>bulk</sub>
            </>
          ),
          units: DMI_UNITS,
          defaultDisplayUnit: "mJ/m\u00b2",
        },
        {
          type: "readonly",
          label: "Chiral helical pitch",
          symbol: (
            <>
              L<sub>D</sub>
            </>
          ),
          mono: true,
          showWhen: (d) => Math.abs(d.dind) > 1e-9 || Math.abs(d.dbulk) > 1e-9,
          format: (d) => {
            const dEff = Math.max(Math.abs(d.dind), Math.abs(d.dbulk));
            if (dEff <= 0 || !d.aexSet || d.aex <= 0) return "\u2014";
            const pitchNm = ((4 * Math.PI * d.aex) / dEff) * 1e9;
            return `${pitchNm.toFixed(1)} nm`;
          },
        },
      ],
      footer: (ctx) =>
        ctx.draft.cubicEnabled ? (
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() =>
              ctx.setField(
                "cubicAxis2",
                orthogonalizeAxisGramSchmidt(ctx.draft.cubicAxis1, ctx.draft.cubicAxis2),
              )
            }
          >
            {"Orthogonalize c\u2082 (Gram-Schmidt)"}
          </Button>
        ) : null,
    },

    /* ── Section 5: Electrical, Mechanical & Magnetoelastic ── */
    {
      id: "material-transport-elastic",
      title: "Electrical, mechanical & magnetoelastic",
      icon: Cpu,
      defaultOpen: !baseline.isMagneticBody,
      summary: (d) =>
        `\u03c3 = ${(d.sigma / 1e6).toFixed(2)} MS/m \u00b7 \u03c1 = ${d.density} kg/m\u00b3`,
      rows: [
        {
          key: "sigma",
          type: "quantity",
          label: "Electrical conductivity",
          symbol: <>&sigma;</>,
          units: CONDUCTIVITY_UNITS,
          defaultDisplayUnit: "MS/m",
          min: 0,
          validate: (v) => (v < 0 ? "Conductivity \u03c3 must be non-negative." : null),
        },
        {
          key: "density",
          type: "quantity",
          label: "Mass density",
          symbol: <>&rho;</>,
          units: DENSITY_UNITS,
          defaultDisplayUnit: "kg/m\u00b3",
          min: 0,
          validate: (v) => (v < 0 ? "Mass density \u03c1 must be non-negative." : null),
        },
        {
          key: "magnetoelasticEnabled",
          type: "switch",
          label: "Enable magnetoelastic coupling",
          structural: true,
          showWhen: (d) => d.isMagneticBody,
        },
        {
          key: "b1",
          type: "quantity",
          label: "Longitudinal coupling constant",
          symbol: (
            <>
              B<sub>1</sub>
            </>
          ),
          units: MAGNETOELASTIC_B_UNITS,
          defaultDisplayUnit: "MJ/m\u00b3",
          showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
        },
        {
          key: "b2",
          type: "quantity",
          label: "Shear coupling constant",
          symbol: (
            <>
              B<sub>2</sub>
            </>
          ),
          units: MAGNETOELASTIC_B_UNITS,
          defaultDisplayUnit: "MJ/m\u00b3",
          showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
        },
        {
          key: "c11",
          type: "quantity",
          label: "Cubic stiffness C11",
          symbol: (
            <>
              C<sub>11</sub>
            </>
          ),
          units: ELASTIC_MODULUS_UNITS,
          defaultDisplayUnit: "GPa",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
          validate: (v, d) => validateBornCubicStability(v, d.c12, d.c44),
        },
        {
          key: "c12",
          type: "quantity",
          label: "Cubic stiffness C12",
          symbol: (
            <>
              C<sub>12</sub>
            </>
          ),
          units: ELASTIC_MODULUS_UNITS,
          defaultDisplayUnit: "GPa",
          showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
          validate: (v, d) => validateBornCubicStability(d.c11, v, d.c44),
        },
        {
          key: "c44",
          type: "quantity",
          label: "Shear stiffness C44",
          symbol: (
            <>
              C<sub>44</sub>
            </>
          ),
          units: ELASTIC_MODULUS_UNITS,
          defaultDisplayUnit: "GPa",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
          validate: (v, d) => validateBornCubicStability(d.c11, d.c12, v),
        },
      ],
      footer: (ctx) =>
        ctx.draft.sharedWithObjects.length > 1 && ctx.draft.materialId ? (
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => void onDuplicateAndUnlink(ctx)}
          >
            <CopyPlus aria-hidden="true" size={12} />
            <span>Duplicate &amp; Unlink Shared Material</span>
          </Button>
        ) : null,
    },
  ];
}
