"use client";

import { ChevronDown, Copy, ExternalLink, FolderClosed, MoreHorizontal, Star } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";

import { formatOpened } from "../model/recentIndex";
import { copyText, formatDuration } from "../model/scriptRowModel";
import type { ProjectStatus } from "../model/types";
import { StatusPill } from "../ui/StatusPill";

/* ── Header ─────────────────────────────────────────────────────────────── */

export interface MenuAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
  /** When set the item is disabled and the reason is its tooltip. */
  readonly disabledReason?: string | null;
  /** A divider is drawn above the item (destructive actions go last). */
  readonly separatorBefore?: boolean;
}

function ActionItems({ actions }: { readonly actions: readonly MenuAction[] }) {
  return (
    <>
      {actions.map((action) => (
        <Fragment key={action.id}>
          {action.separatorBefore ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem
            data-action={action.id}
            disabled={Boolean(action.disabledReason)}
            onSelect={() => action.onSelect()}
            title={action.disabledReason ?? undefined}
          >
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        </Fragment>
      ))}
    </>
  );
}

export interface InspectorHeaderProps {
  readonly name: string;
  readonly path: string;
  readonly pinned: boolean;
  /** Why pinning is unavailable (a read-only database); null when it works. */
  readonly pinDisabledReason?: string | null;
  readonly onTogglePin: () => void;
  readonly moreActions: readonly MenuAction[];
  readonly chips: ReactNode;
  /** Reports a clipboard failure to the caller's notice area. */
  readonly onCopyFailed?: () => void;
}

/** Title with its star and more-menu, the path with a copy button, then the chips. */
export function InspectorHeader({
  name,
  path,
  pinned,
  pinDisabledReason = null,
  onTogglePin,
  moreActions,
  chips,
  onCopyFailed,
}: InspectorHeaderProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copyPath = async () => {
    if (!(await copyText(path))) {
      onCopyFailed?.();
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <header className="fm-start-inspector__head">
      <div className="fm-start-inspector__title-row">
        <h2 className="fm-start-inspector__name">{name}</h2>
        <Button
          aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
          aria-pressed={pinned}
          disabled={Boolean(pinDisabledReason)}
          onClick={onTogglePin}
          size="icon"
          title={pinDisabledReason ?? undefined}
          type="button"
          variant="ghost"
        >
          <Star aria-hidden="true" fill={pinned ? "currentColor" : "none"} size={14} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label="More actions" size="icon" title="More actions" type="button" variant="ghost">
              <MoreHorizontal aria-hidden="true" size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <ActionItems actions={moreActions} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="fm-start-inspector__path">
        <FolderClosed aria-hidden="true" size={12} />
        <span title={path}>{path}</span>
        <Button
          aria-label={copied ? "Path copied" : "Copy path"}
          onClick={() => void copyPath()}
          size="icon"
          title="Copy path"
          type="button"
          variant="ghost"
        >
          <Copy aria-hidden="true" size={12} />
        </Button>
      </div>
      <div className="fm-start-chips">{chips}</div>
    </header>
  );
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */

export interface InspectorTabDef<T extends string> {
  readonly id: T;
  readonly label: string;
}

export interface InspectorTabsProps<T extends string> {
  readonly tabs: readonly InspectorTabDef<T>[];
  readonly value: T;
  readonly onChange: (tab: T) => void;
  readonly label: string;
  readonly baseId: string;
}

export const inspectorTabId = (baseId: string, tab: string) => `${baseId}-tab-${tab}`;
export const inspectorPanelId = (baseId: string) => `${baseId}-panel`;

/** A WAI-ARIA tablist: arrows, Home and End move between tabs; only the selected one is a tab stop. */
export function InspectorTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  baseId,
}: InspectorTabsProps<T>) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    document.getElementById(inspectorTabId(baseId, target.id))?.focus();
  };

  return (
    <div aria-label={label} className="fm-start-tabs" role="tablist">
      {tabs.map((item, index) => (
        <button
          aria-controls={inspectorPanelId(baseId)}
          aria-selected={value === item.id}
          className="fm-start-tab"
          id={inspectorTabId(baseId, item.id)}
          key={item.id}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
          role="tab"
          tabIndex={value === item.id ? 0 : -1}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** The tab panel wrapper, labelled by the active tab. */
export function InspectorPanel({
  baseId,
  tab,
  children,
}: {
  readonly baseId: string;
  readonly tab: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      aria-labelledby={inspectorTabId(baseId, tab)}
      className="fm-start-inspector__body"
      id={inspectorPanelId(baseId)}
      role="tabpanel"
    >
      {children}
    </div>
  );
}

/* ── Action bar ─────────────────────────────────────────────────────────── */

export interface ActionBarProps {
  readonly primaryLabel: string;
  readonly primaryDisabledReason?: string | null;
  readonly onPrimary: () => void;
  readonly primaryAction: string;
  /** Items of the dropdown beside the primary button; hidden when empty. */
  readonly splitActions: readonly MenuAction[];
  readonly externalLabel: string;
  readonly externalDisabledReason?: string | null;
  readonly onExternal: () => void;
  readonly children?: ReactNode;
}

/**
 * The bottom bar of the sketch: the primary action, a dropdown of the other
 * ways to open the item, and an open-externally icon button.
 */
export function InspectorActionBar({
  primaryLabel,
  primaryDisabledReason = null,
  onPrimary,
  primaryAction,
  splitActions,
  externalLabel,
  externalDisabledReason = null,
  onExternal,
  children,
}: ActionBarProps) {
  return (
    <footer className="fm-start-inspector__foot fm-start-actionbar">
      {children ? <div className="fm-start-actionbar__extra">{children}</div> : null}
      <div className="fm-start-actionbar__bar">
        <div className="fm-start-btn-group">
          <Button
            className="fm-start-inspector__open"
            data-action={primaryAction}
            disabled={Boolean(primaryDisabledReason)}
            onClick={onPrimary}
            title={primaryDisabledReason ?? undefined}
            type="button"
            variant="primary"
          >
            {primaryLabel}
          </Button>
          {splitActions.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="More open options"
                  className="fm-start-btn-group__split"
                  title="More open options (Alt+Down)"
                  type="button"
                  variant="primary"
                >
                  <ChevronDown aria-hidden="true" size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <ActionItems actions={splitActions} />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <Button
          aria-label={externalLabel}
          disabled={Boolean(externalDisabledReason)}
          onClick={onExternal}
          size="icon"
          title={externalDisabledReason ?? externalLabel}
          type="button"
          variant="secondary"
        >
          <ExternalLink aria-hidden="true" size={14} />
        </Button>
      </div>
    </footer>
  );
}

/* ── Runs table ─────────────────────────────────────────────────────────── */

export interface RunRow {
  readonly key: string;
  /** The text of the first cell: the run id or the folder's name. */
  readonly label: string;
  readonly status: ProjectStatus;
  readonly statusWord: string;
  readonly title?: string;
  readonly startedAt?: string;
  readonly durationSeconds?: number;
  readonly outputBytes?: number;
  /** Makes the first cell a button (a result folder selects itself). */
  readonly onSelect?: () => void;
}

/** Run | Started | Duration | Output, as in the sketch. A missing value is a dash. */
export function RunsTable({
  rows,
  caption = "Runs",
  formatOutput,
}: {
  readonly rows: readonly RunRow[];
  readonly caption?: string;
  readonly formatOutput: (bytes: number | undefined) => string;
}) {
  return (
    <table className="fm-start-formats fm-start-runs">
      <caption className="fm-start-visually-hidden">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Started</th>
          <th scope="col">Duration</th>
          <th scope="col">Output</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} title={row.title}>
            <th scope="row">
              {row.onSelect ? (
                <button
                  className="fm-start-runs__link"
                  onClick={row.onSelect}
                  title={`Show ${row.label}`}
                  type="button"
                >
                  <StatusPill label={row.label} status={row.status} title={row.statusWord} />
                </button>
              ) : (
                <StatusPill label={row.label} status={row.status} title={row.statusWord} />
              )}
            </th>
            <td>{row.startedAt ? formatOpened(row.startedAt) : "—"}</td>
            <td>{formatDuration(row.durationSeconds) ?? "—"}</td>
            <td>{formatOutput(row.outputBytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
