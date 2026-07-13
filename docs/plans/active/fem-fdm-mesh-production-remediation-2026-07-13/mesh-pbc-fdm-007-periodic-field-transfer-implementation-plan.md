# MESH-PBC-FDM-007 — Periodic FDM field transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Używać periodic wrap zamiast clamp podczas interpolation/transfer na aktywnych osiach PBC.

**Architecture:** Transfer API przyjmuje resolved boundary policy per axis. Interpolation używa modulo dla osi periodic i dotychczasowego clamp dla osi open; ten sam kontrakt obowiązuje forward i reverse transfer.

**Tech Stack:** Rust FDM demag transfer, interpolation tests

## Global Constraints

- Boundary policy pochodzi z resolved PBC, nie globalnego defaultu.
- Open-axis behavior pozostaje bez zmian.
- Transfer artifact zapisuje source/target grid fingerprints i boundary policy.

---

**Finding:** MESH-PBC-FDM-007, P1.
**Files:** `crates/fullmag-fdm-demag/src/transfer.rs`, jego test module, callers w runner/engine przekazujący grid/PBC contract.

### Task 1: RED seam interpolation

- [ ] Dodać 1D/2D fixtures z impulse na ostatniej komórce, sample po drugiej stronie seam i mixed periodic/open axes; periodic ma pobrać pierwszy/ostatni neighbor, open ma clampować.
- [ ] Uruchomić `cargo test -p fullmag-fdm-demag transfer -- --nocapture`; periodic cases mają FAIL.

### Task 2: boundary-aware indices

```rust
fn transfer_index(i: isize, n: usize, periodic: bool) -> usize {
    if periodic { i.rem_euclid(n as isize) as usize } else { i.clamp(0, n as isize - 1) as usize }
}
```

- [ ] Zastąpić sześć bezwarunkowych clamp calls helperem i przekazać axes policy przez oba transfer directions.
- [ ] Dodać conservation/constant-field tests i uruchomić pełny crate test; PASS.

### Task 3: integration/provenance

- [ ] Dodać runner integration fixture z resolved PBC i artifact assertions source/target fingerprint.
- [ ] Commit: `git add crates/fullmag-fdm-demag crates/fullmag-runner && git commit -m "fix(fdm): wrap periodic field transfers"`.

**Exit:** interpolation zawija tylko aktywne periodic axes; seam fixtures i open regression są zielone.

