from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_full_target_is_managed_strict_cpu_gpu_and_fail_closed():
    justfile = (ROOT / "justfile").read_text()
    script = (ROOT / "scripts/verify_fem_standard_problem_4.sh").read_text()
    assert "verify-fem-standard-problem-4:" in justfile
    assert "just verify-fem-time-domain-native-contract" in justfile
    assert "just ensure-managed-fem-runtime" in justfile
    assert 'devices="${FULLMAG_SP4_DEVICES:-cpu gpu}"' in script
    assert (
        'relaxation_algorithms="${FULLMAG_SP4_RELAX_ALGORITHMS:-llg_overdamped '
        'projected_gradient_bb nonlinear_cg}"'
    ) in script
    assert 'meshes="${FULLMAG_SP4_MESH_LEVELS:-coarse medium fine}"' in script
    assert 'cases="${FULLMAG_SP4_CASES:-case-a case-b}"' in script
    assert "FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson" in script
    assert "FULLMAG_GMSH_THREADS=1" in script
    assert "set -euo pipefail" in script
    assert "replay-before" in script and "replay-after" in script
    assert "tests.standard_problems.mumag.sp4.fem.verify" in script
    assert "for algorithm in $relaxation_algorithms" in script
    assert '"$root/relaxations/$device/$mesh/$airbox/$algorithm/artifacts"' in script
    assert '--expected-algorithm "$algorithm" --expected-device "$device"' in script
    assert "scripts/select_fem_sp4_relaxation_state.py" in script
    assert "fresh SP4 relaxation did not satisfy the qualification gate" in script


def test_smoke_is_explicitly_nonqualifying():
    justfile = (ROOT / "justfile").read_text()
    assert "verify-fem-standard-problem-4-smoke:" in justfile
    assert "FULLMAG_SP4_QUALIFYING=0" in justfile
    assert "FULLMAG_SP4_RELAX_MAX_STEPS=1" in justfile
    assert "FULLMAG_SP4_RELAX_ALGORITHMS=llg_overdamped" in justfile
    assert "FULLMAG_SP4_DURATION_S=1e-14" in justfile


def test_resume_keeps_qualification_fail_closed_but_reuses_complete_smoke_artifacts():
    script = (ROOT / "scripts/verify_fem_standard_problem_4.sh").read_text()
    assert 'if [ "$qualifying" = 1 ]; then' in script
    assert 'elif [ -s "$relaxation_root/metadata.json" ]' in script
    assert '[ -s "$relaxation_root/scalars.csv" ]' in script
    assert '[ -s "$relaxation_root/m_final.json" ]' in script
    assert 'relaxation_ready=1' in script


def test_plain_user_scenario_target_keeps_physics_in_script_and_processes_bundle():
    justfile = (ROOT / "justfile").read_text()
    wrapper = (ROOT / "scripts/run_fem_sp4_scenario.sh").read_text()
    assert "fem-sp4-scenario device script attempt_id" in justfile
    assert "scripts/run_fem_sp4_scenario.sh" in justfile
    assert 'just fullmag "build=$build" fem "$device" headless "$script"' in wrapper
    assert 'bundle="${script%.py}.zarr"' in wrapper
    assert "tests.standard_problems.mumag.sp4.fem.collect_results" in wrapper
    assert "tests.standard_problems.mumag.sp4.fem.plot_results" in wrapper
    assert "run_receipt.json" in wrapper
    assert "record" not in wrapper or "--failure-category execution_failure" in wrapper
    for hidden_physics_control in (
        "FULLMAG_SP4_CASE",
        "FULLMAG_SP4_MESH",
        "FULLMAG_SP4_AIRBOX",
        "FULLMAG_SP4_DURATION_S",
        "FULLMAG_SP4_PHASE",
    ):
        assert hidden_physics_control not in wrapper
