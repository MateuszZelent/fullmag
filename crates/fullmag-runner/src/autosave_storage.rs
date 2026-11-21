use fullmag_ir::{AutosaveFormatIR, AutosaveLayoutIR, StageCompletionIR};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Error, ErrorKind};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<StageCompletionIR>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StageManifestIdentity {
    pub target: String,
    pub stage_id: String,
    pub stage_index: u64,
}

/// Update the writer-identified stage and target manifest after the writer has
/// drained. Raw JSON preserves additive metadata from newer consumers.
pub(crate) fn finalize_stage_completion(
    stage_manifest_path: &Path,
    artifact_manifest_path: &Path,
    identity: &StageManifestIdentity,
    final_provenance: &serde_json::Value,
    completion: Option<&StageCompletionIR>,
) -> std::io::Result<()> {
    let original_stage = fs::read(stage_manifest_path)?;
    let original_artifact = fs::read(artifact_manifest_path)?;
    let mut stage: serde_json::Value =
        serde_json::from_slice(&original_stage).map_err(|error| {
            Error::new(
                ErrorKind::InvalidData,
                format!(
                    "stage manifest '{}' is invalid JSON: {error}",
                    stage_manifest_path.display()
                ),
            )
        })?;
    let mut artifact: serde_json::Value =
        serde_json::from_slice(&original_artifact).map_err(|error| {
            Error::new(
                ErrorKind::InvalidData,
                format!(
                    "autosave artifact manifest '{}' is invalid JSON: {error}",
                    artifact_manifest_path.display()
                ),
            )
        })?;

    validate_stage_identity(&stage, identity, stage_manifest_path)?;
    if artifact.get("target").and_then(serde_json::Value::as_str) != Some(identity.target.as_str())
    {
        return Err(Error::new(
            ErrorKind::InvalidData,
            format!(
                "autosave artifact manifest '{}' target does not match stage identity",
                artifact_manifest_path.display()
            ),
        ));
    }
    let stages = artifact
        .get_mut("stages")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| {
            Error::new(
                ErrorKind::InvalidData,
                format!(
                    "autosave artifact manifest '{}' has no stages array",
                    artifact_manifest_path.display()
                ),
            )
        })?;
    let same_index = stages
        .iter()
        .filter(|candidate| {
            candidate
                .get("stage_index")
                .and_then(serde_json::Value::as_u64)
                == Some(identity.stage_index)
        })
        .count();
    let mut matching = stages
        .iter_mut()
        .filter(|candidate| stage_identity_matches(candidate, identity));
    let Some(aggregate_stage) = matching.next() else {
        return Err(Error::new(
            ErrorKind::InvalidData,
            format!(
                "autosave artifact manifest '{}' does not contain stage target '{}' id '{}' index {}",
                artifact_manifest_path.display(),
                identity.target,
                identity.stage_id,
                identity.stage_index
            ),
        ));
    };
    if same_index != 1 || matching.next().is_some() {
        return Err(Error::new(
            ErrorKind::InvalidData,
            format!(
                "autosave artifact manifest '{}' has an ambiguous stage index {}",
                artifact_manifest_path.display(),
                identity.stage_index
            ),
        ));
    }
    if normalized_completion(&stage) != normalized_completion(aggregate_stage) {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "stage manifest and autosave aggregate disagree on completion",
        ));
    }

    let provenance = |value: &serde_json::Value| {
        value
            .get("provenance")
            .cloned()
            .filter(|value| !value.is_null())
    };
    if provenance(&stage) != provenance(aggregate_stage) {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "stage manifest and autosave aggregate disagree on producer provenance",
        ));
    }
    apply_completion(&mut stage, completion)?;
    apply_completion(aggregate_stage, completion)?;
    merge_final_provenance(&mut stage, final_provenance, stage_manifest_path)?;
    merge_final_provenance(aggregate_stage, final_provenance, artifact_manifest_path)?;
    let stage_bytes = serde_json::to_vec_pretty(&stage).map_err(|error| {
        Error::new(
            ErrorKind::InvalidData,
            format!("stage manifest cannot be serialized: {error}"),
        )
    })?;
    let artifact_bytes = serde_json::to_vec_pretty(&artifact).map_err(|error| {
        Error::new(
            ErrorKind::InvalidData,
            format!("autosave artifact manifest cannot be serialized: {error}"),
        )
    })?;

    // Only declared metadata inside this exact stage belongs to this writer.
    // Unwritten lazy field arrays have no attributes yet and remain absent.
    let stage_root = stage_manifest_path
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "stage manifest has no parent"))?;
    let mut updates = vec![
        (
            stage_manifest_path.to_path_buf(),
            original_stage,
            stage_bytes,
        ),
        (
            artifact_manifest_path.to_path_buf(),
            original_artifact,
            artifact_bytes,
        ),
    ];
    let mut metadata_paths = vec![stage_root.join("table/.zattrs")];
    if let Some(quantities) = stage
        .get("field_quantities")
        .and_then(serde_json::Value::as_array)
    {
        for quantity in quantities {
            let quantity = quantity.as_str().ok_or_else(|| {
                Error::new(
                    ErrorKind::InvalidData,
                    "stage field quantity must be a string",
                )
            })?;
            let mut components = Path::new(quantity).components();
            if !matches!(components.next(), Some(std::path::Component::Normal(_)))
                || components.next().is_some()
            {
                return Err(Error::new(
                    ErrorKind::InvalidData,
                    "stage field quantity is not a single path component",
                ));
            }
            metadata_paths.push(stage_root.join("fields").join(quantity).join(".zattrs"));
        }
    }
    for path in metadata_paths {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let mut attrs: serde_json::Value = serde_json::from_slice(&bytes)?;
        if attrs
            .get("completion_stage_identity")
            .is_some_and(|value| !stage_identity_matches(value, identity))
        {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "stage field metadata belongs to a different stage identity",
            ));
        }
        merge_final_provenance(&mut attrs, final_provenance, &path)?;
        apply_completion(&mut attrs, completion)?;
        attrs.as_object_mut().expect("metadata object validated above").insert(
            "completion_stage_identity".into(), serde_json::json!({
                "target": identity.target, "stage_id": identity.stage_id, "stage_index": identity.stage_index,
            }),
        );
        updates.push((path, bytes, serde_json::to_vec_pretty(&attrs)?));
    }
    for (index, (path, _, bytes)) in updates.iter().enumerate() {
        if let Err(error) = write_bytes_atomic(path, bytes) {
            let mut rollback_errors = Vec::new();
            for (path, original, _) in updates[..index].iter().rev() {
                if let Err(rollback_error) = write_bytes_atomic(path, original) {
                    rollback_errors.push(rollback_error.to_string());
                }
            }
            return Err(Error::new(
                error.kind(),
                format!(
                    "stage metadata finalization failed: {error}; rollback errors: {rollback_errors:?}"
                ),
            ));
        }
    }
    Ok(())
}

fn stage_identity_matches(value: &serde_json::Value, identity: &StageManifestIdentity) -> bool {
    value.get("target").and_then(serde_json::Value::as_str) == Some(identity.target.as_str())
        && value.get("stage_id").and_then(serde_json::Value::as_str)
            == Some(identity.stage_id.as_str())
        && value.get("stage_index").and_then(serde_json::Value::as_u64)
            == Some(identity.stage_index)
}

fn validate_stage_identity(
    value: &serde_json::Value,
    identity: &StageManifestIdentity,
    path: &Path,
) -> std::io::Result<()> {
    if stage_identity_matches(value, identity) {
        Ok(())
    } else {
        Err(Error::new(
            ErrorKind::InvalidData,
            format!(
                "stage manifest '{}' does not match target '{}' stage '{}' index {}",
                path.display(),
                identity.target,
                identity.stage_id,
                identity.stage_index
            ),
        ))
    }
}

fn normalized_completion(value: &serde_json::Value) -> Option<&serde_json::Value> {
    value
        .get("completion")
        .filter(|completion| !completion.is_null())
}

fn apply_completion(
    value: &mut serde_json::Value,
    completion: Option<&StageCompletionIR>,
) -> std::io::Result<()> {
    let object = value.as_object_mut().ok_or_else(|| {
        Error::new(
            ErrorKind::InvalidData,
            "stage completion manifest must be a JSON object",
        )
    })?;
    if let Some(completion) = completion {
        object.insert(
            "completion".into(),
            serde_json::to_value(completion).map_err(|error| {
                Error::new(
                    ErrorKind::InvalidData,
                    format!("stage completion cannot be serialized: {error}"),
                )
            })?,
        );
    } else {
        object.remove("completion");
    }
    Ok(())
}

/// Refresh measured execution data without accepting a different producer.
/// Unknown additive metadata survives finalization.
pub(crate) fn merge_final_provenance(
    value: &mut serde_json::Value,
    final_provenance: &serde_json::Value,
    path: &Path,
) -> std::io::Result<()> {
    let final_provenance = final_provenance.as_object().ok_or_else(|| {
        Error::new(
            ErrorKind::InvalidInput,
            "final provenance must be an object",
        )
    })?;
    let object = value.as_object_mut().ok_or_else(|| {
        Error::new(
            ErrorKind::InvalidData,
            "stage metadata must be a JSON object",
        )
    })?;
    let provenance = object
        .entry("provenance")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            Error::new(
                ErrorKind::InvalidData,
                format!(
                    "stage metadata '{}' provenance must be an object",
                    path.display()
                ),
            )
        })?;
    for key in [
        "problem_name",
        "ir_version",
        "source_hash",
        "build_identity",
    ] {
        if let (Some(existing), Some(expected)) = (provenance.get(key), final_provenance.get(key)) {
            if existing != expected {
                return Err(Error::new(
                    ErrorKind::InvalidData,
                    format!(
                        "stage metadata '{}' has a different producer {key}",
                        path.display()
                    ),
                ));
            }
        }
    }
    provenance.extend(
        final_provenance
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    Ok(())
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    crate::autosave_zarr::write_bytes_atomic(path, bytes)
        .map_err(|error| Error::new(ErrorKind::Other, error))
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
    /// Stage-wide ordinal within sample_kind. Field quantities share this
    /// sequence; payload_ref carries the independent per-quantity array row.
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
    next_field_sample_by_quantity: BTreeMap<String, u64>,
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

    pub fn resume(root: &Path, target: impl Into<String>) -> Result<Self, String> {
        let target = target.into();
        let path = root.join(format!("{target}.autosave.json"));
        if !path.exists() {
            return Ok(Self::new(target));
        }
        let manifest = serde_json::from_slice::<AutosaveArtifactManifest>(
            &fs::read(&path).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        if manifest.target != target {
            return Err(format!(
                "autosave manifest target '{}' does not match requested target '{}'",
                manifest.target, target
            ));
        }
        let schema = manifest.stages.first().map(|stage| AutosaveTargetSchema {
            format: stage.format,
            table_quantities: stage.table_quantities.clone(),
            field_quantities: stage.field_quantities.clone(),
        });
        Ok(Self {
            target,
            schema,
            next_stage_index: manifest
                .stages
                .iter()
                .map(|stage| stage.stage_index)
                .max()
                .map_or(0, |index| index + 1),
            next_target_sample_index: manifest
                .stages
                .iter()
                .map(|stage| stage.table_sample_count + stage.field_sample_count)
                .sum(),
            active: None,
            continuous_index: Vec::new(),
        })
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
            provenance: None,
            completion: None,
        };
        writer.begin_stage(&manifest)?;
        self.next_stage_index += 1;
        self.active = Some(ActiveStage {
            manifest,
            next_table_sample: 0,
            next_field_sample: 0,
            next_field_sample_by_quantity: BTreeMap::new(),
        });
        Ok(&self.active.as_ref().expect("active stage was set").manifest)
    }

    pub fn update_active_provenance(
        &mut self,
        provenance: serde_json::Value,
    ) -> Result<(), String> {
        let active = self
            .active
            .as_mut()
            .ok_or_else(|| format!("autosave target '{}' has no active stage", self.target))?;
        active.manifest.provenance = Some(provenance);
        Ok(())
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
        // Logical field ordering is stage-wide, but numerical arrays append
        // independently per quantity (including unequal autosave cadences).
        let payload_sample_index = match sample_kind {
            AutosaveSampleKind::Table => stage_sample_index,
            AutosaveSampleKind::Field => *active
                .next_field_sample_by_quantity
                .get(quantity.unwrap_or(""))
                .unwrap_or(&0),
        };
        let payload_ref = match sample_kind {
            AutosaveSampleKind::Table => format!(
                "stages/stage_{:04}_{}/table/{stage_sample_index}",
                active.manifest.stage_index, active.manifest.stage_id
            ),
            AutosaveSampleKind::Field => format!(
                "stages/stage_{:04}_{}/fields/{}/{payload_sample_index}",
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
                *active
                    .next_field_sample_by_quantity
                    .entry(quantity.unwrap_or("").to_string())
                    .or_default() += 1;
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

    fn completion_stage(target: &str, stage_id: &str, stage_index: u64) -> StageManifest {
        StageManifest {
            schema_version: "stage_autosave.v1".into(),
            target: target.into(),
            stage_id: stage_id.into(),
            stage_index,
            layout: AutosaveLayoutIR::Separate,
            format: AutosaveFormatIR::Zarr,
            table_quantities: vec![],
            field_quantities: vec!["m".into()],
            complete: true,
            table_sample_count: 0,
            field_sample_count: 1,
            provenance: Some(serde_json::json!({"problem_name": "fixture"})),
            completion: None,
        }
    }

    #[test]
    fn legacy_stage_manifest_defaults_to_no_completion() {
        let mut value = serde_json::to_value(completion_stage("state", "relax", 0)).unwrap();
        value.as_object_mut().unwrap().remove("completion");
        let decoded: StageManifest = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.completion, None);
        assert!(
            serde_json::to_value(decoded)
                .unwrap()
                .get("completion")
                .is_none()
        );
    }

    #[test]
    fn completion_finalizer_matches_identity_and_preserves_other_stages() {
        let root =
            std::env::temp_dir().join(format!("fullmag-stage-completion-{}", uuid::Uuid::new_v4()));
        let earlier = completion_stage("state", "relax", 0);
        let current = completion_stage("state", "run", 1);
        let earlier_path = root.join("state.zarr/stages/stage_0000_relax/manifest.json");
        let current_path = root.join("state.zarr/stages/stage_0001_run/manifest.json");
        fs::create_dir_all(earlier_path.parent().unwrap()).unwrap();
        fs::create_dir_all(current_path.parent().unwrap()).unwrap();
        let mut earlier_json = serde_json::to_value(&earlier).unwrap();
        earlier_json["retained_extension"] = serde_json::json!({"keep": true});
        fs::write(
            &earlier_path,
            serde_json::to_vec_pretty(&earlier_json).unwrap(),
        )
        .unwrap();
        fs::write(&current_path, serde_json::to_vec_pretty(&current).unwrap()).unwrap();
        update_artifact_manifest(&root, &earlier).unwrap();
        update_artifact_manifest(&root, &current).unwrap();
        let artifact_path = root.join("state.autosave.json");
        let identity = StageManifestIdentity {
            target: "state".into(),
            stage_id: "run".into(),
            stage_index: 1,
        };
        let producer = serde_json::json!({"problem_name":"fixture", "ir_version":"v0", "source_hash":null, "build_identity":{"git_commit":"fixture"}});
        let completion = StageCompletionIR {
            status: "completed".into(),
            converged: false,
            reason: Some(fullmag_ir::StageStopReason::MaxSteps),
            metric: Some(fullmag_ir::StageMetricKind::Steps),
            metric_name: Some("step".into()),
            metric_value: Some(8.0),
            threshold: Some(8.0),
        };
        finalize_stage_completion(
            &current_path,
            &artifact_path,
            &identity,
            &producer,
            Some(&completion),
        )
        .unwrap();

        let stage: serde_json::Value =
            serde_json::from_slice(&fs::read(&current_path).unwrap()).unwrap();
        let artifact: serde_json::Value =
            serde_json::from_slice(&fs::read(&artifact_path).unwrap()).unwrap();
        let earlier_value: serde_json::Value =
            serde_json::from_slice(&fs::read(&earlier_path).unwrap()).unwrap();
        assert_eq!(
            stage["completion"],
            serde_json::to_value(&completion).unwrap()
        );
        assert_eq!(artifact["stages"][1]["completion"], stage["completion"]);
        assert_eq!(
            stage["provenance"]["build_identity"],
            producer["build_identity"]
        );
        assert_eq!(artifact["stages"][1]["provenance"], stage["provenance"]);
        assert!(earlier_value.get("completion").is_none());
        assert_eq!(earlier_value["retained_extension"]["keep"], true);

        let stage_before = fs::read(&current_path).unwrap();
        let artifact_before = fs::read(&artifact_path).unwrap();
        let mut wrong_producer = producer.clone();
        wrong_producer["source_hash"] = serde_json::json!("another-source");
        assert!(
            finalize_stage_completion(
                &current_path,
                &artifact_path,
                &identity,
                &wrong_producer,
                None
            )
            .is_err()
        );
        assert_eq!(fs::read(&current_path).unwrap(), stage_before);
        assert_eq!(fs::read(&artifact_path).unwrap(), artifact_before);
        for wrong in [
            StageManifestIdentity {
                target: "foreign".into(),
                stage_id: "run".into(),
                stage_index: 1,
            },
            StageManifestIdentity {
                target: "state".into(),
                stage_id: "other".into(),
                stage_index: 1,
            },
            StageManifestIdentity {
                target: "state".into(),
                stage_id: "run".into(),
                stage_index: 2,
            },
        ] {
            assert!(
                finalize_stage_completion(&current_path, &artifact_path, &wrong, &producer, None)
                    .is_err()
            );
            assert_eq!(fs::read(&current_path).unwrap(), stage_before);
            assert_eq!(fs::read(&artifact_path).unwrap(), artifact_before);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[derive(Default)]
    struct RecordingWriter {
        finished: Vec<StageManifest>,
        fail_field_once: bool,
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
            if std::mem::take(&mut self.fail_field_once) {
                return Err("injected field append failure".into());
            }
            Ok(())
        }
        fn finish_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
            self.finished.push(manifest.clone());
            Ok(())
        }
    }

    #[test]
    fn field_payload_rows_are_quantity_local_while_logical_ordinals_stay_global() {
        let mut state = AutosaveTargetState::new("main");
        let mut writer = RecordingWriter::default();
        state
            .begin_stage(
                &mut writer,
                "relax",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec!["step".into()],
                vec!["m".into(), "H_eff".into()],
            )
            .unwrap();
        state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::AcceptedStep { accepted_step: 0 },
                &[0.0],
            )
            .unwrap();
        for (step, quantity) in [(0, "m"), (0, "H_eff"), (1, "m"), (2, "m"), (2, "H_eff")] {
            state
                .append_field_sample(
                    &mut writer,
                    StageSampleCoordinate::AcceptedStep {
                        accepted_step: step,
                    },
                    quantity,
                    &[1.0, 0.0, 0.0],
                )
                .unwrap();
        }
        let fields = &state.continuous_index()[1..];
        assert_eq!(
            fields
                .iter()
                .map(|e| e.stage_sample_index)
                .collect::<Vec<_>>(),
            [0, 1, 2, 3, 4]
        );
        assert_eq!(
            fields
                .iter()
                .map(|e| e.target_sample_index)
                .collect::<Vec<_>>(),
            [1, 2, 3, 4, 5]
        );
        assert_eq!(
            fields
                .iter()
                .map(|e| e.payload_ref.as_str())
                .collect::<Vec<_>>(),
            [
                "stages/stage_0000_relax/fields/m/0",
                "stages/stage_0000_relax/fields/H_eff/0",
                "stages/stage_0000_relax/fields/m/1",
                "stages/stage_0000_relax/fields/m/2",
                "stages/stage_0000_relax/fields/H_eff/1"
            ]
        );
        let manifest = state.finish_stage(&mut writer).unwrap();
        assert_eq!(manifest.field_sample_count, 5);
        assert_eq!(manifest.table_sample_count, 1);
        state
            .begin_stage(
                &mut writer,
                "run",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec!["step".into()],
                vec!["m".into(), "H_eff".into()],
            )
            .unwrap();
        let entry = state
            .append_field_sample(
                &mut writer,
                StageSampleCoordinate::PhysicalTime { time_s: 1.0 },
                "m",
                &[1.0, 0.0, 0.0],
            )
            .unwrap();
        assert_eq!(entry.target_sample_index, 6);
        assert_eq!(entry.stage_sample_index, 0);
        assert_eq!(entry.payload_ref, "stages/stage_0001_run/fields/m/0");
    }

    #[test]
    fn failed_field_append_does_not_advance_quantity_or_logical_indices() {
        let mut state = AutosaveTargetState::new("main");
        let mut writer = RecordingWriter {
            fail_field_once: true,
            ..Default::default()
        };
        state
            .begin_stage(
                &mut writer,
                "relax",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec![],
                vec!["m".into()],
            )
            .unwrap();
        let coordinate = StageSampleCoordinate::AcceptedStep { accepted_step: 0 };
        assert!(state
            .append_field_sample(&mut writer, coordinate, "m", &[1.0])
            .is_err());
        assert!(state.continuous_index().is_empty());
        let entry = state
            .append_field_sample(&mut writer, coordinate, "m", &[1.0])
            .unwrap();
        assert_eq!(entry.target_sample_index, 0);
        assert_eq!(entry.stage_sample_index, 0);
        assert_eq!(entry.payload_ref, "stages/stage_0000_relax/fields/m/0");
        assert_eq!(
            state.finish_stage(&mut writer).unwrap().field_sample_count,
            1
        );
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

    #[test]
    fn resume_continues_stage_and_target_sample_indexes_from_manifest() {
        let root =
            std::env::temp_dir().join(format!("fullmag-autosave-resume-{}", uuid::Uuid::new_v4()));
        update_artifact_manifest(
            &root,
            &StageManifest {
                schema_version: "stage_autosave.v1".into(),
                target: "main".into(),
                stage_id: "relax".into(),
                stage_index: 3,
                layout: AutosaveLayoutIR::Continuous,
                format: AutosaveFormatIR::Zarr,
                table_quantities: vec!["step".into()],
                field_quantities: vec!["m".into()],
                complete: true,
                table_sample_count: 2,
                field_sample_count: 1,
                provenance: None,
                completion: None,
            },
        )
        .unwrap();

        let mut state = AutosaveTargetState::resume(&root, "main").unwrap();
        let mut writer = RecordingWriter::default();
        let stage = state
            .begin_stage(
                &mut writer,
                "run",
                AutosaveLayoutIR::Continuous,
                AutosaveFormatIR::Zarr,
                vec!["step".into()],
                vec!["m".into()],
            )
            .unwrap();
        assert_eq!(stage.stage_index, 4);
        let entry = state
            .append_table_row(
                &mut writer,
                StageSampleCoordinate::PhysicalTime { time_s: 1e-12 },
                &[4.0],
            )
            .unwrap();
        assert_eq!(entry.target_sample_index, 3);
        fs::remove_dir_all(root).unwrap();
    }
}
