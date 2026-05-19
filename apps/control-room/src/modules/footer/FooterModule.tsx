"use client";

import {
  Activity,
  FileText,
  Gauge,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import type { CommandDiagnosticEntry } from "@/kernel/commands/CommandDiagnosticsController";
import type { ModuleProps } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import {
  filterTransportEntries,
  type FooterChannelFilter,
  type FooterDirectionFilter,
} from "./footerModel";
import { CommandAuditTable } from "./CommandAuditTable";
import { FooterDiagnostics } from "./FooterDiagnostics";
import { FooterTelemetry } from "./FooterTelemetry";
import { TransportLogTable } from "./TransportLogTable";

type FooterTabId = "engine" | "logs" | "telemetry";

export default function FooterModule({ kernel }: ModuleProps) {
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
          <span className="fm-footer__summary-item">HTTP + WS</span>
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
        {activeTab === "telemetry" ? <FooterTelemetry /> : null}
      </TabsContent>

      <TabsContent value="engine" className="fm-footer__content">
        {activeTab === "engine" ? <FooterDiagnostics /> : null}
      </TabsContent>
    </Tabs>
  );
}

function FooterLogs({ kernel }: { kernel: ModuleProps["kernel"] }) {
  const entries = useTransportDiagnostics(kernel);
  const commandEntries = useCommandDiagnostics(kernel);
  const [direction, setDirection] = useState<FooterDirectionFilter>("all");
  const [channel, setChannel] = useState<FooterChannelFilter>("all");
  const filteredEntries = useMemo(
    () =>
      filterTransportEntries(entries, {
        channel,
        direction,
      }),
    [channel, direction, entries],
  );

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
          active={channel === "all"}
          onClick={() => setChannel("all")}
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
      </div>
      <div className="fm-footer__log-content">
        <CommandAuditTable entries={commandEntries} />
        <TransportLogTable entries={filteredEntries} />
      </div>
    </>
  );
}

function useTransportDiagnostics(kernel: ModuleProps["kernel"]): RequestDiagnosticEntry[] {
  const version = useSyncExternalStore(
    kernel.diagnostics.subscribe.bind(kernel.diagnostics),
    kernel.diagnostics.getVersion.bind(kernel.diagnostics),
    () => 0,
  );

  return useMemo(() => {
    void version;
    return kernel.diagnostics.list().slice().reverse();
  }, [kernel.diagnostics, version]);
}

function useCommandDiagnostics(kernel: ModuleProps["kernel"]): CommandDiagnosticEntry[] {
  const version = useSyncExternalStore(
    kernel.commandDiagnostics.subscribe.bind(kernel.commandDiagnostics),
    kernel.commandDiagnostics.getVersion.bind(kernel.commandDiagnostics),
    () => 0,
  );

  return useMemo(() => {
    void version;
    return kernel.commandDiagnostics.list().slice().reverse();
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
      onClick={onClick}
    >
      {children}
    </button>
  );
}
