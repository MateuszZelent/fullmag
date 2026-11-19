import type { StudyResultStateResource } from "@/kernel/api/apiTypes";
import type { SavedPlaybackResource } from "@/kernel/api/savedResultsPlayback";
import type { DecodedTopology } from "@/kernel/api/codecs";
import { savedSupportNodeIsActive, type DecodedSavedSupport } from "@/kernel/api/codecs/savedSupportCodec";
import { buildTopologySurfaceIndicesForElements } from "../viewport3dTopologyIndexModel";
import { scalarColorRgb } from "@/shared/visualization/scalarColorPalette";

type GridDefinition = Pick<SavedPlaybackResource, "grid_cells_xyz" | "cell_size_m" | "origin_m">;

export function savedGridGeometry(source: GridDefinition, valueOffset = 0, support?: Uint8Array | null) {
  if (!source.grid_cells_xyz || !source.cell_size_m || !source.origin_m) throw new Error("Saved regular grid geometry is missing.");
  const [nx, ny, nz] = source.grid_cells_xyz;
  const [dx, dy, dz] = source.cell_size_m;
  const [ox, oy, oz] = source.origin_m;
  const cellCount = nx * ny * nz;
  let count = cellCount;
  if (support) {
    count = 0;
    for (let i = 0; i < cellCount; i++) count += support[valueOffset + i] ?? 0;
  }
  const positions = new Float32Array(count * 3);
  const sampleIndices = support ? new Uint32Array(count) : null;
  for (let i = 0, active = 0; i < cellCount; i++) {
    const sampleIndex = valueOffset + i;
    if (support && !support[sampleIndex]) continue;
    const ix = i % nx, iy = Math.floor(i / nx) % ny, iz = Math.floor(i / (nx * ny));
    positions.set([(ox + (ix + 0.5) * dx) * 1e6, (oy + (iy + 0.5) * dy) * 1e6, (oz + (iz + 0.5) * dz) * 1e6], active * 3);
    if (sampleIndices) sampleIndices[active] = sampleIndex;
    active++;
  }
  const size: [number, number, number] = [nx * dx * 1e6, ny * dy * 1e6, nz * dz * 1e6];
  const center: [number, number, number] = [(ox + nx * dx / 2) * 1e6, (oy + ny * dy / 2) * 1e6, (oz + nz * dz / 2) * 1e6];
  const cellSize: [number, number, number] = [dx * 1e6, dy * 1e6, dz * 1e6];
  if (positions.some((value) => !Number.isFinite(value)) ||
      [...size, ...center, ...cellSize].some((value) => !Number.isFinite(value))) {
    throw new Error("Saved grid coordinates exceed the display range.");
  }
  return { kind: "instances" as const, count, positions, activeNodes: null, cellSize, size, center, sampleIndices, valueOffset };
}

export function savedStudyGeometry(
  state: StudyResultStateResource,
  topology: DecodedTopology | null,
  support: DecodedSavedSupport | null,
) {
  const geometry = state.geometry;
  if (state.support_available !== Boolean(support) || (support && support.nodeCount !== state.sample_count)) {
    throw new Error("Saved magnetic support differs from the Study state.");
  }
  if (geometry.kind === "fem") {
    if (!topology || !support) throw new Error("Saved FEM geometry is unavailable.");
    return savedSurfaceGeometry(topology, support);
  }
  const activeNodes = support ? Uint8Array.from(
    { length: state.sample_count }, (_, node) => Number(savedSupportNodeIsActive(support, node)),
  ) : null;
  const layers = geometry.kind === "fdm_multilayer" ? geometry.layers : [{ ...geometry, value_offset: 0 }];
  const grids = layers.map((layer) => savedGridGeometry({
    grid_cells_xyz: layer.grid_cells,
    cell_size_m: layer.cell_size_m,
    origin_m: layer.origin_m,
  }, layer.value_offset, activeNodes)).filter((grid) => grid.count > 0);
  if (grids.length === 0) throw new Error("The saved Study grid has no active magnetic cells.");
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const grid of grids) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], grid.center[axis] - grid.size[axis] / 2);
      high[axis] = Math.max(high[axis], grid.center[axis] + grid.size[axis] / 2);
    }
  }
  const size = low.map((value, axis) => high[axis] - value) as [number, number, number];
  const center = low.map((value, axis) => (value + high[axis]) / 2) as [number, number, number];
  return { kind: "grids" as const, grids, size, center, activeNodes };
}

export function savedFrameColors(values: Float64Array, component: 0|1|2, requestedLimit: number|null, activeNodes?: Uint8Array|null) {
  let maximum=0;
  for(let i=component;i<values.length;i+=3) if (!activeNodes || activeNodes[Math.floor(i/3)]) maximum=Math.max(maximum,Math.abs(values[i]));
  const limit=requestedLimit ?? Math.max(maximum,1e-12);
  const colors=new Float32Array(values.length);
  for(let i=0;i<values.length/3;i++) colors.set(scalarColorRgb(0.5+values[i*3+component]/(2*limit),"coolwarm"),i*3);
  return {colors,limit};
}


/** Preserve canonical nodal ordering; only fully active cells define the magnetic surface. */
export function savedSurfaceGeometry(topology: DecodedTopology, support: DecodedSavedSupport) {
  if (support.nodeCount !== topology.nodeCount) throw new Error("Saved topology and active support differ.");
  const count=topology.nodeCount;
  const activeNodes=new Uint8Array(count);
  for(let node=0;node<count;node++) activeNodes[node]=Number(savedSupportNodeIsActive(support,node));
  const cells=new Set<number>();
  const offsets=topology.cellOffsets;
  const nodes=topology.cellNodes;
  if (!offsets || !nodes) throw new Error("Saved topology has no canonical cells.");
  for(let cell=0;cell<offsets.length-1;cell++) {
    let active=true;
    for(let entry=offsets[cell];entry<offsets[cell+1];entry++) if (!activeNodes[nodes[entry]]) {active=false;break;}
    if(active) cells.add(cell);
  }
  const indices=buildTopologySurfaceIndicesForElements(topology,cells);
  if(!indices.length) throw new Error("Saved mesh has no fully active magnetic cells to display.");
  const positions=new Float32Array(topology.positions.length);
  const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
  for(let node=0;node<count;node++) for(let axis=0;axis<3;axis++) {
    const value=topology.positions[node*3+axis]*1e6;
    positions[node*3+axis]=value;
    if(!Number.isFinite(positions[node*3+axis])) throw new Error("Saved mesh coordinates exceed the display range.");
    if(activeNodes[node]) {low[axis]=Math.min(low[axis],value);high[axis]=Math.max(high[axis],value);}
  }
  const size=low.map((value,axis)=>high[axis]-value) as [number,number,number];
  const center=low.map((value,axis)=>(value+high[axis])/2) as [number,number,number];
  return {kind:"surface" as const,count,positions,indices,activeNodes,size,center};
}


/** Fit the whole bounding sphere inside both axes of a 45 degree perspective view. */
export function savedCameraDistance(size: readonly number[], aspect: number): number {
  const radius=Math.hypot(...size)/2;
  const halfAngle=Math.atan(Math.tan(Math.PI/8)*Math.min(1,aspect));
  return radius/Math.sin(halfAngle)*1.1;
}
