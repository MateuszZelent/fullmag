import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";
import type { CommandContext, CommandResult } from "@/kernel/commands/commandTypes";
import { findElement, installSimulationPreparationTestDom, TestEvent } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";

const mocks = vi.hoisted(() => ({
  identity: { sessionId: "A", sessionEpoch: "4", requestScopeEpoch: "4" },
  execute: vi.fn(),
}));
vi.mock("@/kernel/KernelContext", () => ({ useKernel: () => ({
  api: {}, resources: {}, selection: {}, authoringHistory: {},
  commands: { execute: mocks.execute, getSessionScopeKey: () => sessionRequestScopeKey(mocks.identity) },
}) }));
vi.mock("@/kernel/resources/useSessionStatus", () => ({ useSessionResourceIdentity: () => mocks.identity }));

import { AntennaStudyStageComposer } from "./AntennaStudyStageComposer";

function fixture(): SceneResource {
  return {
    scene: { id: "A", name: "fixture", authoring_schema: "fixture", source_of_truth: "fixture" }, revision: 7,
    antenna_field_solve_stages: [{
      id: "solve", source_object_id: "source", current_transport_id: "current",
      port_mode_ids: ["port-2"], model: "quasistatic_conduction_biot_savart3d",
      oersted_realization: "direct_tetra_quadrature", conductor_mesh_policy: "quadrature",
      field_sampling_domain: { kind: "global" }, target_refs: [{ kind: "global" }],
      solver_policy: "direct", outputs: [{ id: "H_ant", quantity: "H" }],
    }],
    antenna_port_modes: ["port-1", "port-2"].map((id) => ({ id,
      source_object_id: "source", current_transport_id: "current",
      schema_version: "antenna_port_mode.v2", branches: [],
    })),
  };
}

describe("antenna Study composer scoped command and stable controls", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.identity = { sessionId: "A", sessionEpoch: "4", requestScopeEpoch: "4" }; });

  it("keeps the port control during pending/ACK and submits only the chosen port", async () => {
    let finish!: (value: CommandResult) => void;
    mocks.execute.mockReturnValue(new Promise<CommandResult>((resolve) => { finish = resolve; }));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      const scene = fixture();
      await act(async () => root.render(<AntennaStudyStageComposer objectId="source" stageId="solve" scene={scene} status="ready" />));
      const pick = findElement(container, (element) => element.tagName === "SELECT", "port selector");
      const button = findElement(container, (element) => element.tagName === "BUTTON" && element.textContent === "Add Field Solve to Study", "enqueue button");
      expect(button.disabled).toBe(false);
      pick.value = "port-2";
      await act(async () => { pick.dispatchEvent(new TestEvent("change", { bubbles: true })); });
      await act(async () => { button.dispatchEvent(new TestEvent("click", { bubbles: true })); });
      expect(mocks.execute).toHaveBeenCalledWith("study.add-antenna-field-solve-stage", expect.objectContaining({
        source: "inspector", sessionScopeKey: sessionRequestScopeKey(mocks.identity),
        input: { objectId: "source", stageId: "solve", portModeId: "port-2" },
      }));
      expect(pick.disabled).toBe(false);
      expect(button.disabled).toBe(true);
      await act(async () => { root.render(<AntennaStudyStageComposer objectId="source" stageId="solve" scene={{ ...scene, revision: 8 }} status="ready" />); });
      expect(findElement(container, (element) => element.tagName === "SELECT", "port selector")).toBe(pick);
      expect(pick.value).toBe("port-2");
      await act(async () => { finish({ status: "completed", message: "Reference added" }); });
      expect(pick.disabled).toBe(false);
      expect(button.disabled).toBe(false);
      expect(container.textContent).toContain("Reference added");
      const unsupported = structuredClone(scene);
      unsupported.antenna_field_solve_stages![0].port_mode_ids = ["port-1", "port-2"];
      await act(async () => root.render(<AntennaStudyStageComposer objectId="source" stageId="solve" scene={unsupported} status="ready" />));
      expect(findElement(container, (element) => element.tagName === "SELECT", "port selector")).toBe(pick);
      expect(container.textContent).toContain("exactly one port mode");
      expect(container.textContent).not.toContain("Reference added");
      expect(button.disabled).toBe(true);
    } finally { await act(async () => root.unmount()); dom.restore(); }
  });

  it("ignores an old-session ACK and resets the selection for the new session", async () => {
    let finish!: (value: CommandResult) => void;
    mocks.execute.mockReturnValue(new Promise<CommandResult>((resolve) => { finish = resolve; }));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      const scene = fixture();
      scene.antenna_field_solve_stages![0].port_mode_ids = ["port-1"];
      await act(async () => root.render(<AntennaStudyStageComposer objectId="source" stageId="solve" scene={scene} status="ready" />));
      const button = findElement(container, (element) => element.tagName === "BUTTON" && element.textContent === "Add Field Solve to Study", "enqueue button");
      await act(async () => { button.dispatchEvent(new TestEvent("click", { bubbles: true })); });
      const context = mocks.execute.mock.calls[0][1] as CommandContext;
      mocks.identity = { sessionId: "B", sessionEpoch: "5", requestScopeEpoch: "5" };
      await act(async () => root.render(<AntennaStudyStageComposer objectId="source" stageId="solve" scene={fixture()} status="ready" />));
      expect(context.isCurrentSessionScope!()).toBe(false);
      await act(async () => { finish({ status: "completed", message: "Old session ACK" }); });
      expect(container.textContent).not.toContain("Old session ACK");
      const pick = findElement(container, (element) => element.tagName === "SELECT", "port selector");
      expect(pick.value).toBe("port-2");
      expect(pick.disabled).toBe(true);
    } finally { await act(async () => root.unmount()); dom.restore(); }
  });

  it("shows the capability refusal and cannot enqueue a multiport definition", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      const scene = fixture();
      scene.antenna_field_solve_stages![0].port_mode_ids = ["port-1", "port-2"];
      const before = structuredClone(scene);
      await act(async () => root.render(<AntennaStudyStageComposer objectId="source" stageId="solve" scene={scene} status="ready" />));
      const pick = findElement(container, (element) => element.tagName === "SELECT", "port selector");
      const button = findElement(container, (element) => element.tagName === "BUTTON" && element.textContent === "Add Field Solve to Study", "enqueue button");
      expect(container.textContent).toContain("exactly one port mode");
      expect(pick.disabled).toBe(true);
      expect(button.disabled).toBe(true);
      await act(async () => { button.dispatchEvent(new TestEvent("click", { bubbles: true })); });
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(scene).toEqual(before);
    } finally { await act(async () => root.unmount()); dom.restore(); }
  });
});
