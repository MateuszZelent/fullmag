# Plan: F8–F11 artefakty, UI, GPU i release

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-corrective-completion-plan.md` z 2026-08-29. Zakres oryginalnych linii: 524–734.

## F8 — Artefakty, API i FMS

**Priorytet:** P0/P1  
**Zależności:** F2 może rozpocząć schema; finalizacja po Q1  
**Cel:** zachować i przenosić dokładnie kwalifikowane wyniki.

### Artefakty obowiązkowe

- `linearization_certificate.v1`;
- `operator_manifest.v1`;
- `spectrum.vNext`;
- `window_certificate.v1` lub selected-only marker;
- `mode_field_complex.vNext`;
- `residual_certificate.v1`;
- `execution_attestation.v1`;
- `scientific_qualification.v1`.

### Identity tuple

Każdy resource kluczowany przez:

```text
run_id
stage_id
artifact_revision
commit_sha
tree_sha
runtime_digest
mesh_generation
magnetic_topology_hash
airbox_topology_hash
equilibrium_digest
operator_digest
engine_id
device_id
phase_convention
normalization_id
```

### Zadania API

1. Typed OpenAPI/resource schema.
2. HTTP jako data plane; realtime tylko invaliduje revision.
3. Żaden status naukowy nie jest wyprowadzany na frontendzie.
4. Atomic publish: manifest pojawia się dopiero po checksumach wszystkich payloadów.
5. Brak ręcznej konkatenacji JSON.
6. Generated client deterministyczny.

### Zadania FMS

1. Export → process restart → import bez źródłowej historii.
2. Spectrum i binary complex mode field muszą być dostępne.
3. CAS integrity, namespace protection, path portability.
4. Rollback bez częściowej mutacji sesji.
5. Wrong revision/source/engine fail-closed.

### Bramka F8

- dwa niezależne FMS E2E;
- fault injection na każdej granicy atomowości;
- API i manifest nie mogą oznaczyć selected-only jako complete.

---

## F9 — Control Room i Q3 browser

**Priorytet:** P1, ale blokuje wydanie produktu UI  
**Zależności:** F8 + Q1  
**Cel:** odtworzyć UI na typed artifacts, bez lokalnej interpretacji fizyki.

### Zadania

1. Results Navigator pokazuje tylko opublikowane resources.
2. Osobne pola/badges:
   - selected/window;
   - complete/not certified;
   - preview/qualified;
   - CPU/GPU engine;
   - residual status.
3. Widmo:
   - brak nazwy „resonance” bez zdefiniowanego kryterium;
   - klastry i degeneracje jawne;
   - brak domyślnego „pierwszy mod = rezonans”.
4. Viewport:
   - zespolone real/imag;
   - phase animation;
   - `Mx/My/Mz/|m|`;
   - signed diverging scale dla składowych;
   - sequential scale dla magnitude;
   - per-object shader ownership.
5. Cache key = pełny identity tuple.
6. Stale revision jest odrzucana.
7. Odzyskać historyczny kod tylko po review względem nowego API; nie cherry-pickować bezpośrednio.

### Q3 live proof

- ten sam immutable CPU artifact co Q1;
- live backend/API;
- import FMS po restarcie;
- 60 s animacji;
- `gl.isContextLost()==false`;
- niezerowy drawing buffer;
- brak rosnącej alokacji/cache per frame;
- screeny widma, wybranego moda, real/imag i komponentów;
- negative stale-revision test.

### Bramka Q3

Browser receipt wiąże commit, runtime, artifact revisions i screen/video evidence.
Brak mocków oraz brak statycznej `m0` udającej pole moda.

---

## F10 — Produkcyjny GPU i Q2

**Priorytet:** P0 dla claimu GPU  
**Zależności:** Q1  
**Cel:** odtworzyć ten sam operator i kryteria na urządzeniu, bez zmiany fizyki.

### Zadania architektoniczne

1. Osobny `slepc_cuda_nearest_v1`.
2. PETSc matrices/vectors w CUDA-compatible types.
3. Persistent object graph:
   - operator blocks;
   - vectors;
   - KSP/PC;
   - HYPRE CUDA policy;
   - workspaces.
4. Brak `cudaMalloc/free`, H2D macierzy i D2H wektorów w matvec loop.
5. Fail-closed przy braku capability.
6. Ten sam full descriptor verifier; CPU i GPU nie mogą mieć różnych tolerancji.
7. Cluster/subspace parity, nie tylko pojedyncze eigenvectors.
8. Cancellation, teardown i repeated-run stability.
9. Bounded CUDA dense oracle pozostaje wyłącznie negative/compatibility testem.

### Profiler-backed telemetry

- H2D/D2H bytes i count;
- synchronizations;
- kernel/SpMV/Poisson/KSP time;
- setup versus solve;
- peak device/host memory;
- EPS iterations;
- KSP solves i total iterations;
- fallback count = 0.

### Q2 cases

1. bounded parity fixture;
2. pośredni real mesh;
3. `operator_dimension > 1024`;
4. pełny antydot na identycznym input/mesh co Q1;
5. trzy rozmiary;
6. sanitizery i repeated 50/50 lifecycle.

### Proponowane kryteria parity

- częstotliwości izolowanych modów: relative difference ≤ 1e-6 dla FP64 bounded case;
- pełne residuale: oba poniżej tej samej tolerancji;
- klastry: zgodny wymiar i principal-angle threshold z ADR;
- żaden mod nie może przechodzić tylko na jednym engine bez jawnego reason;
- transfer/fallback policy spełniona w niezależnym trace.

### Bramka Q2

- profiler artifact i solver attestation zgadzają się;
- brak host fallback;
- parity + convergence + cancellation zielone;
- zero unresolved P0 GPU.

---

## F11 — Immutable release candidate, pełna regresja i G2

**Priorytet:** P0  
**Zależności:** Q1 + Q2 + Q3  
**Cel:** scalić dokładnie to, co było testowane.

### Zadania

1. Zamrozić candidate:
   - commit;
   - tree;
   - toolchain;
   - dependencies;
   - container/runtime;
   - build recipes.
2. Wykonać pełną macierz negatywną:
   - stale mesh/revision;
   - wrong engine;
   - incomplete window;
   - failed equilibrium;
   - unsupported physics/BC;
   - missing GPU;
   - cancellation;
   - corrupted artifact.
3. Wygenerować DoD manifest.
4. Jeżeli `master` się zmienił, scalić i powtórzyć od najwcześniejszej unieważnionej bramki.
5. PR bez build artifacts, lokalnych symlinków i obcych zmian.
6. Brak force-push podczas finalnej kwalifikacji.
7. Governance promotion dotyka tylko jawnej allowlisty.

### Bramka G2

- wszystkie wymagane DoD `PASS`;
- brak `pending`, `historical-only` i `manual assertion`;
- `master` po merge wskazuje dokładnie zweryfikowane drzewo;
- CI po merge zielone;
- receipts odwołują się do merge commit/tree zgodnie z polityką.
