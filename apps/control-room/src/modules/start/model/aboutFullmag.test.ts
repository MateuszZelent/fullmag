import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FULLMAG_AUTHORS,
  FULLMAG_BIBTEX,
  FULLMAG_CITATION,
  FULLMAG_CITATION_NOTE,
  FULLMAG_COORDINATION,
  FULLMAG_FUNDING,
  FULLMAG_LICENSE,
  FULLMAG_OVERVIEW,
  FULLMAG_TAGLINE,
} from "./aboutFullmag";

// The repository README is the source of these facts; this guards against drift.
// A Windows checkout may use CRLF line endings; the content is what matters.
const readme = readFileSync(
  new URL("../../../../../../readme.md", import.meta.url),
  "utf8",
).split("\r\n").join("\n");
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
// Prose is compared without Markdown emphasis and code spans.
const prose = flat(readme.replace(/[*`]/g, ""));

describe("About page content", () => {
  it("states the tagline and overview as the README does", () => {
    expect(prose).toContain(FULLMAG_TAGLINE);
    for (const paragraph of FULLMAG_OVERVIEW) {
      expect(prose).toContain(flat(paragraph));
    }
  });

  it("lists every author with the affiliation the README gives", () => {
    for (const author of FULLMAG_AUTHORS) {
      expect(readme).toContain(`| ${author.name} | ${author.affiliation} |`);
    }
    expect(prose).toContain(FULLMAG_COORDINATION);
  });

  it("quotes the README's citation sentence and its note", () => {
    expect(prose).toContain(FULLMAG_CITATION);
    expect(prose).toContain(flat(FULLMAG_CITATION_NOTE));
  });

  it("carries the README's BibTeX, license statement and funding line verbatim", () => {
    expect(readme).toContain(FULLMAG_BIBTEX);
    expect(prose).toContain(flat(FULLMAG_LICENSE));
    expect(prose).toContain(flat(FULLMAG_FUNDING));
  });
});
