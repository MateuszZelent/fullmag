import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  installViewport3DFieldColorBuildWorker,
  transferablesForViewport3DFieldColorBuffer,
  type Viewport3DFieldColorBuildWorkerRequest,
} from "./viewport3dFieldColorBuildWorker";

interface PostedMessage {
  message: unknown;
  transfer?: Transferable[];
}

class FakeWorkerScope {
  private listener:
    | ((event: MessageEvent<Viewport3DFieldColorBuildWorkerRequest>) => void)
    | null = null;
  readonly posted: PostedMessage[] = [];

  addEventListener(
    type: "message",
    listener: (
      event: MessageEvent<Viewport3DFieldColorBuildWorkerRequest>,
    ) => void,
  ): void {
    expect(type).toBe("message");
    this.listener = listener;
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }

  dispatch(data: Viewport3DFieldColorBuildWorkerRequest): void {
    expect(this.listener).not.toBeNull();
    this.listener?.({
      data,
    } as unknown as MessageEvent<Viewport3DFieldColorBuildWorkerRequest>);
  }
}

function fieldVectorFixture(): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [2, 1, 1],
    nComp: 3,
    pointCount: 2,
    quantityId: "m",
    valueCount: 6,
    values: new Float64Array([
      1, 0, 0,
      0, 1, 0,
    ]),
  };
}

function waitForWorkerTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("viewport3dFieldColorBuildWorker", () => {
  it("posts a transferable full-domain color buffer", async () => {
    const scope = new FakeWorkerScope();
    installViewport3DFieldColorBuildWorker(scope);

    scope.dispatch({
      colorMode: "orientation",
      colorPalette: "viridis",
      fieldVector: fieldVectorFixture(),
      id: 7,
      shaderOnly: true,
      target: {
        kind: "full-domain",
        vertexCount: 2,
      },
    });

    await waitForWorkerTurn();

    expect(scope.posted).toHaveLength(1);
    const posted = scope.posted[0];
    expect(posted.message).toEqual(
      expect.objectContaining({
        id: 7,
        ok: true,
      }),
    );
    const response = posted.message as {
      data: { vectorValues?: Float32Array };
    };
    expect(Array.from(response.data.vectorValues ?? [])).toEqual([
      1, 0, 0,
      0, 1, 0,
    ]);
    expect(posted.transfer).toContain(response.data.vectorValues?.buffer);
  });

  it("uses the same transferable list helper for optional color buffer arrays", () => {
    const colors = new Float32Array([1, 0, 0]);
    const scalarValues = new Float32Array([1]);
    const vectorValues = new Float32Array([1, 0, 0]);

    expect(
      transferablesForViewport3DFieldColorBuffer({
        colorMode: "magnitude",
        colorPalette: "viridis",
        colors,
        range: { max: 1, min: 0 },
        scalarValues,
        vectorValues,
      }),
    ).toEqual([colors.buffer, scalarValues.buffer, vectorValues.buffer]);
  });
});
