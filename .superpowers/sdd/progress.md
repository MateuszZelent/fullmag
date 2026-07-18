# Subagent-driven development progress

## Plan: 2026-07-17 LLG time-domain solver remediation

- Worktree: `/tmp/fullmag-llg-time-domain-remediation-phase2`
- Branch: `codex/llg-time-domain-remediation-phase2`
- Base: `3130ac7a0950e456c8e4eaab220df2ba0da9dbb9`
- Approved audit: `docs/audits/2026-07-16-llg-time-domain-solver-audit.md`
- Canonical contract: `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`
- Implementation plan: `docs/superpowers/plans/2026-07-17-llg-time-domain-solver-remediation.md`

| Task | Status | RED evidence | GREEN evidence | Reviews | Commit |
|---:|---|---|---|---|---|
| 1 | completed | empty CUDA architecture, stale report path, stale external-energy assertion | default and `FULLMAG_CUDA_ARCHITECTURES=75` managed gates exit 0 | spec APPROVED; quality APPROVED | `54df61a8` |
| 2 | completed | initial 23 failures; review RED 7; re-review RED 6; fixed-draft/resolver follow-up RED | focused 24 passed + 24 subtests; task-owned test_api 251 passed | spec APPROVED; quality APPROVED | `753505d3` |
| 3 | completed | max-error intent was not serialized; unsupported adaptive policies could reach CUDA/FEM ABI gaps; stale Floquet fixture conflated periodic and outer markers | IR 181 passed; full planner 229 passed; focused CLI/Python/runner gates green; managed CUDA test pending | spec APPROVED; quality APPROVED | `5905482a` |
| 4 | completed | hidden first-step/max sentinels, lossy `dt_policy`, fake physical time for direct minimizers, and unbound lane provenance | runner 558/558; all-features and CLI checks green; sentinel restricted to native FEM ABI; adaptive CUDA fails closed | spec APPROVED; quality APPROVED | `c6edf60d` |
| 5 | completed | policy dropped across authoring/API/UI; raw solver JSON; incomplete/implicit stage policy; flat-relax scope regression; Rust/Python scene `algorithm` drift | authoring 47/47; focused API scene 1/1; Python focused 54/54 then 45/45; Control Room full 3482/3482, typecheck/lint green; full Python residual 3/717 reproduced at pre-Task-5 base | spec APPROVED; quality APPROVED after findings 1-25 | `378ba773..3b5ba284` |
| 6 | completed | q=2/q=4 order ignored; accepted steps could not shrink; dt_min force-retry; unsafe GPU candidate failure paths; max_err rtol=0 rejected | independent managed `verify-fem-time-domain-native-contract` exit 0; shared CPU/CUDA-host golden vectors and boundary/failure contracts green | spec APPROVED; quality APPROVED | `7471a615` |
| 7 | completed | fixed RK23/RK45 emitted adaptive suggestions; adaptive floor could force-accept; CUDA ABI dropped authored controller policy; production CUDA loop reused immutable initial dt | engine 200/200; plan 230/230; runner 561/561; fdm-sys 1/1; CPU-only and CUDA managed native contracts PASS; feature-CUDA cargo check PASS | spec APPROVED; quality APPROVED after production dispatch correction | `22e224f7` |
| 8 | completed | CPU relative-only airbox node produced zero scale; legacy FEM adaptive ABI was grown in place; helper-only tests did not prove production rollback | managed FEM CPU/CUDA gate PASS including executed CUDA zero/subnormal/NaN/Inf guard contract; plan 230/230; runner 561/561; production CPU norm/rotation/nonfinite rollback green | spec APPROVED; quality APPROVED after airbox-mask, ABI-v2, and runtime-test corrections | `141cfb77`, `f78e2d6e` |
| 9 | completed | non-periodic Hypre, periodic MFEM CG, strict GPU Hypre, and FEM/BEM Hypre all published `max_iterations=1` candidates; `preconditioner=none` aborted through invalid `HypreIdentity::SetOperator` | `just verify-fem-demag-poisson-contract` exit 0 with actual CPU/periodic/FEM-BEM/GPU nonconvergence fixtures and failed-candidate publication guards | self-review complete; managed contract green after rebase | `45f85564` |
| 10 | completed | candidate, endpoint-refresh, and post-statistics failpoints previously leaked fields/controller/FSAL/cache state; adaptive retries restored only magnetization | managed `just verify-fem-time-domain-native-contract` exit 0 after rebase; CPU full-state failpoints, retry cache rollback, persistent CUDA device-to-device field/FSAL/Poisson rollback, and exactly-once success publication green | self-review complete; managed CPU/CUDA contract green after rebase | `81590e0a` |
| 11 | completed | accepted-step-only telemetry hid rejected attempts; native ABI exposed no bounded trace; live `Error` was normalized eta rather than the authored max-error quantity; no typed solver artifacts existed | managed `just verify-fem-time-domain-native-contract` PASS on CPU/CUDA; runner artifact replay 1/1; API solver-status 1/1; runner/CLI/API cargo check green; Control Room targeted 13/13, typecheck/lint green, full Vitest 386 files passed with 3686 tests passed and 1 skipped | self-review complete; versioned 64-record ABI and fail-closed copy validation; GPU guard metrics use one 24-byte audited readback | `b8fa66b1` |
| 12 | completed | macrospin/exchange/fast-mode fixtures absent; production relax-to-run initially changed 63 scalar values by FP64 renormalization; GPU first post-relax warm-start could report unconverged at zero iterations despite a certified residual; no approved periodic-antidot asset/runtime gate | `just verify-fem-llg-time-domain-qualification-production`, `just verify-fem-llg-periodic-antidot-qualification-production`, `just verify-fem-demag-poisson-contract`, and `just verify-fem-time-domain-native-contract` all exit 0; CPU/GPU FP64 analytic and production runtime artifacts pass; exact persisted handoff has zero differing values; PBC seams are `ok` | self-review complete; capability promotion is limited to explicit adaptive FEM RK45 FP64 and does not imply FP32, stiff lanes, or every optional interaction | pending |
| 13 | pending | pending | pending | pending | pending |
| 14 | pending | pending | pending | pending | pending |
| 15 | pending | pending | pending | pending | pending |

### Baseline evidence

- 2026-07-17: focused legacy Python solver tests passed (2 tests).
- 2026-07-17: runner `initial_timestep_tests` passed (5 tests), including
  stale expectations for hidden `1e-13` fallback.
- 2026-07-17: `just verify-fem-time-domain-native-contract` failed during
  CMake generation because CUDA targets had empty `CUDA_ARCHITECTURES`; the
  recipe did not reach adaptive solver assertions.

### Routed remediation debt

- Task 10 closes general post-backup `gpu_rk_run_stage_attempt` failure
  rollback, candidate field/cache rollback, and the final-statistics commit
  boundary on CPU and CUDA.
- FDM norm and per-spin rotation guard intent remains transported and fails
  closed; Task 8 implements and verifies the FEM CPU/GPU guard realization.
- Task 10 closes candidate H/work/demag-cache rollback and atomic publication;
  Task 7 remains the historical proof for magnetization/time/FSAL-only
  rejected-step behavior before the complete transaction was added.
