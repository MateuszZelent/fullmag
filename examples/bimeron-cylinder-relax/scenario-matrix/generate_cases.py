"""Generate the checked-in bimeron/cylinder material and initial-state matrix."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import sys
from itertools import product
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
CASES_DIR = ROOT / "cases"
MANIFEST_PATH = ROOT / "manifest.json"
SCHEMA = "fullmag.bimeron_material_matrix.v1"
GENERATOR_NAME = "generate_cases.py"

MATERIALS: tuple[dict[str, Any], ...] = (
    {
        "key": "rdmi_current",
        "Ms_A_per_m": 580000.0,
        "Aex_J_per_m": 15e-12,
        "Ku1_J_per_m3": 663920.0,
        "anisU": [1.0, 0.0, 0.0],
        "alpha": 1.0,
        "D_J_per_m2": 0.004,
        "reference_example": "examples/bimeron-cylinder-relax/relax.py",
    },
    {
        "key": "yig",
        "Ms_A_per_m": 140000.0,
        "Aex_J_per_m": 3.5e-12,
        "Ku1_J_per_m3": 0.0,
        "anisU": None,
        "alpha": 0.001,
        "D_J_per_m2": 0.0,
        "reference_example": "examples/fem_eigenmodes_dispersion_de_bv_low_k.py",
    },
    {
        "key": "permalloy",
        "Ms_A_per_m": 752000.0,
        "Aex_J_per_m": 1.55e-11,
        "Ku1_J_per_m3": 0.0,
        "anisU": None,
        "alpha": 0.1,
        "D_J_per_m2": 0.0,
        "reference_example": "examples/permalloy_box_relax_300x1000x10nm_fdm.py",
    },
)

FILM_INITIAL_STATES: tuple[dict[str, Any], ...] = (
    {
        "key": "bimeron",
        "kind": "bimeron",
        "radius_m": 50e-9,
        "wall_width_m": 4.732e-9,
        "vorticity": -1,
        "helicity_rad": 0.0,
        "background_sign": 1,
        "background_m": [1.0, 0.0, 0.0],
        "plane": "xy",
    },
    {
        "key": "uniform_plus_x",
        "kind": "uniform",
        "m": [1.0, 0.0, 0.0],
    },
)

CYLINDER_INITIAL_STATES: tuple[dict[str, Any], ...] = (
    {"key": "plus_x", "kind": "uniform", "m": [1.0, 0.0, 0.0]},
    {"key": "minus_x", "kind": "uniform", "m": [-1.0, 0.0, 0.0]},
)

CYLINDER_MATERIAL: dict[str, Any] = {
    "Ms_A_per_m": 1.3e6,
    "Aex_J_per_m": 10e-12,
    "Ku1_J_per_m3": 0.0,
    "anisU": None,
    "alpha": 1.0,
    "D_J_per_m2": 0.0,
}

COMMON_CONFIGURATION: dict[str, Any] = {
    "units": "SI",
    "geometry": {
        "film": {
            "kind": "box",
            "size_m": [600e-9, 600e-9, 10e-9],
            "center_m": [0.0, 0.0, 0.0],
            "z_bounds_m": [-5e-9, 5e-9],
            "object_id": "bimeron-film",
        },
        "cylinder": {
            "kind": "cylinder",
            "radius_m": 50e-9,
            "height_m": 30e-9,
            "center_m": [0.0, 0.0, 25e-9],
            "z_bounds_m": [10e-9, 40e-9],
            "object_id": "upper-cylinder",
        },
        "surface_gap_m": 5e-9,
        "universe": {
            "size_m": [600e-9, 600e-9, 65e-9],
            "center_m": [0.0, 0.0, 27.5e-9],
            "z_bounds_m": [-5e-9, 60e-9],
            "padding_m": [0.0, 0.0, 0.0],
        },
    },
    "mesh": {"cell_size_m": [2.5e-9, 2.5e-9, 2.5e-9]},
    "execution": {
        "requested_backend": "fdm",
        "requested_device": "gpu",
        "requested_precision": "double",
        "execution_mode": "strict",
        "fdm_demag": {
            "strategy": "multilayer_convolution",
            "mode": "three_d",
            "common_cell_size_m": [2.5e-9, 2.5e-9, 2.5e-9],
            "fft_backend": "cufft",
        },
    },
    "relaxation": {
        "algorithm": "projected_gradient_bb",
        "max_steps": 3000,
        "tol_torque_T": 1e-5,
        "fixed_step": False,
        "physical_time_advances": False,
        "physical_time_s": 0.0,
    },
    "autosave": {
        "table_every_steps": 100,
        "table_quantities": ["step", "mx", "my", "mz", "E_total", "max_torque_T"],
        "fields": [
            {"quantity": "m", "every_steps": 1000},
            {"quantity": "H_demag", "every_steps": 1000},
        ],
        "initial_and_terminal_observations_requested": True,
        "runtime_status": "NOT VERIFIED",
    },
    "output": {
        "data_format": "zarr",
        "location": "beside_source_script",
        "directory_pattern": "<script_stem>.zarr",
        "docker_mapping": "FULLMAG_SCRIPT_OUTPUT_ROOT",
    },
}


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _number(value: float) -> str:
    return repr(float(value))


def _render_case(
    material: dict[str, Any],
    film_state: dict[str, Any],
    cylinder_state: dict[str, Any],
) -> tuple[str, str]:
    case_id = (
        f"material_{material['key']}__film_{film_state['key']}"
        f"__cylinder_{cylinder_state['key']}"
    )
    lines = [
        '"""Standalone Fullmag input generated for the exploratory material matrix."""',
        "",
        "import fullmag as fm",
        "",
        "NM = 1e-9",
        "CELL = (2.5 * NM, 2.5 * NM, 2.5 * NM)",
        "CASE_ID = " + json.dumps(case_id),
        "",
        "study = fm.study(" + json.dumps(case_id) + ")",
        'study.engine("fdm")',
        'study.device("gpu", precision="double")',
        'study.mode("strict")',
        'study.storage(output_dir=CASE_ID + ".zarr", data_format="zarr")',
        "study.universe(",
        '    mode="manual",',
        "    size=(600 * NM, 600 * NM, 65 * NM),",
        "    center=(0.0, 0.0, 27.5 * NM),",
        "    padding=(0.0, 0.0, 0.0),",
        ")",
        "study.cell(*CELL)",
        "",
        "film = study.geometry(",
        '    fm.Box(size=(600 * NM, 600 * NM, 10 * NM)),',
        '    name="bimeron_film",',
        '    object_id="bimeron-film",',
        ")",
        f"film.Ms = {_number(material['Ms_A_per_m'])}",
        f"film.Aex = {_number(material['Aex_J_per_m'])}",
        f"film.Ku1 = {_number(material['Ku1_J_per_m3'])}",
    ]
    if material["anisU"] is not None:
        anis = ", ".join(_number(axis) for axis in material["anisU"])
        lines.append(f"film.anisU = ({anis})")
    lines.extend(
        [
            f"film.alpha = {_number(material['alpha'])}",
            "film.mesh(cell_size=CELL)",
        ]
    )
    if film_state["kind"] == "bimeron":
        lines.extend(
            [
                "film.m = fm.texture.bimeron(",
                "    radius=50 * NM,",
                "    wall_width=4.732 * NM,",
                "    vorticity=-1,",
                "    helicity_rad=0.0,",
                "    background_sign=1,",
                '    plane="xy",',
                ")",
            ]
        )
    else:
        lines.append("film.m = fm.texture.uniform(1.0, 0.0, 0.0)")
    lines.extend(
        [
            "",
            "cylinder = study.geometry(",
            '    fm.Cylinder(radius=50 * NM, height=30 * NM).translate((0.0, 0.0, 25 * NM)),',
            '    name="upper_cylinder",',
            '    object_id="upper-cylinder",',
            ")",
            f"cylinder.Ms = {_number(CYLINDER_MATERIAL['Ms_A_per_m'])}",
            f"cylinder.Aex = {_number(CYLINDER_MATERIAL['Aex_J_per_m'])}",
            f"cylinder.Ku1 = {_number(CYLINDER_MATERIAL['Ku1_J_per_m3'])}",
            f"cylinder.alpha = {_number(CYLINDER_MATERIAL['alpha'])}",
            "cylinder.mesh(cell_size=CELL)",
            "cylinder.m = fm.texture.uniform(",
            "    " + ", ".join(_number(component) for component in cylinder_state["m"]) + ",",
            ")",
            "",
        ]
    )
    if material["D_J_per_m2"] != 0.0:
        lines.extend(
            [
                "# Rotated interfacial DMI is scoped to the film object only.",
                "study.terms.add(",
                "    fm.RotatedInterfacialDMI(",
                f"        D={_number(material['D_J_per_m2'])},",
                "        object_ids=[film.object_id],",
                "    )",
                ")",
            ]
        )
    else:
        lines.append("# No DMI or imposed anisotropy is configured for this film material.")
    lines.extend(
        [
            "study.fdm(",
            "    default_cell=CELL,",
            "    demag=fm.FDMDemag(",
            '        strategy="multilayer_convolution",',
            '        mode="three_d",',
            "        common_cell_size=CELL,",
            '        fft_backend="cufft",',
            "    ),",
            ")",
            "study.demag()",
            "",
            "# PG-BB minimizes energy; it does not advance physical time or use a fixed time step.",
            "relax = study.stages.add_relax(",
            '    stage_id="joint_relax",',
            '    algorithm="projected_gradient_bb",',
            "    max_steps=3000,",
            "    tolT=1e-5,",
            ")",
            "relax.autosave(",
            "    fm.StageAutosave(",
            "        table=fm.TableAutosave(",
            "            every_steps=100,",
            '            quantities=["step", "mx", "my", "mz", "E_total", "max_torque_T"],',
            "        ),",
            "        fields=[",
            '            fm.FieldAutosave("m", every_steps=1000),',
            '            fm.FieldAutosave("H_demag", every_steps=1000),',
            "        ],",
            "    )",
            ")",
            "",
        ]
    )
    source = "\n".join(lines)
    ast.parse(source, filename=f"cases/{case_id}.py")
    return case_id, source


def build_outputs() -> dict[str, bytes]:
    """Return every generated path and deterministic byte content."""
    generated_scripts: dict[str, bytes] = {}
    cases: list[dict[str, Any]] = []
    for material, film_state, cylinder_state in product(
        MATERIALS, FILM_INITIAL_STATES, CYLINDER_INITIAL_STATES
    ):
        case_id, source = _render_case(material, film_state, cylinder_state)
        relative_script = f"cases/{case_id}.py"
        script_bytes = (source.rstrip() + "\n").encode("utf-8")
        generated_scripts[relative_script] = script_bytes
        cases.append(
            {
                "case_id": case_id,
                "study_name": case_id,
                "script": relative_script,
                "script_sha256": _sha256(script_bytes),
                "expected_output_path": str(Path(relative_script).with_suffix(".zarr")),
                "film_material": dict(material),
                "cylinder_material": dict(CYLINDER_MATERIAL),
                "initial_states": {
                    "film": dict(film_state),
                    "cylinder": dict(cylinder_state),
                },
                "max_steps": 3000,
                "convergence_status": "pending runtime; do not infer from max_steps",
                "qualification": "pending",
            }
        )

    payload: dict[str, Any] = {
        "schema": SCHEMA,
        "generator": GENERATOR_NAME,
        "qualification": "pending",
        "runtime_status": "NOT RUN",
        "convergence_claim": "none; inspect the actual terminal solver result",
        "references": {
            "current_rdmi": "examples/bimeron-cylinder-relax/relax.py",
            "yig_material": "examples/fem_eigenmodes_dispersion_de_bv_low_k.py",
            "permalloy_material": "examples/permalloy_box_relax_300x1000x10nm_fdm.py",
        },
        "common_configuration": COMMON_CONFIGURATION,
        "materials": [dict(material) for material in MATERIALS],
        "cylinder_material": dict(CYLINDER_MATERIAL),
        "initial_state_axes": {
            "film": [dict(state) for state in FILM_INITIAL_STATES],
            "cylinder": [dict(state) for state in CYLINDER_INITIAL_STATES],
        },
        "case_count": len(cases),
        "cases": cases,
    }
    integrity_payload = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    manifest = dict(payload)
    manifest["integrity"] = {"payload_sha256": _sha256(integrity_payload)}
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
    return {**generated_scripts, "manifest.json": manifest_bytes}


def _load_previous_manifest(data: bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        return None
    integrity = value.get("integrity")
    if not isinstance(integrity, dict) or not isinstance(integrity.get("payload_sha256"), str):
        return None
    payload = dict(value)
    payload.pop("integrity", None)
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if _sha256(canonical) != integrity["payload_sha256"]:
        return None
    if value.get("generator") != GENERATOR_NAME or not isinstance(value.get("cases"), list):
        return None
    return value


def _previous_script_hashes(manifest: dict[str, Any] | None) -> dict[str, str]:
    if manifest is None:
        return {}
    results: dict[str, str] = {}
    for case in manifest["cases"]:
        if not isinstance(case, dict):
            return {}
        relative = case.get("script")
        digest = case.get("script_sha256")
        if (
            not isinstance(relative, str)
            or not relative.startswith("cases/")
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
            or not isinstance(digest, str)
        ):
            return {}
        results[relative] = digest
    return results


def write_outputs(root: Path = ROOT) -> tuple[int, int]:
    """Write generated files after checking every existing target first."""
    outputs = build_outputs()
    if root.is_symlink() or (root / "cases").is_symlink():
        raise ValueError(f"refusing to write through a symlinked output directory: {root}")
    manifest_path = root / "manifest.json"
    previous = None
    if manifest_path.exists():
        previous = _load_previous_manifest(manifest_path.read_bytes())
    previous_hashes = _previous_script_hashes(previous)

    changed: list[tuple[Path, bytes]] = []
    for relative, expected in outputs.items():
        path = root / relative
        if path.is_symlink():
            raise ValueError(f"refusing to write through a symlinked generated file: {path}")
        if not path.exists():
            changed.append((path, expected))
            continue
        current = path.read_bytes()
        if current == expected:
            continue
        if relative == "manifest.json":
            if previous is None:
                raise ValueError(
                    f"refusing to overwrite modified/unrecognized manifest: {path}"
                )
            prior_cases_match = all(
                (root / case["script"]).is_file()
                and _sha256((root / case["script"]).read_bytes()) == case["script_sha256"]
                for case in previous["cases"]
            )
            if not prior_cases_match:
                raise ValueError(
                    f"refusing to replace manifest whose prior case files were modified: {path}"
                )
            changed.append((path, expected))
            continue
        if previous_hashes.get(relative) == _sha256(current):
            changed.append((path, expected))
            continue
        raise ValueError(f"refusing to overwrite a modified or untracked case: {path}")

    for path, content in changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return len(outputs), len(changed)


def check_outputs(root: Path = ROOT) -> tuple[int, int]:
    outputs = build_outputs()
    missing = [relative for relative in outputs if not (root / relative).is_file()]
    stale = [
        relative
        for relative, expected in outputs.items()
        if (root / relative).is_file() and (root / relative).read_bytes() != expected
    ]
    if missing or stale:
        details = []
        if missing:
            details.append("missing: " + ", ".join(missing))
        if stale:
            details.append("different: " + ", ".join(stale))
        raise ValueError("generated files are not current (" + "; ".join(details) + ")")
    return len(outputs), 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify generated scripts and manifest without writing files",
    )
    args = parser.parse_args(argv)
    try:
        file_count, changed_count = check_outputs() if args.check else write_outputs()
    except (OSError, ValueError) as exc:
        print(f"scenario matrix generation failed: {exc}", file=sys.stderr)
        return 1
    if args.check:
        print(f"verified {file_count} generated files")
    else:
        print(f"wrote {changed_count} of {file_count} generated files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
