import { describe, expect, it } from "vitest";

import {
  installViewport3DRegionOverlayBuildWorker,
  type Viewport3DRegionOverlayBuildWorkerRequest,
} from "./viewport3dRegionOverlayBuildWorker";

interface PostedMessage {
  message: unknown;
  transfer?: Transferable[];
}

class FakeWorkerScope {
  private listener:
    | ((event: MessageEvent<Viewport3DRegionOverlayBuildWorkerRequest>) => void)
    | null = null;
  readonly posted: PostedMessage[] = [];

  addEventListener(
    type: "message",
    listener: (
      event: MessageEvent<Viewport3DRegionOverlayBuildWorkerRequest>,
    ) => void,
  ): void {
    expect(type).toBe("message");
    this.listener = listener;
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }

  dispatch(data: Viewport3DRegionOverlayBuildWorkerRequest): void {
    expect(this.listener).not.toBeNull();
    this.listener?.({
      data,
    } as unknown as MessageEvent<Viewport3DRegionOverlayBuildWorkerRequest>);
  }
}

describe("viewport3dRegionOverlayBuildWorker", () => {
  it("posts mesh-backed overlay models with transferable geometry buffers", async () => {
    const scope = new FakeWorkerScope();
    installViewport3DRegionOverlayBuildWorker(scope);

    scope.dispatch({
      id: 17,
      magneticParts: [
        {
          element_count: 1,
          element_start: 0,
          id: "part:film:core",
          object_id: "film",
          surface_faces: [[0, 1, 2]],
        },
      ],
      regions: [
        {
          enabled: true,
          mesh_part_ids: ["part:film:core"],
          owner_object_id: "film",
          region_id: "film:core",
        },
      ],
      topology: {
        boundaryFaceCount: 0,
        boundaryFaces: new Uint32Array(),
        boundaryMarkers: new Uint32Array(),
        elementCount: 1,
        elementMarkers: Uint32Array.from([1]),
        indices: Uint32Array.from([0, 1, 2, 3]),
        nodeCount: 4,
        positions: Float64Array.from([
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
          0, 0, 1,
        ]),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scope.posted).toHaveLength(1);
    const posted = scope.posted[0];
    expect(posted.message).toEqual(
      expect.objectContaining({
        id: 17,
        ok: true,
      }),
    );
    const response = posted.message as {
      data: { models: Array<{ positions: Float32Array; surfaceIndices: Uint32Array | null }> };
    };
    expect(response.data.models).toHaveLength(1);
    expect(posted.transfer).toContain(response.data.models[0].positions.buffer);
    expect(posted.transfer).toContain(
      response.data.models[0].surfaceIndices?.buffer,
    );
  });
});
