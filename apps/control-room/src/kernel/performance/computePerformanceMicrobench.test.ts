import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "../api/codecs";
import { decodeMeshQualityData } from "../api/codecs/meshQualityDataCodec";
import { decodeTopology } from "../api/codecs/topologyCodec";
import { buildVertexScalarColorsChunked } from "@/modules/viewport-3d/viewport3dFieldMapping";

const COMPUTE_MICROBENCH_BUDGET_MS = 2_500;

function writeMagic(view: DataView, magic: string): void {
  for (const [index, code] of [...magic].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
}

function makeLargeTopologyBuffer(
  nodeCount = 12_000,
  elementCount = 24_000,
  boundaryFaceCount = 12_000,
): ArrayBuffer {
  const byteLength =
    32 +
    nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    elementCount * Uint32Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * Uint32Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  writeMagic(view, "FMMT");
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, elementCount, true);
  view.setUint32(24, boundaryFaceCount, true);

  let offset = 32;
  const positions = new Float64Array(buffer, offset, nodeCount * 3);
  for (let node = 0; node < nodeCount; node += 1) {
    const base = node * 3;
    positions[base] = node % 257;
    positions[base + 1] = Math.floor(node / 257);
    positions[base + 2] = (node % 31) / 31;
  }
  offset += positions.byteLength;

  const indices = new Uint32Array(buffer, offset, elementCount * 4);
  for (let element = 0; element < elementCount; element += 1) {
    const node = element % (nodeCount - 3);
    const base = element * 4;
    indices[base] = node;
    indices[base + 1] = node + 1;
    indices[base + 2] = node + 2;
    indices[base + 3] = node + 3;
  }
  offset += indices.byteLength;

  const boundaryFaces = new Uint32Array(buffer, offset, boundaryFaceCount * 3);
  for (let face = 0; face < boundaryFaceCount; face += 1) {
    const node = face % (nodeCount - 2);
    const base = face * 3;
    boundaryFaces[base] = node;
    boundaryFaces[base + 1] = node + 1;
    boundaryFaces[base + 2] = node + 2;
  }
  offset += boundaryFaces.byteLength;

  const elementMarkers = new Uint32Array(buffer, offset, elementCount);
  elementMarkers.fill(1);
  offset += elementMarkers.byteLength;

  const boundaryMarkers = new Uint32Array(buffer, offset, boundaryFaceCount);
  boundaryMarkers.fill(2);
  return buffer;
}

function makeLargeQualityBuffer(elementCount = 80_000): ArrayBuffer {
  const flags = 0b111;
  const metricCount = 3;
  const buffer = new ArrayBuffer(
    32 + elementCount * metricCount * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  writeMagic(view, "FMMQ");
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, elementCount, true);
  view.setUint32(12, flags, true);

  let offset = 32;
  for (let metric = 0; metric < metricCount; metric += 1) {
    const values = new Float64Array(buffer, offset, elementCount);
    for (let index = 0; index < elementCount; index += 1) {
      values[index] = (index % 1024) / (metric + 1);
    }
    offset += values.byteLength;
  }
  return buffer;
}

function makeLargeVectorField(pointCount = 60_000): DecodedFieldVector {
  const values = new Float64Array(pointCount * 3);
  for (let point = 0; point < pointCount; point += 1) {
    const base = point * 3;
    values[base] = point % 101;
    values[base + 1] = point % 53;
    values[base + 2] = point % 17;
  }
  return {
    dtype: "float64",
    grid: [pointCount, 1, 1],
    nComp: 3,
    pointCount,
    quantityId: "m",
    valueCount: values.length,
    values,
  };
}

function measureSync<T>(run: () => T): { durationMs: number; result: T } {
  const startedAt = performance.now();
  const result = run();
  return { durationMs: performance.now() - startedAt, result };
}

async function measureAsync<T>(run: () => Promise<T>): Promise<{ durationMs: number; result: T }> {
  const startedAt = performance.now();
  const result = await run();
  return { durationMs: performance.now() - startedAt, result };
}

function assertUnderBudget(label: string, durationMs: number): void {
  expect(durationMs, `${label} took ${durationMs.toFixed(1)}ms`).toBeLessThan(
    COMPUTE_MICROBENCH_BUDGET_MS,
  );
}

describe("compute performance microbench", () => {
  it("decodes large topology payloads within the frontend budget", () => {
    const { durationMs, result } = measureSync(() =>
      decodeTopology(makeLargeTopologyBuffer()),
    );

    expect(result.nodeCount).toBe(12_000);
    expect(result.elementCount).toBe(24_000);
    assertUnderBudget("decodeTopology", durationMs);
  });

  it("decodes large mesh-quality payloads within the frontend budget", () => {
    const { durationMs, result } = measureSync(() =>
      decodeMeshQualityData(makeLargeQualityBuffer()),
    );

    expect(result.elementCount).toBe(80_000);
    expect(result.gamma).toHaveLength(80_000);
    assertUnderBudget("decodeMeshQualityData", durationMs);
  });

  it("maps large field vectors through the chunked color path within budget", async () => {
    const yieldToMain = async () => undefined;
    const { durationMs, result } = await measureAsync(() =>
      buildVertexScalarColorsChunked(makeLargeVectorField(), {
        chunkSize: 7_500,
        colorMode: "magnitude",
        yieldToMain,
      }),
    );

    expect(result.colors).toHaveLength(60_000 * 3);
    assertUnderBudget("buildVertexScalarColorsChunked", durationMs);
  });
});
