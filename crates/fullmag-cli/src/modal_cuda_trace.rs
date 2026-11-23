//! Optional device-activity capture for a headless FEM GPU modal stage.
use anyhow::{bail, Context, Result};
use fullmag_ir::{BackendPlanIR, ExecutionPlanIR, FemEigenEngineIR};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const TRACE_ENV: &str = "FULLMAG_FEM_MODAL_CUDA_TRACE";
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DURATION_MS: u32 = 120_000;
const ACTIVITY_FILENAME: &str = "modal-cuda-activity.ndjson";

pub(crate) struct ModalCudaTrace {
    capture: fullmag_runner::FemCudaTrace,
    activity: File,
    receipt: PathBuf,
}

impl ModalCudaTrace {
    pub(crate) fn start(
        headless: bool,
        plan: &ExecutionPlanIR,
        directory: &Path,
    ) -> Result<Option<Self>> {
        let gpu_modal = matches!(&plan.backend_plan, BackendPlanIR::FemEigen(_))
            && plan
                .provenance
                .fem_eigen_execution_resolution
                .as_ref()
                .is_some_and(|resolved| {
                    resolved.resolved_engine == FemEigenEngineIR::GpuModalDeviceKrylov
                });
        if !headless || !gpu_modal {
            return Ok(None);
        }
        match std::env::var_os(TRACE_ENV) {
            None => return Ok(None),
            Some(value) if value == "0" => return Ok(None),
            Some(value) if value == "1" => {}
            Some(_) => bail!("{TRACE_ENV} must be 0 or 1"),
        }
        let path = directory.join(ACTIVITY_FILENAME);
        let activity = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .with_context(|| format!("create CUDA activity artifact {}", path.display()))?;
        let capture = fullmag_runner::FemCudaTrace::start_modal_sample(&activity, MAX_BYTES, MAX_DURATION_MS)
            .map_err(anyhow::Error::msg)?;
        Ok(Some(Self {
            capture,
            activity,
            receipt: directory.join("modal-cuda-activity.json"),
        }))
    }

    pub(crate) fn finish(mut self, run_id: &str, stage_id: &str) -> Result<()> {
        let end = self.capture.finish().map_err(anyhow::Error::msg)?;
        self.activity.sync_all()?;
        self.activity.seek(SeekFrom::Start(0))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = self.activity.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        crate::script_launch::write_json_atomically(
            &self.receipt,
            &serde_json::json!({
                "schema": "fullmag.headless.modal_cuda_activity.v1",
                "run_id": run_id,
                "stage_id": stage_id,
                "activity_filename": ACTIVITY_FILENAME,
                "activity_sha256": format!("{:x}", hasher.finalize()),
                "activity_bytes": self.activity.metadata()?.len(),
                "limits_apply_to": "ndjson_sample",
                "max_bytes": MAX_BYTES,
                "max_duration_ms": MAX_DURATION_MS,
                "end": end,
            }),
        )?;
        Ok(())
    }
}
