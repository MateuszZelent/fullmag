"use client";

import { useCallback, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import type { WorkspaceItemsQuery } from "@/kernel/api/apiTypes";
import type { ApiWorkspaceItem } from "@/kernel/api/workspaceItems";
import { useWorkspaceItemsResource } from "@/kernel/resources/workspaceItemsResource";
import type { KernelApi } from "@/kernel/types";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

export const WORKSPACE_RESULTS_FOLDERS_LIMIT = 500;

export const WORKSPACE_RESULTS_FOLDERS_QUERY: WorkspaceItemsQuery = {
  kind: "result",
  sort: "last_used",
  limit: WORKSPACE_RESULTS_FOLDERS_LIMIT,
  includeMissing: true,
};

type WorkspaceResultsFoldersProps = {
  kernel: KernelApi;
};

function folderName(item: ApiWorkspaceItem): string {
  const name = item.name.trim();
  if (name) return name;
  const path = item.path.trim();
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path || item.id;
}

function unavailableReason(item: ApiWorkspaceItem): string | null {
  switch (item.status) {
    case "missing":
      return "Source unavailable: the registered folder is missing.";
    case "failed":
      return "Source unavailable: the registered folder could not be read.";
    case "migrate":
      return "Source unavailable: the registered folder requires migration.";
    default:
      return null;
  }
}

export function WorkspaceResultsFolders({ kernel }: WorkspaceResultsFoldersProps) {
  const workspace = useWorkspaceItemsResource(WORKSPACE_RESULTS_FOLDERS_QUERY);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const openFolder = useCallback(
    async (item: ApiWorkspaceItem) => {
      setOpeningId(item.id);
      setActionError(null);
      setActionMessage(null);
      try {
        const result = await kernel.commands.execute(
          "workspace.open-results-folder",
          createCommandContext("explorer", kernel, {
            sourceDetail: "results-saved-workspace-folders",
            feedback: "local",
          }),
          { itemId: item.id, name: folderName(item) },
        );
        if (result.status === "completed") {
          setActionMessage(result.message ?? "Saved results opened read only.");
        } else {
          setActionError(result.message ?? "Could not open the saved results folder.");
        }
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "Could not open the saved results folder.",
        );
      } finally {
        setOpeningId(null);
      }
    },
    [kernel],
  );

  const resultFolders = workspace.state.kind === "ready"
    ? workspace.state.list.items.filter((item) => item.kind === "result")
    : [];

  return (
    <section aria-label="Workspace result folders" className="grid min-w-0 gap-2 border-b border-fm-subtle p-3">
      <header className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="m-0 min-w-0 truncate text-fm-md font-semibold text-fm-primary">
            Workspace result folders
          </h2>
          <Badge variant="secondary">workspace</Badge>
        </div>
        <p className="m-0 text-fm-xs text-fm-muted">
          Registered result folders are separate from project SolutionSet revisions.
        </p>
        <p className="m-0 text-fm-xs text-fm-muted">
          Showing up to {WORKSPACE_RESULTS_FOLDERS_LIMIT} registered result folders.
        </p>
      </header>

      {workspace.state.kind === "loading" ? (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">
          Loading workspace result folders…
        </p>
      ) : null}
      {workspace.state.kind === "error" ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          Could not load workspace result folders: {workspace.state.message}
        </p>
      ) : null}
      {workspace.state.kind === "unavailable" ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          Workspace result folders unavailable: {workspace.state.reason}
        </p>
      ) : null}
      {workspace.state.kind === "ready" && resultFolders.length === 0 ? (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">
          No registered workspace result folders.
        </p>
      ) : null}
      {actionError ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          {actionError}
        </p>
      ) : null}
      {actionMessage ? (
        <p className="m-0 text-fm-xs text-fm-accent" role="status">
          {actionMessage}
        </p>
      ) : null}

      {resultFolders.length > 0 ? (
        <ul className="m-0 grid min-w-0 list-none gap-1 p-0" aria-label="Registered workspace result folders">
          {resultFolders.map((item) => {
            const name = folderName(item);
            const sourceError = unavailableReason(item);
            const isOpening = openingId === item.id;
            return (
              <li
                className="grid min-w-0 gap-1 border border-fm-subtle p-2"
                data-workspace-result-id={item.id}
                key={item.id}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium" title={item.path}>{name}</span>
                  <Badge variant="secondary">{item.status}</Badge>
                </div>
                <p className="m-0 min-w-0 truncate text-fm-xs text-fm-muted" title={item.path}>
                  {item.path}
                </p>
                {sourceError ? (
                  <p className="m-0 text-fm-xs text-fm-danger" role="alert">
                    {sourceError}
                  </p>
                ) : null}
                <Button
                  aria-label={`Open ${name}`}
                  className="min-w-0 max-w-full justify-self-start"
                  disabled={sourceError !== null || openingId !== null}
                  size="sm"
                  title={name}
                  type="button"
                  variant="secondary"
                  onClick={() => void openFolder(item)}
                >
                  {isOpening ? "Opening…" : "Open folder"}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
