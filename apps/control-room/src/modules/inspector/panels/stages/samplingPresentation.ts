const ENGINEERING_PREFIXES: Record<number, string> = {
  [-15]: "f",
  [-12]: "p",
  [-9]: "n",
  [-6]: "µ",
  [-3]: "m",
  0: "",
  3: "k",
  6: "M",
  9: "G",
  12: "T",
};

export function formatEngineering(value: number, unit = ""): string {
  if (!Number.isFinite(value)) return "invalid";
  if (value === 0) return `0${unit ? ` ${unit}` : ""}`;

  const exponent = Math.floor(Math.log10(Math.abs(value)) / 3) * 3;
  const prefix = ENGINEERING_PREFIXES[exponent];
  if (prefix === undefined) return formatScientific(value, unit);

  const scaled = Number((value / 10 ** exponent).toPrecision(4));
  return `${scaled}${unit ? ` ${prefix}${unit}` : ""}`;
}

export function formatScientific(value: number, unit = ""): string {
  if (!Number.isFinite(value)) return "invalid";
  return `${value.toExponential(3)}${unit ? ` ${unit}` : ""}`;
}

/**
 * Keep stored SI values directly editable without expanding useful exponents
 * such as 5 GHz into a distracting 5000000000.
 */
export function formatEditableNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "0";

  const magnitude = Math.abs(value);
  if (magnitude >= 1e4 || magnitude < 1e-3) {
    return value.toExponential().replace("e+", "e");
  }
  return String(value);
}
