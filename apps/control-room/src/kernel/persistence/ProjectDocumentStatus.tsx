"use client";

import { useSyncExternalStore } from "react";

import { useKernel } from "../KernelContext";
import {
  EMPTY_PROJECT_DOCUMENT_SNAPSHOT,
  type ProjectDocumentSnapshot,
} from "./ProjectDocumentController";

const NOOP_SUBSCRIBE = () => () => undefined;
const EMPTY_SNAPSHOT_READER = () => EMPTY_PROJECT_DOCUMENT_SNAPSHOT;

export function useProjectDocumentSnapshot() {
  const kernel = useKernel();
  const controller = kernel.projectDocument;
  return useSyncExternalStore(
    controller?.subscribe ?? NOOP_SUBSCRIBE,
    controller?.getSnapshot ?? EMPTY_SNAPSHOT_READER,
    EMPTY_SNAPSHOT_READER,
  );
}

export function ProjectDocumentStatus() {
  const snapshot = useProjectDocumentSnapshot();

  const label = projectStatusLabel(snapshot);
  return (
    <span
      aria-live="polite"
      className="fm-header__project-status"
      data-project-document-state={snapshot.state}
      title={snapshot.error ?? snapshot.fileName ?? label}
    >
      {label}
    </span>
  );
}

function projectStatusLabel(snapshot: ProjectDocumentSnapshot): string {
  switch (snapshot.state) {
    case "loading":
      return "Opening project…";
    case "error":
      return "Project error";
    case "empty":
      return "No project";
    case "ready":
      return snapshot.resource.dirty ? `${snapshot.resource.name} · unsaved` : snapshot.resource.name;
  }
}
