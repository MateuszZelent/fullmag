# MESH-PBC-FDM-002 — CUDA FP32 periodic exchange Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zaimplementować w CUDA `single` ten sam periodic neighbor wrapping i seam exchange co w `double`.

**Architecture:** Wspólny backend-neutral boundary contract zasila oddzielne FP32/FP64 kernels. Do czasu zielonej kwalifikacji capability blokuje `single + gpu + PBC`.

**Tech Stack:** CUDA C++, C ABI, Rust FFI/runner, managed GPU tests

## Global Constraints

- Nie promować single bez double-oracle parity.
- Równania, sign i units są wspólne; implementacje kernels pozostają rozdzielone.
- Native/GPU proof wyłącznie przez container-backed `just`.

---

**Finding:** MESH-PBC-FDM-002, P0.

### Task 1: capability guard i RED kernel test

- [ ] Najpierw zablokować unsupported lane w capability matrix/planner z actionable reason.
- [ ] Dodać FP32 periodic seam fixture w `backends/fdm/tests/`, porównując uniform, linear i seam-localized magnetization z CPU double/FP64.
- [x] Dodać source-level contract dla FP32 periodic neighbor helper i przekazania wszystkich osi; runtime parity fixture pozostaje do managed CUDA.
- [ ] Uruchomić managed test; obecny FP32 ma FAIL na seam.

### Task 2: ABI i kernel

```cpp
struct FdmPeriodicAxes { bool x; bool y; bool z; };
```

- [x] Osie są już częścią ABI/context/sys/CUDA construction i zostały przekazane do FP64; FP32 kernel teraz konsumuje ten sam kontrakt.
- [x] Zastosować modulo neighbor indices tylko na aktywnych osiach; zachować open behavior na pozostałych.
- [ ] Uruchomić managed FP32/FP64 parity test; PASS w opublikowanej single tolerance.

### Task 3: promotion

- [ ] Odblokować capability dopiero po artifact z parity error, device/runtime versions i grid fingerprint.
- [ ] Commit: `git add docs/specs/capability-matrix-v0.* native/include backends/fdm crates/fullmag-fdm-sys crates/fullmag-runner && git commit -m "fix(cuda): implement FP32 periodic exchange"`.

### Evidence (2026-07-14, partial)

- `exchange_fp32.cu` now uses `pbc_neighbor_fp32` with `ctx.periodic_x/y/z`; open axes retain clamped neighbors.
- `fdm_periodic_exchange_fp32_contract` source-level gate was added to the native FDM CMake test set.
- Managed CUDA FP32/FP64 seam parity and promotion artifact remain open; no CUDA runtime was claimed from this environment.

**Exit:** FP32 seam matches double oracle w tolerancji; unsupported guard usunięty wyłącznie po managed proof.
