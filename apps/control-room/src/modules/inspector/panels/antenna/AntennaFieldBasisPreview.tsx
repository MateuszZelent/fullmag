"use client";

import { useState } from "react";

import type { AntennaFieldSolutionResource } from "@/kernel/api/apiTypes";
import {
  antennaFieldPayloadEtag,
  useAntennaFieldSolutionPayloadResource,
} from "@/kernel/resources/antennaResources";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { decodeFieldBasisPreview, fieldBasisPreviewCount, fieldBasisSamplingDomain, selectedFieldBasisPort } from "./AntennaFieldBasisPreviewModel";

interface AntennaFieldBasisPreviewProps {
  solution: AntennaFieldSolutionResource;
}

function vectorValue(vector: [number, number, number]): string {
  return `(${vector.map((value) => value.toExponential(3)).join(", ")})`;
}

export function AntennaFieldBasisPreview({ solution }: AntennaFieldBasisPreviewProps) {
  const [selectedPort, setSelectedPort] = useState(solution.bases[0]?.port_mode_id ?? "");
  const effectivePort = selectedFieldBasisPort(solution, selectedPort);
  const basis = solution.bases.find((candidate) => candidate.port_mode_id === effectivePort);
  let count = 0;
  let metadataError: string | null = null;
  if (basis) {
    try {
      count = fieldBasisPreviewCount(solution, basis);
    } catch (error) {
      metadataError = error instanceof Error ? error.message : String(error);
    }
  }
  const range = count > 0 ? `bytes=0-${count * 3 * 8 - 1}` : undefined;
  const positions = useAntennaFieldSolutionPayloadResource(
    solution.solution_id,
    count > 0 ? "sample_positions" : null,
    null,
    {
      expectedEtag: count > 0 ? antennaFieldPayloadEtag(solution, "sample_positions") : undefined,
      range,
    },
  );
  const field = useAntennaFieldSolutionPayloadResource(
    solution.solution_id,
    count > 0 ? "magnetic_field_per_ampere" : null,
    effectivePort,
    {
      expectedEtag: count > 0 ? antennaFieldPayloadEtag(solution, "magnetic_field_per_ampere", effectivePort) : undefined,
      range,
    },
  );
  let samples = null;
  let payloadError: string | null = positions.error?.message ?? field.error?.message ?? null;
  if (positions.data?.status === "ready" && field.data?.status === "ready") {
    try {
      samples = decodeFieldBasisPreview(positions.data.data, field.data.data, count);
    } catch (error) {
      payloadError = error instanceof Error ? error.message : String(error);
    }
  }

  return (
    <InspectorGroup
      title="Direct antenna field"
      description="Published H basis per 1 A, before waveform scaling or LLG. The preview shows only the first samples."
    >
      {solution.bases.length > 1 ? (
        <Select value={effectivePort} onValueChange={setSelectedPort}>
          <SelectTrigger aria-label="Antenna port basis" className="fm-antenna-field-preview__select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {solution.bases.map((candidate) => (
              <SelectItem key={candidate.port_mode_id} value={candidate.port_mode_id}>
                {candidate.port_mode_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <FieldRow label="Port" value={basis?.port_mode_id ?? "none"} />
      <FieldRow label="Sampling domain" value={fieldBasisSamplingDomain(solution)} />
      {solution.sample_carrier ? (
        <>
          <FieldRow label="Carrier" value={solution.sample_carrier.carrier_kind} />
          <FieldRow label="Sample location" value={solution.sample_carrier.location} />
          <FieldRow label="Sampling topology" value={solution.sample_carrier.topology_digest} />
        </>
      ) : null}
      <FieldRow label="Samples" value={`${count} of ${solution.sample_positions.value_count / 3}`} />
      {metadataError || !basis ? (
        <p role="alert">{metadataError ?? "No published port basis is available."}</p>
      ) : payloadError ? (
        <p role="alert">Antenna field payload unavailable: {payloadError}</p>
      ) : samples ? (
        samples.map((sample, index) => (
          <div key={index} className="fm-antenna-field-preview__sample">
            <FieldRow label={`Sample ${index + 1} position`} value={vectorValue(sample.positionM)} unit="m" />
            <FieldRow label={`Sample ${index + 1} H/I`} value={vectorValue(sample.fieldApmPerA)} unit="A/m/A" />
          </div>
        ))
      ) : count === 0 ? (
        <p role="status">No field samples were published.</p>
      ) : (
        <p role="status">Loading verified antenna field samples…</p>
      )}
    </InspectorGroup>
  );
}
