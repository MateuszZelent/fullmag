import { createContext, useContext, useReducer, useCallback, type ReactNode } from "react";
import type { TransformTool, TransformSpace, TransformPivotMode, SnapConfig } from "./types";
import { DEFAULT_SNAP } from "./types";

interface TransformModeState {
  tool: TransformTool;
  space: TransformSpace;
  pivotMode: TransformPivotMode;
  snap: SnapConfig;
  isDragging: boolean;
}

type TransformModeAction =
  | { type: "SET_TOOL"; tool: TransformTool }
  | { type: "SET_SPACE"; space: TransformSpace }
  | { type: "TOGGLE_SPACE" }
  | { type: "SET_PIVOT_MODE"; mode: TransformPivotMode }
  | { type: "TOGGLE_SNAP" }
  | { type: "SET_SNAP"; snap: Partial<SnapConfig> }
  | { type: "SET_DRAGGING"; dragging: boolean };

const initialState: TransformModeState = {
  tool: "select",
  space: "world",
  pivotMode: "object-center",
  snap: DEFAULT_SNAP,
  isDragging: false,
};

function reducer(state: TransformModeState, action: TransformModeAction): TransformModeState {
  switch (action.type) {
    case "SET_TOOL":
      return { ...state, tool: action.tool };
    case "SET_SPACE":
      return { ...state, space: action.space };
    case "TOGGLE_SPACE":
      return { ...state, space: state.space === "world" ? "local" : "world" };
    case "SET_PIVOT_MODE":
      return { ...state, pivotMode: action.mode };
    case "TOGGLE_SNAP":
      return { ...state, snap: { ...state.snap, enabled: !state.snap.enabled } };
    case "SET_SNAP":
      return { ...state, snap: { ...state.snap, ...action.snap } };
    case "SET_DRAGGING":
      return { ...state, isDragging: action.dragging };
    default:
      return state;
  }
}

interface TransformModeContextValue extends TransformModeState {
  setTool: (tool: TransformTool) => void;
  setSpace: (space: TransformSpace) => void;
  toggleSpace: () => void;
  toggleSnap: () => void;
  setDragging: (d: boolean) => void;
}

const TransformModeContext = createContext<TransformModeContextValue | null>(null);

export function TransformModeProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const setTool = useCallback((tool: TransformTool) => dispatch({ type: "SET_TOOL", tool }), []);
  const setSpace = useCallback((space: TransformSpace) => dispatch({ type: "SET_SPACE", space }), []);
  const toggleSpace = useCallback(() => dispatch({ type: "TOGGLE_SPACE" }), []);
  const toggleSnap = useCallback(() => dispatch({ type: "TOGGLE_SNAP" }), []);
  const setDragging = useCallback((d: boolean) => dispatch({ type: "SET_DRAGGING", dragging: d }), []);

  const value: TransformModeContextValue = {
    ...state,
    setTool,
    setSpace,
    toggleSpace,
    toggleSnap,
    setDragging,
  };

  return (
    <TransformModeContext.Provider value={value}>
      {children}
    </TransformModeContext.Provider>
  );
}

export function useTransformMode(): TransformModeContextValue {
  const ctx = useContext(TransformModeContext);
  if (!ctx) throw new Error("useTransformMode must be used within TransformModeProvider");
  return ctx;
}
