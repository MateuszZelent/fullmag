"""Source guard only; native materialization tests are authored but not compiled."""
import unittest

from test_command_result_identity_source import rust_block, source


class EmptyStudyPipelineSourceTests(unittest.TestCase):
    def test_present_pipeline_returns_before_legacy_fallback_even_when_empty(self):
        body = rust_block(source("crates/fullmag-cli/src/step_utils.rs"),
                          "fn materialize_script_stages(")
        pipeline = body.split("if let Some(document) = study_pipeline {", 1)[1]
        pipeline = pipeline.split("let entrypoint_kind = ir.problem_meta.entrypoint_kind.clone();", 1)[0]
        self.assertNotIn("if !materialized.is_empty()", pipeline)
        self.assertIn("return Ok(annotate_stage_transitions(materialized));", pipeline)
        self.assertIn("configure_stage_output_storage(stage, output_storage.as_ref())?;", pipeline)

    def test_disabled_nodes_and_groups_skip_before_materialization(self):
        body = rust_block(source("crates/fullmag-cli/src/step_utils.rs"),
                          "fn walk_study_pipeline_nodes(")
        self.assertEqual(body.count("if !enabled {"), 3)
        for variant, boundary in (("Primitive", "materialize_pipeline_primitive("),
                                  ("Macro", "materialize_pipeline_macro("),
                                  ("Group", "walk_study_pipeline_nodes(children")):
            branch = body.split("StudyPipelineNode::" + variant + " {", 1)[1]
            branch = branch.split(boundary, 1)[0]
            self.assertIn("if !enabled {\n                    continue;\n                }", branch)

    def test_native_regressions_cover_empty_disabled_group_and_legacy(self):
        text = source("crates/fullmag-cli/src/step_utils.rs")
        for name in ("does_not_synthesize_solver_for_empty_pipeline",
                     "does_not_synthesize_solver_for_disabled_pipeline",
                     "skips_enabled_children_of_disabled_group",
                     "retains_legacy_solver_without_pipeline"):
            self.assertIn("fn materialize_script_stages_" + name + "()", text)


if __name__ == "__main__":
    unittest.main()
