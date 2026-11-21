export type RfLevelInputMode =
  | "power_dbm"
  | "power_mw"
  | "power_w"
  | "current_a"
  | "voltage_v";

export type RfWaveformRegime = "cw_harmonic" | "pulse_peak";

export interface ConvertRfPortLevelInput {
  mode: RfLevelInputMode;
  value: number;
  z0Ohm: number;
  regime?: RfWaveformRegime;
}

export interface ConvertedRfPortLevel {
  z0Ohm: number;
  powerW: number;
  powerMw: number;
  powerDbm: number;
  vRmsV: number;
  iRmsA: number;
  peakVoltageV: number;
  peakCurrentA: number;
  peakCurrentMa: number;
}

/**
 * Bidirectional RF port level converter (dBm <-> mW <-> W <-> V0 <-> I0)
 * at characteristic impedance Z0 > 0 (Volume IV §6.5).
 *
 * For matched CW harmonic excitation:
 *   P_W   = 1e-3 * 10^(P_dBm / 10)
 *   V_rms = sqrt(P_W * Z0)
 *   V_0   = sqrt(2 * P_W * Z0)
 *   I_0   = V_0 / Z0 = sqrt(2 * P_W / Z0)
 *   I_rms = I_0 / sqrt(2)
 *
 * For pulse peak regime:
 *   V_0 = I_0 * Z0, P_peak = I_0^2 * Z0.
 */
export function convertRfPortLevel({
  mode,
  value,
  z0Ohm,
  regime = "cw_harmonic",
}: ConvertRfPortLevelInput): ConvertedRfPortLevel {
  const safeZ0 = Number.isFinite(z0Ohm) && z0Ohm > 0 ? z0Ohm : 50;
  const safeVal = Number.isFinite(value) ? value : 0;
  const cwFactor = regime === "cw_harmonic" ? 2 : 1;

  let powerW = 0;
  let peakVoltageV = 0;
  let peakCurrentA = 0;

  switch (mode) {
    case "power_dbm": {
      powerW = 1e-3 * Math.pow(10, safeVal / 10);
      peakVoltageV = Math.sqrt(cwFactor * powerW * safeZ0);
      peakCurrentA = peakVoltageV / safeZ0;
      break;
    }
    case "power_mw": {
      powerW = Math.max(0, safeVal) * 1e-3;
      peakVoltageV = Math.sqrt(cwFactor * powerW * safeZ0);
      peakCurrentA = peakVoltageV / safeZ0;
      break;
    }
    case "power_w": {
      powerW = Math.max(0, safeVal);
      peakVoltageV = Math.sqrt(cwFactor * powerW * safeZ0);
      peakCurrentA = peakVoltageV / safeZ0;
      break;
    }
    case "current_a": {
      peakCurrentA = Math.abs(safeVal);
      peakVoltageV = peakCurrentA * safeZ0;
      powerW = (peakCurrentA * peakCurrentA * safeZ0) / cwFactor;
      break;
    }
    case "voltage_v": {
      peakVoltageV = Math.abs(safeVal);
      peakCurrentA = peakVoltageV / safeZ0;
      powerW = (peakVoltageV * peakVoltageV) / (cwFactor * safeZ0);
      break;
    }
  }

  const vRmsV = regime === "cw_harmonic" ? peakVoltageV / Math.SQRT2 : peakVoltageV;
  const iRmsA = regime === "cw_harmonic" ? peakCurrentA / Math.SQRT2 : peakCurrentA;
  const powerMw = powerW * 1e3;
  const powerDbm = powerW > 0 ? 10 * Math.log10(powerMw) : Number.NEGATIVE_INFINITY;

  return {
    iRmsA,
    peakCurrentA,
    peakCurrentMa: peakCurrentA * 1e3,
    peakVoltageV,
    powerDbm,
    powerMw,
    powerW,
    vRmsV,
    z0Ohm: safeZ0,
  };
}
