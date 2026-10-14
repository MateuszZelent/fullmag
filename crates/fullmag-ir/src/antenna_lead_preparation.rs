//! Mesh-independent authored lead intent, never an accepted source certificate.
use crate::CurrentSourceDriveIR;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const ANTENNA_EXTERNAL_LEAD_PREPARATION_SCHEMA_VERSION: &str =
    "antenna_external_lead_preparation.v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExternalLeadPreparationKindIR {
    IsolatedBranchStraightStubs,
}

fn default_layers() -> usize {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TerminalLeadExtensionIR {
    pub id: String,
    pub observation_id: String,
    pub object_id: String,
    pub boundary_markers: Vec<i32>,
    pub length_m: f64,
    pub outward_direction_xyz: [f64; 3],
    pub conductivity_spm: f64,
    #[serde(default = "default_layers")]
    pub layers: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ExternalLeadPreparationIR {
    pub schema_version: String,
    pub kind: ExternalLeadPreparationKindIR,
    pub revision: String,
    pub extensions: Vec<TerminalLeadExtensionIR>,
    pub drives: Vec<CurrentSourceDriveIR>,
}

impl ExternalLeadPreparationIR {
    /// Geometry incidence, cap closure and per-component current balance require
    /// the realized device mesh and are deliberately absent from this validator.
    pub fn validation_errors(&self, path: &str) -> Vec<String> {
        const LIMIT: usize = 4 * (1 << 20);
        let text = |s: &str| !s.trim().is_empty() && s.len() <= 4096 && !s.contains('\0');
        let mut errors = Vec::new();
        if !(2..=128).contains(&self.extensions.len())
            || self.drives.is_empty()
            || self.drives.len() > LIMIT
            || self
                .drives
                .len()
                .checked_mul(self.extensions.len())
                .is_none_or(|n| n > LIMIT)
            || self
                .extensions
                .iter()
                .try_fold(0usize, |n, e| n.checked_add(e.boundary_markers.len()))
                .is_none_or(|n| n > LIMIT)
            || self
                .drives
                .iter()
                .try_fold(0usize, |n, d| {
                    n.checked_add(d.outer_terminal_currents_a.len())
                })
                .is_none_or(|n| n > LIMIT)
        {
            return vec![format!("{path} exceeds bounded lead preparation support")];
        }
        if self.schema_version != ANTENNA_EXTERNAL_LEAD_PREPARATION_SCHEMA_VERSION
            || !text(&self.revision)
        {
            errors.push(format!(
                "{path} requires the supported schema_version and bounded nonempty revision"
            ));
        }
        let mut terminal_ids = BTreeSet::new();
        let mut observations = BTreeSet::new();
        let mut markers = BTreeSet::new();
        for (index, extension) in self.extensions.iter().enumerate() {
            let prefix = format!("{path}.extensions[{index}]");
            if !text(&extension.id)
                || !terminal_ids.insert(extension.id.as_str())
                || !text(&extension.observation_id)
                || !observations.insert(extension.observation_id.as_str())
                || !text(&extension.object_id)
            {
                errors.push(format!("{prefix} requires bounded nonempty identifiers and unique terminal/observation IDs"));
            }
            if extension.boundary_markers.is_empty()
                || extension
                    .boundary_markers
                    .iter()
                    .any(|marker| *marker <= 0 || !markers.insert(*marker))
            {
                errors.push(format!(
                    "{prefix}.boundary_markers requires globally disjoint positive int32 selectors"
                ));
            }
            if !extension.length_m.is_finite()
                || extension.length_m <= 0.0
                || !extension.conductivity_spm.is_finite()
                || extension.conductivity_spm <= 0.0
                || !(2..=1 << 20).contains(&extension.layers)
            {
                errors.push(format!("{prefix} requires positive finite length/conductivity and layers in 2..1048576"));
            }
            let direction = extension.outward_direction_xyz;
            let norm = direction[0].hypot(direction[1]).hypot(direction[2]);
            if direction.iter().any(|value| !value.is_finite()) || (norm - 1.0).abs() > 1e-12 {
                errors.push(format!(
                    "{prefix}.outward_direction_xyz must be a finite unit vector"
                ));
            }
        }
        let mut drive_ids = BTreeSet::new();
        let mut port_ids = BTreeSet::new();
        for (index, drive) in self.drives.iter().enumerate() {
            if !text(&drive.id)
                || !drive_ids.insert(drive.id.as_str())
                || !text(&drive.port_mode_ref)
                || !port_ids.insert(drive.port_mode_ref.as_str())
                || drive
                    .outer_terminal_currents_a
                    .keys()
                    .map(String::as_str)
                    .collect::<BTreeSet<_>>()
                    != terminal_ids
                || drive
                    .outer_terminal_currents_a
                    .values()
                    .any(|value| !value.is_finite())
            {
                errors.push(format!("{path}.drives[{index}] requires unique bounded drive/port IDs and exact terminal coverage with finite signed currents"));
            }
        }
        errors
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn fixture() -> serde_json::Value {
        json!({"schema_version": "antenna_external_lead_preparation.v1", "kind": "isolated_branch_straight_stubs", "revision": "intent-r1",
            "extensions": [
                {"id":"minus", "observation_id":"observe-minus", "object_id":"device", "boundary_markers":[11], "length_m":1e-6, "outward_direction_xyz":[-1.,0.,0.], "conductivity_spm":4e7},
                {"id":"plus", "observation_id":"observe-plus", "object_id":"device", "boundary_markers":[12], "length_m":1e-6, "outward_direction_xyz":[1.,0.,0.], "conductivity_spm":4e7}],
            "drives":[{"id":"drive", "port_mode_ref":"port", "outer_terminal_currents_a":{"minus":-0.002, "plus":0.002}}]})
    }

    #[test]
    fn declaration_roundtrip_keeps_signed_and_zero_currents_without_claiming_mesh_balance() {
        let mut preparation: ExternalLeadPreparationIR = serde_json::from_value(fixture()).unwrap();
        assert_eq!(preparation.extensions[0].layers, 2);
        assert!(preparation.validation_errors("intent").is_empty());
        // Disconnected component incidence is unknown until execution.
        preparation.drives[0]
            .outer_terminal_currents_a
            .insert("plus".into(), 0.0);
        assert!(preparation.validation_errors("intent").is_empty());
        let roundtrip: ExternalLeadPreparationIR =
            serde_json::from_value(serde_json::to_value(&preparation).unwrap()).unwrap();
        assert_eq!(preparation, roundtrip);
    }

    #[test]
    fn declaration_rejects_unknown_fields_bad_geometry_controls_and_missing_currents() {
        for malformed in [
            {
                let mut v = fixture();
                v["certificate"] = json!("closed");
                v
            },
            {
                let mut v = fixture();
                v["extensions"][0]["invented"] = json!(true);
                v
            },
            {
                let mut v = fixture();
                v["kind"] = json!("closed_geometry");
                v
            },
            {
                let mut v = fixture();
                v["extensions"][0]["layers"] = json!(2.5);
                v
            },
        ] {
            assert!(serde_json::from_value::<ExternalLeadPreparationIR>(malformed).is_err());
        }
        for malformed in [
            {
                let mut v = fixture();
                v["extensions"][1]["boundary_markers"] = json!([11]);
                v
            },
            {
                let mut v = fixture();
                v["extensions"][0]["outward_direction_xyz"] = json!([2., 0., 0.]);
                v
            },
            {
                let mut v = fixture();
                v["extensions"][0]["layers"] = json!(1);
                v
            },
            {
                let mut v = fixture();
                v["extensions"][0]["length_m"] = json!(0.);
                v
            },
            {
                let mut v = fixture();
                v["drives"][0]["outer_terminal_currents_a"] = json!({"minus":-0.002});
                v
            },
        ] {
            assert!(
                !serde_json::from_value::<ExternalLeadPreparationIR>(malformed)
                    .unwrap()
                    .validation_errors("intent")
                    .is_empty()
            );
        }
    }

    #[test]
    fn malformed_preparation_does_not_disappear_through_optional_charge_flatten() {
        let mut module = json!({"kind":"current_transport", "name":"charge", "model":"ohmic_poisson", "coupling":"one_way",
            "domain":[{"object_id":"device"}], "materials":[{"region":{"object_id":"device"},"material":{"sigma_Spm":4e7}}],
            "boundaries":[], "gauge":"terminal_reference", "solver":{"engine":"cg", "linear":{"relative_tolerance":1e-10,"absolute_tolerance":0.,"max_iterations":100},
            "operator_version":"fem_charge_conforming_h1_p1.transparent.v1","physical_residual_version":"charge_balance_integrated_l2.v1"}, "external_lead_preparation":fixture()});
        let decoded: crate::CurrentModuleIR = serde_json::from_value(module.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(decoded).unwrap()["external_lead_preparation"]["revision"],
            "intent-r1"
        );
        module["external_lead_preparation"]["certificate"] = json!("invented");
        assert!(serde_json::from_value::<crate::CurrentModuleIR>(module.clone()).is_err());
        module["external_lead_preparation"] = fixture();
        module.as_object_mut().unwrap().remove("solver");
        assert!(serde_json::from_value::<crate::CurrentModuleIR>(module).is_err());
    }
}
