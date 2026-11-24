import { describe, it, expect } from 'vitest';
import { buildViewport3DTopologyRenderModel, buildViewport3DFieldRenderModel } from './viewport3dRenderModel';
import { buildVertexScalarColorsChunked } from './viewport3dFieldMapping';
import { mergeViewport3DFieldScalarColors } from './hooks/useViewport3DChunkedScalarColors';
import { finalizeSavedFieldColors } from './savedFieldViewportAdapter';
import { magnitudeColorRgb } from './viewport3dVectorColoring';

const n = 50_004;
function fixture() {
 const positions = new Float64Array(n*3); const values = new Float64Array(n*3);
 for (let i=0;i<n;i++) { positions[i*3]=i/n; values[i*3]=-5+10*i/(n-1); values[i*3+1]=20+10*i/(n-1); }
 positions.set([0,0,0,1,0,0,0,1,0,0,0,1]);
 const topology=buildViewport3DTopologyRenderModel({nodeCount:n,elementCount:1,boundaryFaceCount:4,positions,indices:new Uint32Array([0,1,2,3]),elementMarkers:new Uint32Array([1]),boundaryFaces:new Uint32Array([0,1,2,0,1,3,0,2,3,1,2,3]),boundaryMarkers:new Uint32Array([1,1,1,1])},[],[],new Map())!;
 const field={dtype:'float64' as const,grid:[n,1,1] as [number,number,number],nComp:3,pointCount:n,valueCount:n*3,quantityId:'J_charge',values};
 const model=buildViewport3DFieldRenderModel(topology,field,1,{scalarColorModes:new Set(['x','y']),scalarColorsVisible:true,vectorColorMode:'x',fullScalarColorMode:'x',fullVectorBudget:6})!;
 return {field,model};
}

describe('saved large field colors',()=>{
 it('preserves active shader samples and physical component ranges after async completion',async()=>{
  const {field,model}=fixture();expect(model.scalarColorsByMode.get('x')).toBeNull();
  const buffer=(await buildVertexScalarColorsChunked(field,{colorMode:'x',shaderOnly:true}))!;
  expect(buffer.colors).toHaveLength(0);expect(buffer.range).toEqual({min:-5,max:5});
  const modes=new Map([['x',buffer]]);const parts=new Map([...model.targetPasses.keys()].map(id=>[id,modes]));
  const merged=mergeViewport3DFieldScalarColors(model,modes,'x',parts)!;
  const result=finalizeSavedFieldColors(merged,new Uint8Array(n).fill(1),'x')!;
  expect([...result.scalarColorsByMode.get('x')!.scalarValues!].every(Number.isFinite)).toBe(true);
  const pass=[...result.targetPasses.values()].find(p=>p.vectors.nodeIndices?.length)!;
  expect(pass.vectors.glyphColors).toHaveLength(pass.vectors.nodeIndices!.length*3);
  for(let i=0;i<pass.vectors.nodeIndices!.length;i++) {
   const node=pass.vectors.nodeIndices![i]!;const expected=magnitudeColorRgb((field.values[node*3]!+5)/10,buffer.colorPalette);
   expected.forEach((c,j)=>expect(pass.vectors.glyphColors![i*3+j]).toBeCloseTo(c,5));
  }
 });
 it('marks only inactive shader samples as absent',async()=>{
  const {field,model}=fixture();const buffer=(await buildVertexScalarColorsChunked(field,{colorMode:'x',shaderOnly:true}))!;
  const mask=new Uint8Array(n).fill(1);mask[1]=0;
  const result=finalizeSavedFieldColors(mergeViewport3DFieldScalarColors(model,new Map([['x',buffer]]),'x')!,mask,'x')!;
  const values=result.scalarColorsByMode.get('x')!.scalarValues!;
  expect(values[0]).toBe(0);expect(Number.isNaN(values[1])).toBe(true);expect(values[n-1]).toBe(1);
 });
 it('preserves shader orientation vectors on active samples only',async()=>{
  const {field,model}=fixture();const buffer=(await buildVertexScalarColorsChunked(field,{colorMode:'orientation',shaderOnly:true}))!;
  expect(buffer.colors).toHaveLength(0);expect(buffer.vectorValues).toHaveLength(n*3);
  const mask=new Uint8Array(n).fill(1);mask[1]=0;
  const result=finalizeSavedFieldColors(mergeViewport3DFieldScalarColors(model,new Map([['orientation',buffer]]),'orientation')!,mask,'orientation')!;
  const values=result.scalarColorsByMode.get('orientation')!.vectorValues!;
  expect(Number.isFinite(values[0])).toBe(true);expect(Number.isNaN(values[3])).toBe(true);expect(Number.isFinite(values[n*3-1])).toBe(true);
 });
 it('keeps distinct surface and vector components in physical units',async()=>{
  const {field,model}=fixture();const x=(await buildVertexScalarColorsChunked(field,{colorMode:'x',shaderOnly:true}))!;
  const y=(await buildVertexScalarColorsChunked(field,{colorMode:'y',shaderOnly:true}))!;
  const modes=new Map([['x',x],['y',y]]);const parts=new Map([...model.targetPasses.keys()].map(id=>[id,modes]));
  const result=finalizeSavedFieldColors(mergeViewport3DFieldScalarColors(model,modes,'y',parts)!,new Uint8Array(n).fill(1),'y')!;
  expect(result.scalarColors!.range).toEqual({min:20,max:30});
  expect([...result.targetPasses.values()].every(p=>p.surface.scalarColorMode!=='x'||p.surface.scalarColors?.range.min===-5)).toBe(true);
  expect(result.scalarColorsByMode.get('x')!.range).toEqual({min:-5,max:5});
 });
});
