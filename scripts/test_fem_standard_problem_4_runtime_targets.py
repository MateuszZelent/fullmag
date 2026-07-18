from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_full_target_is_managed_strict_cpu_gpu_and_fail_closed():
    justfile = (ROOT / "justfile").read_text()
    script = (ROOT / "scripts/verify_fem_standard_problem_4.sh").read_text()
    assert "verify-fem-standard-problem-4:" in justfile
    assert "just verify-fem-time-domain-native-contract" in justfile
    assert "just ensure-managed-fem-runtime" in justfile
    assert 'devices="${FULLMAG_SP4_DEVICES:-cpu gpu}"' in script
    assert 'meshes="${FULLMAG_SP4_MESH_LEVELS:-coarse medium fine}"' in script
    assert 'cases="${FULLMAG_SP4_CASES:-case-a case-b}"' in script
    assert "FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson" in script
    assert "FULLMAG_GMSH_THREADS=1" in script
    assert "set -euo pipefail" in script
    assert "replay-before" in script and "replay-after" in script
    assert "tests.standard_problems.mumag.sp4.fem.verify" in script


def test_smoke_is_explicitly_nonqualifying():
    justfile = (ROOT / "justfile").read_text()
    assert "verify-fem-standard-problem-4-smoke:" in justfile
    assert "FULLMAG_SP4_QUALIFYING=0" in justfile
    assert "FULLMAG_SP4_RELAX_MAX_STEPS=1" in justfile
