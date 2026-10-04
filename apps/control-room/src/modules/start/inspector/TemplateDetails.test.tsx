import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SCRIPT_OPEN_UNAVAILABLE, TEMPLATE_WITHOUT_SCRIPT } from "../model/scriptOpen";
import { STUDY_TEMPLATES } from "../model/templates";

import { TemplateDetails } from "./TemplateDetails";

const template = STUDY_TEMPLATES[1];

const render = (props: Partial<Parameters<typeof TemplateDetails>[0]> = {}) =>
  renderToStaticMarkup(<TemplateDetails compute={null} template={template} {...props} />);

const createButton = (html: string) => /<button[^>]*>Create project from template<\/button>/.exec(html)?.[0] ?? "";

describe("TemplateDetails", () => {
  it("keeps Create disabled, with the real reason, while this build cannot open a script", () => {
    const html = render();
    expect(createButton(html)).toContain(' disabled=""');
    expect(html).toContain(SCRIPT_OPEN_UNAVAILABLE);
    // The script itself is still available to the user.
    expect(html).toContain(`Save ${template.id}.py`);
    expect(html).toContain("Copy script");
    expect(html).toContain(`fullmag ${template.id}.py`);
  });

  it("enables Create when a script opener is bound", () => {
    const html = render({ scriptOpener: vi.fn() });
    expect(createButton(html)).not.toContain(' disabled=""');
    expect(html).not.toContain(SCRIPT_OPEN_UNAVAILABLE);
  });

  it("disables Create and hides the script actions for a template without a validated script", () => {
    const html = render({ scriptOpener: vi.fn(), template: { ...template, id: "not-validated" } });
    expect(createButton(html)).toContain(' disabled=""');
    expect(html).toContain(TEMPLATE_WITHOUT_SCRIPT);
    expect(html).not.toContain("Copy script");
  });
});
