import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

describe("CommandPaletteModule lazy runtime resources", () => {
  it("does not subscribe to the full runtime command bundle while closed", async () => {
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
    vi.doMock("./MeshBuildDialog", () => ({
      MeshBuildDialog: () => null,
    }));
    vi.doMock("../viewport-3d/components/Viewport3DSettingsDialog", () => ({
      Viewport3DSettingsDialog: () => null,
    }));

    const { default: CommandPaletteModule } = await import(
      "./CommandPaletteModule"
    );

    renderToStaticMarkup(
      <CommandPaletteModule
        config={{}}
        kernel={
          {
            bus: { on: () => () => undefined },
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

    expect(useStudyRuntimeCommandResourceData).not.toHaveBeenCalled();
    vi.doUnmock("@/kernel/resources/studyRuntimeResources");
    vi.doUnmock("./MeshBuildDialog");
    vi.doUnmock("../viewport-3d/components/Viewport3DSettingsDialog");
  });
});
