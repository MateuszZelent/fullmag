# Subagent-driven development progress

## Plan: 2026-07-17 LLG time-domain solver remediation

- Worktree: `/tmp/fullmag-llg-remediation-clean`
- Branch: `codex/llg-time-domain-remediation-clean`
- Base: `707a50386cdfe6787aac06cca3070289dc731fa2`
- Approved audit: `docs/audits/2026-07-16-llg-time-domain-solver-audit.md`
- Canonical contract: `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`
- Implementation plan: `docs/superpowers/plans/2026-07-17-llg-time-domain-solver-remediation.md`

| Task | Status | RED evidence | GREEN evidence | Reviews | Commit |
|---:|---|---|---|---|---|
| 1 | completed | empty CUDA architecture, stale report path, stale external-energy assertion | default and `FULLMAG_CUDA_ARCHITECTURES=75` managed gates exit 0 | spec APPROVED; quality APPROVED | `138da5c8` |
| 2 | completed | initial 23 failures; review RED 7; re-review RED 6; fixed-draft/resolver follow-up RED | focused 24 passed + 24 subtests; task-owned test_api 251 passed | spec APPROVED; quality APPROVED | `4e25d70e` |
| 3 | completed | max-error intent was not serialized; unsupported adaptive policies could reach CUDA/FEM ABI gaps; stale Floquet fixture conflated periodic and outer markers | IR 181 passed; full planner 229 passed; focused CLI/Python/runner gates green; managed CUDA test pending | spec APPROVED; quality APPROVED | `4ff3eb7b` |
| 4 | completed | hidden first-step/max sentinels, lossy `dt_policy`, fake physical time for direct minimizers, and unbound lane provenance | runner 558/558; all-features and CLI checks green; sentinel restricted to native FEM ABI; adaptive CUDA fails closed | spec APPROVED; quality APPROVED | `5a5c8781` |
| 5 | completed | policy dropped across authoring/API/UI; raw solver JSON; incomplete/implicit stage policy; flat-relax scope regression; Rust/Python scene `algorithm` drift | authoring 47/47; focused API scene 1/1; Python focused 54/54 then 45/45; Control Room full 3482/3482, typecheck/lint green; full Python residual 3/717 reproduced at pre-Task-5 base | spec APPROVED; quality APPROVED after findings 1-25 | `817f18e7..ddca07f0` |
| 6 | completed | q=2/q=4 order ignored; accepted steps could not shrink; dt_min force-retry; unsafe GPU candidate failure paths; max_err rtol=0 rejected | independent managed `verify-fem-time-domain-native-contract` exit 0; shared CPU/CUDA-host golden vectors and boundary/failure contracts green | spec APPROVED; quality APPROVED | `8c7b1d6c` |
| 7 | completed | fixed RK23/RK45 emitted adaptive suggestions; adaptive floor could force-accept; CUDA ABI dropped authored controller policy; production CUDA loop reused immutable initial dt | engine 200/200; plan 230/230; runner 561/561; fdm-sys 1/1; CPU-only and CUDA managed native contracts PASS; feature-CUDA cargo check PASS | spec APPROVED; quality APPROVED after production dispatch correction | `cea7eb2b` |
| 8 | completed | CPU relative-only airbox node produced zero scale; legacy FEM adaptive ABI was grown in place; helper-only tests did not prove production rollback | managed FEM CPU/CUDA gate PASS including executed CUDA zero/subnormal/NaN/Inf guard contract; plan 230/230; runner 561/561; production CPU norm/rotation/nonfinite rollback green | spec APPROVED; quality APPROVED after airbox-mask, ABI-v2, and runtime-test corrections | `8599d50e`, `bcc2f80d` |
| 9 | pending | pending | pending | pending | pending |
| 10 | pending | pending | pending | pending | pending |
| 11 | pending | pending | pending | pending | pending |
| 12 | pending | pending | pending | pending | pending |
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

- Task 10 owns general post-backup `gpu_rk_run_stage_attempt` failure rollback;
  Task 6 closes adaptive reduction, readback, decision-failure, and retry
  candidate restoration only.
- FDM norm and per-spin rotation guard intent remains transported and fails
  closed; Task 8 implements and verifies the FEM CPU/GPU guard realization.
- Task 10 owns candidate H/work/demag-cache rollback and atomic publication;
  Task 7 proves rejected-step rollback only for magnetization, time, and exact
  pre-attempt FSAL validity.
