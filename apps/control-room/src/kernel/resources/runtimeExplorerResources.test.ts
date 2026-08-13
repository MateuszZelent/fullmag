import { describe, expect, it } from "vitest";

import { ControlRoomApiError } from "../api/ControlRoomApi";
import type { CommandDetailResource } from "../api/apiTypes";
import * as runtimeResources from "./runtimeExplorerResources";

describe("runtime Explorer command detail resources", () => {
  it("preserves each command detail revision, missing state, and error independently", async () => {
    const loadRuntimeCommandDetailEntries = (
      runtimeResources as typeof runtimeResources & {
        loadRuntimeCommandDetailEntries?: (
          commandIds: readonly string[],
          load: (commandId: string) => Promise<CommandDetailResource>,
        ) => Promise<unknown[]>;
      }
    ).loadRuntimeCommandDetailEntries;

    expect(loadRuntimeCommandDetailEntries).toBeTypeOf("function");
    if (!loadRuntimeCommandDetailEntries) return;

    const entries = await loadRuntimeCommandDetailEntries(
      ["ready", "missing", "failed"],
      async (commandId) => {
        if (commandId === "missing") {
          throw new ControlRoomApiError("not found", 404);
        }
        if (commandId === "failed") {
          throw new ControlRoomApiError("request failed", 503);
        }
        return {
          command_id: commandId,
          created_at_unix_ms: 1,
          kind: "run",
          seq: 7,
          status: "running",
        };
      },
    );

    expect(entries).toEqual([
      expect.objectContaining({ commandId: "ready", missing: false, revision: 7, status: "ready" }),
      expect.objectContaining({ commandId: "missing", missing: true, revision: null, status: "unavailable" }),
      expect.objectContaining({ commandId: "failed", error: "request failed", missing: false, revision: null, status: "error" }),
    ]);
  });
});
