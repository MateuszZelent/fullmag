"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import type { ComponentRef } from "react";
import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedMesh, Matrix4, MeshBasicMaterial, Vector3, type Camera, type Mesh } from "three";
import { useKernel } from "@/kernel/KernelContext";
import { useSavedResultsPlaybackSelection } from "@/kernel/saved-results/useSavedResultsPlayback";
import { useSavedResultsFrameResource, useSavedResultsManifestResource, useSavedResultsGeometryResource } from "@/kernel/resources/savedResultsPlaybackResources";
import { scalarColorPaletteGradientCss } from "@/shared/visualization/scalarColorPalette";
import { viewport3dStore } from "./viewport3dStore";
import { Viewport3DCanvas } from "./Viewport3DCanvas";
import { useBatchedInvalidate } from "./viewport3dBatchedInvalidate";
import { Viewport3DErrorBoundary } from "./Viewport3DErrorBoundary";
import { useViewport3DColors } from "./hooks/useViewport3DColors";
import { savedCameraDistance, savedFrameColors, savedGridGeometry, savedSurfaceGeometry } from "./model/savedResultsPlaybackModel";
import type { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";

type Geometry = ReturnType<typeof savedGridGeometry>;
export type SavedFieldCanvasGeometry = Geometry | ReturnType<typeof savedSurfaceGeometry>;
type SavedOrbitControlsHandle = ComponentRef<typeof OrbitControls>;

const SAVED_CAMERA_DEFAULT_DIRECTION = new Vector3(0.2, -0.9, 0.8).normalize();

function applySavedCameraPose({
  camera,
  controls,
  direction,
  geometry,
  aspect,
}: {
  camera: Camera;
  controls: SavedOrbitControlsHandle | null;
  direction: Vector3;
  geometry: SavedFieldCanvasGeometry;
  aspect: number;
}): void {
  const target = new Vector3(...geometry.center);
  const distance = savedCameraDistance(geometry.size, aspect);
  camera.position.copy(target).add(direction.clone().normalize().multiplyScalar(distance));
  camera.lookAt(target);
  camera.updateMatrixWorld();
  if (controls) {
    controls.target.copy(target);
    controls.update();
  }
}

function SavedGridLayer({geometry,colors}: {geometry:Geometry;colors:Float32Array|null}) {
  const invalidate=useBatchedInvalidate("frame-commit");
  const gl=useThree(state=>state.gl);
  const meshRef=useRef<InstancedMesh>(null);
  const resources=useMemo(()=>({
    box:new BoxGeometry(...geometry.cellSize),
    material:new MeshBasicMaterial({toneMapped:false}),
  }),[geometry]);
  const args=useMemo<[BoxGeometry,MeshBasicMaterial,number]>(()=>[resources.box,resources.material,geometry.count],[resources,geometry.count]);
  useLayoutEffect(()=>{
    const mesh=meshRef.current;
    if(!mesh)return;
    const matrix=new Matrix4();
    for(let i=0;i<geometry.count;i++) {
      matrix.makeTranslation(geometry.positions[i*3],geometry.positions[i*3+1],geometry.positions[i*3+2]);
      mesh.setMatrixAt(i,matrix);
    }
    mesh.instanceMatrix.needsUpdate=true;
    mesh.computeBoundingSphere();
    invalidate();
    return ()=>{mesh.dispose();};
  },[geometry,invalidate]);
  useLayoutEffect(()=>{
    const mesh=meshRef.current;
    if(!mesh)return;
    gl.domElement.setAttribute("data-saved-geometry-id",mesh.geometry.uuid);
    gl.domElement.setAttribute("data-saved-instance-id",mesh.uuid);
    if (!colors) { invalidate(); return; }
    const color=new Color();
    for(let i=0;i<geometry.count;i++) mesh.setColorAt(i,color.setRGB(colors[i*3],colors[i*3+1],colors[i*3+2]));
    if(mesh.instanceColor) mesh.instanceColor.needsUpdate=true;
    invalidate();
  },[geometry.count,colors,invalidate,gl]);
  useEffect(()=>()=>{resources.box.dispose();resources.material.dispose();},[resources]);
  return <instancedMesh ref={meshRef} args={args} visible={colors !== null} dispose={null} />;
}

function SavedSurfaceLayer({geometry,colors}: {geometry:ReturnType<typeof savedSurfaceGeometry>;colors:Float32Array|null}) {
  const invalidate=useBatchedInvalidate("frame-commit");
  const gl=useThree(state=>state.gl);
  const meshRef=useRef<Mesh>(null);
  const resources=useMemo(()=>{
    const meshGeometry=new BufferGeometry();
    meshGeometry.setAttribute("position",new BufferAttribute(geometry.positions,3));
    meshGeometry.setIndex(new BufferAttribute(geometry.indices,1));
    meshGeometry.setAttribute("color",new BufferAttribute(new Float32Array(geometry.count*3),3));
    meshGeometry.computeBoundingSphere();
    return {geometry:meshGeometry,material:new MeshBasicMaterial({vertexColors:true,toneMapped:false,side:DoubleSide})};
  },[geometry]);
  useLayoutEffect(()=>{
    const mesh=meshRef.current;
    if(!mesh)return;
    gl.domElement.setAttribute("data-saved-geometry-id",resources.geometry.uuid);
    gl.domElement.setAttribute("data-saved-instance-id",mesh.uuid);
    if(colors) {
      const attribute=resources.geometry.getAttribute("color");
      attribute.array.set(colors);
      attribute.needsUpdate=true;
    }
    invalidate();
  },[resources,colors,gl,invalidate]);
  useEffect(()=>()=>{resources.geometry.dispose();resources.material.dispose();},[resources]);
  return <mesh ref={meshRef} geometry={resources.geometry} material={resources.material} visible={colors !== null} dispose={null}/>;
}

function SavedCamera({geometry,frameIndex}: {geometry:Geometry|ReturnType<typeof savedSurfaceGeometry>;frameIndex:number}) {
  const invalidate=useBatchedInvalidate("frame-commit");
  const camera=useThree(state=>state.camera);
  const gl=useThree(state=>state.gl);
  const size=useThree(state=>state.size);
  const controlsRef=useRef<SavedOrbitControlsHandle>(null);
  const fitted=useRef<typeof geometry|null>(null);
  const report=useCallback(()=>{gl.domElement.setAttribute("data-saved-camera-pose",JSON.stringify({position:camera.position.toArray(),quaternion:camera.quaternion.toArray()}));},[camera,gl]);
  const resetSavedCamera=useCallback(()=>{
    if(size.width<=0 || size.height<=0)return;
    applySavedCameraPose({
      aspect:size.width/size.height,
      camera,
      controls:controlsRef.current,
      direction:SAVED_CAMERA_DEFAULT_DIRECTION,
      geometry,
    });
    report();
    invalidate();
  },[camera,geometry,invalidate,report,size.height,size.width]);
  const fitSavedCamera=useCallback(()=>{
    if(size.width<=0 || size.height<=0)return;
    const controls=controlsRef.current;
    const target=controls?.target ?? new Vector3(...geometry.center);
    const direction=new Vector3().subVectors(camera.position,target);
    if(direction.lengthSq()<=Number.EPSILON) direction.copy(SAVED_CAMERA_DEFAULT_DIRECTION);
    applySavedCameraPose({
      aspect:size.width/size.height,
      camera,
      controls,
      direction,
      geometry,
    });
    report();
    invalidate();
  },[camera,geometry,invalidate,report,size.height,size.width]);
  useLayoutEffect(()=>{
    const unregister=viewport3dStore.registerSavedCameraOwner({fit:fitSavedCamera,reset:resetSavedCamera});
    return ()=>unregister();
  },[fitSavedCamera,resetSavedCamera]);
  useLayoutEffect(()=>{
    if(fitted.current===geometry || size.width<=0 || size.height<=0)return;
    resetSavedCamera();
    fitted.current=geometry;
  },[geometry,resetSavedCamera,size.height,size.width]);
  useLayoutEffect(()=>{report();},[report,frameIndex]);
  return <OrbitControls ref={controlsRef} target={geometry.center} makeDefault enableDamping={false} onChange={()=>{report();invalidate();}} />;
}

export interface SavedFieldCanvasProps {
  geometry: SavedFieldCanvasGeometry;
  colors: Float32Array | null;
  frameIndex: number;
  diagnosticRecorder: Pick<DiagnosticRecorderController, "record">;
  className?: string;
  style?: CSSProperties;
}

/** Shared saved-field canvas used by both legacy playback and results snapshots. */
export function SavedFieldCanvas({
  geometry,
  colors,
  frameIndex,
  diagnosticRecorder,
  className = "fm-saved-playback-canvas",
  style,
}: SavedFieldCanvasProps) {
  const { colors: viewportColors } = useViewport3DColors();
  const camera = useMemo(() => {
    const radius = Math.max(...geometry.size);
    const center = geometry.center;
    return {
      position: [center[0] + radius * 0.2, center[1] - radius * 0.9, center[2] + radius * 0.8] as [number, number, number],
      near: radius / 10000,
      far: radius * 100,
      fov: 45,
    };
  }, [geometry]);

  return (
    <div className={className} style={{ flex: 1, minHeight: 260, position: "relative", ...style }}>
      <Viewport3DErrorBoundary diagnosticRecorder={diagnosticRecorder}>
        <Viewport3DCanvas
          camera={camera}
          frameloop="demand"
          gl={{ preserveDrawingBuffer: true, antialias: true }}
          style={{ background: typeof viewportColors?.background === "string" ? viewportColors.background : "var(--fm-bg-viewport)" }}
        >
          <SavedCamera geometry={geometry} frameIndex={frameIndex} />
          {geometry.kind === "instances" ? (
            <SavedGridLayer geometry={geometry} colors={colors} />
          ) : (
            <SavedSurfaceLayer geometry={geometry} colors={colors} />
          )}
        </Viewport3DCanvas>
      </Viewport3DErrorBoundary>
    </div>
  );
}

export default function SavedResultsPlaybackViewport() {
  const kernel=useKernel();
  const source=useSavedResultsPlaybackSelection();
  const metadata=useSavedResultsManifestResource(source?.itemId ?? null);
  const manifest=metadata.data;
  const stage=manifest?.stages.find(s=>s.stage_id===source?.stageId) ?? (!source?.stageId ? manifest?.stages[0] : undefined);
  const index=Math.min(source?.frameIndex ?? 0,Math.max(0,(stage?.frame_count ?? 1)-1));
  const frame=useSavedResultsFrameResource(source?.itemId ?? null,manifest,stage?.stage_id ?? null,index);
  const mesh=useSavedResultsGeometryResource(source?.itemId ?? null,manifest);
  const geometryResult=useMemo(()=>{
    try {return {geometry:manifest ? manifest.fem_mesh ? (mesh.data ? savedSurfaceGeometry(mesh.data.topology,mesh.data.support):null) : savedGridGeometry(manifest):null,error:null};}
    catch(error) {return {geometry:null,error:error instanceof Error ? error.message : "Saved geometry is invalid."};}
  },[manifest,mesh.data]);
  const geometry=geometryResult.geometry;
  const presentation=useMemo(()=>frame.data && source && geometry ? savedFrameColors(frame.data,source.component,source.colorLimit,geometry.activeNodes):null,[frame.data,source,geometry]);
  const error=metadata.error?.message ?? geometryResult.error ?? mesh.error?.message ?? frame.error?.message ?? (!stage && manifest ? "This saved stage is unavailable." : null);
  const currentReady=frame.status==="ready" && !error && Boolean(presentation);
  return <section className="fm-saved-playback-viewport" aria-label="Saved simulation 3D"
    style={{height:"100%",minHeight:320,position:"relative",display:"flex",flexDirection:"column"}}
    data-saved-frame-index={index} data-saved-frame-state={currentReady ? "ready" : error ? "error" : "loading"}>
    <div className="fm-saved-playback-caption" role="status" style={{padding:"8px 12px",color:"var(--fm-text-primary)",background:"var(--fm-bg-panel)"}}>
      {source?.name} · m_{["x","y","z"][source?.component ?? 2]} · {stage ? ((stage.times_s[index] ?? 0)*1e9).toFixed(3) : "—"} ns · {index+1}/{stage?.frame_count ?? "—"}
      {error ? <span role="alert"> · {error}</span> : !currentReady ? " · Loading selected frame…" : null}
    </div>
    {geometry ? <SavedFieldCanvas colors={currentReady && presentation ? presentation.colors : null} diagnosticRecorder={kernel.diagnosticRecorder} frameIndex={index} geometry={geometry}/> : null}
    {presentation && currentReady ? <div className="fm-saved-playback-legend" aria-label="Magnetization color scale" style={{padding:"8px 12px",color:"var(--fm-text-primary)"}}>
      −{presentation.limit.toExponential(3)} <span className="fm-saved-playback-gradient" style={{display:"inline-block",width:180,height:12,background:scalarColorPaletteGradientCss("coolwarm")}}/> +{presentation.limit.toExponential(3)} · m_{["x","y","z"][source?.component ?? 2]} [1] · {source?.colorLimit === null ? "automatic per frame" : "fixed scale"} · dimensions in µm
    </div> : null}
  </section>;
}
