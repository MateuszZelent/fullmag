const MU0_T_PER_APM = 4 * Math.PI * 1e-7;
export const DEFAULT_RELAX_TORQUE_APM = 1e-4;

export function apmFromTesla(valueT: number): number {
  return valueT / MU0_T_PER_APM;
}

export function teslaFromApm(valueApm: number): number {
  return valueApm * MU0_T_PER_APM;
}

export function formatScientific(value: number): string {
  return value.toExponential(6).replace("e+", "e");
}

export function formatTorqueT(valueT: number): string {
  return `${formatScientific(valueT)} T`;
}

export function formatTorquePairFromTesla(valueT: number): string {
  return `${formatTorqueT(valueT)} / ${formatScientific(apmFromTesla(valueT))} A/m`;
}

export function formatTorquePairFromApm(valueApm: number): string {
  return `${formatTorqueT(teslaFromApm(valueApm))} / ${formatScientific(valueApm)} A/m`;
}
