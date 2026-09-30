import assert from "node:assert/strict";
import test from "node:test";
import { buildEigenResidualSummary } from "../src/shared/domain/analysis/eigenResidualSummary.ts";

test("keeps absolute and relative L2 residuals separate", () => {
  const value = buildEigenResidualSummary({ residual_absolute_l2: 2e-12,
    residual_relative_l2: 3e-9, block_residuals: { scope: "reduced_original_blocks_only" } }, 9e-7);
  assert.equal(value.absoluteL2, 2e-12);
  assert.equal(value.relativeL2, 3e-9);
  assert.equal(value.scope, "Reduced original blocks only");
  assert.equal(value.reportedSpectrumResidual, 9e-7);
});
test("legacy mode residual_norm is an absolute alias, never relative", () => {
  const value = buildEigenResidualSummary({ residual_norm: 4e-12 }, null);
  assert.equal(value.absoluteL2, 4e-12);
  assert.equal(value.relativeL2, null);
  assert.equal(value.scope, "Not available");
});
test("spectrum fallback remains unclassified", () => {
  const value = buildEigenResidualSummary(null, 1e-8);
  assert.equal(value.absoluteL2, null);
  assert.equal(value.relativeL2, null);
  assert.equal(value.reportedSpectrumResidual, 1e-8);
  assert.equal(value.scope, "Not available");
});
test("does not infer a scope from a small residual", () => {
  assert.equal(buildEigenResidualSummary({ residual_relative_l2: 1e-14 }, null).scope, "Not available");
});
test("rejects nonnumeric, nonfinite and negative residuals", () => {
  for (const invalid of [true, "1e-9", -1, NaN, Infinity]) {
    const value = buildEigenResidualSummary({ residual_absolute_l2: invalid, residual_relative_l2: invalid }, invalid);
    assert.equal(value.absoluteL2, null);
    assert.equal(value.relativeL2, null);
    assert.equal(value.reportedSpectrumResidual, null);
  }
  assert.equal(buildEigenResidualSummary({ residual_relative_l2: 0 }, 0).relativeL2, 0);
});
test("does not promote an unknown scope to full certification", () => {
  assert.equal(buildEigenResidualSummary({ residual_relative_l2: 1e-10,
    block_residuals: { scope: "unknown" } }, null).scope, "Not available");
});
test("shows the producer's projected full scope without claiming qualification", () => {
  const value = buildEigenResidualSummary({ residual_relative_l2: 2e-10,
    block_residuals: { scope: "full_projected_weak_form_and_periodic_seams" } }, null);
  assert.equal(value.scope, "Full projected weak form and periodic seams");
});
