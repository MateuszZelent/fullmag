"use client";

import {
  Link2,
  Plus,
  Radio,
  Trash2,
  Waves,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  MODEL_COUPLINGS_PATH,
  MODEL_FIELD_DRIVES_PATH,
  MODEL_MASK_FIELD_DRIVES_PATH,
} from "@/kernel/api/apiPaths";
import type { MaskFieldDriveResource, RegionalFieldDriveResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource } from "@/kernel/resources/fieldDriveResources";
import {
  publishCommittedSceneResource,
  useModelCouplingsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useMaskFieldDrivesResource } from "@/kernel/resources/maskAntennaResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/AlertDialog";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorFact, InspectorSpec } from "../../template";
import { buildRootSelection, SpecInspectorHost } from "../../panels/model-roots/SpecInspectorHost";
import {
  isAirboxSceneObject,
  type SceneCoupling,
  type SceneCouplingPatch,
  extractFieldDriveItems,
} from "./modelScopeShared";

/* ── 7. PhysicsCouplingsInspectorPanel (`physics.couplings`) ── */

interface CouplingListRow {
  id: string;
  name: string;
  kindLabel: string;
  endpointsLabel: string;
  strengthLabel: string;
  enabled: boolean;
}

interface CouplingsRootDraft {
  rows: readonly CouplingListRow[];
}

export function PhysicsCouplingsInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const couplingsResource = useModelCouplingsResource();
  const [pendingDelete, setPendingDelete] = useState<CouplingListRow | null>(null);

  const rows = useMemo<readonly CouplingListRow[]>(() => {
    const rawList =
      (couplingsResource.data as { couplings?: unknown[]; items?: unknown[] } | null)?.couplings ??
      (couplingsResource.data as { items?: unknown[] } | null)?.items ??
      scene.data?.couplings ??
      [];
    return rawList.map((entry) => {
      const rec = entry as Record<string, unknown>;
      const id = String(rec.coupling_id ?? rec.id ?? "");
      const kind = String(rec.coupling_kind ?? rec.kind ?? "rkky");
      const epA = (rec.source ?? rec.endpoint_a ?? rec.side_a ?? null) as Record<
        string,
        unknown
      > | null;
      const epB = (rec.target ?? rec.endpoint_b ?? rec.side_b ?? null) as Record<
        string,
        unknown
      > | null;
      const aObj = String(epA?.object ?? epA?.object_id ?? epA?.region_id ?? "A");
      const bObj = String(epB?.object ?? epB?.object_id ?? epB?.region_id ?? "B");
      const params = (rec.parameters ?? rec.params ?? rec) as Record<string, unknown>;
      const j1 =
        typeof params.j1 === "number"
          ? params.j1
          : typeof params.j_rkky === "number"
            ? params.j_rkky
            : typeof params.sigma === "number"
              ? params.sigma
              : null;
      const strengthLabel =
        j1 !== null && Number.isFinite(j1)
          ? `${Number((j1 * 1e3).toPrecision(3))} mJ/m\u00b2`
          : kind;
      return {
        id,
        name: String(rec.name ?? id),
        kindLabel:
          kind === "interlayer_exchange"
            ? "Interlayer (J1+J2)"
            : kind === "exchange"
              ? "Direct Exchange"
              : "RKKY",
        endpointsLabel: `${aObj} \u2194 ${bObj}`,
        strengthLabel,
        enabled: rec.enabled !== false,
      };
    });
  }, [couplingsResource.data, scene.data?.couplings]);

  const baseline = useMemo<CouplingsRootDraft>(() => ({ rows }), [rows]);

  const magneticObjects = useMemo(
    () =>
      (scene.data?.objects ?? []).filter(
        (o) => !isAirboxSceneObject(o) && o.role !== "antenna" && o.role !== "auxiliary",
      ),
    [scene.data?.objects],
  );

  const handleCreateCoupling = useCallback(
    async (
      kind: "rkky" | "interlayer_exchange" | "exchange",
      selectNode: (next: Omit<Selection, "moduleSource">) => void,
    ) => {
      const id = `${kind.replace(/_/g, "-")}-${Date.now().toString(36)}`;
      if (magneticObjects.length >= 2) {
        const a = magneticObjects[0]!;
        const b = magneticObjects[1]!;
        const couplingPayload: SceneCoupling = {
          coupling_id: id,
          kind,
          enabled: true,
          source: { kind: "object", object: a.id },
          target: { kind: "object", object: b.id },
          parameters:
            kind === "rkky"
              ? { kind: "rkky", j1: -1e-3 }
              : kind === "interlayer_exchange"
                ? { kind: "interlayer_exchange", j1: -1e-3, j2: -0.2e-3 }
                : { kind: "exchange", mode: "harmonic_mean" },
        };
        const tx = await kernel.api.model.createCoupling(couplingPayload, {
          baseRevision: scene.data?.revision ?? undefined,
        });
        publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
        kernel.resources.invalidate(MODEL_COUPLINGS_PATH, tx.scene_revision);
      }
      const nodeId = `model:physics:couplings:${id}`;
      selectNode({
        kind: "physics.coupling",
        label: id,
        nodeId,
        objectId: null,
        ref: {
          couplingId: id,
          kind: "physics.coupling",
          nodeId,
          type: "physics-coupling",
        },
      });
    },
    [kernel.api.model, kernel.resources, magneticObjects, scene.data?.revision],
  );

  const handleToggleCoupling = useCallback(
    async (couplingId: string, enabled: boolean) => {
      const patchPayload: SceneCouplingPatch = { enabled };
      const tx = await kernel.api.model.patchCoupling(
        couplingId,
        patchPayload,
        { baseRevision: scene.data?.revision ?? undefined },
      );
      publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
      kernel.resources.invalidate(MODEL_COUPLINGS_PATH, tx.scene_revision);
    },
    [kernel.api.model, kernel.resources, scene.data?.revision],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    const tx = await kernel.api.model.deleteCoupling(id, {
      baseRevision: scene.data?.revision ?? undefined,
    });
    publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
    kernel.resources.invalidate(MODEL_COUPLINGS_PATH, tx.scene_revision);
  }, [kernel.api.model, kernel.resources, pendingDelete, scene.data?.revision]);

  const spec = useMemo<InspectorSpec<CouplingsRootDraft>>(
    () => ({
      id: "physics.couplings-root",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "couplings", label: "Couplings" },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: Link2,
        title: () => "Couplings",
        kindLabel: "Surface & interlayer couplings",
        entityId: "model:physics:couplings",
        statePill: (draft) => ({
          tone: draft.rows.length > 0 ? "ok" : "neutral",
          label: `${draft.rows.length} couplings`,
        }),
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "count", label: "Total", value: String(draft.rows.length) },
        {
          id: "active",
          label: "Active",
          value: String(draft.rows.filter((r) => r.enabled).length),
        },
      ],
      sections: [
        {
          id: "couplings-create",
          title: "Add surface coupling",
          icon: Plus,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="grid grid-cols-1 gap-1.5" data-slot="coupling-creator-tiles">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => void handleCreateCoupling("rkky", ctx.selectNode)}
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add RKKY Bilinear Coupling</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => void handleCreateCoupling("interlayer_exchange", ctx.selectNode)}
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add Interlayer Exchange (J1 + J2)</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => void handleCreateCoupling("exchange", ctx.selectNode)}
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add Direct Surface Exchange</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "couplings-table",
          title: "Configured couplings",
          icon: Link2,
          defaultOpen: true,
          emptyState: (d) =>
            d.rows.length === 0
              ? {
                  icon: Link2,
                  title: "No surface couplings defined",
                  description:
                    "Choose a coupling family above to link two magnetic objects or regions across a shared or separated interface.",
                }
              : null,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.rows.length > 0,
              rowKey: (rawRow) => (rawRow as CouplingListRow).id,
              rows: (d) => d.rows,
              onSelectRow: (rawRow, ctx) => {
                const row = rawRow as CouplingListRow;
                const nodeId = `model:physics:couplings:${row.id}`;
                ctx.selectNode({
                  kind: "physics.coupling",
                  label: row.name,
                  nodeId,
                  objectId: null,
                  ref: {
                    couplingId: row.id,
                    kind: "physics.coupling",
                    nodeId,
                    type: "physics-coupling",
                  },
                });
              },
              columns: [
                {
                  id: "name",
                  header: "Coupling",
                  renderCell: (rawRow) => {
                    const row = rawRow as CouplingListRow;
                    return (
                      <div className="flex flex-col">
                        <span className="font-medium text-[var(--fm-text)]">{row.name}</span>
                        <span className="text-xs text-[var(--fm-text-muted)]">
                          {row.kindLabel} · {row.endpointsLabel}
                        </span>
                      </div>
                    );
                  },
                },
                {
                  id: "strength",
                  header: "Strength",
                  mono: true,
                  renderCell: (rawRow) => (rawRow as CouplingListRow).strengthLabel,
                },
                {
                  id: "actions",
                  header: "Active",
                  align: "right",
                  renderCell: (rawRow) => {
                    const row = rawRow as CouplingListRow;
                    return (
                      <div className="flex items-center justify-end gap-1.5">
                        <Switch
                          aria-label={`Toggle ${row.name}`}
                          checked={row.enabled}
                          onCheckedChange={(checked) => {
                            void handleToggleCoupling(row.id, checked);
                          }}
                        />
                        <Button
                          aria-label={`Delete ${row.name}`}
                          size="icon"
                          type="button"
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete(row);
                          }}
                        >
                          <Trash2 aria-hidden="true" size={13} />
                        </Button>
                      </div>
                    );
                  },
                },
              ],
            },
          ],
        },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () => "Select a coupling to edit endpoints and J1 / J2 constants",
      },
    }),
    [handleCreateCoupling, handleToggleCoupling],
  );

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete coupling &ldquo;{pendingDelete?.name ?? ""}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the surface coupling definition from the session model.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmDelete()}>
              Delete coupling
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SpecInspectorHost>
  );
}

/* ── 8. FieldDrivesInspectorPanel (`physics.field-drives`) ── */

interface FieldDriveSummaryRow {
  id: string;
  label: string;
  driveKind: "regional" | "mask";
  waveformLabel: string;
  targetLabel: string;
  enabled: boolean;
  regionalDrive?: RegionalFieldDriveResource;
  maskDrive?: MaskFieldDriveResource;
}

interface FieldDrivesRootDraft {
  rows: readonly FieldDriveSummaryRow[];
}

export function FieldDrivesInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const regionalDrives = useFieldDrivesResource();
  const maskDrives = useMaskFieldDrivesResource();
  const [pendingDelete, setPendingDelete] = useState<FieldDriveSummaryRow | null>(null);

  const rows = useMemo<readonly FieldDriveSummaryRow[]>(() => {
    const items: FieldDriveSummaryRow[] = [];
    const typedRegional = regionalDrives.data?.drives ?? [];
    for (const rec of extractFieldDriveItems(regionalDrives.data)) {
      const id = String(rec.id ?? "");
      const wf = (rec.waveform ?? null) as Record<string, unknown> | null;
      const target = (rec.target ?? null) as Record<string, unknown> | null;
      const targetLabel =
        target?.kind === "global"
          ? "Global"
          : String(target?.object_id ?? target?.region_id ?? "Scoped");
      const matchedTyped = typedRegional.find((d) => d.id === id);
      items.push({
        id,
        label: String(rec.name ?? id),
        driveKind: "regional",
        waveformLabel: String(wf?.kind ?? "waveform").replace(/_/g, " "),
        targetLabel,
        enabled: rec.enabled !== false,
        ...(matchedTyped ? { regionalDrive: matchedTyped } : {}),
      });
    }
    const typedMask = maskDrives.data?.drives ?? [];
    for (const rec of extractFieldDriveItems(maskDrives.data)) {
      const id = String(rec.id ?? "");
      const wf = (rec.waveform ?? null) as Record<string, unknown> | null;
      const matchedTyped = typedMask.find((d) => d.id === id);
      items.push({
        id,
        label: String(rec.name ?? id),
        driveKind: "mask",
        waveformLabel: String(wf?.kind ?? "mask").replace(/_/g, " "),
        targetLabel: String(rec.object_id ?? "Mask"),
        enabled: rec.enabled !== false,
        ...(matchedTyped ? { maskDrive: matchedTyped } : {}),
      });
    }
    return items;
  }, [maskDrives.data, regionalDrives.data]);

  const baseline = useMemo<FieldDrivesRootDraft>(() => ({ rows }), [rows]);

  const openNewDriveDraft = useCallback(
    (
      driveKind: "regional" | "mask",
      label: string,
      selectNode: (next: Omit<Selection, "moduleSource">) => void,
      waveformHint?: "sinc_pulse" | "sinusoidal" | "gaussian_pulse",
    ) => {
      const nodeId =
        driveKind === "regional" && waveformHint
          ? `model:physics:field-drives:draft:regional:${waveformHint}`
          : `model:physics:field-drives:draft:${driveKind}`;
      selectNode({
        kind: "physics.field-drive",
        label,
        nodeId,
        objectId: null,
        ref: {
          draft: true,
          ...(driveKind === "mask" ? { fieldDriveKind: "mask" as const } : {}),
          kind: "physics.field-drive",
          nodeId,
          type: "physics-field-drive",
        },
      });
    },
    [],
  );

  const handleToggleDrive = useCallback(
    async (row: FieldDriveSummaryRow, enabled: boolean) => {
      if (row.driveKind === "regional" && row.regionalDrive) {
        const res = await kernel.api.model.replaceFieldDrive(row.id, {
          base_revision: scene.data?.revision ?? null,
          drive: { ...row.regionalDrive, enabled },
        });
        publishCommittedSceneResource(kernel.resources, res.committed_scene, res.scene_revision);
        kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, res.scene_revision);
      } else if (row.driveKind === "mask" && row.maskDrive) {
        const res = await kernel.api.model.replaceMaskFieldDrive(row.id, {
          base_revision: scene.data?.revision ?? null,
          drive: { ...row.maskDrive, enabled },
        });
        publishCommittedSceneResource(kernel.resources, res.committed_scene, res.scene_revision);
        kernel.resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, res.scene_revision);
      }
    },
    [kernel.api.model, kernel.resources, scene.data?.revision],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const row = pendingDelete;
    setPendingDelete(null);
    if (row.driveKind === "regional") {
      const res = await kernel.api.model.deleteFieldDrive(row.id, {
        base_revision: scene.data?.revision ?? null,
      });
      publishCommittedSceneResource(kernel.resources, res.committed_scene, res.scene_revision);
      kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, res.scene_revision);
    } else {
      const res = await kernel.api.model.deleteMaskFieldDrive(row.id, {
        base_revision: scene.data?.revision ?? null,
      });
      publishCommittedSceneResource(kernel.resources, res.committed_scene, res.scene_revision);
      kernel.resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, res.scene_revision);
    }
  }, [kernel.api.model, kernel.resources, pendingDelete, scene.data?.revision]);

  const spec = useMemo<InspectorSpec<FieldDrivesRootDraft>>(
    () => ({
      id: "physics.field-drives-root",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          {
            id: "global",
            label: "Global Physics",
            selection: buildRootSelection(
              "physics.scope.global",
              "model:physics:global",
              "Global Physics",
            ),
          },
          { id: "field-drives", label: "Field Drives" },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: Radio,
        title: () => "Field Drives",
        kindLabel: "Prescribed magnetic field excitations",
        entityId: "model:physics:field-drives",
        statePill: (draft) => ({
          tone: draft.rows.length > 0 ? "ok" : "neutral",
          label: `${draft.rows.length} drives`,
        }),
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "total", label: "Total drives", value: String(draft.rows.length) },
        {
          id: "active",
          label: "Enabled",
          value: String(draft.rows.filter((r) => r.enabled).length),
        },
      ],
      sections: [
        {
          id: "field-drives-create",
          title: "Add excitation drive",
          icon: Plus,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="grid grid-cols-2 gap-1.5" data-slot="field-drive-starters">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      openNewDriveDraft(
                        "regional",
                        "New Sinc Pulse Drive",
                        ctx.selectNode,
                        "sinc_pulse",
                      )
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Sinc Pulse</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      openNewDriveDraft(
                        "regional",
                        "New Harmonic Drive",
                        ctx.selectNode,
                        "sinusoidal",
                      )
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Harmonic RF</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      openNewDriveDraft(
                        "regional",
                        "New Gaussian Pulse",
                        ctx.selectNode,
                        "gaussian_pulse",
                      )
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Gaussian Pulse</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      openNewDriveDraft("mask", "New Mask Field Drive", ctx.selectNode)
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Mask Antenna</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "field-drives-table",
          title: "Configured field drives",
          icon: Waves,
          defaultOpen: true,
          emptyState: (d) =>
            d.rows.length === 0
              ? {
                  icon: Waves,
                  title: "No field drives configured",
                  description:
                    "Create a regional or mask magnetic field drive to excite FMR, spin-wave dispersion, or switching dynamics.",
                }
              : null,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.rows.length > 0,
              rowKey: (rawRow) => {
                const row = rawRow as FieldDriveSummaryRow;
                return `${row.driveKind}:${row.id}`;
              },
              rows: (d) => d.rows,
              onSelectRow: (rawRow, ctx) => {
                const row = rawRow as FieldDriveSummaryRow;
                const nodeId = `model:physics:field-drives:${row.id}`;
                ctx.selectNode({
                  kind: "physics.field-drive",
                  label: row.label,
                  nodeId,
                  objectId: null,
                  ref: {
                    fieldDriveId: row.id,
                    ...(row.driveKind === "mask" ? { fieldDriveKind: "mask" as const } : {}),
                    kind: "physics.field-drive",
                    nodeId,
                    type: "physics-field-drive",
                  },
                });
              },
              columns: [
                {
                  id: "label",
                  header: "Drive",
                  renderCell: (rawRow) => {
                    const row = rawRow as FieldDriveSummaryRow;
                    return (
                      <div className="flex flex-col">
                        <span className="font-medium text-[var(--fm-text)]">{row.label}</span>
                        <span className="text-xs text-[var(--fm-text-muted)]">
                          {row.waveformLabel} · {row.targetLabel}
                        </span>
                      </div>
                    );
                  },
                },
                {
                  id: "kind",
                  header: "Family",
                  renderCell: (rawRow) =>
                    (rawRow as FieldDriveSummaryRow).driveKind === "mask" ? "Mask" : "Regional",
                },
                {
                  id: "actions",
                  header: "Active",
                  align: "right",
                  renderCell: (rawRow) => {
                    const row = rawRow as FieldDriveSummaryRow;
                    return (
                      <div className="flex items-center justify-end gap-1.5">
                        <Switch
                          aria-label={`Toggle ${row.label}`}
                          checked={row.enabled}
                          onCheckedChange={(checked) => {
                            void handleToggleDrive(row, checked);
                          }}
                        />
                        <Button
                          aria-label={`Delete ${row.label}`}
                          size="icon"
                          type="button"
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete(row);
                          }}
                        >
                          <Trash2 aria-hidden="true" size={13} />
                        </Button>
                      </div>
                    );
                  },
                },
              ],
            },
          ],
        },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () =>
          "Select a field drive to inspect its B(t) waveform, spectrum, and spatial mask",
      },
    }),
    [handleToggleDrive, openNewDriveDraft],
  );

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete field drive &ldquo;{pendingDelete?.label ?? ""}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the prescribed magnetic field drive from the session model.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmDelete()}>
              Delete field drive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SpecInspectorHost>
  );
}
