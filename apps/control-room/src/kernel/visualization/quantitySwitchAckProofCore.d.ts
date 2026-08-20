export function createQuantitySwitchAckProofRecorder(): {
  recordAcknowledgement(event: unknown): void;
  recordRequest(event: unknown): void;
  validate(expectations: readonly unknown[]): readonly string[];
};
export function validateQuantitySwitchAckProof(input: unknown): readonly string[];
