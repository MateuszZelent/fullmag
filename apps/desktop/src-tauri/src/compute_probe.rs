//! Compute-environment probe behind the start screen's rail widget.
//!
//! It answers "can this machine run what I am about to open?" before anything
//! is opened. Detection shells out to `nvidia-smi`; a host without it is a
//! machine without a usable CUDA GPU, which is a result, not an error.

use serde_json::{json, Value};
use std::process::Command;

const MIB: u64 = 1024 * 1024;

/// One line of `--query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits`.
/// Memory is reported in MiB.
pub fn parse_gpu_line(line: &str) -> Option<Value> {
    let mut fields = line.rsplitn(3, ',');
    let free: u64 = fields.next()?.trim().parse().ok()?;
    let total: u64 = fields.next()?.trim().parse().ok()?;
    let name = fields.next()?.trim();
    if name.is_empty() || total == 0 {
        return None;
    }
    Some(json!({
        "name": name,
        "vram_total": total * MIB,
        "vram_free": free.min(total) * MIB,
    }))
}

/// `CUDA Version: 12.4` from the header of plain `nvidia-smi` output.
pub fn parse_cuda_version(output: &str) -> Option<String> {
    let marker = "CUDA Version:";
    let start = output.find(marker)? + marker.len();
    let version: String = output[start..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

pub fn probe() -> Value {
    let listing = run(
        "nvidia-smi",
        &[
            "--query-gpu=name,memory.total,memory.free",
            "--format=csv,noheader,nounits",
        ],
    );
    let cuda = run("nvidia-smi", &[]).and_then(|text| parse_cuda_version(&text));

    let gpus: Vec<Value> = listing
        .as_deref()
        .unwrap_or("")
        .lines()
        .filter_map(parse_gpu_line)
        .map(|mut gpu| {
            if let Some(version) = &cuda {
                gpu["cuda_version"] = Value::String(version.clone());
            }
            gpu
        })
        .collect();
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let preferred = if gpus.is_empty() { "cpu" } else { "cuda" };
    json!({
        "gpus": gpus,
        "cpu_threads": threads,
        "preferred_backend": preferred,
        "warnings": [],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_gpu_line_and_converts_mib_to_bytes() {
        let gpu = parse_gpu_line("NVIDIA GeForce RTX 4090, 24564, 18700").unwrap();
        assert_eq!(gpu["name"], "NVIDIA GeForce RTX 4090");
        assert_eq!(gpu["vram_total"], 24564u64 * MIB);
        assert_eq!(gpu["vram_free"], 18700u64 * MIB);
    }

    #[test]
    fn a_name_containing_a_comma_survives() {
        let gpu = parse_gpu_line("Tesla V100, 32GB, 32510, 32000").unwrap();
        assert_eq!(gpu["name"], "Tesla V100, 32GB");
    }

    #[test]
    fn free_memory_never_exceeds_total() {
        let gpu = parse_gpu_line("X, 100, 900").unwrap();
        assert_eq!(gpu["vram_free"], 100u64 * MIB);
    }

    #[test]
    fn rejects_lines_that_are_not_gpu_rows() {
        assert!(parse_gpu_line("").is_none());
        assert!(parse_gpu_line("No devices were found").is_none());
        assert!(parse_gpu_line("X, abc, 5").is_none());
        assert!(parse_gpu_line("X, 0, 0").is_none());
    }

    #[test]
    fn reads_the_cuda_version_from_the_smi_header() {
        let text = "| NVIDIA-SMI 551.23   Driver Version: 551.23   CUDA Version: 12.4     |";
        assert_eq!(parse_cuda_version(text).as_deref(), Some("12.4"));
        assert_eq!(parse_cuda_version("no marker here"), None);
    }
}
