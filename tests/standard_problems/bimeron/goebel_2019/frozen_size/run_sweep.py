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
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from typing import Any

_ROOT = Path(__file__).resolve().parents[5]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tests.standard_problems.bimeron.goebel_2019.frozen_size.common import (
    DEFAULT_ALPHA,
    DEFAULT_CELL_NM,
    DEFAULT_DT_S,
    DEFAULT_PIN_RADIUS_NM,
    DEFAULT_RELAX_TOL_T,
    DEFAULT_RING_WIDTH_NM,
    DEFAULT_TRACK_X_NM,
    DEFAULT_TRACK_Y_NM,
    DEFAULT_WALL_WIDTH_NM,
    material_from_environment,
    preset_radius_for_contour,
)
from tests.standard_problems.bimeron.goebel_2019.frozen_size.report import (
    free_reference_from_analysis,
    render_report,
    write_plots,
)
from tests.standard_problems.bimeron.goebel_2019.frozen_size.provenance import (
    CONTRACT_FILENAME,
    build_contract,
    compare_contract,
    contract_sha256,
    contract_missing_evidence,
    load_artifact_contract,
)
from tests.standard_problems.bimeron.goebel_2019.frozen_size.verify import verify_analysis


PROFILE = "bimeron-rdmi-frozen-spins"
SCENARIO_REL = Path("tests/standard_problems/bimeron/goebel_2019/frozen_size/scenario_fdm.py")
BACKGROUND_REL = Path("tests/standard_problems/bimeron/goebel_2019/frozen_size/background_fdm.py")
ANALYZER_REL = Path("tests/standard_problems/bimeron/goebel_2019/frozen_size/analyze.py")
THRESHOLDS_REL = Path("tests/standard_problems/bimeron/goebel_2019/frozen_size/thresholds.v1.json")
# A free-relaxation P0 run is a one-time control for the material parameters,
# not a profile point to repeat at every target radius.
# The annulus is the primary size constraint for E(R).  P2/P3 remain useful
# diagnostic protocols, but mixing their different constraints into the
# default profile would make one curve protocol-dependent.
DEFAULT_PROFILE_PROTOCOLS = ("ring",)
CONTROL_TARGET_R_NM = 3.0
CONTROL_WALL_WIDTH_NM = 3.0
DENSE_TRACK_Y_NM = 80.0
INTERACTIVE_COMPLETION_TIMEOUT_S = 6.0 * 60.0 * 60.0


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
    if series == "dense":
        # R=3 nm is the smallest valid contour for the default 3 nm wall;
        # sample every 0.5 nm through a 20 nm radius.
        return [(round(3.0 + 0.5 * index, 6), 3.0) for index in range(35)]
    return [
        *((radius, 3.0) for radius in (2.75, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0)),
        *((radius, 1.5) for radius in (2.0, 2.5, 2.75, 3.0, 4.0, 5.0)),
    ]


def _requested_targets(args: argparse.Namespace) -> list[tuple[float, float]]:
    """Resolve an optional explicit radius grid and seed wall width."""

    custom_range = any(
        value is not None
        for value in (args.radius_start_nm, args.radius_stop_nm, args.radius_step_nm)
    )
    if custom_range:
        if not all(
            value is not None
            for value in (args.radius_start_nm, args.radius_stop_nm, args.radius_step_nm)
        ):
            raise ValueError(
                "radius-start-nm, radius-stop-nm, and radius-step-nm must be provided together"
            )
        start = float(args.radius_start_nm)
        stop = float(args.radius_stop_nm)
        step = float(args.radius_step_nm)
        if start <= 0.0 or stop < start or step <= 0.0:
            raise ValueError("custom radius range must satisfy 0 < start <= stop and step > 0")
        count = round((stop - start) / step)
        if not math.isclose(
            start + count * step,
            stop,
            rel_tol=0.0,
            abs_tol=1e-9,
        ):
            raise ValueError("custom radius range must contain an integer number of steps")
        wall = (
            float(args.wall_width_nm)
            if args.wall_width_nm is not None
            else DEFAULT_WALL_WIDTH_NM
        )
        if wall <= 0.0:
            raise ValueError("wall-width-nm must be positive")
        return [(round(start + index * step, 6), wall) for index in range(count + 1)]

    targets = _targets(args.series)
    if args.wall_width_nm is not None:
        wall = float(args.wall_width_nm)
        if wall <= 0.0:
            raise ValueError("wall-width-nm must be positive")
        targets = [(radius, wall) for radius, _default_wall in targets]
    return targets


def _case_matrix(args: argparse.Namespace) -> list[dict[str, Any]]:
    protocols = [item.strip().lower() for item in args.protocols.split(",") if item.strip()]
    result: list[dict[str, Any]] = []
    target_pairs = _requested_targets(args)
    for protocol in protocols:
        # P0 is a one-time material/background control.  Never expand it over
        # the requested R grid: a free relaxation cannot preserve each seeded
        # radius and would only repeat the same basin search.
        protocol_targets = (
            [(CONTROL_TARGET_R_NM, CONTROL_WALL_WIDTH_NM)]
            if protocol == "p0"
            else target_pairs
        )
        for target_nm, wall_nm in protocol_targets:
            case_id = _label(target_nm, wall_nm, protocol, args.cell_nm, args.pin_radius_nm)
            result.append(
                {
                    "case_id": case_id,
                    "target_radius_nm": target_nm,
                    "wall_width_nm": wall_nm,
                    "protocol": protocol,
                    "cell_nm": args.cell_nm,
                    "cell_size_nm": [args.cell_nm, args.cell_nm, 0.5],
                    "pin_radius_nm": args.pin_radius_nm,
                    "track_size_nm": [args.track_x_nm, args.track_y_nm, 0.5],
                    "track_x_nm": args.track_x_nm,
                    "track_y_nm": args.track_y_nm,
                    "relax_tol_T": args.tol_t,
                    "table_every_steps": args.table_every_steps,
                    "ring_width_nm": args.ring_width_nm,
                    "ring_radius_offset_nm": float(
                        os.environ.get("FULLMAG_BIMERON_RING_RADIUS_OFFSET_NM", "0.0")
                    ),
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
    material = material_from_environment().metadata()
    environment = {
        "FULLMAG_STORAGE_PROFILE": PROFILE,
        "FULLMAG_BIMERON_DEVICE": args.device,
        "FULLMAG_BIMERON_TARGET_R_NM": str(case["target_radius_nm"]),
        "FULLMAG_BIMERON_WALL_WIDTH_NM": str(case["wall_width_nm"]),
        "FULLMAG_BIMERON_PROTOCOL": case["protocol"],
        "FULLMAG_BIMERON_TRACK_X_NM": str(case.get("track_x_nm", args.track_x_nm)),
        "FULLMAG_BIMERON_TRACK_Y_NM": str(case.get("track_y_nm", args.track_y_nm)),
        "FULLMAG_BIMERON_CELL_NM": str(case["cell_nm"]),
        "FULLMAG_BIMERON_PIN_RADIUS_NM": str(case["pin_radius_nm"]),
        "FULLMAG_BIMERON_RING_WIDTH_NM": str(case.get("ring_width_nm", args.ring_width_nm)),
        "FULLMAG_BIMERON_RING_RADIUS_OFFSET_NM": str(
            case.get(
                "ring_radius_offset_nm",
                os.environ.get("FULLMAG_BIMERON_RING_RADIUS_OFFSET_NM", "0.0"),
            )
        ),
        "FULLMAG_BIMERON_HELICITY_RAD": str(case.get("helicity_rad", args.helicity_rad)),
        "FULLMAG_BIMERON_VORTICITY": str(case.get("vorticity", args.vorticity)),
        "FULLMAG_BIMERON_BACKGROUND_SIGN": str(case.get("background_sign", args.background_sign)),
        "FULLMAG_BIMERON_RELEASE": "1"
        if bool(case.get("release", getattr(args, "release", False)))
        else "0",
        "FULLMAG_BIMERON_RELAX_TIME_S": str(args.relax_time_s),
        "FULLMAG_BIMERON_TOL_T": str(args.tol_t),
        "FULLMAG_BIMERON_HOLD_TIME_S": str(args.hold_time_s),
        "FULLMAG_BIMERON_RELEASE_TIME_S": str(args.release_time_s),
        "FULLMAG_BIMERON_HOLD_SAMPLE_PERIOD_S": str(
            min(args.hold_time_s / 10.0, 1e-11)
        ),
        "FULLMAG_BIMERON_RELAX_MAX_STEPS": str(args.relax_max_steps),
        "FULLMAG_BIMERON_RELEASE_MAX_STEPS": str(args.release_max_steps),
        "FULLMAG_BIMERON_FIELD_EVERY_STEPS": str(args.field_every_steps),
        "FULLMAG_BIMERON_TABLE_EVERY_STEPS": str(args.table_every_steps),
        "FULLMAG_BIMERON_DT_S": str(
            os.environ.get("FULLMAG_BIMERON_DT_S", str(DEFAULT_DT_S))
        ),
        "FULLMAG_BIMERON_ALPHA": str(
            os.environ.get("FULLMAG_BIMERON_ALPHA", str(DEFAULT_ALPHA))
        ),
        "FULLMAG_BIMERON_RELAX_ALGORITHM": os.environ.get(
            "FULLMAG_BIMERON_RELAX_ALGORITHM", "llg_overdamped"
        ),
        "FULLMAG_BIMERON_MSAT_A_PER_M": str(material["Ms_Apm"]),
        "FULLMAG_BIMERON_AEX_J_PER_M": str(material["Aex_Jpm"]),
        "FULLMAG_BIMERON_D_J_PER_M2": str(material["D_Jpm2"]),
        "FULLMAG_BIMERON_KU_J_PER_M3": str(material["Ku_Jpm3"]),
    }
    pin_centres = case.get("pin_centres_nm")
    environment["FULLMAG_BIMERON_PIN_CENTRES_NM"] = (
        json.dumps(pin_centres, separators=(",", ":")) if pin_centres is not None else ""
    )
    return environment


def _analysis_environment(repo: Path, environment: dict[str, str]) -> dict[str, str]:
    """Make the checkout-local experiment helpers importable by managed Python."""

    result = dict(environment)
    existing = result.get("PYTHONPATH", "")
    result["PYTHONPATH"] = str(repo) + (os.pathsep + existing if existing else "")
    return result


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
    needs_control_room_toolchain: bool | None = None,
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
    if needs_control_room_toolchain is not None:
        # The Windows launcher records Node/pnpm only for interactive/static
        # frontend runs.  A headless run built from an interactive receipt is
        # rejected by the launcher even when the native binaries match, so
        # make that distinction part of the preflight as well.
        has_control_room_toolchain = bool(
            manifest.get("node_version") and manifest.get("pnpm_version")
        )
        if has_control_room_toolchain != needs_control_room_toolchain:
            return False
    return manifest.get("local_changes_check") != "skipped"


def _run_process(command: list[str], *, cwd: Path, env: dict[str, str], log: Path) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w", encoding="utf-8") as stream:
        completed = subprocess.run(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
    if completed.returncode:
        raise RuntimeError(f"Fullmag command failed with exit code {completed.returncode}; see {log}")


def _run_analysis_process(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    output: Path,
    log: Path,
) -> dict[str, Any]:
    """Run the managed reader and let the host process persist its JSON.

    The bundled managed interpreter is intentionally read-only outside its
    runtime tree on Windows.  Asking it to write an analysis file therefore
    fails even though it can read the native state.  The analyzer already
    emits one JSON document on stdout, so keep the managed process read-only
    and persist the validated document from the host-side sweep process.
    """

    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
    )
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(
        (completed.stdout or "") + ("\n" + completed.stderr if completed.stderr else ""),
        encoding="utf-8",
    )
    raw = (completed.stdout or "").strip()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"managed analyzer did not emit JSON (exit {completed.returncode}); see {log}"
        ) from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"managed analyzer emitted non-object JSON; see {log}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if completed.returncode not in {0, 2}:
        raise RuntimeError(f"managed analyzer failed with exit code {completed.returncode}; see {log}")
    if payload.get("status") == "incomplete":
        raise RuntimeError(f"managed analyzer returned an incomplete artifact; see {log}")
    return payload


def _interactive_completion_contract(
    script: Path,
    output: Path,
    case: dict[str, Any],
    args: argparse.Namespace,
) -> tuple[str, Path]:
    """Return the final stage and artifact that prove an interactive run is done.

    The managed interactive launcher intentionally keeps the Control Room
    server alive after the solver finishes.  A sweep must therefore stop its
    own process tree only after the last stage has been completed and its
    checkpoint is present; waiting for the launcher process to exit would
    otherwise deadlock the next case.  ``_run_interactive_process`` also
    waits for the launcher’s ``interactive workspace ready`` marker so the
    runtime has flushed source metadata before the process tree is stopped.
    """

    if script.name == BACKGROUND_REL.name:
        return "flat_save_state", output / "states" / "background_relaxed_m.zarr.zip"
    released = bool(case.get("release", getattr(args, "release", False)))
    if released:
        return "flat_save_state", output / "states" / "released_m.zarr.zip"
    # The logical constrained hold is emitted as ``flat_run`` while it is
    # running, but the final checkpoint is written by the following
    # ``flat_save_state`` stage.  Wait for that final stage so the source
    # metadata and state export are flushed before stopping the interactive
    # process tree.
    return "flat_save_state", output / "states" / "constrained_held_m.zarr.zip"


def _stop_interactive_process_tree(process: subprocess.Popen[str]) -> None:
    """Stop the exact interactive launcher tree after its final artifact exists."""

    if process.poll() is not None:
        return
    if os.name == "nt":
        # CTRL_BREAK gives the PowerShell wrapper a chance to close the web
        # and API children cleanly.  The PID-tree fallback is scoped to this
        # just-created launcher, so stale sessions on another port are not
        # touched.
        try:
            process.send_signal(signal.CTRL_BREAK_EVENT)
            process.wait(timeout=10.0)
            return
        except (OSError, subprocess.TimeoutExpired):
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    else:
        process.terminate()
    try:
        process.wait(timeout=20.0)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=20.0)


def _run_interactive_process(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    log: Path,
    final_stage: str,
    final_artifact: Path,
) -> None:
    """Run one inspectable case and close its server after solver completion."""

    log.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    pattern = re.compile(rf"\[fullmag\] stage \d+/\d+ \({re.escape(final_stage)}\) completed")
    workspace_ready_marker = "interactive workspace ready"
    with log.open("w", encoding="utf-8") as stream:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=stream,
            stderr=subprocess.STDOUT,
            text=True,
            creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0),
        )
        try:
            while True:
                returncode = process.poll()
                try:
                    content = log.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    content = ""
                finished = (
                    pattern.search(content) is not None
                    and final_artifact.is_file()
                    and workspace_ready_marker in content
                )
                if finished:
                    _stop_interactive_process_tree(process)
                    return
                if returncode is not None:
                    raise RuntimeError(
                        f"Fullmag interactive command exited with code {returncode} before "
                        f"{final_stage} completed; see {log}"
                    )
                if time.monotonic() - started > INTERACTIVE_COMPLETION_TIMEOUT_S:
                    _stop_interactive_process_tree(process)
                    raise RuntimeError(
                        f"Fullmag interactive command exceeded {INTERACTIVE_COMPLETION_TIMEOUT_S:g}s "
                        f"without completing {final_stage}; see {log}"
                    )
                time.sleep(0.5)
        except BaseException:
            if process.poll() is None:
                _stop_interactive_process_tree(process)
            raise


def _workspace_from_launcher_log(log: Path, repo: Path | None = None) -> Path | None:
    if not log.is_file():
        return None
    content = log.read_text(encoding="utf-8", errors="replace")
    matches = list(re.finditer(r'"workspace_dir"\s*:\s*"((?:\\.|[^"])*)"', content))
    if matches:
        try:
            return Path(json.loads(f'"{matches[-1].group(1)}"'))
        except (json.JSONDecodeError, OSError, ValueError):
            pass
    if repo is None:
        return None
    session_matches = list(re.finditer(r"^[- ]*workspace_id:\s*(\S+)", content, re.MULTILINE))
    if not session_matches:
        return None
    candidate = (
        repo
        / ".fullmag"
        / "local-live"
        / "history"
        / session_matches[-1].group(1).strip()
    )
    return candidate if candidate.is_dir() else None


def _launch(
    repo: Path,
    layout: dict[str, Any],
    script: Path,
    output: Path,
    case: dict[str, Any],
    args: argparse.Namespace,
    *,
    build: bool,
    initial_magnetization_state: Path | None = None,
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
            args.run_mode,
            "-WebPort",
            str(args.web_port),
            "-ScriptPath",
            str(script),
            "-OutputDir",
            str(output),
        ]
        if initial_magnetization_state is not None:
            command.extend(
                [
                    "-InitialMagnetizationState",
                    str(initial_magnetization_state),
                    "-InitialMagnetizationStateFormat",
                    "zarr",
                    "-InitialMagnetizationStateDataset",
                    "m",
                ]
            )
    else:
        if build:
            _run_process(["just", "build", "fullmag"], cwd=repo, env=env, log=output / "build.log")
        binary_arguments = [str(binary), str(script), "--backend", "fdm", "--output-dir", str(output)]
        if args.run_mode == "interactive":
            binary_arguments.extend(["-i", "--web-port", str(args.web_port)])
        else:
            binary_arguments.extend(["--headless", "--json"])
        command = [
            _python(),
            str(repo / "scripts" / "fullmag_storage.py"),
            "run",
            "--repo-root",
            str(repo),
            "--profile",
            PROFILE,
            "--",
            *binary_arguments,
        ]
        if initial_magnetization_state is not None:
            command.extend(
                [
                    "--initial-magnetization-state",
                    str(initial_magnetization_state),
                    "--initial-magnetization-state-format",
                    "zarr",
                    "--initial-magnetization-state-dataset",
                    "m",
                ]
            )
    launcher_log = output / "launcher.log"
    if args.run_mode == "interactive":
        final_stage, final_artifact = _interactive_completion_contract(
            script, output, case, args
        )
        _run_interactive_process(
            command,
            cwd=repo,
            env=env,
            log=launcher_log,
            final_stage=final_stage,
            final_artifact=final_artifact,
        )
    else:
        _run_process(command, cwd=repo, env=env, log=launcher_log)
    return _workspace_from_launcher_log(launcher_log, repo)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _background_reference_contract(
    path: Path,
    *,
    expected_contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Classify a background artifact before using its energy for ΔE."""

    try:
        analysis = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"status": "unavailable", "reason": "background_analysis_missing", "energy_J": None}
    if not isinstance(analysis, dict) or analysis.get("status") != "measured":
        return {"status": "unavailable", "reason": "background_not_measured", "energy_J": None}
    actual_contract = load_artifact_contract(path.parent)
    missing = contract_missing_evidence(actual_contract)
    if missing:
        return {
            "status": "unavailable",
            "reason": "background_contract_missing",
            "energy_J": None,
            "contract_missing_evidence": missing,
        }
    if expected_contract is not None:
        differences = compare_contract(
            expected_contract,
            actual_contract,
            physical_only=True,
        )
        if differences:
            return {
                "status": "unavailable",
                "reason": "background_contract_mismatch",
                "energy_J": None,
                "contract_mismatches": differences,
            }
    energy = analysis.get("energy") if isinstance(analysis.get("energy"), dict) else {}
    value = energy.get("E_total_J")
    try:
        finite_energy = value is not None and math.isfinite(float(value))
    except (TypeError, ValueError):
        finite_energy = False
    runtime = analysis.get("runtime_provenance") if isinstance(analysis.get("runtime_provenance"), dict) else {}
    completion = runtime.get("completion") if isinstance(runtime.get("completion"), dict) else {}
    if not finite_energy:
        return {"status": "unavailable", "reason": "background_energy_not_finite", "energy_J": None}
    if completion.get("converged") is not True:
        return {
            "status": "unavailable",
            "reason": "background_not_converged",
            "energy_J": None,
            "completion": completion,
        }
    return {
        "status": "usable",
        "reason": "background_converged",
        "energy_J": float(value),
        "completion": completion,
        "contract_sha256": actual_contract.get("contract_sha256") if isinstance(actual_contract, dict) else None,
    }


def _protocol_energy_spread(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Summarize protocol-dependent energy spread without rejecting points.

    P2, P3, and P-ring solve different constrained variational problems. Their
    spread is therefore an experimental bias diagnostic, not a numerical
    tolerance or a cross-protocol acceptance gate.
    """

    groups: dict[tuple[float, float, float], list[dict[str, Any]]] = {}
    for result in results:
        protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
        profile = result.get("profile_energy") if isinstance(result.get("profile_energy"), dict) else {}
        try:
            target = float(protocol.get("target_radius_nm"))
            wall = float(protocol.get("wall_width_nm"))
            cell = float(protocol.get("cell_nm"))
            energy = float(profile.get("E_total_J"))
        except (TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in (target, wall, cell, energy)):
            continue
        groups.setdefault((target, wall, cell), []).append(
            {
                "protocol": protocol.get("protocol"),
                "energy_J": energy,
                "delta_E_to_background_J": profile.get("delta_E_to_background_J"),
            }
        )
    diagnostics: list[dict[str, Any]] = []
    for (target, wall, cell), entries in sorted(groups.items()):
        if len(entries) < 2:
            continue
        energies = [float(entry["energy_J"]) for entry in entries]
        spread = max(energies) - min(energies)
        excess = [
            float(entry["delta_E_to_background_J"])
            for entry in entries
            if isinstance(entry.get("delta_E_to_background_J"), (int, float))
            and math.isfinite(float(entry["delta_E_to_background_J"]))
        ]
        excess_scale = abs(sum(excess) / len(excess)) if excess else None
        diagnostics.append(
            {
                "target_radius_nm": target,
                "wall_width_nm": wall,
                "cell_nm": cell,
                "protocols": [entry.get("protocol") for entry in entries],
                "min_energy_J": min(energies),
                "max_energy_J": max(energies),
                "spread_J": spread,
                "spread_relative_to_total": spread / max(abs(sum(energies) / len(energies)), 1e-30),
                "spread_relative_to_excess": spread / excess_scale if excess_scale and excess_scale > 0.0 else None,
                "interpretation": "protocol_bias_diagnostic_only",
            }
        )
    return diagnostics


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _thresholds_path(repo: Path, args: argparse.Namespace | None = None) -> Path:
    """Resolve the versioned verification policy selected for a sweep."""

    value = getattr(args, "thresholds", THRESHOLDS_REL) if args is not None else THRESHOLDS_REL
    path = Path(value)
    if not path.is_absolute():
        path = repo / path
    path = path.resolve()
    if not path.is_file():
        raise FileNotFoundError(f"threshold policy does not exist: {path}")
    return path


def _case_contract(
    repo: Path,
    case: dict[str, Any],
    args: argparse.Namespace,
    source: dict[str, Any],
    *,
    kind: str = "case",
) -> dict[str, Any]:
    thresholds = _thresholds_path(repo, args)
    return build_contract(
        case=case,
        environment=_environment(case, args),
        source=source,
        thresholds_sha256=_sha256_file(thresholds),
        kind=kind,
    )


def _control_case(args: argparse.Namespace) -> dict[str, Any]:
    """Return the one-time free-control request used for compatibility checks."""

    target = CONTROL_TARGET_R_NM
    wall = CONTROL_WALL_WIDTH_NM
    return {
        "case_id": "free-reference-p0",
        "target_radius_nm": target,
        "wall_width_nm": wall,
        "protocol": "p0",
        "cell_nm": args.cell_nm,
        "cell_size_nm": [args.cell_nm, args.cell_nm, 0.5],
        "pin_radius_nm": max(DEFAULT_PIN_RADIUS_NM, args.pin_radius_nm),
        "track_size_nm": [args.track_x_nm, args.track_y_nm, 0.5],
        "track_x_nm": args.track_x_nm,
        "track_y_nm": args.track_y_nm,
        "ring_width_nm": args.ring_width_nm,
        "ring_radius_offset_nm": float(
            os.environ.get("FULLMAG_BIMERON_RING_RADIUS_OFFSET_NM", "0.0")
        ),
        "helicity_rad": args.helicity_rad,
        "vorticity": args.vorticity,
        "background_sign": args.background_sign,
        "release": False,
        "preset_radius_nm": preset_radius_for_contour(target * 1e-9, wall * 1e-9) * 1e9,
    }


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
        "profile_state_label",
        "R_area_profile_nm",
        "R_area_profile_uncertainty_nm",
        "Q_profile",
        "R_area_hold_nm",
        "R_area_uncertainty_nm",
        "R_core_release_nm",
        "Q_hold",
        "radius_error_nm",
        "radius_tolerance_nm",
        "energy_window_relative_span",
        "energy_window_relative_to_excess",
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
        profile_state_label = result.get("profile_state_label")
        if profile_state_label not in {"constrained_relaxed", "constrained_held", "final"}:
            profile_state_label = (
                "constrained_relaxed"
                if profile.get("stage_id") == "constrained_relax"
                else "constrained_held"
                if profile.get("stage_id") == "constrained_hold"
                else "final"
            )
        profile_state = result.get("states", {}).get(profile_state_label, {}) if isinstance(result.get("states"), dict) else {}
        profile_measurement = profile_state.get("measurement") if isinstance(profile_state, dict) and isinstance(profile_state.get("measurement"), dict) else {}
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
                "profile_state_label": profile_state_label,
                "R_area_profile_nm": profile_measurement.get("R_area_nm"),
                "R_area_profile_uncertainty_nm": profile_measurement.get("R_area_uncertainty_nm"),
                "Q_profile": profile_measurement.get("topological_charge"),
                "R_area_hold_nm": held_measurement.get("R_area_nm"),
                "R_area_uncertainty_nm": held_measurement.get("R_area_uncertainty_nm"),
                "R_core_release_nm": released_measurement.get("R_core_nm"),
                "Q_hold": held_measurement.get("topological_charge"),
                "radius_error_nm": verification_payload.get("radius_error_nm"),
                "radius_tolerance_nm": verification_payload.get("radius_tolerance_nm"),
                "energy_window_relative_span": verification_payload.get("energy_window_relative_span"),
                "energy_window_relative_to_excess": verification_payload.get("energy_window_relative_to_excess"),
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


def _verify_case(
    repo: Path,
    analysis: dict[str, Any],
    artifact_root: Path,
    *,
    thresholds_path: Path | None = None,
) -> dict[str, Any]:
    """Persist the verification receipt for every measured case.

    ``verify_analysis`` intentionally returns ``not_converged`` as a normal
    diagnostic status.  Running it in-process lets the sweep keep that
    receipt without treating the expected exit code of the standalone CLI as
    a failed case.
    """

    policy_path = thresholds_path if thresholds_path is not None else _thresholds_path(repo)
    thresholds = json.loads(policy_path.read_text(encoding="utf-8"))
    if not isinstance(thresholds, dict):
        raise ValueError(f"threshold policy must be a JSON object: {policy_path}")
    thresholds = dict(thresholds)
    thresholds.setdefault("policy_path", str(policy_path))
    thresholds.setdefault("policy_sha256", _sha256_file(policy_path))
    verification = verify_analysis(analysis, thresholds)
    verification["threshold_policy"] = {
        "path": str(policy_path),
        "sha256": _sha256_file(policy_path),
        "schema_version": thresholds.get("schema_version"),
    }
    _write_json(artifact_root / "verification.json", verification)
    return verification


def _run_sweep(repo: Path, layout: dict[str, Any], cases: list[dict[str, Any]], args: argparse.Namespace) -> dict[str, Any]:
    runs_root = _assert_within(Path(layout["runs_root"]), Path(layout["storage_root"]))
    output_root = _assert_within(Path(args.output_root) if args.output_root else runs_root / "bimeron-rdmi-frozen-spins", runs_root)
    output_root.mkdir(parents=True, exist_ok=True)
    git_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    git_branch = subprocess.check_output(["git", "branch", "--show-current"], cwd=repo, text=True).strip()
    branch_id = git_branch or f"detached@{git_head[:12]}"
    thresholds_path = _thresholds_path(repo, args)
    threshold_policy = json.loads(thresholds_path.read_text(encoding="utf-8"))
    if not isinstance(threshold_policy, dict):
        raise ValueError(f"threshold policy must be a JSON object: {thresholds_path}")
    qualification_scope = str(
        threshold_policy.get("qualification_scope", "strict_profile")
    )
    strict_release = bool(
        threshold_policy.get(
            "strict_release",
            qualification_scope in {"strict_profile", "strict_release"},
        )
    )
    # A single experiment cannot establish product/four-lane release readiness.
    release_qualified = False
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
                "path": str(thresholds_path),
                "sha256": _sha256_file(thresholds_path),
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
        "qualification_policy": {
            "schema_version": threshold_policy.get("schema_version"),
            "path": str(thresholds_path),
            "sha256": _sha256_file(thresholds_path),
            "scope": qualification_scope,
            "strict_release": strict_release,
            "release_qualified": release_qualified,
        },
        "provenance_contract": {
            "schema_version": "bimeron_frozen_size.case_contract.v1",
            "source_contract_sha256": contract_sha256(source),
            "reuse_requires_contract": True,
        },
    }
    if args.free_reference:
        free_expected = _case_contract(
            repo,
            _control_case(args),
            args,
            source,
            kind="free_reference",
        )
        manifest["free_reference"] = free_reference_from_analysis(
            args.free_reference,
            expected_contract=free_expected,
        )
    _write_json(output_root / "sweep_request.json", manifest)

    background_path: Path | None = None
    background_workspace: Path | None = None
    background_contract: dict[str, Any] = {
        "status": "not_requested",
        "reason": "with_background_disabled",
        "energy_J": None,
    }
    # Reuse the compatible managed binary when the profile has already been
    # prepared.  This keeps a resumed sweep from rebuilding or allocating a
    # second target tree solely because a new case was added.
    # Reuse only a runtime whose source and CUDA identity match this checkout.
    # The Windows launcher performs the authoritative check again; this
    # preflight prevents a stale binary from being selected for the first case
    # and turning an otherwise resumable sweep into a predictable failure.
    built = _managed_runtime_matches_source(
        repo,
        layout,
        device=args.device,
        needs_control_room_toolchain=args.run_mode == "interactive",
    )
    manifest["source"]["managed_runtime_matches_source_preflight"] = built
    manifest["source"]["runtime_manifest"] = str(_runtime_manifest_path(layout))
    if not built:
        raise RuntimeError(
            "managed runtime does not match the requested source/device/toolchain; "
            "prepare it through the approved Fullmag build-runner route before starting "
            "the interactive sweep (the sweep never performs an implicit host build)"
        )
    if args.with_background:
        background_path = output_root / f"background-h{args.cell_nm:g}nm".replace(".", "p")
        background_path = _assert_within(background_path, runs_root)
        background_analysis = background_path / "analysis.json"
        background_case = {
            "case_id": f"background-h{args.cell_nm:g}nm".replace(".", "p"),
            "target_radius_nm": 5.0,
            "wall_width_nm": DEFAULT_WALL_WIDTH_NM,
            "protocol": "p0",
            "cell_nm": args.cell_nm,
            "cell_size_nm": [args.cell_nm, args.cell_nm, 0.5],
            "pin_radius_nm": max(DEFAULT_PIN_RADIUS_NM, args.pin_radius_nm),
            "track_size_nm": [args.track_x_nm, args.track_y_nm, 0.5],
            "track_x_nm": args.track_x_nm,
            "track_y_nm": args.track_y_nm,
            "ring_width_nm": args.ring_width_nm,
            "ring_radius_offset_nm": float(
                os.environ.get("FULLMAG_BIMERON_RING_RADIUS_OFFSET_NM", "0.0")
            ),
            "helicity_rad": args.helicity_rad,
            "vorticity": args.vorticity,
            "background_sign": args.background_sign,
            "release": False,
        }
        background_expected_contract = _case_contract(
            repo, background_case, args, source, kind="background"
        )
        background_is_measured = False
        if background_analysis.is_file():
            background_is_measured = (
                _background_reference_contract(
                    background_analysis,
                    expected_contract=background_expected_contract,
                ).get("status")
                == "usable"
            )
            if background_is_measured:
                # Reusing a run is stricter than comparing physical references:
                # the numerical stop policy and script hashes must also match.
                background_is_measured = not compare_contract(
                    background_expected_contract,
                    load_artifact_contract(background_path),
                )
            if not background_is_measured and args.reuse:
                status = _background_reference_contract(
                    background_analysis,
                    expected_contract=background_expected_contract,
                )
                raise RuntimeError(
                    "existing background artifact is not compatible with the requested physical contract; "
                    f"use a new output root instead of --reuse ({status.get('reason')}: "
                    f"{status.get('contract_mismatches') or status.get('contract_missing_evidence') or ''})"
                )
        if not background_is_measured and background_path.exists() and any(background_path.iterdir()):
            raise RuntimeError(
                "background output already exists but has no compatible provenance contract; "
                f"choose a new output root instead of overwriting historical artifacts: {background_path}"
            )
        if not background_is_measured:
            background_path.mkdir(parents=True, exist_ok=True)
            _write_json(
                background_path / "request_contract.json",
                background_expected_contract,
            )
            _write_json(
                background_path / "request.json",
                {
                    "kind": "background",
                    "case": background_case,
                    "provenance_contract": background_expected_contract,
                },
            )
            background_workspace = _launch(
                repo,
                layout,
                repo / BACKGROUND_REL,
                background_path,
                background_case,
                args,
                build=False,
            )
            built = True
            analyze_background = [
                _analysis_python(repo, layout),
                str(repo / ANALYZER_REL),
                str(background_path),
            ]
            if background_workspace:
                analyze_background.extend(["--workspace", str(background_workspace)])
            _run_analysis_process(
                analyze_background,
                cwd=repo,
                env=_analysis_environment(
                    repo, {**os.environ, **_environment(background_case, args)}
                ),
                output=background_analysis,
                log=background_path / "analysis.log",
            )
            background_analysis_value = json.loads(
                background_analysis.read_text(encoding="utf-8")
            )
            if isinstance(background_analysis_value, dict):
                background_analysis_value["provenance_contract"] = background_expected_contract
                _write_json(background_analysis, background_analysis_value)
        else:
            background_workspace = _workspace_from_launcher_log(
                background_path / "launcher.log", repo
            )
        background_contract = _background_reference_contract(
            background_analysis,
            expected_contract=background_expected_contract,
        )
        manifest["background"] = {
            "path": str(background_path),
            "analysis": str(background_analysis),
            **background_contract,
        }
        _write_json(output_root / "sweep_request.json", manifest)

    results: list[dict[str, Any]] = []
    for case in cases:
        case_root = _assert_within(output_root / case["case_id"], runs_root)
        case["artifact_root"] = str(case_root)
        analysis_path = case_root / "analysis.json"
        expected_contract = _case_contract(repo, case, args, source)
        if analysis_path.is_file() and args.reuse:
            actual_contract = load_artifact_contract(case_root)
            missing = contract_missing_evidence(actual_contract)
            differences = compare_contract(expected_contract, actual_contract)
            if missing or differences:
                raise RuntimeError(
                    "existing case artifact is not compatible with the requested provenance contract; "
                    f"use a new output root instead of --reuse (missing={missing}, mismatches={differences})"
                )
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
        _write_json(case_root / CONTRACT_FILENAME, expected_contract)
        _write_json(
            case_root / "request.json",
            {
                "schema_version": "bimeron_frozen_size.case_request.v1",
                "case": case,
                "environment": _environment(case, args),
                "provenance_contract": expected_contract,
            },
        )
        try:
            workspace = _launch(
                repo,
                layout,
                repo / SCENARIO_REL,
                case_root,
                case,
                args,
                build=False,
            )
            built = True
            analyze_command = [
                _analysis_python(repo, layout),
                str(repo / ANALYZER_REL),
                str(case_root),
            ]
            if workspace:
                analyze_command.extend(["--workspace", str(workspace)])
            # Pass an existing background artifact to the analyzer even when
            # its contract is currently unavailable.  The analyzer records
            # the reason and withholds Delta E; omitting the argument would
            # erase the distinction between "not requested" and
            # "requested but not converged" from the case provenance.
            if background_path:
                analyze_command.extend(["--background", str(background_path)])
                if background_workspace:
                    analyze_command.extend(["--background-workspace", str(background_workspace)])
            _run_analysis_process(
                analyze_command,
                cwd=repo,
                env=_analysis_environment(
                    repo, {**os.environ, **_environment(case, args)}
                ),
                output=analysis_path,
                log=case_root / "analysis.log",
            )
            analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
            if not isinstance(analysis, dict):
                raise RuntimeError(f"analyzer output is not a JSON object: {analysis_path}")
            analysis["provenance_contract"] = expected_contract
            _write_json(analysis_path, analysis)
            verification = _verify_case(
                repo,
                analysis,
                case_root,
                thresholds_path=thresholds_path,
            )
            if isinstance(analysis, dict):
                analysis["verification_status"] = verification.get("status")
                _write_json(analysis_path, analysis)
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
        "scope": qualification_scope,
        "strict_release": strict_release,
        "release_qualified": release_qualified,
        "status_meaning": (
            "passed_selected_working_profile_policy_not_release"
            if not strict_release
            else "passed_selected_strict_profile_policy"
        ),
        "case_count": len(results),
        "verification_status_counts": {
            status: verification_statuses.count(status) for status in sorted(set(verification_statuses))
        },
        "accepted_case_count": passed_count,
        "interpolation_allowed": passed_count == len(results) and bool(results),
    }
    manifest["diagnostics"] = {
        "protocol_energy_spread": _protocol_energy_spread(results),
        "protocol_spread_is_acceptance_gate": False,
    }
    manifest["plots"] = write_plots(manifest, output_root)
    _write_json(output_root / "profile_summary.json", manifest)
    _write_profile_csv(output_root / "profile_energy.csv", results)
    (output_root / "profile_report.md").write_text(render_report(manifest), encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="execute through the managed launcher")
    parser.add_argument("--series", choices=("pilot", "main", "small-wall", "dense", "all"), default="pilot")
    parser.add_argument(
        "--protocols",
        default=",".join(DEFAULT_PROFILE_PROTOCOLS),
        help=(
            "comma-separated constrained protocols for the size profile; "
            "p0 is always reduced to one R=3 nm, w_seed=3 nm free-relaxation control"
        ),
    )
    parser.add_argument("--device", choices=("cpu", "gpu"), default=os.environ.get("FULLMAG_BIMERON_DEVICE", "gpu"))
    parser.add_argument(
        "--run-mode",
        choices=("interactive", "headless"),
        default=os.environ.get("FULLMAG_BIMERON_RUN_MODE", "interactive"),
        help="launch each case with the inspectable UI or without the frontend",
    )
    parser.add_argument("--web-port", type=int, default=int(os.environ.get("FULLMAG_BIMERON_WEB_PORT", "3100")))
    parser.add_argument("--cell-nm", type=float, default=DEFAULT_CELL_NM)
    parser.add_argument("--radius-start-nm", type=float, help="first radius in an explicit profile grid")
    parser.add_argument("--radius-stop-nm", type=float, help="last radius in an explicit profile grid")
    parser.add_argument("--radius-step-nm", type=float, help="spacing in an explicit profile grid")
    parser.add_argument(
        "--wall-width-nm",
        type=float,
        help="override the seed wall width for every requested profile point",
    )
    parser.add_argument("--track-x-nm", type=float, default=None)
    parser.add_argument("--track-y-nm", type=float, default=None)
    parser.add_argument("--pin-radius-nm", type=float, default=DEFAULT_PIN_RADIUS_NM)
    parser.add_argument("--ring-width-nm", type=float, default=DEFAULT_RING_WIDTH_NM)
    parser.add_argument("--helicity-rad", type=float, default=float(os.environ.get("FULLMAG_BIMERON_HELICITY_RAD", "0")))
    parser.add_argument("--vorticity", type=int, choices=(-1, 1), default=int(os.environ.get("FULLMAG_BIMERON_VORTICITY", "-1")))
    parser.add_argument("--background-sign", type=int, choices=(-1, 1), default=int(os.environ.get("FULLMAG_BIMERON_BACKGROUND_SIGN", "1")))
    parser.add_argument("--output-root", type=Path)
    parser.add_argument(
        "--free-reference",
        type=Path,
        help="optional analysis.json from the one-time free bimeron control",
    )
    parser.add_argument(
        "--thresholds",
        type=Path,
        default=THRESHOLDS_REL,
        help="versioned verification policy JSON (default: thresholds.v1.json)",
    )
    parser.add_argument("--limit", type=int)
    parser.add_argument("--release", action="store_true")
    parser.add_argument("--with-background", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--reuse", action="store_true")
    parser.add_argument("--fail-fast", action="store_true")
    parser.add_argument("--allow-diagnostic", action="store_true", help="return success while retaining a diagnostic (not accepted) profile")
    parser.add_argument("--relax-time-s", type=float, default=2e-10)
    parser.add_argument("--tol-t", type=float, default=float(os.environ.get("FULLMAG_BIMERON_TOL_T", str(DEFAULT_RELAX_TOL_T))))
    parser.add_argument("--hold-time-s", type=float, default=1e-10)
    parser.add_argument("--release-time-s", type=float, default=2e-11)
    parser.add_argument("--relax-max-steps", type=int, default=20000)
    parser.add_argument("--release-max-steps", type=int, default=8000)
    parser.add_argument("--field-every-steps", type=int, default=1000)
    parser.add_argument(
        "--table-every-steps",
        type=int,
        default=int(os.environ.get("FULLMAG_BIMERON_TABLE_EVERY_STEPS", "10")),
    )
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit must be positive")
    if args.track_x_nm is None:
        args.track_x_nm = DEFAULT_TRACK_X_NM
    if args.track_y_nm is None:
        args.track_y_nm = DENSE_TRACK_Y_NM if args.series == "dense" else DEFAULT_TRACK_Y_NM
    if args.track_x_nm <= 0.0 or args.track_y_nm <= 0.0:
        parser.error("--track-x-nm and --track-y-nm must be positive")
    if args.web_port <= 0 or args.web_port > 65535:
        parser.error("--web-port must be between 1 and 65535")
    try:
        requested_targets = _requested_targets(args)
    except ValueError as error:
        parser.error(str(error))
    if args.series == "dense":
        dense_extent_nm = max(target + 4.0 * wall for target, wall in requested_targets)
        if dense_extent_nm >= 0.5 * args.track_y_nm:
            parser.error(
                "dense series needs transverse half-width larger than target radius plus four wall widths; "
                "use --track-y-nm at least 80"
            )
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
