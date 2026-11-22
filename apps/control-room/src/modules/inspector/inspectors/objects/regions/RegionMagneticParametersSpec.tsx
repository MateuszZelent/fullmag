"use client";

import {
  Layers,
  Magnet,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useMemo,
} from "react";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useActiveLaneCapabilities } from "@/kernel/resources/useActiveLaneCapabilities";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorFact, InspectorSpec } from "../../../template";
import {
  buildObjectSelection,
  buildRegionSelection,
  LENGTH_UNITS,
  normalizeVector3,
  SpecInspectorHost,
  vectorNorm,
} from "../../../panels/model-roots/SpecInspectorHost";
import type { MaterialFunctionFieldSummary, SceneRegionConflictPolicy } from "../../../panels/region/ObjectRegionMaterialFieldsModel";
import {
  executeRegionMutationWithHistory,
  extractSelectionTarget,
  finalizeRegionAuthoringCommit,
  parseRegionConstitutiveOverrides,
  parseRegionMaterialTransition,
  parseRegionScalarFieldParam,
  REGION_SCALAR_PARAM_KEYS,
  resolveCanonicalRegionMeshLane,
  resolveOwnerBoundsForSceneObject,
  resolveRegionGeometryDefaults,
  serializeRegionConstitutiveOverrides,
  serializeRegionMaterialTransition,
  serializeRegionScalarFieldParam,
  useModelMaterialFieldsResourceSafe,
  useRegionSessionScopeKey,
  type RegionConstitutiveOverrideDraft,
  type RegionScalarParamKey,
  type SceneMaterialParameterAssignment,
  type SceneMaterialParameterName,
} from "../../../panels/region/regionInspectorHelpers";
import { toJsonValue } from "./regionShared";
import {
  ANISOTROPY_DMI_DESCRIPTORS,
  buildScalarParamRows,
  CONSTITUTIVE_PARAM_OPTIONS,
  EXCHANGE_DAMPING_DESCRIPTORS,
  type RegionMaterialOverridesDraft,
  type ScalarParamDraftFields,
} from "./regionMagneticShared";

export function ObjectRegionMagneticParametersInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const materialFieldsResource = useModelMaterialFieldsResourceSafe();
  const activeLane = useActiveLaneCapabilities();
  const sessionScopeKey = useRegionSessionScopeKey(kernel);
  const { objectId, regionId } = extractSelectionTarget(selection);

  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const ownerBounds = useMemo(
    () => resolveOwnerBoundsForSceneObject(sceneObj),
    [sceneObj],
  );
  const regionObj = useMemo(
    () => sceneObj?.regions?.find((r) => r.region_id === regionId),
    [regionId, sceneObj?.regions],
  );
  const parentMat = useMemo(() => {
    const ref = sceneObj?.material_ref;
    return ref ? scene.data?.materials?.find((m) => m.id === ref) : undefined;
  }, [scene.data?.materials, sceneObj?.material_ref]);

  const activeLaneKind =
    (activeLane as { lane?: string } | null)?.lane ??
    (activeLane?.source?.kind === "planner" ? activeLane.resolved?.discretization : null);
  const meshLaneInfo = useMemo(
    () =>
      resolveCanonicalRegionMeshLane(
        activeLaneKind === "fem" || activeLaneKind === "fdm" ? activeLaneKind : null,
        scene.data,
      ),
    [activeLaneKind, scene.data],
  );
  const femLane = meshLaneInfo.lane === "fem";

  const baseline = useMemo<RegionMaterialOverridesDraft>(() => {
    const props = (parentMat?.properties ?? {}) as Record<string, unknown>;
    const parentMs = typeof props.Ms === "number" ? props.Ms : 8.0e5;
    const parentAex = typeof props.Aex === "number" ? props.Aex : 13e-12;
    const parentAlpha = typeof props.alpha === "number" ? props.alpha : 0.008;
    const parentDind = typeof props.Dind === "number" ? props.Dind : 0;
    const parentDbulk = typeof props.Dbulk === "number" ? props.Dbulk : 0;

    const stack = ((sceneObj as unknown as { physics_stack?: Record<string, unknown>[] })
      ?.physics_stack ?? []);
    const uni = stack.find((s) => s.kind === "uniaxial_anisotropy");
    const uniParams = (uni?.params ?? {}) as Record<string, unknown>;
    const parentKu1 = typeof uniParams.ku1 === "number" ? uniParams.ku1 : 0;
    const parentKu2 = typeof uniParams.ku2 === "number" ? uniParams.ku2 : 0;

    const regionRec = (regionObj ?? null) as Record<string, unknown> | null;
    const defaultPriority =
      typeof regionRec?.priority === "number" && Number.isFinite(regionRec.priority)
        ? Math.trunc(regionRec.priority)
        : 0;
    const geomDefaults = resolveRegionGeometryDefaults(regionRec, ownerBounds);

    const assignments = sceneObj?.material_parameter_fields ?? [];
    const parentValues: Record<RegionScalarParamKey, number> = {
      ms: parentMs,
      aex: parentAex,
      alpha: parentAlpha,
      ku1: parentKu1,
      ku2: parentKu2,
      dind: parentDind,
      dbulk: parentDbulk,
    };

    const rawFunctionMap: Partial<
      Record<RegionScalarParamKey, SceneMaterialParameterAssignment>
    > = {};
    const functionSummaryMap: Partial<
      Record<RegionScalarParamKey, MaterialFunctionFieldSummary>
    > = {};
    const scalarEntries = {} as ScalarParamDraftFields;

    for (const key of REGION_SCALAR_PARAM_KEYS) {
      const parsed = parseRegionScalarFieldParam({
        assignments,
        defaultCenter: geomDefaults.defaultCenter,
        defaultPriority,
        defaultRadius: geomDefaults.defaultRadius,
        defaultSpan: geomDefaults.defaultSpan,
        fallbackValue: parentValues[key],
        paramName: key,
        regionId,
      });
      const writable = scalarEntries as Record<string, unknown>;
      writable[`${key}Mode`] = parsed.mode;
      writable[`${key}Value`] = parsed.value;
      writable[`${key}EndValue`] = parsed.endValue;
      writable[`${key}SpanM`] = parsed.spanM;
      writable[`${key}Direction`] = parsed.direction;
      writable[`${key}RadialCenter`] = parsed.radialCenter;
      writable[`${key}RadialRadius`] = parsed.radialRadius;
      writable[`${key}Frame`] = parsed.frame;
      writable[`${key}Priority`] = parsed.priority;
      writable[`${key}ConflictPolicy`] = parsed.conflictPolicy;
      writable[`${key}AssignmentId`] = parsed.assignmentId;
      if (parsed.rawFunction) {
        rawFunctionMap[key] = parsed.rawFunction;
      }
      if (parsed.functionSummary) {
        functionSummaryMap[key] = parsed.functionSummary;
      }
    }

    const axisField = assignments.find(
      (f) => f.region_id === regionId && f.parameter === "anisotropy_axis",
    );
    const axisFieldVal = (axisField?.value ?? null) as Record<string, unknown> | null;
    const rawAxisVec = Array.isArray(axisFieldVal?.value)
      ? axisFieldVal.value
      : axisFieldVal?.direction;
    const parsedAxis: [number, number, number] =
      Array.isArray(rawAxisVec) && rawAxisVec.length >= 3
        ? [
            Number(rawAxisVec[0]) || 0,
            Number(rawAxisVec[1]) || 0,
            Number(rawAxisVec[2]) || 0,
          ]
        : [0, 0, 1];
    const safeAxis = vectorNorm(parsedAxis) > 1e-12 ? parsedAxis : ([0, 0, 1] as const);

    const handledParams = new Set<string>([
      ...REGION_SCALAR_PARAM_KEYS,
      "anisotropy_axis",
    ]);
    const preservedExtraRegionFields = assignments
      .filter((f) => f.region_id === regionId && !handledParams.has(f.parameter))
      .map((f) => structuredClone(f));

    const regionMaterialOverrides = parseRegionConstitutiveOverrides(
      regionObj?.material_overrides,
      defaultPriority,
    );
    const parsedTransition = parseRegionMaterialTransition(regionObj?.material_transition);

    return {
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      regionId,
      regionName: regionObj?.name?.trim() || regionId || "Region",
      exists: Boolean(regionObj),
      parentMs,
      parentAex,
      parentAlpha,
      parentKu1,
      parentKu2,
      parentDind,
      parentDbulk,
      ...scalarEntries,
      axisOverridden: Boolean(axisField),
      axisAssignmentId:
        axisField?.assignment_id || `field-${regionId}-anisotropy-axis`,
      anisotropyAxis: safeAxis,
      axisPriority:
        typeof axisField?.priority === "number" && Number.isFinite(axisField.priority)
          ? Math.trunc(axisField.priority)
          : defaultPriority,
      axisConflictPolicy:
        axisField?.conflict_policy === "error" ||
        axisField?.conflict_policy === "min_mesh_size_wins"
          ? axisField.conflict_policy
          : "higher_priority_wins",
      regionMaterialOverrides,
      ...parsedTransition,
      rawFunctionMap,
      functionSummaryMap,
      preservedExtraRegionFields,
    };
  }, [objectId, ownerBounds, parentMat?.properties, regionId, regionObj, sceneObj]);

  const countActiveOverrides = useCallback((d: RegionMaterialOverridesDraft): number => {
    let n = d.regionMaterialOverrides.length;
    for (const key of REGION_SCALAR_PARAM_KEYS) {
      if (d[`${key}Mode`] !== "inherited") n += 1;
    }
    if (d.axisOverridden) n += 1;
    return n;
  }, []);

  const resetPatch = useMemo<Partial<RegionMaterialOverridesDraft>>(
    () => ({
      msMode: "inherited",
      aexMode: "inherited",
      alphaMode: "inherited",
      ku1Mode: "inherited",
      ku2Mode: "inherited",
      dindMode: "inherited",
      dbulkMode: "inherited",
      axisOverridden: false,
      regionMaterialOverrides: [],
    }),
    [],
  );

  const spec = useMemo<InspectorSpec<RegionMaterialOverridesDraft>>(
    () => ({
      id: "object.region.magnetic-parameters",
      header: {
        breadcrumbs: [
          {
            id: "object",
            label: baseline.objectName,
            selection: buildObjectSelection(objectId, "object.root", baseline.objectName),
          },
          {
            id: "region",
            label: baseline.regionName,
            selection: buildRegionSelection(
              objectId,
              regionId,
              "object.region",
              baseline.regionName,
            ),
          },
          { id: "material", label: "Material Overrides" },
        ],
        searchable: true,
        extraMenuActions: [
          {
            id: "reset-all-to-object",
            label: "Reset all overrides to Object",
            icon: RotateCcw,
            onSelect: (ctx) => ctx.patchDraft(resetPatch),
          },
        ],
      },
      identity: {
        domain: "material",
        icon: Magnet,
        title: (d) => `${d.regionName} \u00b7 Material`,
        kindLabel: "Regional constitutive overrides",
        entityId: regionId || undefined,
        statePill: (d) => {
          const count = countActiveOverrides(d);
          return count > 0
            ? { tone: "ok", label: `${count} overridden` }
            : { tone: "neutral", label: "Inherited" };
        },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "overrides",
          label: "Active overrides",
          value: `${countActiveOverrides(d)} parameters`,
        },
        {
          id: "parent",
          label: "Base Ms",
          value: `${(d.parentMs / 1e3).toFixed(0)} kA/m`,
        },
        {
          id: "transition",
          label: "Transition",
          value: d.transitionKind.replace(/_/g, " "),
        },
      ],
      sections: [
        {
          id: "region-constitutive-overrides",
          title: "Constitutive region overrides (material_overrides)",
          icon: Magnet,
          defaultOpen: baseline.regionMaterialOverrides.length > 0,
          summary: (d) => `${d.regionMaterialOverrides.length} constitutive`,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const list = ctx.draft.regionMaterialOverrides;
                const updateItem = (
                  rowId: string,
                  updater: (
                    prev: RegionConstitutiveOverrideDraft,
                  ) => RegionConstitutiveOverrideDraft,
                ) => {
                  ctx.setField(
                    "regionMaterialOverrides",
                    list.map((entry) => (entry.rowId === rowId ? updater(entry) : entry)),
                  );
                };
                return (
                  <div
                    className="flex flex-col gap-2"
                    data-slot="region-constitutive-overrides-list"
                  >
                    {list.length === 0 ? (
                      <p className="text-xs text-[var(--fm-text-muted)]">
                        No direct constitutive entries on region.material_overrides. Use Add
                        Override or configure spatial parameter fields below.
                      </p>
                    ) : null}
                    {list.map((entry) => (
                      <div
                        key={entry.rowId}
                        className="flex flex-col gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5 text-xs"
                        data-override-parameter={entry.parameter}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[var(--fm-text)]">
                            Override: {entry.parameter}
                          </span>
                          <Button
                            aria-label={`Remove constitutive override ${entry.parameter}`}
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              ctx.setField(
                                "regionMaterialOverrides",
                                list.filter((it) => it.rowId !== entry.rowId),
                              )
                            }
                          >
                            <Trash2 aria-hidden="true" size={12} />
                          </Button>
                        </div>

                        {entry.preservedOverride ? (
                          <p className="text-xs text-[var(--fm-text-muted)]">
                            Non-constant constitutive override ({entry.preservedOverride.value.kind})
                            preserved verbatim in SceneDocument.
                          </p>
                        ) : (
                          <>
                            <div className="grid grid-cols-2 gap-1.5">
                              <div className="flex flex-col gap-1">
                                <span className="text-[var(--fm-text-muted)]">Parameter</span>
                                <Select
                                  value={entry.parameter}
                                  onValueChange={(nextParam) =>
                                    updateItem(entry.rowId, (prev) => ({
                                      ...prev,
                                      parameter: nextParam as SceneMaterialParameterName,
                                    }))
                                  }
                                >
                                  <SelectTrigger
                                    aria-label={`Constitutive parameter ${entry.rowId}`}
                                    density="compact"
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {CONSTITUTIVE_PARAM_OPTIONS.map((opt) => (
                                      <SelectItem key={opt.value} value={opt.value}>
                                        {opt.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="flex flex-col gap-1">
                                <span className="text-[var(--fm-text-muted)]">Priority</span>
                                <Input
                                  aria-label={`Constitutive priority ${entry.parameter}`}
                                  step={1}
                                  type="number"
                                  value={String(entry.priority)}
                                  onChange={(e) => {
                                    const parsed = Number.parseInt(e.target.value, 10);
                                    if (Number.isFinite(parsed)) {
                                      updateItem(entry.rowId, (prev) => ({
                                        ...prev,
                                        priority: parsed,
                                      }));
                                    }
                                  }}
                                />
                              </div>
                            </div>

                            {entry.parameter === "anisotropy_axis" ? (
                              <div className="flex flex-col gap-1.5">
                                <div className="grid grid-cols-3 gap-1.5">
                                  {(["X", "Y", "Z"] as const).map((axisLabel, axisIdx) => (
                                    <Input
                                      key={axisLabel}
                                      aria-label={`Constitutive axis ${axisLabel}`}
                                      type="number"
                                      value={String(entry.vectorValue[axisIdx])}
                                      onChange={(e) => {
                                        const n = Number(e.target.value);
                                        if (Number.isFinite(n)) {
                                          const nextVec: [number, number, number] = [
                                            ...entry.vectorValue,
                                          ];
                                          nextVec[axisIdx] = n;
                                          updateItem(entry.rowId, (prev) => ({
                                            ...prev,
                                            vectorValue: nextVec,
                                          }));
                                        }
                                      }}
                                    />
                                  ))}
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {(
                                    [
                                      ["+X", [1, 0, 0]],
                                      ["+Y", [0, 1, 0]],
                                      ["+Z", [0, 0, 1]],
                                    ] as const
                                  ).map(([lbl, preset]) => (
                                    <Button
                                      key={lbl}
                                      size="sm"
                                      type="button"
                                      variant="ghost"
                                      onClick={() =>
                                        updateItem(entry.rowId, (prev) => ({
                                          ...prev,
                                          vectorValue: preset,
                                        }))
                                      }
                                    >
                                      {lbl}
                                    </Button>
                                  ))}
                                  <Button
                                    size="sm"
                                    type="button"
                                    variant="ghost"
                                    onClick={() =>
                                      updateItem(entry.rowId, (prev) => ({
                                        ...prev,
                                        vectorValue: normalizeVector3(
                                          prev.vectorValue,
                                          [0, 0, 1],
                                        ),
                                      }))
                                    }
                                  >
                                    Normalize
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <div className="grid grid-cols-2 gap-1.5">
                                <div className="flex flex-col gap-1">
                                  <span className="text-[var(--fm-text-muted)]">SI value</span>
                                  <Input
                                    aria-label={`Constitutive value ${entry.parameter}`}
                                    type="number"
                                    value={String(entry.value)}
                                    onChange={(e) => {
                                      const parsed = Number(e.target.value);
                                      if (Number.isFinite(parsed)) {
                                        updateItem(entry.rowId, (prev) => ({
                                          ...prev,
                                          value: parsed,
                                        }));
                                      }
                                    }}
                                  />
                                </div>
                                <div className="flex flex-col gap-1">
                                  <span className="text-[var(--fm-text-muted)]">
                                    Conflict policy
                                  </span>
                                  <Select
                                    value={entry.conflictPolicy}
                                    onValueChange={(nextPol) =>
                                      updateItem(entry.rowId, (prev) => ({
                                        ...prev,
                                        conflictPolicy: nextPol as SceneRegionConflictPolicy,
                                      }))
                                    }
                                  >
                                    <SelectTrigger
                                      aria-label={`Constitutive conflict policy ${entry.parameter}`}
                                      density="compact"
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="higher_priority_wins">
                                        Higher priority wins
                                      </SelectItem>
                                      <SelectItem value="error">Report conflict error</SelectItem>
                                      {femLane ? (
                                        <SelectItem value="min_mesh_size_wins">
                                          Finest mesh wins
                                        </SelectItem>
                                      ) : null}
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                    <div>
                      <Button
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          ctx.setField("regionMaterialOverrides", [
                            ...list,
                            {
                              rowId: `ovr-new-${Date.now().toString(36)}-${list.length}`,
                              parameter: "ms",
                              value: ctx.draft.parentMs,
                              vectorValue: [0, 0, 1],
                              unit: "A/m",
                              priority: 0,
                              conflictPolicy: "higher_priority_wins",
                            },
                          ])
                        }
                      >
                        <Plus aria-hidden="true" size={12} />
                        <span>Add Constitutive Override</span>
                      </Button>
                    </div>
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "region-mat-exchange-damping",
          title: "Magnetization, exchange & damping overrides",
          icon: Magnet,
          defaultOpen: true,
          rows: EXCHANGE_DAMPING_DESCRIPTORS.flatMap((desc) =>
            buildScalarParamRows(desc, baseline, femLane, materialFieldsResource.data),
          ),
          footer: (ctx) =>
            countActiveOverrides(ctx.draft) > 0 ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => ctx.patchDraft(resetPatch)}
              >
                <RotateCcw aria-hidden="true" size={12} />
                <span>Reset to Inherited</span>
              </Button>
            ) : null,
        },
        {
          id: "region-mat-anisotropy-dmi",
          title: "Anisotropy (Ku1, Ku2) & DMI overrides",
          icon: Layers,
          defaultOpen: true,
          rows: [
            ...ANISOTROPY_DMI_DESCRIPTORS.slice(0, 2).flatMap((desc) =>
              buildScalarParamRows(desc, baseline, femLane, materialFieldsResource.data),
            ),
            {
              key: "axisOverridden",
              type: "switch",
              label: "Override uniaxial axis in region",
              structural: true,
            },
            {
              key: "anisotropyAxis",
              type: "vector3",
              label: "Regional uniaxial axis",
              symbol: <>{"u\u0302"}</>,
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.axisOverridden,
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Uniaxial axis must be non-zero." : null,
            },
            {
              key: "axisPriority",
              type: "number",
              label: "Uniaxial axis priority",
              integer: true,
              step: 1,
              showWhen: (d) => d.axisOverridden,
            },
            {
              key: "axisConflictPolicy",
              type: "select",
              label: "Uniaxial axis conflict policy",
              options: [
                { value: "higher_priority_wins", label: "Higher priority wins" },
                { value: "error", label: "Report conflict error" },
                ...(femLane
                  ? [{ value: "min_mesh_size_wins", label: "Finest mesh wins" }]
                  : []),
              ],
              showWhen: (d) => d.axisOverridden,
            },
            ...ANISOTROPY_DMI_DESCRIPTORS.slice(2).flatMap((desc) =>
              buildScalarParamRows(desc, baseline, femLane, materialFieldsResource.data),
            ),
          ],
        },
        {
          id: "region-mat-boundary-transition",
          title: "Boundary transition (material_transition)",
          icon: Layers,
          defaultOpen: true,
          rows: [
            {
              key: "transitionKind",
              type: "segmented",
              label: "Boundary transition",
              structural: true,
              options: [
                { value: "sharp", label: "Sharp" },
                { value: "metric", label: "Metric width" },
                { value: "mesh_relative", label: "Mesh-relative" },
              ],
            },
            {
              key: "transitionWidth",
              type: "quantity",
              label: "Transition width",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.transitionKind === "metric",
            },
            {
              key: "transitionCells",
              type: "number",
              label: "Transition cells",
              integer: true,
              min: 1,
              step: 1,
              showWhen: (d) => d.transitionKind === "mesh_relative",
              validate: (v) =>
                Number.isInteger(v) && v >= 1
                  ? null
                  : "Transition cells must be an integer >= 1.",
            },
            {
              key: "transitionScope",
              type: "segmented",
              label: "Transition scope",
              options: [
                { value: "boundary", label: "Boundary" },
                { value: "inside", label: "Inside" },
                { value: "outside", label: "Outside" },
              ],
              showWhen: (d) =>
                d.transitionKind === "metric" || d.transitionKind === "mesh_relative",
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Regional material assignments match SceneDocument",
        lockReason: (d) => (!d.exists ? "Select an existing authored region." : null),
        onApply: async (draft, base) => {
          const nextRegionFields: SceneMaterialParameterAssignment[] = [
            ...draft.preservedExtraRegionFields.map((f) => structuredClone(f)),
          ];

          for (const key of REGION_SCALAR_PARAM_KEYS) {
            const built = serializeRegionScalarFieldParam({
              assignmentId: draft[`${key}AssignmentId`],
              conflictPolicy: draft[`${key}ConflictPolicy`],
              direction: draft[`${key}Direction`],
              endValue: draft[`${key}EndValue`],
              femLane,
              frame: draft[`${key}Frame`],
              mode: draft[`${key}Mode`],
              objectId,
              paramName: key,
              priority: draft[`${key}Priority`],
              radialCenter: draft[`${key}RadialCenter`],
              radialRadius: draft[`${key}RadialRadius`],
              rawFunction: draft.rawFunctionMap[key] ?? null,
              regionId,
              spanM: draft[`${key}SpanM`],
              value: draft[`${key}Value`],
            });
            if (built) {
              nextRegionFields.push(built);
            }
          }

          if (draft.axisOverridden) {
            const resolvedAxisConflict =
              !femLane && draft.axisConflictPolicy === "min_mesh_size_wins"
                ? undefined
                : draft.axisConflictPolicy;
            nextRegionFields.push({
              assignment_id: draft.axisAssignmentId || `field-${regionId}-anisotropy-axis`,
              owner_object: objectId,
              region_id: regionId,
              parameter: "anisotropy_axis",
              priority: Math.trunc(draft.axisPriority),
              ...(resolvedAxisConflict ? { conflict_policy: resolvedAxisConflict } : {}),
              value: {
                kind: "constant",
                unit: null,
                value: normalizeVector3(draft.anisotropyAxis, [0, 0, 1]),
              },
            });
          }

          const nextConstitutive = serializeRegionConstitutiveOverrides(
            draft.regionMaterialOverrides,
            femLane,
          );
          const baseConstitutive = serializeRegionConstitutiveOverrides(
            base.regionMaterialOverrides,
            femLane,
          );
          const constitutiveChanged =
            JSON.stringify(nextConstitutive) !== JSON.stringify(baseConstitutive);
          const transitionChanged =
            draft.transitionKind !== base.transitionKind ||
            draft.transitionWidth !== base.transitionWidth ||
            draft.transitionCells !== base.transitionCells ||
            draft.transitionScope !== base.transitionScope;

          const currentRegionFields = (sceneObj?.material_parameter_fields ?? []).filter(
            (f) => f.region_id === regionId,
          );
          const fieldsChanged =
            JSON.stringify(nextRegionFields) !== JSON.stringify(currentRegionFields) ||
            (!constitutiveChanged && !transitionChanged);

          const nextTransitionValue =
            draft.transitionKind === "sharp" && !draft.hadAuthoredTransition
              ? { kind: "sharp" as const }
              : serializeRegionMaterialTransition(draft);

          const outcome = await executeRegionMutationWithHistory({
            kernel,
            label: `Update regional magnetic parameters on ${draft.regionName}`,
            sceneData: scene.data,
            sessionScopeKey,
            sourceDetail: "object-region-magnetic-parameters-apply",
            mutation: async (prep, writeOpts) => {
              const baseScene = prep.before ?? scene.data;
              const nextObjects = (baseScene?.objects ?? []).map((obj) => {
                if (obj.id !== objectId) return obj;
                const preservedOtherFields = (obj.material_parameter_fields ?? []).filter(
                  (f) => f.region_id !== regionId,
                );
                return {
                  ...obj,
                  ...(constitutiveChanged || transitionChanged
                    ? {
                        regions: (obj.regions ?? []).map((reg) =>
                          reg.region_id === regionId
                            ? {
                                ...reg,
                                ...(constitutiveChanged
                                  ? { material_overrides: nextConstitutive }
                                  : {}),
                                ...(transitionChanged
                                  ? { material_transition: nextTransitionValue }
                                  : {}),
                              }
                            : reg,
                        ),
                      }
                    : {}),
                  ...(fieldsChanged
                    ? {
                        material_parameter_fields: [
                          ...preservedOtherFields,
                          ...nextRegionFields,
                        ],
                      }
                    : {}),
                };
              });

              return kernel.api.model.commitTransaction(
                {
                  base_revision:
                    writeOpts?.baseRevision ??
                    prep.baseRevision ??
                    scene.data?.revision ??
                    null,
                  kind: "merge_patch",
                  merge_patch: {
                    objects: toJsonValue(nextObjects),
                  },
                },
                writeOpts?.sessionScopeKey
                  ? { sessionScopeKey: writeOpts.sessionScopeKey }
                  : undefined,
              );
            },
          });

          await finalizeRegionAuthoringCommit({
            committedScene: outcome.committed_scene,
            fallbackRev: scene.data?.revision,
            kernel,
            sceneRevision: outcome.scene_revision,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      baseline,
      countActiveOverrides,
      femLane,
      kernel,
      materialFieldsResource.data,
      objectId,
      regionId,
      resetPatch,
      scene.data,
      sceneObj?.material_parameter_fields,
      sessionScopeKey,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
