"use client";

import { useCallback, useState } from "react";
import { SessionPreviewViewport } from "@/modules/viewport-3d/public";
import { Button } from "@/shared/ui/Button";
import { SESSION_PREVIEW_PATH, SESSIONS_PATH } from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import type { SceneResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useResource } from "../resources/useResource";
import { sessionPreviewSelection } from "./sessionPreviewSelection";

export default function SessionPreviewShell({ sessionId }: { readonly sessionId: string }) {
  const { api, resources } = useKernel();
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.sessions.previews.scene(sessionId, { signal }),
    [api, sessionId],
  );
  const scene = useResource<SceneResource>({
    load,
    resourceKey: SESSION_PREVIEW_PATH.replace("{session_id}", encodeURIComponent(sessionId)),
    retryPolicy: null,
  });

  const close = async () => {
    setClosing(true);
    setError(null);
    try {
      await api.sessions.previews.close(sessionId);
    } catch (cause) {
      if (!(cause instanceof ControlRoomApiError && cause.status === 404)) {
        setError(cause instanceof Error ? cause.message : "Unable to close the preview.");
        setClosing(false);
        return;
      }
    }
    resources.invalidate(SESSIONS_PATH, `closed:${sessionId}`);
    if (sessionPreviewSelection.getSnapshot() === sessionId) {
      sessionPreviewSelection.close(sessionId);
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-instance-tabs] [role="tab"][aria-selected="true"]')?.focus());
    }
  };

  return (
    <section aria-label="Model preview" aria-labelledby={`fm-tab-${sessionId}`} className="flex h-full min-h-0 flex-col bg-fm-app"
      id="fm-session-preview" role="tabpanel">
      <header className="flex items-center justify-between gap-3 border-b border-fm-border bg-fm-surface px-4 py-2">
        <div>
          <h1 className="m-0 text-fm-sm font-semibold">{scene.data?.scene?.name ?? "Model preview"}</h1>
          <p className="m-0 text-fm-xs text-fm-secondary">Read only · Authored geometry</p>
        </div>
        <Button disabled={closing} onClick={() => void close()} size="sm" type="button" variant="secondary">
          Close preview
        </Button>
      </header>
      {error && <p role="alert" className="px-4 py-2">{error}</p>}
      {scene.status === "error"
        ? <p role="alert" className="px-4 py-2">This model preview is unavailable.</p>
        : scene.data
          ? <SessionPreviewViewport scene={scene.data} />
          : <p role="status" className="px-4 py-2">Loading model preview…</p>}
    </section>
  );
}
