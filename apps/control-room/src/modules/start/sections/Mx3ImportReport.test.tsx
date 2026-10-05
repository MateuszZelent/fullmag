import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { translateMx3 } from "../model/mx3Import";
import { SCRIPT_SAVE_NEEDS_DESKTOP } from "../model/scriptOpen";

import { Mx3ImportReport } from "./Mx3ImportReport";

const source = (name: string) =>
  readFileSync(new URL(`../model/__fixtures__/mx3/${name}.mx3`, import.meta.url), "utf8");

const render = (name: string, saver: Parameters<typeof Mx3ImportReport>[0]["saver"] = null) =>
  renderToStaticMarkup(
    <Mx3ImportReport
      busy={false}
      fileName={`${name}.mx3`}
      onCopy={vi.fn()}
      onDiscard={vi.fn()}
      onCreate={vi.fn()}
      onSave={vi.fn()}
      saver={saver}
      translation={translateMx3(source(name))}
    />,
  );

describe("Mx3ImportReport", () => {
  it("lists every untranslated statement with its line and reason, before anything is written", () => {
    const html = render("spin_torque_sweep");
    expect(html).toContain("8 statements translated, 10 statements not translated");
    expect(html).toContain("Nothing is written until you confirm");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Xi = 0.05");
    expect(html).toContain("spin-transfer torque");
    expect(html).toContain("ext_makegrains(40e-9, 256, 0)");
      });

  it("says plainly when everything was translated", () => {
    const html = render("anisotropic_film");
    expect(html).toContain("Every statement in the source was translated.");
    expect(html).not.toContain("fm-start-report__unsupported");
    expect(html).toContain("Save translated script…");
  });

  it("disables Save with the real reason outside the desktop host, and still offers the file", () => {
    const html = render("standardproblem4");
    expect(/<button[^>]* disabled=""[^>]*>[\s\S]*?Save translated script…/.test(html)).toBe(true);
    expect(html).toContain(SCRIPT_SAVE_NEEDS_DESKTOP);
    expect(html).toContain("Download script");
    expect(html).toContain("Copy script");
  });

  it("enables Save when a saver exists, even with untranslated statements, and keeps the report visible", () => {
    const html = render("standardproblem4", vi.fn());
    expect(/<button[^>]* disabled=""[^>]*>[\s\S]*?Save translated script…/.test(html)).toBe(false);
    expect(html).toContain("not translated");
    expect(html).toContain("Nothing runs until you choose Run in new window");
  });

  it("offers Create project with the translated script, enabled only with a project creator", () => {
    const withCreator = renderToStaticMarkup(
      <Mx3ImportReport
        busy={false}
        fileName="standardproblem4.mx3"
        onCopy={vi.fn()}
        onCreate={vi.fn()}
        onDiscard={vi.fn()}
        onSave={vi.fn()}
        projectCreator={vi.fn()}
        saver={null}
        translation={translateMx3(source("standardproblem4"))}
      />,
    );
    expect(/<button[^>]*>Create project…<\/button>/.exec(withCreator)?.[0]).not.toContain(' disabled=""');
    expect(withCreator).toContain("Create project runs the translated script once");
    const without = render("standardproblem4");
    expect(/<button[^>]*>Create project…<\/button>/.exec(without)?.[0]).toContain(' disabled=""');
  });
});
