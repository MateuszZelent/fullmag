"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";

import { useFrequencyDomainManifestResource } from "@/kernel/resources/studyRuntimeResources";
import { Button } from "@/shared/ui/Button";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import {
  buildFrequencyDomainCalculationModeRows,
  type FrequencyDomainCalculationModeRow,
} from "../frequencyDomainInspectorModel";
import type { StudyStageDraft } from "../StudyStageAuthoringModel";

type FrequencyDomainStageFamily = "eigenmodes" | "frequency_response";

interface FrequencyDomainCalculationModeSectionProps {
  draft: StudyStageDraft | null;
  family: FrequencyDomainStageFamily;
  onUpdateDraft: (patch: Partial<StudyStageDraft>) => void;
  validation: readonly { message: string; severity: "error" | "warning" }[];
}

const EIGENMODE_MODES = new Set([
  "fmr_modal",
  "free_modes",
  "dispersion_modal",
]);
const RESPONSE_MODES = new Set(["fmr_response", "response_map"]);

export function FrequencyDomainCalculationModeSection({
  draft,
  family,
  onUpdateDraft,
  validation,
}: FrequencyDomainCalculationModeSectionProps) {
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const manifest = useFrequencyDomainManifestResource();
  const rows = buildFrequencyDomainCalculationModeRows(
    manifest.data?.capabilities,
    manifest.data?.floquet_nonzero_k_response_supported,
  ).filter((row) =>
    family === "eigenmodes"
      ? EIGENMODE_MODES.has(row.mode)
      : RESPONSE_MODES.has(row.mode),
  );
  const activeMode = draft?.calculationMode || inferActiveCalculationMode(family, draft);
  const activeRow = rows.find((row) => row.mode === activeMode) ?? rows[0];
  const validationStatus =
    validation.length === 0
      ? "valid"
      : validation.map((issue) => `${issue.severity}: ${issue.message}`).join("; ");

  return (
    <InspectorSection
      value={`${family}-calculation-mode`}
      title={
        family === "eigenmodes"
          ? "Eigenmodes Calculation Mode"
          : "Frequency Response Calculation Mode"
      }
      badge={activeMode}
    >
      <FieldRow
        label="Workflow mode"
        value={
          <select
            aria-label="Workflow mode"
            className="fm-inspector-select"
            disabled={!draft}
            value={activeMode}
            onChange={(event) =>
              onUpdateDraft({ calculationMode: event.target.value })
            }
          >
            {rows.map((row) => (
              <option key={row.mode} value={row.mode}>
                {row.mode}
              </option>
            ))}
          </select>
        }
      />
      <FieldRow
        label="Canonical study"
        value={activeRow?.canonicalStudy ?? "not resolved"}
      />
      <FieldRow
        label="Canonical lowering"
        value={
          family === "eigenmodes"
            ? "StudyIR::Eigenmodes -> modal solver"
            : "StudyIR::FrequencyResponse -> driven harmonic solver"
        }
      />
      <FieldRow
        label="Capability status"
        value={activeRow?.capabilityStatus ?? "unknown"}
      />
      <FieldRow
        label="Patch status"
        value="Save stage writes calculation_mode into the canonical stage patch"
      />
      <FieldRow label="Validation" value={validationStatus} />
      {validationMessage ? (
        <FieldRow label="Validation check" value={validationMessage} />
      ) : null}
      <div className="fm-frequency-domain-table-wrap">
        <table className="fm-frequency-domain-table">
          <thead>
            <tr>
              <th>Mode</th>
              <th>Canonical study</th>
              <th>Boundary</th>
              <th>k</th>
              <th>Sweep</th>
              <th>Excitation</th>
              <th>Artifacts</th>
              <th>Capability</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <CalculationModeRow
                key={row.mode}
                active={row.mode === activeMode}
                row={row}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="fm-inspector-toolbar">
        <Button
          disabled={!draft}
          size="sm"
          title="Calculation mode is part of the stage draft; Save stage commits it."
          type="button"
          variant="primary"
          onClick={() => onUpdateDraft({ calculationMode: activeMode })}
        >
          <CheckCircle2 size={13} aria-hidden="true" />
          Apply calculation mode
        </Button>
        <Button
          disabled={!draft}
          size="sm"
          title="Validate current calculation-mode requirements"
          type="button"
          variant="secondary"
          onClick={() => {
            setValidationMessage(
              validation.length === 0
                ? `${activeMode} requirements are valid for the current draft.`
                : validationStatus,
            );
          }}
        >
          Validate requirements
        </Button>
      </div>
    </InspectorSection>
  );
}

function CalculationModeRow({
  active,
  row,
}: {
  active: boolean;
  row: FrequencyDomainCalculationModeRow;
}) {
  return (
    <tr data-status={active ? "ready" : "available"}>
      <td>{row.mode}</td>
      <td>{row.canonicalStudy}</td>
      <td>{row.boundaryPreset}</td>
      <td>{row.kRequirement}</td>
      <td>{row.sweepRequirement}</td>
      <td>{row.excitationRequirement}</td>
      <td>{row.artifacts}</td>
      <td>{row.capabilityStatus}</td>
    </tr>
  );
}

function inferActiveCalculationMode(
  family: FrequencyDomainStageFamily,
  draft: StudyStageDraft | null,
): string {
  if (family === "frequency_response") {
    return hasNonzeroKSampling(draft) ? "response_map" : "fmr_response";
  }
  return hasNonzeroKSampling(draft) ? "dispersion_modal" : "fmr_modal";
}

function hasNonzeroKSampling(draft: StudyStageDraft | null): boolean {
  const kPath = draft?.kPath?.trim().toLowerCase();
  const kSampling = draft?.kSampling?.trim().toLowerCase();
  const kVector = draft?.kVector?.trim().toLowerCase();
  if (kPath && kPath !== "k = 0" && kPath !== "k=0") return true;
  if (kSampling && kSampling !== "k = 0" && kSampling !== "k=0") return true;
  if (kVector && kVector !== "0,0,0" && kVector !== "0 0 0") return true;
  return false;
}
