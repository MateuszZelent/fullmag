import type { SavedPlaybackResource } from "@/kernel/api/savedResultsPlayback";
import { scalarColorRgb } from "@/shared/visualization/scalarColorPalette";

export function savedGridGeometry(source: SavedPlaybackResource) {
  const [nx,ny,nz] = source.grid_cells_xyz;
  const [dx,dy,dz] = source.cell_size_m;
  const [ox,oy,oz] = source.origin_m;
  const count = nx*ny*nz;
  const positions = new Float32Array(count*3);
  for (let i=0;i<count;i++) {
    const ix=i%nx, iy=Math.floor(i/nx)%ny, iz=Math.floor(i/(nx*ny));
    positions.set([(ox+(ix+0.5)*dx)*1e6,(oy+(iy+0.5)*dy)*1e6,(oz+(iz+0.5)*dz)*1e6],i*3);
  }
  const size: [number,number,number] = [nx*dx*1e6,ny*dy*1e6,nz*dz*1e6];
  const center: [number,number,number] = [(ox+nx*dx/2)*1e6,(oy+ny*dy/2)*1e6,(oz+nz*dz/2)*1e6];
  return {count,positions,cellSize:[dx*1e6,dy*1e6,dz*1e6] as [number,number,number],size,center};
}

export function savedFrameColors(values: Float64Array, component: 0|1|2, requestedLimit: number|null) {
  let maximum=0;
  for(let i=component;i<values.length;i+=3) maximum=Math.max(maximum,Math.abs(values[i]));
  const limit=requestedLimit ?? Math.max(maximum,1e-12);
  const colors=new Float32Array(values.length);
  for(let i=0;i<values.length/3;i++) colors.set(scalarColorRgb(0.5+values[i*3+component]/(2*limit),"coolwarm"),i*3);
  return {colors,limit};
}
