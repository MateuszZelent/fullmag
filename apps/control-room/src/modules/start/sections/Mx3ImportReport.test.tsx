import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { translateMx3 } from "../model/mx3Import";
import { SCRIPT_OPEN_UNAVAILABLE } from "../model/scriptOpen";

import { Mx3ImportReport } from "./Mx3ImportReport";

const source = (name: string) =>
  readFileSync(new URL(`../model/__fixtures__/mx3/${name}.mx3`, import.meta.url), "utf8");

const render = (name: string, opener: Parameters<typeof Mx3ImportReport>[0]["opener"] = null) =>
  renderToStaticMarkup(
    <Mx3ImportReport
      busy={false}
      fileName={`${name}.mx3`}
      onCopy={vi.fn()}
      onDiscard={vi.fn()}
      onOpen={vi.fn()}
      onSave={vi.fn()}
      opener={opener}
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
    expect(html).toContain("Open with 10 untranslated statements");
  });

  it("says plainly when everything was translated", () => {
    const html = render("anisotropic_film");
    expect(html).toContain("Every statement in the source was translated.");
    expect(html).not.toContain("fm-start-report__unsupported");
    expect(html).toContain("Open translated script");
  });

  it("disables Open with the real reason when no script opener is bound, and still offers the file", () => {
    const html = render("standardproblem4");
    expect(/<button[^>]* disabled=""[^>]*>[\s\S]*?Open with 1 untranslated statement/.test(html)).toBe(true);
    expect(html).toContain(SCRIPT_OPEN_UNAVAILABLE);
    expect(html).toContain("Save script");
    expect(html).toContain("Copy script");
  });

  it("enables Open when an opener exists and the translation is complete", () => {
    const html = render("standardproblem4", vi.fn());
    expect(/<button[^>]* disabled=""[^>]*>[\s\S]*?Open with 1 untranslated statement/.test(html)).toBe(false);
  });
});
