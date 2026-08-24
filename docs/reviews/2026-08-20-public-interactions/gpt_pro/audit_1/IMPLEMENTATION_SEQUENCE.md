# Kolejność implementacji remediacji LLG

Kolejność poniżej minimalizuje ryzyko wykonywania optymalizacji na niepoprawnym kontrakcie i ogranicza równoległe modyfikacje tych samych właścicieli stanu.

## Fala 0 — natychmiastowe blokery correctness/build

1. `FDM-CPU-NUM-001` — retry adaptacyjny musi zawsze robić postęp albo kończyć typed failure.
2. `FDM-GPU-ABI-001` — wyrównanie C ABI/Rust FFI i obowiązkowy feature build.
3. `FDM-GPU-NUM-003` — zakaz FSAL dla termiki i nieważnych źródeł.
4. `FEM-GPU-PERF-009` — strict GPU nie może wykonywać pełnego round-trip do CPU Poisson.
5. `FDM-GPU-ARCH-001` i `FEM-GPU-ARCH-001` — requested/resolved/executed receipts i fail-closed.

**Gate wyjściowy:** wszystkie P0 mają reproducer, test regresyjny i nie mogą przejść przez fallback.

## Fala 1 — transakcje i ownership

- `FDM-CPU-TRX-001`
- `FDM-GPU-TRX-001`
- `FEM-CPU-PERF-002`
- `FEM-CPU-PERF-003`
- `FEM-GPU-TRX-001`
- `FEM-CPU-ARCH-001`

**Gate wyjściowy:** fault-injection po każdym istotnym etapie nie zmienia authoritative accepted state; retry termiczny zachowuje raw draw identity.

## Fala 2 — usunięcie kosztów, które fałszują benchmark

- obserwable/stats: `FDM-CPU-PERF-001`, `FDM-GPU-PERF-002`, `FEM-GPU-PERF-008`;
- alokacje/kopie: `FDM-CPU-PERF-002`, `FDM-GPU-PERF-004`, `FEM-GPU-PERF-002`;
- final endpoint recompute: `FEM-CPU-PERF-006`, `FEM-GPU-PERF-007`;
- adaptive host sync: `FDM-GPU-PERF-001`, `FEM-GPU-PERF-006`;
- GPU scalar/stop reductions: `FEM-GPU-PERF-004`.

**Gate wyjściowy:** steady-state hot loop ma jawny budżet alokacji, operator evaluations, transferów i synchronizacji.

## Fala 3 — operatory i solver pomocniczy

- FEM setup/apply: `FEM-CPU-PERF-001`;
- mass solve: `FEM-CPU-PERF-004`;
- Poisson reuse: `FEM-CPU-PERF-005`;
- preconditioner device: `FEM-GPU-PERF-005`;
- matrix-free/PA: `FEM-GPU-PERF-003`;
- FFT CPU/GPU: `FDM-CPU-PERF-003`, `FDM-GPU-PERF-004`.

**Gate wyjściowy:** setup/rebuild count jest revision-driven; linear tolerances są powiązane z błędem LLG.

## Fala 4 — fizyka i parity realizacji

- DMI boundary: `FDM-CPU-PHY-001`, `FDM-GPU-PHY-001`;
- material fields/thermal: `FDM-CPU-PHY-002`, `FDM-GPU-PHY-001`;
- AoS/SoA: `FDM-CPU-ARCH-001`;
- FEM material/Airbox/PBC: `FEM-CPU-PHY-001`, `FEM-GPU-PHY-001`;
- projected RK: `FDM-CPU-NUM-002`, `FEM-GPU-NUM-003`;
- adaptive norms: `FDM-GPU-NUM-001`, `FEM-CPU-NUM-001`.

**Gate wyjściowy:** field, energy derivative, RHS, stage, step i trajectory parity przechodzą na named fixtures.

## Fala 5 — time-to-solution

- stiffness/integrators: `FEM-CPU-NUM-002`, `FEM-GPU-NUM-002`;
- precision policies: `FDM-GPU-NUM-002`, `FEM-GPU-NUM-001`;
- kernel fusion/graphs: `FDM-GPU-PERF-003`, `FEM-GPU-PERF-010`;
- CPU thread/NUMA: `FEM-CPU-PERF-007`;
- ABM3: `FDM-CPU-NUM-003`.

**Gate wyjściowy:** benchmark mierzy wall-clock do ustalonego błędu fizycznego, nie sam throughput kroku.

## Fala 6 — qualification i promotion

- `FDM-CPU-QUAL-001`
- `FDM-GPU-QUAL-001`
- `FEM-CPU-QUAL-001`
- `FEM-GPU-QUAL-001`

Capability może otrzymać status `qualified` wyłącznie dla dokładnie przetestowanej kombinacji backendu, device class, precision, integratora, operator realization i aktywnych interakcji.
