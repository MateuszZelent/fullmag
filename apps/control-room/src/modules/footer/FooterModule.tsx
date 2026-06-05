"use client";

import {
  Activity,
  Clipboard,
  ClipboardCheck,
  FileText,
  Gauge,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import type { CommandDiagnosticEntry } from "@/kernel/commands/CommandDiagnosticsController";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import type { ModuleProps } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import {
  filterTransportEntries,
  type FooterChannelFilter,
  type FooterDirectionFilter,
  serializeTransportEntry,
} from "./footerModel";
import { CommandAuditTable } from "./CommandAuditTable";
import { FooterDiagnostics } from "./FooterDiagnostics";
import { FooterTelemetry } from "./FooterTelemetry";
import { TransportLogTable } from "./TransportLogTable";

type FooterTabId = "engine" | "logs" | "telemetry";

const EMPTY_DIAGNOSTIC_ENTRIES: RequestDiagnosticEntry[] = [];

interface FooterDiagnosticsSnapshot {
  entries: RequestDiagnosticEntry[];
  signature: string;
}

export default function FooterModule(props: ModuleProps) {
  return (
    <WorkspaceRenderProfiler id="FooterModule">
      <FooterModuleContent {...props} />
    </WorkspaceRenderProfiler>
  );
}

function FooterModuleContent({ kernel }: ModuleProps) {
  const [activeTab, setActiveTab] = useState<FooterTabId>("telemetry");

  useEffect(() => {
    return kernel.bus.on("footer:tab-requested", ({ tab }) => {
      setActiveTab(tab);
    });
  }, [kernel.bus]);

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as FooterTabId)}
      className="fm-footer"
    >
      <div className="fm-footer__bar">
        <TabsList className="fm-footer__tabs" aria-label="Bottom diagnostics">
          <TabsTrigger value="logs" className="fm-footer__tab">
            <Activity size={14} aria-hidden="true" />
            Logs
          </TabsTrigger>
          <TabsTrigger value="telemetry" className="fm-footer__tab">
            <Gauge size={14} aria-hidden="true" />
            Telemetry
          </TabsTrigger>
          <TabsTrigger value="engine" className="fm-footer__tab">
            <FileText size={14} aria-hidden="true" />
            Engine
          </TabsTrigger>
        </TabsList>
        <div className="fm-footer__summary" aria-label="Footer log summary">
          <span className="fm-footer__summary-item">HTTP + WS + Perf</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear footer logs"
            title="Clear footer logs"
            onClick={() => {
              kernel.commandDiagnostics.clear();
              kernel.diagnostics.clear();
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <TabsContent value="logs" className="fm-footer__content">
        {activeTab === "logs" ? <FooterLogs kernel={kernel} /> : null}
      </TabsContent>

      <TabsContent value="telemetry" className="fm-footer__content">
        {activeTab === "telemetry" ? (
          <FooterTelemetry bus={kernel.bus} />
        ) : null}
      </TabsContent>

      <TabsContent value="engine" className="fm-footer__content">
        {activeTab === "engine" ? <FooterDiagnostics /> : null}
      </TabsContent>
    </Tabs>
  );
}

function FooterLogs({ kernel }: { kernel: ModuleProps["kernel"] }) {
  const [direction, setDirection] = useState<FooterDirectionFilter>("all");
  const [channel, setChannel] = useState<FooterChannelFilter>("transport");
  const filteredEntries = useTransportDiagnostics(kernel, {
    channel,
    direction,
  });
  const commandEntries = useCommandDiagnostics(kernel);
  const [copied, setCopied] = useState(false);

  function handleCopyLog() {
    const text = filteredEntries.map(serializeTransportEntry).join("\n\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(console.error);
  }

  return (
    <>
      <div className="fm-footer__filters" aria-label="Log filters">
        <FilterButton
          active={direction === "all"}
          onClick={() => setDirection("all")}
        >
          All
        </FilterButton>
        <FilterButton
          active={direction === "rx"}
          onClick={() => setDirection("rx")}
        >
          RX
        </FilterButton>
        <FilterButton
          active={direction === "tx"}
          onClick={() => setDirection("tx")}
        >
          TX
        </FilterButton>
        <span className="fm-footer__filter-sep" aria-hidden="true" />
        <FilterButton
          active={channel === "transport"}
          onClick={() => setChannel("transport")}
        >
          HTTP + WS
        </FilterButton>
        <FilterButton
          active={channel === "http"}
          onClick={() => setChannel("http")}
        >
          HTTP
        </FilterButton>
        <FilterButton
          active={channel === "websocket"}
          onClick={() => setChannel("websocket")}
        >
          WS
        </FilterButton>
        <FilterButton
          active={channel === "performance"}
          onClick={() => setChannel("performance")}
        >
          Perf
        </FilterButton>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          style={{ marginLeft: "auto" }}
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
      <div className="fm-footer__log-content">
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
  const snapshotRef = useRef<FooterDiagnosticsSnapshot | null>(null);
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      kernel.diagnostics.subscribe(onStoreChange),
    [kernel.diagnostics],
  );
  const getSnapshot = useCallback(() => {
    const entries = filterTransportEntries(
      kernel.diagnostics.listNewestFirst(),
      { channel, direction },
    );
    const signature = transportEntriesSignature(entries);
    const previous = snapshotRef.current;
    if (previous?.signature === signature) {
      return previous.entries;
    }

    snapshotRef.current = { entries, signature };
    return entries;
  }, [channel, direction, kernel.diagnostics]);

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_DIAGNOSTIC_ENTRIES,
  );
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

function transportEntriesSignature(
  entries: readonly RequestDiagnosticEntry[],
): string {
  return entries.map((entry) => entry.id).join("|");
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
      onClick={onClick}
    >
      {children}
    </button>
  );
}
