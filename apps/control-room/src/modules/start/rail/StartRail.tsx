"use client";

import { useRef, type KeyboardEvent, type Ref } from "react";

import type { StartSection } from "../model/startScreenState";

import { RAIL_SECTIONS } from "./StartRail.model";

export interface StartRailProps {
  readonly onRunCommand: (commandId: string) => void;
  readonly ref?: Ref<HTMLDivElement>;
  readonly section: StartSection;
}

export function StartRail({
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
                  aria-label={entry.label}
                  aria-keyshortcuts={entry.keys}
                  className="fm-start-rail__item"
                  data-section={entry.id}
                  onClick={() => onRunCommand(entry.commandId)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  tabIndex={active ? 0 : -1}
                  title={entry.label}
                  type="button"
                >
                  <Icon aria-hidden="true" size={16} />
                  <span>{entry.label}</span>
                  {entry.count !== undefined ? (
                    <span role="group" aria-label={`${entry.count} available`} className="fm-start-rail__count">
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
    </div>
  );
}
