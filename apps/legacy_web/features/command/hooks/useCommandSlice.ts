import { useMemo } from "react";
import { useCommandStore } from "../store/useCommandStore";

export function useCommandStateActions() {
  const setRunUntilInput = useCommandStore((s) => s.setRunUntilInput);
  const setCommandPostInFlight = useCommandStore((s) => s.setCommandPostInFlight);
  const setCommandErrorMessage = useCommandStore((s) => s.setCommandErrorMessage);
  const setScriptSyncBusy = useCommandStore((s) => s.setScriptSyncBusy);
  const setScriptSyncMessage = useCommandStore((s) => s.setScriptSyncMessage);
  const setStateIoBusy = useCommandStore((s) => s.setStateIoBusy);
  const setStateIoMessage = useCommandStore((s) => s.setStateIoMessage);
  const setPreviewPostInFlight = useCommandStore((s) => s.setPreviewPostInFlight);
  const setPreviewMessage = useCommandStore((s) => s.setPreviewMessage);

  return useMemo(
    () => ({
      setRunUntilInput,
      setCommandPostInFlight,
      setCommandErrorMessage,
      setScriptSyncBusy,
      setScriptSyncMessage,
      setStateIoBusy,
      setStateIoMessage,
      setPreviewPostInFlight,
      setPreviewMessage,
    }),
    [
      setCommandErrorMessage,
      setCommandPostInFlight,
      setPreviewMessage,
      setPreviewPostInFlight,
      setRunUntilInput,
      setScriptSyncBusy,
      setScriptSyncMessage,
      setStateIoBusy,
      setStateIoMessage,
    ],
  );
}
