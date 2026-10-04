import { describe, expect, it, vi } from "vitest";

import { translateMx3 } from "./mx3Import";
import {
  SCRIPT_OPEN_UNAVAILABLE,
  TEMPLATE_WITHOUT_SCRIPT,
  buildImportOpenRequest,
  createProjectFromTemplate,
  importOpenState,
  openTranslatedMx3,
  resolveScriptOpener,
  templateCreateState,
  type ScriptOpenRequest,
  type ScriptOpener,
} from "./scriptOpen";
import { STUDY_TEMPLATES, templateScript } from "./templates";

const sp4 = STUDY_TEMPLATES.find((t) => t.id === "umag-sp4")!;
const complete = translateMx3(
  "SetGridSize(8, 8, 1)\nSetCellSize(1e-9, 1e-9, 1e-9)\nMsat = 800e3\nAex = 13e-12\nm = Uniform(1, 0, 0)\nRun(1e-12)\n",
);

describe("resolveScriptOpener", () => {
  it("binds nothing in this build, because the API cannot ingest a script", () => {
    expect(resolveScriptOpener()).toBeNull();
    expect(SCRIPT_OPEN_UNAVAILABLE).toContain("no operation that accepts script text");
  });
});

describe("templateCreateState", () => {
  it("is unavailable, with the reason, while no opener is bound", () => {
    expect(templateCreateState(sp4, null)).toEqual({ available: false, reason: SCRIPT_OPEN_UNAVAILABLE });
  });

  it("is available once an opener exists", () => {
    expect(templateCreateState(sp4, vi.fn())).toEqual({ available: true, reason: null });
  });

  it("stays disabled for a template whose script was not validated, whatever the opener", () => {
    const unvalidated = { ...sp4, id: "no-script-yet" };
    expect(templateCreateState(unvalidated, vi.fn())).toEqual({
      available: false,
      reason: TEMPLATE_WITHOUT_SCRIPT,
    });
  });
});

describe("createProjectFromTemplate", () => {
  it("opens the template script as a project named after the template, with its origin", async () => {
    const opener = vi.fn<ScriptOpener>(async () => null);
    expect(await createProjectFromTemplate(sp4, opener)).toBeNull();
    expect(opener).toHaveBeenCalledTimes(1);
    const request: ScriptOpenRequest = opener.mock.calls[0][0];
    expect(request).toEqual({
      projectName: "µMAG Standard Problem #4",
      fileName: "umag-sp4.py",
      source: templateScript(sp4),
      origin: { kind: "template", templateId: "umag-sp4" },
    });
    // The request carries a script and a name only: no runs, results or history are claimed.
    expect(Object.keys(request).sort()).toEqual(["fileName", "origin", "projectName", "source"]);
  });

  it("returns the opener's failure unchanged", async () => {
    const opener: ScriptOpener = async () => "The session list is unconfirmed.";
    expect(await createProjectFromTemplate(sp4, opener)).toBe("The session list is unconfirmed.");
  });

  it("refuses without an opener and never calls anything", async () => {
    expect(await createProjectFromTemplate(sp4, null)).toBe(SCRIPT_OPEN_UNAVAILABLE);
  });
});

describe("importing a translated .mx3", () => {
  it("names the project after the file and keeps the origin", () => {
    expect(buildImportOpenRequest("C:\\runs\\Edge Mode.v2.mx3", complete)).toEqual({
      projectName: "Edge Mode.v2",
      fileName: "Edge Mode.v2.py",
      source: complete.script,
      origin: { kind: "import", format: "mx3", sourceFileName: "C:\\runs\\Edge Mode.v2.mx3" },
    });
  });

  it("does not open an incomplete translation, even with an opener", async () => {
    const opener = vi.fn<ScriptOpener>(async () => null);
    const incomplete = translateMx3("Msat = 800e3\n");
    const state = importOpenState(incomplete, opener);
    expect(state.available).toBe(false);
    expect(state.reason).toContain("incomplete");
    expect(await openTranslatedMx3("a.mx3", incomplete, opener)).toContain("incomplete");
    expect(opener).not.toHaveBeenCalled();
  });

  it("opens a complete translation through the opener, and refuses without one", async () => {
    const opener = vi.fn<ScriptOpener>(async () => null);
    expect(await openTranslatedMx3("a.mx3", complete, opener)).toBeNull();
    expect(opener.mock.calls[0][0].source).toBe(complete.script);
    expect(await openTranslatedMx3("a.mx3", complete, null)).toBe(SCRIPT_OPEN_UNAVAILABLE);
  });
});
