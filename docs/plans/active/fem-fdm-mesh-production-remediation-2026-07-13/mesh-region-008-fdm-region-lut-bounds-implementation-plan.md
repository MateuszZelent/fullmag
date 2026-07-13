# MESH-REGION-008 — FDM region LUT bounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Żadna wartość region mask nie może indeksować poza exchange LUT CPU/CUDA, niezależnie od liczby authorowanych regionów.

**Architecture:** Capability contract publikuje jeden limit `MAX_FDM_REGION_IDS`; planner sprawdza aktywne realized IDs i każdą mask value przed utworzeniem planu. C API wykonuje defense-in-depth validation przed kernel launch.

**Tech Stack:** Rust planner/sys ABI, C API, CUDA FP32/FP64

## Global Constraints

- ID 0 pozostaje tłem, więc 256-entry LUT dopuszcza najwyżej 255 aktywnych ID.
- Brak modulo, truncation i silent merge regionów.
- Managed CUDA gate jest obowiązkowym dowodem.

---

**Finding:** MESH-REGION-008, P0.

### Task 1: RED — granica 255/256

- [ ] Dodać planner tests: 255 aktywnych regionów PASS, 256 FAIL; dodać maskę z wartością 256 bez odpowiadającej legendy i C API contract test.
- [ ] Dodać CUDA canary fixture, która nie uruchamia kernel przy invalid mask; potwierdzić RED w obecnym contract.

### Task 2: shared limit i validation

```rust
pub const MAX_FDM_REGION_IDS: u32 = 255;
```

- [ ] Umieścić limit w jednym ABI-owned miejscu i użyć go w plannerze, capability response, sys wrapper i C API.
- [ ] Walidować `max(region_mask) <= MAX_FDM_REGION_IDS`, LUT dimensions oraz wszystkie explicit pair indices przed alokacją/kopiowaniem/launch.
- [ ] Zwracać stable error `fdm_region_lut_capacity_exceeded` z requested i supported count.

### Task 3: managed CPU/CUDA proof

- [ ] Uruchomić planner/sys tests i repozytoryjny managed CUDA FDM gate dla 255-region checksum oraz 256-region rejection; porównać FP32/FP64 behavior.
- [ ] Commit: `git add crates/fullmag-plan crates/fullmag-fdm-sys backends/fdm crates/fullmag-runner && git commit -m "fix(fdm): bound region exchange lookup tables"`.

**Exit:** invalid region ID jest odrzucone przed native allocation i żaden kernel nie odczytuje LUT poza zakresem.
