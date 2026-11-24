import { describe, expect, it } from "vitest";

import type { SceneResource, StageExecutionResource } from "@/kernel/api/apiTypes";
import {
  hasSessionAcDcAntennaModule,
  hasSessionEigensolveModule,
  isAcDcOnlyQuantityId,
  isConductorOnlyQuantityId,
  resolveSessionPhysicsModules,
} from "./sessionPhysicsModules";

describe("sessionPhysicsModules", () => {
  it("keeps AC/DC and Eigensolve inactive for a standard ferromagnetic scene", () => {
    const scene = {
      objects: [
        { id: "bottom", name: "BottomLayer", role: "magnet" },
        { id: "top", name: "TopLayer", role: "magnet" },
      ],
      study: {
        stages: [{ id: "relax-1", kind: "relax" }],
      },
    } as unknown as SceneResource;

    expect(resolveSessionPhysicsModules({ scene })).toEqual({
      acDcActive: false,
      eigensolveActive: false,
    });
  });

  it("activates AC/DC when an antenna or conductor object, stage, or execution is present", () => {
    expect(
      hasSessionAcDcAntennaModule({
        scene: {
          objects: [{ id: "ant-1", name: "Microstrip", role: "antenna" }],
        } as unknown as SceneResource,
      }),
    ).toBe(true);

    expect(
      hasSessionAcDcAntennaModule({
        scene: {
          objects: [{ id: "film", role: "magnet" }],
          antenna_field_solve_stages: [{ id: "solve-1", source_object_id: "ant" }],
        } as unknown as SceneResource,
      }),
    ).toBe(true);

    expect(
      hasSessionAcDcAntennaModule({
        stageExecution: {
          stages: [{ index: 0, stage_id: "s0", antenna_solve_stage_id: "ant-solve", status: "running" }],
        } as unknown as StageExecutionResource,
      }),
    ).toBe(true);
  });

  it("activates Eigensolve when an eigenmodes or frequency-response stage is authored or running", () => {
    expect(
      hasSessionEigensolveModule({
        scene: {
          objects: [{ id: "film", role: "magnet" }],
          study: {
            stages: [
              { id: "relax-1", kind: "relax" },
              { id: "eigen-1", kind: "eigenmodes" },
            ],
          },
        } as unknown as SceneResource,
      }),
    ).toBe(true);

    expect(
      hasSessionEigensolveModule({
        stageExecution: {
          active_stage_kind: "flat_eigenmodes",
          stages: [],
        } as unknown as StageExecutionResource,
      }),
    ).toBe(true);
  });

  it("distinguishes AC/DC and conductor quantities from standard ferromagnetic quantities", () => {
    expect(isConductorOnlyQuantityId("V_electric")).toBe(true);
    expect(isConductorOnlyQuantityId("J_charge")).toBe(true);
    expect(isAcDcOnlyQuantityId("H_ant")).toBe(true);
    expect(isAcDcOnlyQuantityId("H_oe")).toBe(true);
    expect(isAcDcOnlyQuantityId("m")).toBe(false);
    expect(isAcDcOnlyQuantityId("H_demag")).toBe(false);
    expect(isAcDcOnlyQuantityId("H_eff")).toBe(false);
  });
});
