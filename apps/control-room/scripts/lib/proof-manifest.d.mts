export class ProofManifestError extends Error {
  readonly reasonCode: string;
}

export function validateProofManifest(
  manifest: unknown,
  artifactRoot: string,
): Promise<void>;

export function validateSourceSnapshotBinding(
  manifest: unknown,
  sourceSnapshot: unknown,
): void;

export function writeProofManifest(
  manifest: unknown,
  outputPath: string,
  artifactRoot: string,
): Promise<void>;
