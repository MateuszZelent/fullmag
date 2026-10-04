import { describe, expect, it } from "vitest";

import { generateBibtex, parseProvenance } from "./provenance";
import type { Author } from "./types";

const authors: Author[] = [
  { name: "Anna Kowalska", role: "creator" },
  { name: "Jan Nowak", role: "contributor" },
];

describe("parseProvenance", () => {
  it("rejects input that is not an object", () => {
    expect(parseProvenance(null)).toBeNull();
    expect(parseProvenance("x")).toBeNull();
  });

  it("drops malformed records one by one and sorts newest first", () => {
    const parsed = parseProvenance({
      recorded: true,
      authors: [{ name: "A", role: "wizard" }, { role: "creator" }],
      history: [
        { revision: 1, at: "2026-01-01T00:00:00Z", kind: "edit", summary: "old" },
        { revision: 2, at: "2026-06-01T00:00:00Z", kind: "run", summary: "new", run_id: "r-1" },
        { revision: 3, at: "t", kind: "teleport", summary: "bad" },
      ],
      runs: [
        { run_id: "a", started_at: "2026-01-01T00:00:00Z", status: "ready" },
        { run_id: "b", started_at: "2026-06-01T00:00:00Z", status: "failed", error: "x" },
        { run_id: "c", started_at: "t", status: "melted" },
      ],
    });
    expect(parsed?.authors).toEqual([
      { name: "A", role: "contributor", email: undefined, affiliation: undefined, orcid: undefined },
    ]);
    expect(parsed?.history.map((h) => h.summary)).toEqual(["new", "old"]);
    expect(parsed?.runs.map((r) => r.runId)).toEqual(["b", "a"]);
  });

  it("maps every field of a run the controller records, with its history entry", () => {
    const parsed = parseProvenance({
      recorded: true,
      history: [
        {
          revision: 7,
          at: "2026-10-04T10:05:00.000Z",
          kind: "run",
          summary: "Run run-1 finished",
          run_id: "run-1",
        },
      ],
      runs: [
        {
          run_id: "run-1",
          started_at: "2026-10-04T10:00:00.000Z",
          finished_at: "2026-10-04T10:05:00.000Z",
          status: "ready",
          device: "gpu",
          backend: "FDM",
          duration_seconds: 300,
          frames: 41,
          output_bytes: 1048576,
          revision: 7,
        },
      ],
    });
    expect(parsed?.runs).toEqual([
      {
        runId: "run-1",
        startedAt: "2026-10-04T10:00:00.000Z",
        finishedAt: "2026-10-04T10:05:00.000Z",
        status: "ready",
        device: "gpu",
        backend: "FDM",
        durationSeconds: 300,
        frames: 41,
        outputBytes: 1048576,
        revision: 7,
        error: undefined,
      },
    ]);
    expect(parsed?.history[0]).toMatchObject({ kind: "run", runId: "run-1", revision: 7 });
  });

  it("keeps a never-recorded project distinct from an empty record", () => {
    expect(parseProvenance({ recorded: false })?.recorded).toBe(false);
    expect(parseProvenance({})?.recorded).toBe(true);
  });
});

describe("generateBibtex", () => {
  it("builds an @misc entry from authors, name and revision", () => {
    const bibtex = generateBibtex({
      name: "YIG waveguide",
      authors,
      revision: 42,
      year: 2026,
      citation: { doi: "10.1234/abc" },
    });
    expect(bibtex).toBe(
      [
        "@misc{kowalska2026yig,",
        "  author = {Anna Kowalska and Jan Nowak},",
        "  title = {YIG waveguide},",
        "  year = {2026},",
        "  note = {Fullmag project, revision 42},",
        "  doi = {10.1234/abc}",
        "}",
      ].join("\n"),
    );
  });

  it("uses the preferred BibTeX verbatim when the project has one", () => {
    const preferred = "@dataset{x, title={T}}";
    expect(
      generateBibtex({ name: "n", authors, year: 2026, citation: { preferredBibtex: preferred } }),
    ).toBe(preferred);
  });

  it("copes with no authors and strips characters that break BibTeX", () => {
    const bibtex = generateBibtex({ name: "A {b} \\c", authors: [], year: 2026, citation: {} });
    expect(bibtex).not.toContain("author");
    expect(bibtex).toContain("title = {A b c}");
    expect(bibtex.startsWith("@misc{fullmag2026a,")).toBe(true);
  });
});
