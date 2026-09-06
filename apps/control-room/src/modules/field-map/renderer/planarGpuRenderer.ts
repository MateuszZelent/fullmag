import {
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  WebGLRenderer,
  type WebGLRendererParameters,
} from "three";

import {
  createFdmCellMaterial,
  createFdmCellQuadGeometry,
  createFdmDataTexture,
  disposeFdmCellMesh,
  updateFdmCellMaterial,
  updateFdmCellQuadGeometry,
  updateFdmDataTexture,
  type FdmCellLayerInput,
} from "./fdmCellLayer";
import {
  createFemCutSurfaceGeometry,
  createFemCutSurfaceMaterial,
  disposeFemCutSurfaceMesh,
  updateFemCutSurfaceGeometry,
  updateFemCutSurfaceMaterial,
  type FemCutSurfaceInput,
} from "./femCutSurfaceLayer";
import type { PlanarRenderer } from "./planarRenderer";

type PendingDraw =
  | { kind: "fem"; input: FemCutSurfaceInput }
  | { kind: "fdm"; input: FdmCellLayerInput }
  | { kind: "raster"; pixels: Uint8ClampedArray; width: number; height: number }
  | null;

export interface PlanarGpuRenderer extends PlanarRenderer {
  drawFemCutSurface(input: FemCutSurfaceInput): void;
  drawFdmCells(input: FdmCellLayerInput): void;
  getRendererKind(): "gpu";
  isContextLost(): boolean;
}

export function createPlanarGpuRenderer(
  canvas: HTMLCanvasElement,
  createRenderer: (params: WebGLRendererParameters) => WebGLRenderer = (params) => new WebGLRenderer(params),
): PlanarGpuRenderer | null {
  const gl =
    canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      depth: false,
      powerPreference: "high-performance",
      premultipliedAlpha: true,
      stencil: false,
    }) ??
    canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      depth: false,
      powerPreference: "high-performance",
      premultipliedAlpha: true,
      stencil: false,
    });

  if (!gl) return null;

  let renderer: WebGLRenderer | null = null;
  try {
    renderer = createRenderer({
      alpha: true,
      antialias: true,
      canvas,
      context: gl as WebGL2RenderingContext | WebGLRenderingContext,
      powerPreference: "high-performance",
      premultipliedAlpha: true,
    });
  } catch {
    return null;
  }

  renderer.toneMapping = NoToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.autoClear = false;

  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);

  let contextLost = false;
  let pendingDraw: PendingDraw = null;
  let view: {
    bounds: readonly [number, number, number, number];
    viewport: readonly [number, number, number, number];
  } | null = null;

  let femMesh: Mesh | null = null;
  let fdmMesh: Mesh | null = null;
  let rasterMesh: Mesh | null = null;
  let rasterTexture: DataTexture | null = null;

  const handleContextLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
    if (femMesh) {
      scene.remove(femMesh);
      disposeFemCutSurfaceMesh(femMesh);
      femMesh = null;
    }
    if (fdmMesh) {
      scene.remove(fdmMesh);
      disposeFdmCellMesh(fdmMesh);
      fdmMesh = null;
    }
    disposeRaster();
  };

  const handleContextRestored = () => {
    contextLost = false;
    if (pendingDraw) {
      const pending = pendingDraw;
      pendingDraw = null;
      if (pending.kind === "fem") {
        drawFemCutSurface(pending.input);
      } else if (pending.kind === "fdm") {
        drawFdmCells(pending.input);
      } else if (pending.kind === "raster") {
        draw(pending.pixels, pending.width, pending.height);
      }
    } else {
      paint();
    }
  };

  canvas.addEventListener("webglcontextlost", handleContextLost, false);
  canvas.addEventListener("webglcontextrestored", handleContextRestored, false);

  const updateCameraProjection = () => {
    if (!view || !renderer) return;
    const [uMin, uMax, vMin, vMax] = view.bounds;
    const [vU0, vU1, vV0, vV1] = view.viewport;

    const originU = (uMin + uMax) / 2;
    const originV = (vMin + vMax) / 2;

    camera.left = vU0 - originU;
    camera.right = vU1 - originU;
    camera.bottom = vV0 - originV;
    camera.top = vV1 - originV;
    camera.updateProjectionMatrix();
  };

  const paint = () => {
    if (contextLost || !renderer) return;
    updateCameraProjection();
    renderer.clear();
    renderer.render(scene, camera);
  };

  const disposeRaster = () => {
    if (rasterMesh) {
      scene.remove(rasterMesh);
      rasterMesh.geometry.dispose();
      (rasterMesh.material as MeshBasicMaterial).dispose();
      rasterMesh = null;
    }
    if (rasterTexture) {
      rasterTexture.dispose();
      rasterTexture = null;
    }
  };

  const clearBase = () => {
    pendingDraw = null;
    if (femMesh) {
      scene.remove(femMesh);
      disposeFemCutSurfaceMesh(femMesh);
      femMesh = null;
    }
    if (fdmMesh) {
      scene.remove(fdmMesh);
      disposeFdmCellMesh(fdmMesh);
      fdmMesh = null;
    }
    disposeRaster();
    if (renderer && !contextLost) {
      renderer.clear();
    }
  };

  const drawFemCutSurface = (input: FemCutSurfaceInput) => {
    pendingDraw = { kind: "fem", input };
    if (contextLost) return;
    const originOffset: [number, number] = [
      (input.bounds[0] + input.bounds[1]) / 2,
      (input.bounds[2] + input.bounds[3]) / 2,
    ];

    if (fdmMesh) {
      scene.remove(fdmMesh);
      disposeFdmCellMesh(fdmMesh);
      fdmMesh = null;
    }
    disposeRaster();

    if (femMesh) {
      updateFemCutSurfaceGeometry(femMesh.geometry as BufferGeometry, {
        originOffset,
        scalarValues: input.scalarValues,
        vectorValues: input.vectorValues,
        verticesUv: input.verticesUv,
      });
      updateFemCutSurfaceMaterial(femMesh.material as ShaderMaterial, {
        colormap: input.colormap,
        opacity: input.opacity,
        range: input.range,
        vectorMode: input.vectorMode,
      });
    } else {
      const geometry = createFemCutSurfaceGeometry({
        originOffset,
        scalarValues: input.scalarValues,
        vectorValues: input.vectorValues,
        verticesUv: input.verticesUv,
      });
      const material = createFemCutSurfaceMaterial({
        colormap: input.colormap,
        opacity: input.opacity,
        range: input.range,
        vectorMode: input.vectorMode,
      });
      femMesh = new Mesh(geometry, material);
      scene.add(femMesh);
    }
    paint();
  };

  const drawFdmCells = (input: FdmCellLayerInput) => {
    pendingDraw = { kind: "fdm", input };
    if (contextLost) return;
    const originOffset: [number, number] = [
      (input.bounds[0] + input.bounds[1]) / 2,
      (input.bounds[2] + input.bounds[3]) / 2,
    ];

    if (femMesh) {
      scene.remove(femMesh);
      disposeFemCutSurfaceMesh(femMesh);
      femMesh = null;
    }
    disposeRaster();

    if (fdmMesh) {
      updateFdmCellQuadGeometry(
        fdmMesh.geometry as BufferGeometry,
        input.bounds,
        originOffset,
      );
      const mat = fdmMesh.material as ShaderMaterial;
      const texture = mat.uniforms.fmFieldTexture.value as DataTexture;
      updateFdmDataTexture(
        texture,
        input.scalar,
        input.resolution,
        input.mask,
        input.smooth ?? false,
      );
      updateFdmCellMaterial(mat, texture, {
        colormap: input.colormap,
        opacity: input.opacity,
        range: input.range,
      });
    } else {
      const geometry = createFdmCellQuadGeometry(input.bounds, originOffset);
      const texture = createFdmDataTexture(
        input.scalar,
        input.resolution,
        input.mask,
        input.smooth ?? false,
      );
      const material = createFdmCellMaterial(texture, {
        colormap: input.colormap,
        opacity: input.opacity,
        range: input.range,
      });
      fdmMesh = new Mesh(geometry, material);
      scene.add(fdmMesh);
    }
    paint();
  };

  const draw = (pixels: Uint8ClampedArray, width: number, height: number) => {
    pendingDraw = { kind: "raster", pixels, width, height };
    if (contextLost) return;
    if (femMesh) {
      scene.remove(femMesh);
      disposeFemCutSurfaceMesh(femMesh);
      femMesh = null;
    }
    if (fdmMesh) {
      scene.remove(fdmMesh);
      disposeFdmCellMesh(fdmMesh);
      fdmMesh = null;
    }

    const bounds = view?.bounds ?? [0, width, 0, height];
    const originOffset: [number, number] = [
      (bounds[0] + bounds[1]) / 2,
      (bounds[2] + bounds[3]) / 2,
    ];

    const pixelData = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);

    if (rasterMesh && rasterTexture && rasterTexture.image?.data && rasterTexture.image.width === width && rasterTexture.image.height === height) {
      rasterTexture.image.data.set(pixelData);
      rasterTexture.needsUpdate = true;
      updateFdmCellQuadGeometry(rasterMesh.geometry, bounds, originOffset);
    } else {
      if (rasterMesh) {
        scene.remove(rasterMesh);
        rasterMesh.geometry.dispose();
        (rasterMesh.material as MeshBasicMaterial).dispose();
      }
      if (rasterTexture) {
        rasterTexture.dispose();
      }

      rasterTexture = new DataTexture(
        pixelData,
        width,
        height,
        RGBAFormat,
        UnsignedByteType,
      );
      rasterTexture.wrapS = ClampToEdgeWrapping;
      rasterTexture.wrapT = ClampToEdgeWrapping;
      rasterTexture.magFilter = LinearFilter;
      rasterTexture.minFilter = LinearFilter;
      rasterTexture.generateMipmaps = false;
      rasterTexture.needsUpdate = true;

      const geometry = createFdmCellQuadGeometry(bounds, originOffset);
      const material = new MeshBasicMaterial({
        map: rasterTexture,
        toneMapped: false,
        transparent: true,
      });
      rasterMesh = new Mesh(geometry, material);
      scene.add(rasterMesh);
    }
    paint();
  };

  const setViewport = (
    bounds: readonly [number, number, number, number],
    viewport: readonly [number, number, number, number],
  ) => {
    view = { bounds, viewport };
    paint();
  };

  const resolveViewport = (
    bounds: readonly [number, number, number, number],
    interaction: { panU: number; panV: number; zoom: number },
  ): readonly [number, number, number, number] => {
    const zoom = Math.max(1e-12, interaction.zoom);
    const centerU = (bounds[0] + bounds[1]) / 2 + interaction.panU;
    const centerV = (bounds[2] + bounds[3]) / 2 + interaction.panV;
    const halfU = (bounds[1] - bounds[0]) / (2 * zoom);
    const halfV = (bounds[3] - bounds[2]) / (2 * zoom);
    return [centerU - halfU, centerU + halfU, centerV - halfV, centerV + halfV];
  };

  const resize = (width: number, height: number, dpr: number) => {
    const pixelRatio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    const pixelW = Math.max(1, Math.round(width * pixelRatio));
    const pixelH = Math.max(1, Math.round(height * pixelRatio));
    canvas.width = pixelW;
    canvas.height = pixelH;
    renderer?.setSize(pixelW, pixelH, false);
    paint();
  };

  const dispose = () => {
    canvas.removeEventListener("webglcontextlost", handleContextLost);
    canvas.removeEventListener("webglcontextrestored", handleContextRestored);
    clearBase();
    renderer?.dispose();
    renderer = null;
    canvas.width = 0;
    canvas.height = 0;
    view = null;
  };

  return {
    clearBase,
    dispose,
    draw,
    drawFdmCells,
    drawFemCutSurface,
    getRendererKind: () => "gpu",
    isContextLost: () => contextLost,
    resize,
    resolveViewport,
    setViewport,
  };
}
