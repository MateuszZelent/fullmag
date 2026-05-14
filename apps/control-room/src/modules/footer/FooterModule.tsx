"use client";

import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Gauge,
  Trash2,
} from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";

import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import type { ModuleProps } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import {
  filterTransportEntries,
  formatTransportByteSize,
  formatTransportTimestamp,
  type FooterChannelFilter,
  type FooterDirectionFilter,
  summarizeTransportPath,
} from "./footerModel";

export default function FooterModule({ kernel }: ModuleProps) {
  const entries = useTransportDiagnostics(kernel);
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
  const rxCount = entries.filter((entry) => entry.direction === "rx").length;
  const txCount = entries.filter((entry) => entry.direction === "tx").length;

  return (
    <Tabs defaultValue="logs" className="fm-footer">
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
        <div className="fm-footer__placeholder" role="status">
          Runtime telemetry will use this dock after the transport log stabilizes.
        </div>
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

function TransportLogTable({ entries }: { entries: RequestDiagnosticEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="fm-footer__empty" role="status">
        No transport events captured yet.
      </div>
    );
  }

  return (
    <div className="fm-footer-log" role="table" aria-label="Transport logs">
      <div className="fm-footer-log__row fm-footer-log__row--header" role="row">
        <span role="columnheader">Time</span>
        <span role="columnheader">Dir</span>
        <span role="columnheader">Channel</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Size</span>
        <span role="columnheader">Target</span>
      </div>
      {entries.map((entry) => (
        <div className="fm-footer-log__row" role="row" key={entry.id}>
          <span role="cell">{formatTransportTimestamp(entry.timestampMs)}</span>
          <span role="cell">
            <DirectionBadge entry={entry} />
          </span>
          <span role="cell">{entry.channel.toUpperCase()}</span>
          <span role="cell">{formatStatus(entry)}</span>
          <span role="cell">{formatTransportByteSize(entry.byteLength)}</span>
          <span role="cell" title={summarizeTransportPath(entry)}>
            {summarizeTransportPath(entry)}
          </span>
        </div>
      ))}
    </div>
  );
}

function DirectionBadge({ entry }: { entry: RequestDiagnosticEntry }) {
  const Icon = entry.direction === "rx" ? ArrowDownToLine : ArrowUpFromLine;

  return (
    <span className="fm-footer-log__direction" data-direction={entry.direction}>
      <Icon size={13} aria-hidden="true" />
      {entry.direction.toUpperCase()}
    </span>
  );
}

function formatStatus(entry: RequestDiagnosticEntry): string {
  if (entry.status !== null) {
    return `${entry.status} ${entry.outcome}`;
  }

  return entry.outcome;
}
