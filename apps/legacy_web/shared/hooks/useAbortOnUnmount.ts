/**
 * Shared hooks – useAbortOnUnmount.
 *
 * Returns an AbortSignal that aborts automatically when the component unmounts.
 */
import { useEffect, useMemo } from "react";

export function useAbortOnUnmount(): AbortSignal {
  const controller = useMemo(() => new AbortController(), []);

  useEffect(() => {
    return () => {
      controller.abort();
    };
  }, [controller]);

  return controller.signal;
}
