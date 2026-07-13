# MESH-PBC-FDM-003 — Multilayer FDM PBC parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zapewnić pełne PBC exchange/demag w multilayer CPU, CUDA double i kwalifikowanej CUDA single albo fail-closed oznaczyć lane jako unsupported.

**Architecture:** Multilayer plan przekazuje jeden resolved PBC contract do self/shifted demag kernels i exchange. Brak kompletnej realizacji blokuje plan przed uruchomieniem.

**Tech Stack:** Rust multilayer runner, CUDA convolution/exchange, capability matrix

## Global Constraints

- Zakres obejmuje wszystkie warstwy i interlayer shifts.
- Nie wolno silently fall back do open Neumann.
- CPU double jest oracle; managed CUDA proof jest wymagany.

---

**Finding:** MESH-PBC-FDM-003, P0.

### Task 1: fail-closed guard i RED matrix

- [ ] Natychmiast oznaczyć multilayer PBC unsupported w planner/capability do czasu naprawy.
- [ ] Dodać 2-layer/3-layer fixtures dla periodic X/XY, exchange seam i demag shifted kernels; obecne implementations mają FAIL lub guard.

### Task 2: runtime implementation

```rust
pub struct ResolvedMultilayerPbc { pub axes: [bool; 3], pub images: [u32; 3] }
```

- [ ] Przekazać contract do CPU multilayer reference, CUDA multilayer runner, `multilayer_exchange.cu` i `multilayer_convolution.cu`.
- [ ] Implementować wrapped in-plane neighbors i periodic self/shifted kernels; blokować niewspieraną periodic Z, jeśli plan jej nie dowodzi.
- [ ] Uruchomić CPU/CUDA double parity i single qualification fixtures przez repo `just`; PASS.

### Task 3: provenance/promotion

- [ ] Zapisać per-layer periods, shifts, images i resolved kernels w artifact; odblokować dokładnie zweryfikowane lanes.
- [ ] Commit: `git add docs/specs/capability-matrix-v0.* crates/fullmag-plan crates/fullmag-runner backends/fdm && git commit -m "fix(fdm): implement multilayer periodic interactions"`.

**Exit:** każdy accepted multilayer PBC request używa periodic exchange i demag na wszystkich warstwach; brak otwartego fallbacku.

