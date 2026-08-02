export type SpinAuthoringFamily = "current_transport" | "spin_torque" | "oersted_field";

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function finite(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value); }
function vec3(value: unknown): boolean { return Array.isArray(value) && value.length === 3 && value.every(finite); }
function optionalVec3(value: unknown): boolean { return value === undefined || value === null || vec3(value); }
function defaultString(value: unknown): boolean { return value === undefined || typeof value === "string"; }
function optionalString(value: unknown): boolean { return value === undefined || value === null || typeof value === "string"; }
function optionalFinite(value: unknown): boolean { return value === undefined || value === null || finite(value); }
function regionRef(value: unknown): boolean { return object(value) && typeof value.object_id === "string" && optionalString(value.region_id); }
function optionalRegionRef(value: unknown): boolean { return value === undefined || value === null || regionRef(value); }
function realization(value: unknown): boolean { return value === undefined || value === null || (object(value) && value.kind === "thin_layer_homogenized" && value.realization_version === "slonczewski_thin_layer_homogenized.v1"); }
function compatibilityOrigin(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!object(value) || typeof value.source_ir_version !== "string" || typeof value.authored_kind !== "string") return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}
function points2(value: unknown): boolean { return Array.isArray(value) && value.every((point) => Array.isArray(point) && point.length === 2 && point.every(finite)); }
function envelope(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.kind === "constant") return finite(value.value);
  if (value.kind === "sinusoidal") return finite(value.amplitude) && finite(value.frequency_hz) && finite(value.phase_rad) && finite(value.offset);
  if (value.kind === "pulse") return finite(value.amplitude) && finite(value.t_on_s) && finite(value.t_off_s);
  if (value.kind === "piecewise_linear") return Array.isArray(value.points) && value.points.every((point) => object(point) && finite(point.time_s) && finite(point.value));
  if (value.kind === "sinc") return finite(value.amplitude) && finite(value.center_s) && finite(value.bandwidth_hz) && finite(value.offset);
  return value.kind === "tabulated" && typeof value.artifact_ref === "string" && ["linear", "previous"].includes(String(value.interpolation)) && ["zero", "hold", "error"].includes(String(value.extrapolation)) && (value.bandwidth_hz == null || finite(value.bandwidth_hz));
}
function prescribedDrive(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.kind === "signed_scalar") return finite(value.current_density_Apm2) && vec3(value.sigma_hat) && (value.envelope == null || envelope(value.envelope));
  if (value.kind === "vector_current_source") return typeof value.current_source_id === "string" && vec3(value.drive_direction) && vec3(value.interface_normal);
  if (value.kind === "legacy_scalar_magnitude") return finite(value.raw_charge_current_density_Apm2);
  return value.kind === "legacy_current_source_norm" && typeof value.current_source_id === "string";
}
function oerstedTime(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.kind === "constant") return true;
  if (value.kind === "sinusoidal") return finite(value.frequency_hz) && finite(value.phase_rad) && finite(value.offset);
  if (value.kind === "pulse") return finite(value.t_on) && finite(value.t_off);
  if (value.kind === "piecewise_linear") return points2(value.points);
  return value.kind === "sinc_pulse" && finite(value.cutoff_hz) && finite(value.t0) && finite(value.amplitude);
}

export function isUnsupportedSpinAuthoringResource(
  family: SpinAuthoringFamily,
  resource: object,
): boolean {
  const kind = "kind" in resource ? (resource as { kind?: unknown }).kind : undefined;
  if (family === "current_transport") return kind !== "current_transport";
  if (family === "spin_torque") {
    const value = resource as Record<string, unknown>;
    if (kind === "zhang_li") return !defaultString(value.id) || !optionalVec3(value.current_density) || !optionalString(value.current_source) || !finite(value.degree) || !finite(value.beta);
    if (kind === "slonczewski") return !defaultString(value.id) || !optionalString(value.schema_version) || !optionalVec3(value.current_density) || !optionalString(value.current_source) || !finite(value.degree) || !finite(value.epsilon_prime) || !finite(value.lambda_asymmetry) || !vec3(value.spin_polarization) || !optionalFinite(value.free_layer_thickness_m) || !optionalString(value.fixed_layer_position) || !optionalRegionRef(value.target) || !optionalVec3(value.stack_normal) || !realization(value.realization) || !["slonczewski.fullmag.v2", "slonczewski.legacy_fullmag.v0"].includes(String(value.formula_version));
    if (kind === "prescribed_sot") return !defaultString(value.id) || !prescribedDrive(value.drive) || !finite(value.free_layer_thickness_m) || !finite(value.xi_dl) || !finite(value.xi_fl) || !optionalRegionRef(value.target) || !optionalVec3(value.raw_spin_polarization) || !compatibilityOrigin(value.compatibility_origin) || value.schema_version !== "prescribed_sot.v1" || !["prescribed_sot.fullmag.v1", "prescribed_sot.legacy_fullmag.v0"].includes(String(value.formula_version));
    return true;
  }
  const value = resource as Record<string, unknown>;
  if (kind === "oersted_cylinder") return !defaultString(value.id) || !vec3(value.axis) || !vec3(value.center) || !finite(value.radius) || !finite(value.current) || (value.time_dependence != null && !oerstedTime(value.time_dependence));
  if (kind === "oersted_field") return !defaultString(value.id) || value.model !== "from_current_solution" || typeof value.source !== "string";
  return true;
}
