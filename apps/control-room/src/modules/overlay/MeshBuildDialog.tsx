"use client";

import { useEffect, useState } from "react";

import {
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
} from "@/kernel/resources/geometryLifecycleResources";
import type { KernelApi } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = "unknown"): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function commandIsMeshBuild(commandId: string): boolean {
  return commandId === "mesh.build-selected" || commandId === "mesh.build-shared-domain";
}

export function MeshBuildDialog({ kernel }: { kernel: KernelApi }) {
  const [open, setOpen] = useState(false);
  const [lastCommandId, setLastCommandId] = useState<string | null>(null);
  const [lastCommandStatus, setLastCommandStatus] = useState<string>("pending");
  const activeBuild = useMeshBuildCurrent();
  const latestBuild = useMeshBuildLatestSuccessful();
  const summary = useMeshSummaryResource();
  const manifest = useMeshSharedDomainManifestResource();
  const activeRecord = asRecord(activeBuild.data?.active_build);
  const pipelineRecord = asRecord(activeBuild.data?.mesh_pipeline_status);
  const lastSummary = asRecord(
    activeBuild.data?.last_build_summary ?? latestBuild.data?.last_success,
  );
  const buildReport = activeBuild.data?.shared_domain_build_report;

  useEffect(() => {
    const offSubmitted = kernel.bus.on("command:submitted", ({ commandId }) => {
      if (!commandIsMeshBuild(commandId)) return;
      setLastCommandId(commandId);
      setLastCommandStatus("submitted");
      setOpen(true);
    });
    const offCompleted = kernel.bus.on("command:completed", ({ commandId, status }) => {
      if (!commandIsMeshBuild(commandId)) return;
      setLastCommandId(commandId);
      setLastCommandStatus(status);
      setOpen(true);
    });
    return () => {
      offSubmitted();
      offCompleted();
    };
  }, [kernel.bus]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby="fm-mesh-build-dialog-description">
        <DialogHeader>
          <DialogTitle>Mesh Build</DialogTitle>
          <DialogDescription id="fm-mesh-build-dialog-description">
            Backend v2 command status, current build resource, and last successful mesh.
          </DialogDescription>
        </DialogHeader>
        <div className="fm-dialog__body">
          <dl className="fm-dialog__details">
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Command</dt>
              <dd className="fm-dialog__details-value">{lastCommandId ?? "none"}</dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Command state</dt>
              <dd className="fm-dialog__details-value">{lastCommandStatus}</dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Build resource</dt>
              <dd className="fm-dialog__details-value">{activeBuild.status}</dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Active build</dt>
              <dd className="fm-dialog__details-value">
                {text(activeRecord?.status ?? pipelineRecord?.status, "idle")}
              </dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Mesh</dt>
              <dd className="fm-dialog__details-value">
                {manifest.data?.mesh_name ?? "not built"}
              </dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Revision</dt>
              <dd className="fm-dialog__details-value">
                {summary.data?.revision ?? activeBuild.data?.revision ?? "unknown"}
              </dd>
            </div>
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Last error</dt>
              <dd className="fm-dialog__details-value">
                {activeBuild.data?.last_build_error ??
                  latestBuild.data?.last_build_error ??
                  "none"}
              </dd>
            </div>
          </dl>

          <pre className="fm-dialog__mesh-log">
            {JSON.stringify(
              {
                active_build: activeBuild.data?.active_build ?? null,
                pipeline: activeBuild.data?.mesh_pipeline_status ?? null,
                shared_domain_build_report: buildReport ?? null,
                last_success: lastSummary,
              },
              null,
              2,
            )}
          </pre>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => setOpen(false)}
          >
            Keep Running
          </Button>
          <DialogClose asChild>
            <Button size="sm" type="button" variant="primary">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
