"use client";

import { Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { IMPORT_DISPERSION_REFERENCE_COMMAND } from "@/kernel/analysis-modules/postprocessingCommandContributions";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MAX_REFERENCE_FILE_BYTES,
  parseReferenceTable,
  referencePointsFromTable,
  type ReferenceAxisUnit,
  type ReferenceFrequencyUnit,
  type ReferenceTable,
} from "@/shared/domain/analysis/referenceImport";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { InspectorPropertyRow } from "../../primitives/InspectorPropertyRow";

type ReferenceFileReadResult =
  | { kind: "ready"; table: ReferenceTable }
  | { kind: "error"; reason: string }
  | { kind: "stale" };

/** Applies parser limits to browser file content before updating Inspector state. */
async function readReferenceFileWithinLimits(
  file: Pick<File, "name" | "size" | "text">,
  isCurrent: () => boolean,
): Promise<ReferenceFileReadResult> {
  if (!isCurrent()) return { kind: "stale" };
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    return { kind: "error", reason: "The selected file has an invalid size." };
  }
  if (file.size > MAX_REFERENCE_FILE_BYTES) {
    return { kind: "error", reason: "Reference files must be 4 MiB or smaller." };
  }
  try {
    const text = await file.text();
    if (!isCurrent()) return { kind: "stale" };
    return { kind: "ready", table: parseReferenceTable(text) };
  } catch (error) {
    if (!isCurrent()) return { kind: "stale" };
    return {
      kind: "error",
      reason: error instanceof Error && error.message.length > 0
        ? error.message
        : "The selected reference file could not be read.",
    };
  }
}

/**
 * Imports a COMSOL or CSV dispersion as a reference overlay saved with the
 * project (ADR 0054, spec 32 §9). Columns and units are mapped explicitly;
 * the first column is read as the chart's path coordinate.
 */
export function ReferenceImportSection() {
  const kernel = useKernel();
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<ReferenceTable | null>(null);
  const [pathColumn, setPathColumn] = useState("0");
  const [frequencyColumn, setFrequencyColumn] = useState("1");
  const [pathUnit, setPathUnit] = useState<ReferenceAxisUnit>("rad/um");
  const [frequencyUnit, setFrequencyUnit] = useState<ReferenceFrequencyUnit>("GHz");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const readGeneration = useRef(0);

  const points = useMemo(
    () =>
      table
        ? referencePointsFromTable(table, {
            frequencyColumn: Number(frequencyColumn),
            frequencyUnit,
            pathColumn: Number(pathColumn),
            pathUnit,
          })
        : null,
    [frequencyColumn, frequencyUnit, pathColumn, pathUnit, table],
  );

  async function readFile(file: File | undefined) {
    const generation = ++readGeneration.current;
    setMessage(null);
    setFileName(file?.name ?? null);
    setTable(null);
    setPathColumn("0");
    setFrequencyColumn("1");
    setLabel("");
    if (!file) return;

    const result = await readReferenceFileWithinLimits(file, () => generation === readGeneration.current);
    if (generation !== readGeneration.current || result.kind === "stale") return;
    if (result.kind === "error") {
      setMessage({ kind: "error", text: result.reason });
      return;
    }
    setTable(result.table);
    setLabel((current) => current || file.name.replace(/\.[^.]+$/, ""));
    if (result.table.columns.length < 2) {
      setMessage({ kind: "error", text: "The file needs at least two numeric columns." });
    }
  }

  async function importReference() {
    if (!fileName || !points?.ok) return;
    try {
      const result = await kernel.commands.execute(
        IMPORT_DISPERSION_REFERENCE_COMMAND,
        createCommandContext("inspector", kernel, { sourceDetail: "dispersion reference import" }),
        {
          fileName,
          label: label.trim(),
          points: points.points,
          sourceUnits: { frequency: frequencyUnit, path: pathUnit },
        },
      );
      setMessage(
        result?.status === "completed"
          ? { kind: "success", text: result.message ?? "Reference imported." }
          : { kind: "error", text: result?.message ?? "Reference import failed." },
      );
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error && error.message.length > 0
          ? `Reference import failed: ${error.message}`
          : "Reference import failed.",
      });
    }
  }

  const columnOptions = table?.columns.map((column, index) => ({ label: column, value: String(index) })) ?? [];

  return (
    <InspectorGroup
      defaultOpen={false}
      icon={<Upload aria-hidden="true" size={16} strokeWidth={1.75} />}
      summary={fileName ?? "COMSOL · CSV"}
      title="Import reference"
      variant="nav"
    >
      <InspectorPropertyRow label="File">
        <Input
          accept=".csv,.tsv,.txt,.dat"
          aria-label="Reference file"
          type="file"
          onChange={(event) => void readFile(event.currentTarget.files?.[0])}
        />
      </InspectorPropertyRow>
      {table && columnOptions.length >= 2 ? (
        <>
          <InspectorPropertyRow label="Path coordinate">
            <Select value={pathColumn} onValueChange={setPathColumn}>
              <SelectTrigger aria-label="Path coordinate column"><SelectValue /></SelectTrigger>
              <SelectContent>
                {columnOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InspectorPropertyRow>
          <InspectorPropertyRow label="Path unit">
            <SegmentedControl
              aria-label="Path coordinate unit"
              options={[
                { label: "rad/µm", value: "rad/um" },
                { label: "rad/m", value: "rad/m" },
              ]}
              value={pathUnit}
              onValueChange={setPathUnit}
            />
          </InspectorPropertyRow>
          <InspectorPropertyRow label="Frequency">
            <Select value={frequencyColumn} onValueChange={setFrequencyColumn}>
              <SelectTrigger aria-label="Frequency column"><SelectValue /></SelectTrigger>
              <SelectContent>
                {columnOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InspectorPropertyRow>
          <InspectorPropertyRow label="Frequency unit">
            <SegmentedControl
              aria-label="Frequency unit"
              options={[
                { label: "GHz", value: "GHz" },
                { label: "MHz", value: "MHz" },
                { label: "Hz", value: "Hz" },
              ]}
              value={frequencyUnit}
              onValueChange={setFrequencyUnit}
            />
          </InspectorPropertyRow>
          <InspectorPropertyRow label="Label">
            <Input aria-label="Reference label" value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
          </InspectorPropertyRow>
          <p className="text-fm-xs text-fm-muted">
            {points?.ok
              ? `${points.points.length} points. The path column is read as the chart's path coordinate; the comparison status stays unknown until reference metadata is recorded.`
              : points?.reason}
            {table.skippedRowCount > 0 ? ` ${table.skippedRowCount} non-numeric rows were skipped.` : ""}
          </p>
          <div>
            <Button
              disabled={!points?.ok || label.trim().length === 0}
              size="sm"
              type="button"
              variant="primary"
              onClick={() => void importReference()}
            >
              Import as reference
            </Button>
          </div>
        </>
      ) : null}
      {message ? <FeedbackBanner kind={message.kind} message={message.text} /> : null}
    </InspectorGroup>
  );
}
