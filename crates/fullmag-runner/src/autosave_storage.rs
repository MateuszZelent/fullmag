use fullmag_ir::{AutosaveFormatIR, AutosaveLayoutIR};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StageSampleCoordinate {
    PhysicalTime { time_s: f64 },
    AcceptedStep { accepted_step: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StageManifest {
    pub schema_version: String,
    pub target: String,
    pub stage_id: String,
    pub stage_index: u64,
    pub layout: AutosaveLayoutIR,
    pub format: AutosaveFormatIR,
    pub table_quantities: Vec<String>,
    pub field_quantities: Vec<String>,
    pub complete: bool,
    pub table_sample_count: u64,
    pub field_sample_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AutosaveArtifactManifest {
    pub schema_version: String,
    pub target: String,
    pub format: AutosaveFormatIR,
    pub layout: AutosaveLayoutIR,
    pub stages: Vec<StageManifest>,
}

pub fn update_artifact_manifest(root: &Path, stage: &StageManifest) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let path = root.join(format!("{}.autosave.json", stage.target));
    let mut manifest = if path.exists() {
        serde_json::from_slice::<AutosaveArtifactManifest>(
            &fs::read(&path).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?
    } else {
        AutosaveArtifactManifest {
            schema_version: "fullmag.stage_autosave.artifact.v1".into(),
            target: stage.target.clone(),
            format: stage.format,
            layout: stage.layout,
            stages: Vec::new(),
        }
    };
    if manifest.format != stage.format || manifest.layout != stage.layout {
        return Err(format!(
            "autosave target '{}' artifact metadata conflicts with its existing format or layout",
            stage.target
        ));
    }
    if let Some(existing) = manifest
        .stages
        .iter_mut()
        .find(|existing| existing.stage_index == stage.stage_index)
    {
        *existing = stage.clone();
    } else {
        manifest.stages.push(stage.clone());
        manifest.stages.sort_by_key(|stage| stage.stage_index);
    }
    let temporary = root.join(format!(".{}.autosave.json.tmp", stage.target));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContinuousIndexEntry {
    pub target_sample_index: u64,
    pub stage_id: String,
    pub stage_index: u64,
    pub stage_sample_index: u64,
    pub sample_kind: AutosaveSampleKind,
    pub coordinate: StageSampleCoordinate,
    pub payload_ref: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutosaveSampleKind {
    Table,
    Field,
}

pub trait AutosaveTargetWriter {
    fn begin_stage(&mut self, manifest: &StageManifest) -> Result<(), String>;
    fn append_table_row(
        &mut self,
        entry: &ContinuousIndexEntry,
        values: &[f64],
    ) -> Result<(), String>;
    fn append_field_sample(
        &mut self,
        entry: &ContinuousIndexEntry,
        quantity: &str,
        values: &[f64],
    ) -> Result<(), String>;
    fn finish_stage(&mut self, manifest: &StageManifest) -> Result<(), String>;
}

#[derive(Debug, Clone)]
pub struct AutosaveTargetState {
    target: String,
    schema: Option<AutosaveTargetSchema>,
    next_stage_index: u64,
    next_target_sample_index: u64,
    active: Option<ActiveStage>,
    continuous_index: Vec<ContinuousIndexEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AutosaveTargetSchema {
    format: AutosaveFormatIR,
    table_quantities: Vec<String>,
    field_quantities: Vec<String>,
}

#[derive(Debug, Clone)]
struct ActiveStage {
    manifest: StageManifest,
    next_table_sample: u64,
    next_field_sample: u64,
}

impl AutosaveTargetState {
    pub fn new(target: impl Into<String>) -> Self {
        Self {
            target: target.into(),
            schema: None,
            next_stage_index: 0,
            next_target_sample_index: 0,
            active: None,
            continuous_index: Vec::new(),
        }
    }

    pub fn begin_stage<W: AutosaveTargetWriter>(
        &mut self,
        writer: &mut W,
        stage_id: impl Into<String>,
        layout: AutosaveLayoutIR,
        format: AutosaveFormatIR,
        table_quantities: Vec<String>,
        mut field_quantities: Vec<String>,
    ) -> Result<&StageManifest, String> {
        if self.active.is_some() {
            return Err(format!(
                "autosave target '{}' already has an active stage",
                self.target
            ));
        }
        field_quantities.sort();
        let schema = AutosaveTargetSchema {
            format,
            table_quantities: table_quantities.clone(),
            field_quantities: field_quantities.clone(),
        };
        if layout == AutosaveLayoutIR::Continuous {
            if let Some(existing) = &self.schema {
                if existing != &schema {
                    return Err(format!(
                        "autosave target '{}' rejected schema drift before opening stage",
                        self.target
                    ));
                }
            } else {
                self.schema = Some(schema);
            }
        }
        let manifest = StageManifest {
            schema_version: "stage_autosave.v1".into(),
            target: self.target.clone(),
            stage_id: stage_id.into(),
            stage_index: self.next_stage_index,
            layout,
            format,
            table_quantities,
            field_quantities,
            complete: false,
            table_sample_count: 0,
            field_sample_count: 0,
        };
        writer.begin_stage(&manifest)?;
        self.next_stage_index += 1;
        self.active = Some(ActiveStage {
            manifest,
            next_table_sample: 0,
            next_field_sample: 0,
        });
        Ok(&self.active.as_ref().expect("active stage was set").manifest)
    }

    pub fn append_table_row<W: AutosaveTargetWriter>(
        &mut self,
        writer: &mut W,
        coordinate: StageSampleCoordinate,
        values: &[f64],
    ) -> Result<&ContinuousIndexEntry, String> {
        self.append(writer, AutosaveSampleKind::Table, coordinate, None, values)
    }

    pub fn append_field_sample<W: AutosaveTargetWriter>(
        &mut self,
        writer: &mut W,
        coordinate: StageSampleCoordinate,
        quantity: &str,
        values: &[f64],
    ) -> Result<&ContinuousIndexEntry, String> {
        self.append(
            writer,
            AutosaveSampleKind::Field,
            coordinate,
            Some(quantity),
            values,
        )
    }

    fn append<W: AutosaveTargetWriter>(
        &mut self,
        writer: &mut W,
        sample_kind: AutosaveSampleKind,
        coordinate: StageSampleCoordinate,
        quantity: Option<&str>,
        values: &[f64],
    ) -> Result<&ContinuousIndexEntry, String> {
        let active = self
            .active
            .as_mut()
            .ok_or_else(|| format!("autosave target '{}' has no active stage", self.target))?;
        let stage_sample_index = match sample_kind {
            AutosaveSampleKind::Table => active.next_table_sample,
            AutosaveSampleKind::Field => active.next_field_sample,
        };
        let payload_ref = match sample_kind {
            AutosaveSampleKind::Table => format!(
                "stages/stage_{:04}_{}/table/{stage_sample_index}",
                active.manifest.stage_index, active.manifest.stage_id
            ),
            AutosaveSampleKind::Field => format!(
                "stages/stage_{:04}_{}/fields/{}/{stage_sample_index}",
                active.manifest.stage_index,
                active.manifest.stage_id,
                quantity.unwrap_or("unknown")
            ),
        };
        let entry = ContinuousIndexEntry {
            target_sample_index: self.next_target_sample_index,
            stage_id: active.manifest.stage_id.clone(),
            stage_index: active.manifest.stage_index,
            stage_sample_index,
            sample_kind,
            coordinate,
            payload_ref,
        };
        match sample_kind {
            AutosaveSampleKind::Table => writer.append_table_row(&entry, values)?,
            AutosaveSampleKind::Field => {
                writer.append_field_sample(&entry, quantity.unwrap_or(""), values)?
            }
        }
        match sample_kind {
            AutosaveSampleKind::Table => {
                active.next_table_sample += 1;
                active.manifest.table_sample_count += 1;
            }
            AutosaveSampleKind::Field => {
                active.next_field_sample += 1;
                active.manifest.field_sample_count += 1;
            }
        }
        self.next_target_sample_index += 1;
        self.continuous_index.push(entry);
        Ok(self
            .continuous_index
            .last()
            .expect("index entry was pushed"))
    }

    pub fn finish_stage<W: AutosaveTargetWriter>(
        &mut self,
        writer: &mut W,
    ) -> Result<StageManifest, String> {
        let mut active = self
            .active
            .take()
            .ok_or_else(|| format!("autosave target '{}' has no active stage", self.target))?;
        active.manifest.complete = true;
        if let Err(error) = writer.finish_stage(&active.manifest) {
            active.manifest.complete = false;
            self.active = Some(active);
            return Err(error);
        }
        Ok(active.manifest)
    }

    pub fn recover_incomplete_stage(&self) -> Option<&StageManifest> {
        self.active.as_ref().map(|active| &active.manifest)
    }

    pub fn continuous_index(&self) -> &[ContinuousIndexEntry] {
        &self.continuous_index
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingWriter {
        finished: Vec<StageManifest>,
    }

    impl AutosaveTargetWriter for RecordingWriter {
        fn begin_stage(&mut self, _: &StageManifest) -> Result<(), String> {
            Ok(())
        }
        fn append_table_row(&mut self, _: &ContinuousIndexEntry, _: &[f64]) -> Result<(), String> {
            Ok(())
        }
        fn append_field_sample(
            &mut self,
            _: &ContinuousIndexEntry,
            _: &str,
            _: &[f64],
        ) -> Result<(), String> {
            Ok(())
        }
        fn finish_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
            self.finished.push(manifest.clone());
            Ok(())
        }
    }

    #[test]
    fn indexes_are_monotonic_while_stage_indexes_restart() {
        let mut state = AutosaveTargetState::new("main");
        let mut writer = RecordingWriter::default();
        for (stage, step) in [("relax", 10), ("run", 0)] {
            state
                .begin_stage(
                    &mut writer,
                    stage,
                    AutosaveLayoutIR::Continuous,
                    AutosaveFormatIR::Zarr,
                    vec!["step".into()],
                    vec![],
                )
                .unwrap();
            let coordinate = if stage == "relax" {
                StageSampleCoordinate::AcceptedStep {
                    accepted_step: step,
                }
            } else {
                StageSampleCoordinate::PhysicalTime { time_s: 1e-12 }
            };
            state
                .append_table_row(&mut writer, coordinate, &[step as f64])
                .unwrap();
            state.finish_stage(&mut writer).unwrap();
        }
        assert_eq!(
            state
                .continuous_index
                .iter()
                .map(|entry| entry.target_sample_index)
                .collect::<Vec<_>>(),
            [0, 1]
        );
        assert_eq!(
            state
                .continuous_index
                .iter()
                .map(|entry| entry.stage_sample_index)
                .collect::<Vec<_>>(),
            [0, 0]
        );
        assert!(matches!(
            state.continuous_index[0].coordinate,
            StageSampleCoordinate::AcceptedStep { .. }
        ));
        assert!(matches!(
            state.continuous_index[1].coordinate,
            StageSampleCoordinate::PhysicalTime { .. }
        ));
    }

    #[test]
    fn incomplete_stage_is_recoverable_and_index_contains_no_payload() {
        let mut state = AutosaveTargetState::new("main");
        let mut writer = RecordingWriter::default();
        state
            .begin_stage(
                &mut writer,
                "relax",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec!["step".into()],
                vec![],
            )
            .unwrap();
        state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 1 },
                &[42.0],
            )
            .unwrap();
        assert!(!state.recover_incomplete_stage().unwrap().complete);
        let encoded = serde_json::to_value(state.continuous_index()).unwrap();
        assert!(encoded[0].get("values").is_none());
        assert_eq!(encoded[0]["payload_ref"], "stages/stage_0000_relax/table/0");
    }

    #[test]
    fn continuous_schema_drift_is_rejected_before_writer_open() {
        let mut state = AutosaveTargetState::new("main");
        let mut writer = RecordingWriter::default();
        state
            .begin_stage(
                &mut writer,
                "one",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec!["mx".into()],
                vec![],
            )
            .unwrap();
        state.finish_stage(&mut writer).unwrap();
        let error = state
            .begin_stage(
                &mut writer,
                "two",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec!["my".into()],
                vec![],
            )
            .unwrap_err();
        assert!(error.contains("schema drift"));
        assert_eq!(writer.finished.len(), 1);
    }
}
