"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { copyTextToClipboard } from "./copyTextToClipboard";

type CopyStatus = "idle" | "pending" | "success" | "error";
type CopyOwner = { identity: string };
type CopyState = { owner: CopyOwner; status: CopyStatus };

/** Feedback belongs to the source that was copied, including late clipboard ACKs. */
export function useClipboardCopy(identity: string) {
  const owner = useMemo(() => ({ identity }), [identity]);
  const [state, setState] = useState<CopyState>({ owner, status: "idle" });
  const activeIdentity = useRef<CopyOwner | null>(null);
  const operation = useRef(0);
  const pending = useRef(false);
  useLayoutEffect(() => {
    activeIdentity.current = owner;
    pending.current = false;
    operation.current += 1;
    return () => {
      activeIdentity.current = null;
      pending.current = false;
      operation.current += 1;
    };
  }, [owner]);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    if (activeIdentity.current !== owner || pending.current) return false;
    const submittedOperation = ++operation.current;
    const isCurrent = () => activeIdentity.current === owner && operation.current === submittedOperation;
    pending.current = true;
    setState({ owner, status: "pending" });
    try {
      await copyTextToClipboard(text);
      if (!isCurrent()) return false;
      setState({ owner, status: "success" });
      return true;
    } catch {
      if (isCurrent()) setState({ owner, status: "error" });
      return false;
    } finally {
      if (isCurrent()) pending.current = false;
    }
  }, [owner]);

  useEffect(() => {
    if (state.owner !== owner || state.status !== "success") return;
    const timeout = setTimeout(() => {
      setState((current) => current === state ? { owner, status: "idle" } : current);
    }, 2000);
    return () => clearTimeout(timeout);
  }, [owner, state]);

  const status = state.owner === owner ? state.status : "idle";
  return {
    copy,
    error: status === "error" ? "Could not copy to the clipboard. Try again or copy the text manually." : null,
    status,
  };
}
