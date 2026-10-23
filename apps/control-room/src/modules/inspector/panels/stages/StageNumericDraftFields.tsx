"use client";

import { useState, useSyncExternalStore } from "react";

import type { QuantityFieldDraftStore } from "../../primitives/quantityFieldDraftStore";
import {
  QuantityField,
  type QuantityFieldParseResult,
} from "../../primitives/QuantityField";
import { FormField } from "../../primitives/FormField";
import { formatEditableNumber } from "./samplingPresentation";

const COMPLETE_DECIMAL =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INCOMPLETE_DECIMAL =
  /^[+-]?$|^[+-]?\.$|^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?$/;

export function StageNumberField({
  disabled,
  draftKey,
  label,
  onCommit,
  unit,
  value,
}: {
  disabled?: boolean;
  draftKey: string;
  label: string;
  onCommit: (value: number) => void;
  unit?: string;
  value: number;
}) {
  return (
    <QuantityField
      disabled={disabled}
      draftKey={draftKey}
      format={formatEditableNumber}
      invalidMessage="Enter a finite number."
      label={label}
      onCommit={onCommit}
      parse={parseStageNumber}
      unit={unit}
      value={value}
    />
  );
}

export function StageOptionalNumberField({
  disabled,
  draftKey,
  label,
  onCommit,
  value,
}: {
  disabled?: boolean;
  draftKey: string;
  label: string;
  onCommit: (value: number | null) => void;
  value: number | null;
}) {
  return (
    <QuantityField
      disabled={disabled}
      draftKey={draftKey}
      format={(current) =>
        current === null ? "" : formatEditableNumber(current)
      }
      invalidMessage="Enter a finite number or leave this optional value blank."
      label={label}
      onCommit={onCommit}
      parse={parseOptionalStageNumber}
      value={value}
    />
  );
}

export function StageNumberTextarea({
  disabled,
  draftKey,
  label,
  onCommit,
  points,
  store,
}: {
  disabled?: boolean;
  draftKey: string;
  label: string;
  onCommit: (points: number[][]) => void;
  points: number[][];
  store: QuantityFieldDraftStore;
}) {
  const entry = useSyncExternalStore(
    store.subscribe,
    () => store.get(draftKey),
    () => undefined,
  );
  const [focused, setFocused] = useState(false);
  const formatted = formatPiecewisePoints(points);
  const text = entry?.rawText ?? formatted;
  const showError =
    entry !== undefined &&
    entry.status !== "valid" &&
    (!focused || entry.status === "invalid");
  const error = showError
    ? (entry.message ?? "Enter finite time and value pairs.")
    : undefined;

  function report(rawText: string): void {
    if (rawText === formatted) {
      store.remove(draftKey);
      return;
    }
    const parsed = parsePiecewisePoints(rawText);
    store.report(draftKey, {
      label,
      message: parsed.ok ? null : (parsed.message ?? null),
      rawText,
      status: parsed.ok ? "valid" : parsed.status,
    });
  }

  function commit(): void {
    const pending = store.get(draftKey);
    if (!pending) return;
    const parsed = parsePiecewisePoints(pending.rawText);
    if (!parsed.ok) return;
    store.remove(draftKey);
    if (!samePiecewisePoints(parsed.value, points)) onCommit(parsed.value);
  }

  return (
    <FormField
      disabled={disabled}
      error={error}
      invalid={Boolean(error)}
      label={label}
      rows={5}
      type="textarea"
      value={text}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={(event) => report(event.currentTarget.value)}
      onFocus={() => setFocused(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape" && entry) {
          event.preventDefault();
          store.remove(draftKey);
        }
      }}
    />
  );
}

function parseStageNumber(text: string): QuantityFieldParseResult<number> {
  const normalized = text.trim();
  if (!normalized || INCOMPLETE_DECIMAL.test(normalized)) {
    return { ok: false, status: "incomplete" };
  }
  if (!COMPLETE_DECIMAL.test(normalized)) {
    return {
      ok: false,
      message: "Enter a finite number.",
      status: "invalid",
    };
  }
  const value = Number(normalized);
  return Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, message: "Enter a finite number.", status: "invalid" };
}

function parseOptionalStageNumber(
  text: string,
): QuantityFieldParseResult<number | null> {
  if (text.trim() === "") return { ok: true, value: null };
  return parseStageNumber(text);
}

function parsePiecewisePoints(
  text: string,
): QuantityFieldParseResult<number[][]> {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, status: "incomplete" };

  const points: number[][] = [];
  for (const line of lines) {
    if (/[,;]$/.test(line)) return { ok: false, status: "incomplete" };
    const entries = line.split(/[,\s;]+/).filter(Boolean);
    if (entries.length < 2) return { ok: false, status: "incomplete" };
    if (entries.length !== 2) {
      return {
        ok: false,
        message: "Each piecewise point must contain one time and one value.",
        status: "invalid",
      };
    }
    const time = parseStageNumber(entries[0]);
    const value = parseStageNumber(entries[1]);
    if (!time.ok) return time;
    if (!value.ok) return value;
    points.push([time.value, value.value]);
  }
  return { ok: true, value: points };
}

function formatPiecewisePoints(points: number[][]): string {
  return points.map(([time, value]) => String(time) + ", " + String(value)).join("\n");
}

function samePiecewisePoints(left: number[][], right: number[][]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (point, index) =>
        point.length === 2 &&
        point[0] === right[index]?.[0] &&
        point[1] === right[index]?.[1],
    )
  );
}
