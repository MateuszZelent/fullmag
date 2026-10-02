# Ogólny plan doprowadzenia FEM Fredkin–Koehler do produkcyjnego CPU i GPU

**Data:** 1 września 2026  
**Stan bazowy:** `master@ed1fd1c7d2513ea2f7f6e12ddb2d4f3e2fc6a267`  
**Status dokumentu:** aktywny plan nadrzędny  
**Audyt wejściowy:** [audyt CPU/GPU Fredkin–Koehler](../../audits/fem-fredkin-koehler-cpu-gpu-audit-2026-09-01.md)  
**Playbook wykonawczy:** [szczegółowy plan wdrożenia](fem-fredkin-koehler-cpu-gpu-implementation-playbook-2026-09-01.md)

---

## 1. Cel

Doprowadzić `Demag(model="fredkin_koehler")` do dwóch jawnie rozdzielonych zdolności:

1. **produkcja CPU** — poprawny fizycznie, zwalidowany, bezpieczny pamięciowo i skalowalny operator FEM/BEM bez airboxu;
2. **produkcja strict GPU** — w pełni device-resident pipeline `m -> H_demag, E_demag`, bez ukrytego fallbacku CPU i bez transferów w hot loop.

Plan nie zmienia fizycznego modelu publicznego. Użytkownik nadal wybiera:

```python
fm.Demag(model="fredkin_koehler")
```

Planner i runtime rozstrzygają operator, urządzenie i politykę wykonania, a requested intent oraz resolved execution pozostają zapisane w provenance.

---

## 2. Stan początkowy

### 2.1. CPU

Zaimplementowano dense-reference Fredkin–Koehler:

```text
u1 Neumann solve
-> dense Lindholm boundary apply
-> u2 Dirichlet solve
-> H = -grad(u1+u2)
-> E = -mu0/2 int M.H
```

Kod ma poprawny rdzeń znaków i dwa cache solverów, ale nie przechodzi jeszcze pełnej kwalifikacji. Najpilniejsze luki:

- niepełna powierzchnia BEM może zostać zaakceptowana;
- tylko jeden gauge dla dowolnej liczby rozłącznych ciał;
- brak pełnej walidacji fizycznej;
- brak bezpiecznego limitu dense;
- `O(N_b^2)` pamięci i apply;
- niepotrzebna praca i alokacje w każdym odświeżeniu pola;
- brak pełnej telemetrii BEM.

### 2.2. GPU

Strict GPU jawnie odrzuca Fredkina–Koehlera. Dostępny tryb hybrydowy pobiera `m` na host, wykonuje CPU FEM/BEM i odsyła `H_demag`. To pozostaje trybem kompatybilnościowym, nie zdolnością GPU.

---

## 3. Decyzje architektoniczne

### 3.1. Dense pozostaje oracle, nie produkcyjnym domyślnym operatorem

Gęsty operator:

- jest najprostszym numerycznym punktem odniesienia;
- powinien działać na CPU i GPU dla małych granic;
- musi mieć jawny limit pamięci;
- nie może być automatycznie wybierany dla dużego `N_b`.

### 3.2. Docelowa skalowalność to H2 lub FMM

Wersja produkcyjna musi zapewnić co najmniej:

```text
memory: O(N_b) lub O(N_b log N_b)
apply:  O(N_b log N_b) lub lepiej
```

Wybór między H2 i FMM zostanie zamknięty po prototypach i pomiarach. H2 jest preferowanym pierwszym kandydatem, ponieważ bezpośrednio kompresuje istniejący operator graniczny i ma opublikowane zastosowanie do metody Fredkina–Koehlera.

### 3.3. Jedna fizyka, wiele realizacji operatora

Nie powstaną osobne równania CPU i GPU. Wspólne pozostają:

- kanoniczna topologia granicy,
- definicja gauge,
- operator źródła,
- operator stiffness,
- gather/scatter,
- recovery,
- energia,
- testy.

Różni się wyłącznie sposób przechowywania i wykonania.

### 3.4. GPU oznacza device source of truth

Strict GPU spełnia:

```text
no D2H/H2D in RK/relax hot loop
no host sparse solve
no host BEM apply
no hidden CPU recovery
no host energy reduction
```

Hybrydowy fallback ma osobny resolved mode i receipt.

### 3.5. Najpierw poprawność CPU, potem GPU

Nie wolno portować na GPU niezamkniętej topologii i gauge. Kolejność jest obowiązkowa:

```text
correctness contract
-> CPU numerical oracle
-> shared discrete operators
-> CPU performance
-> dense GPU reference
-> compressed CPU/GPU production
```

---

## 4. Strumienie prac

## Strumień A — utwardzenie poprawności CPU

Zakres:

- dokładny zewnętrzny zbiór ścian;
- closure/manifold/orientation;
- spójne składowe objętości;
- gauge per component;
- jawny `TET4/P1/non-periodic` gate;
- scale-aware geometry;
- failure-atomic initialization;
- dense memory cap.

**Wynik:** mały, bezpieczny `dense_cpu_reference`, którego można używać jako oracle.

## Strumień B — kwalifikacja fizyczna

Zakres:

- zero source;
- kula;
- elipsoida;
- prostopadłościan;
- dwa oddzielne ciała;
- zbieżność `h`;
- transformacje geometryczne;
- energy-field directional derivative;
- airbox extrapolation;
- zewnętrzna fixture Tetmag.

**Wynik:** status `validated_reference` CPU.

## Strumień C — wspólne operatory i optymalizacja CPU

Zakres:

- `DemagBoundaryOperator` interface/factory;
- preasemblowane `B_x/B_y/B_z`;
- preasemblowane `R_x/R_y/R_z`;
- trwałe wektory;
- bulk Dirichlet elimination/lifting;
- BLAS dense apply;
- spójna polityka wątków/NUMA;
- szczegółowa telemetria.

**Wynik:** szybszy oracle, brak alokacji w warm hot path, infrastruktura wspólna z GPU.

## Strumień D — skompresowany operator CPU

Zakres:

- klasteryzacja przestrzenna;
- admissibility;
- dokładny near field;
- low-rank far field;
- kontrola tolerancji kompresji;
- serializacja/cache operatora;
- porównanie H2 z dense.

**Wynik:** `h2_cpu` albo `fmm_cpu`, pozwalający promować CPU do `production_executable`.

## Strumień E — dense strict GPU reference

Zakres:

- device topology view;
- device CSR dla źródła, liftingu i recovery;
- dwa cache device Hypre;
- device gather/scatter;
- cuBLAS `DGEMV`;
- device energy reduction;
- transfer audit i failure atomicity.

**Wynik:** `dense_gpu_reference`, parity z CPU dla małych siatek.

## Strumień F — skompresowany operator GPU

Zakres:

- H2/FMM na urządzeniu;
- batched small dense blocks;
- exact near field;
- compressed far field;
- stream-aware execution;
- device memory budget;
- crossover policy.

**Wynik:** `h2_gpu` lub `fmm_gpu`, pozwalający promować strict GPU do `production_executable`.

## Strumień G — produkt, provenance i rollout

Zakres:

- capability matrix;
- Python/IR/planner/runner;
- resolved operator mode;
- diagnostyka błędów;
- quantities i artifacts;
- dokumentacja publiczna;
- benchmark receipts.

**Wynik:** użytkownik widzi prawdziwy model i faktyczną realizację, bez mylenia fallbacku z GPU.

---

## 5. Fazy i bramki

## Faza 0 — zamrożenie prawdy o stanie

**Zmiany:**

- status CPU: `reference_executable`;
- status strict GPU: `unsupported`;
- hybrydowy CPU fallback: `compatibility`;
- dense cap wymagany przed dalszym użyciem;
- jeden rejestr ustaleń i benchmark manifest.

**Gate wyjściowy:**

- brak sprzecznych twierdzeń w docs/capability;
- każda realizacja ma jednoznaczny `requested/resolved`;
- nie ma automatycznej promocji `auto` na Fredkina–Koehlera.

## Faza 1 — P0/P1 correctness

**Zmiany:**

- pełny zewnętrzny brzeg;
- manifold closure;
- gauge per component;
- runtime topology gate;
- robust Lindholm errors;
- failure-atomic setup.

**Gate wyjściowy:**

- malformed meshes failują przed alokacją operatora;
- dwa oddzielne obiekty rozwiązują się jednoznacznie;
- operator jest deterministyczny dla permutacji wejścia;
- nie ma częściowo opublikowanego workspace po błędzie.

## Faza 2 — validated dense CPU oracle

**Zmiany:**

- analityczne i numeryczne fixtures;
- energy derivative;
- `h`-refinement;
- niezależne porównanie.

**Gate wyjściowy:**

- zaakceptowany raport walidacyjny;
- tolerancje wynikają z krzywych zbieżności, nie z arbitralnej liczby;
- dense cap jest oparty o pomiar pamięci/czasu.

## Faza 3 — shared operator refactor + CPU hot path

**Zmiany:**

- abstrakcja operatora;
- preassembled source/recovery;
- persistent buffers;
- BLAS i thread ownership;
- telemetry.

**Gate wyjściowy:**

- zero alokacji po warm-upie;
- jedno hashowanie/fingerprint na zmianę zasobu, nie na solve;
- brak atomików w recovery;
- cold/warm profile rozdzielony.

## Faza 4 — scalable CPU

**Zmiany:**

- H2/FMM;
- cache/serialization;
- kontrola błędu;
- NUMA i opcjonalnie MPI roadmap.

**Gate wyjściowy:**

- błąd względem dense oracle w zadanej tolerancji;
- pamięć nie rośnie kwadratowo;
- produkcyjny rozmiar fixture mieści budżet runtime;
- poprawa czasu do tej samej dokładności fizycznej.

## Faza 5 — dense strict GPU

**Zmiany:**

- pełny device pipeline z cuBLAS i Hypre GPU.

**Gate wyjściowy:**

- parity wszystkich stanów pośrednich;
- zero ukrytych transferów;
- zero host fallback;
- failure nie publikuje częściowego pola;
- device memory receipt.

## Faza 6 — scalable strict GPU

**Zmiany:**

- H2/FMM GPU;
- auto-selection według rozmiaru i budżetu;
- stream integration.

**Gate wyjściowy:**

- parity z dense oracle;
- crossover benchmark;
- kontrola kompresji;
- stabilny warm-step performance.

## Faza 7 — promocja produktu

**Zmiany:**

- capability `production_executable`;
- public docs;
- UI/API diagnostics;
- `auto` rozważane dopiero po dowodach.

**Gate wyjściowy:**

- wszystkie receipts obecne w repo;
- CPU/GPU parity i performance są zaakceptowane;
- brak nierozwiązanych P0/P1.

---

## 6. Docelowe tryby operatora

```text
dense_cpu_reference
dense_gpu_reference
h2_cpu
h2_gpu
fmm_cpu        # opcjonalny/prototyp
fmm_gpu        # opcjonalny/prototyp
hybrid_cpu_compatibility
```

Minimalny resolved receipt:

```json
{
  "demag_model": "fredkin_koehler",
  "boundary_operator_mode": "h2_gpu",
  "execution_residency": "device",
  "boundary_nodes": 0,
  "boundary_triangles": 0,
  "magnetic_components": 0,
  "gauge_policy": "component_mean_zero",
  "operator_bytes": 0,
  "compression_tolerance": null,
  "compression_ratio": null,
  "linear_solver_u1": "hypre_pcg_boomeramg",
  "linear_solver_u2": "hypre_pcg_boomeramg",
  "hot_loop_host_transfer_bytes": 0
}
```

---

## 7. Zasady wydajności

### 7.1. Metryka nadrzędna

Nie optymalizujemy procentu zajętości CPU/GPU jako celu samego w sobie. Metryką jest:

```text
czas do osiągnięcia tej samej dokładności H_demag/E_demag
```

Raportować należy:

- setup i warm apply osobno;
- p50/p95 czasu faz;
- iteracje i residuale obu solve’ów;
- bytes i bandwidth;
- alokacje;
- transfery;
- kompresję;
- błąd względem oracle.

### 7.2. CPU

- jeden właściciel wątków na fazę;
- brak oversubscription OpenMP + BLAS + Hypre;
- topology-aware affinity;
- first-touch/NUMA;
- preasemblowane sparse operators;
- H2 zamiast gęstej macierzy;
- opcjonalny MPI dopiero po zakończeniu operatora lokalnego.

### 7.3. GPU

- device source of truth;
- persistent allocation;
- stream-aware Hypre/cuBLAS;
- no host synchronization między fazami, jeśli nie jest wymagana;
- exact near-field + compressed far-field;
- quantity readback poza hot loop.

---

## 8. Strategia testów

Warstwy testów:

1. **topology contract** — dokładne zbiory ścian, komponenty, gauge;
2. **kernel unit** — solid angle i Lindholm golden values;
3. **discrete manufactured** — zadane `u`, kontrolowany operator;
4. **physics validation** — kula, elipsoida, dwa ciała;
5. **energy consistency** — directional derivative;
6. **CPU/GPU parity** — `rhs1`, `u1`, trace, BEM output, `u2`, `H`, `E`;
7. **compression parity** — H2/FMM vs dense;
8. **performance** — cold/warm, scaling, transfers, allocations;
9. **failure atomicity** — OOM/cancel/nonconvergence nie publikuje stanu.

---

## 9. Rollback i kompatybilność

- `Demag(model="auto")` nie zmienia zachowania w trakcie prac.
- `fredkin_koehler` może zacząć odrzucać wcześniej akceptowane niepoprawne powierzchnie; jest to naprawa poprawności.
- Dense cap może odrzucić duże przypadki, które wcześniej kończyły się OOM; komunikat ma wskazać H2/FMM lub airbox.
- Hybrydowy fallback pozostaje dostępny wyłącznie przy jawnym wyborze/polityce kompatybilności.
- Każdy nowy tryb ma osobny provenance i capability status.
- Nie kopiować kodu Tetmag objętego AGPL; używać publikacji i zewnętrznych wyników jako oracle.

---

## 10. Definicja zakończenia całego planu

Plan jest zakończony dopiero, gdy:

- CPU i strict GPU mają skalowalny operator;
- wszystkie P0/P1 z audytu są zamknięte;
- dense CPU/GPU są zachowane jako małe oracle;
- H2/FMM przechodzi parity z dense;
- kula/elipsoida/dwa ciała i energy derivative przechodzą;
- strict GPU nie wykonuje transferów w hot loop;
- cold/warm benchmarki i memory receipts są w repo;
- capability i public docs są zgodne;
- domyślna polityka wyboru operatora jest oparta na zmierzonym crossover, a nie na zgadywanym progu.
