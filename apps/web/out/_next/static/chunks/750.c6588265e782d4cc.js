"use strict";(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[750],{5807:(e,o,i)=>{i.d(o,{tW:()=>t,wl:()=>a});let n=new Set,r=[];function t(e){let o=[...function(){let e=window.__FULLMAG_FRONTEND_PERF__;return e?(e!==r&&(r=e),e):(window.__FULLMAG_FRONTEND_PERF__=r,r)}()];for(let i of(o.push(e),o.length>400&&o.splice(0,o.length-400),r=o,window.__FULLMAG_FRONTEND_PERF__=r,n))i()}let l=new Map;function a(e,o){var i;let n=(null!=(i=l.get(e))?i:0)+1;l.set(e,n),t({scope:e,phase:"render",durationMs:0,timestampMs:"undefined"!=typeof performance?performance.now():Date.now(),meta:{renderCount:n,...null!=o?o:{}}})}},36750:(e,o,i)=>{i.r(o),i.d(o,{default:()=>p});var n=i(95155),r=i(12115),t=i(30258),l=i(7952),a=i(88945),s=i(85339),c=i(40264);let f=parseInt(s.sPf.replace(/\D+/g,"")),d=function(e,o,i,n){var r;return(r=class extends s.BKk{constructor(n){for(let r in super({vertexShader:o,fragmentShader:i,...n}),e)this.uniforms[r]=new s.nc$(e[r]),Object.defineProperty(this,r,{get(){return this.uniforms[r].value},set(e){this.uniforms[r].value=e}});this.uniforms=s.LlO.clone(this.uniforms)}}).key=s.cj9.generateUUID(),r}({cellSize:.5,sectionSize:1,fadeDistance:100,fadeStrength:1,fadeFrom:1,cellThickness:.5,sectionThickness:1,cellColor:new s.Q1f,sectionColor:new s.Q1f,infiniteGrid:!1,followCamera:!1,worldCamProjPosition:new s.Pq0,worldPlanePosition:new s.Pq0},`
    varying vec3 localPosition;
    varying vec4 worldPosition;

    uniform vec3 worldCamProjPosition;
    uniform vec3 worldPlanePosition;
    uniform float fadeDistance;
    uniform bool infiniteGrid;
    uniform bool followCamera;

    void main() {
      localPosition = position.xzy;
      if (infiniteGrid) localPosition *= 1.0 + fadeDistance;
      
      worldPosition = modelMatrix * vec4(localPosition, 1.0);
      if (followCamera) {
        worldPosition.xyz += (worldCamProjPosition - worldPlanePosition);
        localPosition = (inverse(modelMatrix) * worldPosition).xyz;
      }

      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
  `,`
    varying vec3 localPosition;
    varying vec4 worldPosition;

    uniform vec3 worldCamProjPosition;
    uniform float cellSize;
    uniform float sectionSize;
    uniform vec3 cellColor;
    uniform vec3 sectionColor;
    uniform float fadeDistance;
    uniform float fadeStrength;
    uniform float fadeFrom;
    uniform float cellThickness;
    uniform float sectionThickness;

    float getGrid(float size, float thickness) {
      vec2 r = localPosition.xz / size;
      vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r);
      float line = min(grid.x, grid.y) + 1.0 - thickness;
      return 1.0 - min(line, 1.0);
    }

    void main() {
      float g1 = getGrid(cellSize, cellThickness);
      float g2 = getGrid(sectionSize, sectionThickness);

      vec3 from = worldCamProjPosition*vec3(fadeFrom);
      float dist = distance(from, worldPosition.xyz);
      float d = 1.0 - min(dist / fadeDistance, 1.0);
      vec3 color = mix(cellColor, sectionColor, min(1.0, sectionThickness * g2));

      gl_FragColor = vec4(color, (g1 + g2) * pow(d, fadeStrength));
      gl_FragColor.a = mix(0.75 * gl_FragColor.a, gl_FragColor.a, g2);
      if (gl_FragColor.a <= 0.0) discard;

      #include <tonemapping_fragment>
      #include <${f>=154?"colorspace_fragment":"encodings_fragment"}>
    }
  `),m=r.forwardRef(({args:e,cellColor:o="#000000",sectionColor:i="#2080ff",cellSize:n=.5,sectionSize:t=1,followCamera:l=!1,infiniteGrid:f=!1,fadeDistance:m=100,fadeStrength:u=1,fadeFrom:g=1,cellThickness:w=.5,sectionThickness:h=1,side:p=s.hsX,...P},v)=>{(0,c.e)({GridMaterial:d});let x=r.useRef(null);r.useImperativeHandle(v,()=>x.current,[]);let _=new s.Zcv,j=new s.Pq0(0,1,0),C=new s.Pq0(0,0,0);return(0,c.D)(e=>{_.setFromNormalAndCoplanarPoint(j,C).applyMatrix4(x.current.matrixWorld);let o=x.current.material,i=o.uniforms.worldCamProjPosition,n=o.uniforms.worldPlanePosition;_.projectPoint(e.camera.position,i.value),n.value.set(0,0,0).applyMatrix4(x.current.matrixWorld)}),r.createElement("mesh",(0,a.A)({ref:x,frustumCulled:!1},P),r.createElement("gridMaterial",(0,a.A)({transparent:!0,"extensions-derivatives":!0,side:p},{cellSize:n,sectionSize:t,cellColor:o,sectionColor:i,cellThickness:w,sectionThickness:h},{fadeDistance:m,fadeStrength:u,fadeFrom:g,infiniteGrid:f,followCamera:l})),r.createElement("planeGeometry",{args:e}))});var u=i(90724),g=i(5807),w=i(15463);function h(){let e=(0,r.useMemo)(()=>[[0,0,0],[1.6,0,0]],[]),o=(0,r.useMemo)(()=>[[0,0,0],[0,1.6,0]],[]),i=(0,r.useMemo)(()=>[[0,0,0],[0,0,1.6]],[]);return(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(l.N,{points:e,color:"#ff5a5a",lineWidth:2}),(0,n.jsx)(l.N,{points:o,color:"#46d17d",lineWidth:2}),(0,n.jsx)(l.N,{points:i,color:"#4f8cff",lineWidth:2})]})}function p(){w.hi.renderDebug.enableRenderLogging&&(0,g.wl)("StandaloneR3fDiagnosticViewport");let[e,o]=(0,r.useState)(0);return(0,n.jsxs)("div",{className:"relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-[#151726]",children:[(0,n.jsxs)(t.Hl,{frameloop:"always",dpr:1,gl:{antialias:!1,powerPreference:"high-performance"},camera:{position:[2.4,1.8,3.2],fov:45,near:.01,far:1e3},children:[(0,n.jsx)("color",{attach:"background",args:["#151726"]}),(0,n.jsx)(h,{}),(0,n.jsx)(m,{position:[0,-.75,0],args:[6,6],cellSize:.5,cellThickness:.6,sectionSize:1.5,sectionThickness:1.1,cellColor:"#252c42",sectionColor:"#3c445f",infiniteGrid:!1,fadeDistance:20,fadeStrength:0}),(0,n.jsxs)("mesh",{position:[-.75,0,0],children:[(0,n.jsx)("boxGeometry",{args:[1.4,.25,.8]}),(0,n.jsx)("meshBasicMaterial",{color:"#4f8cff",wireframe:!0})]}),(0,n.jsxs)("mesh",{position:[.95,.05,0],children:[(0,n.jsx)("torusGeometry",{args:[.42,.12,18,42]}),(0,n.jsx)("meshBasicMaterial",{color:"#ff8a3d",wireframe:!0})]}),(0,n.jsx)(u.N,{enableDamping:!1,screenSpacePanning:!0,onStart:()=>o(e=>e+1)})]}),(0,n.jsxs)("div",{className:"pointer-events-none absolute left-3 top-3 rounded-md border border-white/10 bg-black/35 px-3 py-2 text-xs text-white/80",children:[(0,n.jsx)("div",{children:"Standalone R3F diagnostic viewport"}),(0,n.jsxs)("div",{children:["Interactions: ",e]})]})]})}}}]);