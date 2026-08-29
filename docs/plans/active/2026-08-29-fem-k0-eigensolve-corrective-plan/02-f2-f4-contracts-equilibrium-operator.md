# Plan: F2–F4 kontrakty, równowaga i operator

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-corrective-completion-plan.md` z 2026-08-29. Zakres oryginalnych linii: 202–374.

## F2 — Zamrożenie modelu, statusów i ABI vNext

**Priorytet:** P0  
**Zależności:** F1  
**Cel:** zatrzymać drift kontraktów przed kolejnymi poprawkami.

### Zadania ABI

1. Nowe typy vNext, bez dalszego dopisywania pól do starego requestu:
   ```c
   struct FullmagFemModalEigenRequestVNext {
       uint32_t abi_version;
       uint32_t struct_size;
       uint64_t flags;
       uint64_t reserved[4];
       ...
   };
   ```
2. Wspólny decoder prefiksu z checked extents/alignment.
3. Jawne:
   - `execution_lane`;
   - `engine_id`;
   - `device_policy`;
   - `fallback_policy`;
   - `phase_convention`;
   - `selection_scope`;
   - `completeness_policy`;
   - `scalar_kind`;
   - source/artifact identity.
4. Layout introspection dla request/result/certificate.
5. Generated bindings z jednego schema.

### Zadania statusów

Rozdzielić:

| Pole | Znaczenie |
|---|---|
| `solve_status` | czy algorytm zakończył się poprawnie |
| `selection_scope` | nearest/selected versus region/window |
| `convergence_status` | full/partial/not_converged/cancelled |
| `window_status` | not_applicable/not_certified/complete/incomplete |
| `qualification_status` | preview/conditional/qualified/rejected |
| `artifact_status` | committed/failed/not_requested |

### Zadania taksonomii

- validation oracle nie może używać `production`;
- GPU action parity nie może nazywać się pełnym eigensolverem;
- JSON diagnostyczny nie steruje kodem.

### Testy

- ABI compatibility matrix;
- fuzz/truncated struct;
- planner legality;
- schema round-trip;
- unknown enum fail-closed;
- no string-substring feature gates.

### Bramka F2

- jedno zatwierdzone ADR;
- wszystkie entrypointy przechodzą przez vNext decoder;
- stare ABI jest zamrożone i oznaczone deprecated;
- żaden status nie ma dwóch znaczeń.

---

## F3 — Certyfikat równowagi i spójności fizycznej

**Priorytet:** P0  
**Zależności:** F2  
**Cel:** udowodnić, że operator jest liniaryzacją dokładnie tego stanu.

### Zadania

1. Zbudować `LinearizationCertificateV1` zawierający:
   - `m0_digest`;
   - recomputed `H_eff0` i digest każdego składnika;
   - magnetic mesh + airbox mesh + embedding;
   - region/material/physics snapshot;
   - BC/gauge/PBC certificate;
   - DOF ordering;
   - rzeczywistą tangent mass;
   - tangent frame digest;
   - solver/operator build identity.
2. Wyłączyć cichą renormalizację `m0`.
3. Opcjonalna renormalizacja tworzy nowy equilibrium artifact i pełny recompute.
4. Recompute pola przy użyciu tej samej implementacji co operator.
5. Raportować:
   - nodal `L∞` torque;
   - mass-weighted `L2`;
   - algebraic tangent residual;
   - relative component-wise residual.
6. Egzekwować każdą opcję z `LinearizationBuildOptions` albo ją usunąć.
7. Zmontować rzeczywistą mass matrix/lumping dla Tet4/Prism6.
8. Dla PBC: topologiczny certyfikat bijekcji/orientacji/translacji/regionów.
9. Porównywać mody w kartezjańskiej przestrzeni FE lub używać frame-aware transform.

### Proposed initial thresholds

Wartości muszą być zapisane w ADR i mogą zostać skorygowane po convergence study:

- `max | |m0|-1 | <= 1e-10` bez renormalizacji;
- full algebraic equilibrium residual zgodny z user-specified qualification tolerance;
- brak niezależnego hardcoded floor;
- wszystkie pola finite;
- suma lumped mass zgodna z objętością w tolerancji assembly.

### Testy

- mismatch każdego digesta;
- stale airbox/mesh generation;
- zmieniony BC/gauge;
- renormalization mutation;
- nierównomierny mesh;
- frame threshold sweep;
- analytical uniform state.

### Bramka F3

- bez ważnego certyfikatu żaden production engine nie startuje;
- wszystkie mutation tests fail-closed;
- user relaxation stop i qualification są osobnymi polami.

---

## F4 — Produkcyjny operator sparse/matrix-free

**Priorytet:** P0  
**Zależności:** F3  
**Cel:** usunąć dense-first z production lane.

### Zadania

1. Oddzielić fabryki:
   - `build_bounded_dense_oracle`;
   - `build_production_sparse_operator`.
2. Assembly lokalnych składników bezpośrednio do MFEM/PETSc sparse z prealokacją.
3. Dynamiczny demag:
   - sparse `A_qphi`, `A_phiq`, `A_phiphi`;
   - persistent Poisson KSP/PC;
   - Schur action bez explicit dense matrix.
4. `B_qq`/mass jako sparse operator; overlap przez matvec.
5. Jeden ordering DOF i jawny mapping do artefaktów.
6. Brak `N×N` dense allocation na produkcyjnej ścieżce.
7. Wprowadzić lifecycle context:
   - setup;
   - repeated apply;
   - teardown;
   - cancellation.
8. Wymagane capabilities dla adjoint tylko tam, gdzie naprawdę wspierane.
9. Telemetria z rzeczywistych eventów, nie claimów.

### Testy

- dense oracle parity na małym N;
- randomized action parity;
- symmetry/skew/structure tests tam, gdzie fizyka je gwarantuje;
- Tet4/Prism6 element matrices;
- no-allocation-in-hot-loop;
- three-size memory scaling;
- Poisson setup count = 1.

### Bramka F4

- production path ma pamięć `O(nnz + N*k)`, nie `O(N²)`;
- brak basis probing do utworzenia pełnego operatora;
- wszystkie operator terms mają typed capability/identity.

---
