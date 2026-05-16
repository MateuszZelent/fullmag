"use client";

import { useCallback } from "react";

import {
  commandPaletteStore,
  useCommandPaletteSnapshot,
} from "./commandPaletteStore";

export function useCommandPalette() {
  const state = useCommandPaletteSnapshot();

  const open = useCallback(() => commandPaletteStore.open(), []);
  const close = useCallback(() => commandPaletteStore.close(), []);
  const toggle = useCallback(() => commandPaletteStore.toggle(), []);
  const setQuery = useCallback((query: string) => commandPaletteStore.setQuery(query), []);

  return {
    ...state,
    close,
    open,
    setQuery,
    toggle,
  } as const;
}
