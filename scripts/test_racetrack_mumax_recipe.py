from pathlib import Path
import unittest


JUSTFILE = Path(__file__).resolve().parents[1] / "justfile"


class RacetrackMuMaxRecipeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.recipe = JUSTFILE.read_text(encoding="utf-8")
        start = cls.recipe.index("verify-fdm-gpu-racetrack-mumax-common-limit:")
        end = cls.recipe.index("# Build the Hall observable", start)
        cls.body = cls.recipe[start:end]

    def test_recipe_builds_mumax_manifest_from_the_actual_run(self) -> None:
        self.assertIn("scripts/parse_mumax_common_limit.py", self.body)
        self.assertIn('--output "$work_dir/mumax-input.generated.json"', self.body)
        self.assertIn('cp "$work_dir/mumax-input.generated.json" "$report_root/mumax-input.json"', self.body)
        self.assertIn("--fixed-timestep-s 5e-14", self.body)
        self.assertIn("--sample-interval-s 5e-12", self.body)
        self.assertIn("--duration-s 2e-9", self.body)
        self.assertIn("--sampling-mode explicit_steps", self.body)

    def test_preexisting_mumax_manifest_is_optional_expectation_not_prerequisite(self) -> None:
        self.assertNotIn('for required in "$fullmag_input" "$mumax_input" "$relaxed_ovf"', self.body)
        self.assertIn('for required in "$fullmag_input" "$relaxed_ovf"', self.body)

    def test_generated_manifest_is_used_for_comparison(self) -> None:
        compare = 'compare_fdm_racetrack_mumax.py --fullmag "$report_root/fullmag-input.json" --mumax "$report_root/mumax-input.json"'
        self.assertIn(compare, self.body)


if __name__ == "__main__":
    unittest.main()
