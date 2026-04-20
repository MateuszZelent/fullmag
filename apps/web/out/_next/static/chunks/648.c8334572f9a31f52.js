"use strict";(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[648],{3362:(e,t,n)=>{n.d(t,{Q:()=>r});var i=Object.defineProperty;class r{constructor(){((e,t,n)=>((e,t,n)=>t in e?i(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n)(e,"symbol"!=typeof t?t+"":t,n))(this,"_listeners")}addEventListener(e,t){void 0===this._listeners&&(this._listeners={});let n=this._listeners;void 0===n[e]&&(n[e]=[]),-1===n[e].indexOf(t)&&n[e].push(t)}hasEventListener(e,t){if(void 0===this._listeners)return!1;let n=this._listeners;return void 0!==n[e]&&-1!==n[e].indexOf(t)}removeEventListener(e,t){if(void 0===this._listeners)return;let n=this._listeners[e];if(void 0!==n){let e=n.indexOf(t);-1!==e&&n.splice(e,1)}}dispatchEvent(e){if(void 0===this._listeners)return;let t=this._listeners[e.type];if(void 0!==t){e.target=this;let n=t.slice(0);for(let t=0,i=n.length;t<i;t++)n[t].call(this,e);e.target=null}}}},7952:(e,t,n)=>{let i,r;n.d(t,{N:()=>C});var o=n(88945),a=n(12115),s=n(85339),l=n(40264);let c=new s.NRn,u=new s.Pq0;class d extends s.CmU{constructor(){super(),this.isLineSegmentsGeometry=!0,this.type="LineSegmentsGeometry",this.setIndex([0,2,1,2,3,1,2,4,3,4,5,3,4,6,5,6,7,5]),this.setAttribute("position",new s.qtW([-1,2,0,1,2,0,-1,1,0,1,1,0,-1,0,0,1,0,0,-1,-1,0,1,-1,0],3)),this.setAttribute("uv",new s.qtW([-1,2,1,2,-1,1,1,1,-1,-1,1,-1,-1,-2,1,-2],2))}applyMatrix4(e){let t=this.attributes.instanceStart,n=this.attributes.instanceEnd;return void 0!==t&&(t.applyMatrix4(e),n.applyMatrix4(e),t.needsUpdate=!0),null!==this.boundingBox&&this.computeBoundingBox(),null!==this.boundingSphere&&this.computeBoundingSphere(),this}setPositions(e){let t;e instanceof Float32Array?t=e:Array.isArray(e)&&(t=new Float32Array(e));let n=new s.LuO(t,6,1);return this.setAttribute("instanceStart",new s.eHs(n,3,0)),this.setAttribute("instanceEnd",new s.eHs(n,3,3)),this.computeBoundingBox(),this.computeBoundingSphere(),this}setColors(e,t=3){let n;e instanceof Float32Array?n=e:Array.isArray(e)&&(n=new Float32Array(e));let i=new s.LuO(n,2*t,1);return this.setAttribute("instanceColorStart",new s.eHs(i,t,0)),this.setAttribute("instanceColorEnd",new s.eHs(i,t,t)),this}fromWireframeGeometry(e){return this.setPositions(e.attributes.position.array),this}fromEdgesGeometry(e){return this.setPositions(e.attributes.position.array),this}fromMesh(e){return this.fromWireframeGeometry(new s.XJ7(e.geometry)),this}fromLineSegments(e){let t=e.geometry;return this.setPositions(t.attributes.position.array),this}computeBoundingBox(){null===this.boundingBox&&(this.boundingBox=new s.NRn);let e=this.attributes.instanceStart,t=this.attributes.instanceEnd;void 0!==e&&void 0!==t&&(this.boundingBox.setFromBufferAttribute(e),c.setFromBufferAttribute(t),this.boundingBox.union(c))}computeBoundingSphere(){null===this.boundingSphere&&(this.boundingSphere=new s.iyt),null===this.boundingBox&&this.computeBoundingBox();let e=this.attributes.instanceStart,t=this.attributes.instanceEnd;if(void 0!==e&&void 0!==t){let n=this.boundingSphere.center;this.boundingBox.getCenter(n);let i=0;for(let r=0,o=e.count;r<o;r++)u.fromBufferAttribute(e,r),i=Math.max(i,n.distanceToSquared(u)),u.fromBufferAttribute(t,r),i=Math.max(i,n.distanceToSquared(u));this.boundingSphere.radius=Math.sqrt(i),isNaN(this.boundingSphere.radius)&&console.error("THREE.LineSegmentsGeometry.computeBoundingSphere(): Computed radius is NaN. The instanced position data is likely to have NaN values.",this)}}toJSON(){}applyMatrix(e){return console.warn("THREE.LineSegmentsGeometry: applyMatrix() has been renamed to applyMatrix4()."),this.applyMatrix4(e)}}var f=n(87548);let p=parseInt(s.sPf.replace(/\D+/g,""));class h extends s.BKk{constructor(e){super({type:"LineMaterial",uniforms:s.LlO.clone(s.LlO.merge([f.UniformsLib.common,f.UniformsLib.fog,{worldUnits:{value:1},linewidth:{value:1},resolution:{value:new s.I9Y(1,1)},dashOffset:{value:0},dashScale:{value:1},dashSize:{value:1},gapSize:{value:1}}])),vertexShader:`
				#include <common>
				#include <fog_pars_vertex>
				#include <logdepthbuf_pars_vertex>
				#include <clipping_planes_pars_vertex>

				uniform float linewidth;
				uniform vec2 resolution;

				attribute vec3 instanceStart;
				attribute vec3 instanceEnd;

				#ifdef USE_COLOR
					#ifdef USE_LINE_COLOR_ALPHA
						varying vec4 vLineColor;
						attribute vec4 instanceColorStart;
						attribute vec4 instanceColorEnd;
					#else
						varying vec3 vLineColor;
						attribute vec3 instanceColorStart;
						attribute vec3 instanceColorEnd;
					#endif
				#endif

				#ifdef WORLD_UNITS

					varying vec4 worldPos;
					varying vec3 worldStart;
					varying vec3 worldEnd;

					#ifdef USE_DASH

						varying vec2 vUv;

					#endif

				#else

					varying vec2 vUv;

				#endif

				#ifdef USE_DASH

					uniform float dashScale;
					attribute float instanceDistanceStart;
					attribute float instanceDistanceEnd;
					varying float vLineDistance;

				#endif

				void trimSegment( const in vec4 start, inout vec4 end ) {

					// trim end segment so it terminates between the camera plane and the near plane

					// conservative estimate of the near plane
					float a = projectionMatrix[ 2 ][ 2 ]; // 3nd entry in 3th column
					float b = projectionMatrix[ 3 ][ 2 ]; // 3nd entry in 4th column
					float nearEstimate = - 0.5 * b / a;

					float alpha = ( nearEstimate - start.z ) / ( end.z - start.z );

					end.xyz = mix( start.xyz, end.xyz, alpha );

				}

				void main() {

					#ifdef USE_COLOR

						vLineColor = ( position.y < 0.5 ) ? instanceColorStart : instanceColorEnd;

					#endif

					#ifdef USE_DASH

						vLineDistance = ( position.y < 0.5 ) ? dashScale * instanceDistanceStart : dashScale * instanceDistanceEnd;
						vUv = uv;

					#endif

					float aspect = resolution.x / resolution.y;

					// camera space
					vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );
					vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );

					#ifdef WORLD_UNITS

						worldStart = start.xyz;
						worldEnd = end.xyz;

					#else

						vUv = uv;

					#endif

					// special case for perspective projection, and segments that terminate either in, or behind, the camera plane
					// clearly the gpu firmware has a way of addressing this issue when projecting into ndc space
					// but we need to perform ndc-space calculations in the shader, so we must address this issue directly
					// perhaps there is a more elegant solution -- WestLangley

					bool perspective = ( projectionMatrix[ 2 ][ 3 ] == - 1.0 ); // 4th entry in the 3rd column

					if ( perspective ) {

						if ( start.z < 0.0 && end.z >= 0.0 ) {

							trimSegment( start, end );

						} else if ( end.z < 0.0 && start.z >= 0.0 ) {

							trimSegment( end, start );

						}

					}

					// clip space
					vec4 clipStart = projectionMatrix * start;
					vec4 clipEnd = projectionMatrix * end;

					// ndc space
					vec3 ndcStart = clipStart.xyz / clipStart.w;
					vec3 ndcEnd = clipEnd.xyz / clipEnd.w;

					// direction
					vec2 dir = ndcEnd.xy - ndcStart.xy;

					// account for clip-space aspect ratio
					dir.x *= aspect;
					dir = normalize( dir );

					#ifdef WORLD_UNITS

						// get the offset direction as perpendicular to the view vector
						vec3 worldDir = normalize( end.xyz - start.xyz );
						vec3 offset;
						if ( position.y < 0.5 ) {

							offset = normalize( cross( start.xyz, worldDir ) );

						} else {

							offset = normalize( cross( end.xyz, worldDir ) );

						}

						// sign flip
						if ( position.x < 0.0 ) offset *= - 1.0;

						float forwardOffset = dot( worldDir, vec3( 0.0, 0.0, 1.0 ) );

						// don't extend the line if we're rendering dashes because we
						// won't be rendering the endcaps
						#ifndef USE_DASH

							// extend the line bounds to encompass  endcaps
							start.xyz += - worldDir * linewidth * 0.5;
							end.xyz += worldDir * linewidth * 0.5;

							// shift the position of the quad so it hugs the forward edge of the line
							offset.xy -= dir * forwardOffset;
							offset.z += 0.5;

						#endif

						// endcaps
						if ( position.y > 1.0 || position.y < 0.0 ) {

							offset.xy += dir * 2.0 * forwardOffset;

						}

						// adjust for linewidth
						offset *= linewidth * 0.5;

						// set the world position
						worldPos = ( position.y < 0.5 ) ? start : end;
						worldPos.xyz += offset;

						// project the worldpos
						vec4 clip = projectionMatrix * worldPos;

						// shift the depth of the projected points so the line
						// segments overlap neatly
						vec3 clipPose = ( position.y < 0.5 ) ? ndcStart : ndcEnd;
						clip.z = clipPose.z * clip.w;

					#else

						vec2 offset = vec2( dir.y, - dir.x );
						// undo aspect ratio adjustment
						dir.x /= aspect;
						offset.x /= aspect;

						// sign flip
						if ( position.x < 0.0 ) offset *= - 1.0;

						// endcaps
						if ( position.y < 0.0 ) {

							offset += - dir;

						} else if ( position.y > 1.0 ) {

							offset += dir;

						}

						// adjust for linewidth
						offset *= linewidth;

						// adjust for clip-space to screen-space conversion // maybe resolution should be based on viewport ...
						offset /= resolution.y;

						// select end
						vec4 clip = ( position.y < 0.5 ) ? clipStart : clipEnd;

						// back to clip space
						offset *= clip.w;

						clip.xy += offset;

					#endif

					gl_Position = clip;

					vec4 mvPosition = ( position.y < 0.5 ) ? start : end; // this is an approximation

					#include <logdepthbuf_vertex>
					#include <clipping_planes_vertex>
					#include <fog_vertex>

				}
			`,fragmentShader:`
				uniform vec3 diffuse;
				uniform float opacity;
				uniform float linewidth;

				#ifdef USE_DASH

					uniform float dashOffset;
					uniform float dashSize;
					uniform float gapSize;

				#endif

				varying float vLineDistance;

				#ifdef WORLD_UNITS

					varying vec4 worldPos;
					varying vec3 worldStart;
					varying vec3 worldEnd;

					#ifdef USE_DASH

						varying vec2 vUv;

					#endif

				#else

					varying vec2 vUv;

				#endif

				#include <common>
				#include <fog_pars_fragment>
				#include <logdepthbuf_pars_fragment>
				#include <clipping_planes_pars_fragment>

				#ifdef USE_COLOR
					#ifdef USE_LINE_COLOR_ALPHA
						varying vec4 vLineColor;
					#else
						varying vec3 vLineColor;
					#endif
				#endif

				vec2 closestLineToLine(vec3 p1, vec3 p2, vec3 p3, vec3 p4) {

					float mua;
					float mub;

					vec3 p13 = p1 - p3;
					vec3 p43 = p4 - p3;

					vec3 p21 = p2 - p1;

					float d1343 = dot( p13, p43 );
					float d4321 = dot( p43, p21 );
					float d1321 = dot( p13, p21 );
					float d4343 = dot( p43, p43 );
					float d2121 = dot( p21, p21 );

					float denom = d2121 * d4343 - d4321 * d4321;

					float numer = d1343 * d4321 - d1321 * d4343;

					mua = numer / denom;
					mua = clamp( mua, 0.0, 1.0 );
					mub = ( d1343 + d4321 * ( mua ) ) / d4343;
					mub = clamp( mub, 0.0, 1.0 );

					return vec2( mua, mub );

				}

				void main() {

					#include <clipping_planes_fragment>

					#ifdef USE_DASH

						if ( vUv.y < - 1.0 || vUv.y > 1.0 ) discard; // discard endcaps

						if ( mod( vLineDistance + dashOffset, dashSize + gapSize ) > dashSize ) discard; // todo - FIX

					#endif

					float alpha = opacity;

					#ifdef WORLD_UNITS

						// Find the closest points on the view ray and the line segment
						vec3 rayEnd = normalize( worldPos.xyz ) * 1e5;
						vec3 lineDir = worldEnd - worldStart;
						vec2 params = closestLineToLine( worldStart, worldEnd, vec3( 0.0, 0.0, 0.0 ), rayEnd );

						vec3 p1 = worldStart + lineDir * params.x;
						vec3 p2 = rayEnd * params.y;
						vec3 delta = p1 - p2;
						float len = length( delta );
						float norm = len / linewidth;

						#ifndef USE_DASH

							#ifdef USE_ALPHA_TO_COVERAGE

								float dnorm = fwidth( norm );
								alpha = 1.0 - smoothstep( 0.5 - dnorm, 0.5 + dnorm, norm );

							#else

								if ( norm > 0.5 ) {

									discard;

								}

							#endif

						#endif

					#else

						#ifdef USE_ALPHA_TO_COVERAGE

							// artifacts appear on some hardware if a derivative is taken within a conditional
							float a = vUv.x;
							float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
							float len2 = a * a + b * b;
							float dlen = fwidth( len2 );

							if ( abs( vUv.y ) > 1.0 ) {

								alpha = 1.0 - smoothstep( 1.0 - dlen, 1.0 + dlen, len2 );

							}

						#else

							if ( abs( vUv.y ) > 1.0 ) {

								float a = vUv.x;
								float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
								float len2 = a * a + b * b;

								if ( len2 > 1.0 ) discard;

							}

						#endif

					#endif

					vec4 diffuseColor = vec4( diffuse, alpha );
					#ifdef USE_COLOR
						#ifdef USE_LINE_COLOR_ALPHA
							diffuseColor *= vLineColor;
						#else
							diffuseColor.rgb *= vLineColor;
						#endif
					#endif

					#include <logdepthbuf_fragment>

					gl_FragColor = diffuseColor;

					#include <tonemapping_fragment>
					#include <${p>=154?"colorspace_fragment":"encodings_fragment"}>
					#include <fog_fragment>
					#include <premultiplied_alpha_fragment>

				}
			`,clipping:!0}),this.isLineMaterial=!0,this.onBeforeCompile=function(){this.transparent?this.defines.USE_LINE_COLOR_ALPHA="1":delete this.defines.USE_LINE_COLOR_ALPHA},Object.defineProperties(this,{color:{enumerable:!0,get:function(){return this.uniforms.diffuse.value},set:function(e){this.uniforms.diffuse.value=e}},worldUnits:{enumerable:!0,get:function(){return"WORLD_UNITS"in this.defines},set:function(e){!0===e?this.defines.WORLD_UNITS="":delete this.defines.WORLD_UNITS}},linewidth:{enumerable:!0,get:function(){return this.uniforms.linewidth.value},set:function(e){this.uniforms.linewidth.value=e}},dashed:{enumerable:!0,get:function(){return"USE_DASH"in this.defines},set(e){!!e!="USE_DASH"in this.defines&&(this.needsUpdate=!0),!0===e?this.defines.USE_DASH="":delete this.defines.USE_DASH}},dashScale:{enumerable:!0,get:function(){return this.uniforms.dashScale.value},set:function(e){this.uniforms.dashScale.value=e}},dashSize:{enumerable:!0,get:function(){return this.uniforms.dashSize.value},set:function(e){this.uniforms.dashSize.value=e}},dashOffset:{enumerable:!0,get:function(){return this.uniforms.dashOffset.value},set:function(e){this.uniforms.dashOffset.value=e}},gapSize:{enumerable:!0,get:function(){return this.uniforms.gapSize.value},set:function(e){this.uniforms.gapSize.value=e}},opacity:{enumerable:!0,get:function(){return this.uniforms.opacity.value},set:function(e){this.uniforms.opacity.value=e}},resolution:{enumerable:!0,get:function(){return this.uniforms.resolution.value},set:function(e){this.uniforms.resolution.value.copy(e)}},alphaToCoverage:{enumerable:!0,get:function(){return"USE_ALPHA_TO_COVERAGE"in this.defines},set:function(e){!!e!="USE_ALPHA_TO_COVERAGE"in this.defines&&(this.needsUpdate=!0),!0===e?(this.defines.USE_ALPHA_TO_COVERAGE="",this.extensions.derivatives=!0):(delete this.defines.USE_ALPHA_TO_COVERAGE,this.extensions.derivatives=!1)}}}),this.setValues(e)}}let m=p>=125?"uv1":"uv2",v=new s.IUQ,b=new s.Pq0,y=new s.Pq0,g=new s.IUQ,w=new s.IUQ,E=new s.IUQ,x=new s.Pq0,S=new s.kn4,O=new s.cZY,L=new s.Pq0,P=new s.NRn,_=new s.iyt,A=new s.IUQ;function j(e,t,n){return A.set(0,0,-t,1).applyMatrix4(e.projectionMatrix),A.multiplyScalar(1/A.w),A.x=r/n.width,A.y=r/n.height,A.applyMatrix4(e.projectionMatrixInverse),A.multiplyScalar(1/A.w),Math.abs(Math.max(A.x,A.y))}class T extends s.eaF{constructor(e=new d,t=new h({color:0xffffff*Math.random()})){super(e,t),this.isLineSegments2=!0,this.type="LineSegments2"}computeLineDistances(){let e=this.geometry,t=e.attributes.instanceStart,n=e.attributes.instanceEnd,i=new Float32Array(2*t.count);for(let e=0,r=0,o=t.count;e<o;e++,r+=2)b.fromBufferAttribute(t,e),y.fromBufferAttribute(n,e),i[r]=0===r?0:i[r-1],i[r+1]=i[r]+b.distanceTo(y);let r=new s.LuO(i,2,1);return e.setAttribute("instanceDistanceStart",new s.eHs(r,1,0)),e.setAttribute("instanceDistanceEnd",new s.eHs(r,1,1)),this}raycast(e,t){let n,o,a=this.material.worldUnits,l=e.camera;null!==l||a||console.error('LineSegments2: "Raycaster.camera" needs to be set in order to raycast against LineSegments2 while worldUnits is set to false.');let c=void 0!==e.params.Line2&&e.params.Line2.threshold||0;i=e.ray;let u=this.matrixWorld,d=this.geometry,f=this.material;if(r=f.linewidth+c,null===d.boundingSphere&&d.computeBoundingSphere(),_.copy(d.boundingSphere).applyMatrix4(u),a)n=.5*r;else{let e=Math.max(l.near,_.distanceToPoint(i.origin));n=j(l,e,f.resolution)}if(_.radius+=n,!1!==i.intersectsSphere(_)){if(null===d.boundingBox&&d.computeBoundingBox(),P.copy(d.boundingBox).applyMatrix4(u),a)o=.5*r;else{let e=Math.max(l.near,P.distanceToPoint(i.origin));o=j(l,e,f.resolution)}P.expandByScalar(o),!1!==i.intersectsBox(P)&&(a?function(e,t){let n=e.matrixWorld,o=e.geometry,a=o.attributes.instanceStart,l=o.attributes.instanceEnd,c=Math.min(o.instanceCount,a.count);for(let o=0;o<c;o++){O.start.fromBufferAttribute(a,o),O.end.fromBufferAttribute(l,o),O.applyMatrix4(n);let c=new s.Pq0,u=new s.Pq0;i.distanceSqToSegment(O.start,O.end,u,c),u.distanceTo(c)<.5*r&&t.push({point:u,pointOnLine:c,distance:i.origin.distanceTo(u),object:e,face:null,faceIndex:o,uv:null,[m]:null})}}(this,t):function(e,t,n){let o=t.projectionMatrix,a=e.material.resolution,l=e.matrixWorld,c=e.geometry,u=c.attributes.instanceStart,d=c.attributes.instanceEnd,f=Math.min(c.instanceCount,u.count),p=-t.near;i.at(1,E),E.w=1,E.applyMatrix4(t.matrixWorldInverse),E.applyMatrix4(o),E.multiplyScalar(1/E.w),E.x*=a.x/2,E.y*=a.y/2,E.z=0,x.copy(E),S.multiplyMatrices(t.matrixWorldInverse,l);for(let t=0;t<f;t++){if(g.fromBufferAttribute(u,t),w.fromBufferAttribute(d,t),g.w=1,w.w=1,g.applyMatrix4(S),w.applyMatrix4(S),g.z>p&&w.z>p)continue;if(g.z>p){let e=g.z-w.z,t=(g.z-p)/e;g.lerp(w,t)}else if(w.z>p){let e=w.z-g.z,t=(w.z-p)/e;w.lerp(g,t)}g.applyMatrix4(o),w.applyMatrix4(o),g.multiplyScalar(1/g.w),w.multiplyScalar(1/w.w),g.x*=a.x/2,g.y*=a.y/2,w.x*=a.x/2,w.y*=a.y/2,O.start.copy(g),O.start.z=0,O.end.copy(w),O.end.z=0;let c=O.closestPointToPointParameter(x,!0);O.at(c,L);let f=s.cj9.lerp(g.z,w.z,c),h=f>=-1&&f<=1,v=x.distanceTo(L)<.5*r;if(h&&v){O.start.fromBufferAttribute(u,t),O.end.fromBufferAttribute(d,t),O.start.applyMatrix4(l),O.end.applyMatrix4(l);let r=new s.Pq0,o=new s.Pq0;i.distanceSqToSegment(O.start,O.end,o,r),n.push({point:o,pointOnLine:r,distance:i.origin.distanceTo(o),object:e,face:null,faceIndex:t,uv:null,[m]:null})}}}(this,l,t))}}onBeforeRender(e){let t=this.material.uniforms;t&&t.resolution&&(e.getViewport(v),this.material.uniforms.resolution.value.set(v.z,v.w))}}class M extends d{constructor(){super(),this.isLineGeometry=!0,this.type="LineGeometry"}setPositions(e){let t=e.length-3,n=new Float32Array(2*t);for(let i=0;i<t;i+=3)n[2*i]=e[i],n[2*i+1]=e[i+1],n[2*i+2]=e[i+2],n[2*i+3]=e[i+3],n[2*i+4]=e[i+4],n[2*i+5]=e[i+5];return super.setPositions(n),this}setColors(e,t=3){let n=e.length-t,i=new Float32Array(2*n);if(3===t)for(let r=0;r<n;r+=t)i[2*r]=e[r],i[2*r+1]=e[r+1],i[2*r+2]=e[r+2],i[2*r+3]=e[r+3],i[2*r+4]=e[r+4],i[2*r+5]=e[r+5];else for(let r=0;r<n;r+=t)i[2*r]=e[r],i[2*r+1]=e[r+1],i[2*r+2]=e[r+2],i[2*r+3]=e[r+3],i[2*r+4]=e[r+4],i[2*r+5]=e[r+5],i[2*r+6]=e[r+6],i[2*r+7]=e[r+7];return super.setColors(i,t),this}fromLine(e){let t=e.geometry;return this.setPositions(t.attributes.position.array),this}}class z extends T{constructor(e=new M,t=new h({color:0xffffff*Math.random()})){super(e,t),this.isLine2=!0,this.type="Line2"}}let C=a.forwardRef(function({points:e,color:t=0xffffff,vertexColors:n,linewidth:i,lineWidth:r,segments:c,dashed:u,...f},p){var m,v;let b=(0,l.C)(e=>e.size),y=a.useMemo(()=>c?new T:new z,[c]),[g]=a.useState(()=>new h),w=(null==n||null==(m=n[0])?void 0:m.length)===4?4:3,E=a.useMemo(()=>{let i=c?new d:new M,r=e.map(e=>{let t=Array.isArray(e);return e instanceof s.Pq0||e instanceof s.IUQ?[e.x,e.y,e.z]:e instanceof s.I9Y?[e.x,e.y,0]:t&&3===e.length?[e[0],e[1],e[2]]:t&&2===e.length?[e[0],e[1],0]:e});if(i.setPositions(r.flat()),n){t=0xffffff;let e=n.map(e=>e instanceof s.Q1f?e.toArray():e);i.setColors(e.flat(),w)}return i},[e,c,n,w]);return a.useLayoutEffect(()=>{y.computeLineDistances()},[e,y]),a.useLayoutEffect(()=>{u?g.defines.USE_DASH="":delete g.defines.USE_DASH,g.needsUpdate=!0},[u,g]),a.useEffect(()=>()=>{E.dispose(),g.dispose()},[E]),a.createElement("primitive",(0,o.A)({object:y,ref:p},f),a.createElement("primitive",{object:E,attach:"geometry"}),a.createElement("primitive",(0,o.A)({object:g,attach:"material",color:t,vertexColors:!!n,resolution:[b.width,b.height],linewidth:null!=(v=null!=i?i:r)?v:1,dashed:u,transparent:4===w},f)))})},8828:(e,t,n)=>{e.exports=n(83654)},14806:(e,t,n)=>{e.exports=n(30125)},23689:(e,t,n)=>{n.d(t,{DY:()=>a,IU:()=>l,uv:()=>s});let i=[];function r(e,t,n=(e,t)=>e===t){if(e===t)return!0;if(!e||!t)return!1;let i=e.length;if(t.length!==i)return!1;for(let r=0;r<i;r++)if(!n(e[r],t[r]))return!1;return!0}function o(e,t=null,n=!1,a={}){for(let o of(null===t&&(t=[e]),i))if(r(t,o.keys,o.equal)){if(n)return;if(Object.prototype.hasOwnProperty.call(o,"error"))throw o.error;if(Object.prototype.hasOwnProperty.call(o,"response"))return a.lifespan&&a.lifespan>0&&(o.timeout&&clearTimeout(o.timeout),o.timeout=setTimeout(o.remove,a.lifespan)),o.response;if(!n)throw o.promise}let s={keys:t,equal:a.equal,remove:()=>{let e=i.indexOf(s);-1!==e&&i.splice(e,1)},promise:("object"==typeof e&&"function"==typeof e.then?e:e(...t)).then(e=>{s.response=e,a.lifespan&&a.lifespan>0&&(s.timeout=setTimeout(s.remove,a.lifespan))}).catch(e=>s.error=e)};if(i.push(s),!n)throw s.promise}let a=(e,t,n)=>o(e,t,!1,n),s=(e,t,n)=>void o(e,t,!0,n),l=e=>{if(void 0===e||0===e.length)i.splice(0,i.length);else{let t=i.find(t=>r(e,t.keys,t.equal));t&&t.remove()}}},30125:(e,t,n)=>{var i=n(12115),r="function"==typeof Object.is?Object.is:function(e,t){return e===t&&(0!==e||1/e==1/t)||e!=e&&t!=t},o=i.useState,a=i.useEffect,s=i.useLayoutEffect,l=i.useDebugValue;function c(e){var t=e.getSnapshot;e=e.value;try{var n=t();return!r(e,n)}catch(e){return!0}}var u="undefined"==typeof window||void 0===window.document||void 0===window.document.createElement?function(e,t){return t()}:function(e,t){var n=t(),i=o({inst:{value:n,getSnapshot:t}}),r=i[0].inst,u=i[1];return s(function(){r.value=n,r.getSnapshot=t,c(r)&&u({inst:r})},[e,n,t]),a(function(){return c(r)&&u({inst:r}),e(function(){c(r)&&u({inst:r})})},[e]),l(n),n};t.useSyncExternalStore=void 0!==i.useSyncExternalStore?i.useSyncExternalStore:u},30258:(e,t,n)=>{n.d(t,{Hl:()=>d});var i=n(40264),r=n(12115),o=n(87548);function a(e,t){let n;return(...i)=>{window.clearTimeout(n),n=window.setTimeout(()=>e(...i),t)}}let s=["x","y","top","bottom","left","right","width","height"];var l=n(54735),c=n(95155);function u({ref:e,children:t,fallback:n,resize:l,style:u,gl:d,events:f=i.f,eventSource:p,eventPrefix:h,shadows:m,linear:v,flat:b,legacy:y,orthographic:g,frameloop:w,dpr:E,performance:x,raycaster:S,camera:O,scene:L,onPointerMissed:P,onCreated:_,...A}){r.useMemo(()=>(0,i.e)(o),[]);let j=(0,i.u)(),[T,M]=function({debounce:e,scroll:t,polyfill:n,offsetSize:i}={debounce:0,scroll:!1,offsetSize:!1}){var o,l,c;let u=n||("undefined"==typeof window?class{}:window.ResizeObserver);if(!u)throw Error("This browser does not support ResizeObserver out of the box. See: https://github.com/react-spring/react-use-measure/#resize-observer-polyfills");let[d,f]=(0,r.useState)({left:0,top:0,width:0,height:0,bottom:0,right:0,x:0,y:0}),p=(0,r.useRef)({element:null,scrollContainers:null,resizeObserver:null,lastBounds:d,orientationHandler:null}),h=e?"number"==typeof e?e:e.scroll:null,m=e?"number"==typeof e?e:e.resize:null,v=(0,r.useRef)(!1);(0,r.useEffect)(()=>(v.current=!0,()=>void(v.current=!1)));let[b,y,g]=(0,r.useMemo)(()=>{let e=()=>{let e,t;if(!p.current.element)return;let{left:n,top:r,width:o,height:a,bottom:l,right:c,x:u,y:d}=p.current.element.getBoundingClientRect(),h={left:n,top:r,width:o,height:a,bottom:l,right:c,x:u,y:d};p.current.element instanceof HTMLElement&&i&&(h.height=p.current.element.offsetHeight,h.width=p.current.element.offsetWidth),Object.freeze(h),v.current&&(e=p.current.lastBounds,t=h,!s.every(n=>e[n]===t[n]))&&f(p.current.lastBounds=h)};return[e,m?a(e,m):e,h?a(e,h):e]},[f,i,h,m]);function w(){p.current.scrollContainers&&(p.current.scrollContainers.forEach(e=>e.removeEventListener("scroll",g,!0)),p.current.scrollContainers=null),p.current.resizeObserver&&(p.current.resizeObserver.disconnect(),p.current.resizeObserver=null),p.current.orientationHandler&&("orientation"in screen&&"removeEventListener"in screen.orientation?screen.orientation.removeEventListener("change",p.current.orientationHandler):"onorientationchange"in window&&window.removeEventListener("orientationchange",p.current.orientationHandler))}function E(){p.current.element&&(p.current.resizeObserver=new u(g),p.current.resizeObserver.observe(p.current.element),t&&p.current.scrollContainers&&p.current.scrollContainers.forEach(e=>e.addEventListener("scroll",g,{capture:!0,passive:!0})),p.current.orientationHandler=()=>{g()},"orientation"in screen&&"addEventListener"in screen.orientation?screen.orientation.addEventListener("change",p.current.orientationHandler):"onorientationchange"in window&&window.addEventListener("orientationchange",p.current.orientationHandler))}return o=g,l=!!t,(0,r.useEffect)(()=>{if(l)return window.addEventListener("scroll",o,{capture:!0,passive:!0}),()=>void window.removeEventListener("scroll",o,!0)},[o,l]),c=y,(0,r.useEffect)(()=>(window.addEventListener("resize",c),()=>void window.removeEventListener("resize",c)),[c]),(0,r.useEffect)(()=>{w(),E()},[t,g,y]),(0,r.useEffect)(()=>w,[]),[e=>{e&&e!==p.current.element&&(w(),p.current.element=e,p.current.scrollContainers=function e(t){let n=[];if(!t||t===document.body)return n;let{overflow:i,overflowX:r,overflowY:o}=window.getComputedStyle(t);return[i,r,o].some(e=>"auto"===e||"scroll"===e)&&n.push(t),[...n,...e(t.parentElement)]}(e),E())},d,b]}({scroll:!0,debounce:{scroll:50,resize:0},...l}),z=r.useRef(null),C=r.useRef(null);r.useImperativeHandle(e,()=>z.current);let I=(0,i.a)(P),[U,R]=r.useState(!1),[D,k]=r.useState(!1);if(U)throw U;if(D)throw D;let N=r.useRef(null);(0,i.b)(()=>{let e=z.current;M.width>0&&M.height>0&&e&&(N.current||(N.current=(0,i.c)(e)),async function(){await N.current.configure({gl:d,scene:L,events:f,shadows:m,linear:v,flat:b,legacy:y,orthographic:g,frameloop:w,dpr:E,performance:x,raycaster:S,camera:O,size:M,onPointerMissed:(...e)=>null==I.current?void 0:I.current(...e),onCreated:e=>{null==e.events.connect||e.events.connect(p?(0,i.i)(p)?p.current:p:C.current),h&&e.setEvents({compute:(e,t)=>{let n=e[h+"X"],i=e[h+"Y"];t.pointer.set(n/t.size.width*2-1,-(2*(i/t.size.height))+1),t.raycaster.setFromCamera(t.pointer,t.camera)}}),null==_||_(e)}}),N.current.render((0,c.jsx)(j,{children:(0,c.jsx)(i.E,{set:k,children:(0,c.jsx)(r.Suspense,{fallback:(0,c.jsx)(i.B,{set:R}),children:null!=t?t:null})})}))}())}),r.useEffect(()=>{let e=z.current;if(e)return()=>(0,i.d)(e)},[]);let H=p?"none":"auto";return(0,c.jsx)("div",{ref:C,style:{position:"relative",width:"100%",height:"100%",overflow:"hidden",pointerEvents:H,...u},...A,children:(0,c.jsx)("div",{ref:T,style:{width:"100%",height:"100%"},children:(0,c.jsx)("canvas",{ref:z,style:{display:"block"},children:n})})})}function d(e){return(0,c.jsx)(l.Af,{children:(0,c.jsx)(u,{...e})})}n(49914)},49914:(e,t,n)=>{e.exports=n(66451)},54735:(e,t,n)=>{n.d(t,{Af:()=>s,Nz:()=>r,u5:()=>l,y3:()=>d});var i=n(12115);function r(e,t,n){if(!e)return;if(!0===n(e))return e;let i=t?e.return:e.child;for(;i;){let e=r(i,t,n);if(e)return e;i=t?null:i.sibling}}function o(e){try{return Object.defineProperties(e,{_currentRenderer:{get:()=>null,set(){}},_currentRenderer2:{get:()=>null,set(){}}})}catch(t){return e}}(()=>{var e,t;return"undefined"!=typeof window&&((null==(e=window.document)?void 0:e.createElement)||(null==(t=window.navigator)?void 0:t.product)==="ReactNative")})()?i.useLayoutEffect:i.useEffect;let a=o(i.createContext(null));class s extends i.Component{render(){return i.createElement(a.Provider,{value:this._reactInternals},this.props.children)}}function l(){let e=i.useContext(a);if(null===e)throw Error("its-fine: useFiber must be called within a <FiberProvider />!");let t=i.useId();return i.useMemo(()=>{for(let n of[e,null==e?void 0:e.alternate]){if(!n)continue;let e=r(n,!1,e=>{let n=e.memoizedState;for(;n;){if(n.memoizedState===t)return!0;n=n.next}});if(e)return e}},[e,t])}let c=Symbol.for("react.context"),u=e=>null!==e&&"object"==typeof e&&"$$typeof"in e&&e.$$typeof===c;function d(){let e=function(){let e=l(),[t]=i.useState(()=>new Map);t.clear();let n=e;for(;n;){let e=n.type;u(e)&&e!==a&&!t.has(e)&&t.set(e,i.use(o(e))),n=n.return}return t}();return i.useMemo(()=>Array.from(e.keys()).reduce((t,n)=>r=>i.createElement(t,null,i.createElement(n.Provider,{...r,value:e.get(n)})),e=>i.createElement(s,{...e})),[e])}},66451:(e,t)=>{function n(e,t){var n=e.length;for(e.push(t);0<n;){var i=n-1>>>1,r=e[i];if(0<o(r,t))e[i]=t,e[n]=r,n=i;else break}}function i(e){return 0===e.length?null:e[0]}function r(e){if(0===e.length)return null;var t=e[0],n=e.pop();if(n!==t){e[0]=n;for(var i=0,r=e.length,a=r>>>1;i<a;){var s=2*(i+1)-1,l=e[s],c=s+1,u=e[c];if(0>o(l,n))c<r&&0>o(u,l)?(e[i]=u,e[c]=n,i=c):(e[i]=l,e[s]=n,i=s);else if(c<r&&0>o(u,n))e[i]=u,e[c]=n,i=c;else break}}return t}function o(e,t){var n=e.sortIndex-t.sortIndex;return 0!==n?n:e.id-t.id}if(t.unstable_now=void 0,"object"==typeof performance&&"function"==typeof performance.now){var a,s=performance;t.unstable_now=function(){return s.now()}}else{var l=Date,c=l.now();t.unstable_now=function(){return l.now()-c}}var u=[],d=[],f=1,p=null,h=3,m=!1,v=!1,b=!1,y=!1,g="function"==typeof setTimeout?setTimeout:null,w="function"==typeof clearTimeout?clearTimeout:null,E="undefined"!=typeof setImmediate?setImmediate:null;function x(e){for(var t=i(d);null!==t;){if(null===t.callback)r(d);else if(t.startTime<=e)r(d),t.sortIndex=t.expirationTime,n(u,t);else break;t=i(d)}}function S(e){if(b=!1,x(e),!v)if(null!==i(u))v=!0,O||(O=!0,a());else{var t=i(d);null!==t&&z(S,t.startTime-e)}}var O=!1,L=-1,P=5,_=-1;function A(){return!!y||!(t.unstable_now()-_<P)}function j(){if(y=!1,O){var e=t.unstable_now();_=e;var n=!0;try{e:{v=!1,b&&(b=!1,w(L),L=-1),m=!0;var o=h;try{t:{for(x(e),p=i(u);null!==p&&!(p.expirationTime>e&&A());){var s=p.callback;if("function"==typeof s){p.callback=null,h=p.priorityLevel;var l=s(p.expirationTime<=e);if(e=t.unstable_now(),"function"==typeof l){p.callback=l,x(e),n=!0;break t}p===i(u)&&r(u),x(e)}else r(u);p=i(u)}if(null!==p)n=!0;else{var c=i(d);null!==c&&z(S,c.startTime-e),n=!1}}break e}finally{p=null,h=o,m=!1}}}finally{n?a():O=!1}}}if("function"==typeof E)a=function(){E(j)};else if("undefined"!=typeof MessageChannel){var T=new MessageChannel,M=T.port2;T.port1.onmessage=j,a=function(){M.postMessage(null)}}else a=function(){g(j,0)};function z(e,n){L=g(function(){e(t.unstable_now())},n)}t.unstable_IdlePriority=5,t.unstable_ImmediatePriority=1,t.unstable_LowPriority=4,t.unstable_NormalPriority=3,t.unstable_Profiling=null,t.unstable_UserBlockingPriority=2,t.unstable_cancelCallback=function(e){e.callback=null},t.unstable_forceFrameRate=function(e){0>e||125<e?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):P=0<e?Math.floor(1e3/e):5},t.unstable_getCurrentPriorityLevel=function(){return h},t.unstable_next=function(e){switch(h){case 1:case 2:case 3:var t=3;break;default:t=h}var n=h;h=t;try{return e()}finally{h=n}},t.unstable_requestPaint=function(){y=!0},t.unstable_runWithPriority=function(e,t){switch(e){case 1:case 2:case 3:case 4:case 5:break;default:e=3}var n=h;h=e;try{return t()}finally{h=n}},t.unstable_scheduleCallback=function(e,r,o){var s=t.unstable_now();switch(o="object"==typeof o&&null!==o&&"number"==typeof(o=o.delay)&&0<o?s+o:s,e){case 1:var l=-1;break;case 2:l=250;break;case 5:l=0x3fffffff;break;case 4:l=1e4;break;default:l=5e3}return l=o+l,e={id:f++,callback:r,priorityLevel:e,startTime:o,expirationTime:l,sortIndex:-1},o>s?(e.sortIndex=o,n(d,e),null===i(u)&&e===i(d)&&(b?(w(L),L=-1):b=!0,z(S,o-s))):(e.sortIndex=l,n(u,e),v||m||(v=!0,O||(O=!0,a()))),e},t.unstable_shouldYield=A,t.unstable_wrapCallback=function(e){var t=h;return function(){var n=h;h=t;try{return e.apply(this,arguments)}finally{h=n}}}},83580:(e,t,n)=>{n.d(t,{h:()=>l});var i=n(12115),r=n(8828),o=n(90490);let{useSyncExternalStoreWithSelector:a}=r,s=(e,t)=>{let n=(0,o.y)(e),r=(e,r=t)=>(function(e,t=e=>e,n){let r=a(e.subscribe,e.getState,e.getInitialState,t,n);return i.useDebugValue(r),r})(n,e,r);return Object.assign(r,n),r},l=(e,t)=>e?s(e,t):s},83654:(e,t,n)=>{var i=n(12115),r=n(14806),o="function"==typeof Object.is?Object.is:function(e,t){return e===t&&(0!==e||1/e==1/t)||e!=e&&t!=t},a=r.useSyncExternalStore,s=i.useRef,l=i.useEffect,c=i.useMemo,u=i.useDebugValue;t.useSyncExternalStoreWithSelector=function(e,t,n,i,r){var d=s(null);if(null===d.current){var f={hasValue:!1,value:null};d.current=f}else f=d.current;var p=a(e,(d=c(function(){function e(e){if(!l){if(l=!0,a=e,e=i(e),void 0!==r&&f.hasValue){var t=f.value;if(r(t,e))return s=t}return s=e}if(t=s,o(a,e))return t;var n=i(e);return void 0!==r&&r(t,n)?(a=e,t):(a=e,s=n)}var a,s,l=!1,c=void 0===n?null:n;return[function(){return e(t())},null===c?void 0:function(){return e(c())}]},[t,n,i,r]))[0],d[1]);return l(function(){f.hasValue=!0,f.value=p},[p]),u(p),p}},88945:(e,t,n)=>{n.d(t,{A:()=>i});function i(){return(i=Object.assign?Object.assign.bind():function(e){for(var t=1;t<arguments.length;t++){var n=arguments[t];for(var i in n)({}).hasOwnProperty.call(n,i)&&(e[i]=n[i])}return e}).apply(null,arguments)}},90724:(e,t,n)=>{n.d(t,{N:()=>m});var i=n(88945),r=n(40264),o=n(12115),a=n(85339),s=n(3362),l=Object.defineProperty,c=(e,t,n)=>(((e,t,n)=>t in e?l(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n)(e,"symbol"!=typeof t?t+"":t,n),n);let u=new a.RlV,d=new a.Zcv,f=Math.cos(Math.PI/180*70),p=(e,t)=>(e%t+t)%t;class h extends s.Q{constructor(e,t){super(),c(this,"object"),c(this,"domElement"),c(this,"enabled",!0),c(this,"target",new a.Pq0),c(this,"minDistance",0),c(this,"maxDistance",1/0),c(this,"minZoom",0),c(this,"maxZoom",1/0),c(this,"minPolarAngle",0),c(this,"maxPolarAngle",Math.PI),c(this,"minAzimuthAngle",-1/0),c(this,"maxAzimuthAngle",1/0),c(this,"enableDamping",!1),c(this,"dampingFactor",.05),c(this,"enableZoom",!0),c(this,"zoomSpeed",1),c(this,"enableRotate",!0),c(this,"rotateSpeed",1),c(this,"enablePan",!0),c(this,"panSpeed",1),c(this,"screenSpacePanning",!0),c(this,"keyPanSpeed",7),c(this,"zoomToCursor",!1),c(this,"autoRotate",!1),c(this,"autoRotateSpeed",2),c(this,"reverseOrbit",!1),c(this,"reverseHorizontalOrbit",!1),c(this,"reverseVerticalOrbit",!1),c(this,"keys",{LEFT:"ArrowLeft",UP:"ArrowUp",RIGHT:"ArrowRight",BOTTOM:"ArrowDown"}),c(this,"mouseButtons",{LEFT:a.kBv.ROTATE,MIDDLE:a.kBv.DOLLY,RIGHT:a.kBv.PAN}),c(this,"touches",{ONE:a.wtR.ROTATE,TWO:a.wtR.DOLLY_PAN}),c(this,"target0"),c(this,"position0"),c(this,"zoom0"),c(this,"_domElementKeyEvents",null),c(this,"getPolarAngle"),c(this,"getAzimuthalAngle"),c(this,"setPolarAngle"),c(this,"setAzimuthalAngle"),c(this,"getDistance"),c(this,"getZoomScale"),c(this,"listenToKeyEvents"),c(this,"stopListenToKeyEvents"),c(this,"saveState"),c(this,"reset"),c(this,"update"),c(this,"connect"),c(this,"dispose"),c(this,"dollyIn"),c(this,"dollyOut"),c(this,"getScale"),c(this,"setScale"),this.object=e,this.domElement=t,this.target0=this.target.clone(),this.position0=this.object.position.clone(),this.zoom0=this.object.zoom,this.getPolarAngle=()=>m.phi,this.getAzimuthalAngle=()=>m.theta,this.setPolarAngle=e=>{let t=p(e,2*Math.PI),i=m.phi;i<0&&(i+=2*Math.PI),t<0&&(t+=2*Math.PI);let r=Math.abs(t-i);2*Math.PI-r<r&&(t<i?t+=2*Math.PI:i+=2*Math.PI),v.phi=t-i,n.update()},this.setAzimuthalAngle=e=>{let t=p(e,2*Math.PI),i=m.theta;i<0&&(i+=2*Math.PI),t<0&&(t+=2*Math.PI);let r=Math.abs(t-i);2*Math.PI-r<r&&(t<i?t+=2*Math.PI:i+=2*Math.PI),v.theta=t-i,n.update()},this.getDistance=()=>n.object.position.distanceTo(n.target),this.listenToKeyEvents=e=>{e.addEventListener("keydown",ee),this._domElementKeyEvents=e},this.stopListenToKeyEvents=()=>{this._domElementKeyEvents.removeEventListener("keydown",ee),this._domElementKeyEvents=null},this.saveState=()=>{n.target0.copy(n.target),n.position0.copy(n.object.position),n.zoom0=n.object.zoom},this.reset=()=>{n.target.copy(n.target0),n.object.position.copy(n.position0),n.object.zoom=n.zoom0,n.object.updateProjectionMatrix(),n.dispatchEvent(i),n.update(),l=s.NONE},this.update=(()=>{let t=new a.Pq0,r=new a.Pq0(0,1,0),o=new a.PTz().setFromUnitVectors(e.up,r),c=o.clone().invert(),p=new a.Pq0,g=new a.PTz,w=2*Math.PI;return function(){let E=n.object.position;o.setFromUnitVectors(e.up,r),c.copy(o).invert(),t.copy(E).sub(n.target),t.applyQuaternion(o),m.setFromVector3(t),n.autoRotate&&l===s.NONE&&I(2*Math.PI/60/60*n.autoRotateSpeed),n.enableDamping?(m.theta+=v.theta*n.dampingFactor,m.phi+=v.phi*n.dampingFactor):(m.theta+=v.theta,m.phi+=v.phi);let x=n.minAzimuthAngle,S=n.maxAzimuthAngle;isFinite(x)&&isFinite(S)&&(x<-Math.PI?x+=w:x>Math.PI&&(x-=w),S<-Math.PI?S+=w:S>Math.PI&&(S-=w),x<=S?m.theta=Math.max(x,Math.min(S,m.theta)):m.theta=m.theta>(x+S)/2?Math.max(x,m.theta):Math.min(S,m.theta)),m.phi=Math.max(n.minPolarAngle,Math.min(n.maxPolarAngle,m.phi)),m.makeSafe(),!0===n.enableDamping?n.target.addScaledVector(y,n.dampingFactor):n.target.add(y),n.zoomToCursor&&T||n.object.isOrthographicCamera?m.radius=B(m.radius):m.radius=B(m.radius*b),t.setFromSpherical(m),t.applyQuaternion(c),E.copy(n.target).add(t),n.object.matrixAutoUpdate||n.object.updateMatrix(),n.object.lookAt(n.target),!0===n.enableDamping?(v.theta*=1-n.dampingFactor,v.phi*=1-n.dampingFactor,y.multiplyScalar(1-n.dampingFactor)):(v.set(0,0,0),y.set(0,0,0));let O=!1;if(n.zoomToCursor&&T){let i=null;if(n.object instanceof a.ubm&&n.object.isPerspectiveCamera){let e=t.length();i=B(e*b);let r=e-i;n.object.position.addScaledVector(A,r),n.object.updateMatrixWorld()}else if(n.object.isOrthographicCamera){let e=new a.Pq0(j.x,j.y,0);e.unproject(n.object),n.object.zoom=Math.max(n.minZoom,Math.min(n.maxZoom,n.object.zoom/b)),n.object.updateProjectionMatrix(),O=!0;let r=new a.Pq0(j.x,j.y,0);r.unproject(n.object),n.object.position.sub(r).add(e),n.object.updateMatrixWorld(),i=t.length()}else console.warn("WARNING: OrbitControls.js encountered an unknown camera type - zoom to cursor disabled."),n.zoomToCursor=!1;null!==i&&(n.screenSpacePanning?n.target.set(0,0,-1).transformDirection(n.object.matrix).multiplyScalar(i).add(n.object.position):(u.origin.copy(n.object.position),u.direction.set(0,0,-1).transformDirection(n.object.matrix),Math.abs(n.object.up.dot(u.direction))<f?e.lookAt(n.target):(d.setFromNormalAndCoplanarPoint(n.object.up,n.target),u.intersectPlane(d,n.target))))}else n.object instanceof a.qUd&&n.object.isOrthographicCamera&&(O=1!==b)&&(n.object.zoom=Math.max(n.minZoom,Math.min(n.maxZoom,n.object.zoom/b)),n.object.updateProjectionMatrix());return b=1,T=!1,!!(O||p.distanceToSquared(n.object.position)>h||8*(1-g.dot(n.object.quaternion))>h)&&(n.dispatchEvent(i),p.copy(n.object.position),g.copy(n.object.quaternion),O=!1,!0)}})(),this.connect=e=>{n.domElement=e,n.domElement.style.touchAction="none",n.domElement.addEventListener("contextmenu",et),n.domElement.addEventListener("pointerdown",K),n.domElement.addEventListener("pointercancel",$),n.domElement.addEventListener("wheel",J)},this.dispose=()=>{var e,t,i,r,o,a;n.domElement&&(n.domElement.style.touchAction="auto"),null==(e=n.domElement)||e.removeEventListener("contextmenu",et),null==(t=n.domElement)||t.removeEventListener("pointerdown",K),null==(i=n.domElement)||i.removeEventListener("pointercancel",$),null==(r=n.domElement)||r.removeEventListener("wheel",J),null==(o=n.domElement)||o.ownerDocument.removeEventListener("pointermove",Q),null==(a=n.domElement)||a.ownerDocument.removeEventListener("pointerup",$),null!==n._domElementKeyEvents&&n._domElementKeyEvents.removeEventListener("keydown",ee)};let n=this,i={type:"change"},r={type:"start"},o={type:"end"},s={NONE:-1,ROTATE:0,DOLLY:1,PAN:2,TOUCH_ROTATE:3,TOUCH_PAN:4,TOUCH_DOLLY_PAN:5,TOUCH_DOLLY_ROTATE:6},l=s.NONE,h=1e-6,m=new a.YHV,v=new a.YHV,b=1,y=new a.Pq0,g=new a.I9Y,w=new a.I9Y,E=new a.I9Y,x=new a.I9Y,S=new a.I9Y,O=new a.I9Y,L=new a.I9Y,P=new a.I9Y,_=new a.I9Y,A=new a.Pq0,j=new a.I9Y,T=!1,M=[],z={};function C(){return Math.pow(.95,n.zoomSpeed)}function I(e){n.reverseOrbit||n.reverseHorizontalOrbit?v.theta+=e:v.theta-=e}function U(e){n.reverseOrbit||n.reverseVerticalOrbit?v.phi+=e:v.phi-=e}let R=(()=>{let e=new a.Pq0;return function(t,n){e.setFromMatrixColumn(n,0),e.multiplyScalar(-t),y.add(e)}})(),D=(()=>{let e=new a.Pq0;return function(t,i){!0===n.screenSpacePanning?e.setFromMatrixColumn(i,1):(e.setFromMatrixColumn(i,0),e.crossVectors(n.object.up,e)),e.multiplyScalar(t),y.add(e)}})(),k=(()=>{let e=new a.Pq0;return function(t,i){let r=n.domElement;if(r&&n.object instanceof a.ubm&&n.object.isPerspectiveCamera){let o=n.object.position;e.copy(o).sub(n.target);let a=e.length();R(2*t*(a*=Math.tan(n.object.fov/2*Math.PI/180))/r.clientHeight,n.object.matrix),D(2*i*a/r.clientHeight,n.object.matrix)}else r&&n.object instanceof a.qUd&&n.object.isOrthographicCamera?(R(t*(n.object.right-n.object.left)/n.object.zoom/r.clientWidth,n.object.matrix),D(i*(n.object.top-n.object.bottom)/n.object.zoom/r.clientHeight,n.object.matrix)):(console.warn("WARNING: OrbitControls.js encountered an unknown camera type - pan disabled."),n.enablePan=!1)}})();function N(e){n.object instanceof a.ubm&&n.object.isPerspectiveCamera||n.object instanceof a.qUd&&n.object.isOrthographicCamera?b=e:(console.warn("WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled."),n.enableZoom=!1)}function H(e){if(!n.zoomToCursor||!n.domElement)return;T=!0;let t=n.domElement.getBoundingClientRect(),i=e.clientX-t.left,r=e.clientY-t.top,o=t.width,a=t.height;j.x=i/o*2-1,j.y=-(r/a*2)+1,A.set(j.x,j.y,1).unproject(n.object).sub(n.object.position).normalize()}function B(e){return Math.max(n.minDistance,Math.min(n.maxDistance,e))}function Y(e){g.set(e.clientX,e.clientY)}function q(e){x.set(e.clientX,e.clientY)}function F(){if(1==M.length)g.set(M[0].pageX,M[0].pageY);else{let e=.5*(M[0].pageX+M[1].pageX),t=.5*(M[0].pageY+M[1].pageY);g.set(e,t)}}function V(){if(1==M.length)x.set(M[0].pageX,M[0].pageY);else{let e=.5*(M[0].pageX+M[1].pageX),t=.5*(M[0].pageY+M[1].pageY);x.set(e,t)}}function W(){let e=M[0].pageX-M[1].pageX,t=M[0].pageY-M[1].pageY,n=Math.sqrt(e*e+t*t);L.set(0,n)}function X(e){if(1==M.length)w.set(e.pageX,e.pageY);else{let t=ei(e),n=.5*(e.pageX+t.x),i=.5*(e.pageY+t.y);w.set(n,i)}E.subVectors(w,g).multiplyScalar(n.rotateSpeed);let t=n.domElement;t&&(I(2*Math.PI*E.x/t.clientHeight),U(2*Math.PI*E.y/t.clientHeight)),g.copy(w)}function Z(e){if(1==M.length)S.set(e.pageX,e.pageY);else{let t=ei(e),n=.5*(e.pageX+t.x),i=.5*(e.pageY+t.y);S.set(n,i)}O.subVectors(S,x).multiplyScalar(n.panSpeed),k(O.x,O.y),x.copy(S)}function G(e){var t;let i=ei(e),r=e.pageX-i.x,o=e.pageY-i.y,a=Math.sqrt(r*r+o*o);P.set(0,a),_.set(0,Math.pow(P.y/L.y,n.zoomSpeed)),t=_.y,N(b/t),L.copy(P)}function K(e){var t,i,o;!1!==n.enabled&&(0===M.length&&(null==(t=n.domElement)||t.ownerDocument.addEventListener("pointermove",Q),null==(i=n.domElement)||i.ownerDocument.addEventListener("pointerup",$)),o=e,M.push(o),"touch"===e.pointerType?function(e){switch(en(e),M.length){case 1:switch(n.touches.ONE){case a.wtR.ROTATE:if(!1===n.enableRotate)return;F(),l=s.TOUCH_ROTATE;break;case a.wtR.PAN:if(!1===n.enablePan)return;V(),l=s.TOUCH_PAN;break;default:l=s.NONE}break;case 2:switch(n.touches.TWO){case a.wtR.DOLLY_PAN:if(!1===n.enableZoom&&!1===n.enablePan)return;n.enableZoom&&W(),n.enablePan&&V(),l=s.TOUCH_DOLLY_PAN;break;case a.wtR.DOLLY_ROTATE:if(!1===n.enableZoom&&!1===n.enableRotate)return;n.enableZoom&&W(),n.enableRotate&&F(),l=s.TOUCH_DOLLY_ROTATE;break;default:l=s.NONE}break;default:l=s.NONE}l!==s.NONE&&n.dispatchEvent(r)}(e):function(e){let t;switch(e.button){case 0:t=n.mouseButtons.LEFT;break;case 1:t=n.mouseButtons.MIDDLE;break;case 2:t=n.mouseButtons.RIGHT;break;default:t=-1}switch(t){case a.kBv.DOLLY:if(!1===n.enableZoom)return;H(e),L.set(e.clientX,e.clientY),l=s.DOLLY;break;case a.kBv.ROTATE:if(e.ctrlKey||e.metaKey||e.shiftKey){if(!1===n.enablePan)return;q(e),l=s.PAN}else{if(!1===n.enableRotate)return;Y(e),l=s.ROTATE}break;case a.kBv.PAN:if(e.ctrlKey||e.metaKey||e.shiftKey){if(!1===n.enableRotate)return;Y(e),l=s.ROTATE}else{if(!1===n.enablePan)return;q(e),l=s.PAN}break;default:l=s.NONE}l!==s.NONE&&n.dispatchEvent(r)}(e))}function Q(e){!1!==n.enabled&&("touch"===e.pointerType?function(e){switch(en(e),l){case s.TOUCH_ROTATE:if(!1===n.enableRotate)return;X(e),n.update();break;case s.TOUCH_PAN:if(!1===n.enablePan)return;Z(e),n.update();break;case s.TOUCH_DOLLY_PAN:if(!1===n.enableZoom&&!1===n.enablePan)return;n.enableZoom&&G(e),n.enablePan&&Z(e),n.update();break;case s.TOUCH_DOLLY_ROTATE:if(!1===n.enableZoom&&!1===n.enableRotate)return;n.enableZoom&&G(e),n.enableRotate&&X(e),n.update();break;default:l=s.NONE}}(e):function(e){if(!1!==n.enabled)switch(l){case s.ROTATE:if(!1===n.enableRotate)return;w.set(e.clientX,e.clientY),E.subVectors(w,g).multiplyScalar(n.rotateSpeed);let t=n.domElement;t&&(I(2*Math.PI*E.x/t.clientHeight),U(2*Math.PI*E.y/t.clientHeight)),g.copy(w),n.update();break;case s.DOLLY:var i,r;if(!1===n.enableZoom)return;(P.set(e.clientX,e.clientY),_.subVectors(P,L),_.y>0)?(i=C(),N(b/i)):_.y<0&&(r=C(),N(b*r)),L.copy(P),n.update();break;case s.PAN:if(!1===n.enablePan)return;S.set(e.clientX,e.clientY),O.subVectors(S,x).multiplyScalar(n.panSpeed),k(O.x,O.y),x.copy(S),n.update()}}(e))}function $(e){var t,i,r;(function(e){delete z[e.pointerId];for(let t=0;t<M.length;t++)if(M[t].pointerId==e.pointerId)return void M.splice(t,1)})(e),0===M.length&&(null==(t=n.domElement)||t.releasePointerCapture(e.pointerId),null==(i=n.domElement)||i.ownerDocument.removeEventListener("pointermove",Q),null==(r=n.domElement)||r.ownerDocument.removeEventListener("pointerup",$)),n.dispatchEvent(o),l=s.NONE}function J(e){if(!1!==n.enabled&&!1!==n.enableZoom&&(l===s.NONE||l===s.ROTATE)){var t,i;e.preventDefault(),n.dispatchEvent(r),(H(e),e.deltaY<0)?(t=C(),N(b*t)):e.deltaY>0&&(i=C(),N(b/i)),n.update(),n.dispatchEvent(o)}}function ee(e){if(!1!==n.enabled&&!1!==n.enablePan){let t=!1;switch(e.code){case n.keys.UP:k(0,n.keyPanSpeed),t=!0;break;case n.keys.BOTTOM:k(0,-n.keyPanSpeed),t=!0;break;case n.keys.LEFT:k(n.keyPanSpeed,0),t=!0;break;case n.keys.RIGHT:k(-n.keyPanSpeed,0),t=!0}t&&(e.preventDefault(),n.update())}}function et(e){!1!==n.enabled&&e.preventDefault()}function en(e){let t=z[e.pointerId];void 0===t&&(t=new a.I9Y,z[e.pointerId]=t),t.set(e.pageX,e.pageY)}function ei(e){return z[(e.pointerId===M[0].pointerId?M[1]:M[0]).pointerId]}this.dollyIn=(e=C())=>{N(b*e),n.update()},this.dollyOut=(e=C())=>{N(b/e),n.update()},this.getScale=()=>b,this.setScale=e=>{N(e),n.update()},this.getZoomScale=()=>C(),void 0!==t&&this.connect(t),this.update()}}let m=o.forwardRef(({makeDefault:e,camera:t,regress:n,domElement:a,enableDamping:s=!0,keyEvents:l=!1,onChange:c,onStart:u,onEnd:d,...f},p)=>{let m=(0,r.C)(e=>e.invalidate),v=(0,r.C)(e=>e.camera),b=(0,r.C)(e=>e.gl),y=(0,r.C)(e=>e.events),g=(0,r.C)(e=>e.setEvents),w=(0,r.C)(e=>e.set),E=(0,r.C)(e=>e.get),x=(0,r.C)(e=>e.performance),S=t||v,O=a||y.connected||b.domElement,L=o.useMemo(()=>new h(S),[S]);return(0,r.D)(()=>{L.enabled&&L.update()},-1),o.useEffect(()=>(l&&L.connect(!0===l?O:l),L.connect(O),()=>void L.dispose()),[l,O,n,L,m]),o.useEffect(()=>{let e=e=>{m(),n&&x.regress(),c&&c(e)},t=e=>{u&&u(e)},i=e=>{d&&d(e)};return L.addEventListener("change",e),L.addEventListener("start",t),L.addEventListener("end",i),()=>{L.removeEventListener("start",t),L.removeEventListener("end",i),L.removeEventListener("change",e)}},[c,u,d,L,m,g]),o.useEffect(()=>{if(e){let e=E().controls;return w({controls:L}),()=>w({controls:e})}},[e,L]),o.createElement("primitive",(0,i.A)({ref:p,object:L,enableDamping:s},f))})}}]);