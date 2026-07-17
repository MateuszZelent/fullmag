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
| 6 | pending | pending | pending | pending | pending |
| 7 | pending | pending | pending | pending | pending |
| 8 | pending | pending | pending | pending | pending |
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
