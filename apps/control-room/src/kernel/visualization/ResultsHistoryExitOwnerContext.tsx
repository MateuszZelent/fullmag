"use client";

import { createContext, useContext, type ReactNode } from "react";

export type ResultsHistoryExitOwner = "saved" | "current" | null;

const ResultsHistoryExitOwnerContext =
  createContext<ResultsHistoryExitOwner>(null);

export function ResultsHistoryExitOwnerProvider({
  owner,
  children,
}: {
  readonly owner: ResultsHistoryExitOwner;
  readonly children: ReactNode;
}) {
  return (
    <ResultsHistoryExitOwnerContext.Provider value={owner}>
      {children}
    </ResultsHistoryExitOwnerContext.Provider>
  );
}

export function useResultsHistoryExitOwner(): ResultsHistoryExitOwner {
  return useContext(ResultsHistoryExitOwnerContext);
}
