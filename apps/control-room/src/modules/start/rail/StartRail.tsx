"use client";

import {
  BookOpen,
  GraduationCap,
  House,
  Import,
  Info,
  LayoutGrid,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { useRef, type KeyboardEvent, type Ref } from "react";

import type { StartSection } from "../model/startScreenState";
import type { ComputeProbeState } from "../model/types";

import { STUDY_TEMPLATES } from "../model/templates";

import { ComputeEnvironmentWidget } from "./ComputeEnvironmentWidget";

interface RailEntry {
  readonly commandId: string;
  readonly icon: LucideIcon;
  readonly id: StartSection;
  readonly keys?: string;
  readonly label: string;
  readonly shortcut?: string;
  /** A count shown beside the label, e.g. how many templates ship. */
  readonly count?: number;
}

export const RAIL_SECTIONS: readonly RailEntry[] = [
  { commandId: "start.section.home", icon: House, id: "home", keys: "Control+1", label: "Home", shortcut: "Ctrl 1" },
  { commandId: "start.section.templates", icon: LayoutGrid, id: "templates", keys: "Control+2", label: "Templates", shortcut: "Ctrl 2", count: STUDY_TEMPLATES.length },
  { commandId: "start.section.import", icon: Import, id: "import", keys: "Control+3", label: "Import", shortcut: "Ctrl 3" },
  { commandId: "start.section.learn", icon: GraduationCap, id: "learn", keys: "Control+4", label: "Learn", shortcut: "Ctrl 4" },
  { commandId: "start.section.docs", icon: BookOpen, id: "docs", label: "Docs", shortcut: "F1" },
  { commandId: "start.section.settings", icon: Settings, id: "settings", keys: "Control+,", label: "Settings", shortcut: "Ctrl ," },
  { commandId: "start.section.about", icon: Info, id: "about", label: "About" },
];

export interface StartRailProps {
  readonly compute: ComputeProbeState;
  readonly refreshing?: boolean;
  readonly stale?: boolean;
  readonly computeError?: string | null;
  readonly onRefreshCompute?: () => void;
  readonly onRunCommand: (commandId: string) => void;
  readonly ref?: Ref<HTMLDivElement>;
  readonly section: StartSection;
}

export function StartRail({
  compute,
  refreshing = false,
  stale = false,
  computeError = null,
  onRefreshCompute,
  onRunCommand,
  ref,
  section,
}: StartRailProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // One tab stop for the whole rail: arrows move focus, Enter or click navigates.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = RAIL_SECTIONS.length - 1;
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % RAIL_SECTIONS.length
        : event.key === "ArrowUp"
          ? (index + last) % RAIL_SECTIONS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    itemRefs.current[next]?.focus();
  };

  return (
    <div className="fm-start__rail" ref={ref}>
      <nav aria-label="Start screen sections">
        <ul className="fm-start-rail__nav">
          {RAIL_SECTIONS.map((entry, index) => {
            const Icon = entry.icon;
            const active = entry.id === section;
            return (
              <li key={entry.id}>
                <button
                  aria-current={active ? "page" : undefined}
                  aria-keyshortcuts={entry.keys}
                  className="fm-start-rail__item"
                  data-section={entry.id}
                  onClick={() => onRunCommand(entry.commandId)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  tabIndex={active ? 0 : -1}
                  type="button"
                >
                  <Icon aria-hidden="true" size={16} />
                  <span>{entry.label}</span>
                  {entry.count !== undefined ? (
                    <span aria-label={`${entry.count} available`} className="fm-start-rail__count">
                      {entry.count}
                    </span>
                  ) : null}
                  {entry.shortcut ? <kbd className="fm-start-kbd">{entry.shortcut}</kbd> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div aria-hidden="true" className="fm-start-rail__sep" />
      <ComputeEnvironmentWidget
        compute={compute}
        error={computeError}
        onConfigure={() => onRunCommand("start.section.settings")}
        onRefresh={onRefreshCompute}
        refreshing={refreshing}
        stale={stale}
      />
    </div>
  );
}
