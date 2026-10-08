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
import { ANTENNA_BASIS_QUANTITIES, type AntennaBasisQuantity, decodeAntennaBasisPreview, fieldBasisPreviewCount, fieldBasisSamplingDomain, selectedFieldBasisPort } from "./AntennaFieldBasisPreviewModel";

interface AntennaFieldBasisPreviewProps {
  solution: AntennaFieldSolutionResource;
  quantity?: AntennaBasisQuantity;
}

function vectorValue(vector: number[]): string {
  return `(${vector.map((value) => value.toExponential(3)).join(", ")})`;
}

export function AntennaFieldBasisPreview({ solution, quantity = "magnetic_field_per_ampere" }: AntennaFieldBasisPreviewProps) {
  const spec = ANTENNA_BASIS_QUANTITIES[quantity];
  const magnetic = quantity === "magnetic_field_per_ampere";
  const positionKind = magnetic ? "sample_positions" : "conductor_positions";
  const [selectedPort, setSelectedPort] = useState(solution.bases[0]?.port_mode_id ?? "");
  const effectivePort = selectedFieldBasisPort(solution, selectedPort);
  const basis = solution.bases.find((candidate) => candidate.port_mode_id === effectivePort);
  let count = 0;
  let metadataError: string | null = null;
  if (basis) {
    try {
      count = fieldBasisPreviewCount(solution, basis, quantity);
    } catch (error) {
      metadataError = error instanceof Error ? error.message : String(error);
    }
  }
  const range = count > 0 ? `bytes=0-${count * 3 * 8 - 1}` : undefined;
  const positions = useAntennaFieldSolutionPayloadResource(
    solution.solution_id,
    count > 0 ? positionKind : null,
    null,
    {
      expectedEtag: count > 0 ? antennaFieldPayloadEtag(solution, positionKind) : undefined,
      range,
    },
  );
  const field = useAntennaFieldSolutionPayloadResource(
    solution.solution_id,
    count > 0 ? quantity : null,
    effectivePort,
    {
      expectedEtag: count > 0 ? antennaFieldPayloadEtag(solution, quantity, effectivePort) : undefined,
      range: count > 0 ? `bytes=0-${count * spec.components * 8 - 1}` : undefined,
    },
  );
  let samples = null;
  let payloadError: string | null = positions.error?.message ?? field.error?.message ?? null;
  if (positions.status === "ready" && field.status === "ready" && positions.data?.status === "ready" && field.data?.status === "ready") {
    try {
      samples = decodeAntennaBasisPreview(positions.data.data, field.data.data, count, quantity);
    } catch (error) {
      payloadError = error instanceof Error ? error.message : String(error);
    }
  }

  return (
    <InspectorGroup
      title={spec.label}
      description="Published basis per 1 A, before waveform scaling or LLG. This bounded numerical preview is not a 3D field map."
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
      <FieldRow label="Sampling domain" value={magnetic ? fieldBasisSamplingDomain(solution) : `Conductor: ${solution.source_object_id}`} />
      {magnetic && solution.sample_carrier ? (
        <>
          <FieldRow label="Carrier" value={solution.sample_carrier.carrier_kind} />
          <FieldRow label="Sample location" value={solution.sample_carrier.location} />
          <FieldRow label="Sampling topology" value={solution.sample_carrier.topology_digest} />
        </>
      ) : null}
      <FieldRow label="Samples" value={`${count} of ${solution[positionKind].value_count / 3}`} />
      {metadataError || !basis ? (
        <p role="alert">{metadataError ?? "No published port basis is available."}</p>
      ) : payloadError ? (
        <p role="alert">Antenna field payload unavailable: {payloadError}</p>
      ) : samples ? (
        samples.map((sample, index) => (
          <div key={index} className="fm-antenna-field-preview__sample">
            <FieldRow label={`Sample ${index + 1} position`} value={vectorValue(sample.positionM)} unit="m" />
            <FieldRow label={`Sample ${index + 1} ${spec.label.split(" ").at(-1)}`} value={spec.components === 1 ? sample.value[0].toExponential(3) : vectorValue(sample.value)} unit={spec.unit} />
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
