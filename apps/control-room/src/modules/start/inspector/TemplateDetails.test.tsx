import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SCRIPT_SAVE_NEEDS_DESKTOP, TEMPLATE_WITHOUT_SCRIPT } from "../model/scriptOpen";
import { STUDY_TEMPLATES } from "../model/templates";

import { TemplateDetails } from "./TemplateDetails";

const template = STUDY_TEMPLATES[1];

const render = (props: Partial<Parameters<typeof TemplateDetails>[0]> = {}) =>
  renderToStaticMarkup(<TemplateDetails compute={null} template={template} {...props} />);

const createButton = (html: string) =>
  /<button[^>]*>Create script from template…<\/button>/.exec(html)?.[0] ?? "";

describe("TemplateDetails", () => {
  it("keeps Create disabled, with the real reason, outside the desktop host", () => {
    const html = render();
    expect(createButton(html)).toContain(' disabled=""');
    expect(html).toContain(SCRIPT_SAVE_NEEDS_DESKTOP);
    // The script itself is still available to the user.
    expect(html).toContain(`Download ${template.id}.py`);
    expect(html).toContain("Copy script");
    expect(html).toContain(`fullmag ${template.id}.py`);
  });

  it("enables Create when a script saver is bound and says nothing runs by itself", () => {
    const html = render({ scriptSaver: vi.fn() });
    expect(createButton(html)).not.toContain(' disabled=""');
    expect(html).not.toContain(SCRIPT_SAVE_NEEDS_DESKTOP);
    expect(html).toContain("nothing runs until you choose Run in new window");
    expect(html).not.toContain("Create project from template");
  });

  it("disables Create and hides the script actions for a template without a validated script", () => {
    const html = render({ scriptSaver: vi.fn(), template: { ...template, id: "not-validated" } });
    expect(createButton(html)).toContain(' disabled=""');
    expect(html).toContain(TEMPLATE_WITHOUT_SCRIPT);
    expect(html).not.toContain("Copy script");
  });
});
