import { createContext } from "react";
import type { Viewport3DCameraGestureRef } from "./viewport3DCameraGesture";

export const Viewport3DWireframeGestureContext = createContext<Viewport3DCameraGestureRef | null>(null);
