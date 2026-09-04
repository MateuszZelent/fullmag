# Projekt fazy 1: FEM GPU direct minimizers i preconditioning

- Status: projekt zatwierdzony koncepcyjnie; oczekuje przeglądu spisanej wersji
- Data: 2026-09-04
- Gałąź: `codex/fem-gpu-tasks1-5-remediation`
- Zakres: FEM GPU, `nonlinear_cg`, `projected_gradient_bb`, `double`
- Powiązany ADR: `docs/adr/0030-fem-gpu-direct-minimizer-execution-evidence.md`
- Powiązany projekt evidence:
  `docs/superpowers/specs/2026-09-04-fem-gpu-ncg-receipt-v2-snapshot-v3-design.md`
- Kanoniczna nota numeryczna do skorygowania przed implementacją:
  `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md`

## 1. Decyzja

Faza 1 zamyka wyłącznie dwa istniejące direct minimizers FEM GPU:

1. `nonlinear_cg` (NCG);
2. `projected_gradient_bb` (PG-BB).

Oba algorytmy otrzymują wspólny, prawdziwy kontrakt preconditioningu oraz
niezależne dowody wykonania, poprawności i wydajności. Kolejność evidence
pozostaje NCG-first: receipt v2 i snapshot v3 są najpierw wdrażane oraz
kwalifikowane dla NCG zgodnie z ADR 0030. PG-BB wykorzystuje później ten sam
wersjonowany model identity i lifecycle, ale przechodzi własne bramy.

Faza 1 nie obejmuje GPU tangent-plane implicit (TPI) ani manifold L-BFGS.
Powstaną dla nich osobne projekty po zamknięciu tej fazy.

## 2. Ustalony stan obecny

| Obszar | Stan źródła | Wykonywalność | Walidacja | Wniosek |
|---|---|---|---|---|
| NCG CUDA | istnieje w `gpu/cuda/relaxation/nonlinear_cg.cpp` | development executable | brak kwalifikującego receipt v2/snapshot v3, parity i pięciu powtórzeń | `NOT VERIFIED` |
| PG-BB CUDA | istnieje w `gpu/cuda/relaxation/pgbb.cpp` | development executable | brak osobnej kwalifikacji direct-minimizer | `NOT VERIFIED` |
| `diagonal` | mnożenie punktowe istnieje | nie jest skonfigurowane przez runtime | tylko test diagonalny | nieaktywna implementacja eksperymentalna |
| `exchange_mass` | nazwa i enum istnieją | brak pełnego sparse solve i brak runtime `setup()` | test używa wyłącznie macierzy diagonalnej | błędnie nazwane, `NOT IMPLEMENTED` |
| TPI FEM GPU | brak ścieżki GPU | unsupported | brak | poza fazą 1 |
| L-BFGS | brak implementacji | roadmap | brak | poza fazą 1 |

Audyt kodu wykazał cztery błędy wymagające korekty przed dalszym pomiarem:

1. `GpuExchangeMassPreconditioner` używa tylko przekątnych $M$ i $K$ oraz
   wykonuje mnożenie przez $M_{ii}/(M_{ii}+wK_{ii})$. Jest to aproksymacja
   diagonalna/Jacobiego, a nie rozwiązanie $(M+wK)^{-1}M$.
2. `GpuExchangeMassPreconditioner::setup()` jest wywoływane tylko w teście.
   W produkcyjnym NCG i PG-BB `is_active()` pozostaje więc fałszywe.
3. NCG i PG-BB ignorują wartość zwrotną oraz tekst błędu z
   `apply_device_component()`; ścieżka nie jest fail-closed.
4. Test `ManufacturedSpdMatrix` zawiera wyłącznie `diag`, więc nie potrafi
   odróżnić pełnego sparse solve od mnożenia diagonalnego.

Dodatkowo benchmark jawnie mapuje `exchange_mass` na `None` i odrzuca tę
strategię. Raport
`docs/audits/2026-09-02-fem-gpu-solver-completion.md` nie ma zatem podstaw do
oznaczenia Tasku 10 jako `VERIFIED` ani do tezy o redukcji kroków NCG/PG-BB.

## 3. Cel i kryterium sukcesu

Faza 1 kończy się sukcesem dopiero wtedy, gdy dla NCG i PG-BB osobno:

- `none`, `diagonal` i `exchange_mass` mają jednoznaczną, zgodną z równaniem
  implementację;
- strict GPU nie wykonuje hostowego operatora ani CPU fallbacku;
- błędy setupu, CUDA, sparse apply i fixed CG zatrzymują wykonanie;
- surowy gradient, kryterium stopu, energia i Armijo zachowują dotychczasową
  semantykę;
- receipt/snapshot/provenance wskazują rzeczywisty algorytm i strategię;
- testy numeryczne odróżniają diagonalę od pełnej macierzy sparse;
- CPU/GPU parity, benchmark time-to-tolerance i Nsight pochodzą z tej samej
  identity workloadu;
- capability pozostaje `development_executable`, dopóki wszystkie wymagane
  pasy nie są kompletne.

Sama obecność kodu, kompilacja albo zielony test kontraktowy nie oznacza
kwalifikacji produkcyjnej.

## 4. Kontrakt numeryczny

### 4.1 Operator

Na aktywnej podprzestrzeni magnetycznej obowiązuje kontrakt z noty 0581:

```text
P_lambda = diag(M_s M_lumped) + lambda * (2/mu0) K_A
z        = Pi_T(m) P_lambda^{-1} diag(M_s M_lumped) g
```

Pełne `exchange_mass` musi używać całego sparse $K_A$, razem z wpisami
pozadiagonalnymi. `diagonal` jest wyłącznie aproksymacją:

```text
z_i = Pi_T(m)_i * [M_i / (M_i + lambda K_ii)] * g_i
```

Nazwy strategii oznaczają:

| Token | Znaczenie |
|---|---|
| `none` | brak preconditioningu, $z=g$ po wymaganej projekcji |
| `diagonal` | punktowa aproksymacja oparta na przekątnej $P_\lambda$ |
| `exchange_mass` | device-resident fixed-CG na pełnym $P_\lambda z=Mg$ |

Rodzina `exchange_mass` ma dwa jawne warianty kwalifikacyjne:
`exchange_mass_cg4` i `exchange_mass_cg8`. W receipt pozostają rozdzielone
`family=exchange_mass` oraz `fixed_iterations=4|8`; nie wolno ukryć liczby
iteracji w ogólnej nazwie. Strategia historyczna `stagnation_triggered_cg8`
nie wraca w fazie 1, ponieważ wcześniejsze pomiary wykazały, że była no-op, a
jej ponowne dodanie zwiększyłoby stan sterujący bez dowodu korzyści.

Nota 0581 pozostaje właścicielem równań, jednostek SI, maski magnetycznej,
warunku SPD i ograniczeń. Przed zmianą kodu musi zostać zaktualizowana z
historycznego statusu „measured no-go; implementation removed” do
precyzyjnego opisu ponownej, jeszcze niezakwalifikowanej realizacji. Aktualizacja
nie może usuwać historycznego wyniku no-go ani przedstawiać nowego kodu jako
zwalidowanego przed uzyskaniem dowodów.

### 4.2 Surowy i preconditioned gradient

`g` i `z` muszą być osobnymi buforami urządzenia.

- `g` pozostaje źródłem kryterium stopu, norm fizycznych, pochodnej Armijo i
  testu descent;
- `z` służy wyłącznie do budowy kierunku poszukiwania;
- kod nie może nadpisywać `g` wynikiem preconditionera przed obliczeniem lub
  utrwaleniem wymaganych metryk;
- fallback algorytmiczny do $-g$ po wykryciu kierunku niedescentowego nie jest
  CPU fallbackiem i pozostaje jawnie raportowany.

PG-BB buduje kierunek $d=-z$, lecz sprawdza $d\cdot g<0$ i zachowuje
dotychczasowe kryteria stopu oraz Armijo.

NCG odwzorowuje preconditioned PR+ z implementacji CPU: przechowuje poprzednie
$g$ i $z$, transportuje wektory na nową przestrzeń styczną, używa
$g_{old}\cdot z_{old}$ w mianowniku, a restart rozpoczyna od $-z$. Raw-gradient
recovery pozostaje oddzielnym, jawnym stanem awaryjnym.

### 4.3 Maska i fixed spins

Węzły poza aktywną maską magnetyczną oraz fixed spins mają dokładnie zerowe
RHS, wektory robocze i wynik preconditionera. Nie wolno dzielić przez masę
węzła nieaktywnego. Niepoprawna dodatnia masa aktywnego węzła, nieskończony
współczynnik, niesymetryczny/niepoprawny operator lub wynik niefinity powoduje
terminalny błąd strict GPU.

## 5. Architektura wykonania

### 5.1 Własność kodu

Minimalny podział odpowiedzialności:

- `gpu_relaxation_preconditioner.hpp/.cpp` zachowuje enum, resolver, wspólne
  statystyki i lekką realizację `diagonal`;
- nowy `gpu_exchange_mass_preconditioner.hpp/.cpp` posiada fixed-CG4/CG8,
  urządzeniowe wektory robocze, skalarne rekurencje i cache setupu;
- `relaxation_state.hpp` posiada oba konkretne stany oraz bufory $z$ wymagane
  przez NCG/PG-BB;
- `relaxation_memory.cpp` alokuje i zwalnia bufory zgodnie z resolved planem;
- `nonlinear_cg.cpp` i `pgbb.cpp` integrują strategię we właściwym miejscu
  algorytmu i zawsze propagują błąd;
- `backend_step.cpp` pozostaje właścicielem fail-closed dispatchu CPU/GPU, ale
  nie przejmuje operatora ani solvera.

Nie powstaje abstrakcyjna fabryka preconditionerów. Stan zawiera dwa konkretne
obiekty, a mały dispatch po `GpuRelaxationPreconditionerKind` wybiera dokładnie
jeden z nich.

### 5.2 Pełny sparse solve

Pierwsza realizacja `exchange_mass` wykorzystuje istniejący, załadowany CSR
exchange i `SparseApplyPlan::apply_xyz`. Nie kopiuje macierzy oraz nie montuje
nowego `mfem::HypreParMatrix` po zmianie $\lambda$. Każda iteracja wykonuje
pełne sparse $K_Ap$ dla x/y/z przez wspólny `apply_xyz`, po czym jądro CUDA
tworzy $P_\lambda p = Mp + \lambda(2/\mu_0)K_Ap$ i aktualizuje trzy niezależne
rekurencje CG.

Warianty CG4 i CG8 mają stałą liczbę iteracji. Iloczyny skalarne i współczynniki
rekurencji pozostają w pamięci urządzenia; nie istnieje hostowe kryterium
zbieżności ani readback na iterację. Końcowe residuum jest składane do
istniejącego, dozwolonego pakietu diagnostycznego.

Wymagania:

- pełny CSR i wszystkie wpisy pozadiagonalne uczestniczą w każdym apply;
- RHS, rozwiązanie, wektory Kryłowa i ich skalary pozostają na urządzeniu;
- setup może przesłać niezmienny operator, lecz hot `apply` nie wykonuje H2D,
  D2H, synchronizacji hosta ani alokacji;
- trzy składowe są wykonywane razem przez istniejący wariant
  `SparseApplyPlan`, ale pozostają matematycznie niezależnymi układami;
- wariant sparse (`scalar`, `subwarp`, `warp`, cuSPARSE SpMV/SpMM3) jest częścią
  provenance i podlega istniejącemu fail-closed planowi;
- zero RHS pozostaje dokładnie zerowe bez dzielenia przez zero;
- breakdown CG, niepoprawny mianownik lub niefinity wynik ustawia monotoniczny
  device failure latch odczytywany w dozwolonym pakiecie końcowym.

HYPRE PCG/BoomerAMG jest technicznie dostępny na GPU, lecz nie jest pierwszym
wykonaniem tego kontraktu. Oficjalna dokumentacja potwierdza wsparcie device,
ale nie stanowi dowodu braku synchronizacji dla tego workloadu. Kandydat HYPRE
może wejść do osobnej optymalizacji dopiero wtedy, gdy fixed-CG4/CG8 nie
przejdzie gate wydajności, a Nsight wykaże, że koszt dodatkowego setupu i
sterowania ma szansę się zwrócić.

Nie wolno zastąpić nieudanego sparse solve mnożeniem diagonalnym. Jeśli
`exchange_mass` jest resolved, jego niedostępność lub błąd kończy krok.

### 5.3 Cache i invalidacja

Cache CSR/setupu jest ważny tylko dla identycznego:

- mesh/topology i numeru rewizji operatora;
- aktywnej maski oraz fixed spins;
- rewizji materiału, $M_s$, masy i exchange;
- precision, solver policy, runtime bundle i GPU identity.

Zmiana któregokolwiek elementu wymusza miss i ponowny setup przed użyciem.
Dokładne bitowe $\lambda$ jest parametrem apply. Zmiana $\lambda$ nie przebudowuje
CSR; unieważnia wyłącznie ewentualne dane zależne od $\lambda$, które są
odświeżane urządzeniowo. Trzy składowe jednego gradientu współdzielą ten sam
setup. Cache hit/miss, setup time, apply time, liczba iteracji i residuum są
raportowane, ale profiler pozostaje opt-in oraz bez alokacji próbek, gdy jest
wyłączony.

### 5.4 Resolver

- Domyślna strategia produkcyjna pozostaje `none`.
- `diagonal` i `exchange_mass` są osiągalne tylko przez jawny, wewnętrzny
  profil kwalifikacyjny związany z identity artefaktu.
- Nieaktualny, nieznany albo niezakwalifikowany profil failuje przed pierwszym
  krokiem.
- Python API i ProblemIR nie otrzymują parametru preconditionera; jest to
  resolved runtime optimization, nie fizyka problemu.
- Automatyczny wybór może zostać włączony dopiero po literalnym przejściu gate
  z sekcji 8.

## 6. Evidence i wersjonowanie ABI

### 6.1 NCG-first

Najpierw wdrażany jest zatwierdzony projekt NCG receipt v2/snapshot v3. Musi on
udowodnić:

- `execution_kind=direct_minimizer`;
- `relaxation_algorithm=nonlinear_cg`;
- właściwy required/resolved/executed operator mask;
- lifecycle próby z kandydatami Armijo;
- zero host/unknown/fallback operator work;
- jawny bounded scalar control;
- jeden `execution_generation_id` dla receipt, snapshot i publication receipt.

Preconditioner dodaje do planu i receipt własną realizację, setup/apply,
`fixed_iterations` i wariant sparse apply, ale nie może podszyć się pod
operator exchange używany do fizycznego $H_{ex}$.

### 6.2 PG-BB

Po zamknięciu NCG ten sam ogólny format identity/lifecycle zostaje rozszerzony
o `relaxation_algorithm=projected_gradient_bb`. PG-BB otrzymuje osobne:

- testy terminal outcomes;
- runtime validator;
- parity artifact;
- pięć powtórzeń benchmarku dla każdej strategii;
- capture Nsight.

NCG evidence nie kwalifikuje PG-BB, nawet jeśli oba algorytmy używają tego
samego obiektu preconditionera.

### 6.3 Zgodność ABI

Nowe layouty i symbole ABI są addytywne i wersjonowane. Stare layouty pozostają
obsługiwane zgodnie z ADR 0030. Nieznany enum, bit, rozmiar, generation lub
niespójna algorithm identity powoduje błąd mapowania, a nie domyślne `none`.

## 7. Strategia testów

### G0 — korekta prawdy

- test źródłowy potwierdza, że `exchange_mass` nie jest diagonalą;
- błędne dokumenty zmieniają status Tasku 10 na `NOT VERIFIED`;
- benchmark nie oferuje `exchange_mass`, dopóki pełny runtime nie istnieje.

### G1 — manufactured RED/GREEN

Pierwszy test używa małej SPD z niezerowymi wpisami pozadiagonalnymi. Obecna
implementacja musi go oblać. Oracle wykonuje niezależne rozwiązanie dense dla
tego samego lumped operatora. Test obejmuje również:

- heterogeniczne $M_s$, masę i exchange;
- $\lambda=0$;
- zerowy RHS;
- inactive/fixed nodes;
- błędną masę, macierz, współczynnik i wynik;
- osobne oczekiwane wyniki `diagonal` i `exchange_mass`;
- x/y/z oraz ponowne użycie setupu.

### G2 — integracja algorytmów

Dla NCG i PG-BB osobno testy wymuszają `none`, `diagonal`,
`exchange_mass_cg4` i `exchange_mass_cg8`. Sprawdzają oddzielność $g$ i $z$,
descent, restart/recovery, rollback po błędzie, invalidację cache i brak
zignorowanych statusów CUDA/sparse apply.

### G3 — source, ABI i runner

Testy kontraktowe obejmują wersje receipt/snapshot, algorithm identity,
preconditioner identity, terminal outcomes, transfer masks, monotoniczne
violation latches, publication hashes oraz fail-closed brak GPU.

### G4 — managed runtime

Weryfikacja natywnego FEM/MFEM/CUDA/HYPRE używa wyłącznie repozytoryjnych,
kontenerowych receptur `just`. Host build jest co najwyżej diagnostyką. Bramy
obejmują co najmniej odpowiadające zakresowi warianty:

```text
just verify-fem-exchange-runtime
just verify-fem-relaxation-source-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-cpu-gpu-consistency-smoke
just verify-fem-gpu-performance-regression
```

Dokładna lista celów i kolejność zostaną przypięte w planie implementacji po
ponownym odczycie aktualnego `justfile`.

### G5 — physics i parity

CPU oracle i GPU używają tego samego source snapshot, ProblemIR, mesha,
topologii, materiałów, double precision, stop criteria, tolerancji i output
policy. Porównanie obejmuje:

- końcowe $m$ i defekt normy;
- całkowitą energię i jej monotoniczność po accepted steps;
- torque i stop reason;
- accepted/rejected Armijo work;
- końcowy stan i liczbę kroków;
- hash artefaktu oraz requested/resolved execution identity.

### G6 — performance i Nsight

Dla obu algorytmów i każdej strategii wykonywany jest warm-up oraz dokładnie
pięć mierzonych powtórzeń na coarse, medium i fine. Raport zawiera p50/p95:

- time-to-tolerance;
- accepted steps i Armijo trials;
- liczbę demag solves;
- setup/apply time preconditionera;
- stałą liczbę iteracji i residuum fixed CG;
- czas sparse apply oraz wariant kernela/cuSPARSE;
- transfery, synchronizacje i alokacje hot loop.

Nsight jest osobnym pojedynczym capture dla tej samej identity; nie zastępuje
pięciu powtórzeń.

## 8. Gate promocji

Każdy algorytm i każda strategia są kwalifikowane niezależnie. Literalny gate
z noty 0581 pozostaje bazą do czasu jawnej zmiany w publikacji naukowej:

1. co najmniej 10% poprawy p50 time-to-tolerance na minimum dwóch z trzech
   rozmiarów względem `none`;
2. brak pogorszenia p50 większego niż 5% na dowolnym rozmiarze;
3. brak pogorszenia p95 większego niż 5% na dowolnym rozmiarze;
4. przejście wszystkich bram physics, parity, residency, synchronization i
   fail-closed.

Wynik dla NCG nie promuje PG-BB. `diagonal` może wygrać dla jednego algorytmu,
a `exchange_mass` dla drugiego. Jeżeli żadna strategia nie przejdzie gate,
domyślne `none` pozostaje bez zmian. Nieudany kandydat nie może pozostać
osiągalny w produkcyjnym automatycznym wyborze.

## 9. Kaskada dokumentacji i capability

Implementacja zaczyna się od aktualizacji not fizycznych zgodnie z
`scientific-documentation-contract`, wraz z source mapami i walidacją. Następnie
aktualizowane są:

- `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md`;
- `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`;
- `docs/physics/0560-all-in-gpu-fem-runtime.md`;
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`;
- `docs/architecture/backend-golden-masterplan.md`;
- `docs/specs/native-fem-backend-architecture-v1.md`;
- `docs/specs/capability-matrix-v0.md` i `.json`;
- `docs/audits/2026-09-02-fem-gpu-solver-completion.md`;
- pakiet
  `docs/performance/fem-gpu-performance-remediation-2026-09-01/`;
- ADR 0030 i projekt receipt, jeśli implementacja ujawni potrzebę addytywnego
  doprecyzowania.

Capability zmienia status dopiero po odpowiednim dowodzie:

```text
source_present -> development_executable -> numerically_validated
               -> performance_qualified -> production_default
```

Nie wolno przeskoczyć etapu na podstawie dokumentacji, CTest albo pojedynczego
runu.

## 10. Non-goals fazy 1

- GPU TPI;
- manifold L-BFGS;
- FP32 lub mixed precision;
- zmiana energii, Armijo, tolerancji lub stop criteria;
- nowy publiczny parametr Python/ProblemIR;
- obniżenie jakości mesha lub outputu dla benchmarku;
- ogólny refaktor `Context`, `mfem_bridge.cpp`, dispatchu lub HYPRE;
- block Krylov, HYPRE/AMG dla tego preconditionera albo learned autotuner;
- promocja preconditionera bez A/B time-to-tolerance.

## 11. Kryteria akceptacji fazy 1

Faza 1 jest zakończona tylko wtedy, gdy:

1. obecne błędne nazewnictwo i dokumentacyjne `VERIFIED` są skorygowane;
2. test z pozadiagonalną SPD odróżnia `diagonal` od `exchange_mass`;
3. pełny sparse solve jest rzeczywiście osiągalny w strict FEM GPU;
4. NCG i PG-BB używają osobnych $g$ i $z$ oraz failują po każdym błędzie;
5. NCG ma komplet receipt v2/snapshot v3/publication i pełną kwalifikację;
6. PG-BB ma własny komplet tych samych klas dowodów;
7. obie ścieżki przechodzą managed runtime, physics i CPU/GPU parity;
8. benchmark zawiera dokładnie pięć ważnych powtórzeń na wariant i rozmiar;
9. Nsight potwierdza brak niejawnego host work/fallbacku w hot loop;
10. capability matrix i wszystkie raporty opisują wyłącznie uzyskany stan.

Brak dowodu w dowolnym pasie pozostaje jawnie oznaczony `NOT VERIFIED`; nie
blokuje to zachowania kodu w statusie development, ale blokuje status
produkcyjny i automatyczną promocję.

## 12. Kryteria rollbacku

Kandydat wraca do `none` i nie jest promowany, gdy:

- nie można zachować pełnej macierzy sparse na urządzeniu;
- apply wymaga hostowego operatora, D2H kryterium iteracyjnego lub alokacji w
  hot loop;
- solver nie jest fail-closed;
- surowe metryki albo Armijo zmieniają semantykę;
- parity lub physics gate nie przechodzi;
- time-to-tolerance nie przechodzi literalnego gate;
- evidence nie wiąże source, workload, runtime i GPU jedną identity.

Rollback nie może zmienić mesha, tolerancji, output fidelity ani zastąpić NCG
przebiegiem RK. Historyczny i nowy wynik no-go pozostają w dokumentacji jako
oddzielne, identyfikowalne kampanie.

## 13. Indeks źródeł użytych do projektu

| Teza | Ścieżka i stabilny symbol |
|---|---|
| Resolver i obecna aproksymacja diagonalna | `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp` — `resolve_gpu_relaxation_preconditioner`, `GpuExchangeMassPreconditioner::setup`, `apply_device_component` |
| NCG CUDA i obecny punkt wywołania | `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp` — `gpu_relax_compute_effective_field_energy_gradient_and_direction` |
| PG-BB CUDA i obecny punkt wywołania | `backends/fem/gpu/cuda/relaxation/pgbb.cpp` — `gpu_relax_compute_current_metrics` |
| Stan device minimizerów | `backends/fem/gpu/cuda/relaxation/relaxation_state.hpp` — `FemGpuRelaxationDeviceState` |
| Test, który nie obejmuje off-diagonal | `backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp` — `ManufacturedSpdMatrix` |
| CPU oracle preconditioned NCG/PG-BB | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` — `exchange_mass_preconditioned_gradient`; `backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp` — `next_direction_pr_plus` |
| Device-resident pełny CSR x/y/z | `backends/fem/gpu/cuda/sparse/sparse_apply_plan.hpp` — `SparseApplyPlan::apply_xyz`; `backends/fem/gpu/cuda/exchange/exchange_state.hpp` — `LegacyGpuExchangeDeviceState` |
| Benchmark i niedostępne `exchange_mass` | `scripts/analysis/fem_gpu_benchmark.py` — `RELAXATION_PRECONDITIONER_RUNTIME_NAMES`, `relaxation_preconditioner_runtime_name` |
| Status capability NCG/PG-BB/TPI | `docs/specs/capability-matrix-v0.json` — wpisy `nonlinear_cg`, `projected_gradient_bb`, `tangent_plane_implicit` |
| Kanoniczny kontrakt matematyczny i historyczny no-go | `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md` — sekcje 2, 3 i 7 |

## 14. Zewnętrzne źródła technologiczne

- Oficjalna dokumentacja HYPRE GPU:
  <https://github.com/hypre-space/hypre/wiki/GPUs>
- Oficjalna dokumentacja polityki MFEM/HYPRE device:
  <https://docs.mfem.org/4.9/classmfem_1_1Hypre.html>

Źródła te potwierdzają dostępność GPU PCG/BoomerAMG i pamięci device, ale nie
kwalifikują ich kosztu synchronizacji ani wydajności dla direct minimizers
Fullmag. Dlatego nie zastępują benchmarku i capture Nsight z sekcji 7.
