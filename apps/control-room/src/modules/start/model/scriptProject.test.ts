import { describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";

import { translateMx3 } from "./mx3Import";
import {
  PROJECT_CREATE_UNAVAILABLE,
  SCRIPT_PROJECT_MAX_BYTES,
  TEMPLATE_PROJECT_WITHOUT_SCRIPT,
  buildFromScriptRequest,
  buildMx3ProjectSource,
  buildTemplateProjectSource,
  consentCopy,
  describeFidelity,
  projectCreateFailureMessage,
  projectCreateState,
  scriptHashPrefix,
} from "./scriptProject";
import { STUDY_TEMPLATES } from "./templates";

const template = STUDY_TEMPLATES[1];
const creator = vi.fn();

describe("script project sources", () => {
  it("names a template script after the template and records the origin", () => {
    const source = buildTemplateProjectSource(template);
    expect(source).toMatchObject({
      fileName: `${template.id}.py`,
      origin: `template:${template.id}`,
      projectName: template.name,
    });
    expect(source?.text).toContain("import fullmag");
  });

  it("has no source for a template without a validated script", () => {
    expect(buildTemplateProjectSource({ ...template, id: "not-validated" })).toBeNull();
  });

  it("names a translated .mx3 after the file and records the origin", () => {
    const translation = translateMx3("Nx = 64\n", { studyName: "x" });
    const source = buildMx3ProjectSource("C:\\models\\sp4.mx3", translation);
    expect(source).toMatchObject({ fileName: "sp4.py", origin: "mx3:sp4.mx3", projectName: "sp4" });
    expect(source.text).toBe(translation.script);
  });
});

describe("projectCreateState", () => {
  const source = buildTemplateProjectSource(template);

  it("is available with a creator and a script", () => {
    expect(projectCreateState(source, creator)).toEqual({ available: true, reason: null });
  });

  it("says why it is not available", () => {
    expect(projectCreateState(null, creator).reason).toBe(TEMPLATE_PROJECT_WITHOUT_SCRIPT);
    expect(projectCreateState(source, null).reason).toBe(PROJECT_CREATE_UNAVAILABLE);
    const big = { ...source!, text: "#".repeat(SCRIPT_PROJECT_MAX_BYTES + 1) };
    expect(projectCreateState(big, creator).available).toBe(false);
    expect(projectCreateState(big, creator).reason).toContain("1 MiB");
  });

  it("counts UTF-8 bytes, not characters", () => {
    const text = "µ".repeat(SCRIPT_PROJECT_MAX_BYTES / 2 + 1);
    expect(projectCreateState({ ...source!, text }, creator).available).toBe(false);
  });
});

describe("consent", () => {
  it("names the file, the hash prefix and says the script runs", () => {
    const source = buildTemplateProjectSource(template)!;
    const copy = consentCopy(source, "0123456789ab");
    expect(copy.body).toContain("runs the script");
    expect(copy.facts).toContainEqual({ label: "File", value: `${template.id}.py` });
    expect(copy.facts).toContainEqual({ label: "SHA-256", value: "0123456789ab…" });
  });

  it("admits when no digest is available", () => {
    const copy = consentCopy(buildTemplateProjectSource(template)!, null);
    expect(copy.facts.find((fact) => fact.label === "SHA-256")?.value).toContain("not available");
  });

  it("hashes with SHA-256 (abc)", async () => {
    expect(await scriptHashPrefix("abc")).toBe("ba7816bf8f01");
  });

  it("builds a request that carries the consent flag", () => {
    const request = buildFromScriptRequest(buildTemplateProjectSource(template)!);
    expect(request.consent).toEqual({ executed_by_user: true });
    expect(request.origin).toBe(`template:${template.id}`);
    expect(request.source?.name).toBe(`${template.id}.py`);
  });
});

describe("describeFidelity", () => {
  it("never claims a failed or unchecked round trip as success", () => {
    const failed = describeFidelity({ scene_exported: true, round_trip: "failed", notes: ["a", "b"] });
    expect(failed.tone).toBe("warning");
    expect(failed.headline).toBe("Round trip failed");
    expect(failed.notes).toEqual(["a", "b"]);
    expect(failed.detail).toContain("not an exact copy");
    expect(describeFidelity({ scene_exported: true, round_trip: "not_checked", notes: [] }).tone).toBe("warning");
  });

  it("says verified only for a verified round trip", () => {
    const verified = describeFidelity({ scene_exported: true, round_trip: "verified", notes: [] });
    expect(verified.tone).toBe("ok");
    expect(verified.detail).toContain("remains the source for runs");
  });
});

describe("projectCreateFailureMessage", () => {
  it("keeps the helper's message for a 422 and says nothing was kept", () => {
    const message = projectCreateFailureMessage(
      new ControlRoomApiError("script_export_failed: RuntimeError: boom", 422, null, "script_export_failed"),
    );
    expect(message).toContain("nothing was kept");
    expect(message).toContain("RuntimeError: boom");
  });

  it("explains 413 and other failures", () => {
    expect(projectCreateFailureMessage(new ControlRoomApiError("big", 413))).toContain("1 MiB");
    expect(projectCreateFailureMessage(new ControlRoomApiError("down", 500))).toContain("down");
    expect(projectCreateFailureMessage(new Error("offline"))).toContain("offline");
  });
});
