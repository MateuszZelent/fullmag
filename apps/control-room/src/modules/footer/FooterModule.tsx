"use client";

import { createPortal } from "react-dom";

import { PanelChrome } from "@/shared/ui/PanelFrame";
import {
  Activity,
  CircleAlert,
  Clipboard,
  ClipboardCheck,
  Cpu,
  FileText,
  Gauge,
  ListChecks,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import type { CommandDiagnosticEntry } from "@/kernel/commands/CommandDiagnosticsController";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import { useLayoutSelector } from "@/kernel/layout/useLayout";
import { useStageExecutionResource } from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import type { ModuleProps } from "@/kernel/types";
import { QuickChartResourceView } from "@/shared/analysis-charts/QuickChartResourceView";
import { copyTextToClipboard } from "@/shared/browser/copyTextToClipboard";
import { Button } from "@/shared/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import {
  filterTransportEntries,
  type FooterChannelFilter,
  type FooterDirectionFilter,
  serializeTransportEntry,
} from "./footerModel";
import {
  setFooterChannelFilter,
  setFooterDirectionFilter,
  useFooterUiState,
} from "./footerUiStore";
import { CommandAuditTable } from "./CommandAuditTable";
import { FooterDiagnostics } from "./FooterDiagnostics";
import { FooterTelemetry } from "./FooterTelemetry";
import { footerTelemetryStatusEquals, resolveFooterAntennaStage, selectFooterTelemetryStatus } from "./FooterTelemetry.model";
import { DiagnosticRecorderFooterPanel } from "./DiagnosticRecorderFooterPanel";
import { ProblemsPanel } from "./OperationsProblemsPanel";
import { RunProgressPanel } from "./RunProgressPanel";
import { TransportLogTable } from "./TransportLogTable";

const FOOTER_PANEL_CLASS_NAME =
  "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [&>*]:h-full [&>*]:min-h-0 [&>*]:min-w-0 [&>*]:flex-1";
const FOOTER_CONTENT_CLASS_NAME =
  "fm-footer__content flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden";

const telemetryNavigation = (
  <TabsList aria-label="Telemetry views" className="fm-footer-telemetry-tabs__list" presentation="segmented">
    <TabsTrigger value="overview">Overview</TabsTrigger>
    <TabsTrigger value="antenna">Antenna</TabsTrigger>
  </TabsList>
);

export default function FooterModule(props: ModuleProps) {
  return (
    <WorkspaceRenderProfiler id="FooterModule">
      <FooterModuleContent {...props} />
    </WorkspaceRenderProfiler>
  );
}

function FooterModuleContent({ kernel }: ModuleProps) {
  const activeTab = useLayoutSelector((layout) => layout.activeBottomPanelTab);
  const tabList = useRef<HTMLDivElement>(null);
  const [telemetryNavigationHost, setTelemetryNavigationHost] = useState<HTMLDivElement | null>(null);
  const [telemetryStatusHost, setTelemetryStatusHost] = useState<HTMLDivElement | null>(null);
  const status = useSessionStatusSelector(selectFooterTelemetryStatus, {
    isEqual: footerTelemetryStatusEquals,
  });
  // The footer owns one execution subscription even when another dock tab is active.
  const stageExecution = useStageExecutionResource({ enabled: Boolean(status) });
  const antennaStage = resolveFooterAntennaStage(status, stageExecution.data);
  const sessionKey = status
    ? JSON.stringify([status.sessionId, status.sessionEpoch, status.requestScopeEpoch])
    : null;
  const [telemetrySelection, setTelemetrySelection] = useState<{
    sessionKey: string | null; tab: "overview" | "antenna";
  }>({ sessionKey: null, tab: "overview" });
  const telemetryTab = telemetrySelection.sessionKey === sessionKey ? telemetrySelection.tab : "overview";
  const navigation = useRef<{ sessionKey: string | null; seen: Set<string> }>({
    sessionKey: null, seen: new Set(),
  });
  const runningAntennaIdentity = antennaStage?.active ? antennaStage.identityKey : null;

  useEffect(() => {
    if (navigation.current.sessionKey !== sessionKey) {
      navigation.current = { sessionKey, seen: new Set() };
    }
    if (!runningAntennaIdentity || navigation.current.seen.has(runningAntennaIdentity)) return;
    navigation.current.seen.add(runningAntennaIdentity);
    setTelemetrySelection({ sessionKey, tab: "antenna" });
    kernel.layout.openBottomPanel("telemetry");
  }, [kernel.layout, runningAntennaIdentity, sessionKey]);

  useEffect(() => {
    return kernel.bus.subscribe("footer:tab-requested", ({ tab }) => {
      kernel.layout.setBottomPanelTab(tab);
    });
  }, [kernel.bus, kernel.layout]);

  useEffect(() => {
    const selected = tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (selected && tabList.current) revealFooterTab(tabList.current, selected);
  }, [activeTab]);

  return (
    <Tabs
      value={activeTab}
      activationMode="manual"
      onValueChange={(value) =>
        kernel.layout.setBottomPanelTab(
          value as typeof activeTab,
        )
      }
      className="fm-footer"
    >
      <PanelChrome className="fm-footer__bar">
        <TabsList
          ref={tabList}
          className="fm-footer__tabs"
          aria-label="Bottom diagnostics"
          onFocus={(event) => {
            if (event.target instanceof HTMLElement && event.target.getAttribute("role") === "tab") {
              revealFooterTab(event.currentTarget, event.target);
            }
          }}
        >
          <TabsTrigger value="logs" className="fm-footer__tab" title="Command history and HTTP / WebSocket traffic">
            <Activity size={14} aria-hidden="true" />
            Logs
          </TabsTrigger>
          <TabsTrigger value="telemetry" className="fm-footer__tab" title="Live simulation metrics and antenna progress">
            <Gauge size={14} aria-hidden="true" />
            Telemetry
          </TabsTrigger>
          <TabsTrigger value="diagnostics" className="fm-footer__tab" title="Performance recorder and diagnostic export">
            <Cpu size={14} aria-hidden="true" />
            Diagnostics
          </TabsTrigger>
          <TabsTrigger value="engine" className="fm-footer__tab" title="Runtime logs, solver profile and hardware">
            <FileText size={14} aria-hidden="true" />
            Engine
          </TabsTrigger>
          <TabsTrigger value="operations" className="fm-footer__tab" title="Simulation progress: steps, timings, commands and errors">
            <ListChecks size={14} aria-hidden="true" />
            Operations
          </TabsTrigger>
          <TabsTrigger value="problems" className="fm-footer__tab" title="Errors, warnings and preparation issues">
            <CircleAlert size={14} aria-hidden="true" />
            Problems
          </TabsTrigger>
          <TabsTrigger value="quick-chart" className="fm-footer__tab" title="Pinned scientific chart">
            <Activity size={14} aria-hidden="true" />
            Quick Chart
          </TabsTrigger>
        </TabsList>
        <div className="fm-footer__telemetry-header" hidden={activeTab !== "telemetry"}>
          <div className="fm-footer__telemetry-status" ref={setTelemetryStatusHost} />
          <div className="fm-footer__telemetry-navigation" ref={setTelemetryNavigationHost} />
        </div>
      </PanelChrome>

      <TabsContent value="logs" className={FOOTER_CONTENT_CLASS_NAME}>
        {activeTab === "logs" ? <FooterLogs kernel={kernel} /> : null}
      </TabsContent>

      <TabsContent value="telemetry" className={FOOTER_CONTENT_CLASS_NAME}>
        {activeTab === "telemetry" ? (
          <Tabs
            value={telemetryTab}
            onValueChange={(value) => {
              if (value === "overview" || value === "antenna") {
                setTelemetrySelection({ sessionKey, tab: value });
              }
            }}
            className="fm-footer-telemetry-tabs"
          >
            {telemetryNavigationHost
              ? createPortal(telemetryNavigation, telemetryNavigationHost)
              : telemetryNavigation}
            <TabsContent value={telemetryTab} className="fm-footer-telemetry-tabs__content">
              <FooterTelemetry
                bus={kernel.bus}
                status={status}
                stageExecution={stageExecution}
                statusHost={telemetryStatusHost}
                view={telemetryTab}
              />
            </TabsContent>
          </Tabs>
        ) : null}
      </TabsContent>

      <TabsContent value="diagnostics" className={FOOTER_CONTENT_CLASS_NAME}>
        {activeTab === "diagnostics" ? (
          <div className={FOOTER_PANEL_CLASS_NAME}>
            <DiagnosticRecorderFooterPanel kernel={kernel} />
          </div>
        ) : null}
      </TabsContent>

      <TabsContent value="engine" className={FOOTER_CONTENT_CLASS_NAME}>
        {activeTab === "engine" ? (
          <div className={FOOTER_PANEL_CLASS_NAME}>
            <FooterDiagnostics />
          </div>
        ) : null}
      </TabsContent>

      <TabsContent value="operations" className={FOOTER_CONTENT_CLASS_NAME}>
        {activeTab === "operations" ? (
          <div className={FOOTER_PANEL_CLASS_NAME}>
            <RunProgressPanel
              sessionSolverState={status?.solver.state ?? null}
              stageExecution={stageExecution}
            />
          </div>
        ) : null}
      </TabsContent>

      <TabsContent value="problems" className={FOOTER_CONTENT_CLASS_NAME}>
        {activeTab === "problems" ? (
          <div
            className={`${FOOTER_PANEL_CLASS_NAME} [&>.fm-footer-mesh-jobs]:overflow-auto`}
          >
            <ProblemsPanel />
          </div>
        ) : null}
      </TabsContent>

      <TabsContent value="quick-chart" className={FOOTER_CONTENT_CLASS_NAME}>
        {activeTab === "quick-chart" ? (
          <div className="fm-footer__chart-panel">
            <QuickChartResourceView />
          </div>
        ) : null}
      </TabsContent>
    </Tabs>
  );
}

// Scroll only this dock's tab strip. This also supports browsers without
// scrollIntoView's container option, which would move ancestor panels or the page.
function revealFooterTab(list: HTMLElement, tab: HTMLElement) {
  const bounds = list.getBoundingClientRect();
  const target = tab.getBoundingClientRect();
  if (target.left < bounds.left) list.scrollLeft += target.left - bounds.left;
  else if (target.right > bounds.right) list.scrollLeft += target.right - bounds.right;
}

function FooterLogs({ kernel }: { kernel: ModuleProps["kernel"] }) {
  const { direction, channel } = useFooterUiState();
  const filteredEntries = useTransportDiagnostics(kernel, {
    channel,
    direction,
  });
  const commandEntries = useCommandDiagnostics(kernel);
  const [copied, setCopied] = useState(false);

  function handleCopyLog() {
    const text = filteredEntries.map(serializeTransportEntry).join("\n\n");
    copyTextToClipboard(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(console.error);
  }

  return (
    <>
      <div role="group" className="fm-footer__filters shrink-0" aria-label="Log filters">
        <span className="fm-footer__filter-label">Direction</span>
        <FilterButton
          active={direction === "all"}
          onClick={() => setFooterDirectionFilter("all")}
        >
          All
        </FilterButton>
        <FilterButton
          active={direction === "rx"}
          onClick={() => setFooterDirectionFilter("rx")}
        >
          Received
        </FilterButton>
        <FilterButton
          active={direction === "tx"}
          onClick={() => setFooterDirectionFilter("tx")}
        >
          Sent
        </FilterButton>
        <span className="fm-footer__filter-sep" aria-hidden="true" />
        <span className="fm-footer__filter-label">Channel</span>
        <FilterButton
          active={channel === "transport"}
          onClick={() => setFooterChannelFilter("transport")}
        >
          HTTP + WS
        </FilterButton>
        <FilterButton
          active={channel === "http"}
          onClick={() => setFooterChannelFilter("http")}
        >
          HTTP
        </FilterButton>
        <FilterButton
          active={channel === "websocket"}
          onClick={() => setFooterChannelFilter("websocket")}
        >
          WebSocket
        </FilterButton>
        <FilterButton
          active={channel === "performance"}
          onClick={() => setFooterChannelFilter("performance")}
        >
          Performance
        </FilterButton>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="fm-footer__clear"
          aria-label="Clear command and transport logs"
          title="Clear command and transport logs"
          onClick={() => {
            kernel.commandDiagnostics.clear();
            kernel.diagnostics.clear();
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
          Clear
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="fm-ml-auto"
          aria-label="Copy log to clipboard"
          title={`Copy ${filteredEntries.length} log entries to clipboard`}
          onClick={handleCopyLog}
        >
          {copied ? (
            <ClipboardCheck size={14} aria-hidden="true" />
          ) : (
            <Clipboard size={14} aria-hidden="true" />
          )}
        </Button>
      </div>
      <div className="fm-footer__log-content flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <CommandAuditTable entries={commandEntries} />
        <TransportLogTable entries={filteredEntries} />
      </div>
    </>
  );
}

function useTransportDiagnostics(
  kernel: ModuleProps["kernel"],
  filters: {
    channel: FooterChannelFilter;
    direction: FooterDirectionFilter;
  },
): RequestDiagnosticEntry[] {
  const { channel, direction } = filters;
  const version = useSyncExternalStore(
    kernel.diagnostics.subscribe.bind(kernel.diagnostics),
    kernel.diagnostics.getVersion.bind(kernel.diagnostics),
    () => 0,
  );
  return useMemo(() => {
    void version;
    return filterTransportEntries(
      kernel.diagnostics.listNewestFirst(),
      { channel, direction },
    );
  }, [channel, direction, kernel.diagnostics, version]);
}

function useCommandDiagnostics(kernel: ModuleProps["kernel"]): CommandDiagnosticEntry[] {
  const version = useSyncExternalStore(
    kernel.commandDiagnostics.subscribe.bind(kernel.commandDiagnostics),
    kernel.commandDiagnostics.getVersion.bind(kernel.commandDiagnostics),
    () => 0,
  );

  return useMemo(() => {
    void version;
    return kernel.commandDiagnostics.listNewestFirst();
  }, [kernel.commandDiagnostics, version]);
}

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="fm-footer__filter"
      data-active={active}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
