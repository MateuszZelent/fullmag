"use client";

/**
 * Hook: provides partial display mutations for `PATCH /display`.
 */

import { useState, useCallback } from "react";
import type { DisplaySelection } from "../../api/contracts";
import type { DisplayPatchRequest } from "../../api/types";
import { getLiveSessionClient } from "../../api/client/LiveSessionClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseDisplayControlResult {
  selection: DisplaySelection | null;
  loading: boolean;
  error: LiveApiError | null;
  patchDisplay: (
    update: DisplayPatchRequest,
  ) => Promise<DisplaySelection | null>;
}

export function useDisplayControl(): UseDisplayControlResult {
  const [selection, setSelection] = useState<DisplaySelection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LiveApiError | null>(null);

  const patchDisplay = useCallback(
    async (update: DisplayPatchRequest): Promise<DisplaySelection | null> => {
      setLoading(true);
      setError(null);
      try {
        const client = getLiveSessionClient();
        const result = await client.display.patch(update);
        setSelection(result);
        setLoading(false);
        return result;
      } catch (err) {
        const apiErr =
          err instanceof LiveApiError
            ? err
            : LiveApiError.networkError("display", err);
        setError(apiErr);
        setLoading(false);
        return null;
      }
    },
    [],
  );

  return { selection, loading, error, patchDisplay };
}
