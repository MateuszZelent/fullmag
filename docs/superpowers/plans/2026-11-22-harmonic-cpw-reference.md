# Harmonic CPW Reference Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Keep solve and qualification evidence separate.

**Goal:** Run a reproducible full-wave ECE reference and a Darwin comparison for CPW1 and CPW2 using the same geometry and terminal conditions.

**Architecture:** Use conforming lowest-order edge FEM for Maxwell and a compatible mixed edge and nodal formulation for Darwin in standalone CPU FP64 validation tools. Carry the same phasor convention, geometry, source and sample carrier through both operators. Production Fullmag integration follows the qualification in the physics note.

**Tech Stack:** Python, NumPy, SciPy sparse, Fullmag validation dossier.

**Spec:** [Physics note 0952](../../physics/0952-harmonic-rf-antenna-cpw.md).

## Global constraints

- Use the existing validation worktree. Preserve staged and unstaged changes and both validation archives.
- Obtain a separate compute allocation before solving publication-sized CPW cases. Geometry preflight and small manufactured fixtures are local tests.
- Keep the reference lane separate from the public Python DSL, ProblemIR and Control Room until it meets the numerical qualification.
- Preserve volume copper, peak phasors with exp(+iωt), terminal orientation, signed components and both field quadratures.

## Work

- [x] Build and test the Maxwell edge operator and ECE constraints in `scripts/rf_fullwave_reference.py` and `scripts/test_rf_fullwave_reference.py`. Verify direction, conductivity loss, terminal conservation and a manufactured wave.
- [x] Build the geometry, input validation, probe sampling, preflight and reproducible artifact CLI in `scripts/rf_cpw_reference.py` and its tests.
- [x] Build the comparison Darwin operator in `scripts/rf_darwin_reference.py` and its tests. Check gauge, conservation, and the Darwin power identity separately.
- [x] Verify both nominal CPW meshes without solving. Record DOFs, estimated solve cost and the exact scope needing compute approval.
- [ ] Run scientific qualification under the approved allocation. Compare with independent full-wave evidence and the published results. Publish evidence and retain raw quadratures.
- [ ] Select a qualified native formulation and implement the corresponding Fullmag distribution, execution and round-trip contracts. Report native integration separately.
