use crate::{
    AntennaFieldSourceModelIR, AntennaSpatialProfileIR, CurrentModuleIR, CurrentTransportModelIR,
    DriveActivationIR, DynamicsIR, EmptyPolicyIR, EnergyTermIR, FieldEnvelopeIR,
    FieldSpatialProfileIR, FieldTargetIR, MechanicalLoadIR, MechanicsIR, MonitorTargetIR,
    PlanarExtentIR, PlanarOperatorIR, ProblemIR, SpinTorqueModuleIR, StudyIR,
    SurfaceBoundarySelectorIR, TimeDependenceIR, PLANAR_FRAME_NORMALIZATION_VERSION,
};
use std::collections::BTreeSet;

pub(crate) fn vector3_is_finite(vector: &[f64; 3]) -> bool {
    vector.iter().all(|value| value.is_finite())
}

fn vector3_norm_sq(vector: &[f64; 3]) -> f64 {
    vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]
}

fn dot(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn validate_planar_monitors(problem: &ProblemIR, errors: &mut Vec<String>) {
    let magnet_names: BTreeSet<&str> = problem
        .magnets
        .iter()
        .map(|magnet| magnet.name.as_str())
        .collect();
    let region_ids: BTreeSet<(&str, &str)> = problem
        .object_regions
        .iter()
        .map(|region| (region.owner_object.as_str(), region.region_id.as_str()))
        .collect();
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();

    for (index, monitor) in problem.planar_monitors.iter().enumerate() {
        let label = format!("planar_monitors[{index}]");
        if monitor.id.trim().is_empty() || !ids.insert(monitor.id.as_str()) {
            errors.push(format!("{label} id must be non-empty and unique"));
        }
        if monitor.name.trim().is_empty() || !names.insert(monitor.name.as_str()) {
            errors.push(format!("{label} name must be non-empty and unique"));
        }

        match &monitor.target {
            MonitorTargetIR::MagneticDomain | MonitorTargetIR::Domain => {}
            MonitorTargetIR::Object { object_id } => {
                if !magnet_names.contains(object_id.as_str()) {
                    errors.push(format!(
                        "{label} target object '{object_id}' does not exist"
                    ));
                }
            }
            MonitorTargetIR::Region {
                object_id,
                region_id,
            } => {
                if !region_ids.contains(&(object_id.as_str(), region_id.as_str())) {
                    errors.push(format!(
                        "{label} target region '{object_id}/{region_id}' does not exist"
                    ));
                }
            }
        }

        let frame = &monitor.frame;
        if !vector3_is_finite(&frame.origin_m) {
            errors.push(format!("{label} frame origin_m must be finite"));
        }
        for (name, vector) in [
            ("u_axis", &frame.u_axis),
            ("v_axis", &frame.v_axis),
            ("normal", &frame.normal),
        ] {
            if !vector3_is_finite(vector) {
                errors.push(format!("{label} frame {name} must be finite"));
            } else if (vector3_norm_sq(vector).sqrt() - 1.0).abs() > 1e-12 {
                errors.push(format!("{label} frame {name} must be normalized"));
            }
        }
        if vector3_is_finite(&frame.u_axis)
            && vector3_is_finite(&frame.v_axis)
            && vector3_is_finite(&frame.normal)
        {
            for (a_name, a, b_name, b) in [
                ("u_axis", &frame.u_axis, "v_axis", &frame.v_axis),
                ("u_axis", &frame.u_axis, "normal", &frame.normal),
                ("v_axis", &frame.v_axis, "normal", &frame.normal),
            ] {
                if dot(a, b).abs() > 1e-12 {
                    errors.push(format!(
                        "{label} frame {a_name} and {b_name} must be orthogonal"
                    ));
                }
            }
            let cross_uv = [
                frame.u_axis[1] * frame.v_axis[2] - frame.u_axis[2] * frame.v_axis[1],
                frame.u_axis[2] * frame.v_axis[0] - frame.u_axis[0] * frame.v_axis[2],
                frame.u_axis[0] * frame.v_axis[1] - frame.u_axis[1] * frame.v_axis[0],
            ];
            if dot(&cross_uv, &frame.normal) < 1.0 - 1e-12 {
                errors.push(format!("{label} frame must be right-handed"));
            }
        }
        if frame.normalization_version != PLANAR_FRAME_NORMALIZATION_VERSION {
            errors.push(format!(
                "{label} frame normalization_version must be '{PLANAR_FRAME_NORMALIZATION_VERSION}'"
            ));
        }
        match &frame.extent {
            PlanarExtentIR::Explicit {
                u_min_m,
                u_max_m,
                v_min_m,
                v_max_m,
            } => {
                if !u_min_m.is_finite()
                    || !u_max_m.is_finite()
                    || !v_min_m.is_finite()
                    || !v_max_m.is_finite()
                    || u_min_m >= u_max_m
                {
                    errors.push(format!(
                        "{label} frame extent requires finite u_min_m < u_max_m"
                    ));
                }
                if v_min_m >= v_max_m {
                    errors.push(format!(
                        "{label} frame extent requires finite v_min_m < v_max_m"
                    ));
                }
            }
            PlanarExtentIR::TargetBounds { padding_m }
            | PlanarExtentIR::MagneticDomain { padding_m }
            | PlanarExtentIR::Universe { padding_m } => {
                if !padding_m.is_finite() || *padding_m < 0.0 {
                    errors.push(format!(
                        "{label} frame extent padding_m must be finite and >= 0"
                    ));
                }
            }
        }

        match &monitor.operator {
            PlanarOperatorIR::PlaneSample => {}
            PlanarOperatorIR::SlabAverage { thickness_m } => {
                if !thickness_m.is_finite() || *thickness_m <= 0.0 {
                    errors.push(format!(
                        "{label} slab_average thickness_m must be finite and > 0"
                    ));
                }
            }
            PlanarOperatorIR::DepthProjection {
                reduction,
                empty_policy,
            } => {
                if matches!(empty_policy, EmptyPolicyIR::IncludeAirAsZero)
                    && !matches!(reduction, crate::PlanarReductionIR::MeanOccupied)
                {
                    errors.push(format!(
                        "{label} include_air_as_zero is valid only for mean_occupied"
                    ));
                }
            }
            PlanarOperatorIR::SurfaceProjection { boundary, .. } => match boundary {
                SurfaceBoundarySelectorIR::ObjectBoundary => {}
                SurfaceBoundarySelectorIR::RegionBoundary { region_id } => {
                    if region_id.trim().is_empty() {
                        errors.push(format!("{label} surface region_id must not be empty"));
                    }
                }
                SurfaceBoundarySelectorIR::NamedSurface { surface_id } => {
                    if surface_id.trim().is_empty() {
                        errors.push(format!("{label} surface_id must not be empty"));
                    }
                }
            },
        }
    }
}

fn validate_time_dependence(label: &str, value: &TimeDependenceIR, errors: &mut Vec<String>) {
    match value {
        TimeDependenceIR::Constant => {}
        TimeDependenceIR::Sinusoidal {
            frequency_hz,
            phase_rad,
            offset,
        } => {
            if !frequency_hz.is_finite() || *frequency_hz <= 0.0 {
                errors.push(format!("{label} frequency_hz must be finite and > 0"));
            }
            if !phase_rad.is_finite() || !offset.is_finite() {
                errors.push(format!("{label} phase_rad and offset must be finite"));
            }
        }
        TimeDependenceIR::Pulse { t_on, t_off } => {
            if !t_on.is_finite() || !t_off.is_finite() || t_off <= t_on {
                errors.push(format!("{label} pulse requires finite t_off > t_on"));
            }
        }
        TimeDependenceIR::PiecewiseLinear { points } => {
            if points.len() < 2 {
                errors.push(format!(
                    "{label} piecewise_linear requires at least 2 points"
                ));
            }
            for point in points {
                if !point[0].is_finite() || !point[1].is_finite() {
                    errors.push(format!("{label} piecewise_linear points must be finite"));
                }
            }
            for window in points.windows(2) {
                if window[1][0] <= window[0][0] {
                    errors.push(format!(
                        "{label} piecewise_linear times must be strictly increasing"
                    ));
                }
            }
        }
        TimeDependenceIR::SincPulse {
            cutoff_hz,
            t0,
            amplitude,
        } => {
            if !cutoff_hz.is_finite() || *cutoff_hz <= 0.0 {
                errors.push(format!(
                    "{label} sinc_pulse cutoff_hz must be finite and > 0"
                ));
            }
            if !t0.is_finite() || *t0 < 0.0 || !amplitude.is_finite() {
                errors.push(format!(
                    "{label} sinc_pulse t0 must be finite and >= 0; amplitude must be finite"
                ));
            }
        }
    }
}

fn validate_field_sinc(
    label: &str,
    axis: &[f64; 3],
    period_m: f64,
    center_m: f64,
    width_m: Option<f64>,
    window: &str,
    errors: &mut Vec<String>,
) {
    if !vector3_is_finite(axis) || vector3_norm_sq(axis) <= 1e-30 {
        errors.push(format!("{label} axis must be finite and non-zero"));
    }
    if !period_m.is_finite() || period_m <= 0.0 {
        errors.push(format!("{label} period_m must be finite and > 0"));
    }
    if !center_m.is_finite() {
        errors.push(format!("{label} center_m must be finite"));
    }
    if width_m.is_some_and(|value| !value.is_finite() || value <= 0.0) {
        errors.push(format!("{label} width_m must be finite and > 0"));
    }
    if !matches!(window, "none" | "hann") {
        errors.push(format!("{label} window must be 'none' or 'hann'"));
    }
}

fn validate_field_spatial_profile(
    index: usize,
    profile: &FieldSpatialProfileIR,
    geometry_names: &BTreeSet<&str>,
    errors: &mut Vec<String>,
) {
    let label = format!("field_drives[{index}] spatial_profile");
    match profile {
        FieldSpatialProfileIR::Uniform {} => {}
        FieldSpatialProfileIR::Sinc {
            axis,
            period_m,
            center_m,
            width_m,
            window,
        } => {
            validate_field_sinc(&label, axis, *period_m, *center_m, *width_m, window, errors);
        }
        FieldSpatialProfileIR::GeometryMask {
            object_id,
            envelope,
        } => {
            if !geometry_names.contains(object_id.as_str()) {
                errors.push(format!(
                    "{label} geometry mask object '{object_id}' does not exist"
                ));
            }
            if let FieldEnvelopeIR::Sinc {
                axis,
                period_m,
                center_m,
                width_m,
                window,
            } = envelope
            {
                validate_field_sinc(
                    format!("{label} envelope").as_str(),
                    axis,
                    *period_m,
                    *center_m,
                    *width_m,
                    window,
                    errors,
                );
            }
        }
    }
}

pub(crate) fn validate_field_drives(problem: &ProblemIR, errors: &mut Vec<String>) {
    let magnet_names: BTreeSet<&str> = problem
        .magnets
        .iter()
        .map(|magnet| magnet.name.as_str())
        .collect();
    let geometry_names: BTreeSet<&str> = problem
        .geometry
        .entries
        .iter()
        .map(|geometry| geometry.name())
        .collect();
    let region_ids: BTreeSet<(&str, &str)> = problem
        .object_regions
        .iter()
        .map(|region| (region.owner_object.as_str(), region.region_id.as_str()))
        .collect();
    let pipeline_stage_ids: BTreeSet<&str> = problem
        .problem_meta
        .runtime_metadata
        .get("study_pipeline")
        .and_then(|value| value.get("nodes"))
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|node| node.get("id").and_then(|value| value.as_str()))
        .collect();
    let active_stage_id = problem
        .problem_meta
        .runtime_metadata
        .get("active_stage_id")
        .and_then(|value| value.as_str());
    if let Some(value) = problem
        .problem_meta
        .runtime_metadata
        .get("stage_start_time_s")
    {
        if value
            .as_f64()
            .is_none_or(|time| !time.is_finite() || time < 0.0)
        {
            errors.push(
                "runtime_metadata.stage_start_time_s must be finite and non-negative".to_string(),
            );
        }
    }
    if let Some(stage_id) = active_stage_id {
        if stage_id.trim().is_empty() || !pipeline_stage_ids.contains(stage_id) {
            errors.push(format!(
                "runtime_metadata.active_stage_id '{stage_id}' does not identify an enabled study pipeline stage"
            ));
        }
    }
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();

    for (index, drive) in problem.field_drives.iter().enumerate() {
        if drive.id.trim().is_empty() || !ids.insert(drive.id.as_str()) {
            errors.push(format!(
                "field_drives[{index}] id must be non-empty and unique"
            ));
        }
        if drive.name.trim().is_empty() || !names.insert(drive.name.as_str()) {
            errors.push(format!(
                "field_drives[{index}] name must be non-empty and unique"
            ));
        }
        if !drive.amplitude_b_t.is_finite() || drive.amplitude_b_t < 0.0 {
            errors.push(format!(
                "field_drives[{index}] amplitude_B_T must be finite and >= 0"
            ));
        }
        if !vector3_is_finite(&drive.direction) || vector3_norm_sq(&drive.direction) <= 1e-30 {
            errors.push(format!(
                "field_drives[{index}] direction must be finite and non-zero"
            ));
        } else if (vector3_norm_sq(&drive.direction).sqrt() - 1.0).abs() > 1e-12 {
            errors.push(format!(
                "field_drives[{index}] direction must be normalized"
            ));
        }
        match &drive.target {
            FieldTargetIR::Global {} => {}
            FieldTargetIR::Object { object_id } => {
                if !magnet_names.contains(object_id.as_str()) {
                    errors.push(format!(
                        "field_drives[{index}] target object '{object_id}' does not exist"
                    ));
                }
            }
            FieldTargetIR::Region {
                object_id,
                region_id,
            } => {
                if !region_ids.contains(&(object_id.as_str(), region_id.as_str())) {
                    errors.push(format!("field_drives[{index}] target region '{object_id}/{region_id}' does not exist"));
                }
            }
        }
        validate_field_spatial_profile(index, &drive.spatial_profile, &geometry_names, errors);
        validate_time_dependence(
            format!("field_drives[{index}] waveform").as_str(),
            &drive.waveform,
            errors,
        );
        let active_in_current_stage = match (&drive.activation, active_stage_id) {
            (DriveActivationIR::AllTimeEvolution {}, _) => {
                matches!(problem.study, StudyIR::TimeEvolution { .. })
            }
            (DriveActivationIR::StageIds { stage_ids }, Some(active)) => {
                stage_ids.iter().any(|stage_id| stage_id == active)
            }
            (DriveActivationIR::StageIds { .. }, None) => false,
        };
        if active_in_current_stage
            && matches!(problem.study, StudyIR::Relaxation { .. })
            && !matches!(drive.waveform, TimeDependenceIR::Constant)
        {
            errors.push(format!(
                "field_drives[{index}] dynamic waveform is invalid in a minimizer/relaxation stage"
            ));
        }
        if let DriveActivationIR::StageIds { stage_ids } = &drive.activation {
            if stage_ids.is_empty() {
                errors.push(format!(
                    "field_drives[{index}] activation.stage_ids must not be empty"
                ));
            }
            let mut local_ids = BTreeSet::new();
            for stage_id in stage_ids {
                if stage_id.trim().is_empty() || !local_ids.insert(stage_id.as_str()) {
                    errors.push(format!(
                        "field_drives[{index}] activation stage ids must be non-empty and unique"
                    ));
                }
                if !pipeline_stage_ids.contains(stage_id.as_str()) {
                    errors.push(format!(
                        "field_drives[{index}] activation stage id '{stage_id}' does not exist"
                    ));
                }
            }
        }
        if drive
            .migration
            .as_ref()
            .is_some_and(|migration| migration.migrated_from != "prescribed_zeeman_mask")
        {
            errors.push(format!(
                "field_drives[{index}] migration.migrated_from is unsupported"
            ));
        }
    }

    let legacy_names: BTreeSet<&str> = problem
        .current_modules
        .iter()
        .filter_map(|module| match module {
            CurrentModuleIR::AntennaFieldSource {
                name,
                model: AntennaFieldSourceModelIR::PrescribedZeemanMask,
                ..
            } => Some(name.as_str()),
            _ => None,
        })
        .collect();
    for name in ids.intersection(&legacy_names) {
        errors.push(format!(
            "field drive '{name}' collides with legacy prescribed_zeeman_mask"
        ));
    }
}

pub(crate) fn validate_spin_wave_response_request(problem: &ProblemIR, errors: &mut Vec<String>) {
    let Some(request) = problem
        .problem_meta
        .runtime_metadata
        .get("spin_wave_response")
    else {
        return;
    };
    let Some(request) = request.as_object() else {
        errors.push("runtime_metadata.spin_wave_response must be an object".into());
        return;
    };
    if request
        .get("schema_version")
        .and_then(|value| value.as_str())
        != Some("spin_wave_response.request.v1")
    {
        errors.push("runtime_metadata.spin_wave_response.schema_version must be 'spin_wave_response.request.v1'".into());
    }
    let analysis = request.get("analysis").and_then(|value| value.as_str());
    if !matches!(analysis, Some("gamma" | "finite_k")) {
        errors.push(
            "runtime_metadata.spin_wave_response.analysis must be 'gamma' or 'finite_k'".into(),
        );
    }
    let response_component = request
        .get("response_component")
        .and_then(|value| value.as_str())
        .unwrap_or("my");
    if analysis == Some("gamma") && !matches!(response_component, "my" | "mz") {
        errors.push("runtime_metadata.spin_wave_response.response_component must be my or mz for transverse S_Gamma".into());
    } else if analysis == Some("finite_k") && !matches!(response_component, "mx" | "my" | "mz") {
        errors.push(
            "runtime_metadata.spin_wave_response.response_component must be mx, my, or mz".into(),
        );
    }
    if !matches!(
        request
            .get("detrend")
            .and_then(|value| value.as_str())
            .unwrap_or("none"),
        "none" | "mean" | "linear"
    ) {
        errors.push(
            "runtime_metadata.spin_wave_response.detrend must be none, mean, or linear".into(),
        );
    }
    if request
        .get("susceptibility_floor_fraction")
        .and_then(|value| value.as_f64())
        .is_some_and(|value| !value.is_finite() || !(0.0..1.0).contains(&value))
    {
        errors.push("runtime_metadata.spin_wave_response.susceptibility_floor_fraction must be finite in [0,1)".into());
    }
    if analysis == Some("gamma")
        && !problem.field_drives.iter().any(|drive| {
            drive.enabled
                && matches!(drive.target, FieldTargetIR::Global {})
                && matches!(drive.spatial_profile, FieldSpatialProfileIR::Uniform {})
        })
    {
        errors
            .push("gamma spin-wave analysis requires an enabled global uniform field drive".into());
    }
    if analysis == Some("finite_k") {
        if request
            .get("probe_count")
            .and_then(|value| value.as_u64())
            .is_some_and(|value| !(4..=2048).contains(&value))
        {
            errors.push("finite_k spin-wave analysis probe_count must be in 4..=2048".into());
        }
        if !problem.field_drives.iter().any(|drive| {
            drive.enabled
                && (!matches!(drive.target, FieldTargetIR::Global {})
                    || matches!(
                        drive.spatial_profile,
                        FieldSpatialProfileIR::GeometryMask { .. }
                    ))
        }) {
            errors.push("finite_k spin-wave analysis requires an enabled localized field drive target or geometry mask".into());
        }
    }
}

fn validate_antenna_spatial_profile(
    index: usize,
    profile: &AntennaSpatialProfileIR,
    errors: &mut Vec<String>,
) {
    match profile {
        AntennaSpatialProfileIR::Uniform => {}
        AntennaSpatialProfileIR::Sinc {
            axis,
            period_m,
            width_m,
            center_m,
            ..
        } => {
            if !vector3_is_finite(axis) || vector3_norm_sq(axis) <= 1e-30 {
                errors.push(format!(
                    "current_modules[{index}] antenna_field_source sinc spatial_profile axis must be finite and non-zero"
                ));
            }
            if *period_m <= 0.0 {
                errors.push(format!(
                    "current_modules[{index}] antenna_field_source sinc spatial_profile period_m must be > 0"
                ));
            }
            if let Some(width_m) = width_m {
                if *width_m <= 0.0 {
                    errors.push(format!(
                        "current_modules[{index}] antenna_field_source sinc spatial_profile width_m must be > 0"
                    ));
                }
            }
            if center_m.is_some_and(|value| !value.is_finite()) {
                errors.push(format!(
                    "current_modules[{index}] antenna_field_source sinc spatial_profile center_m must be finite"
                ));
            }
        }
    }
}

pub(crate) fn current_module_name(module: &CurrentModuleIR) -> &str {
    match module {
        CurrentModuleIR::AntennaFieldSource { name, .. }
        | CurrentModuleIR::CurrentTransport { name, .. } => name.as_str(),
    }
}

pub(crate) fn current_transport_exists(problem: &ProblemIR, name: &str) -> bool {
    problem.current_modules.iter().any(|module| {
        matches!(
            module,
            CurrentModuleIR::CurrentTransport { name: module_name, .. } if module_name == name
        )
    })
}

pub(crate) fn validate_oersted_energy_terms(problem: &ProblemIR, errors: &mut Vec<String>) {
    let mut oersted_term_count = 0usize;

    for (index, term) in problem.energy_terms.iter().enumerate() {
        match term {
            EnergyTermIR::OerstedCylinder {
                current,
                radius,
                center,
                axis,
                ..
            } => {
                oersted_term_count += 1;
                if !current.is_finite() {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_cylinder current must be finite"
                    ));
                }
                if *radius <= 0.0 {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_cylinder radius must be > 0"
                    ));
                }
                if !vector3_is_finite(center) {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_cylinder center must contain finite values"
                    ));
                }
                if !vector3_is_finite(axis) {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_cylinder axis must contain finite values"
                    ));
                } else {
                    let norm_sq = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
                    if norm_sq <= 1e-30 {
                        errors.push(format!(
                            "energy_terms[{index}] oersted_cylinder axis must be non-zero"
                        ));
                    }
                }
            }
            EnergyTermIR::OerstedField { source, .. } => {
                oersted_term_count += 1;
                if source.trim().is_empty() {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_field source must not be empty"
                    ));
                } else if !current_transport_exists(problem, source) {
                    errors.push(format!(
                        "energy_terms[{index}] oersted_field source '{}' must reference a current_transport module",
                        source
                    ));
                }
            }
            _ => {}
        }
    }

    if oersted_term_count > 1 {
        errors.push(
            "at most one executable Oersted energy term is currently supported; use a single OerstedCylinder or OerstedField"
                .to_string(),
        );
    }
}

pub(crate) fn validate_dmi_energy_terms(problem: &ProblemIR, errors: &mut Vec<String>) {
    for (index, term) in problem.energy_terms.iter().enumerate() {
        match term {
            EnergyTermIR::InterfacialDmi {
                d,
                interface_normal,
            } => {
                if !d.is_finite() {
                    errors.push(format!(
                        "energy_terms[{index}] interfacial_dmi D must be finite"
                    ));
                }
                if let Some(normal) = interface_normal {
                    if !vector3_is_finite(normal) {
                        errors.push(format!(
                            "energy_terms[{index}] interfacial_dmi interface_normal must contain finite values"
                        ));
                    } else {
                        let norm_sq =
                            normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2];
                        if norm_sq <= 1e-30 {
                            errors.push(format!(
                                "energy_terms[{index}] interfacial_dmi interface_normal must be non-zero"
                            ));
                        }
                    }
                }
            }
            EnergyTermIR::BulkDmi { d } => {
                if !d.is_finite() {
                    errors.push(format!("energy_terms[{index}] bulk_dmi D must be finite"));
                }
            }
            _ => {}
        }
    }
}

pub(crate) fn validate_material_dmi_values(problem: &ProblemIR, errors: &mut Vec<String>) {
    for material in &problem.materials {
        if material
            .interfacial_dmi
            .is_some_and(|value| !value.is_finite())
        {
            errors.push(format!(
                "material '{}' interfacial_dmi must be finite",
                material.name
            ));
        }
        if material.bulk_dmi.is_some_and(|value| !value.is_finite()) {
            errors.push(format!(
                "material '{}' bulk_dmi must be finite",
                material.name
            ));
        }
        if material
            .dind_field
            .as_ref()
            .is_some_and(|values| values.iter().any(|value| !value.is_finite()))
        {
            errors.push(format!(
                "material '{}' dind_field must contain finite values",
                material.name
            ));
        }
        if material
            .dbulk_field
            .as_ref()
            .is_some_and(|values| values.iter().any(|value| !value.is_finite()))
        {
            errors.push(format!(
                "material '{}' dbulk_field must contain finite values",
                material.name
            ));
        }
    }
}

pub(crate) fn validate_current_modules(problem: &ProblemIR, errors: &mut Vec<String>) {
    for (index, module) in problem.current_modules.iter().enumerate() {
        match module {
            CurrentModuleIR::AntennaFieldSource {
                model,
                solver,
                antenna,
                drive,
                air_box_factor,
                object,
                field,
                spatial_profile,
                waveform,
                ..
            } => match model {
                AntennaFieldSourceModelIR::Mqs2p5dAz => {
                    if solver.as_ref().is_some_and(|value| value.trim().is_empty()) {
                        errors.push(format!(
                            "current_modules[{index}] antenna_field_source solver must not be empty"
                        ));
                    }
                    if antenna.is_none() {
                        errors.push(format!(
                            "current_modules[{index}] antenna_field_source mqs_2p5d_az requires antenna"
                        ));
                    }
                    if drive.is_none() {
                        errors.push(format!(
                            "current_modules[{index}] antenna_field_source mqs_2p5d_az requires drive"
                        ));
                    }
                    if let Some(air_box_factor) = air_box_factor {
                        if *air_box_factor <= 0.0 {
                            errors.push(format!(
                                "current_modules[{index}] antenna_field_source air_box_factor must be > 0"
                            ));
                        }
                    }
                }
                AntennaFieldSourceModelIR::PrescribedZeemanMask => {
                    if object
                        .as_ref()
                        .map_or(true, |value| value.trim().is_empty())
                    {
                        errors.push(format!(
                            "current_modules[{index}] antenna_field_source prescribed_zeeman_mask requires object"
                        ));
                    }
                    match field {
                        Some(field) => {
                            if !field.amplitude_b_t.is_finite() {
                                errors.push(format!(
                                    "current_modules[{index}] antenna_field_source prescribed_zeeman_mask amplitude_B_T must be finite"
                                ));
                            }
                            if !vector3_is_finite(&field.direction) {
                                errors.push(format!(
                                    "current_modules[{index}] antenna_field_source prescribed_zeeman_mask direction must contain finite values"
                                ));
                            } else if vector3_norm_sq(&field.direction) <= 1e-30 {
                                errors.push(format!(
                                    "current_modules[{index}] antenna_field_source prescribed_zeeman_mask direction must be non-zero"
                                ));
                            }
                        }
                        None => errors.push(format!(
                            "current_modules[{index}] antenna_field_source prescribed_zeeman_mask requires field"
                        )),
                    }
                    if antenna.is_some()
                        || drive.is_some()
                        || solver.is_some()
                        || air_box_factor.is_some()
                    {
                        errors.push(format!(
                            "current_modules[{index}] antenna_field_source prescribed_zeeman_mask must not define solver, antenna, drive, or air_box_factor"
                        ));
                    }
                    if let Some(profile) = spatial_profile {
                        validate_antenna_spatial_profile(index, profile, errors);
                    }
                    if let Some(waveform) = waveform {
                        validate_time_dependence(
                            format!(
                                "current_modules[{index}] antenna_field_source prescribed_zeeman_mask waveform"
                            )
                            .as_str(),
                            waveform,
                            errors,
                        );
                    }
                }
            },
            CurrentModuleIR::CurrentTransport {
                model,
                current_density,
                solve_region,
                conductivity_s_per_m,
                ..
            } => {
                if let Some(region) = solve_region {
                    if region.trim().is_empty() {
                        errors.push(format!(
                            "current_modules[{index}] current_transport solve_region must not be empty"
                        ));
                    }
                }
                if let Some(conductivity) = conductivity_s_per_m {
                    if *conductivity <= 0.0 {
                        errors.push(format!(
                            "current_modules[{index}] current_transport conductivity_s_per_m must be > 0"
                        ));
                    }
                }
                match model {
                    CurrentTransportModelIR::PrescribedDensity => match current_density {
                        Some(current_density) => {
                            if !vector3_is_finite(current_density) {
                                errors.push(format!(
                                    "current_modules[{index}] current_transport current_density must contain finite values"
                                ));
                            }
                        }
                        None => errors.push(format!(
                            "current_modules[{index}] current_transport prescribed_density requires current_density"
                        )),
                    },
                    CurrentTransportModelIR::OhmicPoisson => {
                        if current_density.is_some() {
                            errors.push(format!(
                                "current_modules[{index}] current_transport ohmic_poisson must not define current_density"
                            ));
                        }
                    }
                }
            }
        }
    }
}

pub(crate) fn validate_legacy_spin_torque_fields(problem: &ProblemIR, errors: &mut Vec<String>) {
    let has_legacy = problem.current_density.is_some()
        || problem.stt_degree.is_some()
        || problem.stt_beta.is_some()
        || problem.stt_spin_polarization.is_some()
        || problem.stt_lambda.is_some()
        || problem.stt_epsilon_prime.is_some();
    if !has_legacy {
        return;
    }

    if problem.current_density.is_none() {
        errors.push("legacy STT fields require current_density".to_string());
    }
    if let Some(current_density) = problem.current_density {
        if !vector3_is_finite(&current_density) {
            errors.push("legacy STT current_density must contain finite values".to_string());
        }
    }
    if let Some(degree) = problem.stt_degree {
        if !(0.0 < degree && degree <= 1.0) {
            errors.push("legacy STT stt_degree must be in (0, 1]".to_string());
        }
    }
    if let Some(beta) = problem.stt_beta {
        if beta < 0.0 {
            errors.push("legacy STT stt_beta must be >= 0".to_string());
        }
    }
    if let Some(spin_polarization) = problem.stt_spin_polarization {
        if !vector3_is_finite(&spin_polarization) {
            errors.push("legacy STT stt_spin_polarization must contain finite values".to_string());
        }
    }
    if let Some(lambda_asymmetry) = problem.stt_lambda {
        if lambda_asymmetry < 1.0 {
            errors.push("legacy STT stt_lambda must be >= 1".to_string());
        }
    }
    if problem.stt_thickness.is_some_and(|value| value <= 0.0) {
        errors.push("legacy STT stt_thickness must be > 0".to_string());
    }
    if let Some(position) = problem.stt_fixed_layer_position.as_deref() {
        if !matches!(position, "top" | "bottom") {
            errors
                .push("legacy STT stt_fixed_layer_position must be 'top' or 'bottom'".to_string());
        }
    }
    if problem.stt_spin_polarization.is_some()
        && (problem.stt_beta.is_some() || problem.stt_lambda.is_none())
    {
        errors.push(
            "legacy STT fields mix Zhang-Li and Slonczewski parameters; use spin_torque_modules for explicit families".to_string(),
        );
    }
}

pub(crate) fn validate_spin_torque_modules(problem: &ProblemIR, errors: &mut Vec<String>) {
    let validate_vector_binding = |index: usize,
                                   label: &str,
                                   current_density: &Option<[f64; 3]>,
                                   current_source: &Option<String>,
                                   errors: &mut Vec<String>| {
        match (current_density, current_source.as_deref()) {
                (Some(current_density), None) => {
                    if !vector3_is_finite(current_density) {
                        errors.push(format!(
                            "spin_torque_modules[{index}] {label} current_density must contain finite values"
                        ));
                    }
                }
                (None, Some(source)) => {
                    if source.trim().is_empty() {
                        errors.push(format!(
                            "spin_torque_modules[{index}] {label} current_source must not be empty"
                        ));
                    } else if !current_transport_exists(problem, source) {
                        errors.push(format!(
                            "spin_torque_modules[{index}] {label} current_source '{}' must reference a current_transport module",
                            source
                        ));
                    }
                }
                (Some(_), Some(_)) => errors.push(format!(
                    "spin_torque_modules[{index}] {label} must use either current_density or current_source, not both"
                )),
                (None, None) => errors.push(format!(
                    "spin_torque_modules[{index}] {label} requires one of current_density or current_source"
                )),
            }
    };

    for (index, module) in problem.spin_torque_modules.iter().enumerate() {
        match module {
            SpinTorqueModuleIR::Slonczewski {
                current_density,
                current_source,
                degree,
                spin_polarization,
                lambda_asymmetry,
                free_layer_thickness_m,
                fixed_layer_position,
                ..
            } => {
                validate_vector_binding(
                    index,
                    "slonczewski",
                    current_density,
                    current_source,
                    errors,
                );
                if !vector3_is_finite(spin_polarization) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski spin_polarization must contain finite values"
                    ));
                }
                if !(0.0 < *degree && *degree <= 1.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski degree must be in (0, 1]"
                    ));
                }
                if *lambda_asymmetry < 1.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski lambda_asymmetry must be >= 1"
                    ));
                }
                if free_layer_thickness_m.is_some_and(|value| value <= 0.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski free_layer_thickness_m must be > 0"
                    ));
                }
                if let Some(position) = fixed_layer_position.as_deref() {
                    if !matches!(position, "top" | "bottom") {
                        errors.push(format!(
                            "spin_torque_modules[{index}] slonczewski fixed_layer_position must be 'top' or 'bottom'"
                        ));
                    }
                }
            }
            SpinTorqueModuleIR::ZhangLi {
                current_density,
                current_source,
                degree,
                beta,
            } => {
                validate_vector_binding(index, "zhang_li", current_density, current_source, errors);
                if !(0.0 < *degree && *degree <= 1.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] zhang_li degree must be in (0, 1]"
                    ));
                }
                if *beta < 0.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] zhang_li beta must be >= 0"
                    ));
                }
            }
            SpinTorqueModuleIR::InterfaceCpp {
                current_density,
                current_source,
                degree,
                spin_polarization,
                interface_normal,
                lambda_asymmetry,
                ..
            } => {
                validate_vector_binding(
                    index,
                    "interface_cpp",
                    current_density,
                    current_source,
                    errors,
                );
                if !vector3_is_finite(spin_polarization) || !vector3_is_finite(interface_normal) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] interface_cpp vectors must contain finite values"
                    ));
                }
                if !(0.0 < *degree && *degree <= 1.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] interface_cpp degree must be in (0, 1]"
                    ));
                }
                if *lambda_asymmetry < 1.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] interface_cpp lambda_asymmetry must be >= 1"
                    ));
                }
            }
            SpinTorqueModuleIR::DriftDiffusion {
                current_density,
                current_source,
                degree,
                spin_polarization,
                beta,
                spin_diffusion_length_m,
            } => {
                validate_vector_binding(
                    index,
                    "drift_diffusion",
                    current_density,
                    current_source,
                    errors,
                );
                if !vector3_is_finite(spin_polarization) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] drift_diffusion vectors must contain finite values"
                    ));
                }
                if !(0.0 < *degree && *degree <= 1.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] drift_diffusion degree must be in (0, 1]"
                    ));
                }
                if *beta < 0.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] drift_diffusion beta must be >= 0"
                    ));
                }
                if *spin_diffusion_length_m <= 0.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] drift_diffusion spin_diffusion_length_m must be > 0"
                    ));
                }
            }
            SpinTorqueModuleIR::SpinOrbitTorque {
                charge_current_density_a_per_m2,
                current_source,
                spin_polarization,
                ferromagnet_thickness_m,
                ..
            } => {
                match (charge_current_density_a_per_m2, current_source.as_deref()) {
                    (Some(current_density), None) => {
                        if *current_density <= 0.0 {
                            errors.push(format!(
                                "spin_torque_modules[{index}] spin_orbit_torque charge_current_density_a_per_m2 must be > 0"
                            ));
                        }
                    }
                    (None, Some(source)) => {
                        if source.trim().is_empty() {
                            errors.push(format!(
                                "spin_torque_modules[{index}] spin_orbit_torque current_source must not be empty"
                            ));
                        } else if !current_transport_exists(problem, source) {
                            errors.push(format!(
                                "spin_torque_modules[{index}] spin_orbit_torque current_source '{}' must reference a current_transport module",
                                source
                            ));
                        }
                    }
                    (Some(_), Some(_)) => errors.push(format!(
                        "spin_torque_modules[{index}] spin_orbit_torque must use either charge_current_density_a_per_m2 or current_source, not both"
                    )),
                    (None, None) => errors.push(format!(
                        "spin_torque_modules[{index}] spin_orbit_torque requires one of charge_current_density_a_per_m2 or current_source"
                    )),
                }
                if !vector3_is_finite(spin_polarization) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] spin_orbit_torque spin_polarization must contain finite values"
                    ));
                }
                if *ferromagnet_thickness_m <= 0.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] spin_orbit_torque ferromagnet_thickness_m must be > 0"
                    ));
                }
            }
        }
    }

    if problem.spin_torque_modules.len() > 1 {
        let has_legacy = problem.current_density.is_some()
            || problem.stt_degree.is_some()
            || problem.stt_beta.is_some()
            || problem.stt_spin_polarization.is_some()
            || problem.stt_lambda.is_some()
            || problem.stt_epsilon_prime.is_some();
        if has_legacy {
            errors.push(
                "legacy STT fields cannot represent more than one spin_torque_modules entry"
                    .to_string(),
            );
        }
    }
}

pub(crate) fn validate_magnetoelastic(problem: &ProblemIR, errors: &mut Vec<String>) {
    validate_unique_names(
        problem
            .elastic_materials
            .iter()
            .map(|material| material.name.as_str()),
        "elastic_materials",
        errors,
    );
    validate_unique_names(
        problem.elastic_bodies.iter().map(|body| body.name.as_str()),
        "elastic_bodies",
        errors,
    );
    validate_unique_names(
        problem.magnetostriction_laws.iter().map(|law| law.name()),
        "magnetostriction_laws",
        errors,
    );

    for (index, material) in problem.elastic_materials.iter().enumerate() {
        if material.name.trim().is_empty() {
            errors.push(format!("elastic_materials[{index}].name must not be empty"));
        }
        if !(material.c11.is_finite() && material.c11 > 0.0) {
            errors.push(format!(
                "elastic_materials[{index}].c11 must be finite and > 0"
            ));
        }
        if !material.c12.is_finite() {
            errors.push(format!("elastic_materials[{index}].c12 must be finite"));
        }
        if !(material.c44.is_finite() && material.c44 > 0.0) {
            errors.push(format!(
                "elastic_materials[{index}].c44 must be finite and > 0"
            ));
        }
        if !(material.density.is_finite() && material.density > 0.0) {
            errors.push(format!(
                "elastic_materials[{index}].density must be finite and > 0"
            ));
        }
        if material
            .mechanical_damping
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            errors.push(format!(
                "elastic_materials[{index}].mechanical_damping must be finite and >= 0 when provided"
            ));
        }
    }

    let geometry_names: BTreeSet<&str> = problem
        .geometry
        .entries
        .iter()
        .map(|entry| entry.name())
        .collect();
    let elastic_material_names: BTreeSet<&str> = problem
        .elastic_materials
        .iter()
        .map(|material| material.name.as_str())
        .collect();
    for (index, body) in problem.elastic_bodies.iter().enumerate() {
        if body.name.trim().is_empty() {
            errors.push(format!("elastic_bodies[{index}].name must not be empty"));
        }
        if !geometry_names.contains(body.geometry.as_str()) {
            errors.push(format!(
                "elastic_bodies[{index}] references unknown geometry '{}'",
                body.geometry
            ));
        }
        if !elastic_material_names.contains(body.elastic_material.as_str()) {
            errors.push(format!(
                "elastic_bodies[{index}] references unknown elastic material '{}'",
                body.elastic_material
            ));
        }
    }

    for (index, law) in problem.magnetostriction_laws.iter().enumerate() {
        if law.name().trim().is_empty() {
            errors.push(format!(
                "magnetostriction_laws[{index}].name must not be empty"
            ));
        }
        match law {
            crate::MagnetostrictionLawIR::Cubic { b1, b2, .. } => {
                if !b1.is_finite() {
                    errors.push(format!("magnetostriction_laws[{index}].b1 must be finite"));
                }
                if !b2.is_finite() {
                    errors.push(format!("magnetostriction_laws[{index}].b2 must be finite"));
                }
            }
            crate::MagnetostrictionLawIR::Isotropic { lambda_s, .. } => {
                if !lambda_s.is_finite() {
                    errors.push(format!(
                        "magnetostriction_laws[{index}].lambda_s must be finite"
                    ));
                }
            }
        }
    }

    for (index, load) in problem.mechanical_loads.iter().enumerate() {
        match load {
            MechanicalLoadIR::BodyForce { f } => {
                if !vector3_is_finite(f) {
                    errors.push(format!(
                        "mechanical_loads[{index}].f must contain finite values"
                    ));
                }
            }
            MechanicalLoadIR::PrescribedStrain { strain } => {
                if strain.iter().any(|value| !value.is_finite()) {
                    errors.push(format!(
                        "mechanical_loads[{index}].strain must contain finite values"
                    ));
                }
            }
            MechanicalLoadIR::PrescribedStress { stress } => {
                if stress.iter().any(|value| !value.is_finite()) {
                    errors.push(format!(
                        "mechanical_loads[{index}].stress must contain finite values"
                    ));
                }
            }
        }
    }

    let magnet_names: BTreeSet<&str> = problem
        .magnets
        .iter()
        .map(|magnet| magnet.name.as_str())
        .collect();
    let body_names: BTreeSet<&str> = problem
        .elastic_bodies
        .iter()
        .map(|body| body.name.as_str())
        .collect();
    let law_names: BTreeSet<&str> = problem
        .magnetostriction_laws
        .iter()
        .map(|law| law.name())
        .collect();
    let has_magnetoelastic = problem
        .energy_terms
        .iter()
        .any(|term| matches!(term, EnergyTermIR::Magnetoelastic { .. }));

    for (index, term) in problem.energy_terms.iter().enumerate() {
        if let EnergyTermIR::Magnetoelastic { magnet, body, law } = term {
            if !magnet_names.contains(magnet.as_str()) {
                errors.push(format!(
                    "energy_terms[{index}] magnetoelastic references unknown magnet '{}'",
                    magnet
                ));
            }
            if !body_names.contains(body.as_str()) {
                errors.push(format!(
                    "energy_terms[{index}] magnetoelastic references unknown elastic body '{}'",
                    body
                ));
            }
            if !law_names.contains(law.as_str()) {
                errors.push(format!(
                    "energy_terms[{index}] magnetoelastic references unknown magnetostriction law '{}'",
                    law
                ));
            }
        }
    }

    let mechanics = match &problem.study {
        crate::StudyIR::TimeEvolution { dynamics, .. }
        | crate::StudyIR::Eigenmodes { dynamics, .. }
        | crate::StudyIR::FrequencyResponse { dynamics, .. } => match dynamics {
            DynamicsIR::Llg { mechanics, .. } => mechanics.as_ref(),
        },
        crate::StudyIR::Relaxation { dynamics, .. } => dynamics.as_ref().and_then(|dynamics| {
            let DynamicsIR::Llg { mechanics, .. } = dynamics;
            mechanics.as_ref()
        }),
        crate::StudyIR::Hysteresis { .. } => None,
    };
    if mechanics.is_some() && !has_magnetoelastic {
        errors.push("llg.mechanics requires a Magnetoelastic energy term".to_string());
    }
    match mechanics {
        Some(MechanicsIR::QuasistaticElasticity {
            max_picard_iterations,
            picard_tolerance,
        }) => {
            if *max_picard_iterations == 0 {
                errors.push(
                    "llg.mechanics.max_picard_iterations must be > 0 for quasistatic_elasticity"
                        .to_string(),
                );
            }
            if !picard_tolerance.is_finite() || *picard_tolerance <= 0.0 {
                errors.push(
                    "llg.mechanics.picard_tolerance must be finite and > 0 for quasistatic_elasticity"
                        .to_string(),
                );
            }
        }
        Some(MechanicsIR::Elastodynamics { mechanical_dt }) => {
            if mechanical_dt.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                errors.push(
                    "llg.mechanics.mechanical_dt must be finite and > 0 when provided".to_string(),
                );
            }
        }
        Some(MechanicsIR::PrescribedStrain) | None => {}
    }
}

pub(crate) fn validate_unique_names<'a>(
    names: impl Iterator<Item = &'a str>,
    label: &str,
    errors: &mut Vec<String>,
) {
    let mut seen = BTreeSet::new();
    let mut duplicates = BTreeSet::new();
    for name in names {
        if !seen.insert(name) {
            duplicates.insert(name.to_string());
        }
    }
    if !duplicates.is_empty() {
        errors.push(format!(
            "{} must have unique names: {}",
            label,
            duplicates.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
}

pub(crate) fn is_supported_llg_integrator(integrator: &str) -> bool {
    matches!(
        integrator,
        "heun" | "rk4" | "rk23" | "rk45" | "abm3" | "auto"
    )
}

pub(crate) fn validate_runtime_selection(problem: &crate::ProblemIR, errors: &mut Vec<String>) {
    if let Some(value) = problem
        .problem_meta
        .runtime_metadata
        .get("runtime_device_override")
    {
        let Some(override_value) = value.as_object() else {
            errors.push("runtime_metadata.runtime_device_override must be an object".to_string());
            return;
        };
        if !override_value
            .get("device")
            .and_then(|value| value.as_str())
            .is_some_and(|device| matches!(device, "cpu" | "gpu"))
        {
            errors.push(
                "runtime_metadata.runtime_device_override.device must be 'cpu' or 'gpu'"
                    .to_string(),
            );
        }
        if override_value
            .get("source")
            .and_then(|value| value.as_str())
            != Some("managed_launcher")
        {
            errors.push(
                "runtime_metadata.runtime_device_override.source must be 'managed_launcher'"
                    .to_string(),
            );
        }
        let unexpected = override_value
            .keys()
            .filter(|key| !matches!(key.as_str(), "device" | "source"))
            .cloned()
            .collect::<Vec<_>>();
        if !unexpected.is_empty() {
            errors.push(format!(
                "runtime_metadata.runtime_device_override contains unsupported keys: {}",
                unexpected.join(",")
            ));
        }
    }
    let Some(value) = problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
    else {
        return;
    };
    let Some(selection) = value.as_object() else {
        errors.push("runtime_metadata.runtime_selection must be an object".to_string());
        return;
    };
    let device = match selection.get("device") {
        None => None,
        Some(value) => match value.as_str() {
            Some(value) if matches!(value, "auto" | "cpu" | "gpu" | "cuda") => Some(value),
            Some(value) => {
                errors.push(format!(
                    "runtime_metadata.runtime_selection.device '{value}' is unsupported"
                ));
                None
            }
            None => {
                errors
                    .push("runtime_metadata.runtime_selection.device must be a string".to_string());
                None
            }
        },
    };
    let precision_value = selection
        .get("execution_precision")
        .or_else(|| selection.get("precision"));
    let precision = match precision_value {
        None => None,
        Some(value) => match value.as_str() {
            Some(value) if matches!(value, "single" | "double") => Some(value),
            Some(value) => {
                errors.push(format!(
                    "runtime_metadata.runtime_selection.execution_precision '{value}' is unsupported"
                ));
                None
            }
            None => {
                errors.push(
                    "runtime_metadata.runtime_selection.execution_precision must be a string"
                        .to_string(),
                );
                None
            }
        },
    };
    if let (Some(left), Some(right)) = (
        selection
            .get("execution_precision")
            .and_then(|value| value.as_str()),
        selection.get("precision").and_then(|value| value.as_str()),
    ) {
        if left != right {
            errors.push(
                "runtime_metadata.runtime_selection precision and execution_precision must agree"
                    .to_string(),
            );
        }
    }
    for (key, allow_zero) in [
        ("cpu_threads", false),
        ("gpu_count", true),
        ("device_index", true),
    ] {
        if selection
            .get(key)
            .filter(|value| !value.is_null())
            .is_some_and(|value| {
                !value
                    .as_u64()
                    .is_some_and(|number| allow_zero || number > 0)
            })
        {
            let requirement = if allow_zero {
                "a non-negative"
            } else {
                "a positive"
            };
            errors.push(format!(
                "runtime_metadata.runtime_selection.{key} must be {requirement} integer"
            ));
        }
    }
    if let Some(count) = selection
        .get("gpu_count")
        .and_then(|value| value.as_u64())
        .filter(|count| *count > 1)
    {
        errors.push(format!(
            "runtime_metadata.runtime_selection.gpu_count={count} requests multi-GPU execution, but multi-GPU execution is not implemented"
        ));
    }
    if selection
        .get("explicit_selection")
        .is_some_and(|value| !value.is_boolean())
    {
        errors.push(
            "runtime_metadata.runtime_selection.explicit_selection must be a boolean".to_string(),
        );
    }
    let typed = match problem.backend_policy.execution_precision {
        crate::ExecutionPrecision::Single => "single",
        crate::ExecutionPrecision::Double => "double",
    };
    if device == Some("auto") && typed == "single" {
        errors.push("runtime_metadata.runtime_selection device='auto' with execution_precision='single' is not qualified; select device='gpu' explicitly".to_string());
    }
    if precision.is_some_and(|value| value != typed) {
        errors.push(format!(
            "runtime_metadata.runtime_selection.execution_precision '{}' conflicts with backend_policy.execution_precision '{typed}'",
            precision.expect("checked as present")
        ));
    }
}

pub(crate) fn validate_study_dynamics(dynamics: &DynamicsIR, errors: &mut Vec<String>) {
    validate_study_dynamics_with_integrator_policy(dynamics, true, errors);
}

pub(crate) fn validate_frequency_response_dynamics(
    dynamics: &DynamicsIR,
    errors: &mut Vec<String>,
) {
    validate_study_dynamics_with_integrator_policy(dynamics, false, errors);
}

fn validate_study_dynamics_with_integrator_policy(
    dynamics: &DynamicsIR,
    validate_integrator: bool,
    errors: &mut Vec<String>,
) {
    match dynamics {
        DynamicsIR::Llg {
            gyromagnetic_ratio,
            integrator,
            fixed_timestep,
            adaptive_timestep,
            field_refresh,
            ..
        } => {
            if !gyromagnetic_ratio.is_finite() || *gyromagnetic_ratio <= 0.0 {
                errors.push("llg.gyromagnetic_ratio must be finite and positive".to_string());
            }
            if validate_integrator && integrator.trim().is_empty() {
                errors.push("llg.integrator must not be empty".to_string());
            } else if validate_integrator && !is_supported_llg_integrator(integrator.as_str()) {
                errors.push(
                    "llg.integrator must be one of: heun, rk4, rk23, rk45, abm3, auto".to_string(),
                );
            }
            if fixed_timestep.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                errors.push(
                    "llg.fixed_timestep must be finite and positive when provided".to_string(),
                );
            }
            if validate_integrator && fixed_timestep.is_some() && adaptive_timestep.is_some() {
                errors.push(
                    "llg.fixed_timestep and llg.adaptive_timestep are mutually exclusive"
                        .to_string(),
                );
            }
            if validate_integrator {
                if let Some(adaptive) = adaptive_timestep {
                    validate_adaptive_timestep(integrator, adaptive, errors);
                }
            }
            if field_refresh
                .as_ref()
                .and_then(|policy| policy.demag_interval_s)
                .is_some_and(|value| !value.is_finite() || value <= 0.0)
            {
                errors.push(
                    "llg.field_refresh.demag_interval_s must be finite and positive when provided"
                        .to_string(),
                );
            }
        }
    }
}

fn validate_adaptive_timestep(
    integrator: &str,
    adaptive: &crate::AdaptiveTimeStepIR,
    errors: &mut Vec<String>,
) {
    if !matches!(integrator, "rk23" | "rk45" | "auto") {
        errors.push(
            "llg.adaptive_timestep requires an embedded-error integrator: rk23, rk45, or auto"
                .to_string(),
        );
    }
    if !adaptive.atol.is_finite() || adaptive.atol < 0.0 {
        errors.push("llg.adaptive_timestep.atol must be finite and nonnegative".to_string());
    }
    if !adaptive.rtol.is_finite() || adaptive.rtol < 0.0 {
        errors.push("llg.adaptive_timestep.rtol must be finite and nonnegative".to_string());
    }
    if adaptive.atol == 0.0 && adaptive.rtol == 0.0 {
        errors.push("llg.adaptive_timestep requires at least one positive tolerance".to_string());
    }
    if adaptive.tolerance_mode == crate::AdaptiveToleranceModeIR::MaxError {
        if !adaptive.atol.is_finite() || adaptive.atol <= 0.0 {
            errors.push(
                "llg.adaptive_timestep max_error mode requires finite positive atol".to_string(),
            );
        }
        if adaptive.rtol != 0.0 {
            errors.push("llg.adaptive_timestep max_error mode requires rtol=0".to_string());
        }
    }
    if !adaptive.dt_min.is_finite() || adaptive.dt_min <= 0.0 {
        errors.push("llg.adaptive_timestep.dt_min must be finite and positive".to_string());
    }
    match adaptive.dt_max {
        Some(value) if !value.is_finite() || value <= 0.0 => {
            errors.push("llg.adaptive_timestep.dt_max must be finite and positive".to_string());
        }
        Some(value) if adaptive.dt_min.is_finite() && value < adaptive.dt_min => {
            errors.push("llg.adaptive_timestep.dt_max must be >= dt_min".to_string());
        }
        Some(_) => {}
        None => errors.push(
            "llg.adaptive_timestep.dt_max is required for executable adaptive dynamics".to_string(),
        ),
    }
    if let Some(value) = adaptive.dt_initial {
        if !value.is_finite() || value <= 0.0 {
            errors.push(
                "llg.adaptive_timestep.dt_initial must be finite and positive when provided"
                    .to_string(),
            );
        } else {
            if adaptive.dt_min.is_finite() && value < adaptive.dt_min {
                errors.push("llg.adaptive_timestep.dt_initial must be >= dt_min".to_string());
            }
            if adaptive
                .dt_max
                .is_some_and(|maximum| maximum.is_finite() && value > maximum)
            {
                errors.push("llg.adaptive_timestep.dt_initial must be <= dt_max".to_string());
            }
        }
    }
    if !adaptive.safety.is_finite() || !(0.0 < adaptive.safety && adaptive.safety <= 1.0) {
        errors.push("llg.adaptive_timestep.safety must be finite and in (0, 1]".to_string());
    }
    if !adaptive.growth_limit.is_finite() || adaptive.growth_limit <= 1.0 {
        errors.push("llg.adaptive_timestep.growth_limit must be finite and > 1".to_string());
    }
    if !adaptive.shrink_limit.is_finite()
        || adaptive.shrink_limit <= 0.0
        || adaptive.shrink_limit >= 1.0
    {
        errors.push("llg.adaptive_timestep.shrink_limit must be finite and in (0, 1)".to_string());
    }
    if adaptive
        .max_spin_rotation
        .is_some_and(|value| !value.is_finite() || value <= 0.0)
    {
        errors.push(
            "llg.adaptive_timestep.max_spin_rotation must be finite and positive when provided"
                .to_string(),
        );
    }
    if adaptive
        .norm_tolerance
        .is_some_and(|value| !value.is_finite() || value <= 0.0)
    {
        errors.push(
            "llg.adaptive_timestep.norm_tolerance must be finite and positive when provided"
                .to_string(),
        );
    }
}
