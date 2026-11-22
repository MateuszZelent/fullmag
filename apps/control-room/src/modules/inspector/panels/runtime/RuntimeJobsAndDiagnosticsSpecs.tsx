"use client";

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Cpu,
  Database,
  FileText,
  HardDrive,
  Info,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { useCallback, useContext, useMemo, useState, useSyncExternalStore } from "react";

import { KernelContext } from "@/kernel/KernelContext";
import {
  runtimeExplorerDetailStore,
  useRuntimeExplorerDetail,
} from "@/kernel/resources/runtimeExplorerDetailStore";
import type {
  RuntimeExecutionDetail,
  RuntimeExplorerDetail,
} from "@/kernel/resources/runtimeExplorerTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { setExplorerActiveTab } from "@/modules/explorer/public";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import { resolveInspectorRoute } from "../../inspectorRouteCatalog";
import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  InspectorTemplate,
  type InspectorActionContext,
  type InspectorFact,
  type InspectorNotice,
  type InspectorRowSpec,
  type InspectorSectionSpec,
  type InspectorSpec,
  type InspectorTone,
} from "../../template";

type DiagnosticSeverityFilter = "all" | "error" | "warning" | "info";
type ResourceCategoryFilter = "all" | "model" | "mesh" | "simulation" | "analysis";
type JobLifecycleFilter = "all" | "active" | "completed" | "failed";

interface RuntimeViewDraft {
  readonly resourceFilter: ResourceCategoryFilter;
  readonly jobFilter: JobLifecycleFilter;
  readonly severityFilter: DiagnosticSeverityFilter;
}

const DEFAULT_DRAFT: RuntimeViewDraft = {
  resourceFilter: "all",
  jobFilter: "all",
  severityFilter: "all",
};

const EMPTY_FIELD_SET: ReadonlySet<string> = new Set();
const EMPTY_ERROR_MAP: ReadonlyMap<string, string> = new Map();

function RuntimeSpecRenderer({
  draft,
  onChange,
  selection,
  spec,
}: {
  draft: RuntimeViewDraft;
  onChange: (next: RuntimeViewDraft) => void;
  selection: InspectorPanelProps["selection"];
  spec: InspectorSpec<RuntimeViewDraft>;
}) {
  const kernel = useContext(KernelContext);
  return (
    <InspectorTemplate
      baseline={DEFAULT_DRAFT}
      dirtyFields={EMPTY_FIELD_SET}
      draft={draft}
      invalidFields={EMPTY_ERROR_MAP}
      onApply={async () => true}
      onFieldChange={(key, value) => onChange({ ...draft, [key]: value })}
      onFieldTouch={() => {}}
      onFocusField={() => {}}
      onParseErrorChange={() => {}}
      onPatchDraft={(patch) => onChange({ ...draft, ...patch })}
      onResetDisplay={() => {}}
      onRevertAll={() => onChange(DEFAULT_DRAFT)}
      onRevertField={() => {}}
      onSelectNode={(next) => {
        kernel?.selection.set(next, "inspector");
      }}
      selection={selection}
      spec={spec}
      touchedFields={EMPTY_FIELD_SET}
    />
  );
}

function formatBytesGiBOrMiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function ownerIdentity(value: string | null): string {
  return value === null ? "Unavailable / unverified" : value;
}

function useAllRuntimeExplorerDetails(): ReadonlyMap<string, RuntimeExplorerDetail> {
  return useSyncExternalStore(
    runtimeExplorerDetailStore.subscribe,
    () => runtimeExplorerDetailStore.getSnapshot().details,
    () => runtimeExplorerDetailStore.getServerSnapshot().details,
  );
}

function classifyResourceCategory(
  descriptorId: string,
  detail: RuntimeExplorerDetail,
): ResourceCategoryFilter {
  const haystack = `${descriptorId} ${detail.key} ${detail.owner ?? ""}`.toLowerCase();
  if (haystack.includes("mesh")) return "mesh";
  if (haystack.includes("analysis") || haystack.includes("frequency")) return "analysis";
  if (
    haystack.includes("simulation") ||
    haystack.includes("solver") ||
    haystack.includes("run") ||
    haystack.includes("stage")
  ) {
    return "simulation";
  }
  return "model";
}

function classifyJobBucket(detail: RuntimeExplorerDetail): JobLifecycleFilter {
  const status = (detail.lifecycleStatus ?? detail.condition ?? "").toLowerCase();
  if (status.includes("fail") || status.includes("error") || status === "degraded") {
    return "failed";
  }
  if (status === "completed" || status === "ready" || status === "succeeded") {
    return "completed";
  }
  return "active";
}

function classifyDiagnosticSeverity(detail: RuntimeExplorerDetail): DiagnosticSeverityFilter {
  const sevFact = detail.facts
    .find((f) => f.label.toLowerCase() === "severity")
    ?.value.toLowerCase();
  if (sevFact === "error" || sevFact === "err" || sevFact?.includes("error")) return "error";
  if (sevFact === "warning" || sevFact === "warn" || sevFact?.includes("warn")) return "warning";
  if (sevFact === "info") return "info";
  const condition = detail.condition?.toLowerCase();
  const lifecycle = detail.lifecycleStatus?.toLowerCase();
  if (
    condition === "degraded" ||
    condition === "failed" ||
    condition === "unavailable" ||
    condition === "error" ||
    lifecycle === "failed" ||
    lifecycle === "error"
  ) {
    return "error";
  }
  if (
    condition === "warning" ||
    condition === "warn" ||
    condition === "stale" ||
    lifecycle === "warning" ||
    lifecycle === "warn" ||
    lifecycle === "stale"
  ) {
    return "warning";
  }
  return "info";
}

function useSelectionRuntimeDetail(
  selection: InspectorPanelProps["selection"],
): RuntimeExplorerDetail | null {
  const ref = selection.ref?.type === "runtime-explorer" ? selection.ref : null;
  return useRuntimeExplorerDetail(ref);
}

function toneFromCondition(condition: string | null | undefined): InspectorTone {
  switch (condition) {
    case "ready":
    case "completed":
      return "ok";
    case "running":
      return "live";
    case "stale":
      return "stale";
    case "warning":
      return "warn";
    case "degraded":
      return "degraded";
    case "failed":
    case "error":
    case "unavailable":
      return "err";
    default:
      return "neutral";
  }
}

interface OffendingTargetResolution {
  readonly kind: string;
  readonly nodeId: string;
  readonly label: string;
  readonly objectId: string | null;
  readonly explorerTab: "model" | "resources" | "jobs" | "diagnostics";
  readonly ref?: Selection["ref"];
}

function resolveOffendingTarget(
  detail: RuntimeExplorerDetail | null,
): OffendingTargetResolution | null {
  if (!detail) return null;
  const targetFact = detail.facts.find(
    (fact) =>
      fact.label.toLowerCase() === "target" ||
      fact.label.toLowerCase() === "offending node" ||
      fact.label.toLowerCase() === "node",
  );
  const raw = (targetFact?.value ?? detail.owner ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (
    lower.includes("execution") ||
    lower === "study.execution" ||
    lower === "backend" ||
    lower === "platform" ||
    lower === "capabilities"
  ) {
    return {
      kind: "study.execution",
      nodeId: "model:study:execution",
      label: "Study Execution",
      objectId: null,
      explorerTab: "model",
    };
  }
  if (lower.includes("airbox") || lower === "airbox.root") {
    return {
      kind: "airbox.root",
      nodeId: "model:airbox",
      label: "Airbox Domain",
      objectId: null,
      explorerTab: "model",
    };
  }
  if (
    lower === "mesh" ||
    lower === "meshing" ||
    lower === "mesh.root" ||
    lower.startsWith("mesh:")
  ) {
    return {
      kind: "mesh.root",
      nodeId: "model:mesh",
      label: "Mesh Domain",
      objectId: null,
      explorerTab: "model",
    };
  }
  if (raw.startsWith("run:")) {
    const runId = raw.slice("run:".length).trim();
    if (!runId) return null;
    const nodeId = `jobs:run:${encodeURIComponent(runId)}`;
    return {
      kind: "jobs.run",
      nodeId,
      label: `Run ${runId}`,
      objectId: null,
      explorerTab: "jobs",
    };
  }
  if (lower === "geometry" || lower === "geometry.root" || lower === "validation") {
    return {
      kind: "geometry.root",
      nodeId: "model:geometry",
      label: "Geometry",
      objectId: null,
      explorerTab: "model",
    };
  }
  if (lower === "study" || lower === "study.root" || lower === "solver") {
    return {
      kind: "study.root",
      nodeId: "model:study",
      label: "Study",
      objectId: null,
      explorerTab: "model",
    };
  }
  if (lower === "stages" || lower === "study.stages") {
    return {
      kind: "study.stages",
      nodeId: "model:study:stages",
      label: "Stages",
      objectId: null,
      explorerTab: "model",
    };
  }
  if (lower === "recovery" || lower === "checkpoints" || lower === "study.recovery") {
    return {
      kind: "study.recovery",
      nodeId: "model:study:recovery",
      label: "Recovery",
      objectId: null,
      explorerTab: "model",
    };
  }
  if (lower === "resources" || lower === "resources.root" || lower === "session") {
    return {
      kind: "resources.root",
      nodeId: "resources:root",
      label: "Session Resources",
      objectId: null,
      explorerTab: "resources",
    };
  }
  if (lower === "jobs" || lower === "jobs.root") {
    return {
      kind: "jobs.root",
      nodeId: "jobs:root",
      label: "Jobs",
      objectId: null,
      explorerTab: "jobs",
    };
  }
  if (raw.startsWith("stage:")) {
    const stageId = raw.slice("stage:".length).trim();
    if (!stageId) return null;
    const nodeId = `model:study:stages:stage:${stageId}`;
    return {
      kind: "study.stage.action",
      nodeId,
      label: `Stage ${stageId}`,
      objectId: null,
      explorerTab: "model",
      ref: {
        kind: "study.stage.action",
        nodeId,
        stageId,
        stageIndex: 0,
        type: "study-stage",
      },
    };
  }
  if (raw.startsWith("object:")) {
    const objectId = raw.slice("object:".length).trim();
    if (!objectId) return null;
    return {
      kind: "object.root",
      nodeId: `model:object:${objectId}`,
      label: objectId,
      objectId,
      explorerTab: "model",
    };
  }
  if (raw.includes(".") && resolveInspectorRoute(raw) !== null) {
    const explorerTab = raw.startsWith("resources.")
      ? "resources"
      : raw.startsWith("jobs.")
        ? "jobs"
        : raw.startsWith("diagnostics.")
          ? "diagnostics"
          : "model";
    return {
      kind: raw,
      nodeId: raw.replace(/\./g, ":"),
      label: raw,
      objectId: null,
      explorerTab,
    };
  }
  return null;
}

function buildExecutionSection(
  id: string,
  title: string,
  exec: RuntimeExecutionDetail | null,
): InspectorSectionSpec<RuntimeViewDraft> {
  const rows: InspectorRowSpec<RuntimeViewDraft>[] = [];
  if (exec?.backend) {
    rows.push({ type: "readonly", label: "Backend", format: () => exec.backend ?? "—" });
  }
  if (exec?.device) {
    rows.push({ type: "readonly", label: "Device", format: () => exec.device ?? "—" });
  }
  if (exec?.mode) {
    rows.push({ type: "readonly", label: "Mode", format: () => exec.mode ?? "—" });
  }
  if (exec?.precision) {
    rows.push({ type: "readonly", label: "Precision", format: () => exec.precision ?? "—" });
  }
  if (exec?.engineId) {
    rows.push({ type: "readonly", label: "Engine", mono: true, format: () => exec.engineId ?? "—" });
  }
  if (exec?.runtimeFamily) {
    rows.push({ type: "readonly", label: "Runtime family", format: () => exec.runtimeFamily ?? "—" });
  }
  if (exec?.worker) {
    rows.push({ type: "readonly", label: "Worker", mono: true, format: () => exec.worker ?? "—" });
  }
  if (rows.length === 0) {
    rows.push({
      type: "readonly",
      label: "Execution descriptor",
      format: () => "Not resolved yet",
    });
  }
  return {
    id,
    title,
    icon: Cpu,
    defaultOpen: true,
    rows,
  };
}

function renderUnavailableRuntimeSpec(
  selection: InspectorPanelProps["selection"],
  id: string,
  breadcrumbs: readonly string[],
  title: string,
) {
  const spec: InspectorSpec<RuntimeViewDraft> = {
    id,
    header: {
      breadcrumbs: breadcrumbs.map((label, idx) => ({ id: `bc-${idx}`, label })),
    },
    identity: {
      domain: "study",
      icon: Database,
      title: () => title,
      kindLabel: "Runtime resource",
      statePill: () => ({ tone: "neutral", label: "Idle" }),
    },
    facts: () => [],
    notices: () => [
      {
        id: "missing-selection",
        tone: "info",
        title: "Typed runtime selection is unavailable.",
        text: "Select an active runtime resource, job, or diagnostic entry once the session snapshot arrives.",
      },
    ],
    sections: [
      {
        id: "selection-state",
        title: "Selection State",
        icon: Info,
        defaultOpen: true,
        rows: [
          {
            type: "readonly",
            label: "Reason",
            format: () => "Typed runtime selection is unavailable.",
          },
        ],
      },
    ],
    commitBar: { mode: "readOnly", statusMessage: () => "Read-only runtime inspector" },
  };

  return (
    <RuntimeSpecRenderer
      draft={DEFAULT_DRAFT}
      onChange={() => {}}
      selection={selection}
      spec={spec}
    />
  );
}

export function RuntimeResourcesOverviewView({ selection }: InspectorPanelProps) {
  const [draft, setDraft] = useState<RuntimeViewDraft>(DEFAULT_DRAFT);
  const kernel = useContext(KernelContext);
  const allDetails = useAllRuntimeExplorerDetails();

  const resourceEntries = useMemo(() => {
    const out: Array<{ id: string; detail: RuntimeExplorerDetail; category: ResourceCategoryFilter }> = [];
    for (const [id, detail] of allDetails.entries()) {
      if (detail.category === "resource") {
        out.push({ id, detail, category: classifyResourceCategory(id, detail) });
      }
    }
    return out;
  }, [allDetails]);

  const spec = useMemo<InspectorSpec<RuntimeViewDraft>>(
    () => ({
      id: "resources.root",
      header: {
        breadcrumbs: [
          { id: "resources", label: "Resources" },
          { id: "catalog", label: "Session Catalog" },
        ],
        primaryHeaderAction: {
          label: "Refresh Resources",
          icon: RefreshCw,
          onRun: () => {
            kernel?.resources.invalidatePrefix("/v2/", "inspector-refresh");
          },
        },
      },
      identity: {
        domain: "study",
        icon: Database,
        title: () => "Session Resources",
        kindLabel: "Runtime resource catalog",
        statePill: () => ({ tone: "ok", label: "Active session" }),
      },
      facts: (d) => {
        const filteredCount = resourceEntries.filter(
          (e) => d.resourceFilter === "all" || e.category === d.resourceFilter,
        ).length;
        return [
          { id: "scope", label: "Scope", value: "Current session" },
          { id: "filter", label: "Category", value: d.resourceFilter },
          { id: "count", label: "Matching", value: `${filteredCount} / ${resourceEntries.length}` },
        ];
      },
      sections: [
        {
          id: "resource-filter",
          title: "Category Filter & Inventory",
          icon: Database,
          defaultOpen: true,
          rows: [
            {
              key: "resourceFilter",
              type: "segmented",
              label: "Resource family",
              options: [
                { value: "all", label: "All" },
                { value: "model", label: "Model" },
                { value: "mesh", label: "Mesh" },
                { value: "simulation", label: "Simulation" },
                { value: "analysis", label: "Analysis" },
              ],
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const visible = resourceEntries.filter(
                  (entry) =>
                    ctx.draft.resourceFilter === "all" ||
                    entry.category === ctx.draft.resourceFilter,
                );
                if (resourceEntries.length === 0) {
                  return (
                    <p className="text-xs text-fm-secondary">
                      Shared runtime resource cache · Select a resource leaf in the Explorer tree for revision &amp; generation.
                    </p>
                  );
                }
                if (visible.length === 0) {
                  return (
                    <p className="text-xs text-fm-secondary">
                      No session resources match category &ldquo;{ctx.draft.resourceFilter}&rdquo;.
                    </p>
                  );
                }
                return (
                  <div className="grid gap-1.5 text-xs">
                    {visible.map(({ id, detail }) => (
                      <div
                        className="flex items-center justify-between gap-2 rounded border border-fm-border-subtle px-2 py-1.5"
                        key={id}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-fm-primary">{detail.key}</div>
                          <div className="text-fm-secondary">
                            {detail.condition}
                            {detail.revision !== null ? ` · rev ${detail.revision}` : ""}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            ctx.selectNode({
                              kind: "resources.runtime",
                              label: detail.key,
                              nodeId: id,
                              objectId: null,
                              ref: {
                                descriptorId: id,
                                kind: "resources.runtime",
                                nodeId: id,
                                resourceKey: detail.key,
                                type: "runtime-explorer",
                              },
                            })
                          }
                        >
                          Inspect →
                        </Button>
                      </div>
                    ))}
                  </div>
                );
              },
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Read-only runtime resource catalog",
      },
    }),
    [kernel, resourceEntries],
  );

  return (
    <RuntimeSpecRenderer
      draft={draft}
      onChange={setDraft}
      selection={selection}
      spec={spec}
    />
  );
}

export function RuntimeResourceInspectorView({ selection }: InspectorPanelProps) {
  const detail = useSelectionRuntimeDetail(selection);
  const kernel = useContext(KernelContext);
  const [draft, setDraft] = useState<RuntimeViewDraft>(DEFAULT_DRAFT);

  if (!detail) {
    return renderUnavailableRuntimeSpec(
      selection,
      "resources.runtime",
      ["Resources", selection.label ?? "Resource"],
      selection.label ?? "Runtime Resource",
    );
  }

  const hasStorage =
    detail.sizeBytes !== null || detail.location !== null || detail.cache !== null;

  const storageRows: InspectorRowSpec<RuntimeViewDraft>[] = [];
  if (detail.sizeBytes !== null) {
    storageRows.push({
      type: "readonly",
      label: "Size",
      format: () => formatBytesGiBOrMiB(detail.sizeBytes ?? 0),
    });
  }
  if (detail.cache !== null) {
    storageRows.push({
      type: "readonly",
      label: "Cache",
      format: () => detail.cache ?? "—",
    });
  }
  if (detail.location !== null) {
    storageRows.push({
      type: "readonly",
      label: "Location",
      mono: true,
      format: () => detail.location ?? "—",
    });
  }

  const sections: InspectorSectionSpec<RuntimeViewDraft>[] = [
    {
      id: "identity",
      title: "Identity",
      icon: Database,
      defaultOpen: true,
      rows: [
        {
          type: "readonly",
          label: "Resource key",
          mono: true,
          format: () => detail.key,
        },
        ...(detail.schema !== null
          ? [
              {
                type: "readonly" as const,
                label: "Schema",
                mono: true,
                format: () => detail.schema ?? "—",
              },
            ]
          : []),
        {
          type: "readonly",
          label: "Owner",
          mono: true,
          format: () => ownerIdentity(detail.owner),
        },
      ],
    },
    {
      id: "version",
      title: "Version & Freshness",
      icon: RefreshCw,
      defaultOpen: true,
      rows: [
        ...(detail.revision !== null
          ? [
              {
                type: "readonly" as const,
                label: "Revision",
                format: () => String(detail.revision),
              },
            ]
          : []),
        ...(detail.generation !== null
          ? [
              {
                type: "readonly" as const,
                label: "Generation",
                mono: true,
                format: () => detail.generation ?? "—",
              },
            ]
          : []),
        {
          type: "readonly",
          label: "Condition",
          format: () => detail.condition,
        },
        {
          type: "readonly",
          label: "Source state",
          format: () => detail.sourceStatus,
        },
      ],
    },
  ];

  if (hasStorage) {
    sections.push({
      id: "storage",
      title: "Storage",
      icon: HardDrive,
      defaultOpen: true,
      rows: storageRows,
    });
  }

  if (detail.facts.length > 0) {
    sections.push({
      id: "evidence",
      title: "Evidence",
      icon: FileText,
      defaultOpen: true,
      rows: detail.facts.map((fact) => ({
        type: "readonly" as const,
        label: fact.label,
        format: () => fact.value,
      })),
    });
  }

  const spec: InspectorSpec<RuntimeViewDraft> = {
    id:
      selection.kind === "resources.mesh.periodic_pairs"
        ? "resources.mesh.periodic_pairs"
        : "resources.runtime",
    header: {
      breadcrumbs: [
        { id: "resources", label: "Resources" },
        { id: "leaf", label: selection.label ?? detail.key },
      ],
      primaryHeaderAction: {
        label: "Invalidate & Refetch",
        icon: RefreshCw,
        onRun: () => {
          kernel?.resources.invalidate(detail.key, "inspector-refresh");
        },
      },
    },
    identity: {
      domain: "study",
      icon: Database,
      title: () => selection.label ?? detail.key,
      kindLabel: "Runtime resource",
      entityId: detail.key,
      statePill: () => ({
        tone: toneFromCondition(detail.condition),
        label: detail.condition,
      }),
    },
    facts: () => [
      { id: "condition", label: "Condition", value: detail.condition },
      { id: "source", label: "Source", value: detail.sourceStatus },
      ...(detail.revision !== null
        ? [{ id: "rev", label: "Revision", value: String(detail.revision) }]
        : []),
    ],
    notices: () =>
      detail.message
        ? [
            {
              id: "resource-message",
              tone: detail.condition === "ready" ? "info" : "warn",
              text: detail.message,
            },
          ]
        : [],
    sections,
    commitBar: {
      mode: "readOnly",
      statusMessage: () => "Read-only HTTP v2 runtime resource",
    },
  };

  return (
    <RuntimeSpecRenderer
      draft={draft}
      onChange={setDraft}
      selection={selection}
      spec={spec}
    />
  );
}

export function RuntimeJobsOverviewView({ selection }: InspectorPanelProps) {
  const [draft, setDraft] = useState<RuntimeViewDraft>(DEFAULT_DRAFT);
  const allDetails = useAllRuntimeExplorerDetails();

  const jobEntries = useMemo(() => {
    const out: Array<{ id: string; detail: RuntimeExplorerDetail; bucket: JobLifecycleFilter }> = [];
    for (const [id, detail] of allDetails.entries()) {
      if (detail.category === "job") {
        out.push({ id, detail, bucket: classifyJobBucket(detail) });
      }
    }
    return out;
  }, [allDetails]);

  const spec = useMemo<InspectorSpec<RuntimeViewDraft>>(
    () => ({
      id: "jobs.root",
      header: {
        breadcrumbs: [
          { id: "jobs", label: "Jobs" },
          { id: "queue", label: "Execution Queue" },
        ],
      },
      identity: {
        domain: "study",
        icon: Activity,
        title: () => "Execution Jobs",
        kindLabel: "Runtime lifecycle",
        statePill: () => ({ tone: "ok", label: "Session queue" }),
      },
      facts: (d) => {
        const filteredCount = jobEntries.filter(
          (e) => d.jobFilter === "all" || e.bucket === d.jobFilter,
        ).length;
        return [
          { id: "filter", label: "Filter", value: d.jobFilter },
          { id: "count", label: "Matching", value: `${filteredCount} / ${jobEntries.length}` },
        ];
      },
      sections: [
        {
          id: "job-filter",
          title: "Job Filter & Execution Lanes",
          icon: Activity,
          defaultOpen: true,
          rows: [
            {
              key: "jobFilter",
              type: "segmented",
              label: "Lifecycle filter",
              options: [
                { value: "all", label: "All" },
                { value: "active", label: "Active" },
                { value: "completed", label: "Completed" },
                { value: "failed", label: "Failed" },
              ],
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const visible = jobEntries.filter(
                  (entry) =>
                    ctx.draft.jobFilter === "all" || entry.bucket === ctx.draft.jobFilter,
                );
                if (jobEntries.length === 0) {
                  return (
                    <p className="text-xs text-fm-secondary">
                      Requested execution intent is tracked separately from resolved device &amp; precision. No active or historical jobs recorded in this session yet.
                    </p>
                  );
                }
                if (visible.length === 0) {
                  return (
                    <p className="text-xs text-fm-secondary">
                      No execution jobs match lifecycle filter &ldquo;{ctx.draft.jobFilter}&rdquo;.
                    </p>
                  );
                }
                return (
                  <div className="grid gap-1.5 text-xs">
                    {visible.map(({ id, detail }) => {
                      const jobRouteKind = id.includes(":command:")
                        ? ("jobs.command" as const)
                        : id.includes(":stage:")
                          ? ("jobs.stage" as const)
                          : ("jobs.run" as const);
                      return (
                        <div
                          className="flex items-center justify-between gap-2 rounded border border-fm-border-subtle px-2 py-1.5"
                          key={id}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-fm-primary">{detail.key}</div>
                            <div className="text-fm-secondary">
                              {detail.lifecycleStatus ?? detail.condition}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              ctx.selectNode({
                                kind: jobRouteKind,
                                label: detail.key,
                                nodeId: id,
                                objectId: null,
                                ref: {
                                  descriptorId: id,
                                  kind: jobRouteKind,
                                  nodeId: id,
                                  resourceKey: detail.key,
                                  type: "runtime-explorer",
                                },
                              })
                            }
                          >
                            Inspect →
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                );
              },
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly", statusMessage: () => "Read-only runtime job queue" },
    }),
    [jobEntries],
  );

  return (
    <RuntimeSpecRenderer
      draft={draft}
      onChange={setDraft}
      selection={selection}
      spec={spec}
    />
  );
}

export function RuntimeExecutionJobView({
  selection,
  specId,
  title,
}: InspectorPanelProps & { specId: "jobs.run" | "jobs.stage"; title: string }) {
  const detail = useSelectionRuntimeDetail(selection);
  const [draft, setDraft] = useState<RuntimeViewDraft>(DEFAULT_DRAFT);

  if (!detail) {
    return renderUnavailableRuntimeSpec(selection, specId, ["Jobs", title], title);
  }

  const facts: InspectorFact[] = [
    { id: "lifecycle", label: "Lifecycle", value: detail.lifecycleStatus ?? "pending" },
    { id: "condition", label: "Condition", value: detail.condition },
    ...(detail.revision !== null
      ? [{ id: "revision", label: "Revision", value: String(detail.revision) }]
      : []),
  ];

  const sections: InspectorSectionSpec<RuntimeViewDraft>[] = [
    {
      id: "lifecycle",
      title,
      icon: Activity,
      defaultOpen: true,
      rows: [
        { type: "readonly", label: "Resource key", mono: true, format: () => detail.key },
        { type: "readonly", label: "Owner", mono: true, format: () => ownerIdentity(detail.owner) },
        {
          type: "readonly",
          label: "Lifecycle status",
          format: () => detail.lifecycleStatus ?? "pending",
        },
        { type: "readonly", label: "Condition", format: () => detail.condition },
        { type: "readonly", label: "Source state", format: () => detail.sourceStatus },
        ...(detail.message
          ? [{ type: "readonly" as const, label: "Message", format: () => detail.message ?? "" }]
          : []),
      ],
    },
    buildExecutionSection("requested-exec", "Requested execution", detail.requestedExecution),
    buildExecutionSection("resolved-exec", "Resolved execution", detail.resolvedExecution),
  ];

  if (detail.facts.length > 0) {
    sections.push({
      id: "evidence",
      title: "Evidence",
      icon: FileText,
      defaultOpen: true,
      rows: detail.facts.map((fact) => ({
        type: "readonly" as const,
        label: fact.label,
        format: () => fact.value,
      })),
    });
  }

  const spec: InspectorSpec<RuntimeViewDraft> = {
    id: specId,
    header: {
      breadcrumbs: [
        { id: "jobs", label: "Jobs" },
        { id: "leaf", label: selection.label ?? title },
      ],
    },
    identity: {
      domain: "study",
      icon: Activity,
      title: () => selection.label ?? title,
      kindLabel: specId === "jobs.run" ? "Simulation run" : "Pipeline stage job",
      entityId: detail.key,
      statePill: () => ({
        tone: toneFromCondition(detail.condition),
        label: detail.lifecycleStatus ?? detail.condition,
      }),
    },
    facts: () => facts,
    sections,
    commitBar: { mode: "readOnly", statusMessage: () => "Read-only execution provenance" },
  };

  return (
    <RuntimeSpecRenderer
      draft={draft}
      onChange={setDraft}
      selection={selection}
      spec={spec}
    />
  );
}

export function RuntimeCommandJobView({ selection }: InspectorPanelProps) {
  const detail = useSelectionRuntimeDetail(selection);
  const [draft, setDraft] = useState<RuntimeViewDraft>(DEFAULT_DRAFT);

  if (!detail) {
    return renderUnavailableRuntimeSpec(
      selection,
      "jobs.command",
      ["Jobs", "Command"],
      "Command Execution",
    );
  }

  const sections: InspectorSectionSpec<RuntimeViewDraft>[] = [
    {
      id: "command-execution",
      title: "Command Execution",
      icon: Terminal,
      defaultOpen: true,
      rows: [
        { type: "readonly", label: "Command key", mono: true, format: () => detail.key },
        { type: "readonly", label: "Owner", mono: true, format: () => ownerIdentity(detail.owner) },
        ...(detail.revision !== null
          ? [{ type: "readonly" as const, label: "Revision", format: () => String(detail.revision) }]
          : []),
        {
          type: "readonly",
          label: "Lifecycle status",
          format: () => detail.lifecycleStatus ?? detail.condition,
        },
        { type: "readonly", label: "Condition", format: () => detail.condition },
        { type: "readonly", label: "Source state", format: () => detail.sourceStatus },
        ...(detail.message
          ? [{ type: "readonly" as const, label: "Message / Receipt", format: () => detail.message ?? "" }]
          : []),
      ],
    },
  ];

  if (detail.facts.length > 0) {
    sections.push({
      id: "evidence",
      title: "Command Receipt Facts",
      icon: FileText,
      defaultOpen: true,
      rows: detail.facts.map((fact) => ({
        type: "readonly" as const,
        label: fact.label,
        format: () => fact.value,
      })),
    });
  }

  const spec: InspectorSpec<RuntimeViewDraft> = {
    id: "jobs.command",
    header: {
      breadcrumbs: [
        { id: "jobs", label: "Jobs" },
        { id: "command", label: selection.label ?? "Command" },
      ],
    },
    identity: {
      domain: "study",
      icon: Terminal,
      title: () => selection.label ?? "Command Execution",
      kindLabel: "Runtime command",
      entityId: detail.key,
      statePill: () => ({
        tone: toneFromCondition(detail.condition),
        label: detail.lifecycleStatus ?? detail.condition,
      }),
    },
    facts: () => [
      { id: "status", label: "Status", value: detail.lifecycleStatus ?? detail.condition },
      ...(detail.revision !== null
        ? [{ id: "revision", label: "Revision", value: String(detail.revision) }]
        : []),
    ],
    notices: () =>
      detail.message
        ? [
            {
              id: "command-message",
              tone: detail.condition === "ready" ? "info" : "warn",
              text: detail.message,
            },
          ]
        : [],
    sections,
    commitBar: {
      mode: "readOnly",
      statusMessage: () => "Read-only command transaction receipt",
    },
  };

  return (
    <RuntimeSpecRenderer
      draft={draft}
      onChange={setDraft}
      selection={selection}
      spec={spec}
    />
  );
}

export function RuntimeDiagnosticCategoryView({
  categoryTitle,
  selection,
  specId,
}: InspectorPanelProps & { categoryTitle: string; specId: string }) {
  const detail = useSelectionRuntimeDetail(selection);
  const allDetails = useAllRuntimeExplorerDetails();
  const kernel = useContext(KernelContext);
  const [draft, setDraft] = useState<RuntimeViewDraft>(DEFAULT_DRAFT);

  const diagnosticEntries = useMemo(() => {
    if (specId !== "diagnostics.root") return [];
    const out: Array<{
      id: string;
      detail: RuntimeExplorerDetail;
      severity: DiagnosticSeverityFilter;
    }> = [];
    for (const [id, entryDetail] of allDetails.entries()) {
      if (entryDetail.category === "diagnostic") {
        out.push({
          id,
          detail: entryDetail,
          severity: classifyDiagnosticSeverity(entryDetail),
        });
      }
    }
    return out;
  }, [allDetails, specId]);

  const offendingTarget = useMemo(() => resolveOffendingTarget(detail), [detail]);

  const handleJumpToOffendingNode = useCallback(() => {
    if (!offendingTarget) return;
    setExplorerActiveTab(offendingTarget.explorerTab);
    kernel?.selection.set(
      {
        kind: offendingTarget.kind,
        label: offendingTarget.label,
        nodeId: offendingTarget.nodeId,
        objectId: offendingTarget.objectId,
        ...(offendingTarget.ref ? { ref: offendingTarget.ref } : {}),
      },
      "inspector",
    );
  }, [kernel, offendingTarget]);

  if (!detail && specId !== "diagnostics.root") {
    return renderUnavailableRuntimeSpec(
      selection,
      specId,
      ["Diagnostics", categoryTitle],
      categoryTitle,
    );
  }

  const effectiveTitle = detail?.contractGap ? "Contract gap" : categoryTitle;
  const rawSeverity: DiagnosticSeverityFilter = detail
    ? classifyDiagnosticSeverity(detail)
    : "info";

  const matchesSeverity =
    draft.severityFilter === "all" || draft.severityFilter === rawSeverity;

  const notices: InspectorNotice<RuntimeViewDraft>[] = [];
  if (detail?.contractGap) {
    notices.push({
      id: "contract-gap",
      tone: "err",
      title: "Contract gap",
      text: detail.message ?? "Required runtime diagnostic contract is unavailable.",
    });
  } else if (detail?.message) {
    notices.push({
      id: "diagnostic-message",
      tone: rawSeverity === "error" ? "err" : rawSeverity === "warning" ? "warn" : "info",
      text: detail.message,
    });
  }

  const sections: InspectorSectionSpec<RuntimeViewDraft>[] = [
    {
      id: "filter-and-findings",
      title: effectiveTitle,
      icon: AlertTriangle,
      defaultOpen: true,
      rows: [
        {
          key: "severityFilter",
          type: "segmented",
          label: "Severity filter",
          options: [
            { value: "all", label: "All" },
            { value: "error", label: "Errors" },
            { value: "warning", label: "Warnings" },
            { value: "info", label: "Info" },
          ],
        },
        ...(detail
          ? [
              {
                type: "custom" as const,
                wide: true,
                render: () =>
                  matchesSeverity ? (
                    <div className="fm-inspector-card" data-severity={rawSeverity}>
                      <div className="flex items-center justify-between gap-2">
                        <Badge
                          variant={
                            rawSeverity === "error"
                              ? "danger"
                              : rawSeverity === "warning"
                                ? "warning"
                                : "default"
                          }
                        >
                          {rawSeverity}
                        </Badge>
                        {offendingTarget ? (
                          <Button
                            onClick={handleJumpToOffendingNode}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            Jump to Offending Node →
                          </Button>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-fm-primary">
                        {detail.message ?? `${effectiveTitle} (${detail.condition})`}
                      </p>
                      {offendingTarget ? (
                        <p className="mt-1 text-xs text-fm-secondary">
                          Target: {offendingTarget.label} ({offendingTarget.kind})
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-xs text-fm-secondary">
                      No diagnostic findings match the selected severity filter (
                      {draft.severityFilter}).
                    </p>
                  ),
              },
              {
                type: "readonly" as const,
                label: "Resource key",
                mono: true,
                format: () => detail.key,
              },
              {
                type: "readonly" as const,
                label: "Owner",
                mono: true,
                format: () => ownerIdentity(detail.owner),
              },
              ...(detail.revision !== null
                ? [
                    {
                      type: "readonly" as const,
                      label: "Revision",
                      format: () => String(detail.revision),
                    },
                  ]
                : []),
              {
                type: "readonly" as const,
                label: "Condition",
                format: () => detail.condition,
              },
              {
                type: "readonly" as const,
                label: "Source state",
                format: () => detail.sourceStatus,
              },
            ]
          : [
              {
                type: "custom" as const,
                wide: true,
                render: (ctx: InspectorActionContext<RuntimeViewDraft>) => {
                  const visible = diagnosticEntries.filter(
                    (entry) =>
                      ctx.draft.severityFilter === "all" ||
                      entry.severity === ctx.draft.severityFilter,
                  );
                  if (diagnosticEntries.length === 0) {
                    return (
                      <p className="text-xs text-fm-secondary">
                        Problem, Health, Capability, Solver, Mesh, Frequency-domain &amp; Performance categories update automatically from session telemetry.
                      </p>
                    );
                  }
                  if (visible.length === 0) {
                    return (
                      <p className="text-xs text-fm-secondary">
                        No diagnostic findings match severity filter &ldquo;{ctx.draft.severityFilter}&rdquo;.
                      </p>
                    );
                  }
                  return (
                    <div className="grid gap-1.5 text-xs">
                      {visible.map(({ id, detail: entryDetail, severity }) => {
                        const rawSuffix = id.startsWith("diagnostics:")
                          ? id.slice("diagnostics:".length)
                          : id.startsWith("diag:")
                            ? id.slice("diag:".length)
                            : null;
                        const candidateKind = rawSuffix
                          ? rawSuffix.startsWith("diagnostics.")
                            ? rawSuffix.replace(/_/g, "-")
                            : `diagnostics.${rawSuffix.replace(/_/g, "-")}`
                          : null;
                        const diagKind = (
                          candidateKind === "diagnostics.problem" ||
                          candidateKind === "diagnostics.health" ||
                          candidateKind === "diagnostics.capability" ||
                          candidateKind === "diagnostics.solver" ||
                          candidateKind === "diagnostics.mesh" ||
                          candidateKind === "diagnostics.frequency-domain" ||
                          candidateKind === "diagnostics.performance"
                            ? candidateKind
                            : "diagnostics.problem"
                        ) as
                          | "diagnostics.problem"
                          | "diagnostics.health"
                          | "diagnostics.capability"
                          | "diagnostics.solver"
                          | "diagnostics.mesh"
                          | "diagnostics.frequency-domain"
                          | "diagnostics.performance";
                        return (
                          <div
                            className="flex items-center justify-between gap-2 rounded border border-fm-border-subtle px-2 py-1.5"
                            key={id}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <Badge
                                  variant={
                                    severity === "error"
                                      ? "danger"
                                      : severity === "warning"
                                        ? "warning"
                                        : "default"
                                  }
                                >
                                  {severity}
                                </Badge>
                                <span className="truncate font-mono text-fm-primary">
                                  {entryDetail.key}
                                </span>
                              </div>
                              {entryDetail.message ? (
                                <p className="mt-0.5 truncate text-fm-secondary">
                                  {entryDetail.message}
                                </p>
                              ) : null}
                            </div>
                            <Button
                              size="sm"
                              type="button"
                              variant="ghost"
                              onClick={() =>
                                ctx.selectNode({
                                  kind: diagKind,
                                  label: entryDetail.key,
                                  nodeId: id,
                                  objectId: null,
                                  ref: {
                                    descriptorId: id,
                                    kind: diagKind,
                                    nodeId: id,
                                    resourceKey: entryDetail.key,
                                    type: "runtime-explorer",
                                  },
                                })
                              }
                            >
                              Inspect →
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  );
                },
              },
            ]),
      ],
    },
  ];

  if (detail && detail.facts.length > 0 && matchesSeverity) {
    sections.push({
      id: "evidence",
      title: "Evidence",
      icon: FileText,
      defaultOpen: true,
      rows: detail.facts.map((fact) => ({
        type: "readonly" as const,
        label: fact.label,
        format: () => fact.value,
      })),
    });
  }

  const spec: InspectorSpec<RuntimeViewDraft> = {
    id: specId,
    header: {
      breadcrumbs: [
        { id: "diagnostics", label: "Diagnostics" },
        { id: "leaf", label: selection.label ?? effectiveTitle },
      ],
      ...(offendingTarget
        ? {
            primaryHeaderAction: {
              label: "Jump to Offending Node →",
              icon: ArrowRight,
              onRun: handleJumpToOffendingNode,
            },
          }
        : {}),
    },
    identity: {
      domain: "study",
      icon: AlertTriangle,
      title: () => selection.label ?? effectiveTitle,
      kindLabel: "Runtime diagnostic",
      entityId: detail?.key,
      statePill: () => ({
        tone: toneFromCondition(detail?.condition ?? "ready"),
        label: detail?.contractGap ? "Contract gap" : detail?.condition ?? "Ready",
      }),
    },
    facts: () => [
      { id: "condition", label: "Condition", value: detail?.condition ?? "ready" },
      { id: "source", label: "Source state", value: detail?.sourceStatus ?? "ready" },
      ...(detail?.revision !== null && detail?.revision !== undefined
        ? [{ id: "rev", label: "Revision", value: `rev ${detail.revision}` }]
        : []),
    ],
    notices: () => notices,
    sections,
    commitBar: {
      mode: "readOnly",
      statusMessage: () => "Read-only runtime diagnostics · Auto-updates on scene changes",
    },
  };

  return (
    <RuntimeSpecRenderer
      draft={draft}
      onChange={setDraft}
      selection={selection}
      spec={spec}
    />
  );
}
