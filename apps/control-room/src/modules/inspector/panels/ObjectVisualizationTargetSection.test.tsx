import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { useFieldMetaResource } from "@/kernel/resources/studyRuntimeResources";

import { ScalarColorbarControl } from "./ObjectVisualizationTargetSection";

const targetSectionSource = readFileSync(
  join(
    process.cwd(),
    "src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx",
  ),
  "utf8",
);

describe("ScalarColorbarControl", () => {
  it("shows the range that is currently rendered instead of stale field metadata", () => {
    const html = renderToStaticMarkup(
      <ScalarColorbarControl
        disabled={false}
        fieldMeta={{
          data: {
            quantity_id: "m",
            stats: { max: 0.1, min: -0.1 },
            unit: "1",
          },
          status: "ready",
        } as ReturnType<typeof useFieldMetaResource>}
        palette="viridis"
        patch={vi.fn()}
        quantityId="m"
        rangeIdentity="surface:m:x:object:film"
        renderedRange={{ max: 0.9957, min: 0.9943 }}
      />,
    );

    expect(html).toContain("0.9943");
    expect(html).toContain("0.9957");
    expect(html).not.toContain("-0.1");
    expect(html).not.toContain("0.1 to 0.1");
  });
});

describe("VisualizationVectorsSection", () => {
  it("does not offer surface lift for full geometry", () => {
    expect(targetSectionSource).toMatch(
      /settings\.geometryScope === "surface"\s*&&/,
    );
  });

  it("passes the session scene cap into vector budget resolution", () => {
    expect(targetSectionSource).toMatch(/sceneCap: number/);
    expect(targetSectionSource).toMatch(
      /requestedBudget: settings\.vectorBudget,\s*sceneCap,/,
    );
  });
});
