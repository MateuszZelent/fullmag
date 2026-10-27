import { readFileSync } from 'node:fs';
// Render GLSL extracted from the renderer sources without building the application.
// Three.js clipping/color-space chunks are omitted identically for both paths;
// compare raw target pixels, not browser output color management.
const { chromium } = await import(process.env.FULLMAG_PLAYWRIGHT_MODULE ?? 'playwright');
const sourcePath = process.argv[2] ?? new URL('../apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
function extract(name) {
  const marker = `const ${name} = \``;
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error(`Missing shader ${name}`);
  const start = offset + marker.length;
  return source.slice(start, source.indexOf('`;', start)).replace(/#include <[^>]+>/g, '').replace(/\$\{VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE\}/g,'fmComplexRealValue').replace(/\$\{VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE\}/g,'fmComplexImagValue').replace(/\$\{VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE\}/g,'fmScalarValue');
}
const vertexPrefix = 'precision highp float; attribute vec3 position; attribute vec3 normal; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; uniform mat3 normalMatrix;\n';
const inputs = {complex:vertexPrefix + extract('COMPLEX_SCALAR_SURFACE_VERTEX_SHADER'),real:vertexPrefix + extract('SCALAR_SURFACE_VERTEX_SHADER'),fragment:'precision highp float;\n'+extract('SCALAR_SURFACE_FRAGMENT_SHADER')};
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();
 const result=await page.evaluate(({complex,real,fragment})=>{
 const canvas=document.createElement('canvas'); canvas.width=canvas.height=8;
 const gl=canvas.getContext('webgl'); if(!gl) throw Error('WebGL unavailable');
 function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
 function program(vertex){const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));return p;}
 const programs={complex:program(complex),real:program(real)};
 function draw(kind,{re=0,im=0,min=0,max=1,rep=1,color=2,normalized=0,phase=0,gain=1}){
 const p=programs[kind];gl.useProgram(p);
 const attr=(name,size,data)=>{const l=gl.getAttribLocation(p,name);if(l<0)return;const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);gl.enableVertexAttribArray(l);gl.vertexAttribPointer(l,size,gl.FLOAT,false,0,0);};
 attr('position',3,[-1,-1,0,3,-1,0,-1,3,0]);attr('normal',3,[0,0,1,0,0,1,0,0,1]);
 attr('fmScalarValue',1,[normalized,normalized,normalized]);attr('fmComplexRealValue',3,[re,0,0,re,0,0,re,0,0]);attr('fmComplexImagValue',3,[im,0,0,im,0,0,im,0,0]);
 for(const n of ['modelViewMatrix','projectionMatrix'])gl.uniformMatrix4fv(gl.getUniformLocation(p,n),false,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);gl.uniformMatrix3fv(gl.getUniformLocation(p,'normalMatrix'),false,[1,0,0,0,1,0,0,0,1]);
 for(const[n,v]of Object.entries({fmScalarMin:min,fmScalarMax:max,fmAmplitudeScale:gain,fmPhaseRad:phase,fmTemporalPhaseSign:1,fmSpatialPhaseSign:-1,fmOpacity:1,fmShadeStrength:0}))gl.uniform1f(gl.getUniformLocation(p,n),v);
 for(const[n,v]of Object.entries({fmColorModeId:color,fmRepresentationId:rep,fmPaletteId:0,fmFloquetActive:0}))gl.uniform1i(gl.getUniformLocation(p,n),v);
 gl.viewport(0,0,8,8);gl.drawArrays(gl.TRIANGLES,0,3);const pixel=new Uint8Array(4);gl.readPixels(4,4,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];
 }
 const cases=[
 {name:'large-real-midrange',re:1e11,max:2e11,normalized:.5},
 {name:'imag-quarter-range',im:5e10,max:2e11,rep:2,normalized:.25},
 {name:'negative-component',re:-1e11,min:-2e11,max:2e11,normalized:.25},
 {name:'complex-magnitude',re:3e10,im:4e10,max:1e11,rep:3,color:0,normalized:.5},
 {name:'negative-phase-magnitude',re:1,im:-1,min:-Math.PI,max:Math.PI,rep:4,color:0,normalized:.375},
 {name:'degenerate-range',re:5,min:5,max:5,normalized:.5},
 {name:'phase-animation',re:1e11,max:2e11,rep:0,phase:Math.PI/2,normalized:0},
 ];
 return cases.map(c=>{const actual=draw('complex',c),expected=draw('real',c);return {name:c.name,actual,expected,passed:actual.every((v,i)=>Math.abs(v-expected[i])<=2)};});
 },inputs);
 console.log(JSON.stringify(result,null,2));if(result.some(x=>!x.passed))process.exitCode=1;
} finally {await browser.close();}
