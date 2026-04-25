"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CommandDetail,
  CommandQueueStatus,
  CommandStatus,
} from "../../api/types";
import { getLiveSessionClient } from "../../api/client/LiveSessionClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

const TERMINAL_STATES = new Set(["completed", "rejected", "failed"]);

export interface UseCommandCompletionOptions {
  enabled?: boolean;
  pollIntervalMs?: number;
}

export interface UseCommandCompletionResult {
  queue: CommandQueueStatus | null;
  command: CommandStatus | null;
  detail: CommandDetail | null;
  terminal: boolean;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
}

export function useCommandCompletion(
  commandId: string | null,
  options?: UseCommandCompletionOptions,
): UseCommandCompletionResult {
  const enabled = options?.enabled ?? true;
  const pollIntervalMs = options?.pollIntervalMs ?? 1000;

  const [queue, setQueue] = useState<CommandQueueStatus | null>(null);
  const [command, setCommand] = useState<CommandStatus | null>(null);
  const [detail, setDetail] = useState<CommandDetail | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);

  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }

    setLoading(true);
    try {
      const client = getLiveSessionClient();
      const queueStatus = await client.commands.status();
      if (!mountedRef.current) {
        return;
      }

      setQueue(queueStatus);
      const matched =
        commandId != null
          ? queueStatus.commands.find((entry) => entry.command_id === commandId) ?? null
          : null;
      setCommand(matched);

      if (commandId != null && matched != null) {
        const commandDetail = await client.commands.get(commandId);
        if (!mountedRef.current) {
          return;
        }
        setDetail(commandDetail);
      } else {
        setDetail(null);
      }

      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setError(
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("command-completion", err),
      );
      setLoading(false);
    }
  }, [commandId, enabled]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      setLoading(false);
      setError(null);
      return () => {
        mountedRef.current = false;
      };
    }

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, pollIntervalMs);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [enabled, pollIntervalMs, refresh]);

  return {
    queue,
    command,
    detail,
    terminal: command != null && TERMINAL_STATES.has(command.status),
    loading,
    error,
    refresh,
  };
}
