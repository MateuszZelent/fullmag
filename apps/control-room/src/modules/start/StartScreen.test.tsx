import { act, type ReactNode, type Ref, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleProps } from "@/kernel/types";
import {
  findElement,
  installSimulationPreparationTestDom,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { StartScreen } from "./StartScreen";
import { startScreenStore, type StartScreenHost } from "./model/startScreenState";

const mocks = vi.hoisted(() => ({
  sessionState: "loading" as "loading" | "no-session",
  workspaceApi: {
    state: { kind: "unavailable" as const, reason: "Workspace API unavailable." },
    announcement: "",
    refresh: vi.fn(),
    pin: vi.fn(async () => null),
    forget: vi.fn(async () => null),
    scan: vi.fn(async () => ({ failure: "Unavailable." })),
    addByPath: vi.fn(async () => ({ failure: "Unavailable." })),
    thumbnailUrl: vi.fn((id: string) => `/thumbnail/${id}`),
    archiveUrl: vi.fn((id: string) => `/archive/${id}`),
    loadFrames: vi.fn(async () => ({ frames: [], next: null })),
    scanning: false,
  },
  recent: {
    state: { kind: "loading" as const },
    rebuilding: false,
    announcement: "",
    refresh: vi.fn(async () => undefined),
    rebuild: vi.fn(async () => undefined),
    pin: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
  },
  scripts: {
    state: { kind: "loading" as const },
    readOnly: false,
    announcement: "",
    refresh: vi.fn(async () => undefined),
    pin: vi.fn(async () => null),
    forget: vi.fn(async () => null),
    open: vi.fn(async () => null),
    reveal: vi.fn(async () => null),
    pickAndOpen: vi.fn(async () => ({ item: null, failure: null })),
    saveNew: vi.fn(async () => ({ kind: "cancelled" as const })),
    readText: vi.fn(async () => ({ text: "" })),
    desktopIdOf: vi.fn(() => null),
  },
  results: {
    state: { kind: "loading" as const },
    pin: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
  },
  computeProbe: {
    compute: null,
    nodeInventory: null,
    error: null,
    refreshing: false,
    stale: false,
    refresh: vi.fn(),
    canEditNodePolicy: false,
    updateNodePolicy: vi.fn(),
    canPublishExecutionProfiles: false,
    publishExecutionProfile: vi.fn(),
  },
}));

vi.mock("@/kernel/resources/useSessionCollection", () => ({
  useSessionCollection: () => ({
    state: mocks.sessionState,
    resource: { data: { sessions: [] } },
  }),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => null,
  useSessionStatusSelector: () => null,
}));
vi.mock("@/kernel/persistence/ProjectDocumentStatus", () => ({
  useProjectDocumentSnapshot: () => null,
}));
vi.mock("@/kernel/layout/instanceTabs", () => ({
  instanceTabs: { open: vi.fn() },
  useEmbeddedInstanceTab: () => false,
}));
vi.mock("@/kernel/commands/commandContext", () => ({
  createCommandContext: () => ({}),
}));
vi.mock("@/kernel/layout/homeView", () => ({
  homeView: {
    close: vi.fn(),
    subscribeDocs: vi.fn(() => () => undefined),
  },
}));
vi.mock("@/kernel/persistence/ScriptProjectActivation", () => ({
  createAndActivateScriptProject: vi.fn(),
}));
vi.mock("@/kernel/resources/instanceDiscoveryResources", () => ({
  useInstanceDiscovery: () => ({ data: null }),
}));
vi.mock("./model/useWorkspaceItems", () => ({
  useWorkspaceItems: () => mocks.workspaceApi,
  useWorkspaceItemDetail: () => ({ state: "idle" }),
}));
vi.mock("./model/useWorkspaceSource", () => ({
  useWorkspaceSource: () => ({
    origin: "api",
    recent: mocks.recent,
    scripts: mocks.scripts,
    results: mocks.results,
    workspace: mocks.workspaceApi,
    workspaceIdOfProject: () => null,
  }),
}));
vi.mock("./model/useRecentIndex", () => ({
  useRecentIndex: () => mocks.recent,
}));
vi.mock("./model/useWorkspaceScripts", () => ({
  useWorkspaceScripts: () => mocks.scripts,
}));
vi.mock("./model/useStartPreferences", () => ({
  useStartPreferences: () => ({ state: { kind: "loading" }, saving: false, setTelemetry: vi.fn() }),
}));
vi.mock("./model/useComputeProbe", () => ({
  useComputeProbe: () => mocks.computeProbe,
}));
vi.mock("./model/executionAvailability", () => ({
  useExecutionAvailability: () => [],
}));
vi.mock("./model/useAuthorName", () => ({
  useAuthorName: () => "Test author",
}));
vi.mock("./model/workspaceHost", () => ({
  workspaceHostAvailable: () => false,
}));
vi.mock("./model/startCommands", () => ({
  startActionDisabledReason: () => null,
}));
vi.mock("./model/startSettings", () => ({
  startSettings: {
    getSnapshot: () => ({ recentKind: "all" }),
    update: vi.fn(),
  },
}));
vi.mock("./model/scriptOpen", () => ({
  scriptSaveAvailable: () => false,
}));
vi.mock("./model/scriptProject", () => ({
  buildFromScriptRequest: vi.fn(),
  projectCreateFailureMessage: vi.fn(),
}));
vi.mock("./model/recentIndexHost", () => ({
  readProjectArchiveAtPath: vi.fn(),
}));
vi.mock("./home/LaunchTiles", () => ({ LAUNCH_TILES: [] }));
vi.mock("./rail/StartRail", () => ({
  StartRail: ({ section }: { section: string }) => <div data-start-rail-section={section} />,
}));
vi.mock("./home/HomeSection", () => ({
  HomeSection: ({ initialFocusRef }: { initialFocusRef: Ref<HTMLButtonElement> }) => (
    <section><button data-start-initial-focus ref={initialFocusRef} type="button">Home</button></section>
  ),
}));
vi.mock("./inspector/ProjectInspector", () => ({
  ProjectInspector: () => <aside>Inspector</aside>,
}));
vi.mock("./sections/AboutSection", () => ({ AboutSection: () => <section>About</section> }));
vi.mock("./sections/DocsSection", () => ({ DocsSection: () => <section>Docs</section> }));
vi.mock("./sections/ImportSection", () => ({
  ImportSection: () => <section data-start-import>Import</section>,
}));
vi.mock("./sections/LearnSection", () => ({ LearnSection: () => <section>Learn</section> }));
vi.mock("./sections/SettingsSection", () => ({
  SettingsSection: () => <section>Settings</section>,
}));
vi.mock("./sections/TemplatesSection", () => ({
  TemplatesSection: () => <section>Templates</section>,
}));
vi.mock("./ui/StartStatusBar", () => ({ StartStatusBar: () => null }));
vi.mock("@/shared/ui/Sheet", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Sheet: Passthrough,
    SheetContent: Passthrough,
    SheetDescription: Passthrough,
    SheetHeader: Passthrough,
    SheetTitle: Passthrough,
    SheetTrigger: Passthrough,
  };
});

interface CommittedStartScreenDom {
  readonly ariaBusy: string | null;
  readonly commandRefreshCount: number | null;
  readonly createProblemDisabledReason: string | null;
  readonly host: StartScreenHost | null;
  readonly inert: boolean;
}

function CommittedDomObserver({
  container,
  onCommit,
  commandRefreshCount,
  onFocusAttempt,
}: {
  readonly container: TestElement;
  readonly onCommit: (snapshot: CommittedStartScreenDom) => void;
  readonly commandRefreshCount?: () => number;
  readonly onFocusAttempt?: (whileInert: boolean) => void;
}) {
  useLayoutEffect(() => {
    const start = findElement(
      container,
      (element) => element.getAttribute("class") === "fm-start",
      "StartScreen",
    );
    const host = startScreenStore.getSnapshot().host;
    onCommit({
      ariaBusy: start.getAttribute("aria-busy"),
      commandRefreshCount: commandRefreshCount?.() ?? null,
      createProblemDisabledReason: host?.createProblemDisabledReason ?? null,
      host,
      inert: start.hasAttribute("inert"),
    });
    if (onFocusAttempt) {
      const button = findElement(
        container,
        (element) => element.hasAttribute("data-start-initial-focus"),
        "initial Home focus target",
      );
      button.focus = () => {
        onFocusAttempt(start.hasAttribute("inert"));
        container.ownerDocument.activeElement = button;
      };
    }
  });
  return null;
}

describe("StartScreen host capabilities", () => {
  let dom: ReturnType<typeof installSimulationPreparationTestDom>;
  let roots: Set<Root>;

  beforeEach(() => {
    dom = installSimulationPreparationTestDom();
    roots = new Set();
    mocks.sessionState = "loading";
    startScreenStore.resetForTests();
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots) root.unmount();
    });
    roots.clear();
    startScreenStore.resetForTests();
    dom.restore();
  });

  const mounted = () => {
    const container = dom.document.createElement("div") as unknown as TestElement;
    const root = createRoot(container as unknown as Element);
    roots.add(root);
    return { container, root };
  };

  const render = (root: Root, kernel: ModuleProps["kernel"]) =>
    root.render(view(kernel));

  const view = (kernel: ModuleProps["kernel"]) => (
    <StartScreen
      kernel={kernel}
      moduleId="start-screen"
      config={{}}
      setConfig={() => undefined}
    />
  );

  const makeKernel = () => {
    const commands = {
      execute: vi.fn(async () => ({ status: "failed" as const })),
      refresh: vi.fn(),
      get: vi.fn(() => undefined),
      isEnabled: vi.fn(() => true),
    };
    return {
      commands,
      kernel: { commands, projectDocument: null } as unknown as ModuleProps["kernel"],
    };
  };

  const sectionOf = (container: TestElement) =>
    findElement(container, (element) => element.getAttribute("class") === "fm-start", "StartScreen");

  const unmount = async (root: Root) => {
    await act(async () => root.unmount());
    roots.delete(root);
  };

  it("renders the SSR launcher inert and busy until hydration attaches a host", () => {
    dom.restore();
    let markup: string;
    try {
      markup = renderToStaticMarkup(view(makeKernel().kernel));
    } finally {
      dom = installSimulationPreparationTestDom();
    }
    const start = markup.match(/<div[^>]*class="fm-start"[^>]*>/)?.[0];

    expect(start).toContain('aria-busy="true"');
    expect(start).toContain('inert=""');
  });

  it("keeps the committed launcher inert until its current owner is ready", async () => {
    const { root, container } = mounted();
    const commits: CommittedStartScreenDom[] = [];
    const focusAttemptsWhileInert: boolean[] = [];
    const kernel = makeKernel().kernel;

    await act(async () => root.render(
      <>
        {view(kernel)}
        <CommittedDomObserver
          container={container}
          onCommit={(snapshot) => commits.push(snapshot)}
          onFocusAttempt={(whileInert) => focusAttemptsWhileInert.push(whileInert)}
        />
      </>,
    ));

    expect(commits[0]).toMatchObject({ inert: true, ariaBusy: "true" });
    expect(focusAttemptsWhileInert).toEqual([false]);
    expect(sectionOf(container).hasAttribute("inert")).toBe(false);
    expect(sectionOf(container).getAttribute("aria-busy")).toBe("false");
    expect(startScreenStore.getSnapshot().host).not.toBeNull();
  });

  it("preserves the active section and selection when loading resolves to no session", async () => {
    const { root, container } = mounted();
    const { kernel, commands } = makeKernel();

    await act(async () => render(root, kernel));
    expect(startScreenStore.getSnapshot().host?.createProblemDisabledReason).toEqual(expect.any(String));

    await act(async () => {
      startScreenStore.setSection("import");
      startScreenStore.setSelectedScript(17);
    });
    expect(sectionOf(container).getAttribute("data-section")).toBe("import");
    expect(container.textContent).toContain("Import");

    const attachedHostBeforeResolution = startScreenStore.getSnapshot().host;
    const refreshCountBeforeResolution = commands.refresh.mock.calls.length;
    mocks.sessionState = "no-session";
    await act(async () => render(root, kernel));

    expect(startScreenStore.getSnapshot().host).toBe(attachedHostBeforeResolution);
    expect(sectionOf(container).getAttribute("data-section")).toBe("import");
    expect(startScreenStore.getSnapshot().selectedScriptId).toBe(17);
    expect(startScreenStore.getSnapshot().host?.createProblemDisabledReason).toBeNull();
    expect(commands.refresh.mock.calls.length).toBeGreaterThan(refreshCountBeforeResolution);
  });

  it("revokes create capability and refreshes commands in the layout commit", async () => {
    const { root, container } = mounted();
    const commits: CommittedStartScreenDom[] = [];
    const { kernel, commands } = makeKernel();
    const observe = () => root.render(
      <>
        {view(kernel)}
        <CommittedDomObserver
          container={container}
          onCommit={(snapshot) => commits.push(snapshot)}
          commandRefreshCount={() => commands.refresh.mock.calls.length}
        />
      </>,
    );
    mocks.sessionState = "no-session";
    await act(async () => observe());
    expect(startScreenStore.getSnapshot().host?.createProblemDisabledReason).toBeNull();

    const previousCommitCount = commits.length;
    const refreshCountBeforeResolution = commands.refresh.mock.calls.length;
    mocks.sessionState = "loading";
    await act(async () => observe());

    const layoutCommit = commits[previousCommitCount];
    expect(layoutCommit?.createProblemDisabledReason).toEqual(expect.any(String));
    expect(layoutCommit?.commandRefreshCount).toBeGreaterThan(refreshCountBeforeResolution);
    expect(startScreenStore.getSnapshot().host?.createProblemDisabledReason).toEqual(expect.any(String));
  });

  it("resets to Home when the mounted StartScreen really unmounts", async () => {
    const { root } = mounted();
    await act(async () => render(root, makeKernel().kernel));
    await act(async () => {
      startScreenStore.setSection("import");
      startScreenStore.setSelectedScript(17);
    });

    await unmount(root);

    expect(startScreenStore.getSnapshot()).toMatchObject({
      host: null,
      section: "home",
      selectedScriptId: null,
    });
  });

  it("keeps the newer mounted owner's section and selection when an older owner unmounts", async () => {
    const first = mounted();
    const second = mounted();
    await act(async () => render(first.root, makeKernel().kernel));
    const firstHost = startScreenStore.getSnapshot().host;
    await act(async () => render(second.root, makeKernel().kernel));
    const currentHost = startScreenStore.getSnapshot().host;

    expect(currentHost).not.toBe(firstHost);
    await act(async () => {
      startScreenStore.setSection("import");
      startScreenStore.setSelectedScript(23);
    });
    await unmount(first.root);

    expect(startScreenStore.getSnapshot().host).toBe(currentHost);
    expect(startScreenStore.getSnapshot().section).toBe("import");
    expect(startScreenStore.getSnapshot().selectedScriptId).toBe(23);
  });

  it("resets the section and selection when the StartScreen kernel owner changes", async () => {
    const { root, container } = mounted();
    const commits: CommittedStartScreenDom[] = [];
    const first = makeKernel();
    let firstHost: StartScreenHost | null = null;
    let probeFirstHost = false;
    let firstHostRejectedAtLayout = false;
    const observe = (kernel: ModuleProps["kernel"]) => root.render(
      <>
        {view(kernel)}
        <CommittedDomObserver
          container={container}
          onCommit={(snapshot) => {
            commits.push(snapshot);
            if (!probeFirstHost || !firstHost) return;
            try {
              firstHost.isEnabled("start.browse", {} as never);
            } catch {
              firstHostRejectedAtLayout = true;
            }
          }}
        />
      </>,
    );
    await act(async () => observe(first.kernel));
    firstHost = startScreenStore.getSnapshot().host;
    expect(firstHost).not.toBeNull();
    await act(async () => {
      startScreenStore.setSection("import");
      startScreenStore.setSelectedScript(17);
    });

    const firstOwnerCommitCount = commits.length;
    probeFirstHost = true;
    await act(async () => observe(makeKernel().kernel));
    const ownerChangeCommits = commits.slice(firstOwnerCommitCount);

    expect(ownerChangeCommits.length).toBeGreaterThan(0);
    expect(ownerChangeCommits.every((commit) => commit.host !== firstHost)).toBe(true);
    expect(firstHostRejectedAtLayout).toBe(true);
    expect(first.commands.isEnabled).not.toHaveBeenCalled();
    expect(startScreenStore.getSnapshot().host).not.toBeNull();
    expect(startScreenStore.getSnapshot().section).toBe("home");
    expect(startScreenStore.getSnapshot().selectedScriptId).toBeNull();
    expect(sectionOf(container).hasAttribute("inert")).toBe(false);
    expect(sectionOf(container).getAttribute("aria-busy")).toBe("false");
  });

  it("invalidates a detached owner's adapter instead of forwarding into the new kernel", async () => {
    const { root } = mounted();
    const first = makeKernel();
    await act(async () => render(root, first.kernel));
    const detachedHost = startScreenStore.getSnapshot().host;

    const second = makeKernel();
    await act(async () => render(root, second.kernel));

    expect(detachedHost).not.toBeNull();
    expect(() => detachedHost!.isEnabled("start.browse", {} as never)).toThrow(
      "The start-screen host is detached.",
    );
    expect(() => detachedHost!.execute("start.browse", {} as never)).toThrow(
      "The start-screen host is detached.",
    );
    expect(first.commands.isEnabled).not.toHaveBeenCalled();
    expect(first.commands.execute).not.toHaveBeenCalled();
    expect(second.commands.isEnabled).not.toHaveBeenCalled();
    expect(second.commands.execute).not.toHaveBeenCalled();
  });

});
