#!/usr/bin/env python3
"""Run and validate the managed BORIS N/F reciprocal-SHE diagnostic."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import subprocess
from dataclasses import replace
from pathlib import Path
from typing import Mapping, Sequence

from boris_nf_interface_smoke import NfCaseConfig, render_boris_script, scenario_manifest
from verify_boris_nf_interface import (
    MeshFields,
    ScenarioParameters,
    compute_field_residuals,
    compute_interface_balance,
    compute_interface_slice,
    read_text_ovf,
    validate_boris_artifact,
)


DEFAULT_BORIS_IMAGE = (
    "nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f"
)
REQUIRED_NORMAL_FIELDS = ("V", "S", "Jc", "Jsx", "Jsy", "Jsz")
REQUIRED_FERROMAGNET_FIELDS = REQUIRED_NORMAL_FIELDS + ("Ts", "Tsi")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_manifest_path(build_root: Path) -> Path:
    candidates = (
        build_root / "source_manifest.json",
        build_root / "source-manifest.json",
        build_root.parent / "source_manifest.json",
        build_root.parent / "source-manifest.json",
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError(
        "BORIS source manifest is missing; expected source_manifest.json beside BorisLin"
    )


def _probe_host_binary(binary: Path, device: str) -> dict[str, object]:
    try:
        result = subprocess.run(
            [str(binary), "-version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"cannot probe BorisLin version: {error}") from error
    if result.returncode != 0:
        raise RuntimeError(
            f"BorisLin -version failed with exit code {result.returncode}: {result.stderr.strip()}"
        )
    version = next(
        (line.strip() for line in (result.stdout + "\n" + result.stderr).splitlines() if "BORIS" in line),
        "",
    )
    if not version:
        raise RuntimeError("BorisLin version probe did not return a BORIS version")
    return {
        "binary_version": version,
        "python_version": platform.python_version(),
        "device_detected": "cpu" if device == "cpu" else "host-cuda",
        "compute_capability": None if device == "cpu" else "host-cuda",
        "device_residency_evidence": f"host BorisLin -g {'-1' if device == 'cpu' else '0'} probe",
        "probe_stdout_sha256": hashlib.sha256(result.stdout.encode()).hexdigest(),
        "probe_stderr_sha256": hashlib.sha256(result.stderr.encode()).hexdigest(),
    }


def capture_runtime_identity(
    build_root: Path,
    image_digest: str,
    device: str,
    *,
    runtime_probe: Mapping[str, object] | None = None,
) -> dict[str, object]:
    """Capture immutable BORIS source, binary, image, and device identity."""

    if device not in {"cpu", "cuda"}:
        raise ValueError("device must be cpu or cuda")
    binary = build_root / "BorisLin"
    if not binary.is_file():
        raise RuntimeError(f"BorisLin binary is missing: {binary}")
    if not os.access(binary, os.X_OK):
        raise RuntimeError(f"BorisLin binary is not executable: {binary}")
    digest_match = re.search(r"(?:^|@)sha256:([0-9a-fA-F]{64})$", image_digest or "")
    if digest_match is None:
        raise RuntimeError("BORIS runtime image must be pinned by digest")
    manifest = _source_manifest_path(build_root)
    probe = dict(runtime_probe) if runtime_probe is not None else _probe_host_binary(binary, device)
    required_probe = ("binary_version", "python_version", "device_detected", "device_residency_evidence")
    missing_probe = [key for key in required_probe if not probe.get(key)]
    if missing_probe:
        raise RuntimeError(f"managed BORIS runtime probe is incomplete: {', '.join(missing_probe)}")
    identity: dict[str, object] = {
        "schema_version": "fullmag.boris.runtime.v1",
        "identity_complete": True,
        "source_manifest": str(manifest),
        "source_manifest_sha256": _sha256(manifest),
        "binary": str(binary),
        "binary_sha256": _sha256(binary),
        "image_digest": image_digest,
        "binary_version": str(probe["binary_version"]),
        "python_version": str(probe["python_version"]),
        "device_requested": device,
        "device_detected": str(probe["device_detected"]),
        "compute_capability": probe.get("compute_capability"),
        "device_residency_evidence": str(probe["device_residency_evidence"]),
        "precision": "double",
        "probe_stdout_sha256": str(probe.get("probe_stdout_sha256", "")),
        "probe_stderr_sha256": str(probe.get("probe_stderr_sha256", "")),
    }
    validate_runtime_identity(identity)
    return identity


def validate_runtime_identity(identity: Mapping[str, object]) -> None:
    required = (
        "schema_version",
        "source_manifest_sha256",
        "binary_sha256",
        "image_digest",
        "binary_version",
        "python_version",
        "device_requested",
        "device_detected",
        "device_residency_evidence",
        "precision",
    )
    if identity.get("schema_version") != "fullmag.boris.runtime.v1":
        raise ValueError("BORIS runtime identity schema is unsupported")
    if identity.get("identity_complete") is not True:
        raise ValueError("BORIS runtime identity is incomplete")
    missing = [key for key in required if not identity.get(key)]
    if missing:
        raise ValueError(f"BORIS runtime identity is missing: {', '.join(missing)}")
    if identity.get("device_requested") not in {"cpu", "cuda"}:
        raise ValueError("BORIS runtime identity has an invalid requested device")
    if identity.get("precision") != "double":
        raise ValueError("BORIS diagnostic requires double precision")
    if identity.get("device_requested") == "cuda":
        if not identity.get("compute_capability"):
            raise ValueError("CUDA runtime identity is missing compute capability")
        if not identity.get("nvidia_smi_query"):
            raise ValueError("CUDA runtime identity is missing nvidia-smi evidence")


def _probe_from_managed_log(stdout: str, stderr: str, device: str) -> dict[str, object]:
    combined = stdout + "\n" + stderr
    version = next((line.strip() for line in combined.splitlines() if "BORIS" in line and "version" in line), "")
    python_line = next((line.strip() for line in combined.splitlines() if re.match(r"^Python \d+\.\d+", line.strip())), "")
    if not version or not python_line:
        raise RuntimeError("managed BORIS output is missing Python or BorisLin version identity")
    probe: dict[str, object] = {
        "binary_version": version,
        "python_version": python_line.removeprefix("Python "),
        "probe_stdout_sha256": hashlib.sha256(stdout.encode()).hexdigest(),
        "probe_stderr_sha256": hashlib.sha256(stderr.encode()).hexdigest(),
    }
    if device == "cpu":
        probe.update(
            {
                "device_detected": "cpu",
                "compute_capability": None,
                "device_residency_evidence": "managed BORIS command used -g -1",
            }
        )
    else:
        gpu_line = next(
            (line.strip() for line in combined.splitlines() if "," in line and "compute" not in line.lower()),
            "",
        )
        if not gpu_line:
            raise RuntimeError("managed CUDA output is missing nvidia-smi identity")
        parts = [part.strip() for part in gpu_line.split(",", 1)]
        probe.update(
            {
                "device_detected": parts[0],
                "compute_capability": parts[1] if len(parts) == 2 else "",
                "nvidia_smi_query": gpu_line,
                "device_residency_evidence": "nvidia-smi plus managed BORIS command used -g 0",
            }
        )
    return probe


def _managed_shell(
    *,
    device: str,
    timeout_s: int,
    binary_path: str,
    scenario_path: str,
    install_python: bool,
) -> str:
    setup = ""
    if install_python:
        setup = (
            "export DEBIAN_FRONTEND=noninteractive; "
            "apt-get update -qq; "
            "apt-get install -y -qq --no-install-recommends "
            "python3.10 libpython3.10 libfftw3-3 python3-numpy python3-matplotlib >/tmp/boris-apt.log; "
        )
    gpu = "-1" if device == "cpu" else "0"
    gpu_probe = ""
    if device == "cuda":
        gpu_probe = "nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader; "
    return (
        f"{setup}python3.10 --version; {binary_path} -version; {gpu_probe}"
        f"timeout {int(timeout_s)} {binary_path} -s {scenario_path} -g {gpu}"
    )


def _managed_command(
    build_root: Path,
    output_dir: Path,
    device: str,
    image_digest: str,
    timeout_s: int,
    runtime_container: str | None,
) -> list[str]:
    if runtime_container:
        mount_root = build_root.parent if build_root.name == "source" else build_root
        binary_path = (
            f"/boris-root/{build_root.name}/BorisLin"
            if mount_root != build_root
            else "/boris-root/BorisLin"
        )
        try:
            relative_output = output_dir.resolve().relative_to(mount_root.resolve())
        except ValueError as error:
            raise RuntimeError(
                "runtime container mode requires output_dir below the mounted BORIS build root"
            ) from error
        report_path = Path("/boris-root") / relative_output
        shell = _managed_shell(
            device=device,
            timeout_s=timeout_s,
            binary_path=binary_path,
            scenario_path=str(report_path / "scenario.py"),
            install_python=False,
        )
        return ["docker", "exec", runtime_container, "bash", "-lc", shell]
    docker_args = ["docker", "run", "--rm"]
    if device == "cuda":
        docker_args.extend(["--gpus", "all"])
    docker_args.extend(
        [
            "-v",
            f"{build_root.resolve()}:/boris-root:ro",
            "-v",
            f"{output_dir.resolve()}:/report",
            "-w",
            "/report",
            image_digest,
            "bash",
            "-lc",
            _managed_shell(
                device=device,
                timeout_s=timeout_s,
                binary_path="/boris-root/BorisLin",
                scenario_path="/report/scenario.py",
                install_python=True,
            ),
        ]
    )
    return docker_args


def _scenario_output_path(build_root: Path, output_dir: Path, runtime_container: str | None) -> Path:
    if not runtime_container:
        return Path("/report")
    mount_root = build_root.parent if build_root.name == "source" else build_root
    try:
        relative_output = output_dir.resolve().relative_to(mount_root.resolve())
    except ValueError as error:
        raise RuntimeError(
            "runtime container mode requires output_dir below the mounted BORIS build root"
        ) from error
    return Path("/boris-root") / relative_output


def _mesh_fields(root: Path, prefix: str) -> MeshFields:
    fields = {name: read_text_ovf(root / f"{prefix}_{name}.ovf") for name in REQUIRED_NORMAL_FIELDS}
    return MeshFields(
        charge_current=fields["Jc"],
        spin_current_x=fields["Jsx"],
        spin_current_y=fields["Jsy"],
        spin_current_z=fields["Jsz"],
        spin_accumulation=fields["S"],
    )


def _artifact_summary(root: Path, config: NfCaseConfig, identity: Mapping[str, object]) -> dict[str, object]:
    manifest = scenario_manifest(config)
    normal = _mesh_fields(root, "n")
    ferromagnet = _mesh_fields(root, "f")
    parameters = manifest["parameters"]
    solver_parameters = ScenarioParameters(
        conductivity_spm=float(parameters["elC_Spm"]),
        de_m2_per_s=float(parameters["De_m2_per_s"]),
        lambda_sf_m=float(parameters["lambda_sf_m"]),
    )
    normal_residuals = compute_field_residuals(normal, solver_parameters)
    ferromagnet_residuals = compute_field_residuals(ferromagnet, solver_parameters)
    interface = compute_interface_slice(
        normal,
        ferromagnet,
        read_text_ovf(root / "f_Tsi.ovf"),
        normal_axis="z",
        normal_sign=1,
    )
    balances = compute_interface_balance(interface)
    residuals = {
        "charge_scaled_l2": max(
            float(normal_residuals["charge_scaled_l2"]),
            float(ferromagnet_residuals["charge_scaled_l2"]),
        ),
        "spin_scaled_l2": max(
            float(normal_residuals["spin_scaled_l2"]),
            float(ferromagnet_residuals["spin_scaled_l2"]),
        ),
        "by_mesh": {"normal": normal_residuals, "ferromagnet": ferromagnet_residuals},
        "charge_residual_tolerance": config.transport_tolerance,
        "spin_residual_tolerance": config.transport_tolerance,
    }
    field_map = {
        "normal": {name: f"n_{name}.ovf" for name in REQUIRED_NORMAL_FIELDS},
        "ferromagnet": {name: f"f_{name}.ovf" for name in REQUIRED_FERROMAGNET_FIELDS},
    }
    return {
        "schema_version": "fullmag.boris_she_nf.v1",
        "runtime": dict(identity),
        "scenario": manifest,
        "fields": field_map,
        "residuals": residuals,
        "interface_balances": {
            **balances,
            "charge_interface_tolerance": config.transport_tolerance,
            "spin_torque_balance_tolerance": config.transport_tolerance,
            "torque_source": "f_Tsi plane average times magnetic cell thickness",
        },
        "qualification": {
            "status": "diagnostic",
            "reason": "managed BORIS N/F execution; no Fullmag equivalence or production claim",
        },
    }


def run_boris_case(
    config: NfCaseConfig,
    build_root: Path,
    output_dir: Path,
    device: str,
    *,
    image_digest: str = DEFAULT_BORIS_IMAGE,
    timeout_s: int = 180,
    runtime_container: str | None = None,
) -> Path:
    """Execute one managed case and return its validated summary path."""

    if output_dir.exists() and any(output_dir.iterdir()):
        raise RuntimeError(f"BORIS output directory is non-empty: {output_dir}")
    binary = build_root / "BorisLin"
    if not binary.is_file():
        raise RuntimeError(f"BorisLin binary is missing: {binary}")
    _source_manifest_path(build_root)
    if timeout_s < 1:
        raise ValueError("timeout_s must be positive")
    output_dir.mkdir(parents=True, exist_ok=True)
    container_config = replace(
        config,
        output_dir=_scenario_output_path(build_root, output_dir, runtime_container),
    )
    (output_dir / "scenario.py").write_text(render_boris_script(container_config), encoding="utf-8")
    (output_dir / "scenario.json").write_text(
        json.dumps(scenario_manifest(config), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    command = _managed_command(
        build_root,
        output_dir,
        device,
        image_digest,
        timeout_s,
        runtime_container,
    )
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_s + 60,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"managed BORIS case timed out after {timeout_s + 60}s") from error
    (output_dir / "runner.stdout.log").write_text(completed.stdout, encoding="utf-8")
    (output_dir / "runner.stderr.log").write_text(completed.stderr, encoding="utf-8")
    combined = completed.stdout + "\n" + completed.stderr
    marker = "BORIS_NF_STAGE_COMPLETE" in combined
    if not marker:
        raise RuntimeError(
            f"BORIS N/F stage marker is missing (exit={completed.returncode}); see runner logs"
        )
    if completed.returncode not in {0, 143}:
        raise RuntimeError(
            f"BORIS N/F process failed with exit code {completed.returncode}; see runner logs"
        )
    required_files = [
        output_dir / f"{prefix}_{name}.ovf"
        for prefix, names in (("n", REQUIRED_NORMAL_FIELDS), ("f", REQUIRED_FERROMAGNET_FIELDS))
        for name in names
    ]
    required_files.append(output_dir / "boris_native_samples.json")
    missing = [str(path.name) for path in required_files if not path.is_file()]
    if missing:
        raise RuntimeError(f"BORIS N/F stage marker was emitted but fields are missing: {', '.join(missing)}")
    native = json.loads((output_dir / "boris_native_samples.json").read_text(encoding="utf-8"))
    if native.get("stage_complete") is not True or native.get("schema_version") != "fullmag.boris_she_nf.native.v1":
        raise RuntimeError("BORIS native samples do not prove stage completion")
    probe = _probe_from_managed_log(completed.stdout, completed.stderr, device)
    if device == "cuda":
        # Preserve the exact query in the immutable identity rather than only
        # retaining a display name.
        probe["nvidia_smi_query"] = next(
            (line.strip() for line in combined.splitlines() if "," in line and "compute" not in line.lower()),
            "",
        )
    identity = capture_runtime_identity(
        build_root,
        image_digest,
        device,
        runtime_probe=probe,
    )
    (output_dir / "runtime.json").write_text(
        json.dumps(identity, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    summary = _artifact_summary(output_dir, config, identity)
    summary_path = output_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    validated = validate_boris_artifact(output_dir)
    (output_dir / "validation.json").write_text(
        json.dumps(validated, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return summary_path


def _resolution_config(resolution: str, output_dir: Path) -> NfCaseConfig:
    values = {
        "0": (10, 4, 2, 2),
        "coarse": (4, 2, 2, 2),
        "medium": (10, 4, 2, 2),
        "fine": (20, 8, 4, 4),
    }
    try:
        nx, ny, nz_n, nz_f = values[resolution]
    except KeyError as error:
        raise ValueError(f"unsupported BORIS N/F resolution: {resolution}") from error
    return NfCaseConfig(nx=nx, ny=ny, nz_n=nz_n, nz_f=nz_f, output_dir=output_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--resolution", choices=("0", "coarse", "medium", "fine"), default="0")
    parser.add_argument("--timeout-s", type=int, default=180)
    parser.add_argument("--image-digest", default=os.environ.get("FULLMAG_BORIS_IMAGE", DEFAULT_BORIS_IMAGE))
    parser.add_argument("--runtime-container", default=os.environ.get("FULLMAG_BORIS_RUNTIME_CONTAINER"))
    args = parser.parse_args()
    config = _resolution_config(args.resolution, args.output_dir)
    summary = run_boris_case(
        config,
        args.build_root,
        args.output_dir,
        args.device,
        image_digest=args.image_digest,
        timeout_s=args.timeout_s,
        runtime_container=args.runtime_container,
    )
    print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
