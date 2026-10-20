"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useRuntimeCommandControlResourceData } from "@/kernel/resources/studyRuntimeResources";

/**
 * The existing workspace Compute command (`studyRuntimeCommandContributions`).
 * The awaiting-Compute call to action only invokes it; it never submits a
 * solve on its own and never bypasses the command's readiness gate.
 */
export const AWAITING_COMPUTE_COMMAND_ID = "study.run";

export interface AwaitingComputeCommandState {
  /** Readiness reason from the command itself; null when it may be invoked. */
  disabledReason: string | null;
  /** True while this surface's invocation is in flight. */
  pending: boolean;
  /** Invokes the existing command through the registry (explicit user action). */
  run: () => void;
  title: string;
}

/**
 * Exposes the registered Compute command's readiness for a status surface.
 * Resources are loaded only while `enabled` (i.e. while the runtime waits for
 * an explicit user Compute), so idle chrome does not pay for them.
 */
export function useAwaitingComputeCommand({
  enabled,
  sourceDetail,
}: {
  enabled: boolean;
  sourceDetail: string;
}): AwaitingComputeCommandState {
  const kernel = useKernel();
  useSyncExternalStore(
    (listener) => kernel.commands.subscribe(listener),
    () => kernel.commands.getVersion(),
    () => 0,
  );
  const resourceData = useRuntimeCommandControlResourceData({ enabled });
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const context = createCommandContext("menu", kernel, {
    resourceData,
    sourceDetail,
  });
  const command = kernel.commands.get(AWAITING_COMPUTE_COMMAND_ID);
  const disabledReason = !enabled
    ? "The runtime is not waiting for Compute."
    : !command
      ? "Compute command is not registered."
      : kernel.commands.isEnabled(AWAITING_COMPUTE_COMMAND_ID, context)
        ? null
        : command.disabledReason?.(context) ?? "Compute is unavailable.";

  const run = useCallback(() => {
    if (pending || disabledReason !== null) return;
    setPending(true);
    // Result feedback is owned by the registry's foreground presenter
    // (source "menu"); this surface only tracks its own in-flight state.
    void kernel.commands
      .execute(AWAITING_COMPUTE_COMMAND_ID, context)
      .finally(() => {
        if (mountedRef.current) setPending(false);
      });
  }, [context, disabledReason, kernel.commands, pending]);

  return {
    disabledReason,
    pending,
    run,
    title: disabledReason ?? (pending ? "Compute request in progress." : "Run Compute for the prepared model."),
  };
}
