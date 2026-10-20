//! Shared active-session authoring policy. This does not qualify an execution lane.

use fullmag_authoring::{
    CurrentTransportModel, KnownSceneCurrentTransport, KnownSceneSpinTransport, SceneDocument,
    SceneOerstedField, SceneSpinInterface, SceneSpinTorque, SceneSpinTransport,
    SceneSpinTransportMode, SceneTransportCoupling, SceneTransportDevice, SceneTransportPrecision,
};

use crate::schemas::authoring::{
    TransportExecutionCapability, TransportExecutionLane, TransportValidationCandidate,
};
use crate::schemas::status::{TransportAuthoringCapability, TransportAuthoringCapabilityMap};

pub(crate) fn transport_authoring_capabilities() -> TransportAuthoringCapabilityMap {
    let blocked = |reason: &str| TransportAuthoringCapability {
        status: "unsupported".into(),
        authoring_allowed: false,
        reason: reason.into(),
    };
    TransportAuthoringCapabilityMap {
        contract_version: "transport-authoring-capabilities.v1".into(),
        m1_one_way_steady: TransportAuthoringCapability {
            status: "semantic_only".into(), authoring_allowed: true,
            reason: "M1 steady one-way authoring is available; execution qualification remains workload-scoped.".into(),
        },
        m2_reciprocal: TransportAuthoringCapability {
            status: "semantic_only".into(), authoring_allowed: true,
            reason: "M2 reciprocal authoring is available; executable qualification remains workload-scoped.".into(),
        },
        m3_transient: blocked("Transient transport remains an M3 authoring capability."),
        gpu: blocked("Transport GPU authoring is unavailable until lane qualification is published."),
        single_precision: blocked("Transport single precision is unavailable until precision qualification is published."),
        hybrid: blocked("Transport hybrid execution is not supported by the v1 authoring contract."),
    }
}

fn result(
    status: &str,
    allowed: bool,
    reason: String,
    requested_lane: Option<TransportExecutionLane>,
) -> TransportExecutionCapability {
    TransportExecutionCapability {
        status: status.into(),
        qualification: status.into(),
        authoring_allowed: allowed,
        reason: Some(reason),
        requested_lane,
        resolved_lane: None,
    }
}

fn unsupported(reason: &str) -> TransportExecutionCapability {
    result("unsupported", false, reason.into(), None)
}

fn reciprocal(source: &KnownSceneCurrentTransport) -> bool {
    source.coupling == SceneTransportCoupling::Bidirectional
        || source.model == CurrentTransportModel::MagnetoresistivePoisson
}

type Requirement<'a> = (&'static str, &'a TransportAuthoringCapability);

fn spin_requirements<'a>(
    spin: &KnownSceneSpinTransport,
    source: Option<&KnownSceneCurrentTransport>,
    capabilities: &'a TransportAuthoringCapabilityMap,
) -> Vec<Requirement<'a>> {
    let mut required = Vec::new();
    let reciprocal = spin.constitutive_version == "transport_constitutive.reciprocal.fullmag.v1"
        || source.is_some_and(reciprocal);
    if reciprocal {
        required.push(("m2_reciprocal", &capabilities.m2_reciprocal));
    }
    if spin.mode == SceneSpinTransportMode::Transient {
        required.push(("m3_transient", &capabilities.m3_transient));
    } else if !reciprocal {
        required.push(("m1_one_way_steady", &capabilities.m1_one_way_steady));
    }
    if spin.requested_execution.device == SceneTransportDevice::Gpu {
        required.push(("gpu", &capabilities.gpu));
    }
    if spin.requested_execution.precision == SceneTransportPrecision::Single {
        required.push(("single_precision", &capabilities.single_precision));
    }
    // Hybrid is not in the current typed authoring enums. Unknown requests stay read-only.
    required
}

fn intersect(
    required: &[Requirement<'_>],
    requested: Option<TransportExecutionLane>,
) -> TransportExecutionCapability {
    let blocked: Vec<_> = required
        .iter()
        .filter(|(_, capability)| {
            !capability.authoring_allowed
                || !matches!(
                    capability.status.as_str(),
                    "semantic_only" | "source_visible"
                )
        })
        .collect();
    let allowed = blocked.is_empty();
    let reasons = if allowed {
        required.iter().collect::<Vec<_>>()
    } else {
        blocked
    };
    result(
        if allowed {
            "semantic_only"
        } else {
            "unsupported"
        },
        allowed,
        reasons
            .iter()
            .map(|(key, capability)| format!("{key}: {}", capability.reason))
            .collect::<Vec<_>>()
            .join(" "),
        requested,
    )
}

fn spin_capability(
    scene: &SceneDocument,
    resource: &SceneSpinTransport,
    capabilities: &TransportAuthoringCapabilityMap,
) -> TransportExecutionCapability {
    let Some(spin) = resource.known() else {
        return unsupported("Unknown spin transport variants are read-only.");
    };
    let source = scene
        .current_transports
        .iter()
        .filter_map(|item| item.known())
        .find(|source| source.name == spin.current_source_id);
    let request = serde_json::to_value(&spin.requested_execution).ok();
    let requested = request.and_then(|value| {
        Some(TransportExecutionLane {
            discretization: value.get("discretization")?.as_str()?.into(),
            device: value.get("device")?.as_str()?.into(),
            precision: value.get("precision")?.as_str()?.into(),
            execution_mode: value.get("execution_mode")?.as_str()?.into(),
        })
    });
    intersect(&spin_requirements(spin, source, capabilities), requested)
}

pub(crate) fn candidate_capability(
    scene: &SceneDocument,
    candidate: &TransportValidationCandidate,
) -> TransportExecutionCapability {
    let capabilities = transport_authoring_capabilities();
    match candidate {
        TransportValidationCandidate::CurrentTransport { resource, .. } => {
            let Some(source) = resource.known() else { return unsupported("Unknown current transport variants are read-only."); };
            if source.model == CurrentTransportModel::PrescribedDensity && source.coupling == SceneTransportCoupling::Bidirectional {
                return unsupported("M2 bidirectional coupling is unsupported for prescribed_density transport.");
            }
            let mut required = vec![if reciprocal(source) { ("m2_reciprocal", &capabilities.m2_reciprocal) } else { ("m1_one_way_steady", &capabilities.m1_one_way_steady) }];
            for spin in scene.spin_transports.iter().filter_map(|item| item.known()).filter(|spin| spin.current_source_id == source.name) {
                for requirement in spin_requirements(spin, Some(source), &capabilities) {
                    if !required.iter().any(|(key, _)| *key == requirement.0) {
                        required.push(requirement);
                    }
                }
            }
            intersect(&required, None)
        }
        TransportValidationCandidate::SpinTransport { resource, .. } => spin_capability(scene, resource, &capabilities),
        TransportValidationCandidate::SpinInterface { owner_spin_transport_id, resource, .. } => {
            if serde_json::from_value::<SceneSpinInterface>(resource.clone()).is_err() {
                return unsupported("Unknown spin interface variants are read-only.");
            }
            match scene.spin_transports.iter().find(|owner| owner.id() == Some(owner_spin_transport_id.as_str())) {
                Some(owner) => spin_capability(scene, owner, &capabilities),
                None => unsupported("The owning spin transport is unavailable."),
            }
        }
        TransportValidationCandidate::SpinTorque { resource, .. } => match resource {
            SceneSpinTorque::Known(_) => result("source_visible", true, "Typed torque authoring is available; execution qualification is variant-specific.".into(), None),
            SceneSpinTorque::Unsupported(_) => unsupported("Unknown spin torque variants are read-only."),
        },
        TransportValidationCandidate::OerstedField { resource, .. } => match resource {
            SceneOerstedField::Known(_) => result("source_visible", true, "Typed Oersted authoring is available; execution qualification is realization-specific.".into(), None),
            SceneOerstedField::Unsupported(_) => unsupported("Unknown Oersted field variants are read-only."),
        },
    }
}
