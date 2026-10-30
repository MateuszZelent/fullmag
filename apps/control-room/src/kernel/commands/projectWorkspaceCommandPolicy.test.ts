import { describe, expect, it } from "vitest";
import { isProjectWorkspaceCommand } from "./projectWorkspaceCommandPolicy";
import { STUDY_RUNTIME_COMMANDS } from "../runtime/studyRuntimeCommandContributions";
import { findShortcutCommand } from "./commandShortcuts";

describe("no-session workspace command policy", () => {
  it("exposes archive restore in the empty Home menu and shortcut set", () => {
    expect(isProjectWorkspaceCommand("study.import-state")).toBe(true);
    const commands = STUDY_RUNTIME_COMMANDS.filter(command => isProjectWorkspaceCommand(command.id));
    expect(findShortcutCommand(commands, { key: "O", ctrlKey: true, shiftKey: true })?.id)
      .toBe("study.import-state");
  });
  it.each(["study.start", "study.solve", "study.prepare-live", "study.restore-checkpoint", "study.pause", "study.stop"])(
    "keeps %s unavailable without a session", id => {
      expect(isProjectWorkspaceCommand(id)).toBe(false);
    },
  );
});
