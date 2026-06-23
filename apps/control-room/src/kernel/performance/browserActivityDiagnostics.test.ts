import { describe, expect, it } from "vitest";

import { startBrowserActivityDiagnostics } from "./browserActivityDiagnostics";

interface FakePerformanceEntry {
  attribution?: Array<{
    containerName?: string;
    containerType?: string;
    name?: string;
  }>;
  blockingDuration?: number;
  duration: number;
  entryType: string;
  name: string;
  renderStart?: number;
  scripts?: Array<{
    duration?: number;
    invoker?: string;
    sourceFunctionName?: string;
    sourceURL?: string;
  }>;
  startTime: number;
  styleAndLayoutStart?: number;
}

class FakePerformanceObserver {
  static latest: FakePerformanceObserver | null = null;
  static instances: FakePerformanceObserver[] = [];
  static supportedEntryTypes = ["longtask", "long-animation-frame"];
  private readonly callback: ConstructorParameters<
    typeof FakePerformanceObserver
  >[0];
  observedType: string | null = null;

  constructor(
    callback: (list: {
      getEntries: () => FakePerformanceEntry[];
    }) => void,
  ) {
    this.callback = callback;
    FakePerformanceObserver.latest = this;
    FakePerformanceObserver.instances.push(this);
  }

  disconnect() {}

  emit(entries: FakePerformanceEntry[]) {
    this.callback({ getEntries: () => entries });
  }

  observe(options: { type: string }) {
    this.observedType = options.type;
  }
}

describe("browser activity diagnostics", () => {
  it("records browser long tasks into performance diagnostics", () => {
    const records: unknown[] = [];
    FakePerformanceObserver.instances = [];
    const stop = startBrowserActivityDiagnostics({
      diagnostics: {
        record: (entry) => records.push(entry),
      },
      observerConstructor: FakePerformanceObserver,
      timeOrigin: 1_000,
    });

    const observer = FakePerformanceObserver.instances.find(
      (item) => item.observedType === "longtask",
    );

    observer?.emit([
      {
        attribution: [
          {
            containerName: "workspace",
            containerType: "window",
            name: "script",
          },
        ],
        duration: 72,
        entryType: "longtask",
        name: "self",
        startTime: 25,
      },
      {
        duration: 5,
        entryType: "measure",
        name: "ignored",
        startTime: 30,
      },
    ]);
    stop();

    expect(records).toEqual([
      {
        byteLength: null,
        channel: "performance",
        contentType: null,
        detail:
          "name=self;source=workspace;attribution=script/window/workspace;suppressedSinceLast=0",
        direction: "rx",
        durationMs: 72,
        messageType: "longtask",
        method: "LONGTASK",
        outcome: "ok",
        path: "fullmag.browser.longtask",
        requestId: "browser-longtask",
        status: null,
        timestampMs: 1_025,
      },
    ]);
  });

  it("records long animation frames with the primary script source", () => {
    const records: unknown[] = [];
    FakePerformanceObserver.instances = [];
    const stop = startBrowserActivityDiagnostics({
      diagnostics: {
        record: (entry) => records.push(entry),
      },
      observerConstructor: FakePerformanceObserver,
      timeOrigin: 1_000,
    });
    const observer = FakePerformanceObserver.instances.find(
      (item) => item.observedType === "long-animation-frame",
    );

    observer?.emit([
      {
        blockingDuration: 40,
        duration: 91,
        entryType: "long-animation-frame",
        name: "long-animation-frame",
        renderStart: 18,
        scripts: [
          {
            duration: 31,
            sourceFunctionName: "buildViewport3DTopologyRenderModel",
            sourceURL: "http://localhost:3100/_next/static/chunks/app.js",
          },
        ],
        startTime: 25,
        styleAndLayoutStart: 55,
      },
    ]);
    stop();

    expect(records).toEqual([
      expect.objectContaining({
        detail:
          "source=chunks/app.js#buildViewport3DTopologyRenderModel;scripts=chunks/app.js#buildViewport3DTopologyRenderModel:31.0ms;blockingMs=40.0;renderStartMs=18.0;styleLayoutStartMs=55.0;suppressedSinceLast=0",
        durationMs: 91,
        messageType: "long-animation-frame",
        method: "LOAF",
        path: "fullmag.browser.long-animation-frame",
        timestampMs: 1_025,
      }),
    ]);
  });

  it("samples browser activity to avoid diagnostics feedback loops", () => {
    const records: unknown[] = [];
    FakePerformanceObserver.instances = [];
    const stop = startBrowserActivityDiagnostics({
      diagnostics: {
        record: (entry) => records.push(entry),
      },
      observerConstructor: FakePerformanceObserver,
      timeOrigin: 1_000,
    });
    const observer = FakePerformanceObserver.instances.find(
      (item) => item.observedType === "long-animation-frame",
    );

    observer?.emit([
      {
        duration: 60,
        entryType: "long-animation-frame",
        name: "long-animation-frame",
        startTime: 25,
      },
      {
        duration: 65,
        entryType: "long-animation-frame",
        name: "long-animation-frame",
        startTime: 500,
      },
      {
        duration: 70,
        entryType: "long-animation-frame",
        name: "long-animation-frame",
        startTime: 1_050,
      },
    ]);
    stop();

    expect(records).toEqual([
      expect.objectContaining({
        durationMs: 60,
        path: "fullmag.browser.long-animation-frame",
        timestampMs: 1_025,
      }),
      expect.objectContaining({
        detail: expect.stringContaining("suppressedSinceLast=1"),
        durationMs: 70,
        path: "fullmag.browser.long-animation-frame",
        timestampMs: 2_050,
      }),
    ]);
  });

  it("does not sample out critical browser activity", () => {
    const records: unknown[] = [];
    FakePerformanceObserver.instances = [];
    startBrowserActivityDiagnostics({
      diagnostics: {
        record: (entry) => records.push(entry),
      },
      observerConstructor: FakePerformanceObserver,
      timeOrigin: 1_000,
    });
    const observer = FakePerformanceObserver.instances.find(
      (item) => item.observedType === "long-animation-frame",
    );

    observer?.emit([
      {
        duration: 60,
        entryType: "long-animation-frame",
        name: "long-animation-frame",
        startTime: 25,
      },
      {
        duration: 120,
        entryType: "long-animation-frame",
        name: "long-animation-frame",
        startTime: 500,
      },
    ]);

    expect(records).toEqual([
      expect.objectContaining({ durationMs: 60 }),
      expect.objectContaining({ durationMs: 120 }),
    ]);
  });
});
