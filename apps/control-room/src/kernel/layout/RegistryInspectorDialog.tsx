"use client";

import { AlertTriangle, X } from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { KernelContext } from "@/kernel/KernelContext";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { ObjectVisualizationSnapshot } from "@/kernel/visualization/ObjectVisualizationController";
import type { VisualizationRegistrySyncSnapshot } from "@/kernel/visualization/VisualizationRegistrySyncController";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

export interface RegistryCommandSummary {
  readonly id: string;
  readonly title?: string;
  readonly category?: string;
  readonly shortcut?: string;
  readonly enabled?: boolean;
  readonly disabledReason?: string;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function depthIndentStyle(depth: number): CSSProperties {
  return {
    "--depth": String(depth),
    paddingInlineStart: `calc(${depth} * var(--fm-space-4))`,
  } as CSSProperties;
}

function JsonLeaf({ value }: { value: string | number | boolean | null }) {
  if (value === null) {
    return <span className="fm-registry-tree__null">null</span>;
  }
  if (typeof value === "boolean") {
    return <span className="fm-registry-tree__bool">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="fm-registry-tree__number">{String(value)}</span>;
  }
  return <span className="fm-registry-tree__string">&quot;{value}&quot;</span>;
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
  const indentStyle = depthIndentStyle(depth);

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return (
      <div className="fm-registry-tree__row" data-depth={depth} style={indentStyle}>
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
      <div className="fm-registry-tree__row" data-depth={depth} style={indentStyle}>
        <span className="fm-registry-tree__key">{label}:</span>
        <span className="fm-registry-tree__empty">
          {bracket[0]}
          {bracket[1]}
        </span>
      </div>
    );
  }

  return (
    <details className="fm-registry-tree__node" open={defaultOpen}>
      <summary className="fm-registry-tree__summary" data-depth={depth} style={indentStyle}>
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
            defaultOpen={depth < 8}
            label={k}
            value={v as JsonValue}
          />
        ))}
      </div>
      <div className="fm-registry-tree__close-bracket" data-depth={depth} style={indentStyle}>
        <span className="fm-registry-tree__bracket">{bracket[1]}</span>
      </div>
    </details>
  );
}

export interface RegistryInspectorDialogProps {
  open: boolean;
  snapshot: ObjectVisualizationSnapshot;
  syncSnapshot: VisualizationRegistrySyncSnapshot;
  visualizationState: VisualizationStateResource | null | undefined;
  commands?: readonly RegistryCommandSummary[];
  onOpenChange: (open: boolean) => void;
  onRetryMutation: () => void;
}

export function RegistryInspectorDialog({
  open,
  snapshot,
  syncSnapshot,
  visualizationState,
  commands,
  onOpenChange,
  onRetryMutation,
}: RegistryInspectorDialogProps) {
  const [tab, setTab] = useState<"local" | "backend" | "commands">("backend");
  const kernel = useContext(KernelContext);

  const handleTabChange = useCallback((value: string) => {
    if (value === "local" || value === "backend" || value === "commands") {
      setTab(value);
    }
  }, []);

  const subscribeCommands = useCallback(
    (listener: () => void) => {
      if (!open || !kernel || typeof kernel.commands?.subscribe !== "function") {
        return () => {};
      }
      return kernel.commands.subscribe(listener);
    },
    [kernel, open],
  );
  const commandVersion = useSyncExternalStore(
    subscribeCommands,
    () =>
      typeof kernel?.commands?.getVersion === "function"
        ? kernel.commands.getVersion()
        : 0,
    () => 0,
  );

  const resolvedCommands: readonly RegistryCommandSummary[] = useMemo(() => {
    if (commandVersion < 0) return [];
    if (commands) return commands;
    if (!kernel) return [];
    if (typeof kernel.commands?.all === "function") {
      const ctx = createCommandContext("inspector", kernel);
      return kernel.commands.all().map((cmd) => ({
        id: cmd.id,
        title: cmd.title,
        category: cmd.category,
        shortcut: cmd.shortcut,
        enabled:
          typeof kernel.commands.isEnabled === "function"
            ? kernel.commands.isEnabled(cmd.id, ctx)
            : true,
      }));
    }
    return (
      (
        kernel as unknown as {
          commands?: { list?: () => readonly RegistryCommandSummary[] };
        }
      )?.commands?.list?.() ?? []
    );
  }, [commandVersion, commands, kernel]);

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

  const backendData: JsonValue = (visualizationState ?? null) as unknown as JsonValue;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="fm-registry-inspector"
        aria-describedby="fm-registry-inspector-description"
      >
        <DialogHeader>
          <DialogTitle>Visualization Registry</DialogTitle>
          <DialogDescription
            id="fm-registry-inspector-description"
            className="fm-visually-hidden"
          >
            Inspect local and backend visualization state and registered shell commands.
          </DialogDescription>
          <DialogClose asChild>
            <Button
              aria-label="Close registry inspector"
              className="fm-registry-inspector__close"
              size="icon"
              type="button"
              variant="ghost"
            >
              <X size={16} />
            </Button>
          </DialogClose>
        </DialogHeader>

        <Tabs value={tab} onValueChange={handleTabChange}>
          <TabsList aria-label="Registry view" className="fm-registry-inspector__tabs">
            <TabsTrigger
              className="fm-registry-inspector__tab"
              data-active={tab === "local"}
              value="local"
            >
              Local pending
              <span className="fm-registry-inspector__tab-badge">v{snapshot.version}</span>
            </TabsTrigger>
            <TabsTrigger
              className="fm-registry-inspector__tab"
              data-active={tab === "backend"}
              value="backend"
            >
              Effective registry
              {visualizationState?.revision !== undefined && (
                <span className="fm-registry-inspector__tab-badge">
                  r{visualizationState.revision}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger
              className="fm-registry-inspector__tab"
              data-active={tab === "commands"}
              value="commands"
            >
              Registered Commands
              <span className="fm-registry-inspector__tab-badge">
                {resolvedCommands.length}
              </span>
            </TabsTrigger>
          </TabsList>

          <div className="fm-registry-inspector__body">
            {syncSnapshot.mutation?.status === "rejected" ? (
              <div
                className="fm-inspector-notice fm-inspector-notice--error"
                role="alert"
              >
                <AlertTriangle aria-hidden="true" size={14} />
                <div className="flex flex-col gap-1">
                  <strong>Visualization update rejected</strong>
                  <span>Target: {syncSnapshot.mutation.targetId}</span>
                  <span>{syncSnapshot.mutation.error}</span>
                  {syncSnapshot.mutation.requestId ? (
                    <span>Request: {syncSnapshot.mutation.requestId}</span>
                  ) : null}
                  <div>
                    <Button
                      onClick={onRetryMutation}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Retry exact update
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            <TabsContent className="fm-registry-tree" value="local">
              <JsonNode defaultOpen depth={0} label="snapshot" value={localData} />
            </TabsContent>
            <TabsContent className="fm-registry-tree" value="backend">
              <JsonNode
                defaultOpen
                depth={0}
                label="visualizationState"
                value={backendData}
              />
            </TabsContent>
            <TabsContent className="fm-registry-tree" value="commands">
              {resolvedCommands.length === 0 ? (
                <p className="text-xs text-fm-secondary">
                  No registered commands reported in this context.
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {resolvedCommands.map((cmd) => (
                    <div
                      className="fm-registry-tree__row justify-between"
                      key={cmd.id}
                    >
                      <span className="fm-registry-tree__key">
                        {cmd.title ? `${cmd.title} (${cmd.id})` : cmd.id}
                      </span>
                      <span className="flex items-center gap-2">
                        {cmd.shortcut ? (
                          <code className="text-xs text-fm-muted">{cmd.shortcut}</code>
                        ) : null}
                        <Badge variant={cmd.enabled === false ? "warning" : "success"}>
                          {cmd.enabled === false
                            ? cmd.disabledReason ?? "Disabled"
                            : "Enabled"}
                        </Badge>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
