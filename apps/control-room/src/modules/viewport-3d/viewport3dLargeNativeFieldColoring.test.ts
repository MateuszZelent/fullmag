import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import { buildFdmSampledScalarColors } from "./viewport3dFieldMapping";
import { resolveViewport3DFdmNativeLayerFieldRequests } from "./model/viewport3DFieldDataPlan";

describe("large native FDM field coloring", () => {
  it("maps a full 240x240x4 native m field to finite cell colors", () => {
    const gridShape: [number, number, number] = [240, 240, 4];
    const cellCount = gridShape[0] * gridShape[1] * gridShape[2];
    const layerId = "layer:film";
    const requests = resolveViewport3DFdmNativeLayerFieldRequests({
      available: true,
      layers: [
        {
          layerId,
          settings: {
            activeQuantityId: "m",
            shaderVisible: true,
            vectorsVisible: false,
            visible: true,
          },
        },
      ],
      maxSamples: cellCount,
    });
    const request = requests.get(layerId);
    expect(request?.quantityId).toBe("m");
    expect(request?.query).toMatchObject({
      component: "full",
      max_samples: cellCount,
      scope_id: layerId,
      scope_kind: "layer",
    });
    if (!request) throw new Error("native layer field request was not resolved");

    const nativeCellIndices = new Uint32Array(cellCount);
    const values = new Float64Array(cellCount * 3);
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      nativeCellIndices[cellIndex] = cellIndex;
      // Deterministic positive-X magnetization with enough scalar variation to
      // exercise the same range and percentile work as a nonuniform sample.
      values[cellIndex * 3] =
        0.5 + (((cellIndex * 7_919) % cellCount) / cellCount);
    }

    const decodedField: DecodedFieldVector = {
      dtype: "float64",
      formatVersion: 3,
      grid: gridShape,
      indexing: "explicit_node_indices",
      nodeIndices: nativeCellIndices,
      nComp: 3,
      pointCount: cellCount,
      quantityId: request.quantityId,
      scopeId: request.query.scope_id,
      scopeKind: "layer",
      valueCount: values.length,
      values,
    };
    const nativeLayerFields = new Map([[request.requestId, decodedField]]);
    const nativeLayerField = nativeLayerFields.get(request.requestId) ?? null;

    let invalidFieldValueCount = 0;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index] ?? Number.NaN;
      if (!Number.isFinite(value) || (index % 3 === 0 && value <= 0)) {
        invalidFieldValueCount += 1;
      }
    }
    expect(invalidFieldValueCount).toBe(0);
    expect(nativeLayerField?.pointCount).toBe(230_400);
    expect(nativeLayerField?.nodeIndices).toHaveLength(230_400);
    expect(nativeLayerField?.nodeIndices?.at(-1)).toBe(230_399);

    const startedAt = performance.now();
    const colors = buildFdmSampledScalarColors(
      nativeLayerField,
      nativeCellIndices,
      cellCount,
      "magnitude",
      "viridis",
      undefined,
      gridShape,
    );
    const elapsedMs = performance.now() - startedAt;

    expect(colors).not.toBeNull();
    if (!colors) throw new Error("native FDM field did not produce cell colors");
    expect(colors.colors).toHaveLength(230_400 * 3);
    expect(colors.scalarValues).toHaveLength(230_400);
    expect(colors.rangeDiagnostics?.finiteCount).toBe(230_400);

    let nonFiniteColorCount = 0;
    let blackCellCount = 0;
    for (const channel of colors.colors) {
      if (!Number.isFinite(channel)) nonFiniteColorCount += 1;
    }
    expect(nonFiniteColorCount).toBe(0);
    for (let cell = 0; cell < cellCount; cell += 1) {
      const offset = cell * 3;
      if (colors.colors[offset] === 0 && colors.colors[offset + 1] === 0 && colors.colors[offset + 2] === 0) {
        blackCellCount += 1;
      }
    }
    expect(blackCellCount).toBe(0);

    console.info(
      `large-native-field-coloring: ${cellCount} native cells, ${elapsedMs.toFixed(2)} ms, ${colors.colors.length} finite RGB channels`,
    );
  });
});
