"""Plan or execute the Göbel/rDMI frozen-spin size sweep.

By default this command only prints a reproducible case matrix.  ``--run``
enters the managed Fullmag launcher, writes every case below the resolver's
``runs_root``, and runs :mod:`analyze` after each completed case.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

_ROOT = Path(__file__).resolve().parents[5]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tests.standard_problems.bimeron.goebel_2019.frozen_size.common import (
    DEFAULT_CELL_NM,
    DEFAULT_PIN_RADIUS_NM,
    DEFAULT_RING_WIDTH_NM,
    DEFAULT_WALL_WIDTH_NM,
    preset_radius_for_contour,
)
from tests.standard_problems.bimeron.goebel_2019.frozen_size.report import render_report
from tests.standard_problems.bimeron.goebel_2019.frozen_size.verify import verify_analysis


PROFILE = "bimeron-rdmi-frozen-spins"
SCENARIO_REL = Path("tests/standard_problems/bimeron/goebel_2019/frozen_size/scenario_fdm.py")
BACKGROUND_REL = Path("tests/standard_problems/bimeron/goebel_2019/frozen_size/background_fdm.py")
ANALYZER_REL = Path("tests/standard_problems/bimeron/goebel_2019/frozen_size/analyze.py")
THRESHOLDS_REL = Path("tests/standard_problems/bimeron/goebel_2019/frozen_size/thresholds.v1.json")


def _repo_root() -> Path:
    return _ROOT


def _python() -> str:
    return sys.executable


def _analysis_python(repo: Path, layout: dict[str, Any]) -> str:
    """Return the managed interpreter that can read Fullmag field artifacts.

    The host interpreter is sufficient for the storage resolver, but it may
    not have the managed ``zarr`` dependency required to measure a native
    ``.zarr.zip`` checkpoint.  Analysis therefore follows the same managed
    profile that produced the run whenever it is available.
    """

    build_root = Path(layout["build_root"])
    candidates = (
        build_root / "python" / "fullmag" / "Scripts" / "python.exe",
        repo / ".fullmag" / "local" / "python" / "bin" / "python",
    )
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return _python()


def _resolve_layout(repo: Path) -> dict[str, Any]:
    command = [
        _python(),
        str(repo / "scripts" / "fullmag_storage.py"),
        "resolve",
        "--repo-root",
        str(repo),
        "--profile",
        PROFILE,
        "--format",
        "json",
    ]
    completed = subprocess.run(command, cwd=repo, check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def _label(target_nm: float, wall_nm: float, protocol: str, cell_nm: float, pin_nm: float) -> str:
    return (
        f"R{target_nm:g}nm-w{wall_nm:g}nm-h{cell_nm:g}nm-"
        f"{protocol}-a{pin_nm:g}nm"
    ).replace(".", "p")


def _targets(series: str) -> list[tuple[float, float]]:
    if series == "pilot":
        return [(radius, 3.0) for radius in (3.0, 5.0, 10.0)]
    if series == "main":
        return [(radius, 3.0) for radius in (2.75, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0)]
    if series == "small-wall":
        return [(radius, 1.5) for radius in (2.0, 2.5, 2.75, 3.0, 4.0, 5.0)]
    return [
        *((radius, 3.0) for radius in (2.75, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0)),
        *((radius, 1.5) for radius in (2.0, 2.5, 2.75, 3.0, 4.0, 5.0)),
    ]


def _case_matrix(args: argparse.Namespace) -> list[dict[str, Any]]:
    protocols = [item.strip().lower() for item in args.protocols.split(",") if item.strip()]
    result: list[dict[str, Any]] = []
    for target_nm, wall_nm in _targets(args.series):
        for protocol in protocols:
            case_id = _label(target_nm, wall_nm, protocol, args.cell_nm, args.pin_radius_nm)
            result.append(
                {
                    "case_id": case_id,
                    "target_radius_nm": target_nm,
                    "wall_width_nm": wall_nm,
                    "protocol": protocol,
                    "cell_nm": args.cell_nm,
                    "pin_radius_nm": args.pin_radius_nm,
                    "ring_width_nm": args.ring_width_nm,
                    "helicity_rad": args.helicity_rad,
                    "vorticity": args.vorticity,
                    "background_sign": args.background_sign,
                    "release": bool(args.release),
                    "preset_radius_nm": preset_radius_for_contour(target_nm * 1e-9, wall_nm * 1e-9) * 1e9,
                }
            )
    if args.limit is not None:
        return result[: args.limit]
    return result


def _assert_within(path: Path, root: Path) -> Path:
    resolved = path.resolve()
    root = root.resolve()
    if root not in resolved.parents and resolved != root:
        raise ValueError(f"output path must stay below managed runs_root {root}: {resolved}")
    return resolved


def _environment(case: dict[str, Any], args: argparse.Namespace) -> dict[str, str]:
    return {
        "FULLMAG_STORAGE_PROFILE": PROFILE,
        "FULLMAG_BIMERON_DEVICE": args.device,
        "FULLMAG_BIMERON_TARGET_R_NM": str(case["target_radius_nm"]),
        "FULLMAG_BIMERON_WALL_WIDTH_NM": str(case["wall_width_nm"]),
        "FULLMAG_BIMERON_PROTOCOL": case["protocol"],
        "FULLMAG_BIMERON_CELL_NM": str(case["cell_nm"]),
        "FULLMAG_BIMERON_PIN_RADIUS_NM": str(case["pin_radius_nm"]),
        "FULLMAG_BIMERON_RING_WIDTH_NM": str(case.get("ring_width_nm", args.ring_width_nm)),
        "FULLMAG_BIMERON_HELICITY_RAD": str(case.get("helicity_rad", args.helicity_rad)),
        "FULLMAG_BIMERON_VORTICITY": str(case.get("vorticity", args.vorticity)),
        "FULLMAG_BIMERON_BACKGROUND_SIGN": str(case.get("background_sign", args.background_sign)),
        "FULLMAG_BIMERON_RELEASE": "1" if args.release else "0",
        "FULLMAG_BIMERON_RELAX_TIME_S": str(args.relax_time_s),
        "FULLMAG_BIMERON_HOLD_TIME_S": str(args.hold_time_s),
        "FULLMAG_BIMERON_RELEASE_TIME_S": str(args.release_time_s),
        "FULLMAG_BIMERON_HOLD_SAMPLE_PERIOD_S": str(
            min(args.hold_time_s / 10.0, 1e-11)
        ),
        "FULLMAG_BIMERON_RELAX_MAX_STEPS": str(args.relax_max_steps),
        "FULLMAG_BIMERON_RELEASE_MAX_STEPS": str(args.release_max_steps),
        "FULLMAG_BIMERON_FIELD_EVERY_STEPS": str(args.field_every_steps),
    }


def _binary_path(repo: Path, layout: dict[str, Any]) -> Path:
    target = Path(layout["env"]["CARGO_TARGET_DIR"])
    if os.name == "nt":
        return target / "x86_64-pc-windows-msvc" / "release" / "fullmag.exe"
    return target / "release" / "fullmag"


def _runtime_manifest_path(layout: dict[str, Any]) -> Path:
    return Path(layout["build_root"]) / "windows-runtime" / "build-manifest.json"


def _source_identity(repo: Path) -> dict[str, Any] | None:
    """Capture the same source identity consumed by the Windows launcher.

    The sweep must decide whether ``BuildMode=true`` is needed before it
    invokes the launcher.  Returning ``None`` on a probe failure is
    intentionally conservative: the launcher will then rebuild or emit its
    own source-identity error instead of silently reusing an unknown binary.
    """

    command = [
        _python(),
        str(repo / "scripts" / "capture_source_snapshot_identity.py"),
        "--repo-root",
        str(repo),
        "--ignore-non-runtime-dirty",
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        )
        value = json.loads(completed.stdout)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _managed_runtime_matches_source(
    repo: Path,
    layout: dict[str, Any],
    *,
    device: str,
) -> bool:
    """Return whether the cached Windows runtime is safe to reuse.

    A present executable is insufficient because the launcher binds source
    identity, CUDA residency, and the exact snapshot to every receipt.  Keep
    this preflight deliberately smaller than the launcher, while covering the
    fields that decide whether a rebuild is required.
    """

    manifest_path = _runtime_manifest_path(layout)
    binary = _binary_path(repo, layout)
    if not binary.is_file() or not manifest_path.is_file():
        return False
    try:
        # Windows PowerShell 7 may emit an UTF-8 BOM for the managed receipt.
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(manifest, dict):
        return False
    identity = _source_identity(repo)
    if identity is None:
        return False
    expected_commit = identity.get("head_commit_full")
    expected_snapshot = identity.get("source_snapshot_sha256")
    expected_state = "dirty" if identity.get("source_snapshot_dirty") else "clean"
    if manifest.get("git_commit") != expected_commit:
        return False
    if manifest.get("source_snapshot_sha256") != expected_snapshot:
        return False
    if manifest.get("worktree_state") != expected_state:
        return False
    if device == "gpu" and manifest.get("cuda") is not True:
        return False
    return manifest.get("local_changes_check") != "skipped"


def _run_process(command: list[str], *, cwd: Path, env: dict[str, str], log: Path) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w", encoding="utf-8") as stream:
        completed = subprocess.run(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
    if completed.returncode:
        raise RuntimeError(f"Fullmag command failed with exit code {completed.returncode}; see {log}")


def _workspace_from_launcher_log(log: Path) -> Path | None:
    if not log.is_file():
        return None
    content = log.read_text(encoding="utf-8", errors="replace")
    matches = list(re.finditer(r'"workspace_dir"\s*:\s*"((?:\\.|[^"])*)"', content))
    if not matches:
        return None
    try:
        return Path(json.loads(f'"{matches[-1].group(1)}"'))
    except (json.JSONDecodeError, OSError, ValueError):
        return None


def _launch(
    repo: Path,
    layout: dict[str, Any],
    script: Path,
    output: Path,
    case: dict[str, Any],
    args: argparse.Namespace,
    *,
    build: bool,
) -> Path | None:
    env = {**os.environ, **_environment(case, args)}
    binary = _binary_path(repo, layout)
    if os.name == "nt":
        command = [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(repo / "scripts" / "windows" / "run_fullmag.ps1"),
            "-BuildMode",
            "true" if build else "false",
            "-Frontend",
            "dev",
            "-Backend",
            "fdm",
            "-Device",
            args.device,
            "-RunMode",
            "headless",
            "-ScriptPath",
            str(script),
            "-OutputDir",
            str(output),
        ]
    else:
        if build:
            _run_process(["just", "build", "fullmag"], cwd=repo, env=env, log=output / "build.log")
        command = [
            _python(),
            str(repo / "scripts" / "fullmag_storage.py"),
            "run",
            "--repo-root",
            str(repo),
            "--profile",
            PROFILE,
            "--",
            str(binary),
            str(script),
            "--backend",
            "fdm",
            "--headless",
            "--json",
            "--output-dir",
            str(output),
        ]
    launcher_log = output / "launcher.log"
    _run_process(command, cwd=repo, env=env, log=launcher_log)
    return _workspace_from_launcher_log(launcher_log)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_profile_csv(path: Path, results: list[dict[str, Any]]) -> None:
    """Write the size-to-energy profile as a stable, analysis-friendly table."""

    fields = [
        "case_id",
        "target_radius_nm",
        "preset_radius_nm",
        "wall_width_nm",
        "protocol",
        "profile_stage",
        "profile_E_total_J",
        "profile_delta_E_to_background_J",
        "terminal_E_total_J",
        "terminal_delta_E_to_background_J",
        "R_area_hold_nm",
        "R_area_uncertainty_nm",
        "R_core_release_nm",
        "Q_hold",
        "radius_error_nm",
        "radius_tolerance_nm",
        "energy_window_relative_span",
        "energy_balance_relative",
        "frozen_dof_count",
        "free_dof_count",
        "verification_status",
    ]
    rows: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
        profile = result.get("profile_energy") if isinstance(result.get("profile_energy"), dict) else {}
        terminal = result.get("energy") if isinstance(result.get("energy"), dict) else {}
        held = result.get("states", {}).get("constrained_held", {}) if isinstance(result.get("states"), dict) else {}
        held_measurement = held.get("measurement") if isinstance(held, dict) and isinstance(held.get("measurement"), dict) else {}
        released = result.get("states", {}).get("released", {}) if isinstance(result.get("states"), dict) else {}
        released_measurement = released.get("measurement") if isinstance(released, dict) and isinstance(released.get("measurement"), dict) else {}
        frozen = result.get("frozen_runtime") if isinstance(result.get("frozen_runtime"), dict) else {}
        verification_status = result.get("verification_status")
        artifact_root = result.get("artifact_root")
        verification_path = Path(artifact_root) / "verification.json" if artifact_root else None
        verification_payload: dict[str, Any] = {}
        if verification_path is not None and verification_path.is_file():
            try:
                loaded_verification = json.loads(verification_path.read_text(encoding="utf-8"))
                if isinstance(loaded_verification, dict):
                    verification_payload = loaded_verification
                    if verification_status is None:
                        verification_status = verification_payload.get("status")
            except (OSError, json.JSONDecodeError):
                verification_payload = {}
        rows.append(
            {
                "case_id": protocol.get("case_id"),
                "target_radius_nm": protocol.get("target_radius_nm"),
                "preset_radius_nm": protocol.get("preset_radius_nm"),
                "wall_width_nm": protocol.get("wall_width_nm"),
                "protocol": protocol.get("protocol"),
                "profile_stage": profile.get("stage_id"),
                "profile_E_total_J": profile.get("E_total_J"),
                "profile_delta_E_to_background_J": profile.get("delta_E_to_background_J"),
                "terminal_E_total_J": terminal.get("E_total_J"),
                "terminal_delta_E_to_background_J": terminal.get("delta_E_to_background_J"),
                "R_area_hold_nm": held_measurement.get("R_area_nm"),
                "R_area_uncertainty_nm": held_measurement.get("R_area_uncertainty_nm"),
                "R_core_release_nm": released_measurement.get("R_core_nm"),
                "Q_hold": held_measurement.get("topological_charge"),
                "radius_error_nm": verification_payload.get("radius_error_nm"),
                "radius_tolerance_nm": verification_payload.get("radius_tolerance_nm"),
                "energy_window_relative_span": verification_payload.get("energy_window_relative_span"),
                "energy_balance_relative": verification_payload.get("energy_balance_relative"),
                "frozen_dof_count": frozen.get("frozen_dof_count"),
                "free_dof_count": frozen.get("free_dof_count"),
                "verification_status": verification_status or "not_run",
            }
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _verify_case(repo: Path, analysis: dict[str, Any], artifact_root: Path) -> dict[str, Any]:
    """Persist the verification receipt for every measured case.

    ``verify_analysis`` intentionally returns ``not_converged`` as a normal
    diagnostic status.  Running it in-process lets the sweep keep that
    receipt without treating the expected exit code of the standalone CLI as
    a failed case.
    """

    thresholds = json.loads((repo / THRESHOLDS_REL).read_text(encoding="utf-8"))
    verification = verify_analysis(analysis, thresholds)
    _write_json(artifact_root / "verification.json", verification)
    return verification


def _run_sweep(repo: Path, layout: dict[str, Any], cases: list[dict[str, Any]], args: argparse.Namespace) -> dict[str, Any]:
    runs_root = _assert_within(Path(layout["runs_root"]), Path(layout["storage_root"]))
    output_root = _assert_within(Path(args.output_root) if args.output_root else runs_root / "bimeron-rdmi-frozen-spins", runs_root)
    output_root.mkdir(parents=True, exist_ok=True)
    git_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    git_branch = subprocess.check_output(["git", "branch", "--show-current"], cwd=repo, text=True).strip()
    branch_id = git_branch or f"detached@{git_head[:12]}"
    for case in cases:
        case["branch_id"] = branch_id
    source = {
        "git_head": git_head,
        "git_branch": git_branch,
        "branch_id": branch_id,
        "worktree_status": subprocess.check_output(["git", "status", "--short"], cwd=repo, text=True),
        "profile": PROFILE,
        "device": args.device,
        "source_identity": _source_identity(repo),
        "scripts": {
            "scenario_fdm": {
                "path": str(repo / SCENARIO_REL),
                "sha256": _sha256_file(repo / SCENARIO_REL),
            },
            "background_fdm": {
                "path": str(repo / BACKGROUND_REL),
                "sha256": _sha256_file(repo / BACKGROUND_REL),
            },
            "analyzer": {
                "path": str(repo / ANALYZER_REL),
                "sha256": _sha256_file(repo / ANALYZER_REL),
            },
            "thresholds": {
                "path": str(repo / THRESHOLDS_REL),
                "sha256": _sha256_file(repo / THRESHOLDS_REL),
            },
        },
    }
    manifest: dict[str, Any] = {
        "schema_version": "bimeron_frozen_size.sweep.v1",
        "source": source,
        "layout": {
            "storage_root": layout["storage_root"],
            "runs_root": str(runs_root),
            "build_root": layout["build_root"],
            "output_root": str(output_root),
        },
        "cases": cases,
        "background": None,
    }
    _write_json(output_root / "sweep_request.json", manifest)

    background_path: Path | None = None
    background_workspace: Path | None = None
    # Reuse the compatible managed binary when the profile has already been
    # prepared.  This keeps a resumed sweep from rebuilding or allocating a
    # second target tree solely because a new case was added.
    # Reuse only a runtime whose source and CUDA identity match this checkout.
    # The Windows launcher performs the authoritative check again; this
    # preflight prevents a stale binary from being selected for the first case
    # and turning an otherwise resumable sweep into a predictable failure.
    built = _managed_runtime_matches_source(repo, layout, device=args.device)
    manifest["source"]["managed_runtime_matches_source_preflight"] = built
    manifest["source"]["runtime_manifest"] = str(_runtime_manifest_path(layout))
    if args.with_background:
        background_path = output_root / f"background-h{args.cell_nm:g}nm".replace(".", "p")
        background_path = _assert_within(background_path, runs_root)
        background_analysis = background_path / "analysis.json"
        background_is_measured = False
        if background_analysis.is_file():
            try:
                background_is_measured = json.loads(background_analysis.read_text(encoding="utf-8")).get("status") == "measured"
            except (OSError, json.JSONDecodeError):
                background_is_measured = False
        if not background_is_measured:
            background_case = {
                "target_radius_nm": 5.0,
                "wall_width_nm": DEFAULT_WALL_WIDTH_NM,
                "protocol": "p0",
                "cell_nm": args.cell_nm,
                "pin_radius_nm": max(DEFAULT_PIN_RADIUS_NM, args.pin_radius_nm),
            }
            background_path.mkdir(parents=True, exist_ok=True)
            _write_json(background_path / "request.json", {"kind": "background", "case": background_case})
            background_workspace = _launch(
                repo,
                layout,
                repo / BACKGROUND_REL,
                background_path,
                background_case,
                args,
                build=not built,
            )
            built = True
            analyze_background = [
                _analysis_python(repo, layout),
                str(repo / ANALYZER_REL),
                str(background_path),
                "--output",
                str(background_analysis),
            ]
            if background_workspace:
                analyze_background.extend(["--workspace", str(background_workspace)])
            _run_process(
                analyze_background,
                cwd=repo,
                env={**os.environ, **_environment(background_case, args)},
                log=background_path / "analysis.log",
            )
        else:
            background_workspace = _workspace_from_launcher_log(background_path / "launcher.log")
        manifest["background"] = {
            "path": str(background_path),
            "analysis": str(background_analysis),
        }
        _write_json(output_root / "sweep_request.json", manifest)

    results: list[dict[str, Any]] = []
    for case in cases:
        case_root = _assert_within(output_root / case["case_id"], runs_root)
        case["artifact_root"] = str(case_root)
        analysis_path = case_root / "analysis.json"
        if analysis_path.is_file() and args.reuse:
            reused = json.loads(analysis_path.read_text(encoding="utf-8"))
            if isinstance(reused, dict):
                verification_path = case_root / "verification.json"
                if verification_path.is_file():
                    try:
                        verification = json.loads(verification_path.read_text(encoding="utf-8"))
                        if isinstance(verification, dict):
                            reused["verification_status"] = verification.get("status")
                    except (OSError, json.JSONDecodeError):
                        pass
                results.append(reused)
            continue
        if case_root.exists() and any(case_root.iterdir()):
            raise RuntimeError(f"case output already exists; use --reuse or choose another output root: {case_root}")
        case_root.mkdir(parents=True, exist_ok=True)
        _write_json(case_root / "request.json", {"schema_version": "bimeron_frozen_size.case_request.v1", "case": case, "environment": _environment(case, args)})
        try:
            workspace = _launch(
                repo,
                layout,
                repo / SCENARIO_REL,
                case_root,
                case,
                args,
                build=not built,
            )
            built = True
            analyze_command = [
                _analysis_python(repo, layout),
                str(repo / ANALYZER_REL),
                str(case_root),
                "--output",
                str(analysis_path),
            ]
            if workspace:
                analyze_command.extend(["--workspace", str(workspace)])
            if background_path:
                analyze_command.extend(["--background", str(background_path)])
                if background_workspace:
                    analyze_command.extend(["--background-workspace", str(background_workspace)])
            _run_process(analyze_command, cwd=repo, env={**os.environ, **_environment(case, args)}, log=case_root / "analysis.log")
            analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
            verification = _verify_case(repo, analysis, case_root)
            if isinstance(analysis, dict):
                analysis["verification_status"] = verification.get("status")
            results.append(analysis)
        except Exception as error:
            failure = {"schema_version": "bimeron_frozen_size.case_failure.v1", "case": case, "error": str(error)}
            _write_json(case_root / "failure.json", failure)
            results.append(failure)
            if args.fail_fast:
                raise
    manifest["results"] = results
    verification_statuses = [
        result.get("verification_status")
        for result in results
        if isinstance(result, dict) and "verification_status" in result
    ]
    passed_count = sum(status == "passed" for status in verification_statuses)
    manifest["qualification"] = {
        "status": "passed" if results and passed_count == len(results) else "diagnostic",
        "case_count": len(results),
        "verification_status_counts": {
            status: verification_statuses.count(status) for status in sorted(set(verification_statuses))
        },
        "accepted_case_count": passed_count,
        "interpolation_allowed": passed_count == len(results) and bool(results),
    }
    _write_json(output_root / "profile_summary.json", manifest)
    _write_profile_csv(output_root / "profile_energy.csv", results)
    (output_root / "profile_report.md").write_text(render_report(manifest), encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="execute through the managed launcher")
    parser.add_argument("--series", choices=("pilot", "main", "small-wall", "all"), default="pilot")
    parser.add_argument("--protocols", default="p0,p2,p3,ring")
    parser.add_argument("--device", choices=("cpu", "gpu"), default=os.environ.get("FULLMAG_BIMERON_DEVICE", "gpu"))
    parser.add_argument("--cell-nm", type=float, default=DEFAULT_CELL_NM)
    parser.add_argument("--pin-radius-nm", type=float, default=DEFAULT_PIN_RADIUS_NM)
    parser.add_argument("--ring-width-nm", type=float, default=DEFAULT_RING_WIDTH_NM)
    parser.add_argument("--helicity-rad", type=float, default=float(os.environ.get("FULLMAG_BIMERON_HELICITY_RAD", "0")))
    parser.add_argument("--vorticity", type=int, choices=(-1, 1), default=int(os.environ.get("FULLMAG_BIMERON_VORTICITY", "-1")))
    parser.add_argument("--background-sign", type=int, choices=(-1, 1), default=int(os.environ.get("FULLMAG_BIMERON_BACKGROUND_SIGN", "1")))
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--release", action="store_true")
    parser.add_argument("--with-background", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--reuse", action="store_true")
    parser.add_argument("--fail-fast", action="store_true")
    parser.add_argument("--allow-diagnostic", action="store_true", help="return success while retaining a diagnostic (not accepted) profile")
    parser.add_argument("--relax-time-s", type=float, default=2e-11)
    parser.add_argument("--hold-time-s", type=float, default=1e-10)
    parser.add_argument("--release-time-s", type=float, default=2e-11)
    parser.add_argument("--relax-max-steps", type=int, default=8000)
    parser.add_argument("--release-max-steps", type=int, default=8000)
    parser.add_argument("--field-every-steps", type=int, default=1000)
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit must be positive")
    repo = _repo_root()
    cases = _case_matrix(args)
    if not args.run:
        print(json.dumps({"schema_version": "bimeron_frozen_size.sweep_plan.v1", "profile": PROFILE, "cases": cases}, indent=2, ensure_ascii=False))
        return 0
    layout = _resolve_layout(repo)
    summary = _run_sweep(repo, layout, cases, args)
    print(json.dumps({"output_root": summary["layout"]["output_root"], "case_count": len(summary["results"])}, ensure_ascii=False))
    qualification = summary.get("qualification") if isinstance(summary.get("qualification"), dict) else {}
    return 0 if args.allow_diagnostic or qualification.get("status") == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
