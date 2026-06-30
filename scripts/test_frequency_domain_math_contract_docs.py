from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PLAN_ROOT = REPO_ROOT / "docs/plans/active/frequency-domain-fem-masterplan-2026-06-11"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_modal_gyrotropic_mapping_contract_is_explicit() -> None:
    plan = read(PLAN_ROOT / "10-production-interior-window-eigensolver.md")

    assert "G q_dot = -K q" in plan
    assert "A = -G^{-1} K" in plan
    assert "lambda = i omega" in plan
    assert "sigma = -i omega" in plan
    assert "omega_rad_s = -Im(sigma)" in plan
    assert "omega_rad_s = Im(i * sigma)" not in plan
    assert "mu0 * Ms(r) / gamma0" in plan


def test_dynamic_demag_and_response_observables_use_si_contract() -> None:
    plan = read(PLAN_ROOT / "10-production-interior-window-eigensolver.md")

    assert "delta_H_demag[xi] = -grad(delta_phi)" in plan
    assert "laplace(delta_phi) = div(Ms * xi)" in plan
    assert "div(-grad(delta_phi)) = -div(Ms * xi)" in plan
    assert "delta_M = Ms * delta_m" in plan
    assert "chi_SI = delta_M / h_drive" in plan
    assert "sgn * 0.5 * mu0 * Ms(r) * omega" in plan
    assert "omega_complex = omega_r + i Gamma" in plan
    assert "Gamma > 0 means decay" in plan


def test_floquet_tangent_frame_transport_and_identity_rejection_are_documented() -> None:
    pbc_plan = read(PLAN_ROOT / "08-periodic-floquet-bloch-boundary-conditions.md")
    masterplan = read(
        PLAN_ROOT / "11-comsol-grade-frequency-domain-masterplan-2026-06-30.md"
    )

    assert "T_dst q_dst =" in pbc_plan
    assert "exp(-i k dot delta_r) * T_src q_src" in pbc_plan
    assert "q_dst =" in pbc_plan
    assert "exp(-i k dot delta_r) * (T_dst^T T_src) q_src" in pbc_plan
    assert "must reject the Floquet/PBC request" in pbc_plan
    assert "scalar phase-only" in pbc_plan
    assert "phase*(T_dst^T T_src)" in masterplan
