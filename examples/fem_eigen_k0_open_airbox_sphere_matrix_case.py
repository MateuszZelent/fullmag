"""Staged explicit-device Kittel sphere case for the open-airbox k=0 matrix.

The campaign preparer copies this file beside a frozen .case.json descriptor.
Run the staged copy with the published fullmag-bin CLI in the selected managed
Docker DEV backend. The descriptor is resolved from __file__; the generated
command pins --output-dir and --workspace-root under the script-output mount.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path, PurePosixPath

import fullmag as fm


CASE_SCHEMA = "fullmag.fem.open_airbox_k0.case.v1"
TEMPLATE_KIND = "kittel_sphere"
MU0 = 4.0e-7 * math.pi


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_case() -> dict:
    script = Path(__file__).resolve()
    descriptor_path = script.with_suffix(".case.json")
    case = json.loads(descriptor_path.read_text(encoding="utf-8"))
    if not isinstance(case, dict) or case.get("schema") != CASE_SCHEMA:
        raise ValueError("missing or unsupported staged case descriptor")
    if case.get("template_kind") != TEMPLATE_KIND:
        raise ValueError("staged descriptor is not a Kittel sphere case")
    if hashlib.sha256(script.read_bytes()).hexdigest() != case.get("script_sha256"):
        raise ValueError("staged case script hash differs from its descriptor")
    if canonical_sha256(case.get("input_identity")) != case.get(
        "input_identity_sha256"
    ):
        raise ValueError("staged case input identity hash differs")
    device = case.get("execution_device")
    if device not in {"cpu", "gpu"}:
        raise ValueError("staged case requires explicit cpu or gpu execution")
    output = case.get("output_directory_name")
    path = PurePosixPath(str(output))
    if (
        not isinstance(output, str)
        or path.is_absolute()
        or len(path.parts) != 1
        or path.name != f"{case.get('case_id')}.zarr"
        or path.suffix != ".zarr"
    ):
        raise ValueError("staged output must be one case-specific relative Zarr name")
    return case


def load_cpu_reference(case: dict) -> tuple[Path, fm.init.SampledMagnetization]:
    runs = Path(__file__).resolve().parent
    pair_id = case["pair_id"]
    if not isinstance(pair_id, str) or not re.fullmatch(r"kittel_h[0-9p]+_box[0-9]+", pair_id):
        raise ValueError("invalid staged Kittel pair identity")
    cpu_case_id = pair_id + "_cpu"
    cpu_case = json.loads((runs / f"{cpu_case_id}.case.json").read_bytes())
    if (
        cpu_case.get("case_id") != cpu_case_id
        or cpu_case.get("execution_device") != "cpu"
        or canonical_sha256(cpu_case.get("input_identity")) != case["input_identity_sha256"]
    ):
        raise ValueError("Kittel GPU case does not match the CPU input descriptor")
    artifact_root = runs / f"{cpu_case_id}.zarr" / "artifacts/frequency_domain"
    pointer = json.loads((artifact_root / "generation.v2.json").read_bytes())
    generation_id = pointer["generation_id"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", generation_id):
        raise ValueError("invalid Kittel CPU artifact generation")
    generation = artifact_root / "generations" / generation_id.removeprefix("sha256:")
    members = pointer["content"]["members"]

    def verified_member(relative: str) -> dict:
        data = (generation / relative).read_bytes()
        if (
            members[relative]["byte_length"] != len(data)
            or members[relative]["sha256"] != "sha256:" + hashlib.sha256(data).hexdigest()
        ):
            raise ValueError(f"Kittel CPU generation member changed: {relative}")
        return json.loads(data)

    solver = verified_member("eigen/diagnostics/solver.v1.json")
    if (
        solver.get("execution_lane") != "production_cpu"
        or solver.get("solve_succeeded") is not True
        or solver.get("full_residual_certified") is not True
        or solver.get("fallback_used") is not False
        or solver.get("demag_kind") != "open_airbox_k0"
    ):
        raise ValueError("Kittel CPU reference is not a certified open-airbox FEM solve")
    paths = [
        f"eigen/metadata/equilibrium_artifact.{version}.json"
        for version in ("v7", "v8")
        if f"eigen/metadata/equilibrium_artifact.{version}.json" in members
    ]
    if len(paths) != 1:
        raise ValueError("Kittel CPU generation must have one equilibrium artifact")
    equilibrium = verified_member(paths[0])
    if (
        equilibrium.get("accepted_for_linearization") is not True
        or equilibrium.get("content_sha256") != solver.get("equilibrium_artifact_sha256")
    ):
        raise ValueError("Kittel CPU solver does not bind the saved equilibrium")
    mesh = verified_member("eigen/metadata/sample_0000/consumer_plan_snapshot.v1.json")["mesh"]
    m0 = equilibrium["m0"]
    if len(mesh["nodes"]) != len(m0):
        raise ValueError("Kittel CPU mesh and equilibrium have different node counts")
    mesh_bytes = json.dumps(mesh, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    pinned = runs.parent / "inputs" / "kittel" / pair_id
    pinned.mkdir(parents=True, exist_ok=True)
    mesh_path = pinned / (hashlib.sha256(mesh_bytes).hexdigest() + ".json")
    if not mesh_path.exists():
        with tempfile.TemporaryDirectory(dir=pinned) as temporary:
            candidate = Path(temporary) / "mesh.json"
            candidate.write_bytes(mesh_bytes)
            try:
                os.link(candidate, mesh_path)
            except FileExistsError:
                pass
    if mesh_path.read_bytes() != mesh_bytes:
        raise ValueError("pinned Kittel CPU mesh differs from its verified snapshot")
    return mesh_path, fm.init.SampledMagnetization(m0)


case = load_case()
gpu = case["execution_device"] == "gpu"
model = case["model"]
study = fm.study(case["study_id"])
study.engine("fem")
study.device(case["execution_device"], precision="double")
study.solver(gamma=float(model["gyromagnetic_ratio_m_per_a_s"]))
study.mode("strict")

radius_m = float(model["radius_m"])
mag_hmax_m = float(model["magnetic_hmax_m"])
air_hmax_m = float(model["air_hmax_m"])
box_factor = float(model["box_factor"])
bias_t = float(model["bias_t"])
gamma0_m_per_a_s = float(model["gyromagnetic_ratio_m_per_a_s"])
gamma_hz_per_t = gamma0_m_per_a_s / (2.0 * math.pi * MU0)
analytic_reference = case["input_identity"]["analytic_reference"]
if (
    gamma0_m_per_a_s != case["input_identity"]["gyromagnetic_ratio_m_per_a_s"]
    or gamma0_m_per_a_s != analytic_reference["gyromagnetic_ratio_m_per_a_s"]
    or not math.isclose(
        gamma_hz_per_t,
        float(analytic_reference["gamma_hz_per_t"]),
        rel_tol=1e-14,
        abs_tol=0.0,
    )
):
    raise ValueError("Kittel gamma differs from the staged scientific input identity")
box_length_m = box_factor * 2.0 * radius_m

study.universe(
    mode="manual",
    size=(box_length_m, box_length_m, box_length_m),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=mag_hmax_m,
    maximum_element_size=air_hmax_m,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)
sphere = study.geometry(fm.Sphere(radius_m, name="sphere"), name="sphere")
sphere.Ms = float(model["saturation_magnetisation_A_per_m"])
sphere.Aex = float(model["exchange_stiffness_J_per_m"])
sphere.alpha = 0.0
sphere.mesh(maximum_element_size=mag_hmax_m, order=1)
if gpu:
    reference_mesh, sphere.m = load_cpu_reference(case)
else:
    sphere.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

study.b_ext(bias_t, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-12,
    max_iterations=1000,
)
if gpu:
    study.domain_mesh(reference_mesh, region_markers={"sphere": 1})
else:
    study.build_domain_mesh()
study.storage(
    output_dir=case["output_directory_name"],
    data_format="zarr",
    existing_output="error",
)
study.save("spectrum")
study.save("mode", indices=(0,))

expected_hz = gamma_hz_per_t * bias_t
static_only_hz = gamma_hz_per_t * (
    bias_t - MU0 * float(model["saturation_magnetisation_A_per_m"]) / 3.0
)
if not math.isclose(
    expected_hz,
    float(analytic_reference["expected_frequency_hz"]),
    rel_tol=1e-14,
    abs_tol=0.0,
):
    raise ValueError("Kittel target differs from the staged analytic reference")
print(
    json.dumps(
        {
            "event": "open_airbox_k0_kittel_case",
            "case_id": case["case_id"],
            "input_identity_sha256": case["input_identity_sha256"],
            "execution_device_requested": case["execution_device"],
            "magnetic_hmax_m": mag_hmax_m,
            "box_factor": box_factor,
            "gyromagnetic_ratio_m_per_a_s": gamma0_m_per_a_s,
            "gamma_hz_per_t": gamma_hz_per_t,
            "expected_kittel_frequency_hz": expected_hz,
            "static_demag_only_frequency_hz": static_only_hz,
        },
        sort_keys=True,
    ),
    file=sys.stderr,
)

study.stages.add_relax(
    stage_id="kittel-sphere-equilibrium",
    algorithm="projected_gradient_bb",
    max_steps=1 if gpu else 20_000,
    tolT=1.0e-6,
)
study.stages.add_eigenmodes(
    stage_id="open-airbox-k0-kittel-mode",
    count=1,
    target="nearest",
    target_frequency=expected_hz,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    equilibrium_acceptance="certified",
    normalization="unit_l2",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc="free",
    magnetostatic_bc="open_airbox_k0",
)
