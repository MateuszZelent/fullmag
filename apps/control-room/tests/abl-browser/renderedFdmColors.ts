/** Read the FDM surface attributes bound to an actual WebGL2 instanced draw.
 * The 32 × 8 × 2 fixture has exactly 512 cuboids, with sixteen at each x.
 * Camera rotation, lighting, antialiasing and overlay pixels do not change
 * the linear RGB supplied to the shader for a given cell.
 */
interface FdmColorDraw {
  sequence: number;
  row: number[][];
  spread: number;
}

declare global {
  interface Window {
    ablColorProbe: { armed: boolean; sequence: number; draw: FdmColorDraw | null };
  }
}

export function installFdmColorProbe(): void {
  const probe = window.ablColorProbe = { armed: true, sequence: 0, draw: null as FdmColorDraw | null };
  const prototype = WebGL2RenderingContext.prototype;
  const draw = prototype.drawElementsInstanced;
  prototype.drawElementsInstanced = function (mode, count, type, offset, instances) {
    draw.call(this, mode, count, type, offset, instances);
    if (!probe.armed || instances !== 512 || mode !== this.TRIANGLES ||
        !(this.canvas instanceof HTMLCanvasElement) || !this.canvas.closest(".fm-viewport-3d")) return;
    const program = this.getParameter(this.CURRENT_PROGRAM);
    if (!program) return;
    const color = this.getAttribLocation(program, "instanceColor");
    const matrix = this.getAttribLocation(program, "instanceMatrix");
    if (color < 0 || matrix < 0) return;
    const readAttribute = (location: number, size: number) => {
      if (this.getVertexAttrib(location, this.VERTEX_ATTRIB_ARRAY_DIVISOR) !== 1 ||
          this.getVertexAttrib(location, this.VERTEX_ATTRIB_ARRAY_TYPE) !== this.FLOAT ||
          this.getVertexAttrib(location, this.VERTEX_ATTRIB_ARRAY_SIZE) !== size ||
          !this.getVertexAttrib(location, this.VERTEX_ATTRIB_ARRAY_ENABLED)) return null;
      const stride = this.getVertexAttrib(location, this.VERTEX_ATTRIB_ARRAY_STRIDE) || size * 4;
      const start = this.getVertexAttribOffset(location, this.VERTEX_ATTRIB_ARRAY_POINTER);
      const buffer = this.getVertexAttrib(location, this.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING);
      this.bindBuffer(this.COPY_READ_BUFFER, buffer);
      const span = (instances - 1) * stride + size * 4;
      if (this.getBufferParameter(this.COPY_READ_BUFFER, this.BUFFER_SIZE) < start + span) return null;
      const values = new Float32Array(span / 4);
      this.getBufferSubData(this.COPY_READ_BUFFER, start, values);
      return { stride: stride / 4, values };
    };
    const previous = this.getParameter(this.COPY_READ_BUFFER_BINDING);
    try {
      const rgb = readAttribute(color, 3);
      // The fourth column of the mat4 holds each cuboid's world translation.
      const xyz = readAttribute(matrix + 3, 4);
      if (!rgb || !xyz) return;
      const bins = new Map<number, { count: number; rgb: number[] }>();
      let spread = 0;
      for (let i = 0; i < instances; i++) {
        const x = xyz.values[i * xyz.stride];
        const at = i * rgb.stride;
        const bin = bins.get(x);
        if (!bin) bins.set(x, { count: 1, rgb: Array.from(rgb.values.subarray(at, at + 3)) });
        else {
          bin.count++;
          for (let k = 0; k < 3; k++) spread = Math.max(spread, Math.abs(rgb.values[at + k] - bin.rgb[k]));
        }
      }
      if (bins.size !== 32 || [...bins.values()].some(bin => bin.count !== 16)) return;
      probe.draw = { sequence: ++probe.sequence, spread,
        row: [...bins].sort(([a], [b]) => a - b).map(([, bin]) => bin.rgb) };
    } finally {
      this.bindBuffer(this.COPY_READ_BUFFER, previous);
    }
  };
}
