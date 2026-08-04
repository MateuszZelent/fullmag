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
        FieldSpatialProfileIR::GaussianPlaneWave {
            center_x_m,
            center_y_m,
            carrier_origin_x_m,
            sigma_x_m,
            sigma_y_m,
            wavelength_m,
            carrier_phase_rad,
        } => {
            for (name, value) in [
                ("center_x_m", *center_x_m),
                ("center_y_m", *center_y_m),
                ("carrier_origin_x_m", *carrier_origin_x_m),
                ("carrier_phase_rad", *carrier_phase_rad),
            ] {
                if !value.is_finite() {
                    errors.push(format!("{label} {name} must be finite"));
                }
            }
            for (name, value) in [
                ("sigma_x_m", *sigma_x_m),
                ("sigma_y_m", *sigma_y_m),
                ("wavelength_m", *wavelength_m),
            ] {
                if !value.is_finite() || value <= 0.0 {
                    errors.push(format!("{label} {name} must be finite and > 0"));
                }
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

fn validate_time_envelope(label: &str, value: &crate::TimeEnvelopeIR, errors: &mut Vec<String>) {
    match value {
        crate::TimeEnvelopeIR::Constant { value } => {
            if !value.is_finite() {
                errors.push(format!("{label} value must be finite"));
            }
        }
        crate::TimeEnvelopeIR::Sinusoidal {
            amplitude,
            frequency_hz,
            phase_rad,
            offset,
        } => {
            if !amplitude.is_finite() || !phase_rad.is_finite() || !offset.is_finite() {
                errors.push(format!(
                    "{label} amplitude, phase_rad, and offset must be finite"
                ));
            }
            if !frequency_hz.is_finite() || *frequency_hz < 0.0 {
                errors.push(format!("{label} frequency_hz must be finite and >= 0"));
            }
        }
        crate::TimeEnvelopeIR::Pulse {
            amplitude,
            t_on_s,
            t_off_s,
        } => {
            if !amplitude.is_finite() {
                errors.push(format!("{label} amplitude must be finite"));
            }
            if !t_on_s.is_finite() || !t_off_s.is_finite() || t_off_s <= t_on_s {
                errors.push(format!(
                    "{label} requires finite t_on_s and t_off_s with t_off_s > t_on_s"
                ));
            }
        }
        crate::TimeEnvelopeIR::PiecewiseLinear { points } => {
            for point in points {
                if !point.time_s.is_finite() || !point.value.is_finite() {
                    errors.push(format!(
                        "{label} piecewise_linear time_s and value must be finite"
                    ));
                }
            }
            for window in points.windows(2) {
                if window[1].time_s <= window[0].time_s {
                    errors.push(format!(
                        "{label} piecewise_linear time_s values must be strictly increasing"
                    ));
                }
            }
        }
        crate::TimeEnvelopeIR::Sinc {
            amplitude,
            center_s,
            bandwidth_hz,
            offset,
        } => {
            if !amplitude.is_finite() || !center_s.is_finite() || !offset.is_finite() {
                errors.push(format!(
                    "{label} amplitude, center_s, and offset must be finite"
                ));
            }
            if !bandwidth_hz.is_finite() || *bandwidth_hz <= 0.0 {
                errors.push(format!("{label} bandwidth_hz must be finite and > 0"));
            }
        }
        crate::TimeEnvelopeIR::Tabulated {
            artifact_ref,
            bandwidth_hz,
            ..
        } => {
            if artifact_ref.trim().is_empty() {
                errors.push(format!("{label} artifact_ref must not be empty"));
            }
            if bandwidth_hz.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                errors.push(format!(
                    "{label} bandwidth_hz must be finite and > 0 when provided"
                ));
            }
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
                definition,
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
                    CurrentTransportModelIR::PrescribedDensity => {
                        if definition.is_some() {
                            errors.push(format!(
                                "current_modules[{index}] current_transport prescribed_density must not define an ohmic charge solve"
                            ));
                        }
                        match current_density {
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
                        }
                    }
                    CurrentTransportModelIR::OhmicPoisson
                    | CurrentTransportModelIR::MagnetoresistivePoisson => {
                        if current_density.is_some() {
                            errors.push(format!(
                                "current_modules[{index}] current_transport ohmic_poisson must not define current_density"
                            ));
                        }
                        if solve_region.is_some() || conductivity_s_per_m.is_some() {
                            errors.push(format!(
                                "current_modules[{index}] legacy ohmic_poisson solve_region/conductivity_s_per_m is ambiguous; author the complete charge contract"
                            ));
                        }
                        match definition {
                            Some(definition) => validate_charge_transport_definition(
                                index,
                                definition,
                                matches!(model, CurrentTransportModelIR::MagnetoresistivePoisson),
                                problem.backend_policy.requested_backend,
                                errors,
                            ),
                            None => errors.push(format!(
                                "current_modules[{index}] current_transport ohmic_poisson requires a complete charge contract"
                            )),
                        }
                    }
                }
            }
        }
    }
}

fn validate_charge_transport_definition(
    index: usize,
    definition: &crate::ChargeTransportDefinitionIR,
    reciprocal: bool,
    requested_backend: crate::BackendTarget,
    errors: &mut Vec<String>,
) {
    let prefix = format!("current_modules[{index}] current_transport");
    if definition.domain.is_empty() || definition.materials.is_empty() {
        errors.push(format!(
            "{prefix} complete charge contract requires non-empty domain and materials"
        ));
    }
    for (material_index, assignment) in definition.materials.iter().enumerate() {
        if !assignment.material.sigma_spm.is_finite() || assignment.material.sigma_spm <= 0.0 {
            errors.push(format!(
                "{prefix}.materials[{material_index}].material.sigma_Spm must be finite and > 0"
            ));
        }
        let tensor = [
            assignment.material.sigma_parallel_spm,
            assignment.material.sigma_perpendicular_spm,
            assignment.material.sigma_ahe_spm,
        ];
        if reciprocal {
            match tensor {
                [Some(parallel), Some(perpendicular), Some(ahe)]
                    if parallel.is_finite()
                        && parallel > 0.0
                        && perpendicular.is_finite()
                        && perpendicular > 0.0
                        && ahe.is_finite() => {}
                _ => errors.push(format!(
                    "{prefix}.materials[{material_index}] magnetoresistive_poisson requires finite sigma_parallel_Spm > 0, sigma_perpendicular_Spm > 0, and sigma_AHE_Spm"
                )),
            }
        } else if tensor.iter().any(Option::is_some) {
            errors.push(format!(
                "{prefix}.materials[{material_index}] anisotropic conductivity is valid only for magnetoresistive_poisson"
            ));
        }
        if !definition.domain.contains(&assignment.region) {
            errors.push(format!(
                "{prefix}.materials[{material_index}].region must belong to the authored charge domain"
            ));
        }
    }
    for region in &definition.domain {
        let assignments = definition
            .materials
            .iter()
            .filter(|assignment| &assignment.region == region)
            .count();
        if assignments != 1 {
            errors.push(format!(
                "{prefix} each charge domain region requires exactly one material assignment"
            ));
        }
    }

    let mut boundary_ids = BTreeSet::new();
    let mut assigned_surfaces = BTreeSet::new();
    let mut voltage_count = 0usize;
    for (boundary_index, boundary) in definition.boundaries.iter().enumerate() {
        if boundary.id().trim().is_empty() || !boundary_ids.insert(boundary.id()) {
            errors.push(format!(
                "{prefix}.boundaries[{boundary_index}].id must be non-empty and unique"
            ));
        }
        if boundary.surfaces().is_empty() {
            errors.push(format!(
                "{prefix}.boundaries[{boundary_index}].surfaces must not be empty"
            ));
        }
        for surface in boundary.surfaces() {
            if !vector3_is_finite(&surface.orientation)
                || surface
                    .orientation
                    .iter()
                    .map(|value| value * value)
                    .sum::<f64>()
                    <= 0.0
            {
                errors.push(format!(
                    "{prefix}.boundaries[{boundary_index}] surface orientation must be finite and nonzero"
                ));
            }
            if !assigned_surfaces.insert((surface.object_id.as_str(), surface.surface_id.as_str()))
            {
                errors.push(format!(
                    "{prefix} surface '{}:{}' has conflicting charge boundary assignments",
                    surface.object_id, surface.surface_id
                ));
            }
        }
        match boundary {
            crate::ChargeBoundaryIR::VoltageElectrode { potential_v, .. } => {
                voltage_count += 1;
                if !potential_v.is_finite() {
                    errors.push(format!(
                        "{prefix}.boundaries[{boundary_index}].potential_V must be finite"
                    ));
                }
            }
            crate::ChargeBoundaryIR::NormalCurrentElectrode {
                outward_current_density_apm2,
                ..
            } if !outward_current_density_apm2.is_finite() => errors.push(format!(
                "{prefix}.boundaries[{boundary_index}].outward_current_density_Apm2 must be finite"
            )),
            _ => {}
        }
    }
    match definition.gauge {
        crate::ChargePotentialGaugeIR::DirichletReference if voltage_count == 0 => errors.push(
            format!("{prefix}.gauge=dirichlet_reference requires a voltage electrode"),
        ),
        crate::ChargePotentialGaugeIR::ZeroMean if voltage_count != 0 => errors.push(format!(
            "{prefix}.gauge=zero_mean conflicts with voltage electrodes"
        )),
        _ => {}
    }
    let solver = &definition.solver;
    let supported_solver = if reciprocal {
        let supported_operator = match requested_backend {
            crate::BackendTarget::Fem => {
                solver.operator_version
                    == "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
            }
            crate::BackendTarget::Auto => matches!(
                solver.operator_version.as_str(),
                "fdm_coupled_charge_spin_fv_block_gmres.v1"
                    | "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
            ),
            _ => solver.operator_version == "fdm_coupled_charge_spin_fv_block_gmres.v1",
        };
        solver.engine == "block_gmres"
            && supported_operator
            && solver.physical_residual_version == "transport_balance_integrated_l2.v1"
    } else {
        let supported_operator = match requested_backend {
            crate::BackendTarget::Fdm => solver.operator_version == "fv_charge_harmonic_v1",
            crate::BackendTarget::Fem => {
                solver.operator_version == "fem_charge_conforming_h1_p1.transparent.v1"
            }
            crate::BackendTarget::Auto => matches!(
                solver.operator_version.as_str(),
                "fv_charge_harmonic_v1" | "fem_charge_conforming_h1_p1.transparent.v1"
            ),
            crate::BackendTarget::Hybrid => false,
        };
        matches!(solver.engine.as_str(), "auto" | "cg")
            && supported_operator
            && solver.physical_residual_version == "charge_balance_integrated_l2.v1"
    };
    if !supported_solver {
        errors.push(format!(
            "{prefix}.solver carries an unsupported charge engine/version for its transport model"
        ));
    }
    if !solver.linear.relative_tolerance.is_finite()
        || solver.linear.relative_tolerance <= 0.0
        || !solver.linear.absolute_tolerance.is_finite()
        || solver.linear.absolute_tolerance < 0.0
        || solver.linear.max_iterations == 0
    {
        errors.push(format!(
            "{prefix}.solver linear tolerances/iterations are invalid"
        ));
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
    let axis_is_valid = |vector: &[f64; 3]| {
        vector3_is_finite(vector)
            && vector3_norm_sq(vector)
                > crate::PRESCRIBED_SOT_V1_EPSILON_AXIS * crate::PRESCRIBED_SOT_V1_EPSILON_AXIS
    };
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

    let mut prescribed_sot_ids = BTreeSet::new();
    for (index, module) in problem.spin_torque_modules.iter().enumerate() {
        match module {
            SpinTorqueModuleIR::Slonczewski {
                schema_version,
                id,
                target,
                formula_version,
                current_density,
                current_source,
                degree,
                spin_polarization,
                stack_normal,
                lambda_asymmetry,
                epsilon_prime,
                free_layer_thickness_m,
                fixed_layer_position,
                realization,
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
                if !degree.is_finite() || !(0.0 < *degree && *degree <= 1.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski degree must be in (0, 1]"
                    ));
                }
                if !lambda_asymmetry.is_finite() || *lambda_asymmetry < 1.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski lambda_asymmetry must be finite and >= 1"
                    ));
                }
                if !epsilon_prime.is_finite() {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski epsilon_prime must be finite"
                    ));
                }
                if free_layer_thickness_m.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] slonczewski free_layer_thickness_m must be > 0 and finite"
                    ));
                }
                if let Some(position) = fixed_layer_position.as_deref() {
                    if !matches!(position, "top" | "bottom") {
                        errors.push(format!(
                            "spin_torque_modules[{index}] slonczewski fixed_layer_position must be 'top' or 'bottom'"
                        ));
                    }
                }
                match formula_version.as_str() {
                    "slonczewski.fullmag.v2" => {
                        if schema_version.as_deref() != Some("slonczewski_torque.v1") {
                            errors.push(format!("spin_torque_modules[{index}] canonical slonczewski schema_version must be slonczewski_torque.v1"));
                        }
                        if id.as_deref().is_none_or(|value| value.trim().is_empty()) {
                            errors.push(format!("spin_torque_modules[{index}] canonical slonczewski id must not be empty"));
                        }
                        let Some(target) = target else {
                            errors.push(format!("spin_torque_modules[{index}] canonical slonczewski requires target"));
                            continue;
                        };
                        if target.object_id.trim().is_empty() || target.region_id.as_deref().is_some_and(|value| value.trim().is_empty()) {
                            errors.push(format!("spin_torque_modules[{index}] canonical slonczewski target references must not be empty"));
                        }
                        if stack_normal.as_ref().is_none_or(|axis| !axis_is_valid(axis)) {
                            errors.push(format!("spin_torque_modules[{index}] canonical slonczewski stack_normal must be finite with norm > epsilon_axis"));
                        }
                        if !axis_is_valid(spin_polarization) {
                            errors.push(format!("spin_torque_modules[{index}] canonical slonczewski spin_polarization must be a finite nonzero axis"));
                        }
                        if fixed_layer_position.is_some() {
                            errors.push(format!("spin_torque_modules[{index}] canonical slonczewski must not contain legacy fixed_layer_position"));
                        }
                        match realization {
                            Some(crate::SlonczewskiRealizationIR::ThinLayerHomogenized { realization_version })
                                if realization_version == "slonczewski_thin_layer_homogenized.v1" => {
                                    if free_layer_thickness_m.is_none() {
                                        errors.push(format!("spin_torque_modules[{index}] canonical thin-layer slonczewski requires free_layer_thickness_m"));
                                    }
                                }
                            Some(crate::SlonczewskiRealizationIR::InterfaceFlux { interface_id, realization_version }) => {
                                if interface_id.trim().is_empty() || realization_version != "slonczewski_interface_flux.v1" {
                                    errors.push(format!("spin_torque_modules[{index}] canonical interface-flux slonczewski has invalid identity"));
                                }
                                if free_layer_thickness_m.is_some() {
                                    errors.push(format!("spin_torque_modules[{index}] canonical interface-flux slonczewski must not contain bulk free_layer_thickness_m"));
                                }
                            }
                            _ => errors.push(format!("spin_torque_modules[{index}] canonical slonczewski requires a registered realization identity")),
                        }
                    }
                    "slonczewski.fullmag.v1" => {
                        errors.push(format!(
                            "spin_torque_modules[{index}] slonczewski.fullmag.v1 is read-only provenance; use slonczewski.fullmag.v2"
                        ));
                    }
                    "slonczewski.legacy_fullmag.v0" => {
                        if schema_version.is_some() || id.is_some() || target.is_some() || stack_normal.is_some() || realization.is_some() {
                            errors.push(format!("spin_torque_modules[{index}] legacy slonczewski must not contain canonical identity, target, stack_normal, or realization"));
                        }
                    }
                    other => errors.push(format!("spin_torque_modules[{index}] unsupported slonczewski formula_version '{other}'")),
                }
            }
            SpinTorqueModuleIR::ZhangLi {
                schema_version,
                id,
                target,
                formula_version,
                operator_version,
                current_density,
                current_source,
                degree,
                beta,
                lande_g,
            } => {
                validate_vector_binding(index, "zhang_li", current_density, current_source, errors);
                if !degree.is_finite() || !(0.0 < *degree && *degree <= 1.0) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] zhang_li degree must be in (0, 1]"
                    ));
                }
                if !beta.is_finite() || *beta < 0.0 {
                    errors.push(format!(
                        "spin_torque_modules[{index}] zhang_li beta must be >= 0"
                    ));
                }
                match formula_version.as_str() {
                    "zhang_li.fullmag.v1" | "zhang_li.mumax3.v1" => {
                        if schema_version.as_deref() != Some("zhang_li_torque.v1") {
                            errors.push(format!("spin_torque_modules[{index}] canonical zhang_li schema_version must be zhang_li_torque.v1"));
                        }
                        if id.as_deref().is_none_or(|value| value.trim().is_empty()) {
                            errors.push(format!("spin_torque_modules[{index}] canonical zhang_li id must not be empty"));
                        }
                        if target.as_ref().is_none_or(|target| target.object_id.trim().is_empty() || target.region_id.as_deref().is_some_and(|value| value.trim().is_empty())) {
                            errors.push(format!("spin_torque_modules[{index}] canonical zhang_li requires a non-empty target"));
                        }
                        let required_operator = if formula_version == "zhang_li.mumax3.v1" {
                            "zl_mumax3_central_v1"
                        } else {
                            "zl_central_reference_v1"
                        };
                        if operator_version.as_deref() != Some(required_operator) {
                            errors.push(format!("spin_torque_modules[{index}] canonical zhang_li requires operator_version {required_operator}"));
                        }
                        if lande_g.is_none_or(|value| !value.is_finite() || value <= 0.0) {
                            errors.push(format!("spin_torque_modules[{index}] canonical zhang_li lande_g must be finite and > 0"));
                        } else if formula_version == "zhang_li.mumax3.v1"
                            && *lande_g != Some(2.0)
                        {
                            errors.push(format!(
                                "spin_torque_modules[{index}] zhang_li.mumax3.v1 is source-compatible with MuMax3's fixed lande_g=2.0"
                            ));
                        }
                    }
                    "zhang_li.legacy_fullmag.v0" => {
                        if schema_version.is_some() || id.is_some() || target.is_some() || operator_version.is_some() || lande_g.is_some() {
                            errors.push(format!("spin_torque_modules[{index}] legacy zhang_li must not contain canonical identity, target, operator_version, or lande_g"));
                        }
                    }
                    other => errors.push(format!("spin_torque_modules[{index}] unsupported zhang_li formula_version '{other}'")),
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
            SpinTorqueModuleIR::DriftDiffusionSpinTorque {
                schema_version,
                id,
                solve_id,
                target,
                formula_version,
            } => {
                if schema_version != "drift_diffusion_spin_torque.v1" {
                    errors.push(format!("spin_torque_modules[{index}] drift-diffusion schema_version must be drift_diffusion_spin_torque.v1"));
                }
                if id.trim().is_empty()
                    || solve_id.trim().is_empty()
                    || target.object_id.trim().is_empty()
                {
                    errors.push(format!("spin_torque_modules[{index}] drift-diffusion id, solve_id, and target.object_id must not be empty"));
                }
                if formula_version != "transport_torque_angular_momentum.fullmag.v1" {
                    errors.push(format!("spin_torque_modules[{index}] drift-diffusion formula_version is unsupported"));
                }
                if !problem
                    .spin_transport_modules
                    .iter()
                    .any(|solve| solve.id == *solve_id)
                {
                    errors.push(format!("spin_torque_modules[{index}] solve_id '{solve_id}' must reference a spin_transport module"));
                }
            }
            SpinTorqueModuleIR::SpinOrbitTorque {
                charge_current_density_a_per_m2,
                current_source,
                spin_polarization,
                ferromagnet_thickness_m,
                ..
            } => {
                errors.push(format!(
                    "spin_torque_modules[{index}] kind spin_orbit_torque is legal only in a 0.2.0 payload and must migrate to prescribed_sot"
                ));
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
            SpinTorqueModuleIR::PrescribedSot {
                schema_version,
                id,
                target,
                formula,
            } => {
                if schema_version != "prescribed_sot.v1" {
                    errors.push(format!(
                        "spin_torque_modules[{index}] prescribed_sot schema_version must be prescribed_sot.v1"
                    ));
                }
                if id.trim().is_empty() {
                    errors.push(format!(
                        "spin_torque_modules[{index}] prescribed_sot id must not be empty"
                    ));
                } else if !prescribed_sot_ids.insert(id.as_str()) {
                    errors.push(format!(
                        "spin_torque_modules[{index}] prescribed_sot has duplicate id '{id}'"
                    ));
                }
                let validate_target = |target: &crate::RegionRefIR, errors: &mut Vec<String>| {
                    if target.object_id.trim().is_empty()
                        || target
                            .region_id
                            .as_deref()
                            .is_some_and(|region| region.trim().is_empty())
                    {
                        errors.push(format!(
                            "spin_torque_modules[{index}] prescribed_sot target references must not be empty"
                        ));
                    }
                };

                match formula {
                    crate::PrescribedSotFormulaIR::FullmagV1 {
                        drive,
                        xi_dl,
                        xi_fl,
                        free_layer_thickness_m,
                    } => {
                        let Some(target) = target else {
                            errors.push(format!(
                                "spin_torque_modules[{index}] prescribed_sot.fullmag.v1 requires an explicit target"
                            ));
                            continue;
                        };
                        validate_target(target, errors);
                        if !xi_dl.is_finite() || !xi_fl.is_finite() {
                            errors.push(format!(
                                "spin_torque_modules[{index}] prescribed_sot.fullmag.v1 xi_dl and xi_fl must be finite"
                            ));
                        }
                        if !free_layer_thickness_m.is_finite() || *free_layer_thickness_m <= 0.0 {
                            errors.push(format!(
                                "spin_torque_modules[{index}] prescribed_sot.fullmag.v1 free_layer_thickness_m must be finite and > 0"
                            ));
                        }
                        match drive {
                            crate::PrescribedSotV1DriveIR::SignedScalar {
                                current_density_apm2,
                                sigma_hat,
                                envelope,
                            } => {
                                if !current_density_apm2.is_finite() {
                                    errors.push(format!(
                                        "spin_torque_modules[{index}] prescribed_sot signed current_density_Apm2 must be finite"
                                    ));
                                }
                                if !axis_is_valid(sigma_hat) {
                                    errors.push(format!(
                                        "spin_torque_modules[{index}] prescribed_sot sigma_hat must be finite with norm > epsilon_axis"
                                    ));
                                }
                                if let Some(envelope) = envelope {
                                    validate_time_envelope(
                                        &format!(
                                            "spin_torque_modules[{index}] prescribed_sot signed_scalar envelope"
                                        ),
                                        envelope,
                                        errors,
                                    );
                                }
                            }
                            crate::PrescribedSotV1DriveIR::VectorCurrentSource {
                                current_source_id,
                                drive_direction,
                                interface_normal,
                            } => {
                                if current_source_id.trim().is_empty()
                                    || !current_transport_exists(problem, current_source_id)
                                {
                                    errors.push(format!(
                                        "spin_torque_modules[{index}] prescribed_sot current_source_id '{current_source_id}' must reference a current_transport module"
                                    ));
                                }
                                let drive_valid = axis_is_valid(drive_direction);
                                let normal_valid = axis_is_valid(interface_normal);
                                if !drive_valid {
                                    errors.push(format!(
                                        "spin_torque_modules[{index}] prescribed_sot drive_direction must be finite with norm > epsilon_axis"
                                    ));
                                }
                                if !normal_valid {
                                    errors.push(format!(
                                        "spin_torque_modules[{index}] prescribed_sot interface_normal must be finite with norm > epsilon_axis"
                                    ));
                                }
                                if drive_valid && normal_valid {
                                    let cross = [
                                        interface_normal[1] * drive_direction[2]
                                            - interface_normal[2] * drive_direction[1],
                                        interface_normal[2] * drive_direction[0]
                                            - interface_normal[0] * drive_direction[2],
                                        interface_normal[0] * drive_direction[1]
                                            - interface_normal[1] * drive_direction[0],
                                    ];
                                    let normalized_cross_norm_sq = vector3_norm_sq(&cross)
                                        / (vector3_norm_sq(drive_direction)
                                            * vector3_norm_sq(interface_normal));
                                    if normalized_cross_norm_sq
                                        <= crate::PRESCRIBED_SOT_V1_EPSILON_AXIS
                                            * crate::PRESCRIBED_SOT_V1_EPSILON_AXIS
                                    {
                                        errors.push(format!(
                                            "spin_torque_modules[{index}] prescribed_sot interface_normal and drive_direction are parallel within epsilon_axis"
                                        ));
                                    }
                                }
                            }
                        }
                    }
                    crate::PrescribedSotFormulaIR::LegacyFullmagV0 {
                        drive,
                        raw_spin_polarization,
                        xi_dl,
                        xi_fl,
                        free_layer_thickness_m,
                        compatibility_origin,
                    } => {
                        if let Some(target) = target {
                            validate_target(target, errors);
                        }
                        if compatibility_origin.source_ir_version != "0.2.0"
                            || compatibility_origin.authored_kind != "spin_orbit_torque"
                        {
                            errors.push(format!(
                                "spin_torque_modules[{index}] prescribed_sot legacy-v0 compatibility_origin must be exactly source_ir_version=0.2.0 and authored_kind=spin_orbit_torque"
                            ));
                        }
                        if !vector3_is_finite(raw_spin_polarization) {
                            errors.push(format!(
                                "spin_torque_modules[{index}] prescribed_sot legacy-v0 raw_spin_polarization must be finite"
                            ));
                        }
                        if !xi_dl.is_finite() || !xi_fl.is_finite() {
                            errors.push(format!(
                                "spin_torque_modules[{index}] prescribed_sot legacy-v0 xi_dl and xi_fl must be finite"
                            ));
                        }
                        if !free_layer_thickness_m.is_finite() || *free_layer_thickness_m <= 0.0 {
                            errors.push(format!(
                                "spin_torque_modules[{index}] prescribed_sot legacy-v0 free_layer_thickness_m must be finite and > 0"
                            ));
                        }
                        match drive {
                            crate::PrescribedSotLegacyDriveIR::LegacyScalarMagnitude {
                                raw_charge_current_density_apm2,
                            } if !raw_charge_current_density_apm2.is_finite() => errors.push(
                                format!(
                                    "spin_torque_modules[{index}] prescribed_sot legacy-v0 raw current must be finite"
                                ),
                            ),
                            crate::PrescribedSotLegacyDriveIR::LegacyCurrentSourceNorm {
                                current_source_id,
                            } if current_source_id.trim().is_empty()
                                || !current_transport_exists(problem, current_source_id) =>
                            {
                                errors.push(format!(
                                    "spin_torque_modules[{index}] prescribed_sot legacy-v0 current_source_id '{current_source_id}' must reference a current_transport module"
                                ))
                            }
                            _ => {}
                        }
                    }
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

pub(crate) fn validate_spin_transport_modules(problem: &ProblemIR, errors: &mut Vec<String>) {
    let llg_integrator = problem
        .study
        .optional_dynamics()
        .map(|dynamics| match dynamics {
            DynamicsIR::Llg { integrator, .. } => integrator.as_str(),
        });
    let has_transient = problem
        .spin_transport_modules
        .iter()
        .any(|module| module.mode == crate::SpinTransportModeIR::Transient);
    let has_steady = problem
        .spin_transport_modules
        .iter()
        .any(|module| module.mode == crate::SpinTransportModeIR::Steady);
    if has_transient && llg_integrator != Some("coupled_imex_ark2") {
        errors.push(
            "transient spin requires llg.integrator='coupled_imex_ark2'; explicit_dp45/rk45 and auto fail closed"
                .to_string(),
        );
    }
    if has_steady && llg_integrator == Some("coupled_imex_ark2") {
        errors.push(
            "steady spin rejects llg.integrator='coupled_imex_ark2'; select a steady-compatible LLG integrator"
                .to_string(),
        );
    }
    if !has_transient && llg_integrator == Some("coupled_imex_ark2") {
        errors.push(
            "llg.integrator='coupled_imex_ark2' requires a transient spin transport module"
                .to_string(),
        );
    }
    let mut ids = BTreeSet::new();
    for (index, module) in problem.spin_transport_modules.iter().enumerate() {
        let prefix = format!("spin_transport_modules[{index}]");
        if module.schema_version != "spin_transport.v1" {
            errors.push(format!("{prefix}.schema_version must be spin_transport.v1"));
        }
        if !ids.insert(module.id.as_str()) || module.id.trim().is_empty() {
            errors.push(format!("{prefix}.id must be non-empty and unique"));
        }
        if module.domain.is_empty() || module.materials.is_empty() {
            errors.push(format!("{prefix} requires non-empty domain and materials"));
        }
        let source = problem
            .current_modules
            .iter()
            .find_map(|current| match current {
                CurrentModuleIR::CurrentTransport {
                    name,
                    model,
                    coupling,
                    definition,
                    ..
                } if name == &module.current_source_id => {
                    Some((definition.as_ref(), *model, *coupling))
                }
                _ => None,
            });
        let Some((charge_definition, source_model, coupling)) = source else {
            errors.push(format!(
                "{prefix}.current_source_id '{}' must reference a current_transport module",
                module.current_source_id
            ));
            continue;
        };
        let reciprocal = coupling == crate::TransportCouplingIR::Bidirectional;
        let expected_model = if reciprocal {
            crate::CurrentTransportModelIR::MagnetoresistivePoisson
        } else {
            crate::CurrentTransportModelIR::OhmicPoisson
        };
        let expected_constitutive = if reciprocal {
            "transport_constitutive.reciprocal.fullmag.v1"
        } else {
            "transport_constitutive.one_way.fullmag.v1"
        };
        if source_model != expected_model {
            errors.push(format!(
                "{prefix} current source model is inconsistent with its coupling"
            ));
        }
        if module.constitutive_version != expected_constitutive {
            errors.push(format!(
                "{prefix}.constitutive_version is inconsistent with its coupling"
            ));
        }
        if module.requested_execution.precision != crate::ExecutionPrecision::Double {
            errors.push(format!(
                "{prefix} steady M1/M2 lane supports precision=double only"
            ));
        }
        for (material_index, assignment) in module.materials.iter().enumerate() {
            let material = &assignment.material;
            if !material.sigma_s_spm.is_finite() || material.sigma_s_spm <= 0.0 {
                errors.push(format!(
                    "{prefix}.materials[{material_index}].sigma_s_Spm must be finite and > 0"
                ));
            }
            if !material.polarization_p.is_finite()
                || !(-1.0..=1.0).contains(&material.polarization_p)
            {
                errors.push(format!("{prefix}.materials[{material_index}].polarization_p must be finite and in [-1,1]"));
            }
            if !material.theta_sh.is_finite()
                || !material.lambda_sf_m.is_finite()
                || material.lambda_sf_m <= 0.0
            {
                errors.push(format!("{prefix}.materials[{material_index}] theta_sh must be finite and lambda_sf_m > 0"));
            }
            let density_of_states = material.density_of_states_per_spin_j_inv_m3;
            let has_physical_capacitance_source =
                material.spin_capacitance_as_per_v_m3.is_some() || density_of_states.is_some();
            match (
                has_physical_capacitance_source,
                material.capacitance_formula_version.as_deref(),
            ) {
                (true, Some(version)) => {
                    if let Some(capacitance) = material.spin_capacitance_as_per_v_m3 {
                    if !capacitance.is_finite() || capacitance <= 0.0 {
                        errors.push(format!(
                            "{prefix}.materials[{material_index}].spin_capacitance_As_per_V_m3 must be finite and > 0"
                        ));
                    }
                    }
                    if let Some(density) = density_of_states {
                        if !density.is_finite() || density <= 0.0 {
                            errors.push(format!(
                                "{prefix}.materials[{material_index}].density_of_states_per_spin_Jinv_m3 must be finite and > 0"
                            ));
                        }
                        if let Some(capacitance) = material.spin_capacitance_as_per_v_m3 {
                            let expected =
                                crate::spin_capacitance_from_density_of_states(density);
                            let tolerance = 1.0e-12
                                * capacitance.abs().max(expected.abs()).max(1.0e-300);
                            if (capacitance - expected).abs() > tolerance {
                                errors.push(format!(
                                    "{prefix}.materials[{material_index}] spin capacitance must equal e^2 times density_of_states_per_spin_Jinv_m3"
                                ));
                            }
                        }
                    }
                    if version.trim().is_empty() {
                        errors.push(format!(
                            "{prefix}.materials[{material_index}].capacitance_formula_version must be non-empty"
                        ));
                    } else if version
                        != crate::DOS_ISOTROPIC_NONMAGNETIC_CAPACITANCE_FORMULA
                    {
                        errors.push(format!(
                            "{prefix}.materials[{material_index}] unsupported capacitance_formula_version '{version}' (expected '{}')",
                            crate::DOS_ISOTROPIC_NONMAGNETIC_CAPACITANCE_FORMULA
                        ));
                    }
                }
                (false, None) if module.mode == crate::SpinTransportModeIR::Steady => {}
                (false, None) => errors.push(format!(
                    "{prefix}.materials[{material_index}] transient mode requires physical spin capacitance and formula version"
                )),
                (false, Some(_)) => errors.push(format!(
                    "{prefix}.materials[{material_index}] capacitance_formula_version requires spin capacitance or density of states"
                )),
                (true, None) => errors.push(format!(
                    "{prefix}.materials[{material_index}] spin capacitance or density of states requires capacitance_formula_version"
                )),
            }
            let sigma_ref = charge_definition.and_then(|definition| {
                definition
                    .materials
                    .iter()
                    .find(|charge| charge.region == assignment.region)
                    .map(|charge| charge.material.sigma_spm)
            });
            if let Some(sigma) = sigma_ref {
                let reciprocal_lambda_min = if reciprocal {
                    charge_definition
                        .and_then(|definition| {
                            definition
                                .materials
                                .iter()
                                .find(|charge| charge.region == assignment.region)
                        })
                        .and_then(|charge| {
                            Some(
                                charge
                                    .material
                                    .sigma_parallel_spm?
                                    .min(charge.material.sigma_perpendicular_spm?),
                            )
                        })
                } else {
                    Some(sigma)
                };
                if reciprocal_lambda_min.is_none() {
                    errors.push(format!("{prefix}.materials[{material_index}] M2 requires sigma_parallel_Spm and sigma_perpendicular_Spm"));
                } else if reciprocal_lambda_min.unwrap() * material.sigma_s_spm
                    - material.polarization_p.powi(2) * sigma.powi(2)
                    <= 0.0
                {
                    errors.push(format!("{prefix}.materials[{material_index}] requires sigma_s_Spm - polarization_p^2*sigma_ref > 0"));
                }
            } else {
                errors.push(format!(
                    "{prefix}.materials[{material_index}] requires a matching charge material assignment"
                ));
            }
        }
        for (interface_index, interface) in module.interfaces.iter().enumerate() {
            if let crate::SpinInterfaceIR::MixingConductance {
                g_up_spm2,
                g_down_spm2,
                g_r_spm2,
                g_i_spm2,
                g_sml_spm2,
                spin_memory_loss,
                formula_version,
                ..
            } = interface
            {
                let interface_prefix = format!("{prefix}.interfaces[{interface_index}]");
                if formula_version != "magnetoelectronic.fullmag.v2" {
                    errors.push(format!(
                        "{interface_prefix}.formula_version must be magnetoelectronic.fullmag.v2; v1 is read-only"
                    ));
                }
                for (name, value) in [
                    ("g_up_Spm2", *g_up_spm2),
                    ("g_down_Spm2", *g_down_spm2),
                    ("g_r_Spm2", *g_r_spm2),
                    ("g_sml_Spm2", *g_sml_spm2),
                ] {
                    if !value.is_finite() || value < 0.0 {
                        errors.push(format!("{interface_prefix}.{name} must be finite and >= 0"));
                    }
                }
                if !g_i_spm2.is_finite() {
                    errors.push(format!("{interface_prefix}.g_i_Spm2 must be finite"));
                }
                if *g_sml_spm2 > 0.0 {
                    errors.push(format!(
                        "{interface_prefix}.g_sml_Spm2 uses rejected sml_surface_conductance.fullmag.v1; author spin_memory_loss with sml_reservoir.fullmag.v2"
                    ));
                }
                if let Some(reservoir) = spin_memory_loss {
                    if reservoir.formula_version != "sml_reservoir.fullmag.v2" {
                        errors.push(format!(
                            "{interface_prefix}.spin_memory_loss.formula_version must be sml_reservoir.fullmag.v2"
                        ));
                    }
                    for (name, value) in [
                        ("g_n_Spm2", reservoir.g_n_spm2),
                        ("g_f_Spm2", reservoir.g_f_spm2),
                    ] {
                        if !value.is_finite() || value < 0.0 {
                            errors.push(format!(
                                "{interface_prefix}.spin_memory_loss.{name} must be finite and >= 0"
                            ));
                        }
                    }
                    if !reservoir.g_lattice_spm2.is_finite() || reservoir.g_lattice_spm2 <= 0.0 {
                        errors.push(format!(
                            "{interface_prefix}.spin_memory_loss.g_lattice_Spm2 must be finite and > 0"
                        ));
                    }
                }
            }
        }
        let supported_operator = if reciprocal {
            match module.requested_execution.discretization {
                crate::BackendTarget::Fem => {
                    module.solver.operator_version
                        == "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
                }
                crate::BackendTarget::Auto => matches!(
                    module.solver.operator_version.as_str(),
                    "fdm_coupled_charge_spin_fv_block_gmres.v1"
                        | "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
                ),
                _ => module.solver.operator_version
                    == "fdm_coupled_charge_spin_fv_block_gmres.v1",
            }
        } else {
            match module.requested_execution.discretization {
                crate::BackendTarget::Fdm => module.solver.operator_version == "fv_spin_upwind_v1",
                crate::BackendTarget::Fem => {
                    module.solver.operator_version
                        == "fem_charge_spin_conforming_h1_p1.transparent.v1"
                        || module.solver.operator_version
                            == "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
                }
                crate::BackendTarget::Auto => matches!(
                    module.solver.operator_version.as_str(),
                    "fv_spin_upwind_v1"
                        | "fem_charge_spin_conforming_h1_p1.transparent.v1"
                        | "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
                ),
                crate::BackendTarget::Hybrid => false,
            }
        };
        if !supported_operator
            || module.solver.physical_residual_version != "transport_balance_integrated_l2.v1"
        {
            errors.push(format!(
                "{prefix}.solver carries unsupported operator/residual version"
            ));
        }
        if reciprocal {
            let bounded_fem_m2 = module.solver.operator_version
                == "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
                && matches!(
                    module.requested_execution.discretization,
                    crate::BackendTarget::Fem | crate::BackendTarget::Auto
                );
            match &module.solver.reciprocal_nonlinear {
                None if bounded_fem_m2 => {}
                Some(policy)
                    if policy.gmres_restart > 0
                        && policy.max_picard_iterations > 0
                        && policy.relative_update_tolerance.is_finite()
                        && policy.relative_update_tolerance > 0.0
                        && policy.eta_transport.is_finite()
                        && policy.eta_transport > 0.0
                        && policy.eta_transport <= 1.0 => {}
                _ => errors.push(format!(
                    "{prefix}.solver requires a valid reciprocal_nonlinear policy for M2"
                )),
            }
        } else if module.solver.reciprocal_nonlinear.is_some() {
            errors.push(format!(
                "{prefix}.solver.reciprocal_nonlinear is valid only for M2"
            ));
        }
        if module.solver.linear.relative_tolerance <= 0.0
            || module.solver.linear.absolute_tolerance < 0.0
            || module.solver.linear.max_iterations == 0
        {
            errors.push(format!(
                "{prefix}.solver linear tolerances/iterations are invalid"
            ));
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
        "heun" | "rk4" | "rk23" | "rk45" | "abm3" | "coupled_imex_ark2" | "auto"
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
                    "llg.integrator must be one of: heun, rk4, rk23, rk45, abm3, coupled_imex_ark2, auto".to_string(),
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
