import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DataPreviewDialog } from "./DataPreviewDialog";

vi.mock("@/kernel/resources/dataPreviewResources", () => ({
  useDataPreviewFieldVector: () => ({
    resource: {
      data: {
        pointCount: 2,
        nComp: 3,
        valueCount: 6,
        values: new Float32Array([1, 0.1, 0, 1, 0.1, 0]),
        grid: [2, 1, 1],
      },
      error: null,
      refetch: vi.fn(),
      revision: "rev-123",
      status: "ready",
    },
    resourceKey: "mock:data-preview-field-vector",
    resourceRevision: "rev-123",
  }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useSolverStatusResource: () => ({
    data: {
      step: 123,
      time_s: 0,
      updated_at: "2026-08-07T07:16:09.073Z",
      revision: 54,
    },
  }),
  useFieldCatalogResource: () => ({
    data: {
      quantities: [
        { quantity_id: "m", label: "Magnetization" },
        { quantity_id: "H_eff", label: "Effective Field" },
        { quantity_id: "H_demag", label: "Demagnetization Field" },
      ],
    },
  }),
}));

describe("DataPreviewDialog", () => {
  it("renders copy button with correct attributes in static markup", () => {
    const html = renderToStaticMarkup(
      <DataPreviewDialog open={true} onOpenChange={vi.fn()} />,
    );
    expect(html).toContain('aria-label="Copy data preview log"');
    expect(html).toContain('title="Copy log to clipboard"');
    expect(html).toContain("m (Magnetization)");
    expect(html).toContain("H_eff (Effective Field)");
    expect(html).toContain("H_demag (Demagnetization Field)");
  });

  it("contains handleCopy log formatting implementation", () => {
    const source = readFileSync(
      resolve(__dirname, "DataPreviewDialog.tsx"),
      "utf-8",
    );
    expect(source).toContain("navigator.clipboard.writeText");
    expect(source).toContain("=== Data Preview ===");
    expect(source).toContain("[Data]");
    expect(source).toContain("[Resource]");
    expect(source).toContain("handleCopy");
  });
});
