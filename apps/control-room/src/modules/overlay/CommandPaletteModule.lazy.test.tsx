import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

async function renderClosedPalette(sessionState: "no-session" | "ready") {
  vi.resetModules();
  const useStudyRuntimeCommandResourceData = vi.fn(() => ({}));
  vi.doMock("@/kernel/resources/studyRuntimeResources", () => ({
    useCommandDetailResource: () => ({
      data: null,
      error: null,
      refetch: () => undefined,
      revision: null,
      status: "idle",
    }),
    useStudyRuntimeCommandResourceData,
  }));
  vi.doMock("@/kernel/resources/useSessionCollection", () => ({
    useSessionCollection: () => ({ resource: { data: null }, state: sessionState }),
  }));
  vi.doMock("@/kernel/resources/useSessionStatus", () => ({
    useSessionResourceIdentity: () =>
      sessionState === "ready" ? { sessionId: "session-1" } : null,
  }));
  const MeshBuildDialog = vi.fn(() => null);
  vi.doMock("./MeshBuildDialog", () => ({ MeshBuildDialog }));

  const { default: CommandPaletteModule } = await import(
    "./CommandPaletteModule"
  );

  const markup = renderToStaticMarkup(
    <CommandPaletteModule
      config={{}}
      kernel={
        {
          bus: { on: () => () => undefined, subscribe: () => () => undefined },
          commands: {
            all: () => [],
            getVersion: () => 0,
            subscribe: () => () => undefined,
          },
        } as never
      }
      moduleId="command-palette"
      setConfig={() => undefined}
      slotId="overlay"
    />,
  );

  vi.doUnmock("@/kernel/resources/studyRuntimeResources");
  vi.doUnmock("@/kernel/resources/useSessionCollection");
  vi.doUnmock("@/kernel/resources/useSessionStatus");
  vi.doUnmock("./MeshBuildDialog");
  return { MeshBuildDialog, markup, useStudyRuntimeCommandResourceData };
}

// The lazy import is slow when the whole suite runs in parallel.
describe("CommandPaletteModule lazy runtime resources", { timeout: 20_000 }, () => {
  it("does not subscribe to the full runtime command bundle while closed", async () => {
    const rendered = await renderClosedPalette("ready");

    expect(rendered.useStudyRuntimeCommandResourceData).not.toHaveBeenCalled();
    expect(rendered.MeshBuildDialog).toHaveBeenCalled();
  });

  it("mounts no session-scoped surfaces on the start screen", async () => {
    const rendered = await renderClosedPalette("no-session");

    expect(rendered.useStudyRuntimeCommandResourceData).not.toHaveBeenCalled();
    expect(rendered.MeshBuildDialog).not.toHaveBeenCalled();
    expect(rendered.markup).toBe("");
  });
});
