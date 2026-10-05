import { describe, expect, it, vi } from "vitest";

import { translateMx3 } from "./mx3Import";
import {
  SCRIPT_SAVE_NEEDS_DESKTOP,
  TEMPLATE_WITHOUT_SCRIPT,
  buildImportSaveRequest,
  createScriptFromTemplate,
  importSaveState,
  saveTranslatedMx3,
  scriptSaveAvailable,
  templateCreateState,
  type ScriptSaver,
} from "./scriptOpen";
import { STUDY_TEMPLATES, templateScript } from "./templates";

const sp4 = STUDY_TEMPLATES.find((t) => t.id === "umag-sp4")!;
const complete = translateMx3(
  "SetGridSize(8, 8, 1)\nSetCellSize(1e-9, 1e-9, 1e-9)\nMsat = 800e3\nAex = 13e-12\nm = Uniform(1, 0, 0)\nRun(1e-12)\n",
);
const saved: ScriptSaver = async () => ({ kind: "cancelled" });

describe("script saving availability", () => {
  it("needs a desktop host, which the test runtime does not have", () => {
    expect(scriptSaveAvailable()).toBe(false);
  });
});

describe("templateCreateState", () => {
  it("is unavailable, with the reason, outside the desktop host", () => {
    expect(templateCreateState(sp4, null)).toEqual({ available: false, reason: SCRIPT_SAVE_NEEDS_DESKTOP });
  });

  it("is available once a saver exists", () => {
    expect(templateCreateState(sp4, saved)).toEqual({ available: true, reason: null });
  });

  it("stays disabled for a template whose script was not validated, whatever the saver", () => {
    const unvalidated = { ...sp4, id: "no-script-yet" };
    expect(templateCreateState(unvalidated, saved)).toEqual({
      available: false,
      reason: TEMPLATE_WITHOUT_SCRIPT,
    });
  });
});

describe("createScriptFromTemplate", () => {
  it("sends the canonical script, a suggested file name and the template origin, and no path", async () => {
    const saver = vi.fn<ScriptSaver>(async () => ({ kind: "cancelled" }));
    expect(await createScriptFromTemplate(sp4, saver)).toBeNull();
    expect(saver).toHaveBeenCalledTimes(1);
    const request = saver.mock.calls[0][0];
    expect(request).toEqual({
      suggestedName: "umag-sp4.py",
      text: templateScript(sp4),
      origin: "template",
      originId: "umag-sp4",
    });
    expect(Object.keys(request).sort()).toEqual(["origin", "originId", "suggestedName", "text"]);
  });

  it("reports a failure of the host and treats a cancelled dialog as no failure", async () => {
    const failing: ScriptSaver = async () => ({ kind: "failed", message: "Could not save the script: disk full" });
    expect(await createScriptFromTemplate(sp4, failing)).toBe("Could not save the script: disk full");
    expect(await createScriptFromTemplate(sp4, saved)).toBeNull();
  });

  it("refuses without a saver and never calls anything", async () => {
    expect(await createScriptFromTemplate(sp4, null)).toBe(SCRIPT_SAVE_NEEDS_DESKTOP);
  });
});

describe("saving a translated .mx3", () => {
  it("names the script after the file and keeps the file name as the origin", () => {
    expect(buildImportSaveRequest("C:/runs/Edge Mode.v2.mx3", complete)).toEqual({
      suggestedName: "Edge Mode.v2.py",
      text: complete.script,
      origin: "mx3",
      originId: "Edge Mode.v2.mx3",
    });
  });

  it("saves an incomplete translation too: the report says it stops when run", async () => {
    const saver = vi.fn<ScriptSaver>(async () => ({ kind: "cancelled" }));
    const incomplete = translateMx3("Msat = 800e3\n");
    expect(incomplete.runnable).toBe(false);
    expect(importSaveState(saver).available).toBe(true);
    expect(await saveTranslatedMx3("a.mx3", incomplete, saver)).toBeNull();
    expect(saver.mock.calls[0][0].text).toBe(incomplete.script);
  });

  it("refuses without a saver", async () => {
    expect(importSaveState(null)).toEqual({ available: false, reason: SCRIPT_SAVE_NEEDS_DESKTOP });
    expect(await saveTranslatedMx3("a.mx3", complete, null)).toBe(SCRIPT_SAVE_NEEDS_DESKTOP);
  });
});
