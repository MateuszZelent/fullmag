import { describe, expect, it } from "vitest";

import { CommandRegistry } from "./CommandRegistry";
import { createCommandContext } from "./commandContext";

describe("createCommandContext session ownership", () => {
  it("captures ownership when the UI context is created rather than rebinding old inputs", () => {
    const commands = new CommandRegistry();
    let scope = "session=a&epoch=1";
    commands.attachSessionScopeSource({
      getScopeKey: () => scope,
      subscribe: () => () => {},
    });
    const kernel = { commands } as never;
    const context = createCommandContext("ribbon", kernel);
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
