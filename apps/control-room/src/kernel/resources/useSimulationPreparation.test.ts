import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SIMULATION_PREPARATION_PATH } from "../api/apiPaths";
import type { SimulationPreparationResource } from "../api/apiTypes";

import { ResourceRuntimeStore } from "./ResourceRuntimeStore";
import {
  resolveSimulationPreparationResult,
  useSimulationPreparation,
} from "./useSimulationPreparation";

function preparationFixture(revision: number): SimulationPreparationResource {
  return {
    active_stage_id: "planning",
    completed_at_unix_ms: null,
    failure: null,
    log_tail: [],
    preparation_id: "prep-1",
    requested_execution: {
      backend: "fdm",
      device: "gpu",
      engine_id: null,
      mode: "strict",
      precision: "double",
      runtime_family: null,
      worker: null,
    },
    resolved_execution: null,
    revision,
    stages: [],
    started_at_unix_ms: 1_000,
    status: "running",
  };
}

function deferred<TData>(): {
  promise: Promise<TData>;
  resolve: (value: TData) => void;
} {
  let resolve!: (value: TData) => void;
  const promise = new Promise<TData>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("useSimulationPreparation", () => {
  it("uses the canonical preparation resource layer", () => {
    const source = readFileSync(
      new URL("./useSimulationPreparation.ts", import.meta.url),
      "utf8",
    );

    expect(typeof useSimulationPreparation).toBe("function");
    expect(source).toContain("useResource<SimulationPreparationResource>");
    expect(source).toContain("resourceKey: SIMULATION_PREPARATION_PATH");
    expect(source).toContain("resolveRevision: (data) => data.revision");
  });

  it("keeps revision 7 visible while invalidated revision 8 loads", async () => {
    const store = new ResourceRuntimeStore<SimulationPreparationResource>();
    const revision8 = deferred<SimulationPreparationResource>();

    await store.ensureLoad({
      externalRevision: 7,
      load: async () => preparationFixture(7),
      resolveRevision: (data) => data.revision,
      resourceKey: SIMULATION_PREPARATION_PATH,
    });

    const pending = store.ensureLoad({
      externalRevision: 8,
      load: () => revision8.promise,
      resolveRevision: (data) => data.revision,
      resourceKey: SIMULATION_PREPARATION_PATH,
    });

    expect(
      resolveSimulationPreparationResult({
        ...store.getSnapshot(SIMULATION_PREPARATION_PATH),
        refetch: () => undefined,
      }),
    ).toMatchObject({
      data: { revision: 7 },
      revision: 8,
      status: "loading",
    });

    revision8.resolve(preparationFixture(8));
    await pending;

    expect(store.getSnapshot(SIMULATION_PREPARATION_PATH)).toMatchObject({
      data: { revision: 8 },
      revision: 8,
      status: "ready",
    });
  });
});
