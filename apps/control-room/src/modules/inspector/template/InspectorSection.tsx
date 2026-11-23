"use client";

import { Check, ChevronRight, Copy, Info } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/Collapsible";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/Tooltip";
import { cn } from "@/shared/utils/className";

import { PropertyRow } from "./PropertyRow";
import type {
  InspectorActionContext,
  InspectorRowSpec,
  InspectorSectionSpec,
  InspectorSpec,
} from "./types";

const keylessRowIds = new WeakMap<object, string>();
let nextKeylessRowSeq = 0;

function resolveStableRowKey<TDraft>(
  sectionId: string,
  row: InspectorRowSpec<TDraft>,
): string {
  if (row.key) return row.key;
  if (row.label) return `${sectionId}:${row.type}:${row.label}`;
  let assigned = keylessRowIds.get(row);
  if (!assigned) {
    nextKeylessRowSeq += 1;
    assigned = `${sectionId}:${row.type}:anon-${nextKeylessRowSeq}`;
    keylessRowIds.set(row, assigned);
  }
  return assigned;
}

export function rowMatchesSearchQuery<TDraft>(
  row: InspectorRowSpec<TDraft>,
  sectionTitle: string,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  if (sectionTitle.toLowerCase().includes(normalizedQuery)) return true;
  if (row.label && row.label.toLowerCase().includes(normalizedQuery)) return true;
  if (row.key && row.key.toLowerCase().includes(normalizedQuery)) return true;
  if (row.hint && row.hint.toLowerCase().includes(normalizedQuery)) return true;
  if (row.symbolInfo?.name.toLowerCase().includes(normalizedQuery)) return true;
  if (typeof row.symbol === "string" && row.symbol.toLowerCase().includes(normalizedQuery)) {
    return true;
  }
  return false;
}

export interface InspectorSectionProps<TDraft> {
  spec: InspectorSpec<TDraft>;
  section: InspectorSectionSpec<TDraft>;
  ctx: InspectorActionContext<TDraft>;
  open: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  filterQuery?: string;
  displayUnits?: Readonly<Record<string, string>>;
  onDisplayUnitChange?: (fieldKey: string, unit: string) => void;
  dirtyFields: ReadonlySet<string>;
  touchedFields: ReadonlySet<string>;
  invalidFields: ReadonlyMap<string, string>;
  forceShowErrors?: boolean;
  onTouchField?: (fieldKey: string) => void;
  onParseErrorChange?: (fieldKey: string, error: string | null) => void;
  flashFieldKey?: string | null;
  flashKind?: "applied" | "live" | "focus";
}

export function InspectorSection<TDraft>({
  spec,
  section,
  ctx,
  open,
  onOpenChange,
  filterQuery = "",
  displayUnits,
  onDisplayUnitChange,
  dirtyFields,
  touchedFields,
  invalidFields,
  forceShowErrors = false,
  onTouchField,
  onParseErrorChange,
  flashFieldKey = null,
  flashKind,
}: InspectorSectionProps<TDraft>): ReactNode {
  if (section.showWhen && !section.showWhen(ctx.draft)) {
    return null;
  }

  const normalizedQuery = filterQuery.trim().toLowerCase();
  const visibleRows = section.rows.filter((row) => !row.showWhen || row.showWhen(ctx.draft));
  const matchedRows = normalizedQuery
    ? visibleRows.filter((row) => rowMatchesSearchQuery(row, section.title, normalizedQuery))
    : visibleRows;

  if (normalizedQuery && matchedRows.length === 0) {
    return null;
  }

  const effectiveOpen = normalizedQuery ? true : open;
  const isLiveSection = Boolean(section.live || spec.commitBar.mode === "liveViewport");
  const showLiveBadge = Boolean(section.live && spec.commitBar.mode !== "liveViewport");

  const hasError = visibleRows.some((row) => {
    const key = row.key;
    if (!key) return false;
    if (!invalidFields.has(key)) return false;
    return (
      touchedFields.has(key) ||
      forceShowErrors ||
      dirtyFields.has(key) ||
      Boolean(row.serverError?.(ctx.draft))
    );
  });

  const hasDirty =
    !isLiveSection && visibleRows.some((row) => Boolean(row.key && dirtyFields.has(row.key)));

  const summaryText = section.summary?.(ctx.draft) ?? "";
  const emptyState = !normalizedQuery ? (section.emptyState?.(ctx.draft) ?? null) : null;
  const SectionIcon = section.icon;
  const EmptyIcon = emptyState?.icon ?? SectionIcon;

  if (section.flush) {
    // A hosted workspace already draws its own groups; skip the section card
    // and trigger so the panel keeps a single level of framing.
    return (
      <section
        aria-label={section.title}
        className="fm-inspector-section fm-inspector-section--flush"
        data-section-id={section.id}
        data-slot="inspector-section"
      >
        {matchedRows.map((row) => (
          <PropertyRow
            key={resolveStableRowKey(section.id, row)}
            ctx={ctx}
            externalError={row.key ? (invalidFields.get(row.key) ?? null) : null}
            forceShowErrors={forceShowErrors}
            liveRow={isLiveSection}
            row={row}
            touched={row.key ? touchedFields.has(row.key) : false}
            onParseErrorChange={onParseErrorChange}
            onTouchField={onTouchField}
          />
        ))}
      </section>
    );
  }

  return (
    <Collapsible
      className="fm-inspector-section"
      data-section-id={section.id}
      data-slot="inspector-section"
      open={effectiveOpen}
      onOpenChange={onOpenChange}
    >
      <CollapsibleTrigger className="fm-inspector-section__trigger">
        <ChevronRight aria-hidden="true" className="fm-inspector-section__chevron" size={14} />
        <SectionIcon aria-hidden="true" className="fm-inspector-section__icon" size={16} />
        <span className="fm-inspector-section__title">{section.title}</span>
        {showLiveBadge ? (
          <Badge className="fm-inspector-live-badge" variant="secondary">
            Live
          </Badge>
        ) : null}
        {summaryText ? (
          <span
            className="fm-inspector-section__summary"
            data-slot="inspector-section-summary"
            data-visible={effectiveOpen ? "false" : "true"}
          >
            {summaryText}
          </span>
        ) : null}
        <span
          aria-hidden="true"
          className="fm-inspector-section__dot"
          data-state={hasError ? "error" : hasDirty ? "dirty" : "clean"}
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="fm-inspector-section__content">
        {emptyState ? (
          <EmptyState
            action={
              emptyState.action ? (
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => emptyState.action?.onRun(ctx)}
                >
                  {emptyState.action.label}
                </Button>
              ) : undefined
            }
            className="fm-inspector-section__empty"
            description={emptyState.description}
            heading={emptyState.title}
            icon={<EmptyIcon aria-hidden="true" size={20} />}
            size="compact"
          />
        ) : (
          <div className="fm-inspector-section__rows">
            {matchedRows.map((row) => {
              const rowKey = row.key;
              return (
                <PropertyRow
                  key={resolveStableRowKey(section.id, row)}
                  ctx={ctx}
                  displayUnit={rowKey ? displayUnits?.[rowKey] : undefined}
                  externalError={rowKey ? (invalidFields.get(rowKey) ?? null) : null}
                  flash={rowKey && flashFieldKey === rowKey ? flashKind : undefined}
                  forceShowErrors={forceShowErrors}
                  liveRow={isLiveSection}
                  row={row}
                  touched={rowKey ? touchedFields.has(rowKey) : false}
                  onDisplayUnitChange={
                    rowKey && onDisplayUnitChange
                      ? (unit) => onDisplayUnitChange(rowKey, unit)
                      : undefined
                  }
                  onParseErrorChange={onParseErrorChange}
                  onTouchField={onTouchField}
                />
              );
            })}
            {section.footer ? (
              <div className="fm-inspector-section__footer">{section.footer(ctx)}</div>
            ) : null}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export interface InspectorDetailsEntry {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}

function DetailCopyButton({
  label,
  value,
  onCopied,
}: {
  label: string;
  value: string;
  onCopied?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={`Copy ${label}`}
          className="fm-inspector-icon-btn"
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => {
            navigator.clipboard?.writeText(value).catch(() => undefined);
            setCopied(true);
            onCopied?.(value);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : `Copy ${label}`}</TooltipContent>
    </Tooltip>
  );
}

export interface InspectorDetailsSectionProps {
  entries: readonly InspectorDetailsEntry[];
  open: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  onNotify?: (title: string, description?: string) => void;
}

export function InspectorDetailsSection({
  entries,
  open,
  onOpenChange,
  onNotify,
}: InspectorDetailsSectionProps): ReactNode {
  const validEntries = entries.filter(
    (entry): entry is InspectorDetailsEntry & { value: string } =>
      typeof entry.value === "string" && entry.value.trim().length > 0,
  );
  if (validEntries.length === 0) return null;

  return (
    <Collapsible
      className="fm-inspector-details"
      data-section-id="__details"
      data-slot="inspector-details"
      open={open}
      onOpenChange={onOpenChange}
    >
      <CollapsibleTrigger className="fm-inspector-details__trigger">
        <ChevronRight aria-hidden="true" className="fm-inspector-section__chevron" size={14} />
        <Info aria-hidden="true" size={15} />
        <span className="fm-inspector-details__title">Details</span>
        <span className="fm-inspector-details__count">
          {validEntries.length} {validEntries.length === 1 ? "field" : "fields"}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent className="fm-inspector-details__content">
        <dl className="fm-inspector-details__list">
          {validEntries.map((entry) => (
            <div key={entry.label} className="fm-inspector-details__item">
              <dt className="fm-inspector-details__label">{entry.label}</dt>
              <dd className={cn("fm-inspector-details__value", entry.mono && "font-mono")}>
                <span className="fm-inspector-details__value-text">{entry.value}</span>
                <DetailCopyButton
                  label={entry.label}
                  value={entry.value}
                  onCopied={(val) => onNotify?.(`Copied ${entry.label}`, val)}
                />
              </dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
