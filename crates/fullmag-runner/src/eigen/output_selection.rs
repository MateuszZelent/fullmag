use crate::eigen::types::PathSolveResult;
use fullmag_ir::{OutputIR, SampleSelectorIR};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// Stable identity of one mode in a sampled eigenproblem.
///
/// The two values are copied from the solve result.  They are deliberately not
/// re-numbered when a selector removes samples or modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct SampleModeId {
    pub(crate) sample_index: usize,
    pub(crate) raw_mode_index: usize,
}

impl SampleModeId {
    pub(crate) const fn new(sample_index: usize, raw_mode_index: usize) -> Self {
        Self {
            sample_index,
            raw_mode_index,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DispersionCurveSelection {
    name: String,
    include_branch_table: bool,
}

impl DispersionCurveSelection {
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn include_branch_table(&self) -> bool {
        self.include_branch_table
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OutputSelectionError {
    EmptyEigenModeField,
    EmptyEigenModeSelector,
    EmptySampleSelector,
    EmptySampleLabel,
    EmptyDispersionCurveName,
    DuplicateModeIndex(u32),
    DuplicateBranchIndex(u32),
    DuplicateSampleIndex(u32),
    DuplicateSampleLabel(String),
    UnknownRawModeIndex(u32),
    UnknownBranch(u32),
    UnknownSampleIndex(u32),
    UnknownSampleLabel(String),
    IndexOutOfRange {
        kind: &'static str,
        value: u32,
    },
    DuplicateResultSampleId(usize),
    DuplicateResultModeId {
        sample_index: usize,
        raw_mode_index: usize,
    },
    DuplicateResultBranchId(usize),
    DuplicateResultBranchPoint {
        branch_id: usize,
        sample_index: usize,
        raw_mode_index: usize,
    },
    UnknownBranchPointSample {
        branch_id: usize,
        sample_index: usize,
    },
    UnknownBranchPointMode {
        branch_id: usize,
        sample_index: usize,
        raw_mode_index: usize,
    },
    BranchPointIdentityMismatch {
        branch_id: usize,
        sample_index: usize,
        raw_mode_index: usize,
        mode_branch_id: Option<usize>,
    },
}

impl fmt::Display for OutputSelectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyEigenModeField => formatter.write_str("eigen_mode field must not be empty"),
            Self::EmptyEigenModeSelector => formatter.write_str(
                "eigen_mode must contain at least one raw mode index or tracked branch index",
            ),
            Self::EmptySampleSelector => formatter.write_str(
                "eigen_mode sample_selector must contain sample_indices or sample_labels",
            ),
            Self::EmptySampleLabel => {
                formatter.write_str("eigen_mode sample_selector labels must not be empty")
            },
            Self::EmptyDispersionCurveName => {
                formatter.write_str("dispersion_curve name must not be empty")
            },
            Self::DuplicateModeIndex(index) => {
                write!(formatter, "eigen_mode indices contains duplicate {index}")
            }
            Self::DuplicateBranchIndex(index) => {
                write!(formatter, "eigen_mode branches contains duplicate {index}")
            }
            Self::DuplicateSampleIndex(index) => {
                write!(formatter, "eigen_mode sample_indices contains duplicate {index}")
            }
            Self::DuplicateSampleLabel(label) => {
                write!(formatter, "eigen_mode sample_labels contains duplicate {label:?}")
            }
            Self::UnknownRawModeIndex(index) => {
                write!(formatter, "eigen_mode references unknown raw mode index {index}")
            }
            Self::UnknownBranch(branch_id) => {
                write!(formatter, "eigen_mode references unknown branch {branch_id}")
            }
            Self::UnknownSampleIndex(index) => {
                write!(formatter, "eigen_mode references unknown sample index {index}")
            }
            Self::UnknownSampleLabel(label) => {
                write!(formatter, "eigen_mode references unknown sample label {label:?}")
            }
            Self::IndexOutOfRange { kind, value } => {
                write!(formatter, "eigen_mode {kind} value {value} does not fit this platform")
            }
            Self::DuplicateResultSampleId(sample_index) => {
                write!(formatter, "solve result contains duplicate sample index {sample_index}")
            }
            Self::DuplicateResultModeId {
                sample_index,
                raw_mode_index,
            } => write!(
                formatter,
                "solve result contains duplicate mode ({sample_index}, {raw_mode_index})"
            ),
            Self::DuplicateResultBranchId(branch_id) => {
                write!(formatter, "solve result contains duplicate branch {branch_id}")
            },
            Self::DuplicateResultBranchPoint {
                branch_id,
                sample_index,
                raw_mode_index,
            } => write!(
                formatter,
                "branch {branch_id} contains duplicate point ({sample_index}, {raw_mode_index})"
            ),
            Self::UnknownBranchPointSample {
                branch_id,
                sample_index,
            } => write!(
                formatter,
                "branch {branch_id} references unknown sample index {sample_index}"
            ),
            Self::UnknownBranchPointMode {
                branch_id,
                sample_index,
                raw_mode_index,
            } => write!(
                formatter,
                "branch {branch_id} references unknown mode ({sample_index}, {raw_mode_index})"
            ),
            Self::BranchPointIdentityMismatch {
                branch_id,
                sample_index,
                raw_mode_index,
                mode_branch_id,
            } => write!(
                formatter,
                "branch {branch_id} point ({sample_index}, {raw_mode_index}) maps to mode branch {mode_branch_id:?}"
            ),
        }
    }
}

impl std::error::Error for OutputSelectionError {}

/// Output routing resolved against one concrete path result.
///
/// Spectrum and dispersion sets contain every mode only when the matching
/// public output was requested.  Field sets contain only `EigenMode` requests.
/// The tracking set is independent from `include_branch_table`: a dispersion
/// request needs all modes and branches retained internally even when the
/// branch table is not exported.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct EigenOutputSelection {
    spectrum_mode_ids: BTreeSet<SampleModeId>,
    field_mode_ids: BTreeSet<SampleModeId>,
    tracking_mode_ids: BTreeSet<SampleModeId>,
    field_mode_ids_by_field: BTreeMap<String, BTreeSet<SampleModeId>>,
    selected_sample_ids: BTreeSet<usize>,
    tracked_branch_ids: BTreeSet<usize>,
    dispersion_curves: Vec<DispersionCurveSelection>,
    has_spectrum_output: bool,
    requires_branch_tracking: bool,
}

impl EigenOutputSelection {
    pub(crate) fn spectrum_mode_ids(&self) -> &BTreeSet<SampleModeId> {
        &self.spectrum_mode_ids
    }

    pub(crate) fn field_mode_ids(&self) -> &BTreeSet<SampleModeId> {
        &self.field_mode_ids
    }

    pub(crate) fn tracking_mode_ids(&self) -> &BTreeSet<SampleModeId> {
        &self.tracking_mode_ids
    }

    pub(crate) fn field_mode_ids_for_field(&self, field: &str) -> Option<&BTreeSet<SampleModeId>> {
        self.field_mode_ids_by_field.get(field)
    }

    pub(crate) fn selected_sample_ids(&self) -> &BTreeSet<usize> {
        &self.selected_sample_ids
    }

    pub(crate) fn tracked_branch_ids(&self) -> &BTreeSet<usize> {
        &self.tracked_branch_ids
    }

    pub(crate) fn dispersion_curves(&self) -> &[DispersionCurveSelection] {
        &self.dispersion_curves
    }

    pub(crate) fn has_spectrum_output(&self) -> bool {
        self.has_spectrum_output
    }

    pub(crate) fn has_dispersion_output(&self) -> bool {
        !self.dispersion_curves.is_empty()
    }

    pub(crate) fn branch_table_requested(&self) -> bool {
        self.dispersion_curves
            .iter()
            .any(|curve| curve.include_branch_table)
    }

    pub(crate) fn requires_branch_tracking(&self) -> bool {
        self.requires_branch_tracking
    }

    pub(crate) fn contains_spectrum_mode(
        &self,
        sample_index: usize,
        raw_mode_index: usize,
    ) -> bool {
        self.spectrum_mode_ids
            .contains(&SampleModeId::new(sample_index, raw_mode_index))
    }

    pub(crate) fn contains_field_mode(&self, sample_index: usize, raw_mode_index: usize) -> bool {
        self.field_mode_ids
            .contains(&SampleModeId::new(sample_index, raw_mode_index))
    }

    pub(crate) fn contains_field_mode_for_field(
        &self,
        field: &str,
        sample_index: usize,
        raw_mode_index: usize,
    ) -> bool {
        self.field_mode_ids_by_field
            .get(field)
            .is_some_and(|mode_ids| {
                mode_ids.contains(&SampleModeId::new(sample_index, raw_mode_index))
            })
    }

    pub(crate) fn contains_tracking_mode(
        &self,
        sample_index: usize,
        raw_mode_index: usize,
    ) -> bool {
        self.tracking_mode_ids
            .contains(&SampleModeId::new(sample_index, raw_mode_index))
    }

    pub(crate) fn spectrum_modes_for_sample(
        &self,
        sample_index: usize,
    ) -> impl Iterator<Item = usize> + '_ {
        self.spectrum_mode_ids
            .iter()
            .filter(move |mode_id| mode_id.sample_index == sample_index)
            .map(|mode_id| mode_id.raw_mode_index)
    }

    pub(crate) fn field_modes_for_sample(
        &self,
        sample_index: usize,
    ) -> impl Iterator<Item = usize> + '_ {
        self.field_mode_ids
            .iter()
            .filter(move |mode_id| mode_id.sample_index == sample_index)
            .map(|mode_id| mode_id.raw_mode_index)
    }

    pub(crate) fn tracking_modes_for_sample(
        &self,
        sample_index: usize,
    ) -> impl Iterator<Item = usize> + '_ {
        self.tracking_mode_ids
            .iter()
            .filter(move |mode_id| mode_id.sample_index == sample_index)
            .map(|mode_id| mode_id.raw_mode_index)
    }
}

/// Resolve all eigen-related outputs against `path_result`.
pub(crate) fn select_eigen_outputs(
    path_result: &PathSolveResult,
    outputs: &[OutputIR],
) -> Result<EigenOutputSelection, OutputSelectionError> {
    let available = AvailableModes::from_result(path_result)?;
    let mut selection = EigenOutputSelection::default();
    let mut mode_requests = Vec::new();

    for output in outputs {
        match output {
            OutputIR::EigenSpectrum { .. } => {
                selection.has_spectrum_output = true;
            }
            OutputIR::DispersionCurve {
                name,
                include_branch_table,
            } => {
                if name.trim().is_empty() {
                    return Err(OutputSelectionError::EmptyDispersionCurveName);
                }
                selection.has_spectrum_output = true;
                selection.dispersion_curves.push(DispersionCurveSelection {
                    name: name.trim().to_string(),
                    include_branch_table: *include_branch_table,
                });
            }
            OutputIR::EigenDiagnostics {
                include_tracking, ..
            } => {
                if *include_tracking {
                    selection.requires_branch_tracking = true;
                }
            }
            OutputIR::EigenMode {
                field,
                indices,
                branches,
                sample_selector,
            } => {
                if field.trim().is_empty() {
                    return Err(OutputSelectionError::EmptyEigenModeField);
                }
                if indices.is_empty() && branches.is_empty() {
                    return Err(OutputSelectionError::EmptyEigenModeSelector);
                }
                mode_requests.push(ModeRequest {
                    field: field.trim(),
                    indices,
                    branches,
                    sample_selector: sample_selector.as_ref(),
                });
            }
            _ => {}
        }
    }

    for request in mode_requests {
        let requested_indices = unique_platform_indices(
            &request.indices,
            "indices",
            OutputSelectionError::DuplicateModeIndex,
        )?;
        for requested_index in &requested_indices {
            if !available.raw_mode_ids.contains(requested_index) {
                return Err(OutputSelectionError::UnknownRawModeIndex(
                    u32::try_from(*requested_index).unwrap_or(u32::MAX),
                ));
            }
        }

        let requested_branches = unique_platform_indices(
            &request.branches,
            "branches",
            OutputSelectionError::DuplicateBranchIndex,
        )?;
        for requested_branch in &requested_branches {
            if !available.branch_ids.contains(requested_branch) {
                return Err(OutputSelectionError::UnknownBranch(
                    u32::try_from(*requested_branch).unwrap_or(u32::MAX),
                ));
            }
        }

        let sample_ids = available.resolve_sample_selector(request.sample_selector)?;
        selection
            .selected_sample_ids
            .extend(sample_ids.iter().copied());
        let mut request_mode_ids = BTreeSet::new();

        for sample in &available.samples {
            let sample_index = sample.sample.sample_index;
            if !sample_ids.contains(&sample_index) {
                continue;
            }
            for mode in &sample.modes {
                let branch_matches = mode
                    .branch_id
                    .is_some_and(|branch_id| requested_branches.contains(&branch_id));
                if requested_indices.contains(&mode.raw_mode_index) || branch_matches {
                    let mode_id = SampleModeId::new(sample_index, mode.raw_mode_index);
                    request_mode_ids.insert(mode_id);
                }
            }
        }

        selection
            .field_mode_ids_by_field
            .entry(request.field.to_string())
            .or_default()
            .extend(request_mode_ids.iter().copied());
        selection
            .field_mode_ids
            .extend(request_mode_ids.iter().copied());

        if !requested_branches.is_empty() {
            selection.requires_branch_tracking = true;
        }
    }

    if selection.has_spectrum_output {
        selection.spectrum_mode_ids = available.mode_ids.clone();
    }
    if !selection.dispersion_curves.is_empty() {
        selection.requires_branch_tracking = true;
    }
    if selection.requires_branch_tracking {
        selection.tracking_mode_ids = available.mode_ids.clone();
        selection.tracked_branch_ids = available.branch_ids.clone();
    }

    Ok(selection)
}

struct ModeRequest<'a> {
    field: &'a str,
    indices: &'a [u32],
    branches: &'a [u32],
    sample_selector: Option<&'a SampleSelectorIR>,
}

struct AvailableModes<'a> {
    samples: Vec<&'a crate::eigen::types::SingleKSolveResult>,
    sample_ids: BTreeSet<usize>,
    sample_labels: BTreeMap<String, BTreeSet<usize>>,
    mode_ids: BTreeSet<SampleModeId>,
    raw_mode_ids: BTreeSet<usize>,
    branch_ids: BTreeSet<usize>,
}

impl<'a> AvailableModes<'a> {
    fn from_result(path_result: &'a PathSolveResult) -> Result<Self, OutputSelectionError> {
        let mut samples = Vec::with_capacity(path_result.samples.len());
        let mut sample_ids = BTreeSet::new();
        let mut sample_labels = BTreeMap::<String, BTreeSet<usize>>::new();
        let mut mode_ids = BTreeSet::new();
        let mut raw_mode_ids = BTreeSet::new();
        let mut branch_ids = BTreeSet::new();

        for sample in &path_result.samples {
            let sample_index = sample.sample.sample_index;
            if !sample_ids.insert(sample_index) {
                return Err(OutputSelectionError::DuplicateResultSampleId(sample_index));
            }
            if let Some(label) = sample.sample.label.as_ref() {
                let label = label.trim();
                if !label.is_empty() {
                    sample_labels
                        .entry(label.to_string())
                        .or_default()
                        .insert(sample_index);
                }
            }
            for mode in &sample.modes {
                let mode_id = SampleModeId::new(sample_index, mode.raw_mode_index);
                if !mode_ids.insert(mode_id) {
                    return Err(OutputSelectionError::DuplicateResultModeId {
                        sample_index,
                        raw_mode_index: mode.raw_mode_index,
                    });
                }
                raw_mode_ids.insert(mode.raw_mode_index);
                if let Some(branch_id) = mode.branch_id {
                    branch_ids.insert(branch_id);
                }
            }
            samples.push(sample);
        }

        let mut branch_table_ids = BTreeSet::new();
        for branch in &path_result.branches {
            if !branch_table_ids.insert(branch.branch_id) {
                return Err(OutputSelectionError::DuplicateResultBranchId(
                    branch.branch_id,
                ));
            }
        }
        branch_ids.extend(branch_table_ids.iter().copied());

        for branch in &path_result.branches {
            let mut point_ids = BTreeSet::new();
            for point in &branch.points {
                let point_id = (point.sample_index, point.raw_mode_index);
                if !point_ids.insert(point_id) {
                    return Err(OutputSelectionError::DuplicateResultBranchPoint {
                        branch_id: branch.branch_id,
                        sample_index: point.sample_index,
                        raw_mode_index: point.raw_mode_index,
                    });
                }
                let Some(sample) = samples
                    .iter()
                    .find(|sample| sample.sample.sample_index == point.sample_index)
                    .copied()
                else {
                    return Err(OutputSelectionError::UnknownBranchPointSample {
                        branch_id: branch.branch_id,
                        sample_index: point.sample_index,
                    });
                };
                let Some(mode) = sample
                    .modes
                    .iter()
                    .find(|mode| mode.raw_mode_index == point.raw_mode_index)
                else {
                    return Err(OutputSelectionError::UnknownBranchPointMode {
                        branch_id: branch.branch_id,
                        sample_index: point.sample_index,
                        raw_mode_index: point.raw_mode_index,
                    });
                };
                if mode.branch_id != Some(branch.branch_id) {
                    return Err(OutputSelectionError::BranchPointIdentityMismatch {
                        branch_id: branch.branch_id,
                        sample_index: point.sample_index,
                        raw_mode_index: point.raw_mode_index,
                        mode_branch_id: mode.branch_id,
                    });
                }
            }
        }

        Ok(Self {
            samples,
            sample_ids,
            sample_labels,
            mode_ids,
            raw_mode_ids,
            branch_ids,
        })
    }

    fn resolve_sample_selector(
        &self,
        selector: Option<&SampleSelectorIR>,
    ) -> Result<BTreeSet<usize>, OutputSelectionError> {
        let Some(selector) = selector else {
            return Ok(self.sample_ids.clone());
        };
        if selector.is_empty() {
            return Err(OutputSelectionError::EmptySampleSelector);
        }

        let mut selected = BTreeSet::new();
        let mut seen_indices = BTreeSet::new();
        for sample_index in &selector.sample_indices {
            let sample_index = platform_index(*sample_index, "sample_indices")?;
            if !seen_indices.insert(sample_index) {
                return Err(OutputSelectionError::DuplicateSampleIndex(
                    sample_index as u32,
                ));
            }
            if !self.sample_ids.contains(&sample_index) {
                return Err(OutputSelectionError::UnknownSampleIndex(
                    u32::try_from(sample_index).unwrap_or(u32::MAX),
                ));
            }
            selected.insert(sample_index);
        }

        let mut seen_labels = BTreeSet::new();
        for label in &selector.sample_labels {
            let label = label.trim();
            if label.is_empty() {
                return Err(OutputSelectionError::EmptySampleLabel);
            }
            if !seen_labels.insert(label) {
                return Err(OutputSelectionError::DuplicateSampleLabel(
                    label.to_string(),
                ));
            }
            let Some(sample_ids) = self.sample_labels.get(label) else {
                return Err(OutputSelectionError::UnknownSampleLabel(label.to_string()));
            };
            selected.extend(sample_ids.iter().copied());
        }
        Ok(selected)
    }
}

fn platform_index(value: u32, kind: &'static str) -> Result<usize, OutputSelectionError> {
    usize::try_from(value).map_err(|_| OutputSelectionError::IndexOutOfRange { kind, value })
}

fn unique_platform_indices<F>(
    values: &[u32],
    kind: &'static str,
    duplicate: F,
) -> Result<BTreeSet<usize>, OutputSelectionError>
where
    F: Fn(u32) -> OutputSelectionError,
{
    let mut result = BTreeSet::new();
    for value in values {
        let platform_value = platform_index(*value, kind)?;
        if !result.insert(platform_value) {
            return Err(duplicate(*value));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{select_eigen_outputs, OutputSelectionError, SampleModeId};
    use crate::eigen::types::{
        EigenSolverModel, KSampleDescriptor, PathSolveResult, SingleKModeResult,
        SingleKSolveResult, TrackedBranch, TrackedBranchPoint,
    };
    use fullmag_ir::{OutputIR, SampleSelectorIR};

    fn mode(raw_mode_index: usize, branch_id: Option<usize>) -> SingleKModeResult {
        SingleKModeResult {
            raw_mode_index,
            branch_id,
            frequency_real_hz: raw_mode_index as f64 + 1.0,
            frequency_imag_hz: 0.0,
            angular_frequency_rad_per_s: raw_mode_index as f64 + 1.0,
            eigenvalue_real: 0.0,
            eigenvalue_imag: raw_mode_index as f64 + 1.0,
            norm: 1.0,
            mass_norm: Some(1.0),
            max_amplitude: 1.0,
            residual_relative_l2: Some(0.0),
            residual_norm: Some(0.0),
            residual_linf: Some(0.0),
            tangent_leakage_mean_abs: None,
            tangent_leakage_max_abs: None,
            tangent_leakage_weighted_relative_l2: None,
            dominant_polarization: "x".to_string(),
            reduced_vector: None,
            lifted_real: None,
            lifted_imag: None,
            amplitude: None,
            phase: None,
            node_mass_weights: None,
            component_participation:
                crate::eigen::ModalParticipationObservable::unavailable_without_context("test"),
        }
    }

    fn sample(
        sample_index: usize,
        label: Option<&str>,
        modes: Vec<SingleKModeResult>,
    ) -> SingleKSolveResult {
        SingleKSolveResult {
            sample: KSampleDescriptor {
                sample_index,
                label: label.map(str::to_string),
                segment_index: None,
                path_s: sample_index as f64,
                t_in_segment: 0.0,
                k_vector: [sample_index as f64, 0.0, 0.0],
            },
            modes,
            relaxation_steps: 0,
            solver_model: EigenSolverModel::ReferenceFull2x2Tangent,
            solver_notes: Vec::new(),
            solver_diagnostics: None,
        }
    }

    fn branch(branch_id: usize, sample_index: usize, raw_mode_index: usize) -> TrackedBranch {
        TrackedBranch {
            branch_id,
            label: Some(format!("B{branch_id}")),
            points: vec![TrackedBranchPoint {
                sample_index,
                raw_mode_index,
                frequency_real_hz: 1.0,
                frequency_imag_hz: 0.0,
                tracking_confidence: 1.0,
                overlap_prev: None,
            }],
        }
    }

    fn result() -> PathSolveResult {
        PathSolveResult {
            samples: vec![
                sample(10, Some("Gamma"), vec![mode(2, Some(7)), mode(9, Some(12))]),
                sample(20, Some("X"), vec![mode(2, Some(12)), mode(15, None)]),
            ],
            branches: vec![branch(7, 10, 2), branch(12, 10, 9)],
            solver_model: EigenSolverModel::ReferenceFull2x2Tangent,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            solver_policy: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        }
    }

    #[test]
    fn spectrum_and_dispersion_keep_all_original_ids_and_track_without_branch_export() {
        let selection = select_eigen_outputs(
            &result(),
            &[
                OutputIR::EigenSpectrum {
                    quantity: "eigenfrequency".to_string(),
                },
                OutputIR::DispersionCurve {
                    name: " bands ".to_string(),
                    include_branch_table: false,
                },
            ],
        )
        .expect("valid spectrum and dispersion outputs");

        let expected = [
            SampleModeId::new(10, 2),
            SampleModeId::new(10, 9),
            SampleModeId::new(20, 2),
            SampleModeId::new(20, 15),
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(selection.spectrum_mode_ids(), &expected);
        assert_eq!(selection.tracking_mode_ids(), &expected);
        assert_eq!(
            selection
                .tracked_branch_ids()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            vec![7, 12]
        );
        assert!(selection.requires_branch_tracking());
        assert!(!selection.branch_table_requested());
        assert_eq!(selection.dispersion_curves()[0].name(), "bands");
        assert!(selection.contains_spectrum_mode(20, 15));
        assert!(!selection.contains_field_mode(10, 2));
        assert_eq!(
            selection.spectrum_modes_for_sample(10).collect::<Vec<_>>(),
            vec![2, 9]
        );
    }

    #[test]
    fn indices_or_branches_and_sample_indices_or_labels_form_unions() {
        let selection = select_eigen_outputs(
            &result(),
            &[OutputIR::EigenMode {
                field: " mode ".to_string(),
                indices: vec![15],
                branches: vec![7],
                sample_selector: Some(SampleSelectorIR {
                    sample_indices: vec![20],
                    sample_labels: vec!["Gamma".to_string()],
                }),
            }],
        )
        .expect("valid union selector");

        let expected = [SampleModeId::new(10, 2), SampleModeId::new(20, 15)]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(selection.field_mode_ids(), &expected);
        assert_eq!(
            selection
                .selected_sample_ids()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            vec![10, 20]
        );
        assert!(selection.contains_field_mode_for_field("mode", 10, 2));
        assert!(!selection.contains_field_mode_for_field("mode", 20, 2));
        assert!(selection.requires_branch_tracking());
    }

    #[test]
    fn repeated_sample_label_selects_all_matching_path_samples() {
        let mut path_result = result();
        path_result
            .samples
            .push(sample(30, Some("Gamma"), vec![mode(2, None)]));

        let selection = select_eigen_outputs(
            &path_result,
            &[OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![2],
                branches: vec![],
                sample_selector: Some(SampleSelectorIR {
                    sample_indices: vec![],
                    sample_labels: vec![" Gamma ".to_string()],
                }),
            }],
        )
        .expect("repeated path labels are valid");

        let expected = [SampleModeId::new(10, 2), SampleModeId::new(30, 2)]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(selection.field_mode_ids(), &expected);
        assert_eq!(
            selection
                .selected_sample_ids()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            vec![10, 30]
        );
    }

    #[test]
    fn diagnostics_tracking_requests_all_modes_without_publishing_spectrum() {
        let selection = select_eigen_outputs(
            &result(),
            &[OutputIR::EigenDiagnostics {
                include_tracking: true,
                include_residuals: false,
                include_overlaps: false,
                include_tangent_leakage: false,
                include_orthogonality: false,
            }],
        )
        .expect("tracking diagnostics output is valid");

        assert!(selection.requires_branch_tracking());
        assert_eq!(selection.tracking_mode_ids().len(), 4);
        assert_eq!(selection.tracked_branch_ids().len(), 2);
        assert!(selection.spectrum_mode_ids().is_empty());
        assert!(!selection.has_spectrum_output());
    }

    #[test]
    fn branch_table_rejects_duplicate_ids_and_invalid_point_identity() {
        let mut duplicate_branch_result = result();
        duplicate_branch_result.branches.push(branch(7, 10, 2));
        assert_eq!(
            select_eigen_outputs(
                &duplicate_branch_result,
                &[OutputIR::DispersionCurve {
                    name: "bands".to_string(),
                    include_branch_table: true,
                }],
            ),
            Err(OutputSelectionError::DuplicateResultBranchId(7))
        );

        let mut invalid_point_result = result();
        invalid_point_result.branches[0].points[0].raw_mode_index = 9;
        assert_eq!(
            select_eigen_outputs(
                &invalid_point_result,
                &[OutputIR::DispersionCurve {
                    name: "bands".to_string(),
                    include_branch_table: true,
                }],
            ),
            Err(OutputSelectionError::BranchPointIdentityMismatch {
                branch_id: 7,
                sample_index: 10,
                raw_mode_index: 9,
                mode_branch_id: Some(12),
            })
        );
    }

    #[test]
    fn valid_sample_with_no_matching_mode_produces_an_explicit_empty_selection() {
        let selection = select_eigen_outputs(
            &result(),
            &[OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![9],
                branches: vec![],
                sample_selector: Some(SampleSelectorIR {
                    sample_indices: vec![20],
                    sample_labels: vec![],
                }),
            }],
        )
        .expect("the sample itself is valid even though it has no requested mode");

        assert!(selection.field_mode_ids().is_empty());
        assert_eq!(
            selection
                .selected_sample_ids()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            vec![20]
        );
        assert!(selection
            .field_mode_ids_for_field("mode")
            .is_some_and(|mode_ids| mode_ids.is_empty()));
    }

    #[test]
    fn unknown_labels_sample_indices_branches_and_modes_are_rejected() {
        let cases = [
            (
                OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![2],
                    branches: vec![],
                    sample_selector: Some(SampleSelectorIR {
                        sample_indices: vec![],
                        sample_labels: vec!["Y".to_string()],
                    }),
                },
                OutputSelectionError::UnknownSampleLabel("Y".to_string()),
            ),
            (
                OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![2],
                    branches: vec![],
                    sample_selector: Some(SampleSelectorIR {
                        sample_indices: vec![99],
                        sample_labels: vec![],
                    }),
                },
                OutputSelectionError::UnknownSampleIndex(99),
            ),
            (
                OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![],
                    branches: vec![99],
                    sample_selector: None,
                },
                OutputSelectionError::UnknownBranch(99),
            ),
            (
                OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![99],
                    branches: vec![],
                    sample_selector: None,
                },
                OutputSelectionError::UnknownRawModeIndex(99),
            ),
        ];

        for (output, expected) in cases {
            assert_eq!(select_eigen_outputs(&result(), &[output]), Err(expected));
        }
    }

    #[test]
    fn malformed_empty_selectors_are_rejected() {
        let empty_mode = OutputIR::EigenMode {
            field: "mode".to_string(),
            indices: vec![],
            branches: vec![],
            sample_selector: None,
        };
        assert_eq!(
            select_eigen_outputs(&result(), &[empty_mode]),
            Err(OutputSelectionError::EmptyEigenModeSelector)
        );

        let empty_samples = OutputIR::EigenMode {
            field: "mode".to_string(),
            indices: vec![2],
            branches: vec![],
            sample_selector: Some(SampleSelectorIR::default()),
        };
        assert_eq!(
            select_eigen_outputs(&result(), &[empty_samples]),
            Err(OutputSelectionError::EmptySampleSelector)
        );
    }
}
