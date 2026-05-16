"use client";

import { useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, Line } from "@react-three/drei";
import { recordFrontendRender } from "@/lib/debug/frontendPerfDebug";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

function AxesLines() {
  const xPoints = useMemo(() => [[0, 0, 0], [1.6, 0, 0]] as [number, number, number][], []);
  const yPoints = useMemo(() => [[0, 0, 0], [0, 1.6, 0]] as [number, number, number][], []);
  const zPoints = useMemo(() => [[0, 0, 0], [0, 0, 1.6]] as [number, number, number][], []);
  return (
    <>
      <Line points={xPoints} color="#ff5a5a" lineWidth={2} />
      <Line points={yPoints} color="#46d17d" lineWidth={2} />
      <Line points={zPoints} color="#4f8cff" lineWidth={2} />
    </>
  );
}

export default function StandaloneR3fDiagnosticViewport() {
  if (FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging) {
    recordFrontendRender("StandaloneR3fDiagnosticViewport");
  }

  const [interactionCount, setInteractionCount] = useState(0);

  return (
    <div className="relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-[#151726]">
      <Canvas
        frameloop="always"
        dpr={1}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        camera={{ position: [2.4, 1.8, 3.2], fov: 45, near: 0.01, far: 1000 }}
      >
        <color attach="background" args={["#151726"]} />
        <AxesLines />
        <Grid
          position={[0, -0.75, 0]}
          args={[6, 6]}
          cellSize={0.5}
          cellThickness={0.6}
          sectionSize={1.5}
          sectionThickness={1.1}
          cellColor="#252c42"
          sectionColor="#3c445f"
          infiniteGrid={false}
          fadeDistance={20}
          fadeStrength={0}
        />
        <mesh position={[-0.75, 0, 0]}>
          <boxGeometry args={[1.4, 0.25, 0.8]} />
          <meshBasicMaterial color="#4f8cff" wireframe />
        </mesh>
        <mesh position={[0.95, 0.05, 0]}>
          <torusGeometry args={[0.42, 0.12, 18, 42]} />
          <meshBasicMaterial color="#ff8a3d" wireframe />
        </mesh>
        <OrbitControls
          enableDamping={false}
          screenSpacePanning
          onStart={() => setInteractionCount((value) => value + 1)}
        />
      </Canvas>
      <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-white/10 bg-black/35 px-3 py-2 text-xs text-white/80">
        <div>Standalone R3F diagnostic viewport</div>
        <div>Interactions: {interactionCount}</div>
      </div>
    </div>
  );
}
