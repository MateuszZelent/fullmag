"use client";

import { Plus, Trash2 } from "lucide-react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";
import { useEditableRowKeys } from "@/shared/utils/useEditableRowKeys";

import {
  appendBoundarySurfaceRow,
  appendTransportCollectionRow,
  changeTransportBoundaryKind,
  chargeBoundaryKinds,
  chargeMaterialFields,
  encodeTransportScopeOption,
  parseTransportScopeOption,
  removeBoundarySurfaceRow,
  removeTransportCollectionRow,
  spinBoundaryKinds,
  spinMaterialFields,
  transportRows,
  transportScopeOptions,
  updateBoundarySurfaceField,
  updateTransportRow,
  updateTransportScopeRow,
  type CollectionRow,
} from "../TransportCollectionFieldsModel";
import { EMPTY_SELECT_SENTINEL } from "./transportShared";

const UNSET_SCOPE_OPTION = '["",""]';

const BOUNDARY_KIND_LABELS: Record<string, string> = {
  equipotential_current_terminal: "Equipotential current terminal",
  voltage_electrode: "Voltage electrode (fixed V)",
  normal_current_electrode: "Normal current electrode (fixed J_n)",
  insulating: "Insulating (J · n̂ = 0)",
  spin_insulating: "Spin-insulating (j_s · n̂ = 0)",
  homogeneous_spin_potential_gradient: "Homogeneous spin potential gradient",
  spin_sink: "Ideal spin sink (μ_s = 0)",
  specified_spin_potential: "Specified spin potential μ_s",
  specified_spin_flux: "Specified normal spin flux j_s",
  periodic_spin: "Periodic spin pair (minus ↔ plus)",
};

function asRowRecord(value: unknown): CollectionRow {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CollectionRow)
    : {};
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function rowIdentity(
  collection: "domain" | "materials" | "boundaries",
  row: CollectionRow,
): string {
  if (collection === "boundaries") return JSON.stringify([collection, row.id]);
  const scope = collection === "materials" ? asRowRecord(row.region) : row;
  return JSON.stringify([collection, scope.object_id, scope.region_id]);
}

export interface TransportCollectionEditorProps {
  family: "current_transport" | "spin_transport";
  collection: "domain" | "materials" | "boundaries";
  value: string;
  scene: SceneResource | null;
  spinMode?: "steady" | "transient";
  disabled?: boolean;
  onChange: (nextJson: string) => void;
}

export function TransportCollectionEditor(props: TransportCollectionEditorProps) {
  let rows: CollectionRow[];
  try {
    rows = transportRows(props.value);
  } catch (error) {
    return (
      <div
        className="rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5 text-xs text-[var(--fm-danger)]"
        role="alert"
      >
        {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }
  return <TransportCollectionRows {...props} rows={rows} />;
}

function TransportCollectionRows({
  family,
  collection,
  value,
  scene,
  spinMode,
  disabled = false,
  onChange,
  rows,
}: TransportCollectionEditorProps & { rows: CollectionRow[] }) {
  const rowKeys = useEditableRowKeys(rows.map((row) => rowIdentity(collection, row)));
  const scopes = transportScopeOptions(scene);
  const sceneObjects = (scene?.objects ?? []).filter(
    (obj) => obj.role !== "airbox" && obj.role !== "air",
  );

  const defaultScope = scopes[0]
    ? { objectId: scopes[0].objectId, regionId: scopes[0].regionId || undefined }
    : undefined;

  const updateRowField = (
    index: number,
    path: readonly string[],
    text: string,
    kind: "text" | "number" | "vector" | "reaction" = "text",
  ) => {
    const next = updateTransportRow(value, index, path, text, kind);
    if (collection === "boundaries" && path.length === 1 && path[0] === "id") {
      rowKeys.rename(index, rowIdentity(collection, transportRows(next)[index]!));
    }
    onChange(next);
  };

  const renderScopeSelect = (
    index: number,
    ref: CollectionRow,
    path: readonly string[],
    label: string,
  ) => {
    const objId = typeof ref.object_id === "string" ? ref.object_id : "";
    const regId = typeof ref.region_id === "string" ? ref.region_id : "";
    const currentEncoded = objId
      ? encodeTransportScopeOption(objId, regId)
      : UNSET_SCOPE_OPTION;
    const isMissingFromScene =
      Boolean(objId) &&
      !scopes.some((s) => s.objectId === objId && s.regionId === regId);

    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[var(--fm-text-muted)]">{label}</span>
        <Select
          disabled={disabled}
          value={currentEncoded}
          onValueChange={(nextVal) => {
            const parsed = parseTransportScopeOption(nextVal);
            if (!parsed) return;
            const [nextObj, nextReg] = parsed;
            const nextJson = updateTransportScopeRow(value, index, path, nextObj, nextReg);
            rowKeys.rename(index, rowIdentity(collection, transportRows(nextJson)[index]!));
            onChange(nextJson);
          }}
        >
          <SelectTrigger aria-label={`${label} ${index + 1}`}>
            <SelectValue placeholder="Select authored object or region" />
          </SelectTrigger>
          <SelectContent align="start" position="popper">
            <SelectGroup>
              <SelectItem value={UNSET_SCOPE_OPTION}>
                Select authored object or region
              </SelectItem>
              {isMissingFromScene ? (
                <SelectItem value={currentEncoded}>
                  {regId ? `${objId} / ${regId} (not in scene)` : `${objId} (not in scene)`}
                </SelectItem>
              ) : null}
              {scopes.map((scope) => (
                <SelectItem
                  key={`${scope.objectId}:${scope.regionId}`}
                  value={encodeTransportScopeOption(scope.objectId, scope.regionId)}
                >
                  {scope.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    );
  };

  const renderSurfaceEditor = ({
    reactKey,
    surfaceRecord,
    label,
    onEditObject,
    onEditSurfaceId,
    onEditOrientation,
    onRemove,
  }: {
    reactKey?: string;
    surfaceRecord: CollectionRow;
    label: string;
    onEditObject: (objId: string) => void;
    onEditSurfaceId: (surfaceId: string) => void;
    onEditOrientation: (orientation: string) => void;
    onRemove?: () => void;
  }) => {
    const surfObjId =
      typeof surfaceRecord.object_id === "string" ? surfaceRecord.object_id : "";
    const objectMissing =
      Boolean(surfObjId) && !sceneObjects.some((o) => o.id === surfObjId);
    return (
      <div
        key={reactKey}
        className="flex flex-col gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-1)] p-2"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-[var(--fm-text)]">{label}</span>
          {onRemove ? (
            <Button
              aria-label={`Remove ${label}`}
              disabled={disabled}
              size="sm"
              type="button"
              variant="ghost"
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" size={12} />
              <span>Remove surface</span>
            </Button>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">{label} object</span>
            <Select
              disabled={disabled}
              value={surfObjId || EMPTY_SELECT_SENTINEL}
              onValueChange={(nextVal) =>
                onEditObject(nextVal === EMPTY_SELECT_SENTINEL ? "" : nextVal)
              }
            >
              <SelectTrigger aria-label={`${label} object`}>
                <SelectValue placeholder="Select object" />
              </SelectTrigger>
              <SelectContent align="start" position="popper">
                <SelectGroup>
                  <SelectItem value={EMPTY_SELECT_SENTINEL}>Select object</SelectItem>
                  {objectMissing ? (
                    <SelectItem value={surfObjId}>
                      {surfObjId} (not in scene)
                    </SelectItem>
                  ) : null}
                  {sceneObjects.map((object) => (
                    <SelectItem key={object.id} value={object.id}>
                      {object.name || object.id}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">{label} surface ID</span>
            <Input
              aria-label={`${label} surface ID`}
              className="font-mono"
              disabled={disabled}
              placeholder="e.g. x_min, x+, signal_in"
              type="text"
              value={formatCellValue(surfaceRecord.surface_id)}
              onChange={(e) => onEditSurfaceId(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">
              {label} outward orientation (nx, ny, nz)
            </span>
            <Input
              aria-label={`${label} outward orientation`}
              className="font-mono"
              disabled={disabled}
              placeholder="-1, 0, 0"
              type="text"
              value={formatCellValue(surfaceRecord.orientation)}
              onChange={(e) => onEditOrientation(e.target.value)}
            />
          </div>
        </div>
      </div>
    );
  };

  const addButtonLabel =
    collection === "domain"
      ? "Add domain scope"
      : collection === "materials"
        ? "Add material assignment"
        : "Add boundary condition";

  return (
    <div
      className="flex flex-col gap-2.5"
      data-slot={`transport-collection-${family}-${collection}`}
    >
      {rows.length === 0 ? (
        <p className="text-xs text-[var(--fm-text-muted)]">
          No explicit {collection} rows configured.
        </p>
      ) : null}

      {rows.map((row, index) => {
        const materialRec = asRowRecord(row.material);
        const boundaryKind = typeof row.kind === "string" ? row.kind : "";
        const boundaryKindsList =
          family === "spin_transport" ? spinBoundaryKinds : chargeBoundaryKinds;

        return (
          <div
            key={rowKeys.keys[index] ?? `${collection}-${index}`}
            className="flex flex-col gap-2.5 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5"
            data-slot={`transport-${collection}-row`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-[var(--fm-text)]">
                {collection === "domain"
                  ? `Domain scope ${index + 1}`
                  : collection === "materials"
                    ? `Material assignment ${index + 1}`
                    : `Boundary ${index + 1}${typeof row.id === "string" && row.id ? ` (${row.id})` : ""}`}
              </span>
              <Button
                aria-label={`Remove ${collection} row ${index + 1}`}
                disabled={disabled}
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => {
                  rowKeys.remove(index);
                  onChange(removeTransportCollectionRow(value, index));
                }}
              >
                <Trash2 aria-hidden="true" size={12} />
                <span>Remove</span>
              </Button>
            </div>

            {collection === "domain"
              ? renderScopeSelect(index, row, [], "Domain scope")
              : null}

            {collection === "materials" ? (
              <div className="flex flex-col gap-2">
                {renderScopeSelect(index, asRowRecord(row.region), ["region"], "Material scope")}
                {(family === "spin_transport"
                  ? spinMaterialFields
                  : chargeMaterialFields
                ).map(([fieldKey, fieldLabel, unit]) => {
                  const isReactionField =
                    fieldKey === "lambda_j_m" || fieldKey === "lambda_phi_m";
                  const isTransientField =
                    fieldKey === "spin_capacitance_As_per_V_m3" ||
                    fieldKey === "density_of_states_per_spin_Jinv_m3" ||
                    fieldKey === "capacitance_formula_version";
                  const rawFieldValue = materialRec[fieldKey];
                  const isDisabledReaction =
                    isReactionField && rawFieldValue === "disabled";

                  if (
                    isTransientField &&
                    spinMode === "steady" &&
                    (rawFieldValue === undefined || rawFieldValue === null || rawFieldValue === "")
                  ) {
                    return null;
                  }

                  return (
                    <div key={fieldKey} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-[var(--fm-text-muted)]">
                          {fieldLabel}
                          {unit ? ` (${unit})` : ""}
                        </span>
                        {isReactionField ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-[var(--fm-text-muted)]">
                              {isDisabledReaction ? "Disabled (HM)" : "Active"}
                            </span>
                            <Switch
                              aria-label={`Enable ${fieldLabel} ${index + 1}`}
                              checked={!isDisabledReaction}
                              disabled={disabled}
                              onCheckedChange={(checked) => {
                                updateRowField(
                                  index,
                                  ["material", fieldKey],
                                  checked ? "1.5e-9" : "disabled",
                                  "reaction",
                                );
                              }}
                            />
                          </div>
                        ) : null}
                        {fieldKey === "capacitance_formula_version" &&
                        !formatCellValue(rawFieldValue) ? (
                          <Button
                            disabled={disabled}
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              updateRowField(
                                index,
                                ["material", fieldKey],
                                "dos_isotropic_nonmagnetic.fullmag.v1",
                                "text",
                              )
                            }
                          >
                            Set canonical DOS v1
                          </Button>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          aria-label={`${fieldLabel} ${index + 1}`}
                          className="font-mono"
                          disabled={disabled}
                          placeholder={
                            isReactionField
                              ? "e.g. 1.2e-9 or disabled"
                              : fieldKey === "capacitance_formula_version"
                                ? "dos_isotropic_nonmagnetic.fullmag.v1"
                                : "SI scalar"
                          }
                          type="text"
                          value={formatCellValue(rawFieldValue)}
                          onChange={(e) =>
                            updateRowField(
                              index,
                              ["material", fieldKey],
                              e.target.value,
                              fieldKey === "capacitance_formula_version"
                                ? "text"
                                : isReactionField
                                  ? "reaction"
                                  : "number",
                            )
                          }
                        />
                        {unit ? <Badge variant="secondary">{unit}</Badge> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {collection === "boundaries" ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-[var(--fm-text-muted)]">Boundary ID</span>
                  <Input
                    aria-label={`Boundary ID ${index + 1}`}
                    className="font-mono"
                    disabled={disabled}
                    placeholder="e.g. left_contact, spin_sink_top"
                    type="text"
                    value={formatCellValue(row.id)}
                    onChange={(e) => updateRowField(index, ["id"], e.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-[var(--fm-text-muted)]">Boundary kind</span>
                  <Select
                    disabled={disabled}
                    value={boundaryKind || EMPTY_SELECT_SENTINEL}
                    onValueChange={(nextKind) => {
                      if (nextKind === EMPTY_SELECT_SENTINEL) return;
                      onChange(changeTransportBoundaryKind(value, index, nextKind));
                    }}
                  >
                    <SelectTrigger aria-label={`Boundary kind ${index + 1}`}>
                      <SelectValue placeholder="Select explicit boundary kind" />
                    </SelectTrigger>
                    <SelectContent align="start" position="popper">
                      <SelectGroup>
                        <SelectItem value={EMPTY_SELECT_SENTINEL}>
                          Select explicit boundary kind
                        </SelectItem>
                        {boundaryKindsList.map((k) => (
                          <SelectItem key={k} value={k}>
                            {BOUNDARY_KIND_LABELS[k] ?? k}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {boundaryKind === "voltage_electrode" ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-[var(--fm-text-muted)]">
                      Electrode potential (V)
                    </span>
                    <Input
                      aria-label={`Electrode potential ${index + 1}`}
                      className="font-mono"
                      disabled={disabled}
                      placeholder="0.1"
                      type="text"
                      value={formatCellValue(row.potential_V)}
                      onChange={(e) =>
                        updateRowField(index, ["potential_V"], e.target.value, "number")
                      }
                    />
                  </div>
                ) : null}

                {boundaryKind === "normal_current_electrode" ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-[var(--fm-text-muted)]">
                      Outward current density (A/m²)
                    </span>
                    <Input
                      aria-label={`Outward current density ${index + 1}`}
                      className="font-mono"
                      disabled={disabled}
                      placeholder="1e11"
                      type="text"
                      value={formatCellValue(row.outward_current_density_Apm2)}
                      onChange={(e) =>
                        updateRowField(
                          index,
                          ["outward_current_density_Apm2"],
                          e.target.value,
                          "number",
                        )
                      }
                    />
                  </div>
                ) : null}

                {boundaryKind === "specified_spin_potential" ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-[var(--fm-text-muted)]">
                      Spin potential vector μ_s (V: x, y, z)
                    </span>
                    <Input
                      aria-label={`Spin potential vector ${index + 1}`}
                      className="font-mono"
                      disabled={disabled}
                      placeholder="0, 1e-4, 0"
                      type="text"
                      value={formatCellValue(row.spin_potential_V)}
                      onChange={(e) =>
                        updateRowField(index, ["spin_potential_V"], e.target.value, "vector")
                      }
                    />
                  </div>
                ) : null}

                {boundaryKind === "specified_spin_flux" ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-[var(--fm-text-muted)]">
                      Normal spin flux vector j_s (A/m²: x, y, z)
                    </span>
                    <Input
                      aria-label={`Normal spin flux vector ${index + 1}`}
                      className="font-mono"
                      disabled={disabled}
                      placeholder="0, 1e10, 0"
                      type="text"
                      value={formatCellValue(row.normal_spin_flux_Apm2)}
                      onChange={(e) =>
                        updateRowField(
                          index,
                          ["normal_spin_flux_Apm2"],
                          e.target.value,
                          "vector",
                        )
                      }
                    />
                  </div>
                ) : null}

                {boundaryKind === "periodic_spin" ? (
                  <div className="flex flex-col gap-2">
                    {renderSurfaceEditor({
                      surfaceRecord: asRowRecord(row.minus_surface),
                      label: `Boundary ${index + 1} minus surface`,
                      onEditObject: (objId) =>
                        updateRowField(index, ["minus_surface", "object_id"], objId),
                      onEditSurfaceId: (surfId) =>
                        updateRowField(index, ["minus_surface", "surface_id"], surfId),
                      onEditOrientation: (orient) =>
                        updateRowField(
                          index,
                          ["minus_surface", "orientation"],
                          orient,
                          "vector",
                        ),
                    })}
                    {renderSurfaceEditor({
                      surfaceRecord: asRowRecord(row.plus_surface),
                      label: `Boundary ${index + 1} plus surface`,
                      onEditObject: (objId) =>
                        updateRowField(index, ["plus_surface", "object_id"], objId),
                      onEditSurfaceId: (surfId) =>
                        updateRowField(index, ["plus_surface", "surface_id"], surfId),
                      onEditOrientation: (orient) =>
                        updateRowField(
                          index,
                          ["plus_surface", "orientation"],
                          orient,
                          "vector",
                        ),
                    })}
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-[var(--fm-text-muted)]">
                        Periodic translation vector (m: dx, dy, dz)
                      </span>
                      <Input
                        aria-label={`Periodic translation ${index + 1}`}
                        className="font-mono"
                        disabled={disabled}
                        placeholder="1e-6, 0, 0"
                        type="text"
                        value={formatCellValue(row.translation_m)}
                        onChange={(e) =>
                          updateRowField(index, ["translation_m"], e.target.value, "vector")
                        }
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {(Array.isArray(row.surfaces) ? row.surfaces : []).map(
                      (surfaceEntry, surfaceIdx) =>
                        renderSurfaceEditor({
                          reactKey: `surf-${index}-${surfaceIdx}`,
                          surfaceRecord: asRowRecord(surfaceEntry),
                          label: `Boundary ${index + 1} surface ${surfaceIdx + 1}`,
                          onEditObject: (objId) =>
                            onChange(
                              updateBoundarySurfaceField(
                                value,
                                index,
                                surfaceIdx,
                                "object_id",
                                objId,
                              ),
                            ),
                          onEditSurfaceId: (surfId) =>
                            onChange(
                              updateBoundarySurfaceField(
                                value,
                                index,
                                surfaceIdx,
                                "surface_id",
                                surfId,
                              ),
                            ),
                          onEditOrientation: (orient) =>
                            onChange(
                              updateBoundarySurfaceField(
                                value,
                                index,
                                surfaceIdx,
                                "orientation",
                                orient,
                              ),
                            ),
                          onRemove: () =>
                            onChange(removeBoundarySurfaceRow(value, index, surfaceIdx)),
                        }),
                    )}
                    <Button
                      disabled={disabled}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        onChange(
                          appendBoundarySurfaceRow(
                            value,
                            index,
                            sceneObjects[0]?.id ?? "",
                          ),
                        )
                      }
                    >
                      <Plus aria-hidden="true" size={12} />
                      <span>Add explicit surface</span>
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}

      <Button
        disabled={disabled}
        size="sm"
        type="button"
        variant="secondary"
        onClick={() => {
          const nextJson = appendTransportCollectionRow(
            value,
            family,
            collection,
            defaultScope,
          );
          const nextRows = transportRows(nextJson);
          rowKeys.append(rowIdentity(collection, nextRows[nextRows.length - 1]!));
          onChange(nextJson);
        }}
      >
        <Plus aria-hidden="true" size={12} />
        <span>{addButtonLabel}</span>
      </Button>
    </div>
  );
}
