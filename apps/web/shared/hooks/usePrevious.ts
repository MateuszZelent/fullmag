/**
 * Shared hooks – usePrevious.
 *
 * Tracks the previous value of a variable across renders.
 */
import { useEffect, useRef } from "react";

export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}
