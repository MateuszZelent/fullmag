"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { recordFrontendRender } from "@/lib/debug/frontendPerfDebug";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

export default function StandaloneThreeDiagnosticViewport() {
  if (FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging) {
    recordFrontendRender("StandaloneThreeDiagnosticViewport");
  }

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x151726);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    camera.position.set(2.4, 1.8, 3.2);

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(1);
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement) as OrbitControls & {
      enableDamping?: boolean;
      screenSpacePanning?: boolean;
    };
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    controls.target.set(0, 0, 0);
    controls.update();

    const axes = new THREE.AxesHelper(1.6);
    scene.add(axes);

    const grid = new THREE.GridHelper(6, 12, 0x3c445f, 0x252c42);
    grid.position.y = -0.75;
    scene.add(grid);

    const rect = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.25, 0.8),
      new THREE.MeshBasicMaterial({ color: 0x4f8cff, wireframe: true }),
    );
    rect.position.set(-0.75, 0, 0);
    scene.add(rect);

    const torus = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.12, 18, 42),
      new THREE.MeshBasicMaterial({ color: 0xff8a3d, wireframe: true }),
    );
    torus.position.set(0.95, 0.05, 0);
    scene.add(torus);

    const resizeObserver = new ResizeObserver(() => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    });
    resizeObserver.observe(host);

    let frameId = 0;
    let lastSampleTime = performance.now();
    let frames = 0;
    let disposed = false;

    const renderLoop = () => {
      if (disposed) {
        return;
      }
      frameId = window.requestAnimationFrame(renderLoop);
      controls.update();
      renderer.render(scene, camera);
      frames += 1;
      const now = performance.now();
      if (now - lastSampleTime >= 500) {
        setFps(Math.round((frames * 1000) / (now - lastSampleTime)));
        frames = 0;
        lastSampleTime = now;
      }
    };
    renderLoop();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      rect.geometry.dispose();
      (rect.material as THREE.Material).dispose();
      torus.geometry.dispose();
      (torus.material as THREE.Material).dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-[#151726]">
      <div ref={hostRef} className="h-full w-full" />
      <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-white/10 bg-black/35 px-3 py-2 text-xs text-white/80">
        <div>Standalone three.js diagnostic viewport</div>
        <div>{fps == null ? "FPS: measuring..." : `FPS: ${fps}`}</div>
      </div>
    </div>
  );
}
