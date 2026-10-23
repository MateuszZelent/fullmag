import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { useClipboardCopy } from "./useClipboardCopy";

const mocks = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock("./copyTextToClipboard", () => ({ copyTextToClipboard: mocks.copy }));

describe("clipboard acknowledgement feedback", () => {
  beforeEach(() => mocks.copy.mockReset());

  it("waits for the clipboard acknowledgement and ignores duplicate submissions", async () => {
    const ack = deferred();
    mocks.copy.mockReturnValue(ack.promise);
    const harness = await mountCopy();
    try {
      let result!: Promise<boolean>;
      await act(async () => { result = harness.current().copy("actual payload"); });
      expect(harness.current().status).toBe("pending");
      expect(await harness.current().copy("duplicate")).toBe(false);
      expect(mocks.copy).toHaveBeenCalledExactlyOnceWith("actual payload");
      await act(async () => { ack.resolve(); await result; });
      expect(await result).toBe(true);
      expect(harness.current().status).toBe("success");
    } finally { await harness.dispose(); }
  });

  it("reports a rejected write and allows retry without claiming success", async () => {
    mocks.copy.mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce(undefined);
    const harness = await mountCopy();
    try {
      await act(async () => { expect(await harness.current().copy("payload")).toBe(false); });
      expect(harness.current().status).toBe("error");
      expect(harness.current().error).toContain("Could not copy");
      await act(async () => { expect(await harness.current().copy("payload")).toBe(true); });
      expect(harness.current().status).toBe("success");
      expect(harness.current().error).toBeNull();
    } finally { await harness.dispose(); }
  });

  it("does not publish a late acknowledgement for a different source", async () => {
    const oldAck = deferred();
    const newAck = deferred();
    mocks.copy.mockReturnValueOnce(oldAck.promise).mockReturnValueOnce(newAck.promise);
    const harness = await mountCopy();
    try {
      let oldResult!: Promise<boolean>;
      let newResult!: Promise<boolean>;
      await act(async () => { oldResult = harness.current().copy("old source"); });
      await harness.render("source-b");
      expect(harness.current().status).toBe("idle");
      await act(async () => { newResult = harness.current().copy("new source"); });
      await act(async () => { oldAck.resolve(); await oldResult; });
      expect(await oldResult).toBe(false);
      expect(harness.current().status).toBe("pending");
      await act(async () => { newAck.resolve(); await newResult; });
      expect(harness.current().status).toBe("success");
    } finally { await harness.dispose(); }
  });

  it("does not replay success after leaving and returning to the same source", async () => {
    mocks.copy.mockResolvedValue(undefined);
    const harness = await mountCopy();
    try {
      await act(async () => { await harness.current().copy("source-a"); });
      expect(harness.current().status).toBe("success");
      await harness.render("source-b");
      await harness.render("source-a");
      expect(harness.current().status).toBe("idle");
    } finally { await harness.dispose(); }
  });

  it("ignores a write that finishes after unmount", async () => {
    const ack = deferred();
    mocks.copy.mockReturnValue(ack.promise);
    const harness = await mountCopy();
    let result!: Promise<boolean>;
    await act(async () => { result = harness.current().copy("payload"); });
    await harness.dispose();
    ack.resolve();
    expect(await result).toBe(false);
  });
});

async function mountCopy() {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  let current!: ReturnType<typeof useClipboardCopy>;
  function Harness({ identity }: { identity: string }) {
    current = useClipboardCopy(identity);
    return <span>{current.status}</span>;
  }
  const render = async (identity: string) => {
    await act(async () => root.render(<Harness identity={identity} />));
  };
  await render("source-a");
  return {
    current: () => current,
    render,
    dispose: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
