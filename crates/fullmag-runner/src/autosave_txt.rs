use crate::autosave_storage::{
    update_artifact_manifest, AutosaveTargetWriter, ContinuousIndexEntry, StageManifest,
    StageSampleCoordinate,
};
use fullmag_ir::AutosaveLayoutIR;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub struct TxtAutosaveWriter {
    root: PathBuf,
    current: Option<TxtStageFile>,
}

struct TxtStageFile {
    path: PathBuf,
    writer: BufWriter<File>,
    quantity_count: usize,
}

impl TxtAutosaveWriter {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            current: None,
        }
    }

    pub fn current_path(&self) -> Option<&Path> {
        self.current.as_ref().map(|current| current.path.as_path())
    }
}

impl AutosaveTargetWriter for TxtAutosaveWriter {
    fn begin_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
        if !manifest.field_quantities.is_empty() {
            return Err("TXT stage autosave supports scalar tables only".into());
        }
        fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        update_artifact_manifest(&self.root, manifest)?;
        let file_name = match manifest.layout {
            AutosaveLayoutIR::Continuous => format!("{}.txt", manifest.target),
            AutosaveLayoutIR::Separate => {
                format!(
                    "{}.stage_{:04}_{}.txt",
                    manifest.target, manifest.stage_index, manifest.stage_id
                )
            }
        };
        let path = self.root.join(file_name);
        let created = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                write_header(&mut file, &manifest.table_quantities)?;
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(error) => return Err(error.to_string()),
        };
        let file = OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        let mut writer = BufWriter::new(file);
        if !created && manifest.layout == AutosaveLayoutIR::Separate {
            return Err(format!(
                "separate TXT autosave file '{}' already exists",
                path.display()
            ));
        }
        writer.flush().map_err(|error| error.to_string())?;
        self.current = Some(TxtStageFile {
            path,
            writer,
            quantity_count: manifest.table_quantities.len(),
        });
        Ok(())
    }

    fn append_table_row(
        &mut self,
        entry: &ContinuousIndexEntry,
        values: &[f64],
    ) -> Result<(), String> {
        let current = self
            .current
            .as_mut()
            .ok_or_else(|| "TXT autosave has no active stage".to_string())?;
        if values.len() != current.quantity_count {
            return Err(format!(
                "TXT table row has {} values, expected {}",
                values.len(),
                current.quantity_count
            ));
        }
        let (clock_kind, coordinate) = match entry.coordinate {
            StageSampleCoordinate::PhysicalTime { time_s } => ("physical_time", time_s),
            StageSampleCoordinate::AcceptedStep { accepted_step } => {
                ("accepted_step", accepted_step as f64)
            }
        };
        write!(
            current.writer,
            "{}\t{}\t{}\t{}\t{}\t{coordinate:.17e}",
            entry.stage_id,
            entry.stage_index,
            entry.target_sample_index,
            entry.stage_sample_index,
            clock_kind,
        )
        .map_err(|error| error.to_string())?;
        for value in values {
            write!(current.writer, "\t{value:.17e}").map_err(|error| error.to_string())?;
        }
        writeln!(current.writer).map_err(|error| error.to_string())
    }

    fn append_field_sample(
        &mut self,
        _: &ContinuousIndexEntry,
        _: &str,
        _: &[f64],
    ) -> Result<(), String> {
        Err("TXT stage autosave does not support field samples".into())
    }

    fn finish_stage(&mut self, manifest: &StageManifest) -> Result<(), String> {
        let mut current = self
            .current
            .take()
            .ok_or_else(|| "TXT autosave has no active stage".to_string())?;
        current.writer.flush().map_err(|error| error.to_string())?;
        current
            .writer
            .get_ref()
            .sync_data()
            .map_err(|error| error.to_string())?;
        update_artifact_manifest(&self.root, manifest)
    }
}

fn write_header(file: &mut File, quantities: &[String]) -> Result<(), String> {
    write!(
        file,
        "stage_id\tstage_index\ttarget_sample_index\tstage_sample_index\tclock_kind\tcoordinate"
    )
    .map_err(|error| error.to_string())?;
    for quantity in quantities {
        write!(file, "\t{}", txt_quantity_header(quantity)).map_err(|error| error.to_string())?;
    }
    writeln!(file).map_err(|error| error.to_string())
}

fn txt_quantity_header(quantity: &str) -> String {
    let unit = match quantity {
        "mx" | "my" | "mz" => "1",
        "t" | "dt" | "time" | "solver_dt" => "s",
        "e_ex" | "e_demag" | "e_ext" | "e_drive" | "e_ani" | "e_dmi" | "e_total" => "J",
        "max_dm_dt" => "1/s",
        "max_h_eff" | "max_h_demag" | "max_torque" | "max_torque_Apm" => "A/m",
        "max_torque_T" => "T",
        _ if quantity.ends_with(".mx")
            || quantity.ends_with(".my")
            || quantity.ends_with(".mz") =>
        {
            "1"
        }
        _ => return quantity.to_string(),
    };
    format!("{quantity}[{unit}]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autosave_storage::AutosaveTargetState;
    use fullmag_ir::AutosaveFormatIR;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("fullmag-autosave-txt-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn continuous_txt_has_stable_header_stage_columns_and_append_order() {
        let root = temp_root();
        let mut writer = TxtAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        for stage_id in ["relax", "run"] {
            state
                .begin_stage(
                    &mut writer,
                    stage_id,
                    AutosaveLayoutIR::Continuous,
                    AutosaveFormatIR::Txt,
                    vec!["mx_Apm".into()],
                    vec![],
                )
                .unwrap();
            state
                .append_table_row(
                    &mut writer,
                    if stage_id == "relax" {
                        StageSampleCoordinate::AcceptedStep { accepted_step: 10 }
                    } else {
                        StageSampleCoordinate::PhysicalTime { time_s: 1e-12 }
                    },
                    &[0.5],
                )
                .unwrap();
            state.finish_stage(&mut writer).unwrap();
        }
        let text = fs::read_to_string(root.join("main.txt")).unwrap();
        let lines = text.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("stage_id\tstage_index"));
        assert!(lines[0].ends_with("mx_Apm"));
        assert!(lines[1].starts_with("relax\t0\t0\t0\taccepted_step"));
        assert!(lines[2].starts_with("run\t1\t1\t0\tphysical_time"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn separate_txt_uses_stage_filename_and_rejects_fields() {
        let root = temp_root();
        let mut writer = TxtAutosaveWriter::new(&root);
        let mut state = AutosaveTargetState::new("main");
        state
            .begin_stage(
                &mut writer,
                "relax",
                AutosaveLayoutIR::Separate,
                AutosaveFormatIR::Txt,
                vec!["mx".into()],
                vec![],
            )
            .unwrap();
        let path = writer.current_path().unwrap().to_owned();
        assert!(path.ends_with("main.stage_0000_relax.txt"));
        state.finish_stage(&mut writer).unwrap();
        let error = state
            .begin_stage(
                &mut writer,
                "bad",
                AutosaveLayoutIR::Separate,
                AutosaveFormatIR::Txt,
                vec![],
                vec!["m".into()],
            )
            .unwrap_err();
        assert!(error.contains("scalar tables only"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn default_magnetization_headers_declare_dimensionless_units() {
        assert_eq!(txt_quantity_header("mx"), "mx[1]");
        assert_eq!(txt_quantity_header("disk.my"), "disk.my[1]");
        assert_eq!(txt_quantity_header("e_total"), "e_total[J]");
    }
}
