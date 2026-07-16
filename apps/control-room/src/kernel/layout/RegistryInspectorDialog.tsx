"use client";

import { X } from "lucide-react";
import { useCallback, useState } from "react";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { ObjectVisualizationSnapshot } from "@/kernel/visualization/ObjectVisualizationController";
import type { VisualizationRegistrySyncSnapshot } from "@/kernel/visualization/VisualizationRegistrySyncController";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

// ── Primitive JSON tree renderer ──────────────────────────────────────────────

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function JsonLeaf({ value }: { value: string | number | boolean | null }) {
  if (value === null) {
    return <span className="fm-registry-tree__null">null</span>;
  }
  if (typeof value === "boolean") {
    return (
      <span className="fm-registry-tree__bool">{String(value)}</span>
    );
  }
  if (typeof value === "number") {
    return <span className="fm-registry-tree__number">{String(value)}</span>;
  }
  return (
    <span className="fm-registry-tree__string">
      &quot;{value}&quot;
    </span>
  );
}

function JsonNode({
  value,
  label,
  depth = 0,
  defaultOpen = false,
}: {
  value: JsonValue;
  label: string;
  depth?: number;
  defaultOpen?: boolean;
}) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return (
      <div className="fm-registry-tree__row" data-depth={depth}>
        <span className="fm-registry-tree__key">{label}:</span>
        <JsonLeaf value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as JsonValue[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, JsonValue>);
  const count = entries.length;
  const bracket = isArray ? ["[", "]"] : ["{", "}"];

  if (count === 0) {
    return (
      <div className="fm-registry-tree__row" data-depth={depth}>
        <span className="fm-registry-tree__key">{label}:</span>
        <span className="fm-registry-tree__empty">
          {bracket[0]}{bracket[1]}
        </span>
      </div>
    );
  }

  return (
    <details
      className="fm-registry-tree__node"
      open={defaultOpen}
    >
      <summary className="fm-registry-tree__summary" data-depth={depth}>
        <span className="fm-registry-tree__key">{label}</span>
        <span className="fm-registry-tree__bracket">{bracket[0]}</span>
        <span className="fm-registry-tree__compact">
          <span className="fm-registry-tree__count">{count}</span>
          <span className="fm-registry-tree__bracket">{bracket[1]}</span>
        </span>
      </summary>
      <div className="fm-registry-tree__children" data-depth={depth}>
        {entries.map(([k, v]) => (
          <JsonNode
            key={k}
            depth={depth + 1}
            defaultOpen={depth < 1}
            label={k}
            value={v as JsonValue}
          />
        ))}
      </div>
      <div className="fm-registry-tree__close-bracket" data-depth={depth}>
        <span className="fm-registry-tree__bracket">{bracket[1]}</span>
      </div>
    </details>
  );
}

// ── Dialog ────────────────────────────────────────────────────────────────────

interface RegistryInspectorDialogProps {
  open: boolean;
  snapshot: ObjectVisualizationSnapshot;
  syncSnapshot: VisualizationRegistrySyncSnapshot;
  visualizationState: VisualizationStateResource | null | undefined;
  onOpenChange: (open: boolean) => void;
  onRetryMutation: () => void;
}

export function RegistryInspectorDialog({
  open,
  snapshot,
  syncSnapshot,
  visualizationState,
  onOpenChange,
  onRetryMutation,
}: RegistryInspectorDialogProps) {
  const [tab, setTab] = useState<"local" | "backend">("backend");

  const handleTabLocal = useCallback(() => setTab("local"), []);
  const handleTabBackend = useCallback(() => setTab("backend"), []);

  const localData: JsonValue = {
    version: snapshot.version,
    defaults: snapshot.defaults as unknown as JsonValue,
    overrides: snapshot.overrides as unknown as JsonValue,
    sync: {
      error: syncSnapshot.error?.message ?? null,
      inflightPatch: syncSnapshot.inflightPatch as unknown as JsonValue,
      lastLocalChangedAt: syncSnapshot.lastLocalChangedAt,
      lastRemoteRevision: syncSnapshot.lastRemoteRevision,
      mutation: syncSnapshot.mutation as unknown as JsonValue,
      pendingFingerprint: syncSnapshot.pendingFingerprint,
      pendingPatch: syncSnapshot.pendingPatch as unknown as JsonValue,
      version: syncSnapshot.version,
    },
  };

  const backendData: JsonValue = visualizationState
    ? {
        revision: visualizationState.revision,
        targets: (visualizationState.targets ?? null) as unknown as JsonValue,
        state: visualizationState as unknown as JsonValue,
      }
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fm-registry-inspector" aria-describedby="fm-registry-inspector-description">
        <DialogHeader>
          <DialogTitle>Visualization Registry</DialogTitle>
          <DialogDescription id="fm-registry-inspector-description" className="fm-visually-hidden">
            Inspect local and backend visualization state.
          </DialogDescription>
          <DialogClose asChild>
            <button
              aria-label="Close registry inspector"
              className="fm-registry-inspector__close"
              type="button"
            >
              <X size={16} />
            </button>
          </DialogClose>
        </DialogHeader>

        <div className="fm-registry-inspector__tabs" role="tablist">
          <button
            aria-selected={tab === "local"}
            className="fm-registry-inspector__tab"
            data-active={tab === "local"}
            role="tab"
            type="button"
            onClick={handleTabLocal}
          >
            Local pending
            <span className="fm-registry-inspector__tab-badge">
              v{snapshot.version}
            </span>
          </button>
          <button
            aria-selected={tab === "backend"}
            className="fm-registry-inspector__tab"
            data-active={tab === "backend"}
            role="tab"
            type="button"
            onClick={handleTabBackend}
          >
            Effective registry
            {visualizationState?.revision !== undefined && (
              <span className="fm-registry-inspector__tab-badge">
                r{visualizationState.revision}
              </span>
            )}
          </button>
        </div>

        <div className="fm-registry-inspector__body">
          {syncSnapshot.mutation?.status === "rejected" ? (
            <div className="fm-registry-inspector__mutation-error" role="alert">
              <strong>Visualization update rejected</strong>
              <span>Target: {syncSnapshot.mutation.targetId}</span>
              <span>{syncSnapshot.mutation.error}</span>
              {syncSnapshot.mutation.requestId ? (
                <span>Request: {syncSnapshot.mutation.requestId}</span>
              ) : null}
              <button onClick={onRetryMutation} type="button">
                Retry exact update
              </button>
            </div>
          ) : null}
          <div className="fm-registry-tree" role="tabpanel">
            {tab === "local" ? (
              <JsonNode
                defaultOpen
                depth={0}
                label="snapshot"
                value={localData}
              />
            ) : (
              <JsonNode
                defaultOpen
                depth={0}
                label="visualizationState"
                value={backendData}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
