"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  pointInsideRegionShape,
  type TargetMetricBounds,
  type Vec3,
} from "@/shared/domain/magnetization-texture/boundsResolver";
import {
  orientedPlaneFrame,
  samplePresetTextureV2Batch,
  spinVectorToRgbUnit,
  type PresetTextureSpecV2,
} from "@/shared/domain/magnetization-texture/evaluateV2Client";
import {
  buildPresetSpecFromDraft,
  THREE_DIMENSIONAL_OBJECT_LOCAL_PRESETS,
  type MagneticTextureDraft,
} from "@/shared/domain/magnetization-texture/presetDefaults";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { Slider } from "@/shared/ui/Slider";

export type SlicePlaneMode = "auto" | "xy" | "xz" | "yz";

const RASTER_NX = 96;
const RASTER_NY = 48;
const GLYPH_NX = 17;
const GLYPH_NY = 9;

function resolveAutoSlicePlane(draft: MagneticTextureDraft): "xy" | "xz" | "yz" {
  if (draft.presetKind === "domain_wall" || draft.presetKind === "two_domain") {
    return draft.normalAxis === "z" ? "xz" : "xy";
  }
  if (draft.presetKind === "helical" || draft.presetKind === "conical" || draft.presetKind === "spiral") {
    const q = draft.propagationAxis;
    if (Math.abs(q[2]) > Math.abs(q[0]) && Math.abs(q[2]) > Math.abs(q[1])) {
      return "xz";
    }
    return "xy";
  }
  if (THREE_DIMENSIONAL_OBJECT_LOCAL_PRESETS.has(draft.presetKind)) {
    return "xy";
  }
  return draft.resolvedPlane;
}

function planeCoordinatePoint(
  plane: "xy" | "xz" | "yz",
  u: number,
  v: number,
  depth: number,
): Vec3 {
  if (plane === "xy") return [u, v, depth];
  if (plane === "xz") return [u, depth, v];
  return [depth, u, v];
}

function projectToSliceComponents(
  vec: Vec3,
  plane: "xy" | "xz" | "yz",
): { mu: number; mv: number; mn: number } {
  const frame = orientedPlaneFrame(plane);
  return {
    mu: vec[0] * frame.e_u[0] + vec[1] * frame.e_u[1] + vec[2] * frame.e_u[2],
    mv: vec[0] * frame.e_v[0] + vec[1] * frame.e_v[1] + vec[2] * frame.e_v[2],
    mn: vec[0] * frame.e_n[0] + vec[1] * frame.e_n[1] + vec[2] * frame.e_n[2],
  };
}

function sliceBoundsAxes(
  bounds: TargetMetricBounds,
  plane: "xy" | "xz" | "yz",
): { cu: number; cv: number; cn: number; lu: number; lv: number; ln: number; uIndex: 0 | 1 | 2; vIndex: 0 | 1 | 2 } {
  const [cx, cy, cz] = bounds.localCenter;
  const [lx, ly, lz] = bounds.size;
  if (plane === "xy") {
    return { cu: cx, cv: cy, cn: cz, lu: lx, lv: ly, ln: lz, uIndex: 0, vIndex: 1 };
  }
  if (plane === "xz") {
    return { cu: cx, cv: cz, cn: cy, lu: lx, lv: lz, ln: ly, uIndex: 0, vIndex: 2 };
  }
  return { cu: cy, cv: cz, cn: cx, lu: ly, lv: lz, ln: lx, uIndex: 1, vIndex: 2 };
}

function resolveRegionOutlineStroke(canvas: HTMLCanvasElement): string {
  const docRoot =
    canvas.ownerDocument?.documentElement ??
    (typeof document !== "undefined" ? document.documentElement : null);
  const readTokens = (target: Element | null): string => {
    if (!target || typeof getComputedStyle !== "function") return "";
    try {
      const styles = getComputedStyle(target);
      if (!styles || typeof styles.getPropertyValue !== "function") return "";
      return (
        styles.getPropertyValue("--fm-accent").trim() ||
        styles.getPropertyValue("--fm-text-primary").trim()
      );
    } catch {
      return "";
    }
  };
  return readTokens(canvas) || readTokens(docRoot) || "rgba(248, 250, 255, 0.9)";
}

export interface TexturePreviewCanvasProps {
  draft: MagneticTextureDraft;
  bounds: TargetMetricBounds;
  overrideSpec?: PresetTextureSpecV2 | null;
  regionRecord?: unknown;
  objectBounds?: TargetMetricBounds | null;
  interactiveCenterDrag?: boolean;
  onTranslateInSlice?: (nextTranslationM: Vec3) => void;
}

export function TexturePreviewCanvas({
  draft,
  bounds,
  overrideSpec,
  regionRecord,
  objectBounds,
  interactiveCenterDrag = true,
  onTranslateInSlice,
}: TexturePreviewCanvasProps) {
  const [sliceMode, setSliceMode] = useState<SlicePlaneMode>("auto");
  const [depthRatio, setDepthRatio] = useState(0); // [-0.5, +0.5] of ln
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingCenterRef = useRef(false);

  const effectivePlane = sliceMode === "auto" ? resolveAutoSlicePlane(draft) : sliceMode;
  const referenceBounds = objectBounds ?? bounds;
  const axisMeta = useMemo(
    () => sliceBoundsAxes(referenceBounds, effectivePlane),
    [effectivePlane, referenceBounds],
  );
  const depthMeters = axisMeta.cn + depthRatio * axisMeta.ln;

  const spec = useMemo<PresetTextureSpecV2>(() => {
    if (overrideSpec) return overrideSpec;
    try {
      return buildPresetSpecFromDraft(draft, bounds);
    } catch {
      return {
        preset_kind: "uniform",
        preset_version: 2,
        preset_params: { direction: [1, 0, 0] },
      };
    }
  }, [bounds, draft, overrideSpec]);

  const centerSampleSummary = useMemo(() => {
    try {
      const centerPt = planeCoordinatePoint(
        effectivePlane,
        bounds.localCenter[axisMeta.uIndex],
        bounds.localCenter[axisMeta.vIndex],
        depthMeters,
      );
      const [vec] = samplePresetTextureV2Batch(spec, [centerPt], bounds);
      if (!vec) return "0, 0, 1";
      return `${vec[0].toFixed(2)}, ${vec[1].toFixed(2)}, ${vec[2].toFixed(2)}`;
    } catch {
      return "invalid";
    }
  }, [axisMeta.uIndex, axisMeta.vIndex, bounds, depthMeters, effectivePlane, spec]);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof canvas.getContext !== "function") return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(180, Math.round(rect.width || 280));
    const cssH = 136;
    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Aspect-preserving 1:1 metric letterbox window [cu +/- 0.55 Lu, cv +/- 0.55 Lv]
    const spanU = Math.max(1e-12, 1.1 * axisMeta.lu);
    const spanV = Math.max(1e-12, 1.1 * axisMeta.lv);
    const scalePxPerM = Math.min((cssW - 8) / spanU, (cssH - 8) / spanV);
    const drawW = Math.max(24, spanU * scalePxPerM);
    const drawH = Math.max(24, spanV * scalePxPerM);
    const offsetX = 0.5 * (cssW - drawW);
    const offsetY = 0.5 * (cssH - drawH);

    // Layer 1: 96 x 48 HSL raster
    const rasterPts: Vec3[] = new Array(RASTER_NX * RASTER_NY);
    for (let jy = 0; jy < RASTER_NY; jy += 1) {
      const v = axisMeta.cv + (0.5 - (jy + 0.5) / RASTER_NY) * spanV;
      for (let ix = 0; ix < RASTER_NX; ix += 1) {
        const u = axisMeta.cu + ((ix + 0.5) / RASTER_NX - 0.5) * spanU;
        rasterPts[jy * RASTER_NX + ix] = planeCoordinatePoint(effectivePlane, u, v, depthMeters);
      }
    }

    let sampled: Vec3[];
    try {
      sampled = samplePresetTextureV2Batch(spec, rasterPts, bounds);
    } catch {
      return;
    }

    const cellW = drawW / RASTER_NX;
    const cellH = drawH / RASTER_NY;
    for (let jy = 0; jy < RASTER_NY; jy += 1) {
      const v = axisMeta.cv + (0.5 - (jy + 0.5) / RASTER_NY) * spanV;
      for (let ix = 0; ix < RASTER_NX; ix += 1) {
        const u = axisMeta.cu + ((ix + 0.5) / RASTER_NX - 0.5) * spanU;
        const idx = jy * RASTER_NX + ix;
        const vec = sampled[idx]!;
        const { mu, mv, mn } = projectToSliceComponents(vec, effectivePlane);
        const [r, g, b] = spinVectorToRgbUnit(mu, mv, mn);

        const inObjBounds =
          Math.abs(u - axisMeta.cu) <= 0.5 * axisMeta.lu &&
          Math.abs(v - axisMeta.cv) <= 0.5 * axisMeta.lv;
        const pt3d = rasterPts[idx]!;
        const inRegion = regionRecord ? pointInsideRegionShape(pt3d, regionRecord) : inObjBounds;
        const alpha = inObjBounds && inRegion ? 1.0 : inObjBounds ? 0.28 : 0.14;

        ctx.fillStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
        ctx.fillRect(offsetX + ix * cellW, offsetY + jy * cellH, cellW + 0.6, cellH + 0.6);
      }
    }

    // Object AABB outline
    const objW = axisMeta.lu * scalePxPerM;
    const objH = axisMeta.lv * scalePxPerM;
    const objX = 0.5 * (cssW - objW);
    const objY = 0.5 * (cssH - objH);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 1.1;
    ctx.strokeRect(objX, objY, objW, objH);

    // Optional sub-region dashed outline
    if (objectBounds) {
      const regMeta = sliceBoundsAxes(bounds, effectivePlane);
      const regX = offsetX + ((regMeta.cu - 0.5 * regMeta.lu - (axisMeta.cu - 0.5 * spanU)) / spanU) * drawW;
      const regY = offsetY + ((axisMeta.cv + 0.5 * spanV - (regMeta.cv + 0.5 * regMeta.lv)) / spanV) * drawH;
      const regW = regMeta.lu * scalePxPerM;
      const regH = regMeta.lv * scalePxPerM;
      ctx.save();
      ctx.setLineDash([4, 2.5]);
      ctx.strokeStyle = resolveRegionOutlineStroke(canvas);
      ctx.lineWidth = 1.4;
      ctx.strokeRect(regX, regY, regW, regH);
      ctx.restore();
    }

    // Layer 2: 17 x 9 vector glyph overlay with high-contrast halo for Latte & Mocha
    const glyphPts: Vec3[] = [];
    const glyphMeta: { px: number; py: number }[] = [];
    for (let gy = 0; gy < GLYPH_NY; gy += 1) {
      const v = axisMeta.cv + (0.5 - (gy + 0.5) / GLYPH_NY) * axisMeta.lv;
      const py = objY + ((gy + 0.5) / GLYPH_NY) * objH;
      for (let gx = 0; gx < GLYPH_NX; gx += 1) {
        const u = axisMeta.cu + ((gx + 0.5) / GLYPH_NX - 0.5) * axisMeta.lu;
        const px = objX + ((gx + 0.5) / GLYPH_NX) * objW;
        glyphPts.push(planeCoordinatePoint(effectivePlane, u, v, depthMeters));
        glyphMeta.push({ px, py });
      }
    }
    const glyphVecs = samplePresetTextureV2Batch(spec, glyphPts, bounds);
    for (let i = 0; i < glyphVecs.length; i += 1) {
      const { px, py } = glyphMeta[i]!;
      const { mu, mv, mn } = projectToSliceComponents(glyphVecs[i]!, effectivePlane);
      const inPlane = Math.hypot(mu, mv);
      const darkBg = mn < -0.25;
      const haloStroke = darkBg ? "rgba(0, 0, 0, 0.55)" : "rgba(255, 255, 255, 0.55)";
      const fgStroke = darkBg ? "rgba(248, 250, 255, 0.94)" : "rgba(17, 17, 27, 0.86)";

      if (inPlane >= 0.2) {
        const ux = mu / inPlane;
        const uy = -mv / inPlane;
        const halfLen = 3.4 * Math.min(1, 0.45 + 0.65 * inPlane);
        const sx = px - ux * halfLen;
        const sy = py - uy * halfLen;
        const ex = px + ux * halfLen;
        const ey = py + uy * halfLen;

        for (const [stroke, width] of [
          [haloStroke, 2.5],
          [fgStroke, 1.3],
        ] as const) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(ex, ey);
          const head = 2.0;
          const ang = Math.atan2(ey - sy, ex - sx);
          ctx.moveTo(ex + Math.cos(ang + 2.5) * head, ey + Math.sin(ang + 2.5) * head);
          ctx.lineTo(ex, ey);
          ctx.lineTo(ex + Math.cos(ang - 2.5) * head, ey + Math.sin(ang - 2.5) * head);
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = fgStroke;
        ctx.fillStyle = fgStroke;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(px, py, 1.9, 0, Math.PI * 2);
        if (mn >= 0) {
          ctx.fill();
        } else {
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(px - 1.2, py - 1.2);
          ctx.lineTo(px + 1.2, py + 1.2);
          ctx.moveTo(px - 1.2, py + 1.2);
          ctx.lineTo(px + 1.2, py - 1.2);
          ctx.stroke();
        }
      }
    }

    // Layer 3: Center crosshair `┼` at projected translation + pivot
    const originShift = draft.mappingSpace === "region" ? bounds.localCenter : [0, 0, 0];
    const centerU = originShift[axisMeta.uIndex]! + draft.translationM[axisMeta.uIndex] + draft.pivotM[axisMeta.uIndex];
    const centerV = originShift[axisMeta.vIndex]! + draft.translationM[axisMeta.vIndex] + draft.pivotM[axisMeta.vIndex];
    const crossX = offsetX + ((centerU - (axisMeta.cu - 0.5 * spanU)) / spanU) * drawW;
    const crossY = offsetY + ((axisMeta.cv + 0.5 * spanV - centerV) / spanV) * drawH;
    ctx.strokeStyle = "rgba(17, 17, 27, 0.75)";
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(crossX - 5, crossY);
    ctx.lineTo(crossX + 5, crossY);
    ctx.moveTo(crossX, crossY - 5);
    ctx.lineTo(crossX, crossY + 5);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(crossX - 5, crossY);
    ctx.lineTo(crossX + 5, crossY);
    ctx.moveTo(crossX, crossY - 5);
    ctx.lineTo(crossX, crossY + 5);
    ctx.stroke();
  }, [axisMeta, bounds, depthMeters, draft.mappingSpace, draft.pivotM, draft.translationM, effectivePlane, objectBounds, regionRecord, spec]);

  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const rootHtml =
      canvas?.ownerDocument?.documentElement ??
      (typeof document !== "undefined" ? document.documentElement : null);
    if (!rootHtml || typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => {
      drawCanvas();
    });
    observer.observe(rootHtml, {
      attributeFilter: ["data-theme", "class", "style"],
      attributes: true,
    });
    return () => {
      observer.disconnect();
    };
  }, [drawCanvas]);

  const updateTranslationFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!interactiveCenterDrag || !onTranslateInSlice) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const spanU = Math.max(1e-12, 1.1 * axisMeta.lu);
      const spanV = Math.max(1e-12, 1.1 * axisMeta.lv);
      const scalePxPerM = Math.min((rect.width - 8) / spanU, (rect.height - 8) / spanV);
      const drawW = Math.max(24, spanU * scalePxPerM);
      const drawH = Math.max(24, spanV * scalePxPerM);
      const offsetX = 0.5 * (rect.width - drawW);
      const offsetY = 0.5 * (rect.height - drawH);

      const relX = Math.max(0, Math.min(1, (event.clientX - rect.left - offsetX) / drawW));
      const relY = Math.max(0, Math.min(1, (event.clientY - rect.top - offsetY) / drawH));
      const targetU = axisMeta.cu + (relX - 0.5) * spanU;
      const targetV = axisMeta.cv + (0.5 - relY) * spanV;

      const originShift = draft.mappingSpace === "region" ? bounds.localCenter : [0, 0, 0];
      const next: Vec3 = [...draft.translationM];
      next[axisMeta.uIndex] = targetU - originShift[axisMeta.uIndex]! - draft.pivotM[axisMeta.uIndex];
      next[axisMeta.vIndex] = targetV - originShift[axisMeta.vIndex]! - draft.pivotM[axisMeta.vIndex];
      onTranslateInSlice(next);
    },
    [axisMeta, bounds.localCenter, draft.mappingSpace, draft.pivotM, draft.translationM, interactiveCenterDrag, onTranslateInSlice],
  );

  const showDepthSlider =
    THREE_DIMENSIONAL_OBJECT_LOCAL_PRESETS.has(draft.presetKind) ||
    draft.presetKind === "helical" ||
    draft.presetKind === "conical" ||
    draft.presetKind === "spiral" ||
    Math.hypot(draft.eulerDeg[0], draft.eulerDeg[1], draft.eulerDeg[2]) > 0.5;

  const sizeLabelNm = `${(axisMeta.lu * 1e9).toPrecision(3)} × ${(axisMeta.lv * 1e9).toPrecision(3)} nm`;

  return (
    <div
      className="grid min-w-0 gap-1.5 rounded-xl border border-fm-subtle bg-fm-field p-2"
      data-center-spin={centerSampleSummary}
      data-slice-plane={effectivePlane}
      data-slot="texture-preview"
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <SegmentedControl<SlicePlaneMode>
          aria-label="Preview slice plane"
          options={[
            { value: "auto", label: `Auto (${effectivePlane.toUpperCase()})` },
            { value: "xy", label: "XY" },
            { value: "xz", label: "XZ" },
            { value: "yz", label: "YZ" },
          ]}
          value={sliceMode}
          onValueChange={setSliceMode}
        />
        <span className="text-xs tabular-nums text-fm-secondary">{sizeLabelNm}</span>
      </div>

      {showDepthSlider ? (
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
          <span className="text-xs text-fm-secondary">Slice depth</span>
          <Slider
            aria-label="Slice depth"
            max={0.5}
            min={-0.5}
            step={0.02}
            value={[depthRatio]}
            valueText={(val) => `${(val * axisMeta.ln * 1e9).toFixed(1)} nm`}
            onValueChange={(vals) => setDepthRatio(vals[0] ?? 0)}
          />
          <output className="text-xs tabular-nums text-fm-secondary">
            {(depthRatio * axisMeta.ln * 1e9).toFixed(1)} nm
          </output>
        </div>
      ) : null}

      <div className="grid grid-cols-[1fr_44px] items-stretch gap-1.5">
        <div className="relative overflow-hidden rounded-lg border border-fm-subtle bg-black/20">
          <canvas
            ref={canvasRef}
            aria-label={`2D magnetic texture ${effectivePlane.toUpperCase()} cross-section preview`}
            className="block h-[136px] w-full cursor-crosshair touch-none"
            data-testid="texture-preview-canvas"
            height={136}
            width={280}
            onPointerDown={(event) => {
              if (!interactiveCenterDrag || !onTranslateInSlice) return;
              draggingCenterRef.current = true;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              updateTranslationFromPointer(event);
            }}
            onPointerMove={(event) => {
              if (!draggingCenterRef.current) return;
              updateTranslationFromPointer(event);
            }}
            onPointerUp={(event) => {
              draggingCenterRef.current = false;
              event.currentTarget.releasePointerCapture?.(event.pointerId);
            }}
          />
        </div>

        {/* Azimuth HSL wheel & out-of-plane lightness legend (min 12px tabular-nums) */}
        <div
          aria-hidden="true"
          className="flex flex-col items-center justify-between rounded-lg border border-fm-subtle bg-fm-panel px-1 py-1.5 text-xs tabular-nums text-fm-secondary"
        >
          <span>+1</span>
          <div
            className="h-12 w-2.5 rounded-full border border-fm-subtle"
            style={{
              background:
                "linear-gradient(to bottom, hsl(225 33% 96%) 0%, var(--fm-accent) 50%, hsl(232 21% 7%) 100%)",
            }}
          />
          <span>−1</span>
          <svg height={24} viewBox="0 0 24 24" width={24}>
            <circle cx={12} cy={12} fill="none" r={9} stroke="hsl(0 85% 52%)" strokeDasharray="14 43" strokeWidth={3.5} />
            <circle
              cx={12}
              cy={12}
              fill="none"
              r={9}
              stroke="hsl(90 80% 44%)"
              strokeDasharray="14 43"
              strokeDashoffset={-14}
              strokeWidth={3.5}
            />
            <circle
              cx={12}
              cy={12}
              fill="none"
              r={9}
              stroke="hsl(180 85% 44%)"
              strokeDasharray="14 43"
              strokeDashoffset={-28}
              strokeWidth={3.5}
            />
            <circle
              cx={12}
              cy={12}
              fill="none"
              r={9}
              stroke="hsl(270 85% 58%)"
              strokeDasharray="15 43"
              strokeDashoffset={-42}
              strokeWidth={3.5}
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
