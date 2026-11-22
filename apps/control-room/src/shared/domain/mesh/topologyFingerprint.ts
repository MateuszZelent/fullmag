export function canonicalMeshTopologyHash(value: string): string {
  const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value);
  return match?.[1]?.toLowerCase() ?? value;
}
