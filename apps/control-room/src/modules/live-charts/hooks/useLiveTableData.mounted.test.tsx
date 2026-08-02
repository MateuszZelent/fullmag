import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const calls = vi.hoisted(() => ({ columns: [] as unknown[], list: [] as unknown[], rows: [] as unknown[], table: [] as unknown[] }));
const columns = [{ column_id: "step", label: "step", unit: "1" }, { column_id: "mx", label: "mx", unit: "1" }];
const readyRows = { data: { status: "ready", data: { columnCount: 2, cursorEnd: 1, cursorStart: 1, resyncRequired: false, revision: 1, rowCount: 1, schemaRevision: 1, totalRows: 1, values: new Float64Array([1, 0.97982]) } }, error: null, revision: 1, status: "ready" as const, refetch: () => undefined };

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useTableColumnsResource: (_id: string, options: unknown) => { calls.columns.push(options); return { data: columns, status: "ready" }; },
  useTableListResource: (options: unknown) => { calls.list.push(options); return { data: null, status: "ready" }; },
  useTableResource: (_id: string, options: unknown) => { calls.table.push(options); return { data: null, status: "ready" }; },
  useTableRowsBinaryResource: (_id: string, options: unknown) => { calls.rows.push(options); return readyRows; },
}));

import { useLiveTableData } from "./useLiveTableData";

function Harness({ active, paused }: { active: boolean; paused: boolean }) {
  const result = useLiveTableData({ active, paused, range: { mode: "follow" }, targetPoints: 800, xAxisId: "step" });
  return <output>{result.table?.rowCount ?? 0}</output>;
}

describe("useLiveTableData mounted resource gating", () => {
  it("does not subscribe metadata or payload resources while inactive or initially paused", async () => {
    installSimulationPreparationTestDom();
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => { root.render(<Harness active={false} paused={false} />); });
    await act(async () => { root.render(<Harness active={true} paused={true} />); });
    for (const option of [...calls.list, ...calls.table, ...calls.columns, ...calls.rows] as Array<{ enabled: boolean }>) expect(option.enabled).toBe(false);
    await act(async () => root.unmount());
  });

  it("keeps the retained table during pause and enables one fresh payload request on resume", async () => {
    installSimulationPreparationTestDom();
    calls.columns.length = calls.list.length = calls.rows.length = calls.table.length = 0;
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => { root.render(<Harness active paused={false} />); });
    expect(host.textContent).toBe("1");
    const initialRows = calls.rows.length;
    await act(async () => { root.render(<Harness active paused />); });
    expect(host.textContent).toBe("1");
    expect((calls.rows.at(-1) as { enabled: boolean }).enabled).toBe(false);
    await act(async () => { root.render(<Harness active paused={false} />); });
    expect(calls.rows.length).toBe(initialRows + 2);
    expect((calls.rows.at(-1) as { enabled: boolean }).enabled).toBe(true);
    await act(async () => root.unmount());
  });
});
