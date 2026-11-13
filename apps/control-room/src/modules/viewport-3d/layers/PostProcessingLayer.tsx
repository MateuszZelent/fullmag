"use client";

import { Bloom, EffectComposer, FXAA, N8AO } from "@react-three/postprocessing";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { type EffectComposer as EffectComposerImpl } from "postprocessing";
import { HalfFloatType, Vector2 } from "three";

import { viewport3DPostProcessingEnabledFromBrowserConfig } from "@/kernel/browserFullmagConfig";
import { useViewport3DCommandState, viewport3dStore } from "../viewport3dStore";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import { prepareViewport3DAmbientOcclusion } from "../viewport3dAmbientOcclusionPrecision";
import { resolveViewport3DPresentationQuality, resolveViewport3DQualityProfileId } from "../viewport3dPresentation";
import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";
import { registerViewport3DCapturePipeline, type Viewport3DComposedCaptureFrame } from "../viewport3dImageExport";
import { Viewport3DAlphaToneMapping } from "./Viewport3DAlphaToneMapping";
import { enableViewport3DHudRaycasting, VIEWPORT_3D_HUD_LAYER } from "../viewport3dHudLayer";

/** Owns the same demand-driven draw pipeline for the viewport and high-resolution PNG. */
export function PostProcessingLayer({ quantitativeDataVisible = false, sceneSpan = 1 }: {
  quantitativeDataVisible?: boolean;
  sceneSpan?: number;
}) {
  const { appearance, widgets, visualProfileId, captureReturnProfileId } = useViewport3DCommandState();
  const invalidate = useBatchedInvalidate("material-style");
  const raycaster = useThree((state) => state.raycaster);
  const getThree = useThree((state) => state.get);
  const available = viewport3DPostProcessingEnabledFromBrowserConfig();
  const enabled = available && !quantitativeDataVisible;
  const qualityProfileId = resolveViewport3DQualityProfileId(visualProfileId, captureReturnProfileId);
  const quality = resolveViewport3DPresentationQuality(qualityProfileId);
  const ao = enabled && quality.aoEnabled && widgets.effectAmbientOcclusion;
  const bloom = enabled && widgets.effectBloom;
  // The tone-mapping pass never touches quantitative data or its legend.
  const toneMapping = enabled && appearance.renderMode === "presentation";
  const hasEffects = ao || bloom || toneMapping;
  const antialias = hasEffects && getViewport3DVisualProfile(qualityProfileId).antialias && widgets.effectAntialias;
  const composer = useRef<EffectComposerImpl | null>(null);
  const logicalSize = useMemo(() => new Vector2(), []);
  const appliedSize = useRef({ width: 0, height: 0, ratio: 0 });
  useEffect(() => {
    const { gl } = getThree();
    const previous = gl.info.autoReset;
    gl.info.autoReset = false;
    return () => { gl.info.autoReset = previous; };
  }, [getThree]);
  useEffect(() => {
    return enableViewport3DHudRaycasting(raycaster);
  }, [raycaster]);
  useEffect(() => {
    viewport3dStore.setPostProcessingDataProtection(quantitativeDataVisible);
    viewport3dStore.setPostProcessingAvailable(available);
    return () => viewport3dStore.setPostProcessingDataProtection(false);
  }, [available, quantitativeDataVisible]);
  useEffect(() => { invalidate(); }, [invalidate, ao, bloom, toneMapping, antialias, quality.aoHalfRes, appearance.aoRadius, appearance.aoIntensity]);

  const renderBase = useCallback(() => {
    const { gl, scene, camera } = getThree();
    const autoClear = gl.autoClear;
    try {
      gl.autoClear = true;
      gl.setRenderTarget(null);
      if (hasEffects && composer.current) {
        gl.getSize(logicalSize);
        const ratio = gl.getPixelRatio();
        const previousSize = appliedSize.current;
        if (previousSize.width !== logicalSize.x || previousSize.height !== logicalSize.y || previousSize.ratio !== ratio) {
          composer.current.setSize(logicalSize.x, logicalSize.y, false);
          appliedSize.current = { width: logicalSize.x, height: logicalSize.y, ratio };
        }
        prepareViewport3DAmbientOcclusion(composer.current.passes);
        composer.current.render(0);
      } else gl.render(scene, camera);
    } finally { gl.autoClear = autoClear; }
  }, [getThree, hasEffects, logicalSize]);

  const renderAnnotations = useCallback(() => {
    const { gl, scene, camera } = getThree();
    const background = scene.background;
    const mask = camera.layers.mask;
    const autoClear = gl.autoClear;
    try {
      scene.background = null;
      camera.layers.set(VIEWPORT_3D_HUD_LAYER);
      gl.autoClear = false;
      gl.clearDepth();
      gl.render(scene, camera);
    } finally {
      scene.background = background;
      camera.layers.mask = mask;
      gl.autoClear = autoClear;
    }
  }, [getThree]);

  const renderComposedPixels = useCallback((annotations: boolean): Viewport3DComposedCaptureFrame => {
    const active = composer.current;
    if (!active) throw new Error("Viewport image effects are not ready. Wait for the viewport and try again.");
    const { gl } = getThree();
    const previousTarget = gl.getRenderTarget();
    const screenFlags = active.passes.map((pass) => pass.renderToScreen);
    try {
      // The final pass must retain its RGBA, including FXAA's sampled coverage.
      // Rendering offscreen also leaves the final effect output in linear light.
      for (const pass of active.passes) pass.renderToScreen = false;
      renderBase();
      let target = active.inputBuffer;
      for (const pass of active.passes) {
        if (pass.enabled && pass.needsSwap) target = target === active.inputBuffer ? active.outputBuffer : active.inputBuffer;
      }
      if (target.texture.type !== HalfFloatType) throw new Error("Viewport image effects require an RGBA16F capture buffer.");
      gl.setRenderTarget(target);
      if (annotations) renderAnnotations();
      let pixels: Uint16Array;
      try { pixels = new Uint16Array(target.width * target.height * 4); }
      catch { throw new Error("The browser could not allocate PNG effect pixels. Choose a smaller export scale."); }
      gl.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
      return { pixels };
    } finally {
      active.passes.forEach((pass, index) => { pass.renderToScreen = screenFlags[index]; });
      gl.setRenderTarget(previousTarget);
    }
  }, [getThree, renderAnnotations, renderBase]);

  useEffect(() => registerViewport3DCapturePipeline(getThree().gl.domElement, {
    resize: (width, height) => {
      const ratio = getThree().gl.getPixelRatio();
      composer.current?.setSize(width / ratio, height / ratio, false);
      appliedSize.current = { width: width / ratio, height: height / ratio, ratio };
    },
    render: ({ annotations, pixels }) => {
      if (pixels && hasEffects) return renderComposedPixels(annotations);
      renderBase();
      if (annotations) renderAnnotations();
    },
  }), [getThree, hasEffects, renderBase, renderAnnotations, renderComposedPixels]);

  useFrame(({ gl }) => gl.info.reset(), 0.5);
  useFrame(renderBase, 1);
  useFrame(() => {
    if (visualProfileId !== "capture" || appearance.exportAnnotations) renderAnnotations();
  }, 2);

  if (!hasEffects) return null;
  return (
    // Single-sample HDR avoids invalid MSAA resolves on software WebGL renderers.
    // FXAA smooths the composed image without changing the selected field data.
    <EffectComposer ref={composer} enabled={false} multisampling={0} frameBufferType={HalfFloatType}>
      <>
        {ao ? <N8AO aoRadius={Math.max(1e-12, Math.abs(sceneSpan)) * appearance.aoRadius} intensity={appearance.aoIntensity} halfRes={quality.aoHalfRes} quality={qualityProfileId === "interactive" ? "low" : quality.aoHalfRes ? "medium" : "high"} depthAwareUpsampling /> : null}
        {bloom ? <Bloom luminanceThreshold={0.8} luminanceSmoothing={0.1} intensity={0.5} /> : null}
        {toneMapping ? <Viewport3DAlphaToneMapping /> : null}
        {antialias ? <FXAA /> : null}
      </>
    </EffectComposer>
  );
}
