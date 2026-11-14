//! Hand-written masks for field excitation (`mask_field_drive.v1`).
//!
//! Contract: `docs/specs/mask-function-v1.md`, physics note
//! `docs/physics/0922-masks-for-field-excitation.md`, ADR 0081. A drive is a
//! list of terms `mask_i(r) * time_i(t)` on a support shape placed in a target
//! (global, a magnet or a region of a magnet). Functions are stored as equations
//! (`field_expr.v1`); the solver never calls Python.

use std::collections::{BTreeMap, BTreeSet};

use fullmag_expr::{
    compile_function, CompiledFunction, FunctionError, FunctionKind, FunctionSource,
    FIELD_EXPR_VERSION, MAX_MASK_TERMS,
};
use serde::{Deserialize, Serialize};

use crate::field_drive_validation::validate_drive_activation;
use crate::{
    DriveActivationIR, FieldTargetIR, FieldTimeOriginIR, ProblemIR, RegionShapeIR, StudyIR,
};

pub const MASK_FIELD_DRIVE_SCHEMA_VERSION: &str = "mask_field_drive.v1";

fn default_enabled() -> bool {
    true
}

fn default_time_origin() -> FieldTimeOriginIR {
    FieldTimeOriginIR::StageLocal
}

/// Coordinates of the support position and of mask functions.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaskFrameIR {
    /// World coordinates.
    World,
    /// Measured from the support position, given in the target's object frame.
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FunctionParameterIR {
    pub name: String,
    pub value: f64,
    /// Authored text of the value (for example `279 * nm`), kept for display and
    /// script export. Absent for captured numbers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FunctionLocalIR {
    pub name: String,
    pub expression: String,
}

/// A mask or time function: parameters, ordered locals, outputs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FunctionIR {
    pub expression_version: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parameters: Vec<FunctionParameterIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locals: Vec<FunctionLocalIR>,
    /// Three equations (tesla) for a mask, one (dimensionless) for a time function.
    pub outputs: Vec<String>,
}

impl FunctionIR {
    pub fn compile(&self, kind: FunctionKind) -> Result<CompiledFunction, FunctionError> {
        let parameters: Vec<(String, f64)> = self
            .parameters
            .iter()
            .map(|parameter| (parameter.name.clone(), parameter.value))
            .collect();
        let locals: Vec<(String, String)> = self
            .locals
            .iter()
            .map(|local| (local.name.clone(), local.expression.clone()))
            .collect();
        compile_function(
            &FunctionSource {
                parameters: &parameters,
                locals: &locals,
                outputs: &self.outputs,
            },
            kind,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MaskSourceIR {
    /// Equations of `x, y, z`, evaluated by the planner once per cell or node.
    Function { function: FunctionIR },
    /// A float32 `.npy` array of shape `(nz, ny, nx, 3)` in tesla on a regular
    /// lattice; `origin_m` is the lower corner of the lattice, world frame.
    Sampled {
        path: String,
        sha256: String,
        size: [u32; 3],
        cell_m: [f64; 3],
        origin_m: [f64; 3],
    },
}

/// The call of a ready antenna (`fullmag.antennas`) that produced a term.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LibraryCallIR {
    pub function: String,
    pub arguments: BTreeMap<String, f64>,
    pub call_index: u32,
    pub output_index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MaskTermIR {
    /// Unique within the drive; addresses the term in `update_mask_field_drive`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub mask: MaskSourceIR,
    /// Absent: a static term (time factor 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<FunctionIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<LibraryCallIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MaskFieldDriveIR {
    pub schema_version: String,
    pub id: String,
    pub name: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Cells the drive may act on; intersected with the support shape.
    pub target: FieldTargetIR,
    /// Support shape; its own center is relative to `position_m`.
    pub shape: RegionShapeIR,
    pub position_m: [f64; 3],
    pub frame: MaskFrameIR,
    pub terms: Vec<MaskTermIR>,
    #[serde(default = "default_time_origin")]
    pub time_origin: FieldTimeOriginIR,
    pub activation: DriveActivationIR,
}

impl MaskFieldDriveIR {
    /// `true` when any term has a time function that reads `t`.
    pub fn is_time_dependent(&self) -> bool {
        self.terms.iter().any(|term| {
            term.time.as_ref().is_some_and(|time| {
                time.compile(FunctionKind::Time)
                    .map(|compiled| compiled.depends_on_variables())
                    .unwrap_or(true)
            })
        })
    }
}

/// Letters, digits and `_`, not starting with a digit, at most 64 bytes.
fn valid_term_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 64
        && chars
            .next()
            .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn finite3(value: &[f64; 3]) -> bool {
    value.iter().all(|component| component.is_finite())
}

fn positive(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn validate_shape(label: &str, shape: &RegionShapeIR, errors: &mut Vec<String>) {
    let valid = match shape {
        RegionShapeIR::Box { size, center } => {
            size.iter().all(|value| positive(*value)) && finite3(center)
        }
        RegionShapeIR::Cylinder {
            radius,
            height,
            center,
            axis,
        } => {
            positive(*radius)
                && positive(*height)
                && finite3(center)
                && finite3(axis)
                && axis.iter().map(|value| value * value).sum::<f64>() > 1e-30
        }
        RegionShapeIR::Sphere { radius, center } => positive(*radius) && finite3(center),
        RegionShapeIR::Csg { .. } => {
            errors.push(format!(
                "mask_shape_invalid: {label}.shape: CSG supports are not part of mask_field_drive.v1; use a box, cylinder or sphere"
            ));
            return;
        }
    };
    if !valid {
        errors.push(format!(
            "mask_shape_invalid: {label}.shape: sizes must be finite and positive, centers finite, a cylinder axis non-zero"
        ));
    }
}

fn function_error(label: &str, error: FunctionError) -> String {
    format!(
        "{}: {label}.{} @{}: {}",
        error.code, error.path, error.position, error.message
    )
}

fn validate_function(
    label: &str,
    function: &FunctionIR,
    kind: FunctionKind,
    errors: &mut Vec<String>,
) -> Option<CompiledFunction> {
    if function.expression_version != FIELD_EXPR_VERSION {
        errors.push(format!(
            "mask_field_drive_invalid: {label}.expression_version must be '{FIELD_EXPR_VERSION}'"
        ));
        return None;
    }
    for (index, parameter) in function.parameters.iter().enumerate() {
        if !parameter.value.is_finite() {
            errors.push(format!(
                "mask_field_drive_invalid: {label}.parameters[{index}] '{}' must be finite",
                parameter.name
            ));
            return None;
        }
    }
    match function.compile(kind) {
        Ok(compiled) => Some(compiled),
        Err(error) => {
            errors.push(function_error(label, error));
            None
        }
    }
}

fn validate_sampled(label: &str, source: &MaskSourceIR, errors: &mut Vec<String>) {
    let MaskSourceIR::Sampled {
        path,
        sha256,
        size,
        cell_m,
        origin_m,
    } = source
    else {
        return;
    };
    let digest_ok = sha256.len() == 64 && sha256.bytes().all(|byte| byte.is_ascii_hexdigit());
    if path.trim().is_empty()
        || !digest_ok
        || size.contains(&0)
        || !cell_m.iter().all(|value| positive(*value))
        || !finite3(origin_m)
    {
        errors.push(format!(
            "mask_array_invalid: {label}: a sampled mask needs a path, a sha256 of 64 hex digits, a non-zero size, positive cells and a finite origin"
        ));
    }
}

/// Validate `ProblemIR.mask_field_drives`. Every message starts with its code.
pub(crate) fn validate_mask_field_drives(problem: &ProblemIR, errors: &mut Vec<String>) {
    if problem.mask_field_drives.is_empty() {
        return;
    }
    let magnet_aliases: BTreeSet<&str> = problem
        .magnets
        .iter()
        .flat_map(|magnet| std::iter::once(magnet.name.as_str()).chain(magnet.object_id.as_deref()))
        .collect();
    let region_ids: BTreeSet<(&str, &str)> = problem
        .object_regions
        .iter()
        .map(|region| (region.owner_object.as_str(), region.region_id.as_str()))
        .collect();
    let declared_stage_ids =
        crate::validation::declared_pipeline_stage_ids(&problem.problem_meta.runtime_metadata);
    let active_stage_id = problem
        .problem_meta
        .runtime_metadata
        .get("active_stage_id")
        .and_then(|value| value.as_str());
    let mut ids: BTreeSet<&str> = problem
        .field_drives
        .iter()
        .map(|drive| drive.id.as_str())
        .collect();

    for (index, drive) in problem.mask_field_drives.iter().enumerate() {
        let label = format!("mask_field_drives[{index}]");
        if drive.schema_version != MASK_FIELD_DRIVE_SCHEMA_VERSION {
            errors.push(format!(
                "mask_field_drive_invalid: {label}.schema_version must be '{MASK_FIELD_DRIVE_SCHEMA_VERSION}'"
            ));
        }
        if drive.id.trim().is_empty() || drive.name.trim().is_empty() {
            errors.push(format!(
                "mask_field_drive_invalid: {label} id and name must not be empty"
            ));
        } else if !ids.insert(drive.id.as_str()) {
            errors.push(format!(
                "mask_field_drive_invalid: {label}.id '{}' is already used by another field drive",
                drive.id
            ));
        }
        match &drive.target {
            FieldTargetIR::Global {} => {}
            FieldTargetIR::Object { object_id } => {
                if !magnet_aliases.contains(object_id.as_str()) {
                    errors.push(format!(
                        "mask_target_unknown: {label}.target object '{object_id}' is not a magnet"
                    ));
                }
            }
            FieldTargetIR::Region {
                object_id,
                region_id,
            } => {
                if !region_ids.contains(&(object_id.as_str(), region_id.as_str())) {
                    errors.push(format!(
                        "mask_target_unknown: {label}.target region '{object_id}/{region_id}' does not exist"
                    ));
                }
            }
        }
        validate_shape(&label, &drive.shape, errors);
        if !finite3(&drive.position_m) {
            errors.push(format!(
                "mask_shape_invalid: {label}.position_m must be finite"
            ));
        }
        if drive.terms.is_empty() || drive.terms.len() > MAX_MASK_TERMS {
            errors.push(format!(
                "mask_too_many_terms: {label} has {} terms; a drive needs 1 to {MAX_MASK_TERMS}",
                drive.terms.len()
            ));
        }
        let mut time_dependent = false;
        let mut term_names = BTreeSet::new();
        for (term_index, term) in drive.terms.iter().enumerate() {
            let term_label = format!("{label}.terms[{term_index}]");
            if let Some(name) = &term.name {
                if !valid_term_name(name) {
                    errors.push(format!(
                        "mask_field_drive_invalid: {term_label}.name '{name}' must use letters, digits and '_', start with a letter or '_' and have at most 64 characters"
                    ));
                } else if !term_names.insert(name.as_str()) {
                    errors.push(format!(
                        "mask_field_drive_invalid: {term_label}.name '{name}' is used by another term of the drive"
                    ));
                }
            }
            match &term.mask {
                MaskSourceIR::Function { function } => {
                    validate_function(
                        &format!("{term_label}.mask"),
                        function,
                        FunctionKind::Mask,
                        errors,
                    );
                }
                sampled @ MaskSourceIR::Sampled { .. } => {
                    validate_sampled(&format!("{term_label}.mask"), sampled, errors);
                }
            }
            if let Some(time) = &term.time {
                if let Some(compiled) = validate_function(
                    &format!("{term_label}.time"),
                    time,
                    FunctionKind::Time,
                    errors,
                ) {
                    time_dependent |= compiled.depends_on_variables();
                }
            }
            if let Some(origin) = &term.origin {
                if origin.function.trim().is_empty()
                    || origin.arguments.values().any(|value| !value.is_finite())
                {
                    errors.push(format!(
                        "mask_field_drive_invalid: {term_label}.origin needs a function name and finite arguments"
                    ));
                }
            }
        }
        validate_drive_activation(
            &label,
            &drive.activation,
            declared_stage_ids.as_ref(),
            errors,
        );
        let active = drive.enabled
            && drive
                .activation
                .is_active_for(problem.study.kind(), active_stage_id);
        if active && time_dependent && matches!(problem.study, StudyIR::Relaxation { .. }) {
            errors.push(format!(
                "mask_field_drive_invalid: {label} has a time-dependent term and is active in a relaxation stage"
            ));
        }
    }
}
