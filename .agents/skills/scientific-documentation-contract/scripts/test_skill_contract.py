from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
SKILL = ROOT / ".agents/skills/scientific-documentation-contract/SKILL.md"


class SkillIntegrationTests(unittest.TestCase):
    def test_skill_declares_required_publication_gates(self) -> None:
        text = SKILL.read_text(encoding="utf-8")
        for requirement in (
            "one canonical scientific owner per physical interaction",
            "FDM CPU, FDM GPU, FEM CPU, and FEM GPU",
            "support and qualification matrix",
            "material implementation differences",
            "scientifically large topics",
            "path + symbol",
            "# %%",
            "ProblemIR",
            "requested intent",
            "resolved execution",
            "source-code index",
            "MathJax",
            "fm.study(...)",
            "study.stages.add_*",
            "relax_projected_gradient_bb.py",
            "Never put `fm.Problem(...)` in `public_docs/site`",
        ):
            self.assertIn(requirement, text)
        self.assertNotIn("domain → solver → backend → interaction", text)

    def test_agents_makes_skill_mandatory(self) -> None:
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("MUST use `scientific-documentation-contract`", agents)

    def test_physics_publication_requires_contract(self) -> None:
        physics = (ROOT / ".agents/skills/physics-publication/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("REQUIRED SUB-SKILL: use `scientific-documentation-contract`", physics)


if __name__ == "__main__":
    unittest.main()
