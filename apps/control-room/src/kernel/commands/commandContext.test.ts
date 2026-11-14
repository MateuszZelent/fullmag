import { describe, expect, it } from "vitest";

import { CommandRegistry } from "./CommandRegistry";
import { createCommandContext } from "./commandContext";

describe("createCommandContext session ownership", () => {
  it("uses the existing kernel owner of unresolved Study submissions", () => {
    const commandFeedback = { hasUnresolvedStudyCompute: () => true, getRetryableStudyCompute: () => null };
    const context = createCommandContext("inspector", { commandFeedback } as never);

    expect(context.commandFeedback).toBe(commandFeedback);
  });

  it.each(["ready", "stale", "error"] as const)("forwards the Inspector command queue status %s", (status) => {
    const resources = { commands: { revision: 9 } };
    const context = createCommandContext("inspector", {} as never, {
      commandQueueResourceStatus: status,
      resourceData: resources,
    });

    expect(context.commandQueueResourceStatus).toBe(status);
    expect(context.resourceData).toBe(resources);
  });

  it("captures ownership when the UI context is created rather than rebinding old inputs", () => {
    const commands = new CommandRegistry();
    let scope = "session=a&epoch=1";
    commands.attachSessionScopeSource({
      getScopeKey: () => scope,
      subscribe: () => () => {},
    });
    const objectEditSession = {};
    const kernel = { commands, objectEditSession } as never;
    const context = createCommandContext("ribbon", kernel);
    expect(context.objectEditSession).toBe(objectEditSession);
    expect(context.isCurrentSessionScope?.()).toBe(true);
    scope = "session=b&epoch=2";
    expect(context.sessionScopeKey).toBe("session=a&epoch=1");
    expect(context.isCurrentSessionScope?.()).toBe(false);
    expect(createCommandContext("ribbon", kernel).sessionScopeKey).toBe(scope);
    expect(createCommandContext("ribbon", kernel, {
      sessionScopeKey: "session=explicit&epoch=3",
    }).sessionScopeKey).toBe("session=explicit&epoch=3");
  });
});
