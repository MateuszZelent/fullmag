/**
 * Mesh entity – shared types.
 */
export interface MeshEntity {
  id: string;
  name: string | null;
  source: string | null;
  nodeCount: number;
  elementCount: number;
  feOrder: number | null;
  boundsMin: [number, number, number] | null;
  boundsMax: [number, number, number] | null;
  extent: [number, number, number] | null;
}
