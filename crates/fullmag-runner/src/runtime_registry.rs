use crate::fdm::gpu::cuda::native as native_fdm;
use crate::native_fem;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

fn default_strict() -> String {
    "strict".to_string()
}

fn default_production() -> String {
    "production".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEngine {
    pub backend: String,
    pub device: String,
    pub precision: String,
    #[serde(default = "default_strict")]
    pub mode: String,
    #[serde(default)]
    pub public: bool,
    #[serde(default = "default_production")]
    pub stability: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeManifest {
    pub family: String,
    pub version: String,
    pub worker: String,
    pub engines: Vec<ManifestEngine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineAvailabilityStatus {
    Available,
    MissingRuntime,
    MissingDriver,
    MissingLibrary,
    FeatureGated,
    Experimental,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostEngineEntry {
    pub backend: String,
    pub device: String,
    pub precision: String,
    pub mode: String,
    pub runtime_family: String,
    pub runtime_version: String,
    pub worker: String,
    pub status: EngineAvailabilityStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<String>,
    pub public: bool,
    pub stability: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostCapabilityMatrix {
    pub profile_version: String,
    pub engines: Vec<HostEngineEntry>,
}

#[derive(Debug, Clone)]
pub struct ResolvedRuntime {
    pub runtime_family: String,
    pub runtime_version: String,
    pub worker: String,
    pub engine_id: String,
}

pub struct RuntimeRegistry {
    manifests: Vec<(PathBuf, RuntimeManifest)>,
}

impl RuntimeRegistry {
    pub fn discover(runtimes_dir: &Path) -> Self {
        let mut manifests = Vec::new();
        if let Ok(entries) = std::fs::read_dir(runtimes_dir) {
            for entry in entries.flatten() {
                let pack_dir = entry.path();
                if !pack_dir.is_dir() {
                    continue;
                }

                let manifest_path = pack_dir.join("manifest.json");
                if !manifest_path.is_file() {
                    continue;
                }

                match std::fs::read_to_string(&manifest_path) {
                    Ok(content) => match serde_json::from_str::<RuntimeManifest>(&content) {
                        Ok(manifest) => manifests.push((pack_dir, manifest)),
                        Err(error) => eprintln!(
                            "warning: failed to parse runtime manifest {}: {}",
                            manifest_path.display(),
                            error
                        ),
                    },
                    Err(error) => eprintln!(
                        "warning: failed to read runtime manifest {}: {}",
                        manifest_path.display(),
                        error
                    ),
                }
            }
        }

        manifests.sort_by(|a, b| a.1.family.cmp(&b.1.family));
        Self { manifests }
    }

    pub fn capability_matrix(&self) -> HostCapabilityMatrix {
        let mut engines = Vec::new();

        for (pack_dir, manifest) in &self.manifests {
            let worker_path = pack_dir.join(&manifest.worker);
            let worker_exists = worker_path.is_file();

            for engine in &manifest.engines {
                let (status, status_reason) = if !worker_exists {
                    (
                        EngineAvailabilityStatus::MissingRuntime,
                        Some(format!(
                            "worker binary not found: {}",
                            worker_path.display()
                        )),
                    )
                } else if engine.device.eq_ignore_ascii_case("gpu")
                    && !gpu_available_for_backend(&engine.backend)
                {
                    (
                        EngineAvailabilityStatus::MissingDriver,
                        Some(gpu_unavailable_reason(&engine.backend)),
                    )
                } else {
                    (EngineAvailabilityStatus::Available, None)
                };

                engines.push(HostEngineEntry {
                    backend: engine.backend.clone(),
                    device: engine.device.clone(),
                    precision: engine.precision.clone(),
                    mode: engine.mode.clone(),
                    runtime_family: manifest.family.clone(),
                    runtime_version: manifest.version.clone(),
                    worker: manifest.worker.clone(),
                    status,
                    status_reason,
                    public: engine.public,
                    stability: engine.stability.clone(),
                });
            }
        }

        HostCapabilityMatrix {
            profile_version: "2026-04-06".to_string(),
            engines,
        }
    }

    pub fn resolve(&self, backend: &str, device: &str, precision: &str) -> Option<ResolvedRuntime> {
        let matrix = self.capability_matrix();
        matrix
            .engines
            .iter()
            .find(|entry| {
                entry.backend == backend
                    && entry.device == device
                    && entry.precision == precision
                    && entry.status == EngineAvailabilityStatus::Available
            })
            .map(|entry| ResolvedRuntime {
                runtime_family: entry.runtime_family.clone(),
                runtime_version: entry.runtime_version.clone(),
                worker: entry.worker.clone(),
                engine_id: format!("{}_{}", entry.backend, entry.device),
            })
    }
}

fn gpu_available_for_backend(backend: &str) -> bool {
    match backend {
        "fdm" => native_fdm::is_cuda_available(),
        "fem" => native_fem::is_gpu_available(),
        _ => false,
    }
}

fn gpu_unavailable_reason(backend: &str) -> String {
    match backend {
        "fdm" => "GPU runtime requires CUDA support on this host".to_string(),
        "fem" => "GPU runtime requires FEM GPU support on this host".to_string(),
        _ => format!("GPU runtime is not recognized for backend '{backend}'"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new() -> Self {
            let unique = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "fullmag-runtime-registry-tests-{}-{}-{}",
                std::process::id(),
                nanos,
                unique
            ));
            fs::create_dir_all(&path).expect("create temp test dir");
            Self { path }
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn discover_reads_runtime_manifests_from_direct_children() {
        let temp = TempDirGuard::new();
        let runtimes = temp.path.join("runtimes");
        fs::create_dir_all(runtimes.join("cpu-reference")).expect("create cpu runtime dir");
        fs::create_dir_all(runtimes.join("fdm-cuda")).expect("create gpu runtime dir");
        fs::create_dir_all(runtimes.join("ignored").join("nested")).expect("create nested dir");

        fs::write(
            runtimes.join("cpu-reference").join("manifest.json"),
            r#"{
                "family": "cpu-reference",
                "version": "0.1.0",
                "worker": "../../bin/fullmag-bin",
                "engines": [
                    {
                        "backend": "fdm",
                        "device": "cpu",
                        "precision": "double",
                        "public": true
                    }
                ]
            }"#,
        )
        .expect("write cpu manifest");
        fs::write(
            runtimes.join("fdm-cuda").join("manifest.json"),
            r#"{
                "family": "fdm-cuda",
                "version": "0.1.0",
                "worker": "bin/fullmag-fdm-cuda-bin",
                "engines": [
                    {
                        "backend": "fdm",
                        "device": "gpu",
                        "precision": "double",
                        "mode": "strict",
                        "public": true,
                        "stability": "production"
                    }
                ]
            }"#,
        )
        .expect("write gpu manifest");
        fs::write(
            runtimes
                .join("ignored")
                .join("nested")
                .join("manifest.json"),
            r#"{
                "family": "nested",
                "version": "0.1.0",
                "worker": "bin/worker",
                "engines": []
            }"#,
        )
        .expect("write nested manifest");

        let registry = RuntimeRegistry::discover(&runtimes);
        let matrix = registry.capability_matrix();

        assert_eq!(matrix.engines.len(), 2);

        let cpu = matrix
            .engines
            .iter()
            .find(|entry| entry.runtime_family == "cpu-reference")
            .expect("cpu entry");
        assert_eq!(cpu.backend, "fdm");
        assert_eq!(cpu.device, "cpu");
        assert_eq!(cpu.mode, "strict");
        assert_eq!(cpu.runtime_version, "0.1.0");

        let gpu = matrix
            .engines
            .iter()
            .find(|entry| entry.runtime_family == "fdm-cuda")
            .expect("gpu entry");
        assert_eq!(gpu.backend, "fdm");
        assert_eq!(gpu.device, "gpu");
        assert_eq!(gpu.precision, "double");
        assert_eq!(gpu.stability, "production");
    }

    #[test]
    fn capability_matrix_marks_missing_runtime_when_worker_is_absent() {
        let temp = TempDirGuard::new();
        let runtimes = temp.path.join("runtimes");
        let cpu_pack = runtimes.join("cpu-reference");
        fs::create_dir_all(cpu_pack.join("bin")).expect("create runtime tree");

        fs::write(
            cpu_pack.join("manifest.json"),
            r#"{
                "family": "cpu-reference",
                "version": "0.1.0",
                "worker": "bin/fullmag-bin",
                "engines": [
                    {
                        "backend": "fdm",
                        "device": "cpu",
                        "precision": "double"
                    }
                ]
            }"#,
        )
        .expect("write manifest");

        let missing_registry = RuntimeRegistry::discover(&runtimes);
        let missing_matrix = missing_registry.capability_matrix();
        assert_eq!(missing_matrix.engines.len(), 1);
        assert_eq!(
            missing_matrix.engines[0].status,
            EngineAvailabilityStatus::MissingRuntime
        );

        fs::write(cpu_pack.join("bin").join("fullmag-bin"), b"#!/bin/sh\n").expect("write worker");

        let present_registry = RuntimeRegistry::discover(&runtimes);
        let present_matrix = present_registry.capability_matrix();
        assert_ne!(
            present_matrix.engines[0].status,
            EngineAvailabilityStatus::MissingRuntime
        );
    }

    #[test]
    fn capability_matrix_gpu_detection_is_stable_without_panicking() {
        let temp = TempDirGuard::new();
        let runtimes = temp.path.join("runtimes");
        let gpu_pack = runtimes.join("fdm-cuda");
        fs::create_dir_all(gpu_pack.join("bin")).expect("create runtime tree");
        fs::write(gpu_pack.join("bin").join("fullmag-fdm-cuda-bin"), b"stub")
            .expect("write worker");
        fs::write(
            gpu_pack.join("manifest.json"),
            r#"{
                "family": "fdm-cuda",
                "version": "0.1.0",
                "worker": "bin/fullmag-fdm-cuda-bin",
                "engines": [
                    {
                        "backend": "fdm",
                        "device": "gpu",
                        "precision": "double"
                    }
                ]
            }"#,
        )
        .expect("write manifest");

        let registry = RuntimeRegistry::discover(&runtimes);
        let matrix = registry.capability_matrix();
        assert_eq!(matrix.engines.len(), 1);
        assert!(matches!(
            matrix.engines[0].status,
            EngineAvailabilityStatus::Available | EngineAvailabilityStatus::MissingDriver
        ));
    }
}
