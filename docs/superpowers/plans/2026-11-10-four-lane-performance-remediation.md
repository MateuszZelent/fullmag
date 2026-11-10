# Four-lane solver performance remediation

**Goal:** Implement the verified findings of the four-lane audit without changing physical inputs, silently falling back to CPU, or weakening residual, rollback, convergence and Zarr contracts.

**Base:** `d4134f0d17149686947c8cfac5f072b077982a7c` (task branch merged with master `da795b554bfdf66d55cee04cbf0e978aafed2a5a`). Existing SP4 inputs/results remain preserved. Group: `fullmag-worktree-fullmag-a8342df1f0247d61`.

**Architecture:** Reuse interaction results at their numerical owner, with explicit validity and failure semantics. Keep actual fresh-zero solves and independent residual certification. Use existing instrumentation and managed Compose build/runtime; source tests are not numerical qualification.

**Spec:** External audit `C:/git/fullmag/fullmag/docs/audits/2026-11-10-four-lane-solver-performance-audit.md` and its independently verified findings in the task conversation. Numerical owners: `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md` and existing FDM energy/relaxation notes.

## Ordered implementation and acceptance

- [ ] FDM CPU BB: eliminate duplicate accepted demag convolution in AoS and SoA. Owner: engine energy/field API and reference minimizer. Preserve individual energy reductions, interactions, constraints, line search, stopping and backtracking. Compare combined versus independent energy/field evaluation; test backtracking and regional interactions.
- [ ] FEM CPU BB: reuse a certified accepted endpoint only with defensible validity, including refinement and failure. Owner: CPU relaxation. Never treat logical `rhs_evals` as physical solve count. Test forced refresh equivalence and invalidation.
- [ ] FEM GPU BB: reuse accepted endpoint fields and energy at GPU relaxation owner. Preserve source/operator/state/policy identity, exact refinement semantics, independent certificate, failure/rollback. Measure actual solve counts and final trajectories.
- [ ] GPU RK: preserve eligible restored FSAL derivative on adaptive retry; retain fail-closed stochastic/callback/frozen/periodic policy. Test rejected attempts and all supported explicit integrators; do not repurpose endpoint tokens or warm-start potential implicitly.
- [ ] GPU observables: skip provably unnecessary DMI refresh while preserving stale-buffer clearing; reduce weighted per-object magnetization on device with existing P1/DG0 semantics. Verify CPU/GPU observable parity and transfer counts.
- [ ] FDM GPU BB: consolidate boundary operations where host decisions permit it; retain Armijo/retraction safety. Verify backtrack and failure paths, native receipt and full Zarr.
- [ ] CPU execution: collect one-build thread/wait/binding matrix before selecting new defaults; inspect effective compilation options before changing OpenMP linkage. Do not infer optimal defaults from mixed-build timings.
- [ ] FDM FFT: qualify single-layer padding and grain-size candidates against existing kernels/independent oracle before enabling. Buffer reduction alone is not an accepted performance result.
- [ ] Poisson: benchmark certified adaptive inner tolerance, RK initial guesses and AMG variants separately. Keep requested tolerance/certificate/iteration limits; relaxation fresh-zero changes require explicit numerical contract documentation and qualification.
- [ ] Transaction/persistence: qualify minimal rollback state rather than remove journal; preserve writer backpressure and terminal provenance acknowledgement. Diagnose bounded wait failures rather than suppress them.
- [ ] Telemetry: physical solve counts, accumulated CG iterations, explicit termination reason where missing; no new per-step full-field reads and no allocations when profiler disabled.
- [ ] Qualification: alternating repeated baseline/candidate runs with identical source/input/device/budgets, separately initialization/steady-state/output. Record accepted/rejected steps, energies, torque, field consistency, independent residual and full host-WSL Zarr. No speedup claim from a single run or trace coverage.
- [ ] Integration: review, coherent verified commits, push existing PR #419 or correctly scoped follow-up, required CI, merge and main fast-forward. Retain this worktree while scientific campaign/untracked inputs/consumers require it; record any exact cleanup blocker.

## Current constraints

On initial inspection Docker responds, this group's application services are stopped, WSL has about 2.4 GiB available. Runtime/build admission must be established afresh through the launcher. Existing results and technical volumes must not be deleted to obtain space without qualification and authority.

## Review focus

Cache after Armijo refinement; external source/operator mutation; rejected attempts and interrupted finalization; frozen/periodic/regional material semantics; writer failure while preserving primary solver error.
