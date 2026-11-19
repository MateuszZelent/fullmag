/** Inspect the actual vertex attributes of the strip's WebGL surface draw. */
export interface FemDraw {
  sequence: number;
  mode: "scalar" | "rgb";
  samples: { x: number; y: number; distance: number; value: number[] }[];
}

declare global {
  interface Window {
    ablFemProbe: { armed: boolean; sequence: number; draws: FemDraw[] };
  }
}

export function installFemAlphaProbe(): void {
  const probe = window.ablFemProbe = { armed: true, sequence: 0, draws: [] as FemDraw[] };
  const prototype = WebGL2RenderingContext.prototype;
  function inspect(gl: WebGL2RenderingContext, mode: number, indices: ArrayLike<number>) {
    if (mode !== gl.TRIANGLES || !probe.armed || indices.length < 36 ||
        !(gl.canvas instanceof HTMLCanvasElement) || !gl.canvas.closest(".fm-viewport-3d")) return;
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    if (!program) return;
    const ids = Array.from(new Set(Array.from(indices)));
    const last = ids.reduce((max, id) => Math.max(max, id), 0);
    if (last >= 200_000) return;
    function attribute(name: string, channels: number) {
      const location = gl.getAttribLocation(program, name);
      if (location < 0 || !gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_ENABLED) ||
          gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_TYPE) !== gl.FLOAT) return;
      const size = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_SIZE);
      if (size < channels) return;
      const stride = (gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_STRIDE) || size * 4) / 4;
      const offset = gl.getVertexAttribOffset(location, gl.VERTEX_ATTRIB_ARRAY_POINTER);
      const data = new Float32Array(last * stride + size);
      gl.bindBuffer(gl.COPY_READ_BUFFER, gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING));
      if (offset + data.byteLength > gl.getBufferParameter(gl.COPY_READ_BUFFER, gl.BUFFER_SIZE)) return;
      gl.getBufferSubData(gl.COPY_READ_BUFFER, offset, data);
      return (id: number, channel: number) => data[id * stride + channel];
    }
    const xyz = attribute("position", 3);
    const scalar = attribute("fmScalarValue", 1);
    const value = scalar || attribute("color", 3);
    if (!xyz || !value) return;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const id of ids) {
      xmin = Math.min(xmin, xyz(id, 0)); xmax = Math.max(xmax, xyz(id, 0));
      ymin = Math.min(ymin, xyz(id, 1)); ymax = Math.max(ymax, xyz(id, 1));
    }
    const aspect = (xmax - xmin) / (ymax - ymin);
    if (!(aspect > 1.99 && aspect < 2.01)) return;
    // Each coordinate lies inside a distinct part of the example. Sample the
    // actual nearest drawn vertex, then evaluate the oracle at that position.
    const anchors = [[-99, 10], [-88, 10], [74, 10], [99, 10], [8, 32], [8, 26], [8, -32], [0, 8]];
    const samples = anchors.map(() => ({ x: 0, y: 0, distance: Infinity, value: [] as number[] }));
    for (const id of ids) {
      const x = 200 * (xyz(id, 0) - xmin) / (xmax - xmin) - 100;
      const y = 100 * (xyz(id, 1) - ymin) / (ymax - ymin) - 50;
      anchors.forEach(([ax, ay], i) => {
        const distance = Math.hypot(x - ax, y - ay);
        if (distance < samples[i].distance) samples[i] = { x, y, distance,
          value: scalar ? [value(id, 0)] : [value(id, 0), value(id, 1), value(id, 2)] };
      });
    }
    if (samples.some(p => p.distance > 4)) return;
    probe.draws.push({ sequence: ++probe.sequence, mode: scalar ? "scalar" : "rgb", samples });
    if (probe.draws.length > 12) probe.draws.shift();
  }
  const indexed = prototype.drawElements;
  prototype.drawElements = function(mode, count, type, offset) {
    indexed.call(this, mode, count, type, offset);
    if (!probe.armed || mode !== this.TRIANGLES || count < 36 || count > 200_000) return;
    const buffer = this.getParameter(this.ELEMENT_ARRAY_BUFFER_BINDING);
    if (!buffer) return;
    const previous = this.getParameter(this.COPY_READ_BUFFER_BINDING);
    try {
      const Index = type === this.UNSIGNED_INT ? Uint32Array : type === this.UNSIGNED_SHORT ? Uint16Array : Uint8Array;
      const indices = new Index(count);
      this.bindBuffer(this.COPY_READ_BUFFER, buffer);
      if (offset + indices.byteLength > this.getBufferParameter(this.COPY_READ_BUFFER, this.BUFFER_SIZE)) return;
      this.getBufferSubData(this.COPY_READ_BUFFER, offset, indices);
      inspect(this, mode, indices);
    } finally { this.bindBuffer(this.COPY_READ_BUFFER, previous); }
  };
  const arrays = prototype.drawArrays;
  prototype.drawArrays = function(mode, first, count) {
    arrays.call(this, mode, first, count);
    if (!probe.armed || mode !== this.TRIANGLES || count < 36 || count > 200_000) return;
    const previous = this.getParameter(this.COPY_READ_BUFFER_BINDING);
    try { inspect(this, mode, Array.from({ length: count }, (_, i) => first + i)); }
    finally { this.bindBuffer(this.COPY_READ_BUFFER, previous); }
  };
}
