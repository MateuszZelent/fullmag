export type SpinAuthoringFamily = "current_transport" | "spin_torque" | "oersted_field";

export function isUnsupportedSpinAuthoringResource(
  family: SpinAuthoringFamily,
  resource: object,
): boolean {
  const kind = "kind" in resource ? (resource as { kind?: unknown }).kind : undefined;
  if (family === "current_transport") {
    return kind !== "current_transport";
  }
  if (family === "spin_torque") {
    return kind !== "slonczewski" && kind !== "zhang_li" && kind !== "prescribed_sot";
  }
  return kind !== "oersted_cylinder" && kind !== "oersted_field";
}
