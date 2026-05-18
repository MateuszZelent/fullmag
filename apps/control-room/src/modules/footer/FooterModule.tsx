"use client";

import {
  Activity,
  FileText,
  Gauge,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import type { ModuleProps } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import {
  filterTransportEntries,
  type FooterChannelFilter,
  type FooterDirectionFilter,
} from "./footerModel";
import { TransportLogTable } from "./TransportLogTable";
import { FooterDiagnostics } from "./FooterDiagnostics";
import { FooterTelemetry } from "./FooterTelemetry";

type FooterTabId = "engine" | "logs" | "telemetry";

export default function FooterModule({ kernel }: ModuleProps) {
  const entries = useTransportDiagnostics(kernel);
  const [direction, setDirection] = useState<FooterDirectionFilter>("all");
  const [channel, setChannel] = useState<FooterChannelFilter>("all");
  const [activeTab, setActiveTab] = useState<FooterTabId>("telemetry");

  useEffect(() => {
    return kernel.bus.on("footer:tab-requested", ({ tab }) => {
      setActiveTab(tab);
    });
  }, [kernel.bus]);

  const filteredEntries = useMemo(
    () =>
      filterTransportEntries(entries, {
        channel,
        direction,
      }),
    [channel, direction, entries],
  );
  const rxCount = entries.filter((entry) => entry.direction === "rx").length;
  const txCount = entries.filter((entry) => entry.direction === "tx").length;

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
        <div className="fm-footer__summary" aria-label="Transport summary">
          <span className="fm-footer__summary-item">RX {rxCount}</span>
          <span className="fm-footer__summary-item">TX {txCount}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear transport logs"
            title="Clear transport logs"
            onClick={() => kernel.diagnostics.clear()}
            disabled={entries.length === 0}
          >
            <Trash2 size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <TabsContent value="logs" className="fm-footer__content">
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
        <TransportLogTable entries={filteredEntries} />
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
