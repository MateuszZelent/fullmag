/**
 * Material entity – shared types.
 *
 * Canonical representation of a material used across features.
 */
export interface MaterialEntity {
  id: string;
  name: string;
  ms: number | null;
  a_ex: number | null;
  alpha: number | null;
  gamma: number | null;
  k_u: number | null;
  k_u_axis: [number, number, number] | null;
  exchange_enabled: boolean;
  demag_enabled: boolean;
  zeeman_field: [number, number, number] | null;
}
