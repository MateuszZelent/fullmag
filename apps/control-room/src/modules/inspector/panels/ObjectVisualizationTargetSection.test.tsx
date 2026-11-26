import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { useFieldMetaResource } from "@/kernel/resources/studyRuntimeResources";

import {
  ScalarColorbarControl,
  validateManualScalarRangeInput,
} from "./ObjectVisualizationTargetSection";

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

  it("shows native manual limits and states that out-of-range values are clipped", () => {
    const html = renderToStaticMarkup(
      <ScalarColorbarControl
        disabled={false}
        fieldMeta={{
          data: {
            quantity_id: "H_ex",
            stats: { max: 4, min: -3 },
            unit: "A/m",
          },
          status: "ready",
        } as ReturnType<typeof useFieldMetaResource>}
        palette="viridis"
        patch={vi.fn()}
        quantityId="H_ex"
        rangeIdentity="surface:H_ex:scalar:object:film"
        renderedRange={{ max: 2, min: -1 }}
        rangePreferenceComponent="scalar"
        scalarRangePolicy={{
          max: 2,
          min: -1,
          mode: "manual",
          scale: "linear",
          symmetric: false,
        }}
      />,
    );

    expect(html).toContain('type="number"');
    expect(html).toContain("Manual color range minimum");
    expect(html).toContain("Manual color range maximum");
    expect(html).toContain("Apply range");
    expect(html).toContain("Values outside this range are clipped");
    expect(html).toContain("-1 A/m to 2 A/m");
  });
});

describe("validateManualScalarRangeInput", () => {
  it("accepts signed components when both limits are finite and min is below max", () => {
    expect(validateManualScalarRangeInput("-0.75", "1.5")).toEqual({
      max: 1.5,
      min: -0.75,
      error: null,
    });
  });

  it.each([
    ["1", "1", "Minimum must be less than maximum."],
    ["Infinity", "2", "Enter finite numeric minimum and maximum values."],
    ["", "2", "Enter finite numeric minimum and maximum values."],
  ])("rejects invalid bounds %o", (min, max, error) => {
    expect(validateManualScalarRangeInput(min, max)).toMatchObject({ error });
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
