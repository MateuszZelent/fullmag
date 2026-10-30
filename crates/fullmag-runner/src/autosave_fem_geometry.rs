//! Immutable, prepared geometry metadata for regular FEM nodal Zarr autosaves.
//!
//! Preparation is source-only: it validates plan data and creates canonical
//! bytes, but performs no filesystem access or solver qualification.

use fullmag_ir::{AutosaveFormatIR, BackendPlanIR, ExecutionPlanIR, StageAutosaveIR};
use fullmag_quantities::{
    fem_nodal_field::{FemP1NodalFieldSemantics, FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT},
    quantity_spec, QuantityDomain, QuantityId,
};
use fullmag_session::{
    saved_fem_nodal::{
        FemNodalStorageLayout, SavedFemNodalArrayBinding, SavedFemP1MeshGeometry,
        FEM_NODAL_ARRAY_BINDING_SCHEMA, FEM_P1_MESH_GEOMETRY_SCHEMA, MAX_FEM_NODAL_SEMANTICS_BYTES,
    },
    solution_field_geometry::{
        SavedFieldGeometryRef, SavedFieldRepresentationEvidence, MAX_FEM_P1_GEOMETRY_SHAPE_BYTES,
    },
};
use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub(crate) struct PreparedFemAutosaveGeometry {
    mesh_reference: SavedFieldGeometryRef,
    mesh_bytes: Arc<Vec<u8>>,
    topology_fingerprint: String,
    node_count: usize,
    cell_count: usize,
    quantities: HashMap<QuantityId, PreparedFemAutosaveQuantity>,
}

#[derive(Debug, Clone)]
struct PreparedFemAutosaveQuantity {
    semantics: Arc<FemP1NodalFieldSemantics>,
    semantics_reference: SavedFieldGeometryRef,
    semantics_bytes: Arc<Vec<u8>>,
    component_count: usize,
}

pub(crate) struct PreparedFemAutosaveBinding {
    pub(crate) binding: SavedFemNodalArrayBinding,
    pub(crate) mesh_bytes: Arc<Vec<u8>>,
    pub(crate) semantics_bytes: Arc<Vec<u8>>,
}

impl PreparedFemAutosaveGeometry {
    /// Prepare the shared mesh and each canonical, supported nodal quantity.
    pub(crate) fn from_plan(
        plan: &ExecutionPlanIR,
        policy: &StageAutosaveIR,
    ) -> Result<Option<Self>, String> {
        if policy.format != AutosaveFormatIR::Zarr {
            return Ok(None);
        }
        let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
            return Ok(None);
        };
        if fem.fe_order != 1 {
            return Ok(None);
        }

        let mut requested = Vec::new();
        for field in &policy.fields {
            if let Some(quantity) = canonical_supported_quantity(&field.quantity) {
                if !requested.contains(&quantity) {
                    requested.push(quantity);
                }
            }
        }
        if requested.is_empty() {
            return Ok(None);
        }

        let node_count = fem.mesh.nodes.len();
        let cell_count = fem.mesh.cells.len();
        let facet_count = fem.mesh.facets.len();
        if exceeds_existing_geometry_shape_budget(node_count, cell_count, facet_count) {
            return Ok(None);
        }

        let mesh_geometry = SavedFemP1MeshGeometry {
            schema_version: FEM_P1_MESH_GEOMETRY_SCHEMA.into(),
            coordinate_unit: "m".into(),
            representation_evidence: SavedFieldRepresentationEvidence::NotVerified,
            mesh: fem.mesh.clone(),
        };
        mesh_geometry
            .validate()
            .map_err(|error| format!("validating FEM autosave mesh geometry: {error}"))?;
        let topology_fingerprint = fem.mesh.topology_fingerprint_v6();
        let needs_magnetic_support = requested.iter().any(|quantity| {
            quantity_spec(quantity.as_str())
                .is_some_and(|spec| spec.domain == QuantityDomain::MagneticOnly)
        });
        let normalized_markers = if needs_magnetic_support {
            Some(
                crate::fem::plan::normalized_runtime_element_markers(fem)
                    .map_err(|error| error.message)?,
            )
        } else {
            None
        };

        let Some(mesh_bytes) = serialize_with_budget(
            &mesh_geometry,
            fullmag_session::solution_field_geometry::MAX_FEM_P1_GEOMETRY_BYTES,
            "FEM autosave mesh geometry",
        )?
        else {
            return Ok(None);
        };
        let mesh_reference = SavedFieldGeometryRef {
            schema_id: FEM_P1_MESH_GEOMETRY_SCHEMA.into(),
            object_ref: fullmag_session::hex_sha256(&mesh_bytes),
            byte_length: mesh_bytes.len() as u64,
        };
        let mesh_bytes = Arc::new(mesh_bytes);

        let mut quantities = HashMap::new();
        for quantity in requested {
            let spec = quantity_spec(quantity.as_str()).ok_or_else(|| {
                format!(
                    "quantity '{}' is absent from the catalog",
                    quantity.as_str()
                )
            })?;
            let active_node_mask = match spec.domain {
                QuantityDomain::MagneticOnly => {
                    crate::preview::mesh_quantity_active_mask_with_element_markers(
                        quantity.as_str(),
                        &fem.mesh,
                        normalized_markers
                            .as_deref()
                            .ok_or_else(|| "normalized FEM markers are unavailable".to_string())?,
                    )
                    .ok_or_else(|| {
                        format!(
                            "FEM autosave active support is unavailable for quantity '{}'",
                            quantity.as_str()
                        )
                    })?
                }
                QuantityDomain::FullDomain => vec![true; node_count],
            };
            let semantics = Arc::new(
                FemP1NodalFieldSemantics::new(
                    quantity,
                    &topology_fingerprint,
                    node_count,
                    active_node_mask,
                )
                .map_err(|error| error.to_string())?,
            );
            let Some(semantics_bytes) = serialize_with_budget(
                semantics.as_ref(),
                MAX_FEM_NODAL_SEMANTICS_BYTES,
                "FEM nodal semantics",
            )?
            else {
                return Ok(None);
            };
            let semantics_reference = SavedFieldGeometryRef {
                schema_id: FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT.into(),
                object_ref: fullmag_session::hex_sha256(&semantics_bytes),
                byte_length: semantics_bytes.len() as u64,
            };
            let component_count = match semantics.descriptor.tensor_rank {
                0 => 1,
                1 => 3,
                _ => {
                    return Err(format!(
                        "FEM nodal quantity '{}' has unsupported tensor rank",
                        quantity.as_str()
                    ));
                }
            };
            let semantics_bytes = Arc::new(semantics_bytes);
            let prepared_quantity = PreparedFemAutosaveQuantity {
                semantics,
                semantics_reference,
                semantics_bytes,
                component_count,
            };
            validate_prepared_quantity(
                &mesh_geometry,
                &mesh_reference,
                &topology_fingerprint,
                node_count,
                cell_count,
                quantity,
                &prepared_quantity,
            )?;
            quantities.insert(quantity, prepared_quantity);
        }

        Ok(Some(Self {
            mesh_reference,
            mesh_bytes,
            topology_fingerprint,
            node_count,
            cell_count,
            quantities,
        }))
    }

    /// Bind one canonical array path to prepared immutable geometry and semantics.
    pub(crate) fn bind_array(
        &self,
        array_path: &str,
        quantity: &str,
        layout: FemNodalStorageLayout,
        value_count: usize,
    ) -> Result<Option<PreparedFemAutosaveBinding>, String> {
        let Some(quantity_id) = canonical_supported_quantity(quantity) else {
            return Ok(None);
        };
        let Some(prepared) = self.quantities.get(&quantity_id) else {
            return Ok(None);
        };
        let expected_width = self
            .node_count
            .checked_mul(prepared.component_count)
            .ok_or_else(|| "FEM nodal array width overflow".to_string())?;
        if value_count != expected_width {
            return Err(format!(
                "FEM nodal array '{}' has width {value_count}; expected {expected_width}",
                quantity_id.as_str()
            ));
        }
        let binding = SavedFemNodalArrayBinding {
            schema_version: FEM_NODAL_ARRAY_BINDING_SCHEMA.into(),
            array_path: array_path.into(),
            quantity_id,
            unit: prepared.semantics.descriptor.unit.clone(),
            component_count: prepared.component_count,
            node_count: self.node_count,
            cell_count: self.cell_count,
            field_layout: layout,
            topology_fingerprint: self.topology_fingerprint.clone(),
            mesh: self.mesh_reference.clone(),
            semantics: prepared.semantics_reference.clone(),
        };
        binding.validate().map_err(|error| error.to_string())?;
        Ok(Some(PreparedFemAutosaveBinding {
            binding,
            mesh_bytes: Arc::clone(&self.mesh_bytes),
            semantics_bytes: Arc::clone(&prepared.semantics_bytes),
        }))
    }
}

fn exceeds_existing_geometry_shape_budget(
    node_count: usize,
    cell_count: usize,
    facet_count: usize,
) -> bool {
    node_count > (MAX_FEM_P1_GEOMETRY_SHAPE_BYTES / 24) as usize
        || cell_count > (MAX_FEM_P1_GEOMETRY_SHAPE_BYTES / 16) as usize
        || facet_count > (MAX_FEM_P1_GEOMETRY_SHAPE_BYTES / 12) as usize
}

fn serialize_with_budget<T: serde::Serialize>(
    value: &T,
    max_bytes: u64,
    label: &str,
) -> Result<Option<Vec<u8>>, String> {
    let max_bytes = usize::try_from(max_bytes)
        .map_err(|_| format!("{label} byte budget does not fit this platform"))?;
    let mut writer = BudgetedJsonWriter {
        bytes: Vec::new(),
        max_bytes,
        exceeded: false,
    };
    let serialized = serde_json::to_writer(&mut writer, value);
    if writer.exceeded {
        return Ok(None);
    }
    serialized.map_err(|error| format!("serializing {label}: {error}"))?;
    if writer.bytes.is_empty() {
        return Err(format!("serialized {label} is empty"));
    }
    Ok(Some(writer.bytes))
}

struct BudgetedJsonWriter {
    bytes: Vec<u8>,
    max_bytes: usize,
    exceeded: bool,
}

impl Write for BudgetedJsonWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self
            .bytes
            .len()
            .checked_add(bytes.len())
            .map_or(true, |len| len > self.max_bytes)
        {
            self.exceeded = true;
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "serialized metadata exceeds its byte budget",
            ));
        }
        let required = self.bytes.len() + bytes.len(); // checked against max_bytes above
        if required > self.bytes.capacity() {
            // Geometric growth avoids reallocating for every small serde token,
            // while keeping the requested allocation within the metadata budget.
            let capacity = self
                .bytes
                .capacity()
                .saturating_mul(2)
                .max(1024)
                .max(required)
                .min(self.max_bytes);
            if self
                .bytes
                .try_reserve_exact(capacity - self.bytes.len())
                .is_err()
            {
                self.exceeded = true;
                return Err(io::Error::new(
                    io::ErrorKind::Other,
                    "serialized metadata allocation exceeds available memory",
                ));
            }
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn canonical_supported_quantity(value: &str) -> Option<QuantityId> {
    let quantity = QuantityId::ALL
        .iter()
        .copied()
        .find(|quantity| quantity.as_str() == value)?;
    FemP1NodalFieldSemantics::supports_quantity(quantity).then_some(quantity)
}

fn validate_prepared_quantity(
    mesh: &SavedFemP1MeshGeometry,
    mesh_reference: &SavedFieldGeometryRef,
    topology_fingerprint: &str,
    node_count: usize,
    cell_count: usize,
    quantity: QuantityId,
    prepared: &PreparedFemAutosaveQuantity,
) -> Result<(), String> {
    let binding = SavedFemNodalArrayBinding {
        schema_version: FEM_NODAL_ARRAY_BINDING_SCHEMA.into(),
        array_path: format!("stages/prepared/fields/{}", quantity.as_str()),
        quantity_id: quantity,
        unit: prepared.semantics.descriptor.unit.clone(),
        component_count: prepared.component_count,
        node_count,
        cell_count,
        field_layout: FemNodalStorageLayout::AosNodeMajor,
        topology_fingerprint: topology_fingerprint.into(),
        mesh: mesh_reference.clone(),
        semantics: prepared.semantics_reference.clone(),
    };
    binding
        .validate_payload_structure(mesh, &prepared.semantics)
        .map_err(|error| format!("validating prepared FEM nodal binding: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        AutosaveLayoutIR, BackendTarget, CommonPlanMeta, ExecutionMode, FemPlanIR, FieldAutosaveIR,
        OutputPlanIR, ProvenancePlanIR,
    };

    fn mesh() -> fullmag_ir::MeshIR {
        fullmag_ir::MeshIR::from_legacy_tet4(
            "mixed-support-tet".into(),
            vec![
                [0., 0., 0.],
                [1., 0., 0.],
                [0., 1., 0.],
                [0., 0., 1.],
                [0., 0., -1.],
            ],
            vec![[0, 1, 2, 3], [0, 2, 1, 4]],
            vec![0, 1],
            vec![
                [0, 1, 3],
                [1, 2, 3],
                [2, 0, 3],
                [0, 2, 4],
                [2, 1, 4],
                [1, 0, 4],
            ],
            vec![1; 6],
            vec![],
            vec![],
            std::collections::HashMap::new(),
        )
    }

    fn plan(mesh: fullmag_ir::MeshIR, fe_order: u32) -> ExecutionPlanIR {
        ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: "v0".into(),
                requested_backend: BackendTarget::Fem,
                resolved_backend: BackendTarget::Fem,
                execution_mode: ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: BackendPlanIR::Fem(FemPlanIR {
                mesh,
                fe_order,
                ..FemPlanIR::default()
            }),
            output_plan: OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: ProvenancePlanIR::default(),
        }
    }

    fn policy(format: AutosaveFormatIR, quantities: &[&str]) -> StageAutosaveIR {
        StageAutosaveIR {
            kind: "stage_autosave".into(),
            target: "state".into(),
            layout: AutosaveLayoutIR::Separate,
            format,
            table: None,
            fields: quantities
                .iter()
                .map(|quantity| FieldAutosaveIR {
                    kind: "field_autosave".into(),
                    quantity: (*quantity).into(),
                    every_seconds: None,
                    sample_period_policy: None,
                    every_steps: Some(1),
                })
                .collect(),
        }
    }

    #[test]
    fn prepares_quantity_specific_masks_and_shared_mesh_bytes() {
        let plan = plan(mesh(), 1);
        let policy = policy(AutosaveFormatIR::Zarr, &["m", "H_eff"]);
        let prepared = PreparedFemAutosaveGeometry::from_plan(&plan, &policy)
            .expect("prepare source geometry")
            .expect("supported FEM Zarr fields should prepare geometry");
        let m = prepared
            .bind_array(
                "stages/stage-1/fields/m",
                "m",
                FemNodalStorageLayout::AosNodeMajor,
                15,
            )
            .unwrap()
            .unwrap();
        let h_eff = prepared
            .bind_array(
                "stages/stage-1/fields/H_eff",
                "H_eff",
                FemNodalStorageLayout::SoaComponentMajor,
                15,
            )
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(&m.mesh_bytes, &h_eff.mesh_bytes));
        assert_eq!(m.binding.mesh, h_eff.binding.mesh);
        assert_ne!(m.binding.semantics, h_eff.binding.semantics);
        assert_eq!(m.binding.unit, "1");
        assert_eq!(h_eff.binding.unit, "A/m");
        assert_eq!(m.binding.field_layout, FemNodalStorageLayout::AosNodeMajor);
        assert_eq!(
            h_eff.binding.field_layout,
            FemNodalStorageLayout::SoaComponentMajor
        );

        let m_semantics = serde_json::from_slice::<FemP1NodalFieldSemantics>(&m.semantics_bytes)
            .expect("decode prepared M semantics");
        let h_eff_semantics =
            serde_json::from_slice::<FemP1NodalFieldSemantics>(&h_eff.semantics_bytes)
                .expect("decode prepared H_eff semantics");
        assert_eq!(
            m_semantics.active_node_mask,
            vec![true, true, true, false, true]
        );
        assert_eq!(h_eff_semantics.active_node_mask, vec![true; 5]);
    }

    #[test]
    fn rejects_width_mismatch_and_skips_alias_projection_or_unsupported_quantity() {
        let plan = plan(mesh(), 1);
        let policy = policy(AutosaveFormatIR::Zarr, &["m", "M", "m.x", "E_total"]);
        let prepared = PreparedFemAutosaveGeometry::from_plan(&plan, &policy)
            .expect("prepare source geometry")
            .expect("canonical m field should prepare geometry");
        assert!(prepared
            .bind_array(
                "stages/stage-1/fields/m",
                "m",
                FemNodalStorageLayout::AosNodeMajor,
                14,
            )
            .is_err());
        assert!(prepared
            .bind_array(
                "stages/stage-1/fields/M",
                "M",
                FemNodalStorageLayout::AosNodeMajor,
                15,
            )
            .unwrap()
            .is_none());
        assert!(prepared
            .bind_array(
                "stages/stage-1/fields/m.x",
                "m.x",
                FemNodalStorageLayout::AosNodeMajor,
                15,
            )
            .unwrap()
            .is_none());
        assert!(prepared
            .bind_array(
                "stages/stage-1/fields/E_total",
                "E_total",
                FemNodalStorageLayout::AosNodeMajor,
                1,
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn skips_non_zarr_and_higher_order_fem_policies() {
        let plan = plan(mesh(), 1);
        assert!(PreparedFemAutosaveGeometry::from_plan(
            &plan,
            &policy(AutosaveFormatIR::Txt, &["m"])
        )
        .unwrap()
        .is_none());

        let high_order_plan = plan(mesh(), 2);
        assert!(PreparedFemAutosaveGeometry::from_plan(
            &high_order_plan,
            &policy(AutosaveFormatIR::Zarr, &["m"])
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn shape_budget_preflight_does_not_require_allocating_mesh_arrays() {
        let max_nodes = (MAX_FEM_P1_GEOMETRY_SHAPE_BYTES / 24) as usize;
        let max_cells = (MAX_FEM_P1_GEOMETRY_SHAPE_BYTES / 16) as usize;
        let max_facets = (MAX_FEM_P1_GEOMETRY_SHAPE_BYTES / 12) as usize;
        assert!(!exceeds_existing_geometry_shape_budget(
            max_nodes, max_cells, max_facets
        ));
        assert!(exceeds_existing_geometry_shape_budget(
            max_nodes + 1,
            max_cells,
            max_facets
        ));
        assert!(exceeds_existing_geometry_shape_budget(
            max_nodes,
            max_cells + 1,
            max_facets
        ));
        assert!(exceeds_existing_geometry_shape_budget(
            max_nodes,
            max_cells,
            max_facets + 1
        ));
    }

    #[test]
    fn serialized_metadata_budget_is_optional() {
        let within = serialize_with_budget(&"a", 3, "test semantics").unwrap();
        assert_eq!(within.as_deref(), Some(br#""a"#));
        assert!(serialize_with_budget(&"a", 2, "test semantics")
            .unwrap()
            .is_none());
    }
}
