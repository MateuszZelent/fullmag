import type { ScriptBuilderStageState } from "@/lib/session/types";
import type { NodeStatus, TreeNodeData } from "./types";

interface ResultQuantity {
  id: string;
  label: string;
  kind: string;
  unit?: string | null;
}

interface ResultWorkspaceEntry {
  id: string;
  label: string;
  icon?: string;
  badge?: string | null;
  status?: NodeStatus;
  group?: "auto" | "pinned";
  createdAtUnixMs?: number;
}

export interface BuildResultRootTreeOptions {
  studyStages: ScriptBuilderStageState[];
  resultFieldQuantities: ResultQuantity[];
  resultScalarQuantities: ResultQuantity[];
  resultWorkspaceEntries: ResultWorkspaceEntry[];
  scalarRowCount?: number;
  eigenModeCount?: number | null;
  eigenModeSummaries?: { index: number; label: string }[];
  eigenHasDispersion?: boolean;
  hasVortexData?: boolean;
}

function mapAnalysisEntry(entry: ResultWorkspaceEntry): TreeNodeData {
  return {
    id: entry.id.startsWith("res-") ? entry.id : `res-analysis-${entry.id}`,
    label: entry.label,
    icon: entry.icon ?? "🧩",
    badge: entry.badge ?? undefined,
    status: entry.status ?? "ready",
  };
}

export function buildResultRootChildren(opts: BuildResultRootTreeOptions): TreeNodeData[] {
  const hasRunStage = opts.studyStages.some((stage) => stage.kind === "run");
  const hasRelaxStage = opts.studyStages.some((stage) => stage.kind === "relax");
  const hasEigenStage =
    opts.studyStages.some((stage) => stage.kind === "eigenmodes") ||
    Boolean(opts.eigenModeCount && opts.eigenModeCount > 0);
  const hasSaveStateStage = opts.studyStages.some((stage) => stage.kind === "save_state");
  const pinnedResultWorkspaces = opts.resultWorkspaceEntries
    .filter((entry) => entry.group !== "auto")
    .sort((a, b) => (b.createdAtUnixMs ?? 0) - (a.createdAtUnixMs ?? 0));
  const autoResultWorkspaces = opts.resultWorkspaceEntries
    .filter((entry) => entry.group === "auto")
    .sort((a, b) => (a.createdAtUnixMs ?? 0) - (b.createdAtUnixMs ?? 0));

  const resultFieldChildren: TreeNodeData[] =
    opts.resultFieldQuantities.length > 0
      ? opts.resultFieldQuantities.map((quantity) => ({
          id: `res-qty-${encodeURIComponent(quantity.id)}`,
          label: quantity.label,
          icon: "𝑓",
          badge: quantity.unit ? `${quantity.kind} · ${quantity.unit}` : quantity.kind,
          status: "ready",
        }))
      : [
          {
            id: "res-fields-empty",
            label: "No field quantities yet",
            icon: "◌",
            status: "pending",
          },
        ];
  const resultSolutionChildren: TreeNodeData[] = [
    ...(hasRunStage || hasRelaxStage
      ? [
          {
            id: "res-dataset-time-series",
            label: "Time-Dependent Fields",
            icon: "⏱",
            badge: opts.scalarRowCount ? `${opts.scalarRowCount} samples` : "pending",
            status: (opts.scalarRowCount && opts.scalarRowCount > 0 ? "ready" : "pending") as NodeStatus,
          },
          {
            id: "res-dataset-final-state",
            label: "Final State",
            icon: "◉",
            status: (opts.scalarRowCount && opts.scalarRowCount > 0 ? "ready" : "pending") as NodeStatus,
          },
        ]
      : []),
    ...(hasEigenStage
      ? [
          {
            id: "res-dataset-eigen-spectrum",
            label: "Eigen Spectrum",
            icon: "≈",
            status: (opts.eigenModeCount && opts.eigenModeCount > 0 ? "ready" : "pending") as NodeStatus,
            badge: opts.eigenModeCount ? `${opts.eigenModeCount} modes` : "pending",
          },
          ...(opts.eigenHasDispersion
            ? [
                {
                  id: "res-dataset-eigen-dispersion",
                  label: "Eigen Dispersion",
                  icon: "∿",
                  status: "ready" as const,
                },
              ]
            : []),
        ]
      : []),
    ...(hasSaveStateStage
      ? [
          {
            id: "res-dataset-checkpoints",
            label: "Saved States",
            icon: "💾",
            status: "ready" as const,
          },
        ]
      : []),
  ];
  const resultDatasetChildren: TreeNodeData[] = [
    {
      id: "res-dataset-study-1",
      label: "Study 1",
      icon: "Σ",
      status: "ready" as const,
      children: [
        {
          id: "res-dataset-solution-1",
          label: "Solution 1",
          icon: "◉",
          badge: opts.scalarRowCount ? `${opts.scalarRowCount} samples` : "pending",
          status:
            opts.scalarRowCount && opts.scalarRowCount > 0
              ? "ready"
              : hasEigenStage
                ? "ready"
                : "pending" as NodeStatus,
          children:
            resultSolutionChildren.length > 0
              ? resultSolutionChildren
              : [
                  {
                    id: "res-dataset-empty",
                    label: "No solution outputs yet",
                    icon: "◌",
                    status: "pending",
                  },
                ],
        },
      ],
    },
  ];
  const resultScalarChildren: TreeNodeData[] =
    opts.resultScalarQuantities.length > 0
      ? opts.resultScalarQuantities.map((quantity) => ({
          id: `res-qty-${encodeURIComponent(quantity.id)}`,
          label: quantity.label,
          icon: "Σ",
          badge: quantity.unit ? `${quantity.kind} · ${quantity.unit}` : quantity.kind,
          status: "ready",
        }))
      : [
          {
            id: "res-scalars-empty",
            label: "No derived scalars yet",
            icon: "◌",
            status: "pending",
          },
        ];

  return [
    {
      id: "res-overview",
      label: "Overview",
      icon: "🧭",
      badge: opts.scalarRowCount ? `${opts.scalarRowCount} samples` : "pending",
      status: opts.scalarRowCount && opts.scalarRowCount > 0 ? "ready" : "pending",
    },
    {
      id: "res-datasets",
      label: "Datasets",
      icon: "🧱",
      status: opts.scalarRowCount && opts.scalarRowCount > 0 ? "ready" : "pending",
      children: resultDatasetChildren,
    },
    {
      id: "res-fields",
      label: "Field Quantities",
      icon: "🗂",
      status: opts.resultFieldQuantities.length > 0 ? "ready" : "pending",
      badge: opts.resultFieldQuantities.length > 0 ? `${opts.resultFieldQuantities.length}` : undefined,
      children: resultFieldChildren,
    },
    {
      id: "res-energy",
      label: "Derived Scalars",
      icon: "⚡",
      status: opts.resultScalarQuantities.length > 0 ? "ready" : "pending",
      badge: opts.resultScalarQuantities.length > 0 ? `${opts.resultScalarQuantities.length}` : undefined,
      children: resultScalarChildren,
    },
    {
      id: "res-analyses",
      label: "Analyses",
      icon: "🧠",
      status: opts.resultWorkspaceEntries.length > 0 ? "ready" : "pending",
      badge: opts.resultWorkspaceEntries.length > 0 ? `${opts.resultWorkspaceEntries.length}` : undefined,
      children:
        opts.resultWorkspaceEntries.length > 0
          ? [
              ...(pinnedResultWorkspaces.length > 0
                ? [
                    {
                      id: "res-analyses-pinned",
                      label: "Pinned",
                      icon: "📌",
                      badge: `${pinnedResultWorkspaces.length}`,
                      status: "ready" as const,
                      children: pinnedResultWorkspaces.map(mapAnalysisEntry),
                    },
                  ]
                : []),
              ...(autoResultWorkspaces.length > 0
                ? [
                    {
                      id: "res-analyses-auto",
                      label: "Auto",
                      icon: "⚙",
                      badge: `${autoResultWorkspaces.length}`,
                      status: "ready" as const,
                      children: autoResultWorkspaces.map(mapAnalysisEntry),
                    },
                  ]
                : []),
            ]
          : [
              {
                id: "res-analyses-empty",
                label: "No custom analyses yet",
                icon: "◌",
                status: "pending",
              },
            ],
    },
    { id: "res-state-io", label: "Session I/O", icon: "💾" },
    { id: "res-export", label: "Export", icon: "💾" },
    ...(opts.eigenModeCount && opts.eigenModeCount > 0
      ? [
          {
            id: "res-eigenmodes",
            label: "Eigenmodes",
            icon: "〜",
            badge: `${opts.eigenModeCount} modes`,
            status: "ready" as const,
            defaultOpen: false,
            children: [
              {
                id: "res-eigenmodes-summary",
                label: "Summary",
                icon: "📋",
                status: "ready" as const,
              },
              {
                id: "res-eigenmodes-spectrum",
                label: "Spectrum",
                icon: "📊",
                status: "ready" as const,
              },
              ...(opts.eigenHasDispersion
                ? [{
                    id: "res-eigenmodes-dispersion",
                    label: "Dispersion",
                    icon: "≈",
                    status: "ready" as const,
                  }]
                : []),
              ...(opts.eigenModeSummaries ?? []).map((mode) => ({
                id: `res-eigenmode-${mode.index}`,
                label: mode.label,
                icon: "〜",
                status: "ready" as const,
              })),
            ],
          },
        ]
      : []),
    ...(opts.hasVortexData
      ? [
          {
            id: "res-vortex",
            label: "Vortex / STNO",
            icon: "🌀",
            badge: opts.scalarRowCount ? `${opts.scalarRowCount} pts` : undefined,
            status: "ready" as const,
            defaultOpen: false,
            children: [
              {
                id: "res-time-traces",
                label: "Time Traces",
                icon: "📈",
                status: "ready" as const,
                children: [
                  {
                    id: "res-time-trace-mx",
                    label: "mₓ(t)",
                    icon: "〰",
                    status: "ready" as const,
                  },
                  {
                    id: "res-time-trace-my",
                    label: "m_y(t)",
                    icon: "〰",
                    status: "ready" as const,
                  },
                  {
                    id: "res-time-trace-mz",
                    label: "mᵤ(t)",
                    icon: "〰",
                    status: "ready" as const,
                  },
                ],
              },
              {
                id: "res-vortex-frequency",
                label: "FFT / PSD",
                icon: "📊",
                status: "ready" as const,
              },
              {
                id: "res-vortex-trajectory",
                label: "Trajectory (mₓ vs m_y)",
                icon: "◎",
                status: "ready" as const,
              },
              {
                id: "res-vortex-orbit",
                label: "Orbit Amplitude",
                icon: "◉",
                status: "ready" as const,
              },
            ],
          },
        ]
      : []),
  ];
}
