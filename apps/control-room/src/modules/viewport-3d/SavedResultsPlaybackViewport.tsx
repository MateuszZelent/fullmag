"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedMesh, Matrix4, MeshBasicMaterial, type Mesh } from "three";
import { useKernel } from "@/kernel/KernelContext";
import { useSavedResultsPlaybackSelection } from "@/kernel/saved-results/useSavedResultsPlayback";
import type { SavedFolderPlaybackSelection, SavedStudyPlaybackSelection } from "@/kernel/saved-results/SavedResultsPlaybackController";
import { useStudyResultPlaybackResources } from "@/kernel/resources/studyResultPlaybackResources";
import { Button } from "@/shared/ui/Button";
import { useSavedResultsFrameResource, useSavedResultsManifestResource, useSavedResultsGeometryResource } from "@/kernel/resources/savedResultsPlaybackResources";
import { scalarColorPaletteGradientCss } from "@/shared/visualization/scalarColorPalette";
import { Viewport3DCanvas } from "./Viewport3DCanvas";
import { useBatchedInvalidate } from "./viewport3dBatchedInvalidate";
import { Viewport3DErrorBoundary } from "./Viewport3DErrorBoundary";
import { useViewport3DColors } from "./hooks/useViewport3DColors";
import { savedCameraDistance, savedFrameColors, savedGridGeometry, savedStudyGeometry, savedSurfaceGeometry } from "./model/savedResultsPlaybackModel";

type Geometry = ReturnType<typeof savedGridGeometry>;
type PlaybackGeometry = Geometry | ReturnType<typeof savedStudyGeometry>;

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
    for (let i = 0; i < geometry.count; i++) {
      const offset = 3 * (geometry.sampleIndices?.[i] ?? geometry.valueOffset + i);
      mesh.setColorAt(i, color.setRGB(colors[offset], colors[offset + 1], colors[offset + 2]));
    }
    if(mesh.instanceColor) mesh.instanceColor.needsUpdate=true;
    invalidate();
  },[geometry,colors,invalidate,gl]);
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

function SavedCamera({geometry,frameIndex}: {geometry:Pick<PlaybackGeometry, "size" | "center">;frameIndex:number}) {
  const invalidate=useBatchedInvalidate("frame-commit");
  const camera=useThree(state=>state.camera);
  const gl=useThree(state=>state.gl);
  const size=useThree(state=>state.size);
  const fitted=useRef<typeof geometry|null>(null);
  const report=useCallback(()=>{gl.domElement.setAttribute("data-saved-camera-pose",JSON.stringify({position:camera.position.toArray(),quaternion:camera.quaternion.toArray()}));},[camera,gl]);
  useLayoutEffect(()=>{
    if(fitted.current===geometry || size.width<=0 || size.height<=0)return;
    const distance=savedCameraDistance(geometry.size,size.width/size.height);
    const directionLength=Math.hypot(0.2,0.9,0.8);
    const center=geometry.center;
    camera.position.set(center[0]+distance*0.2/directionLength,center[1]-distance*0.9/directionLength,center[2]+distance*0.8/directionLength);
    camera.lookAt(...center);
    camera.updateMatrixWorld();
    fitted.current=geometry;
    report();
    invalidate();
  },[camera,geometry,invalidate,report,size.width,size.height]);
  useLayoutEffect(()=>{report();},[report,frameIndex]);
  return <OrbitControls target={geometry.center} makeDefault enableDamping={false} onChange={()=>{report();invalidate();}} />;
}

export default function SavedResultsPlaybackViewport() {
  const source = useSavedResultsPlaybackSelection();
  if (!source) return null;
  return source.studyResult
    ? <StudyResultPlayback source={source} />
    : <SavedFolderPlayback source={source} />;
}

function SavedFolderPlayback({ source }: { source: SavedFolderPlaybackSelection }) {
  const metadata=useSavedResultsManifestResource(source.itemId);
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
    {geometry ? <SavedPlaybackCanvas geometry={geometry} frameIndex={index} colors={currentReady ? presentation?.colors ?? null : null} /> : null}
    {presentation && currentReady ? <div className="fm-saved-playback-legend" aria-label="Magnetization color scale" style={{padding:"8px 12px",color:"var(--fm-text-primary)"}}>
      −{presentation.limit.toExponential(3)} <span className="fm-saved-playback-gradient" style={{display:"inline-block",width:180,height:12,background:scalarColorPaletteGradientCss("coolwarm")}}/> +{presentation.limit.toExponential(3)} · m_{["x","y","z"][source?.component ?? 2]} [1] · {source?.colorLimit === null ? "automatic per frame" : "fixed scale"} · dimensions in µm
    </div> : null}
  </section>;
}

function StudyResultPlayback({ source }: { source: SavedStudyPlaybackSelection }) {
  const { savedResultsPlayback } = useKernel();
  const { state, geometry, magnetization } = useStudyResultPlaybackResources(source.studyResult);
  const descriptor = state.data;
  const carrier = geometry.data;
  const samples = magnetization.data;
  const rendered = useMemo(() => {
    try {
      return { geometry: descriptor && carrier ? savedStudyGeometry(descriptor, carrier.topology, carrier.support) : null, error: null };
    } catch (error) {
      return { geometry: null, error: error instanceof Error ? error.message : "Saved Study geometry is invalid." };
    }
  }, [descriptor, carrier]);
  const presentation = useMemo(() =>
    samples && rendered.geometry ? savedFrameColors(samples, source.component, source.colorLimit, rendered.geometry.activeNodes) : null,
  [samples, rendered.geometry, source.component, source.colorLimit]);
  const error = state.error?.message ?? geometry.error?.message ?? magnetization.error?.message ?? rendered.error;
  const ready = Boolean(presentation && !error);
  return (
    <section className="fm-saved-playback-viewport flex h-full min-h-0 flex-col" aria-label="Saved Study result 3D"
      data-saved-frame-state={ready ? "ready" : error ? "error" : "loading"}>
      <header className="flex flex-wrap items-center gap-2 border-b border-fm-border bg-fm-surface px-3 py-2">
        <span role="status">
          {source.name} · case {source.studyResult.source.case_id} · final state
          {descriptor ? ` · step ${descriptor.step} · ${(descriptor.time_s * 1e9).toPrecision(4)} ns` : ""}
          {!ready && !error ? " · Loading saved domain and magnetization…" : ""}
        </span>
        <div className="flex gap-1" role="group" aria-label="Magnetization component">
          {([0, 1, 2] as const).map((component) => (
            <Button key={component} size="sm" variant="ghost" aria-pressed={source.component === component}
              onClick={() => savedResultsPlayback?.setComponent(component)}>m_{["x", "y", "z"][component]}</Button>
          ))}
        </div>
        <Button size="sm" variant="secondary" onClick={() => savedResultsPlayback?.close()}>Return to live</Button>
      </header>
      {error ? <p role="alert" className="px-3 py-2">{error}</p> : null}
      {rendered.geometry && !error ? (
        <SavedPlaybackCanvas geometry={rendered.geometry} frameIndex={0} colors={presentation?.colors ?? null} />
      ) : null}
      {presentation && ready ? (
        <div aria-label="Magnetization color scale" className="px-3 py-2">
          −{presentation.limit.toExponential(3)}{" "}
          <span className="fm-saved-playback-gradient" style={{ display: "inline-block", width: 180, height: 12, background: scalarColorPaletteGradientCss("coolwarm") }} />
          {" "}+{presentation.limit.toExponential(3)} · m_{["x", "y", "z"][source.component]} [1] · dimensions in µm
        </div>
      ) : null}
    </section>
  );
}

function SavedPlaybackCanvas({
  geometry, frameIndex, colors,
}: {
  geometry: PlaybackGeometry;
  frameIndex: number;
  colors: Float32Array | null;
}) {
  const { diagnosticRecorder } = useKernel();
  const { colors: themeColors } = useViewport3DColors();
  const camera = useMemo(() => {
    const radius = Math.max(...geometry.size);
    const center = geometry.center;
    return {
      position: [center[0] + radius * 0.2, center[1] - radius * 0.9, center[2] + radius * 0.8] as [number, number, number],
      near: radius / 10000, far: radius * 100, fov: 45,
    };
  }, [geometry]);
  return (
    <div className="fm-saved-playback-canvas" style={{ flex: 1, minHeight: 260, position: "relative" }}>
      <Viewport3DErrorBoundary diagnosticRecorder={diagnosticRecorder}>
        <Viewport3DCanvas camera={camera} frameloop="demand" gl={{ preserveDrawingBuffer: true, antialias: true }}
          style={{ background: typeof themeColors?.background === "string" ? themeColors.background : "var(--fm-bg-viewport)" }}>
          <SavedCamera geometry={geometry} frameIndex={frameIndex} />
          {geometry.kind === "instances" ? <SavedGridLayer geometry={geometry} colors={colors} /> : null}
          {geometry.kind === "grids" ? geometry.grids.map((grid) => (
            <SavedGridLayer key={grid.valueOffset} geometry={grid} colors={colors} />
          )) : null}
          {geometry.kind === "surface" ? <SavedSurfaceLayer geometry={geometry} colors={colors} /> : null}
        </Viewport3DCanvas>
      </Viewport3DErrorBoundary>
    </div>
  );
}
