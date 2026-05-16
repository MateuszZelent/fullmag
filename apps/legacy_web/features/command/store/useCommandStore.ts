import { create } from "zustand";
import type { SetStateAction } from "react";
import type { DisplaySelection, EngineLogEntry } from "@/lib/session/types";

export interface CommandStoreState {
  runUntilInput: string;
  commandPostInFlight: boolean;
  commandErrorMessage: string | null;
  scriptSyncBusy: boolean;
  scriptSyncMessage: string | null;
  stateIoBusy: boolean;
  stateIoMessage: string | null;
  previewPostInFlight: boolean;
  previewMessage: string | null;
  optimisticDisplaySelection: DisplaySelection | null;
  frontendTraceLog: EngineLogEntry[];

  setRunUntilInput: (value: SetStateAction<string>) => void;
  setCommandPostInFlight: (value: SetStateAction<boolean>) => void;
  setCommandErrorMessage: (value: SetStateAction<string | null>) => void;
  setScriptSyncBusy: (value: SetStateAction<boolean>) => void;
  setScriptSyncMessage: (value: SetStateAction<string | null>) => void;
  setStateIoBusy: (value: SetStateAction<boolean>) => void;
  setStateIoMessage: (value: SetStateAction<string | null>) => void;
  setPreviewPostInFlight: (value: SetStateAction<boolean>) => void;
  setPreviewMessage: (value: SetStateAction<string | null>) => void;
  setOptimisticDisplaySelection: (value: SetStateAction<DisplaySelection | null>) => void;
  setFrontendTraceLog: (value: SetStateAction<EngineLogEntry[]>) => void;
}

function resolveSetStateAction<T>(value: SetStateAction<T>, previous: T): T {
  return typeof value === "function"
    ? (value as (prev: T) => T)(previous)
    : value;
}

export const useCommandStore = create<CommandStoreState>((set) => ({
  runUntilInput: "1e-12",
  commandPostInFlight: false,
  commandErrorMessage: null,
  scriptSyncBusy: false,
  scriptSyncMessage: null,
  stateIoBusy: false,
  stateIoMessage: null,
  previewPostInFlight: false,
  previewMessage: null,
  optimisticDisplaySelection: null,
  frontendTraceLog: [],

  setRunUntilInput: (value) =>
    set((prev) => ({ runUntilInput: resolveSetStateAction(value, prev.runUntilInput) })),
  setCommandPostInFlight: (value) =>
    set((prev) => ({
      commandPostInFlight: resolveSetStateAction(value, prev.commandPostInFlight),
    })),
  setCommandErrorMessage: (value) =>
    set((prev) => ({
      commandErrorMessage: resolveSetStateAction(value, prev.commandErrorMessage),
    })),
  setScriptSyncBusy: (value) =>
    set((prev) => ({ scriptSyncBusy: resolveSetStateAction(value, prev.scriptSyncBusy) })),
  setScriptSyncMessage: (value) =>
    set((prev) => ({
      scriptSyncMessage: resolveSetStateAction(value, prev.scriptSyncMessage),
    })),
  setStateIoBusy: (value) =>
    set((prev) => ({ stateIoBusy: resolveSetStateAction(value, prev.stateIoBusy) })),
  setStateIoMessage: (value) =>
    set((prev) => ({ stateIoMessage: resolveSetStateAction(value, prev.stateIoMessage) })),
  setPreviewPostInFlight: (value) =>
    set((prev) => ({
      previewPostInFlight: resolveSetStateAction(value, prev.previewPostInFlight),
    })),
  setPreviewMessage: (value) =>
    set((prev) => ({ previewMessage: resolveSetStateAction(value, prev.previewMessage) })),
  setOptimisticDisplaySelection: (value) =>
    set((prev) => ({
      optimisticDisplaySelection: resolveSetStateAction(value, prev.optimisticDisplaySelection),
    })),
  setFrontendTraceLog: (value) =>
    set((prev) => ({
      frontendTraceLog: resolveSetStateAction(value, prev.frontendTraceLog),
    })),
}));

export const selectRunUntilInput = (s: CommandStoreState) => s.runUntilInput;
export const selectCommandPostInFlight = (s: CommandStoreState) => s.commandPostInFlight;
export const selectCommandErrorMessage = (s: CommandStoreState) => s.commandErrorMessage;
export const selectScriptSyncBusy = (s: CommandStoreState) => s.scriptSyncBusy;
export const selectScriptSyncMessage = (s: CommandStoreState) => s.scriptSyncMessage;
export const selectStateIoBusy = (s: CommandStoreState) => s.stateIoBusy;
export const selectStateIoMessage = (s: CommandStoreState) => s.stateIoMessage;
export const selectPreviewPostInFlight = (s: CommandStoreState) => s.previewPostInFlight;
export const selectPreviewMessage = (s: CommandStoreState) => s.previewMessage;
export const selectOptimisticDisplaySelection = (s: CommandStoreState) =>
  s.optimisticDisplaySelection;
export const selectFrontendTraceLog = (s: CommandStoreState) => s.frontendTraceLog;
