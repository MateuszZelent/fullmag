# 09. Kolejność PR, testy i Definition of Done

## 1. Reguła

Każdy PR ma jeden główny mechanizm, test/licznik przed optymalizacją,
compatibility path, managed GPU A/B i nie zmienia tolerancji razem z kernelem.

## 2. Sekwencja

### PR-00 — baseline i snapshot

Runtime performance owner, ABI v1 i SP4 managed benchmark. Zachować istniejący
strict receipt, execution masks, transfer audit, step stats, endpoint telemetry
i phase event ownership; nie implementować ich ponownie. Zachować istniejący
Ada-specific gate exportera (`8.9`, `fullmag_fem=sm_89`, `hypre=sm_89`), a
stałe wymaganie `sm_89` zastąpić mapowaniem wykrytego compute capability i
zapisać wynik z digestem bundle w immutable benchmark receipt.

### PR-01 — HYPRE owner + conditional RHS norm

Usuwa duplicate setters; omija normę w converged relative-only.

### PR-02 — demag FieldOnly

Zero stage energy w RK, final energy parity.

### PR-03 — LLG no-metric + output mask v2

Bez intermediate reduction; control stopping nadal działa.

### PR-04 — deferred normalizer + control packet

Zero normalizer readbacks; one fence/attempt; rollback.

### PR-05 — adaptive specializations

ErrorOnly bez acos; one typed reduction.

### PR-06 — BS23 endpoint reuse

Warm accepted = 3 RHS/3 demag.

### PR-07 — DP54 exact endpoint + FSAL slot

Exact state, no duplicate RHS/copy.

### PR-08 — fused exchange xyz

Row scale, offdiag CSR, strict fused kernel.

### PR-09 — accumulation variants + row mapping

Qualified accurate mode and static profiles.

### PR-10 — periodic reduced exchange

No O(N²), full field/energy/direct-energy parity.

### PR-11 — fused recovery + H_eff

Shared pattern recovery, compose launches, lazy fields.

### PR-12 — typed multi-channel reductions

Adaptive/Armijo/NCG proofs.

### PR-13 — NCG preconditioner

Diagonal first, correct PR+, time-to-tolA.

### PR-14 — purpose-dependent Poisson tolerance

Dopiero po pełnej kwalifikacji; default bez zmian.

### PR-15 — operator planner/PA

Qualified profile i break-even.

## 3. Testy każdego PR

Statyczne:

- source ownership,
- ABI layout,
- forbidden sync/allocation,
- CMake registration.

Actual GPU:

- operator fixture,
- accepted step,
- reject/failure,
- SP4 smoke,
- transfer/receipt snapshot.

Fizyka:

- field/energy,
- residual,
- macrospin/norm,
- damping energy,
- trajectory,
- PBC/frozen, gdy dotyczy.

## 4. A/B policy

- identyczny mesh digest,
- 8 warmup,
- >=31 micro repeats albo 64 steps,
- median/p95,
- bez GUI dla solver benchmarku,
- pełny device/build provenance.

Proponowane początkowe progi po zmierzeniu szumu:

```text
correctness/receipt fail -> block
median > 1.03 baseline -> investigate/block
p95 > 1.10 baseline -> investigate
work counter grows unexplained -> block
```

## 5. Managed commands

Zawsze sprawdzić aktualny `justfile`. Typowa sekwencja:

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just verify-fem-demag-poisson-contract
just verify-fem-time-domain-native-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-cpu-gpu-consistency-smoke
just fem-sp4-run gpu <output_dir>
```

Jeżeli target zmienił nazwę, użyć aktualnego odpowiednika z `just --list`.
Nie zastępować host buildem.
`fem-managed-headless` jest alternatywnym managed entrypointem.
`fem-gpu-headless` jest ścieżką ad hoc/diagnostyczną i nie spełnia tej bramki.

## 6. Dokumenty przy merge

- `docs/architecture/backend-golden-masterplan.md`
- `docs/physics/0560-all-in-gpu-fem-runtime.md`
- właściwe exchange/demag/RK/relaxation docs
- `docs/specs/capability-matrix-v0.md`
- provenance schema
- benchmark index.

## 7. Rollback

Każdy nowy operator ma compatibility implementation podczas kwalifikacji.
Rollback przełącza planner na poprzedni qualified kind i zachowuje telemetrię.
Niewalidowany feature flag nie jest publicznym production option.

## 8. Final DoD

Wykonanie:

```text
execution_class=device_resident
host_mask=0
unknown_mask=0
bulk hot-loop transfer=0
global sync=0
```

Warm no-reject RK23:

```text
rhs=3
demag_solves=3
exchange_applies=3
exchange_kernel_launches=3
stage_demag_energy=0
normalizer_readbacks=0
adaptive_readbacks=1
```

PBC:

```text
O(nnz_reduced + N lift)
no full source-row scan
```

Poprawność:

- operator/energy derivative,
- residual,
- temporal order,
- SP4,
- Armijo,
- frozen/PBC.

Produkcja:

- cubin matches GPU,
- actual-device CI,
- docs/capability/provenance,
- compatibility removal condition.
