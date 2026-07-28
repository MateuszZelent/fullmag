//! Qualified offline crossover data for FEM `device=auto` selection.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::FemCrossoverDecision;
use fullmag_ir::FemPlanIR;

pub(crate) const FEM_CROSSOVER_SCHEMA_V1: &str = "fullmag.fem-crossover.v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FemCrossoverFeatures {
    pub node_count: u64,
    pub matrix_nnz: Option<u64>,
    pub demag_enabled: bool,
    pub relaxation_algorithm: String,
    pub preview_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FemCrossoverSampleDistribution {
    pub p50_seconds: f64,
    pub p95_seconds: f64,
    pub stddev_seconds: f64,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FemCrossoverSample {
    pub fixture_id: String,
    pub node_count: u64,
    pub matrix_nnz: Option<u64>,
    pub cpu: FemCrossoverSampleDistribution,
    pub gpu: FemCrossoverSampleDistribution,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FemCrossoverStratum {
    pub id: String,
    pub demag_enabled: bool,
    pub relaxation_algorithm: String,
    pub preview_enabled: bool,
    #[serde(default)]
    pub requires_matrix_nnz: bool,
    #[serde(default)]
    pub minimum_matrix_nnz: Option<u64>,
    #[serde(default)]
    pub maximum_matrix_nnz: Option<u64>,
    pub lower_node_count: u64,
    pub upper_node_count: u64,
    pub within_band_device: String,
    pub samples: Vec<FemCrossoverSample>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FemCrossoverHardwareIdentity {
    pub gpu_uuid: String,
    pub gpu_name: String,
    pub compute_capability: String,
    pub driver_version: String,
    pub cuda_toolkit_version: String,
    pub cpu_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FemCrossoverRuntimeIdentity {
    pub bundle_sha256: String,
    pub library_sha256: BTreeMap<String, String>,
    pub hardware: FemCrossoverHardwareIdentity,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FemCrossoverProfileV1 {
    pub schema_version: String,
    pub calibration_id: String,
    pub qualified: bool,
    #[serde(default)]
    pub qualification_notes: Vec<String>,
    #[serde(default)]
    pub evidence_sources: Vec<String>,
    pub confidence: f64,
    pub warmup_runs: u32,
    pub repeat_runs: u32,
    pub runtime: FemCrossoverRuntimeIdentity,
    pub strata: Vec<FemCrossoverStratum>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub profile_sha256: String,
}

pub(crate) fn profile_payload_sha256(profile: &FemCrossoverProfileV1) -> String {
    let mut payload = profile.clone();
    payload.signature = None;
    payload.profile_sha256.clear();
    let encoded = serde_json::to_vec(&payload).expect("FEM crossover profile must serialize");
    format!("{:x}", Sha256::digest(encoded))
}

pub(crate) fn validate_fem_crossover_profile(
    profile: FemCrossoverProfileV1,
    runtime: &FemCrossoverRuntimeIdentity,
) -> Result<FemCrossoverProfileV1, String> {
    if profile.schema_version != FEM_CROSSOVER_SCHEMA_V1 {
        return Err(format!(
            "unsupported FEM crossover schema {}",
            profile.schema_version
        ));
    }
    if !profile.qualified {
        return Err("FEM crossover profile is not qualified".to_string());
    }
    if profile.calibration_id.trim().is_empty() {
        return Err("FEM crossover calibration_id is empty".to_string());
    }
    if profile.signature.is_some() {
        return Err(
            "FEM crossover schema v1 signatures are unsupported and must be null".to_string(),
        );
    }
    if !profile.confidence.is_finite() || !(0.0..=1.0).contains(&profile.confidence) {
        return Err("FEM crossover confidence must be finite and in [0, 1]".to_string());
    }
    if profile.warmup_runs == 0 || profile.repeat_runs < 2 {
        return Err("FEM crossover sampling policy requires warmup>=1 and repeats>=2".to_string());
    }
    let expected_hash = profile_payload_sha256(&profile);
    if profile.profile_sha256 != expected_hash {
        return Err(format!(
            "FEM crossover profile SHA-256 mismatch: expected {expected_hash}"
        ));
    }
    if &profile.runtime != runtime {
        return Err("FEM crossover device or runtime/library identity mismatch".to_string());
    }
    if profile.strata.is_empty() {
        return Err("FEM crossover profile contains no strata".to_string());
    }
    for stratum in &profile.strata {
        if stratum.lower_node_count > stratum.upper_node_count {
            return Err(format!(
                "FEM crossover stratum {} has inverted node bounds",
                stratum.id
            ));
        }
        if !matches!(stratum.within_band_device.as_str(), "cpu" | "gpu") {
            return Err(format!(
                "FEM crossover stratum {} has invalid within_band_device",
                stratum.id
            ));
        }
        if stratum.minimum_matrix_nnz > stratum.maximum_matrix_nnz {
            return Err(format!(
                "FEM crossover stratum {} has inverted matrix_nnz bounds",
                stratum.id
            ));
        }
        if stratum.samples.is_empty() {
            return Err(format!(
                "FEM crossover stratum {} contains no samples",
                stratum.id
            ));
        }
        for sample in &stratum.samples {
            for distribution in [&sample.cpu, &sample.gpu] {
                if distribution.count < 2
                    || !distribution.p50_seconds.is_finite()
                    || !distribution.p95_seconds.is_finite()
                    || !distribution.stddev_seconds.is_finite()
                    || distribution.p50_seconds < 0.0
                    || distribution.p95_seconds < distribution.p50_seconds
                    || distribution.stddev_seconds < 0.0
                {
                    return Err(format!(
                        "FEM crossover fixture {} has invalid sample distribution",
                        sample.fixture_id
                    ));
                }
            }
        }
    }
    Ok(profile)
}

pub(crate) fn resolve_auto_fem_device(
    features: &FemCrossoverFeatures,
    profile: Option<&FemCrossoverProfileV1>,
) -> FemCrossoverDecision {
    let Some(profile) = profile
        .filter(|profile| profile.qualified && profile.schema_version == FEM_CROSSOVER_SCHEMA_V1)
    else {
        return availability_first_gpu_decision("availability_first_gpu_no_qualified_profile");
    };
    let stratum = profile.strata.iter().find(|stratum| {
        let matrix_nnz_required = stratum.requires_matrix_nnz
            || stratum.minimum_matrix_nnz.is_some()
            || stratum.maximum_matrix_nnz.is_some();
        stratum.demag_enabled == features.demag_enabled
            && stratum.relaxation_algorithm == features.relaxation_algorithm
            && stratum.preview_enabled == features.preview_enabled
            && (!matrix_nnz_required || features.matrix_nnz.is_some())
            && features.matrix_nnz.is_none_or(|nnz| {
                stratum
                    .minimum_matrix_nnz
                    .is_none_or(|minimum| nnz >= minimum)
                    && stratum
                        .maximum_matrix_nnz
                        .is_none_or(|maximum| nnz <= maximum)
            })
    });
    let Some(stratum) = stratum else {
        return availability_first_gpu_decision("availability_first_gpu_profile_inapplicable");
    };
    let (resolved, reason) = if features.node_count < stratum.lower_node_count {
        ("cpu", "calibrated_below_lower_bound")
    } else if features.node_count > stratum.upper_node_count {
        ("gpu", "calibrated_above_upper_bound")
    } else {
        (
            stratum.within_band_device.as_str(),
            "calibrated_hysteresis_band",
        )
    };
    FemCrossoverDecision {
        requested: "auto".to_string(),
        resolved: resolved.to_string(),
        reason: reason.to_string(),
        calibration_id: Some(profile.calibration_id.clone()),
        confidence: Some(profile.confidence),
    }
}

fn availability_first_gpu_decision(reason: &str) -> FemCrossoverDecision {
    FemCrossoverDecision {
        requested: "auto".to_string(),
        resolved: "gpu".to_string(),
        reason: reason.to_string(),
        calibration_id: None,
        confidence: None,
    }
}

pub(crate) fn load_qualified_profile_from_env() -> Option<FemCrossoverProfileV1> {
    load_qualified_profile_from_env_with_identity(None)
}

fn load_qualified_profile_from_env_with_identity(
    authoritative_runtime: Option<&FemCrossoverRuntimeIdentity>,
) -> Option<FemCrossoverProfileV1> {
    let profile_path = std::env::var_os("FULLMAG_FEM_CROSSOVER_PROFILE")?;
    let Some(authoritative_runtime) = authoritative_runtime else {
        eprintln!(
            "warning: rejecting FEM crossover profile because the selected managed runtime, loaded \
             native libraries, and detected GPU do not yet expose one authoritative crossover identity"
        );
        return None;
    };
    let profile = std::fs::read(&profile_path)
        .map_err(|error| format!("cannot read profile: {error}"))
        .and_then(|bytes| {
            serde_json::from_slice::<FemCrossoverProfileV1>(&bytes)
                .map_err(|error| format!("cannot parse profile: {error}"))
        })
        .and_then(|profile| validate_fem_crossover_profile(profile, authoritative_runtime));
    match profile {
        Ok(profile) => Some(profile),
        Err(error) => {
            eprintln!("warning: rejecting FEM crossover profile: {error}");
            None
        }
    }
}

pub(crate) fn debug_min_nodes_decision(
    features: &FemCrossoverFeatures,
) -> Option<FemCrossoverDecision> {
    let raw = std::env::var("FULLMAG_FEM_GPU_MIN_NODES").ok()?;
    let threshold = raw.trim().parse::<u64>().ok()?;
    if threshold == 0 {
        return None;
    }
    eprintln!(
        "warning: FULLMAG_FEM_GPU_MIN_NODES is a deprecated debug-only override for FEM device=auto"
    );
    let (resolved, reason) = if features.node_count < threshold {
        ("cpu", "debug_min_nodes_override_below_threshold")
    } else {
        ("gpu", "debug_min_nodes_override_at_or_above_threshold")
    };
    Some(FemCrossoverDecision {
        requested: "auto".to_string(),
        resolved: resolved.to_string(),
        reason: reason.to_string(),
        calibration_id: None,
        confidence: None,
    })
}

pub(crate) fn features_from_plan(plan: &FemPlanIR, preview_enabled: bool) -> FemCrossoverFeatures {
    FemCrossoverFeatures {
        node_count: plan.mesh.nodes.len() as u64,
        matrix_nnz: None,
        demag_enabled: plan.enable_demag,
        relaxation_algorithm: plan
            .relaxation
            .as_ref()
            .map(|relaxation| {
                crate::fem::relax::algorithm::algorithm_provenance_name(relaxation.algorithm)
                    .to_string()
            })
            .unwrap_or_else(|| "time_domain".to_string()),
        preview_enabled,
    }
}

pub(crate) fn resolve_auto_fem_plan_device(
    plan: &FemPlanIR,
    preview_enabled: bool,
) -> FemCrossoverDecision {
    let features = features_from_plan(plan, preview_enabled);
    if let Some(decision) = debug_min_nodes_decision(&features) {
        return decision;
    }
    let profile = load_qualified_profile_from_env();
    resolve_auto_fem_device(&features, profile.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::{LazyLock, Mutex};

    static ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    struct EnvRestore {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvRestore {
        fn set(key: &'static str, value: &std::path::Path) -> Self {
            let previous = std::env::var_os(key);
            unsafe {
                std::env::set_var(key, value);
            }
            Self { key, previous }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            unsafe {
                if let Some(previous) = &self.previous {
                    std::env::set_var(self.key, previous);
                } else {
                    std::env::remove_var(self.key);
                }
            }
        }
    }

    fn identity() -> FemCrossoverRuntimeIdentity {
        FemCrossoverRuntimeIdentity {
            bundle_sha256: "bundle-a".to_string(),
            library_sha256: BTreeMap::from([
                ("libmfem.so".to_string(), "mfem-a".to_string()),
                ("libHYPRE.so".to_string(), "hypre-a".to_string()),
            ]),
            hardware: FemCrossoverHardwareIdentity {
                gpu_uuid: "GPU-test-a".to_string(),
                gpu_name: "Test GPU".to_string(),
                compute_capability: "8.9".to_string(),
                driver_version: "590.48".to_string(),
                cuda_toolkit_version: "13.1".to_string(),
                cpu_identity: "Test CPU".to_string(),
            },
        }
    }

    fn profile() -> FemCrossoverProfileV1 {
        let sample = FemCrossoverSample {
            fixture_id: "box-exchange".to_string(),
            node_count: 100,
            matrix_nnz: None,
            cpu: FemCrossoverSampleDistribution {
                p50_seconds: 2.0,
                p95_seconds: 2.2,
                stddev_seconds: 0.1,
                count: 5,
            },
            gpu: FemCrossoverSampleDistribution {
                p50_seconds: 1.0,
                p95_seconds: 1.2,
                stddev_seconds: 0.1,
                count: 5,
            },
        };
        let mut profile = FemCrossoverProfileV1 {
            schema_version: FEM_CROSSOVER_SCHEMA_V1.to_string(),
            calibration_id: "test-calibration".to_string(),
            qualified: true,
            qualification_notes: Vec::new(),
            evidence_sources: vec!["test-fixture".to_string()],
            confidence: 0.95,
            warmup_runs: 1,
            repeat_runs: 5,
            runtime: identity(),
            strata: vec![FemCrossoverStratum {
                id: "exchange-no-preview".to_string(),
                demag_enabled: false,
                relaxation_algorithm: "llg_overdamped".to_string(),
                preview_enabled: false,
                requires_matrix_nnz: false,
                minimum_matrix_nnz: None,
                maximum_matrix_nnz: None,
                lower_node_count: 80,
                upper_node_count: 120,
                within_band_device: "gpu".to_string(),
                samples: vec![sample],
            }],
            signature: None,
            profile_sha256: String::new(),
        };
        profile.profile_sha256 = profile_payload_sha256(&profile);
        profile
    }

    fn features(node_count: u64) -> FemCrossoverFeatures {
        FemCrossoverFeatures {
            node_count,
            matrix_nnz: None,
            demag_enabled: false,
            relaxation_algorithm: "llg_overdamped".to_string(),
            preview_enabled: false,
        }
    }

    #[test]
    fn qualified_profile_selects_cpu_below_lower_bound_and_gpu_above_upper_bound() {
        let runtime = identity();
        let profile = validate_fem_crossover_profile(profile(), &runtime)
            .expect("matching qualified profile");

        let below = resolve_auto_fem_device(&features(79), Some(&profile));
        assert_eq!(below.resolved, "cpu");
        assert_eq!(below.calibration_id.as_deref(), Some("test-calibration"));

        let above = resolve_auto_fem_device(&features(121), Some(&profile));
        assert_eq!(above.resolved, "gpu");
        assert_eq!(above.calibration_id.as_deref(), Some("test-calibration"));
    }

    #[test]
    fn preview_mode_selects_only_the_matching_calibration_stratum() {
        let mut profile = profile();
        let mut preview_stratum = profile.strata[0].clone();
        preview_stratum.id = "exchange-preview".to_string();
        preview_stratum.preview_enabled = true;
        preview_stratum.within_band_device = "cpu".to_string();
        profile.strata.push(preview_stratum);

        let no_preview = resolve_auto_fem_device(&features(100), Some(&profile));
        let mut preview_features = features(100);
        preview_features.preview_enabled = true;
        let preview = resolve_auto_fem_device(&preview_features, Some(&profile));

        assert_eq!(no_preview.resolved, "gpu");
        assert_eq!(preview.resolved, "cpu");
    }

    #[test]
    fn pinned_decision_survives_profile_mutation_and_removal() {
        let mut mutable_profile = profile();
        let pinned = resolve_auto_fem_device(&features(79), Some(&mutable_profile));

        mutable_profile.strata[0].lower_node_count = 0;
        mutable_profile.strata[0].within_band_device = "gpu".to_string();
        drop(mutable_profile);

        assert_eq!(pinned.requested, "auto");
        assert_eq!(pinned.resolved, "cpu");
        assert_eq!(pinned.reason, "calibrated_below_lower_bound");
        assert_eq!(pinned.calibration_id.as_deref(), Some("test-calibration"));
        assert_eq!(pinned.confidence, Some(0.95));
    }

    #[test]
    fn invalid_profile_sha_is_rejected() {
        let runtime = identity();
        let mut profile = profile();
        profile.profile_sha256 = "bad".to_string();
        assert!(validate_fem_crossover_profile(profile, &runtime).is_err());
    }

    #[test]
    fn integrity_field_is_omitted_from_the_hashed_payload() {
        let mut payload = profile();
        payload.profile_sha256.clear();
        let json = serde_json::to_value(payload).expect("profile payload JSON");
        assert!(json.get("profile_sha256").is_none());
    }

    #[test]
    fn signature_is_omitted_from_the_unsigned_profile_hash() {
        let mut unsigned = profile();
        unsigned.signature = None;
        let unsigned_hash = profile_payload_sha256(&unsigned);
        unsigned.signature = Some("unverified-signature".to_string());
        assert_eq!(profile_payload_sha256(&unsigned), unsigned_hash);
    }

    #[test]
    fn non_null_signature_is_rejected_without_a_signing_policy() {
        let runtime = identity();
        let mut signed = profile();
        signed.signature = Some("unverified-signature".to_string());
        signed.profile_sha256 = profile_payload_sha256(&signed);
        let error = validate_fem_crossover_profile(signed, &runtime)
            .expect_err("schema v1 must reject unsupported signatures");
        assert!(error.contains("signature"));
    }

    #[test]
    fn matrix_nnz_bounds_are_inapplicable_without_an_operator_summary() {
        let mut profile = profile();
        profile.strata[0].minimum_matrix_nnz = Some(1);
        profile.profile_sha256 = profile_payload_sha256(&profile);

        let decision = resolve_auto_fem_device(&features(79), Some(&profile));
        assert_eq!(decision.resolved, "gpu");
        assert_eq!(
            decision.reason,
            "availability_first_gpu_profile_inapplicable"
        );
        assert_eq!(decision.calibration_id, None);
    }

    #[test]
    fn mismatched_gpu_identity_is_rejected() {
        let mut runtime = identity();
        runtime.hardware.gpu_uuid = "GPU-other".to_string();
        assert!(validate_fem_crossover_profile(profile(), &runtime).is_err());
    }

    #[test]
    fn mismatched_library_hashes_are_rejected() {
        let mut runtime = identity();
        runtime
            .library_sha256
            .insert("libmfem.so".to_string(), "mfem-other".to_string());
        assert!(validate_fem_crossover_profile(profile(), &runtime).is_err());
    }

    #[test]
    fn matching_caller_json_cannot_activate_without_authoritative_runtime_identity() {
        let _lock = ENV_LOCK.lock().expect("lock crossover profile environment");
        let directory = std::env::temp_dir().join(format!(
            "fullmag-fem-crossover-identity-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&directory).expect("create crossover identity test directory");
        let profile_path = directory.join("profile.json");
        let identity_path = directory.join("identity.json");
        std::fs::write(
            &profile_path,
            serde_json::to_vec(&profile()).expect("serialize crossover profile"),
        )
        .expect("write crossover profile");
        std::fs::write(
            &identity_path,
            serde_json::to_vec(&identity()).expect("serialize runtime identity"),
        )
        .expect("write runtime identity");
        let _profile_env = EnvRestore::set("FULLMAG_FEM_CROSSOVER_PROFILE", &profile_path);
        let _identity_env =
            EnvRestore::set("FULLMAG_FEM_CROSSOVER_RUNTIME_IDENTITY", &identity_path);

        assert!(
            load_qualified_profile_from_env().is_none(),
            "two matching caller-controlled JSON files must not establish runtime identity"
        );

        std::fs::remove_dir_all(directory).expect("remove crossover identity test directory");
    }

    #[test]
    fn caller_identity_cannot_override_a_different_authoritative_runtime() {
        let _lock = ENV_LOCK.lock().expect("lock crossover profile environment");
        let directory = std::env::temp_dir().join(format!(
            "fullmag-fem-crossover-authority-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&directory).expect("create crossover identity test directory");
        let profile_path = directory.join("profile.json");
        let identity_path = directory.join("identity.json");
        std::fs::write(
            &profile_path,
            serde_json::to_vec(&profile()).expect("serialize crossover profile"),
        )
        .expect("write crossover profile");
        std::fs::write(
            &identity_path,
            serde_json::to_vec(&identity()).expect("serialize caller runtime identity"),
        )
        .expect("write caller runtime identity");
        let _profile_env = EnvRestore::set("FULLMAG_FEM_CROSSOVER_PROFILE", &profile_path);
        let _identity_env =
            EnvRestore::set("FULLMAG_FEM_CROSSOVER_RUNTIME_IDENTITY", &identity_path);
        let mut authoritative_runtime = identity();
        authoritative_runtime.hardware.gpu_uuid = "GPU-actually-detected".to_string();

        assert!(
            load_qualified_profile_from_env_with_identity(Some(&authoritative_runtime)).is_none(),
            "caller identity must not replace identity derived from the executing runtime"
        );

        std::fs::remove_dir_all(directory).expect("remove crossover identity test directory");
    }

    #[test]
    fn checked_in_rtx4080_evidence_is_hash_valid_but_unqualified() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../benchmarks/fem-gpu/crossover/rtx4080-sm89.json");
        let bytes = std::fs::read(path).expect("checked-in crossover evidence");
        let profile: FemCrossoverProfileV1 =
            serde_json::from_slice(&bytes).expect("crossover evidence schema");
        assert_eq!(profile.profile_sha256, profile_payload_sha256(&profile));
        assert!(!profile.qualified);
        let runtime = profile.runtime.clone();
        assert!(validate_fem_crossover_profile(profile, &runtime).is_err());
    }
}
