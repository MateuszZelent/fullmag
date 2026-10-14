"use client";

import { Canvas, useFrame, type RootState } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box3, Color, Mesh } from "three";
import type { GeometryRealizationResource, SceneResource } from "@/kernel/api/apiTypes";
import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";
import { resolveAntennaPlacement } from "@/modules/inspector/panels/antenna/AntennaPlacementModel";
import { PrimitiveObjectLayer } from "@/modules/viewport-3d/layers/PrimitiveObjectLayer";
import { resolveViewport3DMaterialProfile } from "@/modules/viewport-3d/layers/viewport3DMaterialProfile";
import { useViewport3DColors } from "@/modules/viewport-3d/hooks/useViewport3DColors";
import { Viewport3DInvalidationProvider } from "@/modules/viewport-3d/viewport3dBatchedInvalidate";
import { Viewport3DResourceTracker } from "@/modules/viewport-3d/viewport3dDiagnostics";
import { buildViewport3DPrimitiveRenderModel } from "@/modules/viewport-3d/viewport3dPrimitiveModel";
import { configureViewport3DRenderer, getViewport3DVisualProfile, resolveViewport3DCanvasGlOptions } from "@/modules/viewport-3d/viewport3dVisualProfile";
import { Button } from "@/shared/ui/Button";

const antennaId = "cpw-preview-source", targetId = "waveguide-preview-target";
const gap = 200e-9;
const transform = { pivot: [0, 0, 0], rotation_quat: [0, 0, 0, 1], scale: [1, 1, 1], translation: [0, 0, 0] };
const params = {
  length_m: 1.4e-6, thickness_m: 60e-9,
  stations: [0, 0.25, 0.45, 0.55, 0.75, 1].map((s) => ({ s,
    signal_width_m: s >= 0.45 && s <= 0.55 ? 50e-9 : 200e-9,
    left_gap_m: 30e-9, right_gap_m: 70e-9,
    left_ground_width_m: 150e-9, right_ground_width_m: 300e-9,
  })),
  conductors: [{ id: "ground-right-custom", kind: "ground_right" }, { id: "signal-custom", kind: "signal" }, { id: "ground-left-custom", kind: "ground_left" }],
  transform: { rotation_matrix: [[0, -1, 0], [1, 0, 0], [0, 0, 1]], translation_m: [0, -0.7e-6, 0] },
};
const target = { id: targetId, name: "Waveguide preview", role: "magnet", magnetization_ref: "fixture:target",
  geometry: { geometry_kind: "Box", geometry_params: { dimensions: [2e-6, 250e-9, 40e-9] } }, transform };
const antenna = { id: antennaId, name: "CPW preview", role: "antenna", geometry: { geometry_kind: "CPWAntennaLayout", geometry_params: params }, transform };
const scene = { revision: 1, objects: [target, antenna] };
const realization = { source_scene_revision: 1, bodies: [{ object_id: targetId, status: "ready", bounds_min: [-1e-6, -125e-9, -20e-9], bounds_max: [1e-6, 125e-9, 20e-9] }] };
const profile = getViewport3DVisualProfile("capture");
const materialProfile = resolveViewport3DMaterialProfile(profile);
const settings = { ...DEFAULT_OBJECT_VISUALIZATION, primitiveVisible: true };
interface Runtime { root: RootState | null; frames: number }

function FrameCounter({ onFrame }: { onFrame: () => void }) {
  useFrame(onFrame);
  return null;
}

function readCanvas(runtime: Runtime) {
  const root = runtime.root;
  const meshes: Array<{ id: string; color: string; vertices: number; indices: number; parts: unknown; min: number[]; max: number[] }> = [];
  if (root) {
    root.scene.updateMatrixWorld(true);
    root.scene.traverse((node) => {
      if (!(node instanceof Mesh) || !node.userData.objectId) return;
      const bounds = new Box3().setFromObject(node);
      const material = Array.isArray(node.material) ? node.material[0] : node.material;
      meshes.push({ id: node.userData.objectId, color: "color" in material && material.color instanceof Color ? material.color.getHexString() : "",
        vertices: node.geometry.getAttribute("position").count, indices: node.geometry.index?.count ?? 0,
        parts: node.geometry.userData.conductorParts ?? null, min: bounds.min.toArray(), max: bounds.max.toArray() });
    });
  }
  const gl = root?.gl.getContext();
  return { frames: runtime.frames, contextLost: gl?.isContextLost() ?? true,
    width: gl?.drawingBufferWidth ?? 0, height: gl?.drawingBufferHeight ?? 0, meshes };
}

type Evidence = ReturnType<typeof readCanvas> & { side: string; mounted: boolean; invalid: boolean; expectedGold: string; geometries: number; diagnostics: unknown };
declare global { interface Window { __antennaCpwViewport?: { read: () => Evidence; pixels: () => { gold: number; total: number } }; } }

export default function AntennaCpwViewportFixturePage() {
  const { colors, clientReady } = useViewport3DColors();
  const [side, setSide] = useState<"above" | "below">("above");
  const [invalid, setInvalid] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [tracker] = useState(() => new Viewport3DResourceTracker());
  const runtime = useRef<Runtime>({ root: null, frames: 0 });
  const onFrame = useCallback(() => { runtime.current.frames++; }, []);
  const model = useMemo(() => {
    // Only the production placement calculation is exercised, not API/ACK.
    const placement = resolveAntennaPlacement(scene as unknown as SceneResource, realization as unknown as GeometryRealizationResource, antennaId, targetId, side, gap);
    const geometryParams = invalid ? { ...params, stations: params.stations.map((station, index) => index === 2 ? { ...station, left_gap_m: 0 } : station) } : params;
    return buildViewport3DPrimitiveRenderModel({ ...scene, objects: [target, { ...antenna,
      geometry: { ...antenna.geometry, geometry_params: geometryParams }, transform: { ...transform, translation: Array.from(placement.translation) } }] }, null);
  }, [side, invalid]);
  useEffect(() => () => tracker.disposeAll(), [tracker]);
  useEffect(() => {
    if (!colors || !clientReady) return;
    if (!colors.antenna) throw new Error("Antenna theme token is required for gold qualification");
    const expectedGold = new Color(colors.antenna).getHexString();
    if ([colors.mesh, colors.background].some((color) => new Color(color).getHexString() === expectedGold)) throw new Error("Antenna token must differ from sample and background colors");
    window.__antennaCpwViewport = {
      read: () => ({ ...readCanvas(runtime.current), side, invalid, mounted, expectedGold, geometries: tracker.getSnapshot().geometries, diagnostics: model.diagnostics }),
      pixels: () => {
        const gl = runtime.current.root?.gl.getContext();
        if (!gl || gl.isContextLost()) throw new Error("Active WebGL context required");
        const bytes = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        const rgb = [0, 2, 4].map((offset) => parseInt(expectedGold.slice(offset, offset + 2), 16));
        let gold = 0;
        for (let index = 0; index < bytes.length; index += 4) if (rgb.every((value, axis) => Math.abs(value - bytes[index + axis]) < 12)) gold++;
        return { gold, total: bytes.length / 4 };
      },
    };
    return () => { delete window.__antennaCpwViewport; };
  }, [clientReady, colors, invalid, model, mounted, side, tracker]);
  return <main id="fm-main-content" className="fm-antenna-cpw-viewport-fixture" style={{ padding: 24 }}>
    <h1>CPW — produkcyjny podgląd geometrii</h1>
    <p>Fixture renderowania, bez solve i transakcji API. Odstęp world Z: 200 nm.</p>
    <Button onClick={() => setSide("above")}>Above sample</Button>
    <Button onClick={() => setSide("below")}>Below sample</Button>
    <Button onClick={() => setInvalid((value) => !value)}>Toggle invalid CPW</Button>
    <Button onClick={() => setMounted((value) => !value)}>Toggle layer</Button>
    <div data-testid="cpw-canvas" style={{ width: 1000, height: 620 }}>
      {clientReady && colors ? <Canvas frameloop="demand" dpr={1} gl={resolveViewport3DCanvasGlOptions(profile)}
        camera={{ position: [2.3e-6, -3e-6, 2e-6], up: [0, 0, 1], near: 1e-9, far: 1e-3, fov: 40 }}
        onCreated={(root) => { configureViewport3DRenderer(root.gl, profile); root.camera.lookAt(0, 0, 0); runtime.current.root = root; }}>
        <color attach="background" args={[colors.background]} />
        <FrameCounter onFrame={onFrame} />
        <Viewport3DInvalidationProvider>
          {mounted ? <PrimitiveObjectLayer colors={colors} getObjectSettings={() => settings} materialProfile={materialProfile}
            primitiveModel={model} tracker={tracker} onSelectObject={() => undefined} /> : null}
        </Viewport3DInvalidationProvider>
      </Canvas> : null}
    </div>
    <pre>{JSON.stringify({ side, invalid, diagnostics: model.diagnostics }, null, 2)}</pre>
  </main>;
}
