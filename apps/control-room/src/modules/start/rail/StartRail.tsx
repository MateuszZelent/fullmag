"use client";

import { GraduationCap, Home, Import, LayoutGrid, type LucideIcon } from "lucide-react";

import { cn } from "@/shared/utils/className";

import { setStartSection } from "../model/startScreenState";
import type { StartSection } from "../model/types";
import { ComputeEnvironmentWidget } from "./ComputeEnvironmentWidget";

const SECTIONS: ReadonlyArray<{
  readonly id: StartSection;
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly shortcut: string;
}> = [
  { id: "home", label: "Home", Icon: Home, shortcut: "Ctrl 1" },
  { id: "templates", label: "Templates", Icon: LayoutGrid, shortcut: "Ctrl 2" },
  { id: "import", label: "Import", Icon: Import, shortcut: "Ctrl 3" },
  { id: "learn", label: "Learn", Icon: GraduationCap, shortcut: "Ctrl 4" },
];

export function StartRail({ section }: { readonly section: StartSection }) {
  return (
    <nav
      aria-label="Start screen sections"
      className="flex min-h-0 flex-col border-r border-fm-subtle bg-fm-chrome px-fm-2 py-fm-3"
    >
      <div className="flex flex-col gap-px">
        {SECTIONS.map(({ id, label, Icon, shortcut }) => {
          const active = id === section;
          return (
            <button
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-[var(--fm-control-height-compact)] w-full items-center gap-fm-2 rounded-fm-md px-fm-2 text-left font-fm-ui text-fm-sm",
                active ? "bg-fm-selected text-fm-start-nav-active" : "text-fm-secondary hover:bg-fm-raised",
              )}
              key={id}
              onClick={() => setStartSection(id)}
              type="button"
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
              <kbd className="ml-auto font-fm-mono text-fm-2xs text-fm-start-meta">{shortcut}</kbd>
            </button>
          );
        })}
      </div>
      <div className="mt-auto pt-fm-3">
        <ComputeEnvironmentWidget />
      </div>
    </nav>
  );
}
