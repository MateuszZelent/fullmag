# FEM K0 eigensolve z dynamicznym demagiem — audyt bieżący i plan wykonawczy

> **Dla wykonawców agentowych:** przed implementacją użyj
> `subagent-driven-development`. Każdy etap implementacyjny wymaga świeżego
> implementera, RED/GREEN, review specyfikacji i review jakości. Ten dokument
> jest planem wykonawczym połączonym z audytem stanu; nie jest dowodem
> kwalifikacji fizycznej ani zgodą na promocję capability.

**Cel:** doprowadzić dokładny FEM `k=0` modalny eigensolver z dynamicznym
demagiem Poisson-airbox do produkcyjnej kwalifikacji CPU i GPU oraz udostępnić
modalne widma, bias-field scan, FMR response i zespolone pola modów w jednym
Control Room.

**Architektura:** fizyka i intencja użytkownika przechodzą przez Python DSL,
`ProblemIR`, walidację i planner. Wspólny certyfikowany request trafia do
natychmiastowego MFEM shared-domain assembly, a osobne realizacje PETSc/SLEPc
CPU i CUDA GPU publikują ten sam model artefaktów, proweniencji i binary field
data-plane. Results, Analysis, Inspector i unified `viewport-3d` są jedną
powierzchnią workspace, nie trzema aplikacjami.

**Technologie:** Python DSL, Rust (`fullmag-ir`, `fullmag-plan`, runner/API),
MFEM/PETSc/SLEPc/hypre/CUDA, C ABI/Rust FFI, OpenAPI v2, React/TypeScript,
ECharts, Three.js/WebGL, container-backed `justfile`.

## Globalne ograniczenia

- Zakres modalny obejmuje wyłącznie FEM, dokładne `k=0`, periodic x/y, open z,
  dynamiczny Poisson-airbox, P1, `alpha=0`, double i real-frequency-rotated
  target. FDM FFT nie jest modalnym eigensolverem.
- Kittel jest wyłącznie postsolve oracle. Fizyczne pola wejściowe należą do
  `BiasFieldSweepIR` w `StudyIR::Eigenmodes`.
- `A_qq`, `B_qq`, `A_qphi`, `A_phiq` i `P` muszą powstać z jednego natywnego
  MFEM mesh/quadrature/region-map/certificate. Runner orkiestruje, nie składa
  produkcyjnej macierzy.
- CPU i GPU dzielą kontrakt, znaki, jednostki, certyfikaty i artefakty, ale
  mają osobne implementacje i osobne dowody runtime.
- Strict GPU nigdy nie maskuje braku CUDA/MFEM/hypre/SLEPc cichym CPU fallbackiem.
- Native FEM buduje się i kwalifikuje wyłącznie przez właściwe recipe z
  `justfile`; host `cargo`/`cmake` może być tylko diagnostyką.
- HTTP v2 jest źródłem prawdy dla snapshotów; WebSocket tylko invaliduje
  revision/resource. Ciężkie pola i topologia pozostają na data plane.
- Wszystkie klasy CSS Control Room mają prefiks `fm-`; kolory pochodzą z
  `--fm-*`, Catppuccin Mocha/Latte. React nie używa bezpośredniego `fetch()`.
- Nie wolno usuwać locków, targetów, runtime bundle'i ani worktree bez
  inwentaryzacji, potwierdzenia braku aktywnych użytkowników i osobnej zgody.
- Żadna zmiana po R1 nie może być traktowana jako kompatybilna z evidence Q1–Q3;
  zmiana runtime-relevant unieważnia cały release candidate.

---

## 1. Werdykt audytu na dzień 2026-08-09

### 1.1 Snapshot, który faktycznie zbadano

Audyt dotyczy recovery worktree:

```text
/home/kkingstoun/git/fullmag/fullmag/.worktrees/eigensolve-k0-demag-recovery
branch: codex/eigensolve-k0-demag
HEAD:   5acc73bd7046d5e93828d3c3a424eb83e939e5cc
master: 220262df5d84fa04b842c414e3e5868444b356e5
master...HEAD (left/right): 119 64
```

Gałąź jest 119 commitów za aktualnym lokalnym `master` i ma 64 commity
specyficzne dla recovery. Worktree jest brudny: istnieją staged i unstaged
zmiany natywne, runnera, artefaktów, API, UI, dokumentacji oraz untracked
artefakty. Nie ma jednego clean source snapshotu, na którym można oprzeć
wynik naukowy.

Ostatni zamknięty commit C2 to `236ccbd79`. Checkpoint C3 to
`5acc73bd7` (`fem: freeze modal ABI certificate boundary`); bieżąca poprawka
ABI v18, manifestu/testu/proweniencji ma source/ABI approval, ale pozostaje
niezatwierdzona jako commit, ponieważ wspólny indeks jest brudny i
repozytoryjny `.git` jest w tej sesji tylko do odczytu. Dotyka między innymi
`native/include/fullmag_fem.h`,
`crates/fullmag-fem-sys/src/lib.rs`, `backends/fem/src/api.cpp` i mechanicznych
inicjalizatorów w `crates/fullmag-runner/src/native_fem/frequency_domain.rs`.

### 1.2 Odpowiedź operacyjna

**Nie należy jeszcze uruchamiać tego snapshotu jako produkcyjnego źródła
obliczeń.** Można później uruchomić bounded diagnostic smoke, ale dopiero po
zachowaniu recovery state, integracji `master`, domknięciu ABI i zbudowaniu
świeżego managed runtime. Wynik historyczny lub lokalny contract test nie jest
dowodem dla obecnego snapshotu.

Pierwsze obliczenie kwalifikacyjne powinno być CPU i ma pełnić rolę niezależnego
oracle dla GPU. GPU może być implementowane równolegle po zamrożeniu ABI i
assembly, ale jego claim wymaga osobnego device/runtime/parity/residency proof.

C3 review względem parenta `236ccbd79` potwierdził poprawną strukturę append-only
V16/V17/V18 i wywołanie verifiera relation views. Cztery uwagi source-level
(pełny gate bufora layout v3, sprzeczny slot manifestu v2, wiązanie digestów
deskryptora ze zweryfikowanym payloadem oraz ścisły NULL/count gate dla
exchange) zostały naprawione i niezależnie zaakceptowane. Runner nadal nie ma
authoritative producer/descriptors. Nie jest to GREEN produkcyjny:
managed-native proof nadal blokuje istniejący export lock/runtime, a natywne
MFEM `A_qq` assembly pozostaje otwarte.

### 1.3 Drabina dowodu

| Poziom | Co oznacza | Czego nie dowodzi |
|---|---|---|
| `contract_only` | typ, API, walidator lub test syntetyczny istnieje | nie dowodzi fizyki ani wykonywalności |
| `source_visible` | kod jest routowany w źródłach | nie dowodzi aktualnego bundle/runtime |
| `executable` | dokładny snapshot wykonał managed run i wydał artefakty | nie dowodzi zbieżności, skalowania ani UI |
| `physics_validated` | niezależne oracles, reszty i zbieżność przeszły dla scope | nie dowodzi GPU residency ani release readiness |
| `production_qualified` | exact-scope evidence jest hash-bound, `open_blockers=[]` i DoD przechodzi | nie rozszerza zakresu na inny backend, precision lub `k` |

W bieżącym snapshotcie żaden z `DOD-01`–`DOD-14` nie ma kompletnego dowodu
wydaniowego. Nie podaję jednego procenta: mieszałby implementację kontraktu,
wykonywalność i kwalifikację. C2 jest zamkniętym podzadaniem, lecz cały cel
pozostaje `promotion blocked`.

### 1.4 Rewizja po niezależnym review N1/C3, A2/U0, N3 i U1

Po zamknięciu źródłowej części A2/U0 wykonano osobny review granicy ABI oraz
transportu Results. Wynik nie zmienia werdyktu produkcyjnego, ale precyzuje
następny zakres:

- A2/U0 jest `source_complete` i ma niezależne `APPROVED`: canonical paths,
  typed facade, resource hooks, generated OpenAPI, Results Navigator adapters,
  SelectionRef oraz content-addressed WebSocket invalidation są objęte testami
  focused. Brakuje jeszcze live API z natywnym bundle'em oraz browser/WebGL
  evidence.
- N3 ma `source_complete / managed_blocked`: GPU odrzuca niekanoniczne
  konwencje, zero/nieznany target, pustą lub niekompletną window i nie publikuje
  `ok` dla niepełnego wyniku. Recipe CUDA zatrzymuje się przed kompilacją na
  zajętym export lockiem; nie ma jeszcze dowodu device/runtime, residency,
  przypadku `operator_dimension > 1024` ani sanitizer sidecars.
- U1 ma `source_green / browser_unvalidated`: osobne węzły i Inspectory dla
  `resonance-fits` oraz `kittel-fit` są rozdzielone od `modal-driven-comparison`;
  adaptery są fail-closed dla `missing/partial/corrupt`, a testy docelowe są
  zielone. Nadal brakuje natywnego artefaktu, live API i interaktywnego proofu
  Results→Inspector→viewport.
- N1/C3 po poprawce ma `APPROVED` dla zakresu źródłowego ABI i fail-closed:
  kompletne relation views wymagają rzeczywistego preimage, a
  `resolved_canonical_preimage_sha256` jest publikowany dopiero po weryfikacji
  relation views i digestów.
- Manifest ABI v2 publikuje rozmiary i offsety publicznych typów relation-view
  (`Relation`, `RegionRole`, `ClassDigest`, `View`, `BindingRequest`) oraz ich
  odpowiedniki Rust/C. Manifest v3 dodaje rozmiar/offsety
  `FullmagFemModalLinearizationDescriptor`; zmiana istniejących pól
  `spectral_transform_kind` z enum na `int/uint32_t` nadal nie jest
  append-only i wymaga jawnej, odrębnej wersji ABI.
- `certificate_binding_v6 = NULL` oraz `linearization_descriptor = NULL` w
  runnerze są poprawnym stanem bezpiecznego fail-closed, ale oznaczają, że
  runner nie jest jeszcze `executable`; authoritative producer z native
  meshera/assembly pozostaje zależnością N1.
- Publiczny ABI v17 jest jawnie normalizowany do wewnętrznego solverowego
  kontraktu v16. Append-only publiczny v18, deskryptor liniaryzacji i layout
  wrapper v3 mają source-level `GREEN`: short-prefix/null, units, digest, count,
  cross-language offset, pełny caller-buffer gate i dokładny exchange NULL/count
  są objęte testami. Managed native contract nadal wymaga zgodnego
  runtime/export lock. Nieznany numer ABI, `struct_size==0` i zbyt krótki
  obowiązkowy prefiks są odrzucane przed odczytem optional tailu.

Pozostają blokery wykonawcze N1: oba wskaźniki handoffu w runnerze są
bezpiecznym stanem contract-only, ale nie są authoritative producerem z native
meshera; `A_qq` nadal nie ma natywnego MFEM assembly, a managed native contract
czeka na runtime/export lock. Runtime capability musi pozostać
`unsupported`/`fallback=none`, nawet jeśli planner zachowuje legalną
resolution intent. Nie są to powody do cofania gotowych typed routes ani do
wprowadzania syntetycznych identyfikatorów w UI. Approval dotyczy diffu i
bezpieczeństwa ABI, nie świeżego managed-native runtime proof ani kwalifikacji
produkcyjnej.

---

## 2. Co zostało zrobione

### 2.1 Inwentaryzacja wszystkich worktree i ochrona przed duplikacją pracy

Read-only `git worktree list --porcelain` wykazało **39 worktree**. Jedynym
właścicielem bieżącego K0 recovery jest:

```text
/home/kkingstoun/git/fullmag/fullmag/.worktrees/eigensolve-k0-demag-recovery
branch: codex/eigensolve-k0-demag
```

Pozostałe worktree zawierają niezależne zakresy (m.in. `fem-gpu-end-to-end-
remediation`, `fdm-production-completion`, `analysis-workbench-refactor`,
`live-charts-analysis-separation`, `fem-mixed-*` i `frontend-3d-remediation`).
Ich obecność nie jest dowodem, że K0 jest gotowe do użycia: nie wolno kopiować
plików po nazwie ani łączyć commitów bez porównania parenta, source/runtime
snapshotu i właściciela pliku. Dwa wpisy pod `/tmp` są oznaczone przez Git jako
`prunable`; nie wolno ich usuwać w tej sesji.

Kontrola przed każdym reuse:

```bash
git worktree list --porcelain
git -C <worktree> status --short --branch
git -C <worktree> log --oneline --decorate -n 12
git -C <worktree> diff --stat -- <exact-paths>
git -C <worktree> rev-parse HEAD
```

Jeżeli dwa worktree modyfikują ten sam plik, najpierw wybierz jednego
właściciela lane'u z macierzy poniżej; drugi agent wykonuje wyłącznie review lub
read-only porównanie. Nie wolno traktować dirty `master` jako bezpiecznego
źródła do automatycznego cherry-picku.

### 2.2 Kontrakty fizyczne, Python, IR i planner

Istnieje rozległa implementacja `Eigenmodes`/`FrequencyResponse`:

- `packages/fullmag-py/src/fullmag/model/study.py` — publiczne study;
- `packages/fullmag-py/src/fullmag/model/eigen.py::BiasFieldSweep` — fizyczny
  scan `[Hx, Hy, Hz]` w `A/m`;
- `packages/fullmag-py/src/fullmag/world.py` — stage lowering i eksport;
- `crates/fullmag-ir/src/study.rs` — `BiasFieldSweepIR` i `StudyIR::Eigenmodes`;
- `crates/fullmag-ir/src/lib.rs` — walidacja SI, Gamma-only, demag, BC, alpha,
  precision, strict execution i fail-closed reason tokens;
- `crates/fullmag-plan/src/fem.rs` — legalność przed wyborem urządzenia,
  per-sample requested/resolved provenance;
- `crates/fullmag-plan/src/lib.rs` — FDM bias sweep odrzucany stabilnym
  `eigenmodes.bias_field_sweep_requires_fem_backend; fallback=none`.

`K0KittelFieldSweepValidation` nie jest już właściwym właścicielem pola wejściowego
w C2. Po merge trzeba jeszcze usunąć wszystkie stare ścieżki, które w innych
fragmentach runnera mogą nadal interpretować Kittel metadata jako bias input.

### 2.3 C2 — stan zamknięty po review

C2 dostarczyło:

- niepustą uporządkowaną listę pól A/m;
- `relax_each | continuation` i jawny seed;
- wzajemne wykluczenie z `k_path`, exact Gamma oraz zakaz fully-periodic 3D;
- odrzucenie braku demagu/airbox, `alpha != 0`, single precision,
  non-strict execution, złego PBC i FDM;
- własne indeksy/provenance dla każdej próbki CPU/GPU;
- tabelę edytowalną `[Hx, Hy, Hz] A/m` w Study Inspector.

Najważniejsze commity C2:

```text
c3e18cf9a  feat(eigen): add canonical bias-field sweep contract
b5be917de  fix(eigen): fail closed bias-field sweep planning
fa7e1dd85  fix(eigen): reject material damping in bias sweeps
b86925d5b  test(eigen): cover bias-field sweep legality matrix
5110339cc  test(eigen): bind sweep samples to execution provenance
0b977ac35  test(eigen): cover remaining sweep rejection cases
236ccbd79  docs: record final sweep legality coverage
```

Review C2 jest czysty. Zweryfikowano: `pnpm --dir apps/control-room typecheck`,
9 testów `packages/fullmag-py/tests/test_problem_ir.py`, focused `fullmag-ir`
i `fullmag-plan`. Pełny round-trip/API pozostaje ograniczony przez niezależną,
brudną zmianę `packages/fullmag-py/src/fullmag/runtime/script_builder.py` —
plik ma 0 bajtów, a diff usuwa 7367 linii. Nie wolno go po cichu odtwarzać w
ramach C2.

### 2.4 Istniejący native FEM CPU

Źródłowo istnieją:

- `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp`
  — P1, `P`, `A_qphi`, `A_phiq`, `B_qq`, Robin/Dirichlet/Neumann, gauge i
  redukcja klas;
- `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` —
  rotated-frequency SLEPc oraz q/phi/gauge residuals;
- `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` —
  Schur MatShell, rekonstrukcja `phi=-P^-1*A_phiq*q` i deduplikacja;
- `crates/fullmag-runner/src/fem_eigen.rs` — certyfikaty, przygotowanie
  requestu i nadal częściowe runner-owned assembly.

To jest `source_visible`, nie `physics_validated`. Testy używają także małych
syntetycznych macierzy i fixture'ów bez rzeczywistego magnetic+airbox, seamów,
narożników i pełnej mapy regionów.

### 2.5 Istniejący native FEM GPU

`backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` ma rzeczywistą
ścieżkę PETSc/SLEPc CUDA z CUDA CSR/Vec, Schur MatShell, Poisson CG/HYPRE,
shift-invert Krylov-Schur i device residual metrics. Produkcyjny routing nie
ma cichego CPU fallbacku. `modal_krylov.cu` pozostaje validation-only i nie
może zostać awansowany do produkcyjnego eigensolvera.

Po ostatnim lane źródłowym GPU ma fail-closed input/window validation,
`EPSGetConvergedReason`, monitor/stopping callback, cancellation guard,
częściowe artefakty, residual/counter fields i poprawne agregowanie statusu
niepełnego okna. Nadal nie ma managed CUDA/SLEPc compile/solve proof; solver
state nie jest jeszcze dowiedziony jako persistent, transfer/allocation fields
nie mają niezależnego pomiaru, a brakują trace residency, realny przypadek
`operator_dimension > 1024` i sanitizer sidecars.

### 2.6 Runner, artefakty, API i istniejące UI

Istnieją:

- `crates/fullmag-runner/src/fem_eigen.rs::write_eigen_v2_bundle`;
- spectrum/branches/dispersion/diagnostics i complex mode fields;
- trasy v2 w `crates/fullmag-api/src/router_v2/handlers/analysis/`;
- centralny `apps/control-room/src/kernel/api/ControlRoomApi.ts` i generated
  OpenAPI client;
- `frequencyDomainExplorerNodes.ts`, `FrequencyDomainEigenSection.tsx`,
  `frequency-domain/FrequencyDomainResultInspectors.tsx`;
- `AnalysisFieldOverlayController` i komendy real/imag/magnitude/phase/
  phase-rotated-real;
- jeden `viewport-3d` z istniejącym lifecycle i ECharts z dispose/resize.

UI nie wymaga przepisywania od zera. Typed Rust/OpenAPI payloady, cztery trasy
field-sweep/FMR, generated path/type/JSON handoff, dedicated facade/hooks,
content-addressed invalidation oraz Results Navigator z chart source slice są
już źródłowo obecne i przechodzą focused testy. U1 rozdziela semantycznie:

- `Modal Resonances` — tylko częstotliwości modów, bez udawanej intensywności;
- `Driven FMR` — odpowiedź względem częstotliwości i wybranego observable;
- `Resonance Fits` — osobny artefakt fitów, linewidth/Q/uncertainty/source
  revision;
- `Kittel Fit` — osobny artefakt parametrów i punktów `[H_x,H_y,H_z] A/m`;
- `Modal vs Driven Comparison` — wyłącznie compatibility certificate, nie
  wspólny magazyn danych.

Węzły `resonance-fits`/`resonance-fit` i `kittel-fit` mają osobne
`SelectionRef`, `Inspector` i `resourceKey`; `missing/partial/corrupt` nie
stają się sztucznie `ready`. GREEN U1: focused 331/331, szerszy Results/
Inspector 335/335, typecheck, scoped ESLint i architecture hygiene przechodzą;
React Doctor 87/100 wskazuje wyłącznie trzy istniejące ostrzeżenia poza U1.
Pozostają live native API/artifacty, pełny inspector/SelectionRef handoff z
runtime, spójne osie/jednostki na każdym native payloadzie oraz native
browser/WebGL proof. Obecny fixture-backed smoke nie jest takim proofem.

---

## 3. Co nadal blokuje cel

### P0 — kolejność i stan repozytorium

1. Recovery branch jest 119 commitów za `master`.
2. Worktree ma wiele staged/unstaged/untracked zmian; nie ma clean commit.
3. C3 ma checkpoint ABI; v17 relation certificate i publiczny v18 descriptor
   boundary są source-approved. N1 fail-closed runtime gate jest source-approved
   i zwraca `unsupported` + `fallback=none`, lecz runner nie dostarcza
   authoritative handoffu, a `A_qq` nie ma jeszcze natywnego MFEM assembly.
4. Filesystem `/tmp`/root był pełny (`ENOSPC`), więc C3 nie mogło uruchomić
   GREEN ani zapisać index/target. Nie wolno usuwać aktywnych targetów ani
   runtime cache bez potwierdzenia właścicieli.
5. Istniejący `.fem-gpu-host.export.lock` i stary managed bundle nie są dowodem
   aktualnego runtime. Lock wymaga host-wide read-only audytu przed jakąkolwiek
   decyzją.

### P0 — native contract i assembly

- C3 zamroziło kompletny ABI v16/v17/v18: `sizeof`/`offsetof` requestu, V17
  prefixu shared payloadu, pełnego V18 descriptor tailu, resultu, CSR view i
  nested public fields; pozostaje wykonać managed native contract na zgodnym
  runtime.
- `fullmag_fem_modal_eigen_solve` musi sprawdzać `struct_size` przed odczytem
  optional tail; unknown enum/schema/layout/certificate ma kończyć się
  `validation_error`, stabilnym reason tokenem i `fallback=none`.
- Shared payload musi wiązać mesh certificate, map binding, equilibrium,
  linearization, BC/gauge i bias sample; natywny boundary nie może ufać samym
  countom ani `equivalence_classes_complete`.
- Verifier `verify_mesh_symmetry_certificate_v6()` wraz z union-find i
  `verify_mesh_symmetry_certificate_map_binding()` jest source-green i jest
  wywoływany przez C ABI po dostarczeniu relation views; odrzuca niepełne mapy
  fail-closed. Nadal nie wolno traktować go jako N1 GREEN: runner nie posiada
  authoritative producera z native meshera, a `A_qq`/term descriptor nie jest
  jeszcze generowany z jednego MFEM mesh/quadrature source-of-truth.
- CPU/GPU entrypointy nie udają capability: przy obecnym `NULL` producerze
  zwracają stabilny `k0_poisson_airbox_real_fem_assembly_unavailable` i nie
  przechodzą do runner-owned CSR. Planner może zachować legalną intent
  resolution, ale runtime capability pozostaje `unsupported`.
- Result ma publikować faktyczne resolved CPU/GPU, scalar, transform, engine i
  fallback, a nie kopiować requestu/AUTO.
- `destroy` musi być bezpieczny dla null/zero/partial/full/double.
- N1 musi usunąć produkcyjną zależność od
  `crates/fullmag-runner/src/fem/eigen_operator.rs::assemble_full_2x2_operator_real`
  i przenieść pełne `A_qq` do MFEM operatora.

### P0 — fizyczny bias sweep i oracle Kittela

- `bias_field_samples` jest jedynym źródłem wejściowych pól fizycznych;
  `k0_kittel_validation` nie może zmieniać `external_field`, równowagi,
  targetu, operator signature ani routingu.
- Każdy sample musi jawnie wykonać `RelaxEach`, `Continuation` z poprzednim
  accepted equilibrium albo `InitialState`; ignorowanie `equilibrium_policy`
  i `continuation_seed` jest błędem, nawet jeśli podstawowy solve się kompiluje.
- Kontrakt musi jednoznacznie rozstrzygać zerowy wektor pola. Skończone zero
  jest obecnie akceptowane wspólnie przez IR/planner/runner; kwalifikacja nadal
  wymaga świeżego managed dowodu jego fizycznej interpretacji.
- Sweep zatrzymuje się na `Cancelled`/`Partial` i publikuje stan
  `interrupted`/`partial`; nie może scalać takich próbek w `complete=true` ani
  kontynuować kolejnych pól.
- Oracle Kittela musi emitować rzeczywisty per-sample pass/fail, expected-vs-
  solved error i artefakt `validation/kittel_k0_pbc/summary.v1.json`. Samo
  pole `postsolve_oracle` w diagnostics nie jest walidacją.
- Ostatnia poprawka P0 jest defensywnie bezpieczniejsza: skończone pole zerowe
  przechodzi wspólną walidację, próbka `Cancelled` zatrzymuje skan przed
  scaleniem i zachowuje częściowy bundle `interrupted`, a żądanie Kittel bez
  adaptera kończy się stabilnym
  `bias_field_sweep_kittel_postsolve_oracle_unavailable`. To nadal nie jest
  kwalifikacja produkcyjna: brakuje świeżego managed runu z per-sample
  expected-vs-solved Kittel evidence oraz dowodu semantyki equilibrium dla
  obu wariantów `continuation_seed`.
- Przed Q1 obowiązkowe są testy policy/continuation, zero-field, cancellation,
  oracle mismatch i niezmienności operator signature po edycji metadata;
  bez nich P0 pozostaje `CHANGES_REQUIRED`.

### P0 — CPU/GPU dowody numeryczne

- CPU ma już źródłowy complete-window certificate, EPS stop reason, pełne
  reszty/counters i fail-closed cancellation; nadal brakuje realnego
  magnetic+airbox E2E managed runu, envelope/scaling proof i niezależnego
  evidence.
- GPU ma źródłowe EPS monitor/reason, fail-closed window/cancel, device
  residual path i liczniki; nadal nie ma świeżego managed compile/solve,
  niezależnego telemetry/residency trace, >1024 scalable case ani
  memcheck/racecheck/synccheck sidecars.
- Historyczny Kittel/CPU-GPU wynik nie może być przypisany do aktualnego
  snapshotu.

### P1 — artefakty, API i FMR

- Typed writers for `eigen/field_sweep.v1.json`, `fmr/peaks.v1.json`,
  `fmr/resonance_fits.v1.json` i `fmr/kittel_fit.v1.json` istnieją wraz z
  lifecycle, units, uncertainty, source revision i validation status; 29
  focused artifact tests oraz runner compile/no-run przechodzą. Nadal brakuje
  świeżego managed bundle oraz pełnego staged evidence handoff.
- Rust/OpenAPI ma typed payload union, content-addressed revision/digest,
  response diagnostics registration, cztery endpointy field-sweep/FMR,
  dedicated facade/hooks oraz odświeżone generated `openapi-v2.json`,
  `openapi-v2-types.ts` i `openapi-v2-paths.ts`; focused Vitest, pełny
  `corepack pnpm typecheck`, `cargo check` i focused OpenAPI test przechodzą.
  WebSocket/resource invalidation, native API i browser proof pozostają
  otwarte. Free-form extras są zachowane w serde i opisane w OpenAPI.

### P1 — Control Room

- `FrequencyDomainEigenSection` ma chart contract X=mode rank/Y=frequency Hz;
  końcowy handoff typed payloadu z A2 oraz dedicated resource hooks/facade są
  źródłowo domknięte; live invalidation i native/browser proof pozostają
  otwarte;
- response może wymuszać `a.u.`/`W/m^3` niezależnie od artefaktu;
- FD dispersion jest mylone z time-domain dynamic structure factor;
- progress nie rozdziela live stage execution (primary) i artifact fallback;
- część drzewa ma fikcyjne `ready`/revision `0` bez zasobu HTTP;
- `results-navigator` ma typed collection adapters, stabilne selection refs,
  semantic inspector mapping, jawny `corrupt -> error`, Results-tab
  activation test i dedicated field-sweep/FMR hooks. U0 focused Vitest oraz
  selection regressions przechodzą; pełny Control Room typecheck również
  przechodzi. Content-addressed live invalidation, native artifacts i browser
  proof pozostają otwarte, a obecny duży `FrequencyDomainResultInspectors.tsx`
  nadal wymaga późniejszego podziału domenowego;
- fixture smoke z przechwytywaniem `/v2/**` nie dowodzi native API/WebGL.

---

## 4. Bramka „czy można zacząć realne obliczenia?”

| Rodzaj obliczenia | Najwcześniejszy legalny moment | Warunek |
|---|---|---|
| syntetyczny contract/oracle | po udanym G0 baseline | test nie jest dowodem fizyki |
| bounded CPU diagnostic | po G0 + C3 GREEN + świeży managed runtime | wynik `source/runtime=diagnostic`, bez promotion |
| CPU physical qualification | po N1 + N2 + R1 | complete window, residuals, convergence, scan, scope |
| GPU diagnostic | po G0 + C3 + N1 + zgodny CUDA runtime | strict target, bez CPU fallback |
| GPU physical qualification | po Q1 CPU oracle + N3 + R1 | parity, residency, independent trace, >1024, sanitizers |
| Results/viewport qualification | po Q1/Q2 artefaktach | native browser proof CPU i GPU |
| `production_qualified` | dopiero G2 | immutable manifest + governance attestation |

Stary `verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-*` może być
używany jako historyczny/diagnostic gate do czasu przepięcia na `BiasFieldSweepIR`;
nie wolno na jego podstawie deklarować nowego production scope.

---

## 5. DAG etapów i dozwolona równoległość

```text
G0 checkpoint + merge master + baseline
  -> C1 physics/scope/docs refresh
  -> C2 BiasFieldSweepIR (DONE, re-verify after merge)
  -> C3 ABI/certificate (source complete; native binding blocked)
       -> N1 native MFEM shared-domain Aqq/P/Aqphi/Aphiq/Bqq
            +--> N2 CPU solver/window/residual
            +--> N3 GPU persistence/telemetry/window
            +--> A1S artifact schemas/writers
                    -> A1E staged evidence/release
                    -> A2 typed OpenAPI/revisions/events
                           -> U0 Results tree/selection/adapters
                                  +--> U1 Analysis/Inspectors/FMR
                                  +--> U2 unified mode-field viewport
N2 + N3 + A1E + A2 + U0 + U1 + U2 -> R1 managed runtime freeze
R1 -> Q1 CPU evidence -> Q2 GPU parity/performance -> Q3 native browser/release
Q3 -> DoD verifier -> immutable scientific manifest -> G2 governance promotion
```

### Zasady równoległości

1. G0 ma jednego właściciela integracji; do jego zakończenia inni agenci robią
   tylko read-only audit albo przygotowują testy bez dotykania wspólnych plików.
2. C3 jest właścicielem C ABI/FFI; N1/N2/N3 nie zmieniają layoutu samodzielnie.
3. Po C3 i N1 N2 oraz N3 mogą implementować się równolegle, ale nie mogą
   edytować tych samych plików ani budować/przełączać managed runtime.
4. A1S może przygotować schematy po uzgodnieniu C3/N1; A2 czeka na freeze
   schematów. U0 może przygotować pure adapters, ale nie transport.
5. U1 i U2 mogą biec równolegle po A2/U0; komunikują się przez kernel command/
   event/SelectionRef, nie przez importy komponentów.
6. R1, Q1, Q2, Q3 i G2 są serializowane. Qualification owner nie patchuje
   źródła podczas zbierania evidence.
7. Każdy lane kończy handoffem: commit, pliki, wejście/wyjście kontraktu,
   komendy i exit codes, ryzyka, informacja o unieważnieniu evidence.

### Macierz właścicielstwa plików

| Lane | Wyłączny zakres | Zależność | Wynik |
|---|---|---|---|
| G0 | Git, merge, generators, runtime pointer | obecny recovery | clean integrated baseline |
| C1 | `docs/physics/0830-*`, source-map, masterplan, capability/ADR | G0 | physics/scope freeze |
| C2 | Python study/world/eigen, `crates/fullmag-ir`, `crates/fullmag-plan`, authoring UI | C1 | canonical scan (już wykonany, reverify) |
| C3 | `native/include/fullmag_fem.h`, `crates/fullmag-fem-sys`, modal headers, `api.cpp`, FFI initializer | C1 + payload design | ABI/certificate manifest |
| N1 | `backends/fem/cpu/frequency_domain/operators/`, native assembly tests, `eigen_operator` removal | C2+C3 | native blocks and digests |
| N2 | CPU modal/Schur/residual/window files and CPU tests | N1+C3 | CPU engine contract |
| N3 | `modal_petsc_slepc.cpp`, CUDA modal telemetry/tests | N1+C3 | GPU engine contract |
| A1S | runner eigen artifacts, `docs/specs/frequency-domain-artifacts-v2.md`, verifiers | C2+C3+N1 | typed artifact schemas |
| A1E | staged evidence, DoD/release recipes/scripts | A1S | causal release DAG |
| A2 | Rust API/OpenAPI/generated client/facades/hooks | A1S | typed resource plane |
| U0 | `results-navigator`, tree/selection/adapters/layout | A2 schema | canonical Results tree |
| U1 | Analysis plots, Inspector panels, FMR jobs/exports | A2+U0 | scientific Analysis |
| U2 | overlay controller, field hooks, viewport render model/smoke | A2+U0 | mode field visualization |
| R1/Q1/Q2/Q3/G2 | release owner only | all implementation lanes | evidence and promotion |

---

## 6. Instrukcje wykonania krok po kroku

### Etap G0 — checkpoint recovery i integracja aktualnego mastera

**Właściciel:** integration owner. **Równoległość:** brak operacji Git/runtime.

1. Zapisz osobno `git status --short`, `git diff --cached --name-only`,
   `git diff --name-status`, `git ls-files --others --exclude-standard`,
   `git worktree list --porcelain`, `git rev-parse HEAD master origin/master`
   i `git rev-list --left-right --count master...HEAD`.
2. Sklasyfikuj każdy staged/unstaged/untracked path: C2/C3/N*, UI, artefakt,
   build output, obca zmiana. Nie dodawaj `native-debug/` ani wielkich outputów
   bez jawnego statusu `retain`.
3. Sprawdź staged paths w osobnej komendzie przed checkpointem. Utwórz checkpoint
   wyłącznie z intencjonalnym recovery content; nie odtwarzaj pustego
   `script_builder.py` bez osobnej decyzji właściciela tej zmiany.
4. `git fetch origin master`; zapisz `origin/master`; scalaj `git merge --no-ff
   origin/master`, nie rób destrukcyjnego resetu ani rebase dirty tree.
5. Konflikty rozwiązuj według kolejności: aktualna fizyka/API z master,
   zachowanie K0 recovery, generated output przez generator. Po merge sprawdź
   ponownie demag, planner, runner, field store i viewport.
6. Uruchom lekkie baseline'y z `/dev/shm` lub zarządzanym storage, nie w pełnym
   `/tmp`:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
  packages/fullmag-py/tests/test_problem_ir.py
env CARGO_TARGET_DIR=/dev/shm/fullmag-g0-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-ir --quiet
env CARGO_TARGET_DIR=/dev/shm/fullmag-g0-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-plan --quiet
python3 scripts/build_fd_solver_masterplan_full_pack.py --check
pnpm --dir apps/control-room typecheck
```

7. Zapisz exit code i source snapshot. Jeśli branch nadal jest za master,
   zatrzymaj wszystkie lane'y implementacyjne.

**Bramka G0:** merge jest rozstrzygnięty, checkpoint odtwarzalny, staged paths
opisane, baseline ma exit codes, a runtime nie jest jeszcze używany jako proof.

### Etap C1 — refresh physics note i scope

1. Zaktualizuj `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` oraz
   source map tak, aby bias scan był wejściem fizycznym, Kittel postsolve,
   `A_qq` runner-owned było opisane jako blocker, a GPU claims miały status
   source-visible/unvalidated.
2. Zdefiniuj exact scope IDs:
   `fem_k0_periodic_airbox_cpu_double_v1` i
   `fem_k0_periodic_airbox_gpu_double_v1`.
3. Uzupełnij w nocie: problem, równania, symbole/SI, założenia, FDM/FEM,
   CPU/GPU, Python/IR/planner/runtime/provenance, observables i validation.
   Nie kopiuj osobnych stron dla CPU/GPU; lane'y są rozdziałami realizacji.
4. W capability matrix pozostaw `unvalidated` aż do G2. Nie promuj statusu po
   przejściu testu dokumentacji.
5. Uruchom validator scientific docs, source-map tests i full-pack check.

**Bramka C1:** dokumentacja nie sugeruje kwalifikacji, path+symbol anchors są
stabilne, przykład Python jest stage-first i opisuje rzeczywisty K0 contract.

### Etap C2 — reverify po merge

C2 nie powinno być przepisywane. Po konflikcie/merge uruchom:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
  packages/fullmag-py/tests/test_problem_ir.py \
  packages/fullmag-py/tests/test_api.py::TestStudyApi::test_study_stage_builder_bias_field_sweep_roundtrips_cpu_and_gpu_intent
env CARGO_TARGET_DIR=/dev/shm/fullmag-c2-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-ir --test ir_tests eigenmodes_bias_field_sweep --quiet
env CARGO_TARGET_DIR=/dev/shm/fullmag-c2-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-plan fem_eigen_bias_field_sweep --quiet
pnpm --dir apps/control-room typecheck
```

Sprawdź, że każdy sample ma requested/resolved execution, FDM kończy się
`fallback=none`, a Kittel metadata nie ustawia pola/targetu/equilibrium.

### Etap C3 — ABI i certyfikat fail-closed

**Właściciel:** C ABI/FFI. **Nie edytować:** hot-loopów CPU/GPU, assembly,
UI ani artefaktów. Dozwolony jest wyłącznie backend-neutralny dispatch
`modal_eigen_solver.cpp`, jeśli zapisuje rzeczywisty resolved provenance bez
zmiany algorytmu.

1. Najpierw dodaj RED tests w `backends/fem/tests/frequency_domain/
   modal_eigen_contract_test.cpp` i `crates/fullmag-fem-sys/src/lib.rs` dla:
   short request/payload, unknown enum/schema/layout, stale cert/digest,
   pair mismatch, missing/unknown airbox marker, changed mesh/equilibrium/
   bias identity, resolved-field mismatch i destroy null/zero/partial/full/
   double.
2. W `native/include/fullmag_fem.h` utrzymaj append-only tail i jeden manifest
   schema/version. Publikuj `sizeof`/`offsetof` requestu, payloadu, resultu,
   `FullmagFemCsrMatrixView` i każdego używanego nested public field.
3. W `api.cpp::fullmag_fem_modal_eigen_solve` odczytuj tail dopiero po
   prefix-size check. Validation failure musi powstać przed dereferencją.
   Publiczny ABI v17 normalizuj do solverowego kontraktu v16 przed dispatch;
   każdy nieznany request/operator ABI odrzucaj na tej granicy, zanim odczytasz
   optional tail albo przekażesz request do `solve_modal_eigen_contract`.
4. Zwiąż `mesh_certificate_schema`, `mesh_certificate_digest`, osobny
   `mesh_certificate_map_binding_digest`, equilibrium/linearization/BC/gauge,
   `bias_field_sample_index`, stable sample ID/signature, magnetic/airbox part
   identity. Brak dowodu map binding odrzucaj.
5. `copy_frequency_domain_contract_result` ma przyjąć rzeczywiście resolved
   fields od backendu; nie kopiuj requestu i nie zostawiaj AUTO przy validation
   error. Backend-neutralny dispatch może ustawić te pola, ale nie może zmieniać
   hot-loopu ani udawać kanonicznego certyfikatu.
6. Dodaj Rust/C++ cross-language layout assertions i mechanicznie zaktualizuj
   FFI initializers. Nie dodawaj solver policy.
7. Uruchom RED, implementację i GREEN:

```bash
env CARGO_TARGET_DIR=/dev/shm/fullmag-c3-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-fem-sys --quiet
just verify-fem-frequency-domain-native-contract
env CARGO_TARGET_DIR=/dev/shm/fullmag-c3-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-runner native_fem --quiet
```

Jeżeli `ENOSPC` lub export lock wróci, zatrzymaj lane, zachowaj partial diff i
raportuj blocker; nie usuwaj targetów ani nie zabijaj procesów.

**Bramka C3:** ABI manifest C++ = Rust, stale/short/unknown input odrzuca się
przed solve, result ma resolved reality, destroy jest idempotentny.

#### Interim C3 v18 (stan po rozszerzeniu ABI)

Wspólny frequency-domain ABI ma teraz wersję `18`, z jawnymi prefiksami
zgodności `V16=16` i `V17=17`. Wszystkie trzy koperty modalne zachowują
kolejność append-only:

- request: `mesh_generation_identity`, `canonical_preimage_sha256`,
- shared payload: preimage wraz z długością, jego SHA-256, oba digesty klas
  (`magnetic`/`scalar`) oraz status/reason producenta,
- result: przeliczony digest preimage oraz resolved binding status/reason.

Warstwa C/Rust publikuje te pola w niezmienionym manifeście v2 (V17 prefix), a
nowy manifest v3 publikuje pełny rozmiar V18 payloadu, offset deskryptora oraz
`FullmagFemModalLinearizationDescriptor` v1. API odczytuje każdy tail wyłącznie
po sprawdzeniu `abi_version` i `struct_size`. Stare v16/v17 request/payload
mogą pozostać używalne, jeżeli ich prefix obejmuje konsumowane pola; payload
V18 bez pełnego deskryptora jest odrzucany przed dispatch.
W manifeście v1/v2 pole `modal_shared_domain_payload_size` jest odtąd
deklarowanym minimalnym rozmiarem prefiksu V17, a nie rozmiarem bieżącej
struktury V18. Konsument, który chce użyć V18, musi pobrać manifest v3 i użyć
pełnego rozmiaru oraz offsetu `linearization_descriptor`; nie wolno wyliczać
ich z lokalnego `sizeof` innej wersji nagłówka.

Native boundary ponownie liczy SHA-256 preimage i sprawdza długość oraz ścisłe
UTF-8. C ABI v17 przenosi już autorytatywne widoki relacji v6 (generator/
closure, region IDs i klasy magnetic/scalar), a `api.cpp` wywołuje pełny
`verify_mesh_symmetry_certificate_v6` przed akceptacją bindingu. C ABI v18
dodaje niezależny, backend-neutralny deskryptor liniaryzacji: SI units,
tożsamości digestów (state/equilibrium muszą być 1:1 z zaakceptowanym payloadem),
tangent/equilibrium/field/alpha arrays i typed exchange/DMI term views oraz
podpis dostawcy demagu. Deskryptor nie zawiera gotowego
`A_qq`, nie wybiera solvera i nie zmienia polityki UI/runnera. Niepoprawny lub
brakujący deskryptor daje stabilny fail-closed (`linearization_descriptor_*`).
Runner celowo wysyła obecnie `NULL`, więc managed native runtime pozostaje
zablokowany do czasu wygenerowania canonical descriptor handoff z natywnego
meshera/assembly; nie wolno wypełniać go syntetycznie z runner-owned CSR.
Focused C++ RED/GREEN obejmuje także short-v3 manifest, zgodność digestów
deskryptora 1:1 z zaakceptowanym payloadem oraz exact NULL/0 versus
non-NULL/nonzero dla aktywnego exchange termu. Weryfikacja źródłowa przechodzi;
brak biblioteki `libfullmag_fem` i managed export lock nadal blokują wykonanie.

Niezależny review C3 v18 potwierdził zamknięcie czterech akcji: pełnego
caller-buffer gate v3, spójnego slotu manifestu v2, byte-for-byte wiązania
digestów deskryptora z payloadem oraz dokładnego exchange `NULL/count`. To jest
approval source/ABI, nie managed runtime proof.

### Etap N1 — pełne natywne MFEM shared-domain assembly

1. RED: fixture realnego magnetic film + airbox z periodic x/y, open z,
   osobnymi part IDs, seams i corner classes. Dodaj negative certs.
2. Zaimplementuj kanoniczny verifier map-binding w
   `mesh_symmetry_certificate.*`: odbuduj klasy z `mesh.periodic_node_pairs`
   i markerów regionów, porównaj je z mapami payloadu i odtwórz digest z
   canonical preimage. Rozszerzenia payloadu są append-only; brak preimage,
   zgodności mapy albo part identity nadal kończy się fail-closed przed MFEM.
   Minimalny właścicielski widok wejściowy musi pochodzić z meshera/native
   mesh, nie z runnera: `abi_version`, `struct_size`, `node_count`, jawny
   `node_domain_kind[]` (magnetic/airbox), `node_region_ids[]`, osobne
   globalne `magnetic_periodic_pairs[]` i `airbox_periodic_pairs[]`, obie
   tożsamości partów oraz fingerprint certyfikatu topologii. Jeśli zachowany
   zostaje obecny helper pair-map, append-only payload v17 musi nieść te same
   pary z endpoint-region IDs; liczniki par nie są ich substytutem.
   Następnie backend-neutral verifier odbudowuje union-find pełnych klas
   magnetic/scalar, w tym tranzytywność i narożniki, i porównuje dokładne
   `magnetic_reduced_node[]`/`scalar_reduced_node[]` oraz class digests.
   Rust i C++ używają jednego, opisanego golden-vector preimage/digestu;
   obecny JSON runnera i tekstowy preimage helpera nie mogą współistnieć.
3. Przenieś assembly `A_qq` z `crates/fullmag-runner/src/fem/eigen_operator.rs`
   do `backends/fem/cpu/frequency_domain/operators/`; runner przekazuje tylko
   accepted linearization, mesh/map i physical terms.
4. Składaj wspólnie `A_qq`, `B_qq`, `A_qphi`, `A_phiq`, `P`, boundary mass i
   gauge. Magnetic terms widzą tylko magnetic regions, scalar Poisson cały
   shared domain.
5. Publikuj ordering, units, scaling, region IDs, BC/gauge, block digests i
   operator input signature.
6. Dodaj manufactured Poisson (Robin/Dirichlet/Neumann), reciprocity/energy,
   random-vector action, sign-flip negative control, region isolation i
   metadata perturbation invariant.
   Obowiązkowy test kolejności wykonuje solve na prawdziwym magnetic+airbox
   mesh z parą narożną/tranzytywną, mutuje pojedynczą klasę przy stałych
   licznikach i starym digest, a następnie wymaga stabilnego
   `periodic_mesh_equivalence_class_map_mismatch` przed alokacją MFEM;
   wynik ma `accepted=false`, puste CSR/operator digest i zerowe liczniki q/phi.
7. Uruchom, po integracji, managed recipes:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
```

**Bramka N1:** wszystkie produkcyjne bloki są natywne, real magnetic+airbox
fixture przechodzi, a niezgodny certyfikat zatrzymuje solve.

### Etap N2 — CPU solver i complete window

1. RED tests dla `EPSGetConvergedReason`, stop reason, operator/PC applies,
   restart/iteration counters, full unscaled magnetic/Poisson/gauge/tangent/
   reconstruction residuals, cancellation i partial artifact.
2. Zachowaj rotated pencil i target `tau=omega_target`; nie zamieniaj go na
   target oryginalnego `lambda=i omega`.
3. Dodaj fail-closed window coverage: failed subwindow blokuje `complete=true`,
   `nev`/shift refinement stabilizuje clusters, degeneracy porównuje
   invariant subspaces, dense descriptor oracle pokrywa małe przypadki.
4. Zakres sekwencyjnego `PETSC_COMM_SELF`/LU zapisz jawnie jako bounded;
   nie nazywaj go skalowalnym bez pomiaru.
5. Uruchom, po integracji, managed:

```bash
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell
```

**Bramka N2:** CPU ma accepted modes z pełnymi resztami, coverage certificate,
stop reason i jasno zapisanym scope DOF/time/memory.

### Etap N3 — GPU PETSc/SLEPc persistent i telemetry

1. RED tests dla cold/reuse/invalidation, cancel, zero count/NaN/unknown target,
   missing runtime, failed subwindow i no-fallback.
2. W `modal_petsc_slepc.cpp` utrzymuj przy tej samej operator signature:
   CUDA matrices/vectors, Poisson KSP/workspace, MatShell/mass, shifted PC,
   EPS/ST/KSP/PC, BV/basis/restart state, residual/result workspace.
3. Jawnie invaliduj po mesh/equilibrium/bias/BC/gauge/target/precision/operator
   change. Instrumentuj realne setup/hot-loop/final allocations, H2D/D2H bytes,
   GPU high-water, applies/iterations/restarts i EPS reason.
4. Zaimplementuj ten sam complete-window/cluster certificate co CPU; cancel
   przerywa EPS i resztę shiftów.
5. Rozdziel diagnostics exact materialized Schur+ILU od approximate Schur+HYPRE.
6. Wymuś trzy mierzone dimensions, w tym `operator_dimension > 1024`; etykieta
   testu nie zastępuje wymiaru z native artifact.
7. Managed verification dopiero przez:

```bash
just verify-fem-frequency-domain-gpu-petsc-slepc-runtime
just verify-fem-frequency-domain-eigen-k0-gpu-petsc-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
```

**Bramka N3:** niezależny trace potwierdza residency/no hot-loop full-vector
transfer, complete window, strict no-fallback, cancellation i scalable case.

### Etap A1S — artefakty i analiza jako serwerowe dane

Zamroź schematy przed implementacją A2/UI:

```text
frequency_domain/manifest.v1.json
eigen/spectrum.v2.json
eigen/branches.v2.json
eigen/field_sweep.v1.json
eigen/diagnostics/solver.v1.json
eigen/modes/{sample_id}/{mode_id}.json
eigen/mode_fields.zarr/{sample_id}/{mode_id}/vector_xyz_complex/...
fmr/peaks.v1.json
fmr/resonance_fits.v1.json
fmr/kittel_fit.v1.json
validation/frequency_domain_production_dod.v1.json
```

Każdy artefakt ma schema, source/runtime/scope ID, content revision/hash,
units, topology/indexing, requested/resolved execution, status complete/partial/
interrupted/corrupt i cross-artifact references. `fmr/peaks` jest derived
datasetem. Modalne frequency bez RF coupling/oscillator strength nie są
intensywnością FMR i nie uruchamiają peak extraction.

Dodaj verifier tests dla missing fields, wrong units, stale revision, wrong
sample/mode mapping, fabricated field, topology mismatch, invalid fit/covariance
i `complete=true` z brakami. Zakaz syntetycznych mode vectors w production
bundle.

### Etap A1E — przyczynowo zamknięty release DAG

1. Producer zapisuje raw CPU/GPU, convergence, parity, performance, sanitizer,
   browser i pre-release sidecars w trwałym staging.
2. Sidecar zawiera command, exit code, stdout/stderr hashes, timestamp,
   source/runtime/scope identity i verifier version.
3. Staged-release kopiuje zweryfikowane bytes do tymczasowego bundle root,
   ponownie sprawdza hash/size, tworzy evidence manifest i dopiero wtedy
   uruchamia DoD writer/verifier.
4. Existing destructive recipes nie mogą kasować staging input ani tworzyć
   evidence przed ukończeniem upstream gates.
5. Performance v2 wymaga trzech measured dimensions i jednego >1024; osobne
   memcheck/racecheck/synccheck sidecars są obowiązkowe dla GPU.

### Etap A2 — typed OpenAPI v2 i resource invalidation

1. Zastąp `Option<Value>` strukturami dla manifest/spectrum/branches/scan/
   diagnostics/modes/response/FMR/provenance.
2. Dodaj wszystkie `#[utoipa::path]`, generated JSON/types/client i centralne
   facades/hooks. Nie pisz endpoint strings w React.
3. Kanoniczne namespace:
   `/v2/sessions/current/analysis/frequency-domain/*`; stare aliasy mają jeden
   release deprecation i telemetry, potem znikają.
4. Revision/ETag jest content digest + source artifact revision; zmiana treści
   tej samej długości musi zmieniać revision.
5. WebSocket invaliduje manifest/spectrum/branches/scan/mode metadata/FMR/
   response progress, ale payload pobiera HTTP.
6. Mode field metadata publikuje `field_id`, sample/mode IDs, complex
   representation, components/order, units, topology/domain generation,
   phasor/k convention i source revision. Bytes płyną wyłącznie przez
   `/v2/sessions/current/data/fields/{field_id}/samples/vector`.

### Etap U0 — Results Navigator i stabilna selekcja

1. Dodaj `apps/control-room/src/modules/results-navigator/manifest.ts` i
   module w `panel-left`; obecny Results w Explorerze pozostaje chwilowym
   compatibility shim.
2. Kernel layout rejestruje `workspace.results.frequency-domain`; ribbon używa
   context `results`. Nie twórz drugiego shellu ani FEM-only viewportu.
3. Wprowadź stabilne IDs:

```ts
type ModalSelectionRef = {
  kind: "modal-mode";
  runId: string; stageId: string; artifactRevision: string;
  sampleId: string; modeId: string; branchId?: string;
};
type ResponseSelectionRef = {
  kind: "response-point";
  runId: string; stageId: string; artifactRevision: string;
  pointId: string; observableId?: string;
};
```

`sampleIndex`, `rawModeIndex`, `frequencyIndex` są metadata display-only; nie
są node ID, cache key ani identity.

4. Usuń silent `slice(0, 64)`, zastosuj virtualisation/pagination; każdy node
   ma resource/state/inspector mapping. Brak zasobu to `missing/unsupported/
   partial/error`, nie fikcyjne `ready`.
5. Pure adapters przyjmują typed payload dla manifest/spectrum/scan/branches/
   response/FMR i nie parsują `unknown` w komponencie.

### Etap U1 — Analysis, FMR i Inspectory

Powierzchnie centralne:

1. **Eigen Spectrum:** X = mode index/rank, Y = frequency w jednostce
   artefaktu; tabela klawiaturowa jest równoważna chartowi.
2. **Field Sweep:** X = `[H_bias]` w A/m albo jawnie oznaczone `mu0 H` w T,
   Y = frequency; kolor = branch, nigdy backend.
3. **Modal Resonances:** tylko frequency markers. Intensywność/peak detection
   jest ukryte, jeśli nie ma physical RF coupling/oscillator-strength artifact.
4. **Driven FMR:** X = frequency, Y = wybrany observable z jednostką artefaktu;
   amplitude/susceptibility/power/phase nie mogą być mieszane bez selektora.
5. **Field-Frequency Map:** tylko realny dwuwymiarowy dataset, bez sklejenia
   dwóch niezależnych scanów w UI.
6. **Dispersion:** modalny k-path; nie dynamic structure factor.
7. **Modal vs Driven:** tylko z serwerowym compatibility certificate obejmującym
   run/stage, equilibrium, mesh/topology, BC/gauge, damping, drive/polarisation,
   observable, normalization, phasor i source revisions.
8. **Fits:** peak/fitting/Kittel są analysis jobs z serwerowym artefaktem,
   source revision, model, fit range, linewidth, Q, covariance, uncertainty,
   conditioning i residual. Inspector przechowuje tylko draft.

Podziel `FrequencyDomainResultInspectors.tsx` domenowo:

```text
frequency-domain/overview/
frequency-domain/eigen/
frequency-domain/scan/
frequency-domain/response/
frequency-domain/fmr/
frequency-domain/validation/
frequency-domain/resources/
frequency-domain/diagnostics/
```

Każdy semantic node ma osobny Inspector; generic fallback pokazuje
`unsupported inspector`, nigdy cudzy panel. Header panelu zawsze pokazuje:
`product | run/stage | artifact state | qualification | resolved execution`.

### Etap U2 — zespolone pole modowe w unified viewport

1. Command `Plot in 3D` tworzy kernel-owned `FieldOverlayIntent`; źródłowy
   chart/Inspector może się odmontować bez abortowania handoffu.
2. Pipeline: selection -> field metadata -> binary field -> topology/domain
   generation check -> render model -> viewport ACK. Late completion sprawdza
   token, selection i revision; superseded request jest zwalniany.
3. Domyślne pole to complex Cartesian `delta_m_xyz`; tangent-local `q` nie jest
   renderowane jako XYZ bez certyfikowanej rekonstrukcji.
4. Obsłuż representation matrix:

| Reprezentacja | Render | Glyphs |
|---|---|---|
| real/imag/phase-rotated real vector | signed/vector glyphs albo scalar component | tak tylko dla vector |
| magnitude | scalar `abs` | nie |
| phase | scalar cyclic, z amplitude mask i component/projection | nie |
| complex `delta_phi` | scalar real/imag/magnitude/phase | nigdy glyph |

5. Phasor convention bierze się z artifact metadata; renderer nie zgaduje
   znaku czasu. Dla `k=0` `k_f`/origin/Floquet są jawnie zerowe. Suwak phase
   jest lokalną projekcją jednego załadowanego complex field i nie pobiera go
   ponownie na tick.
6. Przy zmianie mode/phase na tym samym topology ID nie przebudowuj geometry;
   wymień field buffers i zwolnij poprzednie zasoby. Animacja zatrzymuje się na
   clear/tab change/unmount i respektuje reduced motion.
7. Dodaj memory stress >=100 zmian mode/phase/tab oraz browser proof osobno
   CPU/GPU i real/imag/magnitude/phase/phase-rotated-real. Proof wymaga
   `gl.isContextLost() == false`, canvas visible i drawing buffer >0.

---

## 7. Kwalifikacja i release

### R1 — jeden release candidate

Po scaleniu C1–C3, N1–N3, A1S/A1E, A2, U0–U2 jeden integration owner:

1. sprawdza clean ancestry/source snapshot;
2. wykonuje host-wide read-only lock/mount audit;
3. uruchamia `just rebuild-fem-runtime`, `just ensure-managed-fem-runtime`,
   `just verify-managed-fem-runtime-source-provenance` i dependency inspect;
4. zamraża runtime manifest (commit, source snapshot, ABI, PETSc/SLEPc/MFEM/
   CUDA/device) oraz nie przełącza go ponownie w Q1/Q2/Q3.

### Q1 — CPU

1. Exact CPU scope, manufactured Poisson, sign/energy/reciprocity, dense vs
   Schur, target-axis negative control.
2. Fizyczny BiasFieldSweep: każdy sample ma własne equilibrium, certificate,
   operator signature i artifact ID.
3. Trzy poziomy mesh i trzy poziomy airbox padding, osobne convergence budgets.
4. Każdy accepted mode: magnetic, Poisson, gauge, tangent i reconstruction
   residual oraz complete-window/cluster certificate.
5. CPU oracle dla tych samych trzech performance cases GPU, w tym measured
   `operator_dimension > 1024`.
6. Raw staging index, nie final bundle; DoD dopiero po Q3.

### Q2 — GPU

1. CPU/GPU mają równoważny operator input signature; equilibrium hash może być
   lane-specific, lecz physical tolerance musi być jawna.
2. Porównaj blocks/actions, clusters/subspaces, residuals, accepted outcomes,
   fields i artifacts.
3. Zmierz cold/reuse/invalidation, memory, allocations, H2D/D2H, EPS/KSP,
   apply/restart/stop. Niezależny trace jest wymagany.
4. Cancel przed/w trakcie EPS i między subwindows; strict negative controls:
   missing CUDA/HYPRE/SLEPc, stale ABI/cert, illegal input, no CPU fallback.
5. Compute Sanitizer memory/race/sync oraz trzy real dimensions, jeden >1024.

### Q3 — native browser i release

Dla CPU i GPU osobno, bez fixture interception:

1. Results Navigator -> run/stage -> Frequency Domain -> Spectrum/Field Sweep.
2. Wybór tego samego mode z tree, chart i table daje identyczny SelectionRef.
3. Mode Inspector pokazuje full residual/provenance/qualification.
4. `Plot in 3D` wykonuje wszystkie reprezentacje i zmianę mode/phase; WebGL
   proof zapisuje screenshot, field/topology/revision IDs, console/network,
   resource counts i drawing buffer.
5. Sprawdź stale/partial/interrupted/error/corrupt/unsupported, Mocha/Latte,
   reduced motion i 100-switch stress.
6. Modal Resonances, Driven FMR i Comparison pokazują osobne source kinds;
   brak coupling artefactu nie daje intensywności modalnej.
7. Ingestuj raw evidence, uruchom DoD writer/verifier i utwórz immutable
   scientific manifest. G2 może później zmienić wyłącznie allowlistowane
   capability/readiness docs i stworzyć promotion attestation wiążącą R1,
   G2 i manifest.

---

## 8. DOD-01–DOD-14 — stan i kryterium zamknięcia

| DoD | Stan teraz | Co zamyka |
|---|---|---|
| 01 Physics note | częściowo | C1 validator, scope i source-map |
| 02 Python/UI round-trip | C2 częściowo | post-merge positive/negative + export identity |
| 03 ProblemIR | C2 mocne | pełny post-merge legal matrix |
| 04 Planner | C2 mocne | fresh strict CPU/GPU/auto provenance |
| 05 Certyfikaty | otwarte | C3/N1 map binding, seams, corners, invalidation |
| 06 Native assembly | otwarte | N1 natywne `A_qq` + independent oracles |
| 07 Solver | source-visible | N2/N3 convergence/window/stop/no-fallback |
| 08 Residuals | source-visible | każdy accepted mode i oryginalne blocks |
| 09 Artifacts/API/UI | częściowo | A1S/A2/U1/U2 typed/native browser |
| 10 Analytical | historyczne tylko | niezależny scan + Kittel postsolve fit/uncertainty |
| 11 Convergence | otwarte | 3 mesh + 3 airbox CPU/GPU |
| 12 Parity | historyczna tylko | exact operator signature + clusters/subspaces/fields |
| 13 Performance | otwarte | CPU envelope; GPU >1024, trace, memory, cancel, sanitizers |
| 14 Release | otwarte | pre-release regression, DoD, immutable manifest, G2 attestation |

Promocja jest legalna wyłącznie, gdy oba exact scopes mają
`implementation_state=executable`, `validation_state=physics_validated`,
`promotion_decision=production_qualified`, `open_blockers=[]`, a API/UI czytają
zweryfikowaną attestation. `source_visible`, zielony unit test, historyczny
Kittel ani obecność route nie spełniają tego warunku.

---

## 9. Kontrakt handoffu dla każdego subagenta

Każdy implementer oddaje:

1. commit SHA i listę dokładnie zmienionych plików;
2. krótki kontrakt wejścia/wyjścia i zależności od poprzedniego lane'u;
3. RED command + pierwszy błąd;
4. GREEN command + pełny exit code/output summary;
5. testy negatywne i brak cichego fallbacku;
6. wpływ na wcześniejsze evidence (czy unieważnia R1/Q1/Q2/Q3);
7. nierozwiązane ryzyka i następny gate.

Reviewer dostaje package z `scripts/review-package BASE HEAD`, sprawdza scope
compliance i jakość. Critical/Important wracają do tego samego implementera;
po clean review aktualizowany jest progress ledger. Nie łączymy dwóch agentów
współwłaścicieli jednego pliku.

---

## 10. Źródła i granice twierdzeń

Kanoniczna fizyka pozostaje w:

- `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`;
- `docs/plans/active/fd_sovler_masterplan/24_production_definition_of_done.md`;
- `docs/plans/active/fd_sovler_masterplan/27_fem_k0_eigensolve_production_completion_and_control_room.md`;
- `docs/specs/frequency-domain-artifacts-v2.md`;
- `docs/specs/resource-first-control-room-api-v2.md`.

Ten dokument jest audytem i instrukcją kolejności. Nie zastępuje publikacyjnej
noty fizycznej, nie zmienia capability matrix i nie nadaje statusu
`production_qualified`. Każde twierdzenie runtime wymaga świeżego managed
recipe, identyfikacji urządzenia, source snapshotu i hash-bound evidence.

## 11. Definition of done tego planu

Plan jest wykonany dopiero, gdy:

- G0 ma aktualny `master` jako przodka i clean recovery checkpoint;
- C2 jest ponownie zielone po merge, C3 i N1 są zaakceptowane;
- CPU i GPU mają osobne, pełne evidence exact-scope;
- artifacts/API/Results/Inspectors/viewport działają na tych samych native
  resources i revisions;
- FMR modal/driven/comparison nie mieszają produktów ani jednostek;
- Q3 przechodzi bez fixture interception, z WebGL proof CPU/GPU;
- DOD-01–DOD-14, scientific manifest i G2 attestation są zamknięte.
