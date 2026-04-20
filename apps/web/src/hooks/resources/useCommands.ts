"use client";

/**
 * Hook: provides submitCommand() for POST /commands.
 */

import { useState, useCallback } from "react";
import type { CommandResponse } from "../../api/generated/openapi-types";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseCommandsResult {
  lastResponse: CommandResponse | null;
  loading: boolean;
  error: LiveApiError | null;
  submitCommand: (
    command: string,
    params?: Record<string, unknown>,
  ) => Promise<CommandResponse | null>;
}

export function useCommands(): UseCommandsResult {
  const [lastResponse, setLastResponse] = useState<CommandResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LiveApiError | null>(null);

  const submitCommand = useCallback(
    async (
      command: string,
      params?: Record<string, unknown>,
    ): Promise<CommandResponse | null> => {
      setLoading(true);
      setError(null);
      try {
        const client = getLiveApiClient();
        const result = await client.commands.submit(command, params);
        setLastResponse(result);
        setLoading(false);
        return result;
      } catch (err) {
        const apiErr =
          err instanceof LiveApiError
            ? err
            : LiveApiError.networkError("commands", err);
        setError(apiErr);
        setLoading(false);
        return null;
      }
    },
    [],
  );

  return { lastResponse, loading, error, submitCommand };
}
