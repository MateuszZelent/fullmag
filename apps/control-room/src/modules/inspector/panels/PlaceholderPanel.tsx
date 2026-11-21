"use client";

import { Compass, Info } from "lucide-react";
import { useMemo } from "react";

import type { InspectorPanelProps } from "../inspectorTypes";
import { InspectorTemplate, type InspectorSpec } from "../template";

interface FallbackDraft {
  readonly kind: string;
  readonly label: string;
  readonly nodeId: string | null;
  readonly source: string | null;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

export function PlaceholderPanel({ selection }: InspectorPanelProps) {
  const draft: FallbackDraft = useMemo(
    () => ({
      kind: selection.kind ?? "selection",
      label: selection.label ?? "Selected node",
      nodeId: selection.nodeId,
      source: selection.moduleSource,
    }),
    [selection.kind, selection.label, selection.moduleSource, selection.nodeId],
  );

  const spec = useMemo<InspectorSpec<FallbackDraft>>(
    () => ({
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Read-only selection summary",
      },
      details: (current) => [
        { label: "Selection kind", mono: true, value: current.kind },
        { label: "Explorer node", mono: true, value: current.nodeId },
        { label: "Source module", mono: false, value: current.source },
      ],
      facts: () => [],
      header: {
        breadcrumbs: [{ id: "inspector:fallback", label: draft.label }],
        searchable: false,
      },
      id: "inspector.fallback",
      identity: {
        domain: "definition",
        entityId: selection.nodeId ?? undefined,
        icon: Compass,
        kindLabel: "Selection",
        statePill: () => ({ label: "Unmapped", tone: "neutral" }),
        title: (current) => current.label,
      },
      notices: (current) => [
        {
          id: "unregistered-selection-kind",
          text: `No dedicated Inspector specification is registered for selection kind "${current.kind}".`,
          title: "No dedicated inspector registered",
          tone: "info",
        },
      ],
      sections: [
        {
          defaultOpen: true,
          emptyState: () => ({
            description:
              "Choose a model, mesh, physics, study, or result node in the Explorer tree to inspect its properties.",
            icon: Info,
            title: "No editable properties for this selection",
          }),
          icon: Info,
          id: "fallback-overview",
          rows: [],
          title: "Selection details",
        },
      ],
    }),
    [draft.label, selection.nodeId],
  );

  return (
    <div
      className="fm-unsupported-inspector"
      data-inspector-owner="inspector.fallback"
    >
      <InspectorTemplate
        baseline={draft}
        dirtyFields={EMPTY_SET}
        draft={draft}
        invalidFields={EMPTY_MAP}
        selection={selection}
        spec={spec}
        touchedFields={EMPTY_SET}
        onFieldChange={() => undefined}
        onFieldTouch={() => undefined}
        onRevertField={() => undefined}
      />
    </div>
  );
}
