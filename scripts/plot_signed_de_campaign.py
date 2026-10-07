"""Render a real grouped signed-fifteen DE campaign without scientific qualification.

The input must be one canonical managed run containing ``run-request.json``,
``run-result.json`` and ``de-smoke-signed-fifteen/eigen/dispersion.csv``.
Only native rows that pass the existing DE-SMOKE artifact validator are
plotted.  Analytic references are evaluated at those same signed wavevectors;
no FEM sample is mirrored or numerically interpolated.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Mapping

from de_pilot_receipts import validate_de_pilot_receipts
from finite_dirichlet_thin_film_oracle import n0_reference_frequencies
from managed_runtime_artifact_root import resolve_runtime_artifact_root
from thin_film_thickness_oracle import MU0, solve_thickness_modes
from validate_de_smoke_rows import SAMPLING, validate_rows


PILOT = "de-smoke-signed-fifteen"
EXPECTED_K_UM = (-25, -20, -15, -10, -7, -5, -2, 0, 2, 5, 7, 10, 15, 20, 25)
EXPECTED_K_RAD_PER_M = tuple(value * 1.0e6 for value in EXPECTED_K_UM)
EXPECTED_VECTORS = tuple((0.0, value, 0.0) for value in EXPECTED_K_RAD_PER_M)
EXPECTED_POLICY = {
    "max_cpu_percent": 90.0,
    "max_memory_percent": 80.0,
    "memory_reserve_bytes": 1_073_741_824,
    "max_workers": None,
    "threads_per_worker": 1,
}
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
HEX32 = re.compile(r"[0-9a-f]{32}\Z")
HEX40 = re.compile(r"[0-9a-f]{40}\Z")


def _read_json(path: Path, label: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{label} is missing or is not a regular file: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{label} is missing or invalid: {path}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object: {path}")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _finite(value: object, name: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite numeric value")
    value = float(value)
    if not math.isfinite(value) or (positive and value <= 0.0):
        raise ValueError(f"{name} must be a finite {'positive ' if positive else ''}value")
    return value


def _required_mapping(value: object, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _contained_file(root: Path, relative: str, label: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError(f"{label} escapes the campaign case: {relative}")
    root = root.resolve()
    path = (root / candidate).resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label} escapes the campaign case: {relative}") from error
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{label} is missing or is not a regular file: {relative}")
    return path


def _validate_receipt_identity(batch: Path, request: Mapping[str, Any], result: Mapping[str, Any]) -> None:
    try:
        validate_de_pilot_receipts(dict(request), dict(result), PILOT)
    except ValueError:
        raise

    declared_output = request.get("output_dir")
    if not isinstance(declared_output, str) or Path(declared_output).resolve() != batch:
        raise ValueError("run-request output_dir is not bound to the supplied canonical batch")

    model_sha = request.get("model_sha256")
    if not isinstance(model_sha, str) or HEX64.fullmatch(model_sha) is None:
        raise ValueError("signed-fifteen receipt has no valid model_sha256")
    job = _required_mapping(request.get("job"), "run-request job")
    if HEX32.fullmatch(str(job.get("job_id", ""))) is None:
        raise ValueError("signed-fifteen receipt has no valid job_id")
    if HEX64.fullmatch(str(job.get("source_digest", ""))) is None:
        raise ValueError("signed-fifteen receipt has no valid source_digest")
    if request.get("source") != result.get("source") or request.get("job") != result.get("job"):
        raise ValueError("signed-fifteen receipt source or job identity changed")

    model_source = _required_mapping(request.get("model_source"), "run-request model_source")
    if model_source != result.get("model_source"):
        raise ValueError("signed-fifteen receipt model_source identity changed")
    if HEX40.fullmatch(str(model_source.get("commit", ""))) is None:
        raise ValueError("signed-fifteen receipt has no full model source commit")
    if model_source.get("sha256") != model_sha:
        raise ValueError("signed-fifteen model source hash differs from model_sha256")

    if request.get("sampling") != "signed-fifteen":
        raise ValueError("signed-fifteen request has the wrong sampling")
    if request.get("cases") != [PILOT] or request.get("operation") != PILOT + "-numerical-pilot":
        raise ValueError("signed-fifteen request case identity is invalid")


def _validate_campaign_policy(
    request: Mapping[str, Any], result: Mapping[str, Any], metadata: Mapping[str, Any]
) -> dict[str, Any]:
    campaign = _required_mapping(request.get("parallel_campaign"), "parallel_campaign")
    if dict(campaign) != dict(_required_mapping(result.get("parallel_campaign"), "result parallel_campaign")):
        raise ValueError("signed-fifteen request/result parallel_campaign identity changed")
    if campaign.get("sampling") != "signed-fifteen":
        raise ValueError("parallel_campaign has the wrong sampling")
    mode = campaign.get("mode")
    if mode not in {"serial", "adaptive"}:
        raise ValueError("parallel_campaign mode must be serial or adaptive")
    if campaign.get("model_sha256") != request.get("model_sha256"):
        raise ValueError("parallel_campaign model hash differs from the receipt")
    model_source = _required_mapping(request.get("model_source"), "run-request model_source")
    if campaign.get("model_source_commit") != model_source.get("commit"):
        raise ValueError("parallel_campaign source commit differs from the receipt")
    for key, expected in EXPECTED_POLICY.items():
        if campaign.get(key) != expected:
            raise ValueError(f"parallel_campaign policy field {key} is not pinned")

    runtime = _required_mapping(
        _required_mapping(metadata.get("problem_meta"), "problem_meta").get("runtime_metadata"),
        "runtime_metadata",
    )
    selection = _required_mapping(runtime.get("runtime_selection"), "runtime_selection")
    resolved = _required_mapping(selection.get("parallel_execution"), "runtime parallel_execution")
    expected = {"mode": mode, **EXPECTED_POLICY}
    if dict(resolved) != expected:
        raise ValueError("runtime parallel_execution does not match parallel_campaign")
    return {**expected}


def _resolve_runtime_case(
    batch: Path, request: Mapping[str, Any], result: Mapping[str, Any]
) -> tuple[Path, dict[str, Any]]:
    model_sha = request.get("model_sha256")
    if not isinstance(model_sha, str):
        raise ValueError("signed-fifteen request has no model_sha256 for runtime artifact binding")
    case, binding = resolve_runtime_artifact_root(batch, PILOT, model_sha)
    recorded_binding = result.get("runtime_output_binding")
    if not isinstance(recorded_binding, Mapping):
        raise ValueError("run-result runtime_output_binding is missing or invalid")
    if dict(recorded_binding) != binding:
        raise ValueError("run-result runtime_output_binding differs from current terminal runtime evidence")
    return case, binding


def _validate_artifact_hashes(case: Path, result: Mapping[str, Any]) -> dict[str, str]:
    artifacts = _required_mapping(result.get("artifacts"), "run-result artifacts")
    hashes = _required_mapping(artifacts.get("required_artifact_hashes"), "required_artifact_hashes")
    if "metadata.json" not in hashes or "eigen/dispersion.csv" not in hashes:
        raise ValueError("run-result artifact hashes do not bind metadata and dispersion.csv")
    observed: dict[str, str] = {}
    for relative, binding in hashes.items():
        if not isinstance(relative, str) or not isinstance(binding, Mapping):
            raise ValueError("run-result required_artifact_hashes has an invalid entry")
        path = _contained_file(case, relative, "hashed artifact")
        expected_hash = binding.get("sha256")
        expected_size = binding.get("size")
        if not isinstance(expected_hash, str) or HEX64.fullmatch(expected_hash) is None:
            raise ValueError(f"invalid artifact hash for {relative}")
        if isinstance(expected_size, bool) or not isinstance(expected_size, int) or expected_size < 0:
            raise ValueError(f"invalid artifact size for {relative}")
        actual_hash = _sha256(path)
        if path.stat().st_size != expected_size or actual_hash != expected_hash:
            raise ValueError(f"artifact hash or size mismatch: {relative}")
        observed[relative] = actual_hash
    return observed


def _validate_model_metadata(
    request: Mapping[str, Any], metadata: Mapping[str, Any]
) -> tuple[dict[str, float], list[float], dict[str, Any]]:
    runtime = _required_mapping(
        _required_mapping(metadata.get("problem_meta"), "problem_meta").get("runtime_metadata"),
        "runtime_metadata",
    )
    model = dict(_required_mapping(runtime.get("de_smoke"), "de_smoke model metadata"))
    if model.get("schema") != "fullmag.de-smoke.v1":
        raise ValueError("run metadata has an unsupported DE-SMOKE model descriptor")
    if model.get("sampling") != "signed-fifteen":
        raise ValueError("run metadata has the wrong signed-fifteen sampling")
    if model.get("dispersion_geometry") != "damon_eshbach" or model.get("orientation") != "M0=x,k=y,normal=z":
        raise ValueError("run metadata does not declare Damon-Eshbach geometry")
    if model.get("outer_boundary_kind") != "poisson_dirichlet":
        raise ValueError("run metadata does not declare the finite Dirichlet airbox")
    if model.get("modal_target") != "frequency_window" or model.get("selection_scope") != "frequency_window":
        raise ValueError("signed-fifteen model must use a frequency window")
    if model.get("window_complete") is not None or model.get("requested_mode_count") != 1:
        raise ValueError("signed-fifteen model has an invalid completeness or mode count")

    expected_vectors = [list(vector) for vector in EXPECTED_VECTORS]
    if model.get("ky_rad_per_m") != list(EXPECTED_K_RAD_PER_M):
        raise ValueError("run metadata signed ky path differs from the requested campaign")
    if model.get("kx_rad_per_m") != [0.0] * len(EXPECTED_K_RAD_PER_M):
        raise ValueError("run metadata has a nonzero signed-fifteen kx path")
    if model.get("k_vectors_rad_per_m") != expected_vectors:
        raise ValueError("run metadata resolved k vectors differ from the requested campaign")

    frequency_window = model.get("frequency_window_hz")
    if (not isinstance(frequency_window, list) or len(frequency_window) != 2 or
            any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in frequency_window)):
        raise ValueError("run metadata has no finite frequency window")
    frequency_window = [_finite(value, "frequency_window_hz", positive=True) for value in frequency_window]
    if frequency_window[0] >= frequency_window[1]:
        raise ValueError("run metadata frequency window is not ordered")
    override = request.get("frequency_window_override_ghz")
    if override is not None:
        override = _required_mapping(override, "frequency_window_override_ghz")
        expected_window = [
            _finite(override.get("min"), "frequency_window_override_ghz.min", positive=True) * 1.0e9,
            _finite(override.get("max"), "frequency_window_override_ghz.max", positive=True) * 1.0e9,
        ]
        if expected_window[0] >= expected_window[1] or any(
            not math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-6)
            for actual, expected in zip(frequency_window, expected_window)
        ):
            raise ValueError("run metadata frequency window differs from the request override")

    fields = {
        "mu0_t_m_a": _finite(model.get("mu0_t_m_a"), "mu0_t_m_a", positive=True),
        "external_induction_t": _finite(model.get("external_induction_t"), "external_induction_t", positive=True),
        "air_padding_each_side_m": _finite(model.get("air_padding_each_side_m"), "air_padding_each_side_m", positive=True),
        "film_thickness_m": _finite(model.get("film_thickness_m"), "film_thickness_m", positive=True),
        "exchange_stiffness_j_per_m": _finite(model.get("exchange_stiffness_j_per_m"), "exchange_stiffness_j_per_m", positive=True),
        "saturation_magnetisation_a_per_m": _finite(model.get("saturation_magnetization_a_per_m"), "saturation_magnetization_a_per_m", positive=True),
        "gamma0_rad_s_per_a_m": _finite(model.get("gamma0_m_per_a_s"), "gamma0_m_per_a_s", positive=True),
    }
    if not math.isclose(fields["mu0_t_m_a"], MU0, rel_tol=1e-12, abs_tol=0.0):
        raise ValueError("coupled thin-film oracle requires the canonical MU0 from model metadata")
    if model.get("magnetostatic_bc") not in (None, "floquet_airbox"):
        raise ValueError("run metadata magnetostatic boundary is not Floquet airbox")
    return fields, frequency_window, model


def _read_actual_rows(csv_path: Path, frequency_window: list[float]) -> list[dict[str, Any]]:
    required = {
        "sample_index", "raw_mode_index", "branch_id", "kx_rad_per_m",
        "ky_rad_per_m", "kz_rad_per_m", "frequency_hz",
    }
    rows: list[dict[str, Any]] = []
    with csv_path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise ValueError("signed-fifteen dispersion.csv is missing required columns")
        for raw in reader:
            try:
                sample_index = int(raw["sample_index"])
                raw_mode_index = int(raw["raw_mode_index"])
                branch_id = int(raw["branch_id"])
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError("signed-fifteen dispersion row has invalid indices") from error
            values = {}
            for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", "frequency_hz"):
                try:
                    values[key] = _finite(float(raw[key]), key)
                except (TypeError, ValueError, OverflowError) as error:
                    raise ValueError(f"signed-fifteen dispersion row has invalid {key}") from error
            if sample_index < 0 or raw_mode_index != 0:
                raise ValueError("signed-fifteen rows must use nonnegative samples and raw mode 0")
            if values["frequency_hz"] <= 0.0 or not frequency_window[0] <= values["frequency_hz"] <= frequency_window[1]:
                raise ValueError("signed-fifteen row frequency is outside the resolved window")
            rows.append({"sample_index": sample_index, "raw_mode_index": raw_mode_index,
                         "branch_id": branch_id, **values})
    if len(rows) != len(EXPECTED_K_RAD_PER_M):
        raise ValueError("signed-fifteen dispersion must contain exactly 15 native rows")
    rows.sort(key=lambda row: row["sample_index"])
    if [row["sample_index"] for row in rows] != list(range(15)):
        raise ValueError("signed-fifteen dispersion sample indices are incomplete or duplicated")
    for row, expected_k in zip(rows, EXPECTED_K_RAD_PER_M):
        if row["kx_rad_per_m"] != 0.0 or row["kz_rad_per_m"] != 0.0:
            raise ValueError("signed-fifteen dispersion leaves the DE propagation direction")
        if not math.isclose(row["ky_rad_per_m"], expected_k, rel_tol=1e-12, abs_tol=1e-12):
            raise ValueError("signed-fifteen dispersion wavevector differs from its sample index")
    return rows


def load_campaign(batch: Path) -> dict[str, Any]:
    """Validate and load the real native campaign without writing anything."""
    batch = Path(batch).expanduser().resolve()
    if not batch.is_dir() or batch.is_symlink():
        raise ValueError("campaign path must be a regular directory")
    request = _read_json(batch / "run-request.json", "run-request")
    result = _read_json(batch / "run-result.json", "run-result")
    _validate_receipt_identity(batch, request, result)
    case, runtime_binding = _resolve_runtime_case(batch, request, result)
    if not case.is_dir() or case.is_symlink():
        raise ValueError("signed-fifteen runtime artifact directory is missing")
    metadata_path = case / "metadata.json"
    metadata = _read_json(metadata_path, "signed-fifteen metadata")
    artifact_hashes = _validate_artifact_hashes(case, result)
    parameters, frequency_window, model = _validate_model_metadata(request, metadata)
    policy = _validate_campaign_policy(request, result, metadata)
    diagnostics_path = case / "eigen" / "diagnostics" / "solver.v1.json"
    csv_path = case / "eigen" / "dispersion.csv"
    row_report = validate_rows(csv_path, "signed-fifteen", diagnostics_path, metadata_path)
    if not isinstance(row_report, Mapping) or row_report.get("status") != "pass":
        raise ValueError("signed-fifteen native row validation did not pass")
    rows = _read_actual_rows(csv_path, frequency_window)
    return {
        "batch": batch,
        "case": case,
        "runtime_output_binding": runtime_binding,
        "request": request,
        "result": result,
        "metadata": metadata,
        "model": model,
        "parameters": parameters,
        "frequency_window_hz": frequency_window,
        "parallel_campaign": policy,
        "row_report": dict(row_report),
        "rows": rows,
        "artifact_sha256": artifact_hashes,
        "input_sha256": {
            "run-request.json": _sha256(batch / "run-request.json"),
            "run-result.json": _sha256(batch / "run-result.json"),
            "metadata.json": _sha256(metadata_path),
            "eigen/dispersion.csv": _sha256(csv_path),
            "eigen/diagnostics/solver.v1.json": _sha256(diagnostics_path),
        },
    }


def analytic_points(campaign: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Evaluate n=0 and coupled references at the actual native k samples."""
    parameters = campaign["parameters"]
    rows = campaign["rows"]
    result: list[dict[str, Any]] = []
    for row in rows:
        k = row["ky_rad_per_m"]
        n0 = n0_reference_frequencies(
            k_rad_m=k,
            geometry="damon_eshbach",
            bias_field_a_per_m=parameters["external_induction_t"] / parameters["mu0_t_m_a"],
            film_thickness_m=parameters["film_thickness_m"],
            air_padding_each_side_m=parameters["air_padding_each_side_m"],
            exchange_stiffness_j_per_m=parameters["exchange_stiffness_j_per_m"],
            saturation_magnetisation_a_per_m=parameters["saturation_magnetisation_a_per_m"],
            gamma0_rad_s_per_a_m=parameters["gamma0_rad_s_per_a_m"],
            mu0_t_m_a=parameters["mu0_t_m_a"],
        )
        coupled = solve_thickness_modes(
            ms_a_m=parameters["saturation_magnetisation_a_per_m"],
            exchange_j_m=parameters["exchange_stiffness_j_per_m"],
            bias_t=parameters["external_induction_t"],
            thickness_m=parameters["film_thickness_m"],
            gamma0_m_a_s=parameters["gamma0_rad_s_per_a_m"],
            k_rad_m=k,
            geometry="DE",
            basis_size=32,
        )
        modes = coupled.get("modes") if isinstance(coupled, Mapping) else None
        if not isinstance(modes, list) or not modes or not isinstance(modes[0], Mapping):
            raise ValueError("coupled thin-film oracle returned no mode")
        result.append({
            "sample_index": row["sample_index"],
            "k_rad_per_m": k,
            "native_frequency_hz": row["frequency_hz"],
            "open_film_n0_frequency_hz": n0["open_film_n0_frequency_hz"],
            "finite_dirichlet_n0_frequency_hz": n0["finite_dirichlet_n0_frequency_hz"],
            "coupled_thickness_frequency_hz": _finite(
                modes[0].get("frequency_hz"), "coupled oracle frequency", positive=True
            ),
        })
    return result


def _source_hashes() -> dict[str, str]:
    paths = [
        Path(__file__),
        Path(__file__).with_name("de_pilot_receipts.py"),
        Path(__file__).with_name("managed_runtime_artifact_root.py"),
        Path(__file__).with_name("validate_de_smoke_rows.py"),
        Path(__file__).with_name("finite_dirichlet_thin_film_oracle.py"),
        Path(__file__).with_name("thin_film_thickness_oracle.py"),
    ]
    return {path.name: _sha256(path) for path in paths}


def write_plot(campaign: Mapping[str, Any], output: Path) -> dict[str, str]:
    """Write a new sibling output directory and return generated file hashes."""
    batch = Path(campaign["batch"]).resolve()
    output = Path(output).expanduser().resolve()
    if output == batch or output.parent != batch.parent:
        raise ValueError("plot output must be a new sibling directory of the canonical batch")
    if output.exists() or output.is_symlink():
        raise ValueError(f"refusing to overwrite existing plot output: {output}")
    if not output.parent.is_dir() or output.parent.is_symlink():
        raise ValueError("plot output parent must be an existing canonical storage directory")

    references = analytic_points(campaign)
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    output.mkdir(exist_ok=False)
    png = output / "signed-fifteen-dispersion.png"
    pdf = output / "signed-fifteen-dispersion.pdf"
    x = [item["k_rad_per_m"] / 1.0e6 for item in references]
    native = [item["native_frequency_hz"] / 1.0e9 for item in references]
    open_n0 = [item["open_film_n0_frequency_hz"] / 1.0e9 for item in references]
    finite_n0 = [item["finite_dirichlet_n0_frequency_hz"] / 1.0e9 for item in references]
    coupled = [item["coupled_thickness_frequency_hz"] / 1.0e9 for item in references]
    fig, ax = plt.subplots(figsize=(11, 6.5), constrained_layout=True)
    ax.scatter(x, native, s=52, color="#1565c0", label="FEM native — 15 actual rows")
    ax.scatter(x, open_n0, s=40, marker="x", color="#d58a18", label="Open-film n=0 oracle")
    ax.scatter(x, finite_n0, s=40, marker="+", color="#7b2cbf", label="Finite Dirichlet n=0 oracle")
    ax.scatter(x, coupled, s=34, marker="^", facecolors="none", edgecolors="#202a35",
               label="Coupled thickness oracle (N=32)")
    ax.axvline(0.0, color="#202a35", linewidth=0.8, alpha=0.4)
    parameters = campaign["parameters"]
    ax.set(
        xlabel="kᵧ [rad/µm]",
        ylabel="f [GHz]",
        title="Signed DE dispersion — native 15-point campaign (NOT VERIFIED)",
    )
    ax.grid(alpha=0.25)
    ax.legend(fontsize=9)
    ax.text(
        0.01,
        -0.17,
        "No mirrored or numerically interpolated FEM samples · "
        f"t={parameters['film_thickness_m'] * 1e9:g} nm · "
        f"Mₛ={parameters['saturation_magnetisation_a_per_m'] / 1e3:g} kA/m · "
        f"A={parameters['exchange_stiffness_j_per_m'] * 1e12:g} pJ/m · "
        f"B₀={parameters['external_induction_t']:g} T",
        transform=ax.transAxes,
        fontsize=8,
    )
    fig.savefig(png, dpi=180)
    fig.savefig(pdf)
    plt.close(fig)

    report = {
        "schema": "fullmag.signed-de-campaign-plot.v1",
        "status": "pass",
        "qualification": "NOT VERIFIED",
        "scope": "actual signed-fifteen native rows with postsolve n0/coupled references",
        "pilot": PILOT,
        "actual_point_count": len(references),
        "expected_k_rad_per_m": list(EXPECTED_K_RAD_PER_M),
        "mirrored_samples": False,
        "interpolated_numeric_samples": False,
        "parameters_from_metadata": parameters,
        "frequency_window_hz": campaign["frequency_window_hz"],
        "parallel_campaign": campaign["parallel_campaign"],
        "row_preflight": campaign["row_report"],
        "receipt_identity": {
            "model_sha256": campaign["request"]["model_sha256"],
            "model_source": campaign["request"]["model_source"],
            "job": campaign["request"]["job"],
            "source": campaign["request"]["source"],
        },
        "runtime_output_binding": campaign["runtime_output_binding"],
        "input_sha256": campaign["input_sha256"],
        "artifact_sha256": campaign["artifact_sha256"],
        "analytic_reference_models": {
            "open_film_n0": {"status": "available", "boundary": "open_magnetostatic_free"},
            "finite_dirichlet_n0": {
                "status": "available",
                "boundary": "scalar_potential_dirichlet",
                "air_padding_each_side_m": parameters["air_padding_each_side_m"],
            },
            "coupled_thickness_oracle": {
                "status": "available",
                "basis_size": 32,
                "qualification": "diagnostic_oracle_only_not_FEM",
            },
        },
        "references": references,
        "source_sha256": _source_hashes(),
        "limitations": [
            "The managed receipt is completed_unqualified; this plot is not a scientific qualification.",
            "Mesh, airbox, thickness-mode and branch/convergence gates remain open.",
            "Analytic n0 and coupled values are diagnostic references, not FEM replacements.",
        ],
    }
    report["output_sha256"] = {png.name: _sha256(png), pdf.name: _sha256(pdf)}
    receipt_path = output / "plot-receipt.json"
    receipt_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"png": str(png), "pdf": str(pdf), "receipt": str(receipt_path)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batch", type=Path, help="canonical signed-fifteen managed run directory")
    parser.add_argument("--output", required=True, type=Path,
                        help="new sibling directory in canonical storage for PNG/PDF/receipt")
    args = parser.parse_args(argv)
    try:
        campaign = load_campaign(args.batch)
        outputs = write_plot(campaign, args.output)
    except (OSError, ValueError, csv.Error) as error:
        print(f"plot-signed-de-campaign: {error}", file=sys.stderr)
        return 2
    print(json.dumps({"status": "pass", "qualification": "NOT VERIFIED", **outputs}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
