use super::*;
use crate::FemMaterialFieldLocation;

fn representation() -> FemRepresentationReceipt {
    FemRepresentationReceipt {
        schema_version: 1,
        state_space: FemStateRepresentation::LocalNodeAos,
        ms_location: FemMaterialFieldLocation::ElementDg0,
        a_location: FemMaterialFieldLocation::Scalar,
        local_node_count: 2,
        true_node_count: 1,
        periodic_map_revision: 42,
        representation_copy_count: 2,
        gather_scatter_bytes: 96,
        invalid_space_assertion_count: 0,
        hot_loop_representation_copy_count: 1,
        hot_loop_gather_scatter_bytes: 48,
    }
}

#[test]
fn periodic_local_snapshot_is_valid_and_bound_to_values_and_endpoint() {
    let values = [[0.1, -0.0, 1.0], [0.1, -0.0, 1.0]];
    let receipt =
        FemLocalNodeSnapshotReceipt::capture(7, 0.7, 0.1, &values, representation()).unwrap();
    let bytes = serde_json::to_vec(&receipt).unwrap();
    assert_eq!(parse_fem_snapshot_receipt(&bytes).unwrap(), receipt);
    assert!(receipt.validate_snapshot(7, 0.7, 0.1, &values).is_ok());
    assert!(receipt.validate_snapshot(6, 0.7, 0.1, &values).is_err());
    assert!(receipt.validate_snapshot(7, 0.8, 0.1, &values).is_err());
    assert!(receipt.validate_snapshot(7, 0.7, 0.2, &values).is_err());
    let mut changed = values;
    changed[1][1] = 0.0;
    assert!(receipt.validate_snapshot(7, 0.7, 0.1, &changed).is_err());
    changed = values;
    changed[0][0] = f64::NAN;
    assert!(local_node_values_sha256(&changed).is_err());
    let mut hasher = Sha256::new();
    for value in values.iter().flatten() {
        hasher.update(value.to_le_bytes());
    }
    assert_eq!(
        receipt.values_sha256,
        format!("sha256:{:x}", hasher.finalize())
    );
}

#[test]
fn unknown_fields_missing_map_and_invalid_native_counts_fail_closed() {
    let values = [[1., 0., 0.]; 2];
    let valid = FemLocalNodeSnapshotReceipt::capture(0, 0., 0., &values, representation()).unwrap();
    for field in ["map", "local", "true", "invalid", "counters", "schema"] {
        let mut changed = valid.clone();
        match field {
            "map" => changed.representation.periodic_map_revision = 0,
            "local" => changed.representation.local_node_count = 1,
            "true" => changed.representation.true_node_count = 3,
            "invalid" => changed.representation.invalid_space_assertion_count = 1,
            "counters" => changed.representation.hot_loop_gather_scatter_bytes = 97,
            _ => changed.schema_version = "future".into(),
        }
        assert!(changed.validate(2).is_err());
    }
    let mut raw = serde_json::to_value(valid).unwrap();
    raw["representation"]["invented_map_proof"] = serde_json::json!(true);
    assert!(parse_fem_snapshot_receipt(&serde_json::to_vec(&raw).unwrap()).is_err());
    assert!(parse_fem_snapshot_receipt(&vec![b' '; MAX_FEM_SNAPSHOT_RECEIPT_BYTES + 1]).is_err());
}

#[test]
fn indexed_geometry_receipt_requires_canonical_digest_and_bound_node_map() {
    let mut receipt =
        FemLocalNodeSnapshotReceipt::capture(0, 0., 0., &[[1., 0., 0.]; 2], representation())
            .unwrap();
    receipt.native_indexed_geometry_sha256 = Some(format!("sha256:{}", "a".repeat(64)));
    assert!(receipt.validate(2).is_err());
    receipt.native_node_map_sha256 = Some(format!("sha256:{}", "b".repeat(64)));
    receipt.validate(2).unwrap();
    let wire = serde_json::to_vec(&receipt).unwrap();
    assert_eq!(parse_fem_snapshot_receipt(&wire).unwrap(), receipt);
    receipt.native_indexed_geometry_sha256 = Some("unverified".into());
    assert!(receipt.validate(2).is_err());
}
