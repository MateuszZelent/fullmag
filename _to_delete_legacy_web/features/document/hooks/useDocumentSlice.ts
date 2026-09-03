import { useMemo } from "react";
import {
  selectModelBuilderGraph,
  selectRemoteSceneDocument,
  selectSceneDocumentDraft,
  selectSolverPlan,
  selectSolverSettings,
  useDocumentStore,
} from "../store/useDocumentStore";

export function useSolverSettings() {
  return useDocumentStore(selectSolverSettings);
}

export function useSolverPlan() {
  return useDocumentStore(selectSolverPlan);
}

export function useModelBuilderGraph() {
  return useDocumentStore(selectModelBuilderGraph);
}

export function useSceneDocumentDraft() {
  return useDocumentStore(selectSceneDocumentDraft);
}

export function useRemoteSceneDocument() {
  return useDocumentStore(selectRemoteSceneDocument);
}

export function useDocumentActions() {
  const setSolverSettings = useDocumentStore((s) => s.setSolverSettings);
  const setSolverPlan = useDocumentStore((s) => s.setSolverPlan);
  const setModelBuilderGraph = useDocumentStore((s) => s.setModelBuilderGraph);
  const setSceneDocumentDraft = useDocumentStore((s) => s.setSceneDocumentDraft);
  const setRemoteSceneDocument = useDocumentStore((s) => s.setRemoteSceneDocument);

  return useMemo(
    () => ({
      setSolverSettings,
      setSolverPlan,
      setModelBuilderGraph,
      setSceneDocumentDraft,
      setRemoteSceneDocument,
    }),
    [
      setModelBuilderGraph,
      setRemoteSceneDocument,
      setSceneDocumentDraft,
      setSolverPlan,
      setSolverSettings,
    ],
  );
}
