import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PROJECT_CREATE_UNAVAILABLE, buildTemplateProjectSource } from "../model/scriptProject";
import { STUDY_TEMPLATES } from "../model/templates";

import { CreateProjectAction } from "./CreateProjectAction";

const source = buildTemplateProjectSource(STUDY_TEMPLATES[1]);

const button = (html: string) => /<button[^>]*>Create project…<\/button>/.exec(html)?.[0] ?? "";

describe("CreateProjectAction", () => {
  it("is enabled with a creator and a script, and does not run anything on render", () => {
    const creator = vi.fn();
    const html = renderToStaticMarkup(<CreateProjectAction creator={creator} source={source} />);
    expect(button(html)).not.toContain(' disabled=""');
    expect(creator).not.toHaveBeenCalled();
    // The consent prompt is closed until the click.
    expect(html).not.toContain("Run this script to create a project?");
  });

  it("is disabled with the real reason when there is no creator", () => {
    const html = renderToStaticMarkup(<CreateProjectAction creator={null} source={source} />);
    expect(button(html)).toContain(' disabled=""');
    expect(button(html)).toContain(`title="${PROJECT_CREATE_UNAVAILABLE}"`);
  });

  it("is disabled without a script", () => {
    const html = renderToStaticMarkup(<CreateProjectAction creator={vi.fn()} source={null} />);
    expect(button(html)).toContain(' disabled=""');
  });
});
