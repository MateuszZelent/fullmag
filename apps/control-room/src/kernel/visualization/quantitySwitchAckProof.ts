export interface QuantitySwitchAckProofRequest {
  carrierKey: string;
  method: string;
  resourceKey: string;
}

export interface QuantitySwitchAckProofAck {
  carrierKey: string;
  revision: number;
  status: "failed" | "rendered";
}

export interface QuantitySwitchAckProofExpectation {
  carrierKey: string;
  revision: number;
  styleOnly?: boolean;
}

import * as core from "./quantitySwitchAckProofCore.js";
export const createQuantitySwitchAckProofRecorder = core.createQuantitySwitchAckProofRecorder as () => {
  recordAcknowledgement(acknowledgement: QuantitySwitchAckProofAck): void;
  recordRequest(request: QuantitySwitchAckProofRequest): void;
  validate(expectations: readonly QuantitySwitchAckProofExpectation[]): readonly string[];
};

/**
 * Fail-closed accounting for the deterministic quantity-switch smoke fixture.
 * Carrier identity is session-scoped by the recorder; no endpoint aliasing is
 * accepted here because that could mask duplicate field fetches.
 */
export function validateQuantitySwitchAckProof({
  acknowledgements,
  expectations,
  requests,
}: {
  acknowledgements: readonly QuantitySwitchAckProofAck[];
  expectations: readonly QuantitySwitchAckProofExpectation[];
  requests: readonly QuantitySwitchAckProofRequest[];
}): readonly string[] {
  return core.validateQuantitySwitchAckProof({ acknowledgements, expectations, requests }) as readonly string[];
}
