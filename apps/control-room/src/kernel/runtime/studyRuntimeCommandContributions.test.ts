import { describe, expect, it, vi } from "vitest";

import {
  DATA_FIELDS_PATH,
  DATA_FIELD_VECTOR_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_OBJECT_METRICS_PATH,
  SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
} from "../api/apiPaths";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";

import { STUDY_RUNTIME_COMMANDS } from "./studyRuntimeCommandContributions";

function registryWithStudyRuntimeCommands(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.attach(new EventBus<KernelEventMap>());
  for (const command of STUDY_RUNTIME_COMMANDS) {
    registry.register(command);
  }
  return registry;
}

describe("study runtime command contributions", () => {
  it("submits compute fields without a run command and invalidates field resources", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-fields",
      error: null,
    }));
    const fieldVectorKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=full`;
    const fieldVectorListener = vi.fn();
    resources.subscribe(fieldVectorKey, fieldVectorListener);

    const result = await registry.execute("study.compute-fields", {
      api: {
        commands: { submit },
      } as never,
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Compute fields command accepted.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith({ kind: "compute_fields" });
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe("cmd-fields");
    expect(resources.getRevision(SESSION_STATUS_RESOURCE_KEY)).toBe("cmd-fields");
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBe("cmd-fields");
    expect(fieldVectorListener).toHaveBeenCalledWith("cmd-fields");
  });

  it("submits compute energies without a run command and invalidates energy/object metrics resources", async () => {
    const registry = registryWithStudyRuntimeCommands();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const submit = vi.fn(async () => ({
      accepted: true,
      command_id: "cmd-energies",
      error: null,
    }));
    const objectMetricsKey = SIMULATION_OBJECT_METRICS_PATH.replace(
      "{object_id}",
      "arch_Waveguide",
    );
    const objectMetricsListener = vi.fn();
    resources.subscribe(objectMetricsKey, objectMetricsListener);

    const result = await registry.execute("study.compute-energies", {
      api: {
        commands: { submit },
      } as never,
      resources,
      source: "test",
    });

    expect(result).toEqual({
      message: "Compute energies command accepted.",
      status: "completed",
    });
    expect(submit).toHaveBeenCalledWith({ kind: "compute_energies" });
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe("cmd-energies");
    expect(resources.getRevision(SESSION_STATUS_RESOURCE_KEY)).toBe("cmd-energies");
    expect(resources.getRevision(SIMULATION_SOLVER_ENERGIES_CURRENT_PATH)).toBe(
      "cmd-energies",
    );
    expect(objectMetricsListener).toHaveBeenCalledWith("cmd-energies");
  });

  it("reports a clear disabled reason when the API facade is unavailable", () => {
    const registry = registryWithStudyRuntimeCommands();
    const context = { source: "test" as const };

    expect(registry.isEnabled("study.compute-fields", context)).toBe(false);
    expect(registry.get("study.compute-fields")?.disabledReason?.(context)).toBe(
      "Control-room API is unavailable.",
    );
  });
});
