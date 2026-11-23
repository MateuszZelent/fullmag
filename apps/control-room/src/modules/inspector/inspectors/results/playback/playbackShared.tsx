"use client";

import {
  Download,
  ExternalLink,
  FileOutput,
  GitCommit,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
} from "react";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { Button } from "@/shared/ui/Button";
import { EmptyState } from "@/shared/ui/EmptyState";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorSpec } from "../../../template";
import { FrequencyDomainExportsInspectorPanel } from "../frequency-domain";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import type { PostprocessingInspectorModel } from "../../../panels/physics-first/postprocessingInspectorModel";

export interface EmptyPostprocessingDraft {
  componentIndex: string;
}

export const DEFAULT_POSTPROCESSING_DRAFT: EmptyPostprocessingDraft = {
  componentIndex: "0",
};

const LEGACY_UNPUBLISHED_TOKEN_RE = /^(?:unavail\w*|unkn\w*|n\/a)$/i;

function sanitizePlaceholderText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const trimmed = value.trim();
  if (!trimmed || LEGACY_UNPUBLISHED_TOKEN_RE.test(trimmed)) {
    return "—";
  }
  return value;
}

export function scopeForPostprocessingSelection(
  selection: InspectorPanelProps["selection"],
): "definition" | "root" {
  return selection.ref?.type === "postprocessing"
    ? selection.ref.scope
    : selection.kind?.endsWith(".root")
      ? "root"
      : "definition";
}

function copyTextArtifact(payload: string): void {
  void navigator.clipboard?.writeText(payload).catch(() => undefined);
}

export function PostprocessingModelInspectorView({
  emptyDescription,
  emptyTitle,
  hostFrequencyDomainExports = false,
  icon,
  idPrefix,
  model,
  scope,
  selection,
}: {
  emptyDescription?: string;
  emptyTitle?: string;
  hostFrequencyDomainExports?: boolean;
  icon: InspectorSpec<EmptyPostprocessingDraft>["identity"]["icon"];
  idPrefix: string;
  model: PostprocessingInspectorModel;
  scope: "definition" | "root";
  selection: InspectorPanelProps["selection"];
}) {
  const kernel = useContext(KernelContext);
  const postRef = selection.ref?.type === "postprocessing" ? selection.ref : null;
  const fdRef = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const isPublished = model.status.availability === "available";

  const openInAnalysis = useCallback(() => {
    kernel?.layout?.setActiveViewportMainModule?.("analysis-plots");
    kernel?.layout?.setFocusedSlot?.("viewport-main");
    if (kernel) {
      void kernel.commands.execute(
        "workspace.focus-selection",
        createCommandContext("inspector", kernel),
      );
    }
  }, [kernel]);

  const exportFormatPayload = useCallback(
    (format: "csv" | "json" | "parquet") => {
      const record = {
        breadcrumbs: model.breadcrumbs,
        export_format: format,
        node_id: selection.nodeId,
        owner: postRef ? `${postRef.ownerKind ?? ""}:${postRef.ownerId ?? ""}` : null,
        properties: Object.fromEntries(
          model.properties.map((p) => [p.label, sanitizePlaceholderText(p.value)]),
        ),
        provenance: Object.fromEntries(
          model.provenance.map((p) => [p.label, sanitizePlaceholderText(p.value)]),
        ),
        resource_ref: postRef?.resourceRef ?? fdRef?.resourceRef ?? null,
        title: model.title,
      };
      if (format === "csv") {
        const lines = [
          "section,field,value",
          ...model.properties.map(
            (p) => `"property","${p.label}","${sanitizePlaceholderText(p.value)}"`,
          ),
          ...model.provenance.map(
            (p) => `"provenance","${p.label}","${sanitizePlaceholderText(p.value)}"`,
          ),
        ];
        copyTextArtifact(lines.join("\n"));
        return;
      }
      copyTextArtifact(JSON.stringify(record, null, 2));
    },
    [fdRef?.resourceRef, model, postRef, selection.nodeId],
  );

  const spec = useMemo<InspectorSpec<EmptyPostprocessingDraft>>(
    () => ({
      id: `${idPrefix}:${selection.nodeId ?? scope}`,
      header: {
        breadcrumbs: model.breadcrumbs.map((b, i) => ({ id: `b-${i}`, label: b })),
        ...(kernel
          ? {
              primaryHeaderAction: {
                label: "Open in Analysis",
                icon: ExternalLink,
                onRun: () => openInAnalysis(),
              },
            }
          : {}),
        extraMenuActions: [
          {
            id: "export-csv",
            label: "Export CSV Metadata",
            icon: Download,
            onSelect: () => exportFormatPayload("csv"),
          },
          {
            id: "export-json",
            label: "Export JSON Manifest",
            icon: Download,
            onSelect: () => exportFormatPayload("json"),
          },
          {
            id: "export-parquet",
            label: "Copy Parquet Descriptor",
            icon: FileOutput,
            onSelect: () => exportFormatPayload("parquet"),
          },
        ],
      },
      identity: {
        domain: "physics",
        icon,
        title: () => model.title,
        kindLabel: `${model.physicalLabel} · ${model.methodLabel}`,
        entityId: postRef?.ownerId ?? selection.nodeId ?? undefined,
        statePill: () => ({
          tone: isPublished ? "ok" : "neutral",
          label: isPublished ? "Published" : sanitizePlaceholderText(model.status.execution),
        }),
      },
      facts: () => [
        { id: "scope", label: "Scope", value: scope },
        {
          id: "resource",
          label: "Resource",
          value: sanitizePlaceholderText(model.status.resource),
        },
        {
          id: "freshness",
          label: "Freshness",
          value: sanitizePlaceholderText(postRef?.freshness ?? "indexed"),
        },
      ],
      notices: () =>
        model.diagnostics.map((text, idx) => ({
          id: `diag-${idx}`,
          tone: "warn" as const,
          text,
        })),
      sections: [
        ...(hostFrequencyDomainExports &&
        kernel &&
        (fdRef !== null ||
          selection.kind === "results.frequency_domain.exports" ||
          Boolean(selection.nodeId?.includes("frequency-domain")))
          ? [
              {
                id: "fd-exports",
                title: "Frequency-Domain Export Bundle",
                icon: FileOutput,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <FrequencyDomainExportsInspectorPanel selection={selection} />
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "properties",
          title: scope === "root" ? `${model.title} Catalog` : "Definition Properties",
          icon,
          defaultOpen: true,
          rows: [
            ...(scope === "root" && !postRef && emptyTitle && emptyDescription
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <EmptyState
                        description={emptyDescription}
                        heading={emptyTitle}
                        size="compact"
                      />
                    ),
                  },
                ]
              : []),
            ...(postRef
              ? [
                  {
                    type: "readonly" as const,
                    label: "Owner resource state",
                    format: () => model.status.resource,
                  },
                ]
              : []),
            ...model.properties.map((prop) => ({
              type: "readonly" as const,
              label: prop.label,
              mono: prop.mono,
              format: () => sanitizePlaceholderText(prop.value),
            })),
            {
              type: "readonly" as const,
              label: "Action policy",
              format: () => model.actionLabel,
            },
            {
              type: "custom" as const,
              wide: true,
              render: () => (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Postprocessing actions">
                  <Button
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={openInAnalysis}
                  >
                    <ExternalLink aria-hidden="true" size={13} />
                    <span>Open in Analysis</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => exportFormatPayload("csv")}
                  >
                    <Download aria-hidden="true" size={13} />
                    <span>Export CSV</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => exportFormatPayload("json")}
                  >
                    <Download aria-hidden="true" size={13} />
                    <span>Export JSON</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => exportFormatPayload("parquet")}
                  >
                    <FileOutput aria-hidden="true" size={13} />
                    <span>Export Parquet</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "provenance",
          title: "Provenance & Revisions",
          icon: GitCommit,
          defaultOpen: scope === "definition",
          rows: [
            ...model.provenance.map((prop) => ({
              type: "readonly" as const,
              label: prop.label,
              mono: prop.mono,
              format: () => sanitizePlaceholderText(prop.value),
            })),
            {
              type: "readonly" as const,
              label: "Selection source",
              format: () => selection.moduleSource,
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      emptyDescription,
      emptyTitle,
      exportFormatPayload,
      fdRef,
      hostFrequencyDomainExports,
      icon,
      idPrefix,
      isPublished,
      kernel,
      model,
      openInAnalysis,
      postRef,
      scope,
      selection,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_POSTPROCESSING_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
