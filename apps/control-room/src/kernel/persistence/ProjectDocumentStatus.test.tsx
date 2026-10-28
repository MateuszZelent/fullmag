import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProjectDocumentSnapshot } from "./ProjectDocumentController";
import { ProjectDocumentStatusLabel } from "./ProjectDocumentStatus";

describe("ProjectDocumentStatusLabel", () => {
  it("keeps unsaved status outside the truncatable project name", () => {
    const name = "A project with a long descriptive name";
    const snapshot = {
      state: "ready",
      fileName: "/fixture/project.fms",
      resource: { name, dirty: true },
    } as ProjectDocumentSnapshot;
    const html = renderToStaticMarkup(<ProjectDocumentStatusLabel snapshot={snapshot} />);
    expect(html).toContain(`title="/fixture/project.fms"`);
    expect(html).toMatch(new RegExp(`class="fm-header__project-status-name">${name}</span>`));
    expect(html).toContain('<span class="fm-header__project-status-dirty"> · unsaved</span>');
    expect(html).toContain('aria-live="polite"');
  });

  it("leaves clean project names intact without an unsaved marker", () => {
    const snapshot = { state: "ready", resource: { name: "Project", dirty: false } } as ProjectDocumentSnapshot;
    const html = renderToStaticMarkup(<ProjectDocumentStatusLabel snapshot={snapshot} />);
    expect(html).toContain("Project</span>");
    expect(html).not.toContain("project-status-dirty");
  });
});
