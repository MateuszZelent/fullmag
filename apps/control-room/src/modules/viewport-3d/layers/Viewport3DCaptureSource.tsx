"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";

import { registerViewport3DCaptureSource } from "../viewport3dImageExport";

/** Registers the live scene resources used by transparent and annotation-free PNG captures. */
export function Viewport3DCaptureSource() {
  const { camera, gl, scene } = useThree();

  useEffect(
    () => registerViewport3DCaptureSource(gl.domElement, { camera, renderer: gl, scene }),
    [camera, gl, scene],
  );
  return null;
}
