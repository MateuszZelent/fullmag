import tempfile
import unittest
from pathlib import Path

from scripts.check_relaxation_contract_docs import check_relaxation_contract_docs


MARKDOWN_PATHS = (
    "docs/physics/0500-fdm-relaxation-algorithms.md",
    "docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md",
    "docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md",
    "docs/architecture/backend-golden-masterplan.md",
    "docs/specs/problem-ir-v0.md",
    "docs/specs/problem-ir-compatibility-v1.md",
    "docs/specs/capability-matrix-v0.md",
    "docs/specs/resource-first-control-room-api-v2.md",
)


class RelaxationContractDocsTest(unittest.TestCase):
    def _repo(self, text: str) -> Path:
        root = Path(tempfile.mkdtemp())
        for relative in MARKDOWN_PATHS:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        capability = root / "docs/specs/capability-matrix-v0.json"
        capability.write_text(
            """{
              "features": [
                {"id":"relaxation_llg_overdamped","notes":"Defaults 1e-4 A/m and 50000; max_torque_Apm and max_rhs_norm_per_s."},
                {"id":"relaxation_projected_gradient_bb","notes":"m/A line-search step and no RK."},
                {"id":"relaxation_nonlinear_cg","notes":"m/A line-search step and no RK."},
                {"id":"relaxation_tangent_plane_implicit","lanes":{"fem_cpu_public":"development_executable","fem_gpu_public":"unsupported"},"notes":"Strict and forced GPU reject; extended resolves CPU/MFEM."}
              ]
            }""",
            encoding="utf-8",
        )
        return root

    def test_accepts_canonical_contract(self) -> None:
        root = self._repo(
            """
            The public default torque tolerance is `1e-4 A/m` and max_steps is 50000.
            `max_torque_Apm` is the exact accepted-state field residual in `A/m`;
            `max_torque_T = mu0 * max_torque_Apm` is the equivalent value in `T`,
            while `max_rhs_norm_per_s` is a separate dynamic observable in `1/s`.
            Direct-minimizer line-search step lambda has unit `m/A`; PG-BB and NCG
            own no RK integrator or physical/pseudo time.
            TPI is rejected in strict mode and on GPU; extended mode may resolve
            it only to the CPU/MFEM development lane.
            """
        )
        self.assertEqual(check_relaxation_contract_docs(root), [])

    def test_rejects_each_stale_contract_family(self) -> None:
        root = self._repo(
            """
            Direct-minimizer lambda is dimensionless and its line-search pseudo-time is in s.
            The default torque tolerance is 1e-6 A/m.
            Tangent-plane implicit is strict-production and GPU-executable.
            max_torque is reconstructed from dm/dt.
            Projected-gradient uses RK4 integration.
            """
        )
        errors = "\n".join(check_relaxation_contract_docs(root))
        for contract in ("step-unit", "default-torque", "tpi-capability", "torque-observable", "direct-rk"):
            self.assertIn(contract, errors)

    def test_rejects_multiline_tpi_production_and_automatic_fallback_claim(self) -> None:
        root = self._repo(
            """
            The public default torque tolerance is `1e-4 A/m` and max_steps is 50000.
            `max_torque_Apm` is the exact accepted-state field residual in `A/m`;
            `max_torque_T = mu0 * max_torque_Apm` is the equivalent value in `T`,
            while `max_rhs_norm_per_s` is a separate dynamic observable in `1/s`.
            Direct-minimizer line-search step lambda has unit `m/A`; PG-BB and NCG
            own no RK integrator or physical/pseudo time.
            TPI is rejected in strict mode and on GPU; extended mode may resolve
            it only to the CPU/MFEM development lane.
            """
        )
        matrix = root / "docs/specs/capability-matrix-v0.md"
        matrix.write_text(
            matrix.read_text(encoding="utf-8")
            + """
            FEM relaxation algorithms llg_overdamped, projected_gradient_bb,
            nonlinear_cg, and CPU/MFEM tangent_plane_implicit are the current
            production-executable relaxation set. In automatic runtime selection,
            a GPU TPI plan falls back to fem_cpu_native.
            """,
            encoding="utf-8",
        )
        errors = "\n".join(check_relaxation_contract_docs(root))
        self.assertIn("tpi-capability", errors)
        self.assertIn("hidden-fallback", errors)


if __name__ == "__main__":
    unittest.main()
