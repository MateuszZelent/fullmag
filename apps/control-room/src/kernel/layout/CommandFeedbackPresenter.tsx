"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  type ToastVariant,
} from "@/shared/ui/Toast";

import type {
  CommandFeedbackController,
  CommandFeedbackNotice,
  CommandFeedbackTone,
} from "../commands/CommandFeedbackController";
import { useKernel } from "../KernelContext";
import { useCommandQueueResource } from "../resources/studyRuntimeResources";

const EMPTY_NOTICES: readonly CommandFeedbackNotice[] = Object.freeze([]);
const noopSubscribe = () => () => {};

const TONE_VARIANT: Record<CommandFeedbackTone, ToastVariant> = {
  error: "error",
  info: "default",
  success: "success",
  warning: "warning",
};

/** Errors stay longer so the user can follow the Diagnostics link. */
const TONE_DURATION_MS: Record<CommandFeedbackTone, number> = {
  error: 10_000,
  info: 6_000,
  success: 4_000,
  warning: 7_000,
};

function useCommandFeedbackNotices(
  controller: CommandFeedbackController | undefined,
): readonly CommandFeedbackNotice[] {
  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? noopSubscribe(),
    [controller],
  );
  const getSnapshot = useCallback(
    () => controller?.getSnapshot() ?? EMPTY_NOTICES,
    [controller],
  );
  // Server snapshot is empty so the first client render matches SSR.
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_NOTICES);
}

/**
 * Shell-level foreground presenter for kernel command feedback. It renders
 * only what `CommandFeedbackController` owns; command logic never renders UI.
 */
export function CommandFeedbackPresenter() {
  const kernel = useKernel();
  const controller = kernel.commandFeedback;
  const notices = useCommandFeedbackNotices(controller);
  const hasPendingBackendCommands = controller?.hasPendingBackendCommands() ?? false;
  const commandQueue = useCommandQueueResource({
    enabled: hasPendingBackendCommands,
  });
  const sessionScopeKey = kernel.commands.getSessionScopeKey() ?? null;
  useEffect(() => {
    if (commandQueue.status === "ready" && commandQueue.data) {
      controller?.observeCommandQueue(commandQueue.data, sessionScopeKey);
    }
  }, [commandQueue.data, commandQueue.status, controller, notices, sessionScopeKey]);

  const openDiagnostics = useCallback(() => {
    kernel.layout.setPanelVisible("bottom", true);
    kernel.layout.setFocusedSlot("panel-bottom");
    // Set the tab directly too: the footer may not be mounted yet to hear the event.
    kernel.layout.setBottomPanelTab("diagnostics");
    kernel.bus.emit("footer:tab-requested", {
      reason: "command-feedback",
      tab: "diagnostics",
    });
  }, [kernel]);

  if (!controller) return null;

  return (
    <ToastProvider label="Command feedback" swipeDirection="right">
      {notices.map((notice) => (
        <Toast
          data-command-id={notice.commandId}
          data-command-status={notice.status}
          duration={TONE_DURATION_MS[notice.tone]}
          key={notice.id}
          onOpenChange={(open) => {
            if (!open) controller.dismiss(notice.id);
          }}
          open
          type={notice.tone === "error" ? "foreground" : "background"}
          variant={TONE_VARIANT[notice.tone]}
        >
          <div className="fm-toast__body">
            <ToastTitle>
              {notice.title}
              {notice.repeatCount > 1 ? (
                <span className="fm-toast__repeat">{` ×${notice.repeatCount}`}</span>
              ) : null}
            </ToastTitle>
            <ToastDescription>{notice.message}</ToastDescription>
          </div>
          <div className="fm-toast__actions">
            {notice.tone === "error" || notice.tone === "warning" ? (
              <ToastAction
                altText="Open command diagnostics in the bottom panel"
                onClick={openDiagnostics}
              >
                Diagnostics
              </ToastAction>
            ) : null}
            <ToastClose />
          </div>
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
