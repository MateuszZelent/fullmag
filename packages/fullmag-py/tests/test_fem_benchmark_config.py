import importlib.util
import inspect
import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
BENCHMARK_PATH = REPO_ROOT / "examples" / "bench_fem_gpu_long.py"
ANALYSIS_BENCHMARK_PATH = REPO_ROOT / "scripts" / "analysis" / "fem_gpu_benchmark.py"
FEM_CMAKE_PATH = REPO_ROOT / "native" / "backends" / "fem" / "CMakeLists.txt"
GPU_RK_CU_PATH = REPO_ROOT / "native" / "backends" / "fem" / "src" / "gpu_rk.cu"
GPU_RK_CPP_PATH = REPO_ROOT / "native" / "backends" / "fem" / "src" / "gpu_rk.cpp"
GPU_EXCHANGE_CPP_PATH = REPO_ROOT / "native" / "backends" / "fem" / "src" / "gpu_exchange.cpp"
MFEM_BRIDGE_CPP_PATH = REPO_ROOT / "native" / "backends" / "fem" / "src" / "mfem_bridge.cpp"
ALL_IN_GPU_RUNTIME_DOC = REPO_ROOT / "docs" / "physics" / "0560-all-in-gpu-fem-runtime.md"
ALL_IN_GPU_PLAN = (
    REPO_ROOT / "docs" / "plans" / "active" / "all-in-gpu-fem-rollout-plan-2026-05-15.md"
)


def load_benchmark_module():
    spec = importlib.util.spec_from_file_location("bench_fem_gpu_long", BENCHMARK_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_analysis_benchmark_module():
    spec = importlib.util.spec_from_file_location(
        "fem_gpu_benchmark", ANALYSIS_BENCHMARK_PATH
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_benchmark_config_accepts_integrator_axis(monkeypatch):
    bench = load_benchmark_module()
    monkeypatch.setenv("FULLMAG_BENCH_INTEGRATOR", "rk4")

    _, _, _, _, integrator, _ = bench.benchmark_config()

    assert integrator == "rk4"


def test_benchmark_config_accepts_adaptive_timestep_policy(monkeypatch):
    bench = load_benchmark_module()
    monkeypatch.setenv("FULLMAG_BENCH_INTEGRATOR", "rk23")
    monkeypatch.setenv("FULLMAG_BENCH_TIMESTEP_POLICY", "adaptive")

    _, _, _, _, integrator, timestep_policy = bench.benchmark_config()

    assert integrator == "rk23"
    assert timestep_policy == "adaptive"


def test_default_until_follows_env_steps_and_dt(monkeypatch):
    monkeypatch.setenv("FULLMAG_BENCH_STEPS", "7")
    monkeypatch.setenv("FULLMAG_BENCH_DT", "2e-13")
    bench = load_benchmark_module()

    assert bench.DEFAULT_UNTIL == 14e-13


def test_build_is_no_arg_for_cli_loader():
    bench = load_benchmark_module()
    signature = inspect.signature(bench.build)

    for parameter in signature.parameters.values():
        assert parameter.default is not inspect.Parameter.empty


def test_exchange_demag_build_uses_shared_domain_mesh_contract():
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag",
        integrator="heun",
    )

    assert problem.runtime.backend_target.value == "fem"
    assert problem.discretization.fem.mesh is None
    assert problem.runtime_metadata["study_universe"]["airbox_hmax"] > 0.0
    assert problem.runtime_metadata["mesh_workflow"]["build_target"] == "domain"


def test_exchange_demag_anisotropy_build_uses_shared_domain_and_material_ku():
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag_anisotropy",
        integrator="rk23",
        timestep_policy="adaptive",
    )

    material = problem.magnets[0].material
    assert problem.discretization.fem.mesh is None
    assert problem.runtime_metadata["mesh_workflow"]["build_target"] == "domain"
    assert material.Ku1 == 0.5e6
    assert material.anisU == (0.0, 0.0, 1.0)


def test_phase10_anisotropy_scenarios_use_expected_terms_and_materials():
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    uniaxial = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_anis_uniaxial",
        integrator="heun",
    )
    cubic = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_anis_cubic",
        integrator="heun",
    )
    demag_uniaxial = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag_anis_uniaxial",
        integrator="heun",
    )
    demag_cubic = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag_anis_cubic",
        integrator="heun",
    )

    assert uniaxial.discretization.fem.mesh == str(mesh_path)
    assert uniaxial.magnets[0].material.Ku1 == 0.5e6
    assert uniaxial.magnets[0].material.anisU == (0.0, 0.0, 1.0)
    assert cubic.discretization.fem.mesh == str(mesh_path)
    assert cubic.magnets[0].material.Kc1 == 4.8e4
    assert cubic.magnets[0].material.anisC1 == (1.0, 0.0, 0.0)
    assert cubic.magnets[0].material.anisC2 == (0.0, 1.0, 0.0)
    assert demag_uniaxial.discretization.fem.mesh is None
    assert demag_uniaxial.runtime_metadata["mesh_workflow"]["build_target"] == "domain"
    assert demag_uniaxial.magnets[0].material.Ku1 == 0.5e6
    assert demag_cubic.discretization.fem.mesh is None
    assert demag_cubic.runtime_metadata["mesh_workflow"]["build_target"] == "domain"
    assert demag_cubic.magnets[0].material.Kc1 == 4.8e4


def test_benchmark_build_accepts_demag_solver_policy_env(monkeypatch):
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"
    monkeypatch.setenv("FULLMAG_BENCH_DEMAG_RTOL", "1e-6")
    monkeypatch.setenv("FULLMAG_BENCH_DEMAG_ATOL", "1e-12")
    monkeypatch.setenv("FULLMAG_BENCH_DEMAG_MAX_ITERATIONS", "75")
    monkeypatch.setenv("FULLMAG_BENCH_DEMAG_PRINT_LEVEL", "2")

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag_anisotropy",
        integrator="rk23",
        timestep_policy="adaptive",
    )

    policy = problem.discretization.fem.demag_solver_policy
    assert policy is not None
    assert policy.solver == "CG"
    assert policy.preconditioner == "AMG"
    assert policy.rtol == 1e-6
    assert policy.atol == 1e-12
    assert policy.max_iterations == 75
    assert policy.print_level == 2


def test_benchmark_build_can_request_adaptive_timestep():
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag",
        integrator="rk23",
        timestep_policy="adaptive",
    )

    dynamics = problem.study.dynamics
    assert dynamics.integrator == "rk23"
    assert dynamics.fixed_timestep is None
    assert dynamics.adaptive_timestep is not None
    assert dynamics.adaptive_timestep.dt_initial == 1e-13


def test_analysis_benchmark_accepts_timestep_policy_axis():
    bench = load_analysis_benchmark_module()

    assert bench.resolve_timestep_policies("fixed,adaptive") == ["fixed", "adaptive"]


def test_build_uses_cli_safe_uniform_initializer():
    bench = load_benchmark_module()
    problem = bench.build()

    assert problem.magnets[0].m0.to_ir()["kind"] == "uniform"


def test_emit_summary_includes_integrator(capsys):
    bench = load_benchmark_module()

    class Step:
        time = 2e-13
        dt = 1e-13
        error_estimate = 0.25
        dt_suggested = 2e-13
        e_total = 1.0
        e_ex = 0.25
        e_demag = 0.0
        wall_time_ns = 10
        exchange_wall_time_ns = 2
        demag_wall_time_ns = 0
        demag_assemble_wall_time_ns = 0
        demag_solve_wall_time_ns = 0
        demag_recover_wall_time_ns = 0
        demag_energy_wall_time_ns = 0
        rhs_wall_time_ns = 3
        extra_energy_wall_time_ns = 1
        snapshot_wall_time_ns = 0
        rhs_evals = 5
        demag_solves = 0
        rejected_attempts = 0
        fsal_reused = False
        max_dm_dt = 4.0
        max_h_eff = 5.0
        max_h_demag = 0.0
        e_ani = 0.0
        e_dmi = 0.0

    class Value:
        value = "fem"

    class Result:
        status = "ok"
        backend = Value()
        mode = Value()
        precision = Value()
        steps = [Step()]

    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    bench.emit_summary(Result(), mesh_path, 1, 2e-13, "exchange_only", "rk4", "adaptive")

    output = capsys.readouterr().out.strip()
    assert output.startswith("BENCHMARK_RESULT=")
    payload = json.loads(output.split("=", 1)[1])
    assert payload["integrator"] == "rk4"
    assert payload["timestep_policy"] == "adaptive"
    assert payload["final_solver_dt_s"] == 1e-13
    assert payload["error_estimate"] == 0.25
    assert payload["dt_suggested_s"] == 2e-13
    assert payload["rhs_evals"] == 5


def test_emit_summary_includes_demag_phase_timing_fields(capsys):
    bench = load_benchmark_module()

    class Step:
        time = 2e-13
        e_total = 1.0
        e_ex = 0.25
        e_demag = 0.1
        wall_time_ns = 31
        exchange_wall_time_ns = 2
        demag_wall_time_ns = 29
        demag_assemble_wall_time_ns = 3
        demag_solve_wall_time_ns = 5
        demag_recover_wall_time_ns = 7
        demag_energy_wall_time_ns = 11
        rhs_wall_time_ns = 13
        extra_energy_wall_time_ns = 17
        snapshot_wall_time_ns = 19
        rhs_evals = 5
        demag_solves = 1
        rejected_attempts = 0
        fsal_reused = False
        max_dm_dt = 4.0
        max_h_eff = 5.0
        max_h_demag = 6.0
        e_ani = 0.0
        e_dmi = 0.0

    class Value:
        value = "fem"

    class Result:
        status = "ok"
        backend = Value()
        mode = Value()
        precision = Value()
        steps = [Step()]

    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    bench.emit_summary(Result(), mesh_path, 1, 2e-13, "exchange_demag", "heun")

    payload = json.loads(capsys.readouterr().out.strip().split("=", 1)[1])
    assert payload["demag_assemble_wall_time_ns"] == 3
    assert payload["demag_solve_wall_time_ns"] == 5
    assert payload["demag_recover_wall_time_ns"] == 7
    assert payload["demag_energy_wall_time_ns"] == 11


def test_preflight_finds_mfem_config_from_mfem_dir(tmp_path):
    bench = load_analysis_benchmark_module()
    mfem_prefix = tmp_path / "mfem"
    config_path = mfem_prefix / "lib" / "cmake" / "mfem" / "MFEMConfig.cmake"
    config_path.parent.mkdir(parents=True)
    config_path.write_text("# test mfem config\n", encoding="utf-8")

    report = bench.build_preflight_report({"MFEM_DIR": str(mfem_prefix)})

    assert report["status"] == "ok_mfem_config"
    assert report["mfem_config_path"] == str(config_path)
    assert bench.is_mfem_stack_ready(report)


def test_resolve_backends_accepts_cpu_only():
    bench = load_analysis_benchmark_module()

    assert bench.resolve_backends("cpu") == ["fem_cpu"]
    assert bench.resolve_backends("fem_cpu,gpu") == ["fem_cpu", "fem_gpu"]


def test_resolve_backends_rejects_unknown_backend():
    bench = load_analysis_benchmark_module()

    try:
        bench.resolve_backends("cpu,tpu")
    except ValueError as exc:
        assert "unsupported benchmark backend" in str(exc)
    else:
        raise AssertionError("resolve_backends should reject unknown backends")


def test_positive_int_arg_rejects_zero_gmsh_threads():
    bench = load_analysis_benchmark_module()

    try:
        bench.positive_int_arg("0")
    except bench.argparse.ArgumentTypeError as exc:
        assert ">= 1" in str(exc)
    else:
        raise AssertionError("positive_int_arg should reject zero")


def test_resolve_thread_count_specs_accepts_phase10_tokens():
    bench = load_analysis_benchmark_module()

    specs = bench.resolve_thread_count_specs(
        "1,physical_cores/2,physical_cores,auto",
        detected_physical_cores=8,
    )

    assert [(spec.label, spec.env_value) for spec in specs] == [
        ("1", "1"),
        ("physical_cores/2", "4"),
        ("physical_cores", "8"),
        ("auto", "auto"),
    ]


def test_positive_float_arg_rejects_zero_demag_residual_threshold():
    bench = load_analysis_benchmark_module()

    try:
        bench.positive_float_arg("0")
    except bench.argparse.ArgumentTypeError as exc:
        assert "> 0" in str(exc)
    else:
        raise AssertionError("positive_float_arg should reject zero")


def test_analysis_demag_policy_args_validate_known_values():
    bench = load_analysis_benchmark_module()

    assert bench.demag_solver_arg("gmres") == "GMRES"
    assert bench.demag_preconditioner_arg("jacobi") == "JACOBI"
    assert bench.nonnegative_int_arg("0") == 0
    assert bench.resolve_demag_solvers("cg,gmres,cg", "CG") == ["CG", "GMRES"]
    assert bench.resolve_demag_preconditioners("amg,jacobi,none", "AMG") == [
        "AMG",
        "JACOBI",
        "NONE",
    ]


def test_analysis_demag_policy_args_reject_unknown_values():
    bench = load_analysis_benchmark_module()

    for parser, value in (
        (bench.demag_solver_arg, "bicgstab"),
        (bench.demag_preconditioner_arg, "ilu"),
        (bench.nonnegative_int_arg, "-1"),
    ):
        try:
            parser(value)
        except bench.argparse.ArgumentTypeError:
            continue
        raise AssertionError(f"{parser.__name__} should reject {value!r}")


def test_phase10_analysis_accepts_medium_mesh_alias_and_scenario_names():
    bench = load_analysis_benchmark_module()

    assert bench.resolve_mesh_token("medium") == (
        REPO_ROOT / "examples" / "assets" / "bench_box_200x50x10nm.mesh.json"
    )
    assert bench.resolve_scenarios(
        "exchange_only,exchange_demag,exchange_anis_uniaxial,exchange_anis_cubic,"
        "exchange_demag_anis_uniaxial,exchange_demag_anis_cubic"
    ) == [
        "exchange_only",
        "exchange_demag",
        "exchange_anis_uniaxial",
        "exchange_anis_cubic",
        "exchange_demag_anis_uniaxial",
        "exchange_demag_anis_cubic",
    ]
    assert bench.row_is_fem_cpu_no_pbc_adaptive_scope(
        {
            "backend": "fem_cpu",
            "scenario": "exchange_demag_anis_uniaxial",
            "integrator": "rk23",
            "timestep_policy": "adaptive",
        }
    )
    assert bench.row_is_fem_cpu_no_pbc_adaptive_scope(
        {
            "backend": "fem_cpu",
            "scenario": "exchange_demag_anis_cubic",
            "integrator": "rk45",
            "timestep_policy": "adaptive",
        }
    )


def test_demag_policy_pairs_expand_only_demag_scenarios():
    bench = load_analysis_benchmark_module()

    assert bench.demag_policy_pairs_for_scenario(
        "exchange_demag_anisotropy",
        ["CG", "GMRES"],
        ["AMG", "JACOBI"],
    ) == [
        ("CG", "AMG"),
        ("CG", "JACOBI"),
        ("GMRES", "AMG"),
        ("GMRES", "JACOBI"),
    ]
    assert bench.demag_policy_pairs_for_scenario(
        "exchange_only",
        ["CG", "GMRES"],
        ["AMG", "JACOBI"],
    ) == [("CG", "AMG")]


def test_run_backend_carries_demag_phase_timing_from_payload(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout=json.dumps(
                {
                    "executed_steps": 2,
                    "final_time_s": 2e-13,
                    "demag_assemble_wall_time_ns": 3_000_000,
                    "demag_solve_wall_time_ns": 5_000_000,
                    "demag_recover_wall_time_ns": 7_000_000,
                    "demag_energy_wall_time_ns": 11_000_000,
                }
            ).join(("BENCHMARK_RESULT=", "\n")),
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["demag_assemble_wall_time_ms"] == 3.0
    assert row["demag_solve_wall_time_ms"] == 5.0
    assert row["demag_recover_wall_time_ms"] == 7.0
    assert row["demag_energy_wall_time_ms"] == 11.0


def test_run_backend_propagates_requested_gmsh_threads(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag",
        integrator="heun",
        steps=1,
        dt=1e-13,
        thread_spec=bench.ThreadCountSpec(label="physical_cores/2", env_value="4"),
        extra_env={
            "FULLMAG_FEM_EXECUTION": "cpu",
            "FULLMAG_GMSH_THREADS": "1",
            "FULLMAG_BENCH_DEMAG_SOLVER": "GMRES",
            "FULLMAG_BENCH_DEMAG_PRECONDITIONER": "JACOBI",
            "FULLMAG_BENCH_DEMAG_RTOL": "1e-6",
            "FULLMAG_BENCH_DEMAG_ATOL": "1e-12",
            "FULLMAG_BENCH_DEMAG_MAX_ITERATIONS": "75",
            "FULLMAG_BENCH_DEMAG_PRINT_LEVEL": "2",
        },
    )

    assert captured_env["FULLMAG_GMSH_THREADS"] == "1"
    assert captured_env["FULLMAG_CPU_THREADS"] == "4"
    assert captured_env["FULLMAG_BENCH_DEMAG_SOLVER"] == "GMRES"
    assert captured_env["FULLMAG_BENCH_DEMAG_PRECONDITIONER"] == "JACOBI"
    assert row["requested_gmsh_threads"] == "1"
    assert row["requested_cpu_thread_spec"] == "physical_cores/2"
    assert row["requested_cpu_threads"] == "4"
    assert row["requested_demag_solver"] == "GMRES"
    assert row["requested_demag_preconditioner"] == "JACOBI"
    assert row["requested_demag_relative_tolerance"] == "1e-6"
    assert row["requested_demag_absolute_tolerance"] == "1e-12"
    assert row["requested_demag_max_iterations"] == "75"
    assert row["requested_demag_print_level"] == "2"


def test_run_backend_defaults_fullmag_python_to_benchmark_interpreter(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    monkeypatch.delenv("FULLMAG_PYTHON", raising=False)
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={},
    )

    assert captured_env["FULLMAG_PYTHON"] == bench.sys.executable
    assert row["requested_fullmag_python"] == bench.sys.executable


def test_run_backend_missing_gpu_binary_still_reports_adaptive_acceptance_gate(tmp_path):
    bench = load_analysis_benchmark_module()
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=tmp_path / "missing-fullmag-fem-gpu",
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="rk45",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["status"] == "missing_binary"
    assert row["error"] == "GPU benchmark binary is missing"
    assert row["phase2_compute_assertion_enabled"] is True
    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert row["phase2_gate_reason"] == "gpu_binary=missing"
    assert row["adaptive_gpu_rk_acceptance_ready"] is False
    assert "nvcc" in row["adaptive_gpu_rk_acceptance_blockers"]


def test_run_backend_prefers_execution_plan_mesh_stats_from_metadata(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "input_magnetic_mesh",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_plan": {
                        "backend_plan": {
                            "kind": "fem",
                            "mesh_name": "study_domain",
                            "mesh": {
                                "nodes": [[0, 0, 0], [1, 0, 0]],
                                "elements": [[0, 1, 1, 1]],
                                "boundary_faces": [[0, 1, 1]],
                            },
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["mesh_name"] == "study_domain"
    assert row["node_count"] == 2
    assert row["element_count"] == 1
    assert row["boundary_face_count"] == 1
    assert row["solver_mesh_signature"]


def test_execution_plan_mesh_signature_changes_with_solver_mesh():
    bench = load_analysis_benchmark_module()
    first = {
        "execution_plan": {
            "backend_plan": {
                "kind": "fem",
                "mesh_name": "study_domain",
                "mesh": {
                    "nodes": [[0, 0, 0], [1, 0, 0]],
                    "elements": [[0, 1, 1, 1]],
                    "boundary_faces": [[0, 1, 1]],
                },
            }
        }
    }
    second = {
        "execution_plan": {
            "backend_plan": {
                "kind": "fem",
                "mesh_name": "study_domain",
                "mesh": {
                    "nodes": [[0, 0, 0], [2, 0, 0]],
                    "elements": [[0, 1, 1, 1]],
                    "boundary_faces": [[0, 1, 1]],
                },
            }
        }
    }

    first_stats = bench.execution_plan_mesh_stats(first)
    second_stats = bench.execution_plan_mesh_stats(second)

    assert first_stats["solver_mesh_signature"]
    assert second_stats["solver_mesh_signature"]
    assert first_stats["solver_mesh_signature"] != second_stats["solver_mesh_signature"]


def test_unstable_solver_mesh_groups_detects_repeated_case_drift():
    bench = load_analysis_benchmark_module()
    base_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "demag_relative_tolerance": 1e-6,
        "demag_absolute_tolerance": None,
        "demag_max_iterations": 100,
    }

    failures = bench.unstable_solver_mesh_groups(
        [
            {**base_row, "repeat_index": 0, "solver_mesh_signature": "mesh-a"},
            {**base_row, "repeat_index": 1, "solver_mesh_signature": "mesh-b"},
        ]
    )

    assert failures
    assert "exchange_demag_anisotropy" in failures[0]


def test_unstable_solver_mesh_groups_accepts_stable_repeats():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "demag_relative_tolerance": 1e-6,
        "demag_absolute_tolerance": None,
        "demag_max_iterations": 100,
        "solver_mesh_signature": "mesh-a",
    }

    assert bench.unstable_solver_mesh_groups([{**row, "repeat_index": 0}, {**row, "repeat_index": 1}]) == []


def test_benchmark_pass_fail_summary_groups_by_solver_mesh_signature():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "mesh_path": "coarse",
            "scenario": "exchange_demag",
            "integrator": "heun",
            "requested_cpu_thread_spec": "1",
            "solver_mesh_signature": "mesh-a",
            "status": "ok",
            "demag_final_residual_norm": 5e-9,
            "demag_actual_iterations": 8,
        },
        {
            "backend": "fem_cpu",
            "mesh_path": "coarse",
            "scenario": "exchange_demag",
            "integrator": "rk4",
            "requested_cpu_thread_spec": "auto",
            "solver_mesh_signature": "mesh-a",
            "status": "ok",
            "demag_final_residual_norm": 5e-7,
            "demag_actual_iterations": 8,
        },
        {
            "backend": "fem_cpu",
            "mesh_path": "medium",
            "scenario": "exchange_only",
            "integrator": "heun",
            "requested_cpu_thread_spec": "1",
            "solver_mesh_signature": "mesh-b",
            "status": "failed",
            "error_kind": "mpi_init_or_pmix_startup",
        },
    ]

    summary = bench.benchmark_pass_fail_summary(
        rows,
        gate_failures=["missing matrix row"],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert summary["status"] == "fail"
    assert summary["row_count"] == 3
    assert summary["ok_count"] == 2
    assert summary["failed_count"] == 1
    groups = {group["solver_mesh_signature"]: group for group in summary["solver_mesh_groups"]}
    assert groups["mesh-a"]["status"] == "fail"
    assert groups["mesh-a"]["row_count"] == 2
    assert groups["mesh-a"]["max_demag_final_residual_norm"] == 5e-7
    assert groups["mesh-a"]["thread_specs"] == ["1", "auto"]
    assert groups["mesh-b"]["status"] == "fail"
    assert groups["mesh-b"]["error_kinds"] == ["mpi_init_or_pmix_startup"]


def test_performance_regression_failures_detect_over_budget_identical_solver_mesh_signature():
    bench = load_analysis_benchmark_module()
    base_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anis_uniaxial",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_relative_tolerance": "1e-8",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "500",
        "requested_demag_print_level": "0",
        "solver_mesh_signature": "mesh-a",
        "status": "ok",
    }
    baseline = [
        {
            **base_row,
            "wall_time_ms": "100.0",
            "demag_solver_apply_wall_time_ms": "20.0",
        }
    ]
    current = [
        {
            **base_row,
            "wall_time_ms": 111.0,
            "demag_solver_apply_wall_time_ms": 21.0,
        },
        {
            **base_row,
            "solver_mesh_signature": "mesh-b",
            "wall_time_ms": 1000.0,
            "demag_solver_apply_wall_time_ms": 1000.0,
        },
    ]

    failures = bench.performance_regression_failures(
        current,
        baseline,
        max_regression_percent=10.0,
    )

    assert len(failures) == 1
    assert "wall_time_ms=111" in failures[0]
    assert "accepted baseline 100" in failures[0]
    assert "11.00%" in failures[0]
    assert "mesh-a" in failures[0]
    assert "mesh-b" not in failures[0]
    assert bench.comparable_baseline_case_count(current, baseline) == 1


def test_demag_convergence_failures_detect_residual_and_iteration_drift():
    bench = load_analysis_benchmark_module()
    base_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "demag_final_residual_norm": 5e-7,
        "demag_actual_iterations": 11,
    }

    failures = bench.demag_convergence_failures(
        [base_row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert len(failures) == 2
    assert "demag_final_residual_norm" in failures[0]
    assert "demag_actual_iterations" in failures[1]


def test_demag_convergence_failures_include_runtime_error_kind():
    bench = load_analysis_benchmark_module()

    failures = bench.demag_convergence_failures(
        [
            {
                "backend": "fem_cpu",
                "mesh_path": "coarse",
                "scenario": "exchange_demag_anisotropy",
                "integrator": "rk23",
                "timestep_policy": "adaptive",
                "status": "failed",
                "error_kind": "mpi_init_or_pmix_startup",
            }
        ],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert len(failures) == 1
    assert "mpi_init_or_pmix_startup" in failures[0]


def test_demag_convergence_failures_ignore_non_demag_scenarios():
    bench = load_analysis_benchmark_module()

    assert bench.demag_convergence_failures(
        [
            {
                "scenario": "exchange_only",
                "status": "ok",
            }
        ],
        max_residual=1e-8,
        max_iterations=1,
    ) == []


def test_demag_convergence_failures_accept_converged_demag_row():
    bench = load_analysis_benchmark_module()

    assert bench.demag_convergence_failures(
        [
            {
                "scenario": "exchange_demag",
                "status": "ok",
                "demag_final_residual_norm": "5e-9",
                "demag_actual_iterations": "6",
            }
        ],
        max_residual=1e-8,
        max_iterations=10,
    ) == []


def test_fem_cpu_no_pbc_adaptive_readiness_requires_scope_and_runtime_evidence():
    bench = load_analysis_benchmark_module()
    incomplete_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_recover_wall_time_ms": 1.0,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [incomplete_row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("periodic_boundary_pair_count" in failure for failure in failures)
    assert any("final_e_ex_j" in failure for failure in failures)
    assert any("final_e_demag_j" in failure for failure in failures)
    assert any("demag_solver_setup_wall_time_ms" in failure for failure in failures)
    assert any("demag_energy_wall_time_ms" in failure for failure in failures)
    assert any("demag_solver_setup_reused" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_accepts_complete_row():
    bench = load_analysis_benchmark_module()
    complete_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "reported_scenario": "exchange_demag_anisotropy",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "execution_engine": "fem_cpu_native",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ex_j": -2e-18,
        "final_e_demag_j": 3e-18,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    assert bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [complete_row],
        max_residual=1e-8,
        max_iterations=10,
    ) == []


def test_fem_cpu_no_pbc_adaptive_readiness_accepts_phase10_anisotropy_names():
    bench = load_analysis_benchmark_module()
    for scenario in ("exchange_demag_anis_uniaxial", "exchange_demag_anis_cubic"):
        complete_row = {
            "backend": "fem_cpu",
            "mesh_path": "medium",
            "scenario": scenario,
            "integrator": "rk23",
            "timestep_policy": "adaptive",
            "dt_s": 1e-13,
            "steps": 2,
            "status": "ok",
            "reported_precision": "double",
            "reported_scenario": scenario,
            "reported_integrator": "rk23",
            "reported_timestep_policy": "adaptive",
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "fem_data_residency": "host_source_of_truth",
            "uses_cuda_kernels": False,
            "uses_gpu_poisson": False,
            "demag_model": "airbox",
            "demag_boundary_variant": "robin",
            "domain_mesh_mode": "shared_domain_mesh_with_air",
            "solver_mesh_has_air": True,
            "periodic_boundary_pair_count": 0,
            "periodic_node_pair_count": 0,
            "executed_steps": 2,
            "final_solver_dt_s": 8e-14,
            "error_estimate": 0.5,
            "dt_suggested_s": 9e-14,
            "demag_solves": 6,
            "rhs_evals": 6,
            "final_e_ex_j": -2e-18,
            "final_e_demag_j": 3e-18,
            "final_e_ani_j": -1e-19,
            "demag_final_residual_norm": 5e-9,
            "demag_actual_iterations": 8,
            "demag_assemble_wall_time_ms": 2.0,
            "demag_solve_wall_time_ms": 5.0,
            "demag_solver_setup_wall_time_ms": 3.0,
            "demag_solver_apply_wall_time_ms": 4.0,
            "demag_solver_setup_reused": True,
            "demag_recover_wall_time_ms": 1.0,
            "demag_energy_wall_time_ms": 0.5,
        }

        assert bench.fem_cpu_no_pbc_adaptive_readiness_failures(
            [complete_row],
            max_residual=1e-8,
            max_iterations=10,
        ) == []


def test_fem_cpu_no_pbc_adaptive_readiness_requires_requested_matrix_coverage():
    bench = load_analysis_benchmark_module()
    only_one_case = {
        "backend": "fem_cpu",
        "mesh_path": "medium",
        "scenario": "exchange_demag_anis_uniaxial",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "requested_cpu_thread_spec": "1",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "reported_scenario": "exchange_demag_anis_uniaxial",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [only_one_case],
        max_residual=1e-8,
        max_iterations=10,
        required_mesh_paths={"medium", "coarse"},
        required_scenarios={"exchange_demag_anis_uniaxial", "exchange_demag_anis_cubic"},
        required_integrators={"rk23", "rk45"},
        required_thread_specs={"1", "auto"},
    )

    assert any(
        "mesh_path=coarse scenario=exchange_demag_anis_uniaxial integrator=rk23 thread_count=1"
        in failure
        for failure in failures
    )
    assert any(
        "mesh_path=medium scenario=exchange_demag_anis_cubic integrator=rk23 thread_count=1"
        in failure
        for failure in failures
    )
    assert any(
        "mesh_path=medium scenario=exchange_demag_anis_uniaxial integrator=rk45 thread_count=1"
        in failure
        for failure in failures
    )
    assert any(
        "mesh_path=medium scenario=exchange_demag_anis_uniaxial integrator=rk23 thread_count=auto"
        in failure
        for failure in failures
    )


def test_fem_cpu_no_pbc_adaptive_readiness_rejects_gpu_runtime_provenance():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "execution_engine": "fem_native_gpu",
        "fem_execution_mode": "hybrid_legacy_sparse",
        "mfem_device": "cuda",
        "fem_data_residency": "device_source_of_truth",
        "uses_cuda_kernels": True,
        "uses_gpu_poisson": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("execution_engine" in failure for failure in failures)
    assert any("fem_execution_mode" in failure for failure in failures)
    assert any("mfem_device" in failure for failure in failures)
    assert any("fem_data_residency" in failure for failure in failures)
    assert any("uses_cuda_kernels" in failure for failure in failures)
    assert any("uses_gpu_poisson" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_rejects_reported_case_mismatch():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag",
        "reported_integrator": "heun",
        "reported_timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "execution_engine": "fem_cpu_native",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("reported_scenario" in failure for failure in failures)
    assert any("reported_integrator" in failure for failure in failures)
    assert any("reported_timestep_policy" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_rejects_non_robin_or_no_air_mesh():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag_anisotropy",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "bem",
        "demag_boundary_variant": "dirichlet",
        "domain_mesh_mode": "merged_magnetic_mesh",
        "solver_mesh_has_air": False,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("demag_model" in failure for failure in failures)
    assert any("demag_boundary_variant" in failure for failure in failures)
    assert any("domain_mesh_mode" in failure for failure in failures)
    assert any("solver_mesh_has_air" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_rejects_short_completed_run():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag_anisotropy",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 1,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("executed_steps" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_requires_minimum_steps_or_torque_stop():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anis_uniaxial",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag_anis_uniaxial",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 50,
        "status": "ok",
        "reported_precision": "double",
        "execution_engine": "fem_cpu_native",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 50,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 150,
        "rhs_evals": 150,
        "final_e_ex_j": -2e-18,
        "final_e_demag_j": 3e-18,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
        min_qualified_steps=100,
    )

    assert any("minimum qualified steps=100" in failure for failure in failures)
    assert bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [{**row, "stop_reason": "torque"}],
        max_residual=1e-8,
        max_iterations=10,
        min_qualified_steps=100,
    ) == []


def test_fem_cpu_no_pbc_adaptive_readiness_requires_warm_solver_reuse_after_first_step():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag_anisotropy",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": False,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("demag_solver_setup_reused" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_rejects_frozen_demag_refresh():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag_anisotropy",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_refresh_interval_s": 1e-12,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 1,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("demag_refresh_interval_s" in failure for failure in failures)


def test_run_backend_maps_benchmark_e_ani_to_readiness_energy(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny_no_pbc",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
                "periodic_boundary_pairs": [],
                "periodic_node_pairs": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_plan": {
                        "backend_plan": {
                            "kind": "fem",
                            "mesh": {
                                "mesh_name": "shared_domain",
                                "nodes": [[0, 0, 0], [1, 0, 0]],
                                "elements": [[0, 1, 1, 1], [1, 0, 0, 0]],
                                "element_markers": [0, 1],
                                "boundary_faces": [],
                                "periodic_boundary_pairs": [],
                                "periodic_node_pairs": [],
                                "domain_mesh_mode": "shared_domain_mesh_with_air",
                            },
                        },
                    },
                    "execution_provenance": {
                        "execution_engine": "fem_cpu_native",
                        "fem_execution_mode": "cpu_native",
                        "mfem_device": "cpu",
                        "fem_data_residency": "host_source_of_truth",
                        "uses_cuda_kernels": False,
                        "uses_gpu_poisson": False,
                    },
                    "demag_runtime": {
                        "model": "airbox",
                        "boundary_variant": "robin",
                        "actual_iterations": 8,
                        "final_residual_norm": 5e-9,
                    },
                    "fem_cpu_relaxation_qualification": {
                        "stop_reason": "max_steps",
                        "final_torque_apm": 4e-4,
                        "final_torque_t": 5e-10,
                        "norm_defect": 1e-12,
                    },
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout=json.dumps(
                {
                    "status": "completed",
                    "precision": "double",
                    "executed_steps": 2,
                    "final_time_s": 2e-13,
                    "final_solver_dt_s": 8e-14,
                    "error_estimate": 0.5,
                    "dt_suggested_s": 9e-14,
                    "demag_solves": 6,
                    "rhs_evals": 6,
                    "final_e_ex_j": -2e-18,
                    "final_e_demag_j": 3e-18,
                    "e_ani": -1e-19,
                    "demag_assemble_wall_time_ns": 2_000_000,
                    "demag_solve_wall_time_ns": 5_000_000,
                    "demag_solver_setup_wall_time_ns": 3_000_000,
                    "demag_solver_apply_wall_time_ns": 4_000_000,
                    "demag_solver_setup_reused": True,
                    "demag_recover_wall_time_ns": 1_000_000,
                    "demag_energy_wall_time_ns": 500_000,
                },
                sort_keys=True,
            ).join(("BENCHMARK_RESULT=", "\n")),
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag_anisotropy",
        integrator="rk23",
        steps=2,
        dt=1e-13,
        timestep_policy="adaptive",
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["final_e_ani_j"] == -1e-19
    assert row["final_e_ex_j"] == -2e-18
    assert row["final_e_demag_j"] == 3e-18
    assert row["execution_engine"] == "fem_cpu_native"
    assert row["stop_reason"] == "max_steps"
    assert row["final_torque_apm"] == 4e-4
    assert row["final_torque_t"] == 5e-10
    assert row["norm_defect"] == 1e-12
    assert bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    ) == []


def test_run_backend_classifies_mpi_pmix_startup_failures(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny_no_pbc",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=1,
            stdout="",
            stderr="MPI_Init_thread failed: PMIx socket is unavailable",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag_anisotropy",
        integrator="rk23",
        steps=1,
        dt=1e-13,
        timestep_policy="adaptive",
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["status"] == "failed"
    assert row["error_kind"] == "mpi_init_or_pmix_startup"


def test_run_backend_classifies_missing_python_dependency(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny_no_pbc",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=1,
            stdout="",
            stderr="ModuleNotFoundError: No module named 'h5py'",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag_anisotropy",
        integrator="rk23",
        steps=1,
        dt=1e-13,
        timestep_policy="adaptive",
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["status"] == "failed"
    assert row["error_kind"] == "missing_python_dependency"


def test_best_demag_policy_rows_selects_fastest_converged_policy():
    bench = load_analysis_benchmark_module()
    base_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "solver_mesh_signature": "mesh-a",
        "requested_demag_relative_tolerance": "1e-6",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "100",
        "requested_demag_print_level": "0",
        "status": "ok",
    }

    summaries = bench.best_demag_policy_rows(
        [
            {
                **base_row,
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "AMG",
                "demag_solver_apply_wall_time_ms": 7.0,
                "demag_final_residual_norm": 5e-7,
                "demag_actual_iterations": 9,
            },
            {
                **base_row,
                "requested_demag_solver": "GMRES",
                "requested_demag_preconditioner": "JACOBI",
                "demag_solver_apply_wall_time_ms": 4.0,
                "demag_final_residual_norm": 8e-7,
                "demag_actual_iterations": 12,
            },
            {
                **base_row,
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "NONE",
                "demag_solver_apply_wall_time_ms": 1.0,
                "demag_final_residual_norm": 2e-5,
                "demag_actual_iterations": 3,
            },
        ],
        max_residual=1e-6,
        max_iterations=20,
    )

    assert len(summaries) == 1
    assert summaries[0]["demag_solver"] == "GMRES"
    assert summaries[0]["demag_preconditioner"] == "JACOBI"
    assert summaries[0]["average_demag_timing_ms"] == 4.0


def test_best_demag_policy_failures_report_missing_converged_candidate():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "solver_mesh_signature": "mesh-a",
        "requested_demag_relative_tolerance": "1e-6",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "100",
        "requested_demag_print_level": "0",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "status": "ok",
        "demag_solver_apply_wall_time_ms": 7.0,
        "demag_final_residual_norm": 2e-5,
        "demag_actual_iterations": 9,
    }

    failures = bench.best_demag_policy_failures(
        [row],
        max_residual=1e-6,
        max_iterations=20,
    )

    assert len(failures) == 1
    assert "no converged demag policy" in failures[0]
    assert "exchange_demag_anisotropy" in failures[0]


def test_best_demag_policy_failures_include_runtime_error_kind():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "solver_mesh_signature": "mesh-a",
        "requested_demag_relative_tolerance": "1e-6",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "100",
        "requested_demag_print_level": "0",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "status": "failed",
        "error_kind": "mpi_init_or_pmix_startup",
    }

    failures = bench.best_demag_policy_failures(
        [row],
        max_residual=1e-6,
        max_iterations=20,
    )

    assert len(failures) == 1
    assert "mpi_init_or_pmix_startup" in failures[0]


def test_run_backend_loads_metadata_from_cli_artifact_dir(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "input_magnetic_mesh",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    (artifact_dir / "metadata.json").write_text(
        json.dumps(
            {
                "execution_plan": {
                    "backend_plan": {
                        "kind": "fem",
                        "mesh_name": "study_domain",
                        "mesh": {
                            "nodes": [[0, 0, 0], [1, 0, 0]],
                            "elements": [[0, 1, 1, 1]],
                            "boundary_faces": [[0, 1, 1]],
                        },
                    }
                },
                "demag_runtime": {
                    "linear_solver": "CG",
                    "preconditioner": "AMG",
                    "relative_tolerance": 1e-6,
                    "absolute_tolerance": 1e-12,
                    "max_iterations": 75,
                    "print_level": 2,
                    "timings_ns": {
                        "assemble": 3_000_000,
                        "solve": 5_000_000,
                        "solver_setup": 13_000_000,
                        "solver_apply": 17_000_000,
                        "recover": 7_000_000,
                        "energy": 11_000_000,
                    },
                    "solver_setup_reused": True,
                },
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout=f"""
fullmag workspace summary
- status: completed
- total_steps: 1
- final_time: 1.000000e-13 s
- artifact_dir: {artifact_dir}
""",
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["mesh_name"] == "study_domain"
    assert row["node_count"] == 2
    assert row["demag_assemble_wall_time_ms"] == 3.0
    assert row["demag_solve_wall_time_ms"] == 5.0
    assert row["demag_solver_setup_wall_time_ms"] == 13.0
    assert row["demag_solver_apply_wall_time_ms"] == 17.0
    assert row["demag_solver_setup_reused"] is True
    assert row["demag_recover_wall_time_ms"] == 7.0
    assert row["demag_energy_wall_time_ms"] == 11.0
    assert row["demag_linear_solver"] == "CG"
    assert row["demag_preconditioner"] == "AMG"
    assert row["demag_relative_tolerance"] == 1e-6
    assert row["demag_absolute_tolerance"] == 1e-12
    assert row["demag_max_iterations"] == 75
    assert row["demag_print_level"] == 2


def test_run_backend_accepts_null_demag_runtime_for_non_demag_scenarios(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "input_magnetic_mesh",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {"fem_assembly_mode": "legacy_sparse"},
                    "demag_runtime": None,
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_dmi",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["status"] == "ok"
    assert row["fem_assembly_mode"] == "legacy_sparse"


def test_parse_cli_workspace_summary_as_benchmark_payload():
    bench = load_analysis_benchmark_module()
    output = """
fullmag workspace summary
- status: completed
- total_steps: 2
- final_time: 2.000000e-13 s
- final_E_ex: -5.115751e-35 J
- final_E_demag: 0.000000e0 J
- final_E_ext: 0.000000e0 J
- final_E_ani: 1.250000e-24 J
- final_E_dmi: -3.500000e-24 J
- final_E_total: -5.115751e-35 J
"""

    payload = bench.parse_benchmark_result(output)

    assert payload["status"] == "completed"
    assert payload["executed_steps"] == 2
    assert payload["final_time_s"] == 2.0e-13
    assert payload["final_e_total_j"] == -5.115751e-35
    assert payload["final_e_ani_j"] == 1.25e-24
    assert payload["final_e_dmi_j"] == -3.5e-24


def test_cli_workspace_summary_prints_local_energy_terms():
    source = (REPO_ROOT / "crates" / "fullmag-cli" / "src" / "orchestrator.rs").read_text(
        encoding="utf-8"
    )
    function_start = source.index("fn print_script_summary(")
    function_end = source.index("fn refresh_problem_preview_state(", function_start)
    function_source = source[function_start:function_end]

    assert "final_E_ani" in function_source
    assert "final_E_dmi" in function_source


def test_run_backend_carries_gpu_state_provenance(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "fem_gpu_state_allocated": True,
                        "fem_gpu_state_node_count": 8,
                        "fem_gpu_state_dof_len": 24,
                        "fem_gpu_state_stage_count": 2,
                        "fem_gpu_state_device_bytes": 32768,
                        "fem_gpu_state_reduction_workspace_bytes": 512,
                        "hot_loop_exchange_host_sync_count": 2,
                        "hot_loop_compute_host_sync_count": 0,
                        "fem_gpu_rk_exchange_only_enabled": False,
                        "fem_gpu_rk_stage_count": 2,
                        "fem_gpu_rk_uses_cuda_kernels": False,
                        "fem_gpu_rk_allows_exchange_host_sync": False,
                        "fem_gpu_rk_stage_exchange_device_resident": False,
                        "fem_exchange_operator_mode": "unsupported",
                        "fem_gpu_rk_block_reason": "requires CUDA",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["fem_gpu_state_allocated"] is True
    assert row["fem_gpu_state_node_count"] == 8
    assert row["fem_gpu_state_dof_len"] == 24
    assert row["fem_gpu_state_stage_count"] == 2
    assert row["fem_gpu_state_device_bytes"] == 32768
    assert row["fem_gpu_state_reduction_workspace_bytes"] == 512
    assert row["hot_loop_exchange_host_sync_count"] == 2
    assert row["hot_loop_compute_host_sync_count"] == 0
    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert (
        row["phase2_gate_reason"]
        == "compute_hot_loop_host_sync_count=0;stage_exchange_device_resident=false;"
        "gpu_rk_block_reason=requires CUDA"
    )
    assert row["fem_gpu_rk_exchange_only_enabled"] is False
    assert row["fem_gpu_rk_stage_count"] == 2
    assert row["fem_gpu_rk_uses_cuda_kernels"] is False
    assert row["fem_gpu_rk_allows_exchange_host_sync"] is False
    assert row["fem_gpu_rk_stage_exchange_device_resident"] is False
    assert row["fem_exchange_operator_mode"] == "unsupported"
    assert row["fem_gpu_rk_block_reason"] == "requires CUDA"
    assert row["adaptive_gpu_rk_acceptance_ready"] is False
    assert "nvcc" in row["adaptive_gpu_rk_acceptance_blockers"]


def test_run_backend_serializes_adaptive_gpu_rk_acceptance_gate(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps({"execution_provenance": {"hot_loop_compute_host_sync_count": 0}}),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="rk45",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["adaptive_gpu_rk_acceptance_ready"] is False
    assert isinstance(row["adaptive_gpu_rk_acceptance_blockers"], str)
    assert "nvcc" in row["adaptive_gpu_rk_acceptance_blockers"]


def test_run_backend_flags_phase2_compute_hot_loop_sync_regression(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_exchange_host_sync_count": 1,
                        "hot_loop_compute_host_sync_count": 3,
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert (
        row["phase2_gate_reason"]
        == "compute_hot_loop_host_sync_count=3;stage_exchange_device_resident=false"
    )


def test_run_backend_preserves_gpu_rk_block_reason_when_compute_sync_is_missing(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "fem_gpu_rk_stage_exchange_device_resident": False,
                        "fem_gpu_rk_block_reason": "requires captured legacy sparse exchange metadata",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert (
        row["phase2_gate_reason"]
        == "compute_hot_loop_host_sync_count=missing;"
        "gpu_rk_block_reason=requires captured legacy sparse exchange metadata"
    )


def test_run_backend_marks_failed_gpu_run_without_phase2_provenance(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=1,
            stdout="",
            stderr="native FEM GPU backend is not available",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["status"] == "failed"
    assert "native FEM GPU backend is not available" in row["error"]
    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert row["phase2_gate_reason"] == "run_failed_before_phase2_provenance"


def test_truncate_error_preserves_tail_for_failed_acceptance_diagnostics():
    bench = load_analysis_benchmark_module()
    message = "prefix " + ("x" * 800) + " fallback_reason=all_in_gpu_contract_unmet"

    truncated = bench.truncate_error(message, limit=160)

    assert len(truncated) <= 160
    assert "prefix" in truncated
    assert "fallback_reason=all_in_gpu_contract_unmet" in truncated


def test_run_backend_passes_phase2_gate_only_when_stage_exchange_is_device_resident(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_compute_host_sync_count": 0,
                        "fem_gpu_rk_stage_exchange_device_resident": True,
                        "fem_exchange_operator_mode": "legacy_sparse_gpu",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["phase2_compute_hot_loop_sync_clean"] is True
    assert (
        row["phase2_gate_reason"]
        == "compute_hot_loop_host_sync_count=0;stage_exchange_device_resident=true"
    )


def test_run_backend_rejects_phase2_gate_when_exchange_operator_mode_is_unsupported(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_compute_host_sync_count": 0,
                        "fem_gpu_rk_stage_exchange_device_resident": True,
                        "fem_exchange_operator_mode": "unsupported",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert row["phase2_gate_reason"] == "exchange_operator_mode=unsupported"


def test_run_backend_flags_inconsistent_gpu_rk_enabled_without_device_stage_exchange(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_compute_host_sync_count": 0,
                        "fem_gpu_rk_exchange_only_enabled": True,
                        "fem_gpu_rk_stage_exchange_device_resident": False,
                        "fem_gpu_rk_block_reason": "stage H_ex device-resident exchange requires CUDA runtime support",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert (
        row["phase2_gate_reason"]
        == "runtime_contract_violation=exchange_only_enabled_without_stage_exchange_device_resident;"
        "gpu_rk_block_reason=stage H_ex device-resident exchange requires CUDA runtime support"
    )


def test_run_backend_does_not_pass_phase2_gate_when_assertion_is_disabled(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_compute_host_sync_count": 0,
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC": "0"},
    )

    assert row["phase2_compute_assertion_enabled"] is False
    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert row["phase2_gate_reason"] == "compute_hot_loop_assertion=disabled"


def test_run_backend_enables_phase2_compute_sync_assertion_for_gpu_exchange_only(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={},
    )

    assert captured_env["FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC"] == "1"
    assert row["phase2_compute_assertion_enabled"] is True


def test_run_backend_phase2_compute_sync_assertion_overrides_inherited_env(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC", "0")
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={},
    )

    assert captured_env["FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC"] == "1"
    assert row["phase2_compute_assertion_enabled"] is True


def test_gpu_rk_cuda_source_contains_kernel_call_sites():
    assert GPU_RK_CU_PATH.is_file()
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    assert "fullmag_cuda_llg_rhs_fused(" in source
    assert "fullmag_cuda_normalize_vectors(" in source
    assert "fullmag_cuda_accumulate_heff(" in source
    assert "fullmag_cuda_device_max(" in source
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    assert "src/gpu_rk.cu" in cmake


def test_gpu_rk_step_surface_has_no_hot_loop_aos_transfer_calls():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_exchange_only_step(")
    function_end = source.index("bool gpu_rk_finalize_step_stats(", function_start)
    function_source = source[function_start:function_end]

    assert "upload_aos_to_soa(" not in function_source
    assert "download_soa_to_aos(" not in function_source
    assert "record_host_to_device(" not in function_source
    assert "record_device_to_host(" not in function_source


def test_gpu_rk_step_surface_has_no_compute_side_stream_synchronization():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_exchange_only_step(")
    function_end = source.index("bool gpu_rk_finalize_step_stats(", function_start)
    function_source = source[function_start:function_end]

    assert "cudaStreamSynchronize" not in function_source
    assert "cudaPeekAtLastError" not in function_source
    assert "cuda_launch_ok(" in function_source


def test_gpu_rk_step_promotes_clean_device_copy_without_hot_loop_transfer():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_exchange_only_step(")
    function_end = source.index("bool gpu_rk_finalize_step_stats(", function_start)
    function_source = source[function_start:function_end]

    assert "FemGpuSyncState::DeviceClean" in function_source
    assert "FemGpuSyncState::HostClean" in function_source
    assert "FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH" in function_source
    assert "gpu_state_upload_magnetization_aos(" not in function_source


def test_gpu_rk_uses_preallocated_device_reduction_workspace():
    gpu_rk_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = gpu_rk_source.index("bool gpu_rk_exchange_only_step(")
    function_end = gpu_rk_source.index("\n} // namespace fullmag::fem", function_start)
    function_source = gpu_rk_source[function_start:function_end]
    gpu_state_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "gpu_state.hpp"
    ).read_text(encoding="utf-8")
    gpu_state_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "gpu_state.cpp"
    ).read_text(encoding="utf-8")

    assert "scalar_reduce_temp_storage" in gpu_state_header
    assert "scalar_reduce_temp_storage_bytes" in gpu_state_header
    assert "fullmag_cuda_device_max(" in gpu_state_source
    assert "allocate_bytes(\n            &state.scalar_reduce_temp_storage" in gpu_state_source
    assert "gpu.scalar_reduce_temp_storage" in function_source
    assert "gpu.scalar_reduce_temp_storage_bytes" in function_source
    assert "nullptr,\n        reduce_bytes" not in function_source


def test_gpu_state_uploads_effective_fields_outside_hot_loop():
    gpu_state_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "gpu_state.hpp"
    ).read_text(encoding="utf-8")
    gpu_state_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "gpu_state.cpp"
    ).read_text(encoding="utf-8")
    context_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "context.cpp"
    ).read_text(encoding="utf-8")

    assert "gpu_state_upload_effective_fields_aos" in gpu_state_header
    assert "gpu_state_upload_effective_fields_aos" in gpu_state_source
    assert "state.h_ex" in gpu_state_source
    assert "state.h_demag" in gpu_state_source
    assert "state.h_ext" in gpu_state_source
    assert "state.h_eff" in gpu_state_source
    assert "gpu_state_upload_effective_fields_aos(" in context_source


def test_gpu_state_uploads_local_vector_fields_outside_hot_loop():
    gpu_state_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "gpu_state.hpp"
    ).read_text(encoding="utf-8")
    gpu_state_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "gpu_state.cpp"
    ).read_text(encoding="utf-8")
    context_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "context.cpp"
    ).read_text(encoding="utf-8")

    assert "gpu_state_upload_local_vector_fields_aos" in gpu_state_header
    assert "gpu_state_upload_local_vector_fields_aos" in gpu_state_source
    for member in (
        "state.h_ani",
        "state.h_cubic_ani",
        "state.h_dmi",
        "state.h_bulk_dmi",
        "state.h_oe",
        "state.h_therm",
        "state.h_mel",
    ):
        assert member in gpu_state_source
    for context_member in (
        "ctx.h_ani_xyz.data()",
        "ctx.h_cubic_ani_xyz.data()",
        "ctx.h_dmi_xyz.data()",
        "ctx.h_bulk_dmi_xyz.data()",
        "ctx.h_oe_xyz.data()",
        "ctx.h_therm_xyz.data()",
        "ctx.h_mel_xyz.data()",
    ):
        assert context_member in context_source


def test_gpu_state_uploads_runtime_coefficients_outside_hot_loop():
    gpu_state_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "gpu_state.hpp"
    ).read_text(encoding="utf-8")
    gpu_state_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "gpu_state.cpp"
    ).read_text(encoding="utf-8")
    context_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "context.cpp"
    ).read_text(encoding="utf-8")

    assert "gpu_state_upload_runtime_coefficients" in gpu_state_header
    assert "gpu_state_upload_runtime_coefficients" in gpu_state_source
    for member in (
        "state.node_volumes",
        "state.ms",
        "state.a",
        "state.alpha",
        "state.ku",
        "state.ku2",
        "state.dind",
        "state.dbulk",
        "state.kc1",
        "state.kc2",
        "state.kc3",
        "state.magnetic_node_mask",
        "state.periodic_reduced_node",
        "state.periodic_representative_nodes",
        "state.runtime_coefficients_uploaded",
    ):
        assert member in gpu_state_source
    for context_member in (
        "ctx.Ku_field.data()",
        "ctx.Ku2_field.data()",
        "ctx.Dind_field.data()",
        "ctx.Dbulk_field.data()",
        "ctx.Kc1_field.data()",
        "ctx.Kc2_field.data()",
        "ctx.Kc3_field.data()",
    ):
        assert context_member in context_source
    assert "gpu_state_upload_runtime_coefficients(" in context_source


def test_legacy_sparse_exchange_csr_upload_is_wired_before_gpu_exchange_plan_can_pass():
    gpu_state_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "gpu_state.hpp"
    ).read_text(encoding="utf-8")
    gpu_state_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "gpu_state.cpp"
    ).read_text(encoding="utf-8")
    mfem_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "mfem_bridge.cpp"
    ).read_text(encoding="utf-8")
    context_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "context.cpp"
    ).read_text(encoding="utf-8")
    exchange_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "gpu_exchange.cpp"
    ).read_text(encoding="utf-8")

    assert "gpu_state_upload_exchange_legacy_sparse" in gpu_state_header
    assert "gpu_state_upload_exchange_legacy_sparse" in gpu_state_source
    for member in (
        "exchange_csr_row_offsets",
        "exchange_csr_col_indices",
        "exchange_csr_values",
        "exchange_lumped_mass",
        "exchange_inv_lumped_mass",
        "exchange_legacy_sparse_device_bytes",
        "exchange_legacy_sparse_uploaded = true",
    ):
        assert member in gpu_state_source
    assert "state.device_bytes -= previous_device_bytes" in gpu_state_source
    assert "upload_legacy_sparse_exchange_to_gpu_state(" in mfem_source
    assert "exchange_form->SpMat()" in mfem_source
    assert "gpu_state_upload_exchange_legacy_sparse(" in mfem_source
    assert "context_upload_mfem_exchange_to_gpu_state(" in mfem_source
    assert "context_upload_mfem_exchange_to_gpu_state(" in context_source
    assert "ctx.gpu_state.exchange_legacy_sparse_uploaded" in exchange_source


def test_legacy_sparse_exchange_upload_runs_after_gpu_state_allocation():
    context_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "context.cpp"
    ).read_text(encoding="utf-8")
    mfem_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "mfem_bridge.cpp"
    ).read_text(encoding="utf-8")

    init_start = context_source.index("bool context_from_plan(")
    init_source = context_source[init_start:]
    gpu_initialize = init_source.index("gpu_state_initialize(")
    coefficient_upload = init_source.index("gpu_state_upload_runtime_coefficients(")
    exchange_upload = init_source.index("context_upload_mfem_exchange_to_gpu_state(")

    assert gpu_initialize < coefficient_upload < exchange_upload

    mfem_init_start = mfem_source.index("bool context_initialize_mfem(")
    mfem_init_end = mfem_source.index(
        "bool context_upload_mfem_exchange_to_gpu_state(",
        mfem_init_start,
    )
    mfem_init_source = mfem_source[mfem_init_start:mfem_init_end]

    assert "gpu_state_upload_exchange_legacy_sparse(" not in mfem_init_source


def test_gpu_exchange_plan_enables_only_after_device_sparse_exchange_is_ready():
    exchange_source = GPU_EXCHANGE_CPP_PATH.read_text(encoding="utf-8")

    assert "ctx.use_consistent_mass" in exchange_source
    assert "ctx.periodic_reduced_node.empty()" in exchange_source
    assert "ctx.gpu_state.runtime_coefficients_uploaded" in exchange_source
    assert "ctx.gpu_state.exchange_legacy_sparse_uploaded" in exchange_source
    assert "plan.stage_exchange_device_resident = true" in exchange_source
    assert "plan.operator_mode = \"legacy_sparse_gpu\"" in exchange_source


def test_gpu_rk_plan_supports_per_node_damping_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    assert "per-node damping yet" not in rk_source
    assert "ctx.material.damping" in cuda_source
    assert "gpu.alpha" in cuda_source
    assert "!ctx.alpha_field.empty()" in cuda_source
    assert "const fem_real_t *alpha_field" in kernel_header
    assert "bool use_alpha_field" in kernel_header
    assert "use_alpha_field ? alpha_field[i] : uniform_alpha" in kernel_source


def test_gpu_rk_plan_supports_heun_and_rk4_fixed_step_integrators():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")

    assert "ctx.integrator != FULLMAG_FEM_INTEGRATOR_HEUN" not in rk_source
    assert "FULLMAG_FEM_INTEGRATOR_RK4" in rk_source
    assert "GPU RK exchange-only path currently supports Heun, RK4, RK23, and RK45 only" in rk_source
    assert "rk4_accept_kernel" in cuda_source
    assert "stats.rhs_evaluations = total_stage_rhs_evaluations + 1" in cuda_source


def test_gpu_rk_plan_supports_uniform_external_field_energy_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    assert "does not support external field energy yet" not in rk_source
    assert "fullmag_cuda_external_energy_blocks" in kernel_header
    assert "external_energy_blocks_kernel" in kernel_source
    assert "-kMu0 * ms[i] * mdoth * lumped_mass[i]" in kernel_source
    assert "fullmag_cuda_external_energy_blocks(" in cuda_source
    assert "launch GPU RK external energy reduction" in cuda_source
    assert "stats.external_energy_joules = external_energy" in cuda_source
    assert "stats.total_energy_joules =" in cuda_source
    assert "exchange_energy + external_energy" in cuda_source


def test_gpu_rk_plan_supports_uniaxial_anisotropy_field_and_energy_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    assert "ctx.enable_anisotropy" not in rk_source
    assert "does not support anisotropy yet" not in rk_source
    assert "fullmag_cuda_uniaxial_anisotropy_field_energy_blocks" in kernel_header
    assert "uniaxial_anisotropy_field_energy_blocks_kernel" in kernel_source
    assert "2.0 * ku_i / (kMu0 * ms_i)" in kernel_source
    assert "4.0 * ku2_i / (kMu0 * ms_i)" in kernel_source
    assert "fullmag_cuda_add_field_inplace" in kernel_header
    assert "fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(" in cuda_source
    assert "launch GPU RK uniaxial anisotropy h_eff accumulation" in cuda_source
    assert "launch GPU RK uniaxial anisotropy energy reduction" in cuda_source
    assert "stats.anisotropy_energy_joules = anisotropy_energy" in cuda_source
    assert (
        "exchange_energy + external_energy + anisotropy_energy"
        in cuda_source
    )


def test_gpu_rk_plan_supports_cubic_anisotropy_field_and_energy_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    assert "ctx.enable_cubic_anisotropy" not in rk_source
    assert "does not support cubic anisotropy yet" not in rk_source
    assert "fullmag_cuda_cubic_anisotropy_field_energy_blocks" in kernel_header
    assert "cubic_anisotropy_field_energy_blocks_kernel" in kernel_source
    assert "const double pf1 = -2.0 * kc1_i * inv_mu0_ms" in kernel_source
    assert "const double pf2 = -2.0 * kc2_i * inv_mu0_ms" in kernel_source
    assert "const double pf3 = -4.0 * kc3_i * inv_mu0_ms" in kernel_source
    assert "kc1_i * sigma + kc2_i * m1sq * m2sq * m3sq + kc3_i * sigma * sigma" in kernel_source
    assert "fullmag_cuda_cubic_anisotropy_field_energy_blocks(" in cuda_source
    assert "launch GPU RK cubic anisotropy h_eff accumulation" in cuda_source
    assert "launch GPU RK cubic anisotropy energy reduction" in cuda_source
    assert "cubic_anisotropy_energy" in cuda_source
    assert "anisotropy_energy + cubic_anisotropy_energy" in cuda_source


def test_gpu_rk_plan_supports_precomputed_oersted_field_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    assert "does not support Oersted field yet" not in rk_source
    assert "requires precomputed Oersted field data" in rk_source
    assert "fullmag_cuda_add_scaled_field_inplace" in kernel_header
    assert "add_scaled_field_inplace_kernel" in kernel_source
    assert "scale * h_add[i]" in kernel_source
    assert "double oersted_scale(const Context &ctx)" in cuda_source
    assert "ctx.oersted_time_dep_kind" in cuda_source
    assert "fullmag_cuda_add_scaled_field_inplace(gpu.h_oe.x" in cuda_source
    assert "launch GPU RK Oersted h_eff accumulation" in cuda_source


def test_gpu_rk_plan_supports_magnetoelastic_field_and_energy_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    context_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "context.cpp"
    ).read_text(encoding="utf-8")
    state_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "gpu_state.hpp"
    ).read_text(encoding="utf-8")
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    assert "does not support magnetoelastic field yet" not in rk_source
    assert "requires 6 magnetoelastic strain Voigt values per node" in rk_source
    assert "requires device-resident per-node magnetoelastic strain" in rk_source
    assert "requires magnetoelastic strain data" in rk_source
    assert "double *mel_strain_voigt" in state_header
    assert "bool mel_strain_uploaded" in state_header
    assert "gpu_state_upload_magnetoelastic_strain" in context_source
    assert "fullmag_cuda_magnetoelastic_field_energy_blocks" in kernel_header
    assert "magnetoelastic_field_energy_blocks_kernel" in kernel_source
    assert "per_node_strain_voigt + static_cast<size_t>(i) * 6u" in kernel_source
    assert "inv_mu0_ms = -1.0 / (kMu0 * ms_i)" in kernel_source
    assert "2.0 * b1 * lmx * e11" in kernel_source
    assert "energy_density * lumped_mass[i]" in kernel_source
    assert "fullmag_cuda_magnetoelastic_field_energy_blocks(" in cuda_source
    assert "use_per_node_strain ? gpu.mel_strain_voigt : nullptr" in cuda_source
    assert "launch GPU RK magnetoelastic h_eff accumulation" in cuda_source
    assert "launch GPU RK magnetoelastic energy reduction" in cuda_source
    assert "stats.magnetoelastic_energy_joules = magnetoelastic_energy" in cuda_source
    assert "magnetoelastic_energy" in cuda_source


def test_gpu_rk_plan_supports_slonczewski_stt_rhs_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    assert "does not support Slonczewski STT yet" not in rk_source
    assert "gpu_rk_resolve_slonczewski_thickness" in rk_source
    assert "requires explicit or geometry-derived Slonczewski free-layer thickness" in rk_source
    assert "fullmag_cuda_add_slonczewski_stt_rhs" in kernel_header
    assert "slonczewski_stt_rhs_kernel" in kernel_source
    assert "kHbar = 1.054571817e-34" in kernel_source
    assert "kElectronCharge = 1.60217662e-19" in kernel_source
    assert "current_density_magnitude(ctx)" in cuda_source
    assert "slonczewski_thickness" in cuda_source
    assert "ctx.stt_spin_polarization[0]" in cuda_source
    assert "launch GPU RK Slonczewski STT RHS" in cuda_source


def test_gpu_rk_plan_supports_rk23_adaptive_retry_scaffold():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")

    assert "FULLMAG_FEM_INTEGRATOR_RK23_BS" in rk_source
    assert "adaptive RK23/RK45" not in rk_source
    assert "GPU RK exchange-only path currently supports Heun, RK4, RK23, and RK45 only" in rk_source
    assert "bs23_accept_kernel" in cuda_source
    assert "is_rk23" in cuda_source
    assert "compute_adaptive_error_norm_device(" in cuda_source
    assert "restore_adaptive_reject_magnetization_device(" in cuda_source
    assert "stats.rhs_evaluations = total_stage_rhs_evaluations + 1" in cuda_source


def test_gpu_rk_plan_supports_rk45_adaptive_retry_scaffold():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    mfem_source = MFEM_BRIDGE_CPP_PATH.read_text(encoding="utf-8")

    assert "FULLMAG_FEM_INTEGRATOR_RK45_DP54" in rk_source
    assert "GPU RK exchange-only path currently supports Heun, RK4, RK23, and RK45 only" in rk_source
    assert "adaptive RK23/RK45" not in rk_source
    assert "dp54_accept_kernel" in cuda_source
    assert "is_rk45" in cuda_source
    assert "gpu_adaptive_pi_step(ctx, error_estimate)" in cuda_source
    assert "stats.rhs_evaluations = total_stage_rhs_evaluations + 1" in cuda_source

    function_start = mfem_source.index("bool context_step_explicit_rk_mfem(")
    function_end = mfem_source.index("\n} // namespace fullmag::fem", function_start)
    function_source = mfem_source[function_start:function_end]
    assert "FULLMAG_FEM_INTEGRATOR_RK45_DP54" in function_source
    assert "!ctx.adaptive_dt_enabled" not in function_source[
        function_source.index("if ((ctx.integrator == FULLMAG_FEM_INTEGRATOR_HEUN") :
        function_source.index("const bool adaptive =")
    ]
    assert "tab.stages == 7" in function_source


def test_gpu_rk_plan_enables_only_from_exchange_plan_stage_residency():
    source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_branch_start = source.index("#if FULLMAG_HAS_CUDA_RUNTIME")
    cuda_branch_end = source.index("#else", cuda_branch_start)
    cuda_branch = source[cuda_branch_start:cuda_branch_end]

    assert "plan.enabled = true" not in cuda_branch
    assert "stage H_ex is recomputed device-resident" in cuda_branch
    assert "gpu_exchange_plan_stage_exchange(ctx" in source


def test_mfem_exchange_path_marks_transfer_audit_exchange_interop_scope():
    source = MFEM_BRIDGE_CPP_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool compute_exchange_for_magnetization(")
    function_end = source.index(
        "bool compute_effective_fields_for_magnetization_impl(",
        function_start,
    )
    function_source = source[function_start:function_end]

    assert "TransferAuditScopeKind::ExchangeInterop" in function_source


def test_mfem_exchange_stage_path_still_has_explicit_host_roundtrip_blocker():
    source = MFEM_BRIDGE_CPP_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool compute_exchange_for_magnetization(")
    function_end = source.index(
        "bool compute_effective_fields_for_magnetization_impl(",
        function_start,
    )
    function_source = source[function_start:function_end]

    assert "copy_host_vector_to_mfem(ctx.mfem_mx" in function_source
    assert "copy_host_vector_to_mfem(ctx.mfem_my" in function_source
    assert "copy_host_vector_to_mfem(ctx.mfem_mz" in function_source
    assert "pack_components_to_aos(" in function_source
    assert "gpu.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH" not in function_source


def test_gpu_rk_cuda_step_recomputes_exchange_for_each_heun_stage():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_exchange_only_step(")
    function_source = source[function_start:]
    helper_start = source.index("bool compute_rhs_for_magnetization(")
    helper_end = source.index("} // namespace", helper_start)
    helper_source = source[helper_start:helper_end]

    assert "fullmag_cuda_legacy_sparse_exchange(" in source
    assert "compute_legacy_sparse_exchange(ctx.gpu_state, m, stream, reason)" in helper_source
    assert function_source.count("compute_rhs_for_magnetization(") >= 2
    assert 'gpu.m,\n            gpu.error' in function_source
    assert "gpu.m_stage" in function_source
    assert "legacy_sparse_gpu" in function_source


def test_gpu_rk_cuda_step_refreshes_final_heff_after_accept():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_exchange_only_step(")
    function_end = source.index("bool gpu_rk_finalize_step_stats(", function_start)
    function_source = source[function_start:function_end]

    accept_index = function_source.index("launch GPU RK accept/normalize")
    final_rhs_call_index = function_source.index(
        "compute_rhs_for_magnetization(\n            ctx,\n            gpu.m",
        accept_index,
    )
    final_heff_label_index = function_source.index(
        "launch GPU RK final h_eff accumulation",
        final_rhs_call_index,
    )
    reduce_index = function_source.index("fullmag_cuda_device_max(", final_heff_label_index)

    assert accept_index < final_rhs_call_index < final_heff_label_index < reduce_index


def test_gpu_rk_cuda_step_recomputes_final_rhs_metric_after_final_heff_refresh():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_exchange_only_step(")
    function_end = source.index("bool gpu_rk_finalize_step_stats(", function_start)
    function_source = source[function_start:function_end]

    accept_index = function_source.index("launch GPU RK accept/normalize")
    final_rhs_call_index = function_source.index(
        "compute_rhs_for_magnetization(\n            ctx,\n            gpu.m",
        accept_index,
    )
    final_heff_label_index = function_source.index(
        "launch GPU RK final h_eff accumulation",
        final_rhs_call_index,
    )
    reduce_index = function_source.index("fullmag_cuda_device_max(", final_heff_label_index)

    assert "gpu.error,\n            stream" in function_source
    assert final_rhs_call_index < final_heff_label_index < reduce_index


def test_gpu_rk_rhs_evaluation_count_includes_final_rhs_metric():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_exchange_only_step(")
    function_end = source.index("bool gpu_rk_finalize_step_stats(", function_start)
    function_source = source[function_start:function_end]

    assert "stats.rhs_evaluations = total_stage_rhs_evaluations + 1" in function_source


def test_gpu_rk_reuses_fsal_stage_zero_without_host_sync():
    header_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "gpu_state.hpp"
    ).read_text(encoding="utf-8")
    state_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "gpu_state.cpp"
    ).read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = cuda_source.index("bool gpu_rk_exchange_only_step(")
    function_end = cuda_source.index("bool gpu_rk_finalize_step_stats(", function_start)
    function_source = cuda_source[function_start:function_end]

    assert "bool fsal_valid = false" in header_source
    assert "state.fsal_valid = false" in state_source
    assert "fsal_reused = fsal_method && gpu.fsal_valid" in function_source
    assert "if (!fsal_reused)" in function_source
    assert "copy_component_device(" in function_source
    assert "gpu.error" in function_source
    assert "gpu.k[0]" in function_source
    assert "cudaMemcpyDeviceToDevice" in cuda_source
    assert "stats.fsal_reused = fsal_reused ? 1 : 0" in function_source
    assert "stats.rhs_evaluations = total_stage_rhs_evaluations + 1" in function_source
    assert "cudaStreamSynchronize" not in function_source


def test_gpu_rk_keeps_device_backup_for_future_adaptive_reject_retry():
    header_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "gpu_state.hpp"
    ).read_text(encoding="utf-8")
    state_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "gpu_state.cpp"
    ).read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = cuda_source.index("bool gpu_rk_exchange_only_step(")
    function_end = cuda_source.index("bool gpu_rk_finalize_step_stats(", function_start)
    function_source = cuda_source[function_start:function_end]

    assert "FemGpuComponentField m_backup" in header_source
    assert "allocate_component(state.m_backup" in state_source
    assert "free_component(state.m_backup)" in state_source
    assert "copy_component_device(" in function_source
    assert "gpu.m" in function_source
    assert "gpu.m_backup" in function_source
    assert "GPU RK backup magnetization device copy" in function_source
    assert "cudaMemcpyDeviceToDevice" in cuda_source
    assert "cudaStreamSynchronize" not in function_source


def test_gpu_rk_has_device_restore_for_adaptive_reject_retry():
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")

    assert "restore_adaptive_reject_magnetization_device(" in cuda_source
    helper_source = cuda_source[
        cuda_source.index("restore_adaptive_reject_magnetization_device(") :
        cuda_source.index("bool compute_adaptive_error_norm_device(")
    ]

    assert "copy_component_device(" in helper_source
    assert "gpu.m_backup" in helper_source
    assert "gpu.m" in helper_source
    assert "GPU RK restore rejected adaptive magnetization device copy" in helper_source
    assert "gpu.fsal_valid = false" in helper_source
    assert "cudaStreamSynchronize" not in helper_source


def test_gpu_rk_has_adaptive_pi_decision_helper():
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")

    assert "struct GpuAdaptiveResult" in cuda_source
    assert "gpu_adaptive_pi_step(" in cuda_source
    helper_source = cuda_source[
        cuda_source.index("gpu_adaptive_pi_step(") :
        cuda_source.index("bool restore_adaptive_reject_magnetization_device(")
    ]

    assert "ctx.adaptive_dt_enabled" in helper_source
    assert "ctx.prev_error_norm" in helper_source
    assert "ctx.safety_factor" in helper_source
    assert "ctx.pi_alpha" in helper_source
    assert "ctx.pi_beta" in helper_source
    assert "ctx.dt_grow_max" in helper_source
    assert "ctx.dt_shrink_min" in helper_source
    assert "ctx.dt_max" in helper_source
    assert "ctx.dt_min" in helper_source
    assert "ctx.rejected_steps += 1" in helper_source
    assert "std::pow" in helper_source
    assert "return {true" in helper_source
    assert "return {false" in helper_source


def test_gpu_kernels_expose_device_adaptive_error_norm_blocks():
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    assert "fullmag_cuda_adaptive_error_norm_blocks" in kernel_header
    assert "adaptive_error_norm_blocks_kernel" in kernel_source
    assert "b_hi0" in kernel_source
    assert "b_lo0" in kernel_source
    assert "adaptive_atol" in kernel_source
    assert "adaptive_rtol" in kernel_source
    assert "fmax(fabs(old_m" in kernel_source
    assert "if (stages > 4)" in kernel_source
    assert "if (stages > 6)" in kernel_source
    assert "BlockReduce<double, 256>" in kernel_source


def test_gpu_kernels_use_double_atomic_add_compatibility_helper():
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")
    kernel_start = kernel_source.index("zhang_li_element_rhs_kernel(")
    kernel_end = kernel_source.index("__global__ void zhang_li_normalize_add_rhs_kernel", kernel_start)
    kernel_body = kernel_source[kernel_start:kernel_end]

    assert "atomic_add_double(double *address, double value)" in kernel_source
    assert "atomicCAS(" in kernel_source
    assert "atomicAdd(&work_" not in kernel_body
    assert "atomicAdd(&node_weight" not in kernel_body
    assert "atomic_add_double(&work_x[node]" in kernel_body
    assert "atomic_add_double(&node_weight[node]" in kernel_body


def test_gpu_rk_has_device_adaptive_error_norm_reduction_helper():
    gpu_rk_cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")

    assert "compute_adaptive_error_norm_device(" in gpu_rk_cuda_source
    helper_source = gpu_rk_cuda_source[
        gpu_rk_cuda_source.index("compute_adaptive_error_norm_device(") :
        gpu_rk_cuda_source.index("__global__ void euler_stage_kernel")
    ]
    assert "fullmag_cuda_adaptive_error_norm_blocks(" in helper_source
    assert "fullmag_cuda_device_max(" in helper_source
    assert "gpu.scalar_reduce_workspace" in helper_source
    assert "gpu.scalar_reduce_temp_storage" in helper_source
    assert "temp_storage=nullptr" not in helper_source
    assert "ctx.adaptive_atol" in helper_source
    assert "ctx.adaptive_rtol" in helper_source
    assert "read_scalar_result(" in helper_source
    assert "GPU RK adaptive error norm" in helper_source


def test_gpu_rk_step_contains_adaptive_retry_loop_scaffold():
    gpu_rk_cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = gpu_rk_cuda_source.index("bool gpu_rk_exchange_only_step(")
    function_end = gpu_rk_cuda_source.index("bool gpu_rk_finalize_step_stats(", function_start)
    function_source = gpu_rk_cuda_source[function_start:function_end]

    assert "const bool adaptive = tableau.order_est > 0 && ctx.adaptive_dt_enabled" in function_source
    assert "for (;;) {" in function_source
    assert "ctx.current_dt = active_dt" in function_source
    assert "compute_adaptive_error_norm_device(" in function_source
    assert "gpu_adaptive_pi_step(ctx, error_estimate)" in function_source
    assert "restore_adaptive_reject_magnetization_device(gpu, stream, reason)" in function_source
    assert "rejected_attempts += 1" in function_source
    assert "continue;" in function_source
    assert "stats.error_estimate = error_estimate" in function_source
    assert "stats.dt_suggested = suggested_dt" in function_source
    assert "stats.rejected_attempts = rejected_attempts" in function_source


def test_gpu_rk_scalar_stats_are_read_outside_hot_loop_scope():
    api_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "api.cpp"
    ).read_text(encoding="utf-8")
    gpu_rk_cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")

    step_start = api_source.index("int fullmag_fem_backend_step(")
    step_source = api_source[step_start:]
    hot_loop_start = step_source.index("TransferAuditScope hot_loop")
    hot_loop_end = step_source.index("if (ctx.transfer_audit.hot_loop_violation)")
    finalize = step_source.index("gpu_rk_finalize_step_stats(")

    assert hot_loop_start < hot_loop_end < finalize
    assert "stats.max_rhs_amplitude = 0.0" not in gpu_rk_cuda_source
    assert "cudaMemcpyAsync(" in gpu_rk_cuda_source
    assert "record_device_to_host(ctx.transfer_audit, sizeof(double))" in gpu_rk_cuda_source


def test_gpu_rk_finalize_step_stats_fills_exchange_only_device_metrics():
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")
    gpu_rk_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")

    assert "fullmag_cuda_legacy_sparse_exchange_energy_blocks" in kernel_header
    assert "fullmag_cuda_field_metric_blocks" in kernel_header
    assert "fullmag_cuda_device_sum" in kernel_header
    assert "legacy_sparse_exchange_energy_blocks_kernel" in kernel_source
    assert "field_metric_blocks_kernel" in kernel_source
    assert "fullmag_cuda_device_sum(" in gpu_rk_source
    assert "stats.exchange_energy_joules = exchange_energy" in gpu_rk_source
    assert "stats.external_energy_joules = external_energy" in gpu_rk_source
    assert "stats.anisotropy_energy_joules = anisotropy_energy + cubic_anisotropy_energy" in gpu_rk_source
    assert "stats.total_energy_joules =" in gpu_rk_source
    assert "exchange_energy + external_energy + anisotropy_energy + cubic_anisotropy_energy" in gpu_rk_source
    assert "stats.max_effective_field_amplitude = max_h_eff" in gpu_rk_source
    assert "stats.max_torque_Apm = max_torque" in gpu_rk_source
    assert "stats.demag_solve_count = 0" in gpu_rk_source
    assert "stats.demag_linear_iterations = 0" in gpu_rk_source
    assert "stats.demag_linear_residual = 0.0" in gpu_rk_source
    assert "stats.requested_omp_threads = ctx.requested_omp_threads" in gpu_rk_source
    assert "stats.effective_omp_threads = ctx.effective_omp_threads" in gpu_rk_source


def test_gpu_rk_finalize_step_stats_fills_average_magnetization_without_field_readback():
    c_header = (REPO_ROOT / "native" / "include" / "fullmag_fem.h").read_text(
        encoding="utf-8"
    )
    rust_ffi = (REPO_ROOT / "crates" / "fullmag-fem-sys" / "src" / "lib.rs").read_text(
        encoding="utf-8"
    )
    native_fem = (
        REPO_ROOT / "crates" / "fullmag-runner" / "src" / "native_fem.rs"
    ).read_text(encoding="utf-8")
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")
    mfem_source = MFEM_BRIDGE_CPP_PATH.read_text(encoding="utf-8")
    gpu_rk_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")

    for source in (c_header, rust_ffi):
        assert "double mx;" in source or "pub mx: f64" in source
        assert "double my;" in source or "pub my: f64" in source
        assert "double mz;" in source or "pub mz: f64" in source

    assert "stats.mx = average[0]" in mfem_source
    assert "stats.my = average[1]" in mfem_source
    assert "stats.mz = average[2]" in mfem_source
    assert "mx: stats.mx" in native_fem
    assert "my: stats.my" in native_fem
    assert "mz: stats.mz" in native_fem
    assert "fullmag_cuda_magnetization_sum_blocks" in kernel_header
    assert "magnetization_sum_blocks_kernel" in kernel_source
    assert "fullmag_cuda_magnetization_sum_blocks(" in gpu_rk_source
    assert "stats.mx = mx_sum / magnetic_count" in gpu_rk_source
    assert "stats.my = my_sum / magnetic_count" in gpu_rk_source
    assert "stats.mz = mz_sum / magnetic_count" in gpu_rk_source


def test_gpu_average_magnetization_matches_cpu_zero_vector_exclusion():
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    function_start = kernel_source.index("__global__ void magnetization_sum_blocks_kernel(")
    function_end = kernel_source.index("// ── C interface implementations", function_start)
    function_source = kernel_source[function_start:function_end]

    assert "fabs(local_x) > 1e-18 || fabs(local_y) > 1e-18 || fabs(local_z) > 1e-18" in function_source
    assert "local_count = nonzero ? 1.0 : 0.0" in function_source


def test_gpu_rk_finalize_updates_stage_completion_from_device_metrics():
    context_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "context.hpp"
    ).read_text(encoding="utf-8")
    mfem_source = MFEM_BRIDGE_CPP_PATH.read_text(encoding="utf-8")
    gpu_rk_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")

    assert "context_update_stage_completion_from_stats" in context_header
    assert "void context_update_stage_completion_from_stats(" in mfem_source
    assert "update_stage_completion_from_stats(ctx, stats)" in mfem_source
    assert "context_update_stage_completion_from_stats(ctx, stats)" in gpu_rk_source


def test_gpu_rk_step_records_nonzero_wall_time_before_early_return():
    source = MFEM_BRIDGE_CPP_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool context_step_explicit_rk_mfem(")
    function_source = source[function_start:]
    gpu_call = function_source.index("gpu_rk_exchange_only_step(")
    wall_time = function_source.index("stats.wall_time_ns = elapsed_ns(wall_start)", gpu_call)
    early_return = function_source.index("return true;", gpu_call)

    assert gpu_call < wall_time < early_return


def test_gpu_rk_plan_does_not_reject_external_field_after_gpu_energy_metric_support():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    gpu_rk_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")

    assert "ctx.has_external_field" not in rk_source
    assert "external field energy" not in rk_source
    assert "ctx.has_external_field" in gpu_rk_source
    assert "external_energy" in gpu_rk_source


def test_gpu_rk_plan_reports_specific_unsupported_term_reasons():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")

    assert "does not support DMI yet" not in rk_source
    assert "does not support bulk DMI yet" not in rk_source
    assert "requires device-resident mesh geometry for DMI" in rk_source
    assert "requires deterministic thermal seed for device thermal field" in rk_source
    assert "requires device-resident mesh geometry for Zhang-Li STT" in rk_source
    assert "local terms or torques" not in rk_source


def test_gpu_rk_plan_supports_dmi_with_device_mesh_geometry():
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    assert "fullmag_cuda_dmi_field_energy_serial" in kernel_header
    assert "dmi_field_energy_serial_kernel" in kernel_source
    assert "tetra_gradients_device" in kernel_source
    assert "bulk_mode" in kernel_source
    assert "inv_projection_mass = -1.0 / (kMu0 * ms_i * mass" in kernel_source
    assert "launch GPU RK interfacial DMI field" in cuda_source
    assert "launch GPU RK bulk DMI field" in cuda_source
    assert "launch GPU RK interfacial DMI h_eff accumulation" in cuda_source
    assert "launch GPU RK bulk DMI h_eff accumulation" in cuda_source
    assert "stats.dmi_energy_joules = dmi_energy + bulk_dmi_energy" in cuda_source


def test_gpu_rk_plan_supports_zhang_li_stt_with_device_mesh_geometry():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    state_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "gpu_state.hpp"
    ).read_text(encoding="utf-8")
    context_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "context.cpp"
    ).read_text(encoding="utf-8")
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    assert "does not support Zhang-Li STT yet" not in rk_source
    assert "mesh_geometry_uploaded" in rk_source
    assert "FemGpuComponentField zhang_li_rhs" in state_header
    assert "double *zhang_li_node_weight" in state_header
    assert "gpu_state_upload_mesh_geometry" in context_source
    assert "fullmag_cuda_add_zhang_li_stt_rhs" in kernel_header
    assert "zhang_li_element_rhs_kernel" in kernel_source
    assert "tetra_gradients_device" in kernel_source
    assert "zhang_li_normalize_add_rhs_kernel" in kernel_source
    assert "atomic_add_double(&work_x[node]" in kernel_source
    assert "atomicAdd(&work_x[node]" not in kernel_source
    assert "launch GPU RK Zhang-Li STT RHS" in cuda_source


def test_gpu_rk_plan_supports_deterministic_thermal_field_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    kernel_header = (
        REPO_ROOT / "native" / "backends" / "fem" / "include" / "kernels.h"
    ).read_text(encoding="utf-8")
    kernel_source = (
        REPO_ROOT / "native" / "backends" / "fem" / "src" / "kernels.cu"
    ).read_text(encoding="utf-8")

    assert "does not support thermal field yet" not in rk_source
    assert "ctx.thermal_seed == 0" in rk_source
    assert "fullmag_cuda_thermal_field_blocks" in kernel_header
    assert "thermal_field_blocks_kernel" in kernel_source
    assert "splitmix64_next" in kernel_source
    assert "deterministic_normal" in kernel_source
    assert "ctx.thermal_seed" in cuda_source
    assert "ctx.step_count" in cuda_source
    assert "launch GPU RK deterministic thermal field" in cuda_source
    assert "launch GPU RK thermal h_eff accumulation" in cuda_source


def test_snapshot_stats_syncs_device_source_magnetization_before_cpu_field_recompute():
    source = MFEM_BRIDGE_CPP_PATH.read_text(encoding="utf-8")

    refresh_start = source.index("bool context_refresh_exchange_field_mfem(")
    refresh_end = source.index("bool context_snapshot_stats_mfem(", refresh_start)
    refresh_source = source[refresh_start:refresh_end]
    snapshot_start = refresh_end
    snapshot_end = source.index("bool context_step_explicit_rk_mfem(", snapshot_start)
    snapshot_source = source[snapshot_start:snapshot_end]

    assert "context_sync_gpu_magnetization_to_host(ctx, error)" in refresh_source
    assert "context_sync_gpu_magnetization_to_host(ctx, error)" in snapshot_source
    assert snapshot_source.index("context_sync_gpu_magnetization_to_host(ctx, error)") < snapshot_source.index(
        "compute_effective_fields_for_magnetization("
    )


def test_explicit_rk_stepper_has_controlled_gpu_rk_call_site():
    source = MFEM_BRIDGE_CPP_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool context_step_explicit_rk_mfem(")
    function_end = source.index("\n} // namespace fullmag::fem", function_start)
    function_source = source[function_start:function_end]
    gpu_call_start = function_source.index("gpu_rk_plan_exchange_only(")
    workspace_start = function_source.index("stepper_workspace_allocate(")

    assert '#include "gpu_rk.hpp"' in source
    assert gpu_call_start < workspace_start
    assert "gpu_rk_exchange_only_step(" in function_source
    assert "gpu_rk_plan.enabled" in function_source
    assert "FULLMAG_FEM_INTEGRATOR_HEUN" in function_source
    assert "FULLMAG_FEM_INTEGRATOR_RK23_BS" in function_source
    assert "FULLMAG_FEM_INTEGRATOR_RK45_DP54" in function_source
    gpu_gate = function_source[gpu_call_start:workspace_start]
    assert "!ctx.adaptive_dt_enabled" not in gpu_gate


def test_preflight_reports_gpu_rk_cuda_source_and_compiler_state():
    bench = load_analysis_benchmark_module()

    report = bench.build_preflight_report(
        {"FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC": "1"}
    )

    assert report["gpu_rk_cuda_source_path"] == str(GPU_RK_CU_PATH)
    assert report["gpu_rk_cuda_source_present"] is True
    assert report["gpu_rk_cmake_wired"] is True
    assert report["assert_no_hot_loop_compute_sync"] is True
    assert isinstance(report["cuda_compiler_available"], bool)
    assert "cuda_compiler_path" in report
    assert "adaptive_gpu_rk_acceptance_ready" in report
    assert "adaptive_gpu_rk_acceptance_blockers" in report


def test_preflight_requires_cuda_mfem_and_compute_gate_for_adaptive_gpu_rk(tmp_path):
    bench = load_analysis_benchmark_module()
    mfem_prefix = tmp_path / "mfem"
    mfem_config_dir = mfem_prefix / "lib" / "cmake" / "mfem"
    mfem_config_dir.mkdir(parents=True)
    (mfem_config_dir / "MFEMConfig.cmake").write_text("# fake mfem config\n", encoding="utf-8")

    missing_gate = bench.build_preflight_report({"MFEM_DIR": str(mfem_prefix)})
    assert missing_gate["adaptive_gpu_rk_acceptance_ready"] is False
    assert "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1" in missing_gate[
        "adaptive_gpu_rk_acceptance_blockers"
    ]

    gated = bench.build_preflight_report(
        {
            "MFEM_DIR": str(mfem_prefix),
            "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC": "1",
        }
    )
    if gated["cuda_compiler_available"]:
        assert gated["adaptive_gpu_rk_acceptance_ready"] is True
        assert gated["adaptive_gpu_rk_acceptance_blockers"] == []
    else:
        assert gated["adaptive_gpu_rk_acceptance_ready"] is False
        assert "nvcc" in gated["adaptive_gpu_rk_acceptance_blockers"]


def test_required_preflight_can_enforce_adaptive_gpu_rk_acceptance(tmp_path):
    bench = load_analysis_benchmark_module()
    report = bench.build_preflight_report({})

    failures = bench.preflight_failures(
        report,
        require_mfem_stack=False,
        require_adaptive_gpu_rk_acceptance=True,
    )

    assert failures
    assert any("adaptive GPU RK acceptance is required" in failure for failure in failures)
    assert any("nvcc" in failure for failure in failures)


def test_benchmark_cli_accepts_preflight_alias(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--preflight"],
    )

    args = bench.parse_args()

    assert args.preflight_only is True
    completed = subprocess.run(
        [sys.executable, str(ANALYSIS_BENCHMARK_PATH), "--help"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "--preflight, --preflight-only" in completed.stdout


def test_benchmark_cli_applies_fem_cpu_no_pbc_adaptive_ready_preset(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--fem-cpu-no-pbc-adaptive-ready-preset"],
    )

    args = bench.parse_args()
    bench.apply_fem_cpu_no_pbc_adaptive_ready_preset(args)

    assert args.backends == "cpu"
    assert args.scenarios == "exchange_demag_anis_uniaxial,exchange_demag_anis_cubic"
    assert args.integrators == "rk23,rk45"
    assert args.timestep_policies == "adaptive"
    assert args.thread_counts == "1,physical_cores/2,physical_cores,auto"
    assert args.min_qualified_steps == 100
    assert args.require_mfem_stack is True
    assert args.require_demag_converged is True
    assert args.require_fem_cpu_no_pbc_adaptive_ready is True
    assert args.require_stable_solver_mesh is True
    assert args.emit_best_demag_policy is True
    assert args.require_best_demag_policy is True


def test_benchmark_cli_rejects_implicit_preflight_abbreviation(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--pref"],
    )

    try:
        bench.parse_args()
    except SystemExit as exc:
        assert exc.code == 2
    else:
        raise AssertionError("implicit --pref abbreviation must be rejected")


def test_benchmark_cli_rejects_implicit_skip_preflight_abbreviation(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--skip"],
    )

    try:
        bench.parse_args()
    except SystemExit as exc:
        assert exc.code == 2
    else:
        raise AssertionError("implicit --skip abbreviation must be rejected")


def test_all_in_gpu_docs_describe_compute_only_hot_loop_gate():
    runtime_doc = ALL_IN_GPU_RUNTIME_DOC.read_text(encoding="utf-8")
    rollout_plan = ALL_IN_GPU_PLAN.read_text(encoding="utf-8")

    assert "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1" in runtime_doc
    assert "phase2_compute_assertion_enabled" in runtime_doc
    assert "hot_loop_compute_host_sync_count" in runtime_doc
    assert "hot_loop_exchange_host_sync_count" in runtime_doc
    assert "FULLMAG_FEM_ALL_IN_GPU=1" in runtime_doc
    assert "FULLMAG_FEM_EXECUTION=all_in_gpu" in runtime_doc
    assert "all_in_gpu_contract_unmet" in runtime_doc
    assert "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1" in rollout_plan
    assert "phase2_compute_assertion_enabled" in rollout_plan
    assert "FULLMAG_FEM_ALL_IN_GPU=1" in rollout_plan
    assert "all_in_gpu_contract_unmet" in rollout_plan
    assert "Samo istnienie hostowej sciezki `compute_exchange_for_magnetization`" in rollout_plan
    assert "dopoki te call-site'y istnieja w sciezce stage exchange" not in rollout_plan
    assert "obecny tryb to\n`unsupported`" not in runtime_doc


def test_preflight_searches_cmake_prefix_path(tmp_path):
    bench = load_analysis_benchmark_module()
    empty_prefix = tmp_path / "empty"
    mfem_prefix = tmp_path / "mfem"
    config_path = mfem_prefix / "share" / "mfem" / "cmake" / "mfem-config.cmake"
    empty_prefix.mkdir()
    config_path.parent.mkdir(parents=True)
    config_path.write_text("# test mfem config\n", encoding="utf-8")

    env = {
        "CMAKE_PREFIX_PATH": os.pathsep.join([str(empty_prefix), str(mfem_prefix)])
    }
    report = bench.build_preflight_report(env)

    assert report["status"] == "ok_mfem_config"
    assert report["mfem_config_path"] == str(config_path)


def test_preflight_accepts_prebuilt_native_library(tmp_path):
    bench = load_analysis_benchmark_module()
    lib_dir = tmp_path / "native"
    lib_dir.mkdir()
    lib_path = lib_dir / "libfullmag_fem.so"
    lib_path.write_text("", encoding="utf-8")

    report = bench.build_preflight_report({"FULLMAG_FEM_LIB_DIR": str(lib_dir)})

    assert report["status"] == "ok_prebuilt"
    assert report["prebuilt_library_path"] == str(lib_path)
    assert bench.is_mfem_stack_ready(report)
    assert "adaptive_gpu_rk_acceptance_ready" in report
    assert "adaptive_gpu_rk_acceptance_blockers" in report
    assert "MFEM stack or prebuilt native FEM library is required" not in report[
        "adaptive_gpu_rk_acceptance_blockers"
    ]


def test_required_preflight_failure_names_actionable_environment_variables():
    bench = load_analysis_benchmark_module()

    report = bench.build_preflight_report({})
    failures = bench.preflight_failures(report, require_mfem_stack=True)

    assert report["status"] == "missing"
    assert failures
    remediation = "\n".join(failures)
    assert "FULLMAG_FEM_LIB_DIR" in remediation
    assert "MFEM_DIR" in remediation
    assert "MFEM_PREFIX" in remediation
    assert "CMAKE_PREFIX_PATH" in remediation


def test_preflight_invalid_prebuilt_still_reports_adaptive_acceptance_gate(tmp_path):
    bench = load_analysis_benchmark_module()
    missing_lib_dir = tmp_path / "native"
    missing_lib_dir.mkdir()

    report = bench.build_preflight_report({"FULLMAG_FEM_LIB_DIR": str(missing_lib_dir)})

    assert report["status"] == "invalid_prebuilt"
    assert report["adaptive_gpu_rk_acceptance_ready"] is False
    assert "MFEM stack or prebuilt native FEM library is required" in report[
        "adaptive_gpu_rk_acceptance_blockers"
    ]


def test_fullmag_use_mfem_stack_env_makes_missing_stack_a_failure():
    bench = load_analysis_benchmark_module()

    report = bench.build_preflight_report({"FULLMAG_USE_MFEM_STACK": "ON"})
    failures = bench.preflight_failures(
        report,
        require_mfem_stack=report["fullmag_use_mfem_stack_enabled"],
    )

    assert report["fullmag_use_mfem_stack_enabled"] is True
    assert failures
