"""Staged open-airbox k=0 spectrum repeat from the accepted step-8006 state.

The campaign preparer copies this file beside a frozen .case.json descriptor.
The descriptor names immutable checkpoint and mesh files through the canonical
Docker DEV script-output mount. The generated fullmag-bin command pins output
and workspace roots under that mount; checkpoint paths come from the descriptor.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path, PurePosixPath

import numpy as np
import zarr

import fullmag as fm


CASE_SCHEMA = "fullmag.fem.open_airbox_k0.case.v1"
TEMPLATE_KIND = "checkpoint_step_8006"


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_case() -> dict:
    script = Path(__file__).resolve()
    descriptor_path = script.with_suffix(".case.json")
    case = json.loads(descriptor_path.read_text(encoding="utf-8"))
    if not isinstance(case, dict) or case.get("schema") != CASE_SCHEMA:
        raise ValueError("missing or unsupported staged case descriptor")
    if case.get("template_kind") != TEMPLATE_KIND:
        raise ValueError("staged descriptor is not a checkpoint repeat case")
    if hashlib.sha256(script.read_bytes()).hexdigest() != case.get("script_sha256"):
        raise ValueError("staged case script hash differs from its descriptor")
    if canonical_sha256(case.get("input_identity")) != case.get(
        "input_identity_sha256"
    ):
        raise ValueError("staged case input identity hash differs")
    device = case.get("execution_device")
    if device not in {"cpu", "gpu"}:
        raise ValueError("staged case requires explicit cpu or gpu execution")
    output_name = case.get("output_directory_name")
    output = PurePosixPath(str(output_name))
    if (
        not isinstance(output_name, str)
        or output.is_absolute()
        or len(output.parts) != 1
        or output.name != f"{case.get('case_id')}.zarr"
        or output.suffix != ".zarr"
    ):
        raise ValueError("staged output must be one case-specific relative Zarr name")
    for key in (
        "mesh_container_path",
        "equilibrium_container_path",
        "equilibrium_artifact_container_path",
    ):
        input_path = PurePosixPath(str(case.get(key)))
        if (
            not input_path.is_absolute()
            or not str(input_path).startswith("/opt/fullmag/script-output/")
            or ".." in input_path.parts
        ):
            raise ValueError(f"{key} must be inside the managed DEV output mount")
    return case


case = load_case()
mesh_path = Path(case["mesh_container_path"])
checkpoint_path = Path(case["equilibrium_container_path"])
artifact_path = Path(case["equilibrium_artifact_container_path"])
expected = case["checkpoint_identity"]

if not artifact_path.is_file() or sha256_file(artifact_path) != expected[
    "equilibrium_artifact_file_sha256"
]:
    raise ValueError("certified equilibrium artifact differs from the pinned step-8006 bytes")
artifact = json.loads(artifact_path.read_bytes())
if artifact.get("content_sha256") != expected["equilibrium_artifact_content_sha256"]:
    raise ValueError("certified step-8006 equilibrium content identity differs")

if not mesh_path.is_file() or sha256_file(mesh_path) != expected["input_mesh_sha256"]:
    raise ValueError("staged input mesh differs from the step-8006 mesh identity")

archive = zarr.open_group(str(checkpoint_path), mode="r")
if (
    archive.attrs.get("sequence_step") != 8006
    or archive.attrs.get("completion", {}).get("converged") is not True
    or archive.attrs.get("equilibrium_certified") is not True
    or archive.attrs.get("linearization_certificate", {}).get("status") != "matched"
):
    raise ValueError("staged equilibrium is not the accepted step-8006 checkpoint")
if archive.attrs.get("input_mesh_sha256") != expected["input_mesh_sha256"]:
    raise ValueError("step-8006 equilibrium does not name the staged mesh")
if archive.attrs.get("magnetization_f64le_sha256") != expected[
    "magnetization_f64le_sha256"
]:
    raise ValueError("step-8006 equilibrium magnetization identity differs")
if archive.attrs.get("linearization_certificate", {}).get(
    "mesh_topology_sha256"
) != expected["native_mesh_topology_sha256"]:
    raise ValueError("step-8006 equilibrium topology identity differs")

initial_state = fm.init.load_magnetization(
    checkpoint_path, dataset="m", format="zarr"
)
values = np.asarray(initial_state.values, dtype="<f8")
if (
    values.shape != (expected["node_count"], 3)
    or not np.isfinite(values).all()
    or hashlib.sha256(values.tobytes()).hexdigest()
    != expected["magnetization_f64le_sha256"]
):
    raise ValueError("loaded equilibrium field differs from step-8006 identity")

study = fm.study(case["study_id"])
study.engine("fem")
study.device(case["execution_device"], precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(1.6e-6, 1.6e-6, 1.6e-6),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=16e-9,
    maximum_element_size=100e-9,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)
sphere = study.geometry(
    fm.Sphere(100e-9, name="permalloy_geom"), name="permalloy"
)
sphere.Ms = 800e3
sphere.Aex = 13e-12
sphere.alpha = 1.0
sphere.m = initial_state
sphere.mesh(maximum_element_size=16e-9, order=1)
study.solver(gamma=float(case["input_identity"]["gyromagnetic_ratio_m_per_a_s"]))
study.b_ext(5.0e-3, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-12,
    max_iterations=1000,
)
study.domain_mesh(str(mesh_path), region_markers={"permalloy_geom": 1})
study.storage(
    output_dir=case["output_directory_name"],
    data_format="zarr",
    existing_output="error",
)
study.save("spectrum")
study.save("mode", indices=tuple(range(case["requested_mode_count"])))

print(
    json.dumps(
        {
            "event": "open_airbox_k0_checkpoint_repeat",
            "case_id": case["case_id"],
            "input_identity_sha256": case["input_identity_sha256"],
            "execution_device_requested": case["execution_device"],
            "frequency_window_hz": case["frequency_window_hz"],
            "minimum_positive_mode_count": case["minimum_positive_mode_count"],
            "requested_mode_count": case["requested_mode_count"],
            "input_mesh_sha256": expected["input_mesh_sha256"],
            "equilibrium_artifact_file_sha256": expected["equilibrium_artifact_file_sha256"],
            "magnetization_f64le_sha256": expected[
                "magnetization_f64le_sha256"
            ],
        },
        sort_keys=True,
    ),
    file=sys.stderr,
)

# Re-evaluate the unchanged saved state using the native Robin provider.
# The campaign verifier requires zero accepted steps and an exact m0 digest.
study.stages.add_relax(
    stage_id="verify-saved-equilibrium",
    algorithm="projected_gradient_bb",
    max_steps=1,
    tolT=float(case["input_identity"]["equilibrium_recertification_tolerance_t"]),
)
study.stages.add_eigenmodes(
    stage_id="open-airbox-k0-step-8006-frequency-window",
    count=case["requested_mode_count"],
    target="frequency_window",
    frequency_min=case["frequency_window_hz"][0],
    frequency_max=case["frequency_window_hz"][1],
    operator="full_2x2",
    equilibrium_source="relax",
    equilibrium_acceptance="certified",
    include_demag=True,
    normalization="unit_l2",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc="free",
    magnetostatic_bc="open_airbox_k0",
)
