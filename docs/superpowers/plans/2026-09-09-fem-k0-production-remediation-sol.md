# FEM K0: pełny plan poprawek i kwalifikacji produkcyjnej dla Sola

Data planu: 2026-09-09. Checkpoint 2026-09-10: **wykonano S00 w zakresie
baseline i zabezpieczenia dowodów; S01–S14 nie rozpoczęto w tym zleceniu**.

Wynik, kontrole C01–C03, ograniczenia i decyzje o odzysku opisuje
[raport S00](../../audits/2026-09-10-fem-k0-s00-baseline-and-evidence.md).
Stan cyklu integracji dokumentów jest osobny od odbioru danych S00.

Dokument obejmuje skorygowany audyt, rejestr problemów, zadania implementacyjne,
testy, kolejność, dowody odbioru i przekazanie do wykonania. Zastępuje kolejność
pozostałych prac w audycie `docs/audits/2026-08-29-fem-k0-eigensolve-plan-realization-audit-and-remaining-implementation-plan.md`.
Zachowuje historię tego audytu; nie unieważnia poprawnych dawnych wyników ani nie
zmienia automatycznie canonical physics/ABI. Początkowe zlecenie obejmowało
przygotowanie planu; kolejne zlecenie z 2026-09-10 autoryzuje wyłącznie S00.

## 1. Instrukcja startowa dla Sola

Po otrzymaniu zlecenia wykonania realizuj zadania S00–S14 poniżej. Zachowaj model
i reasoning wybrane przez użytkownika. Nie zaczynaj od kolejnego wielogodzinnego
antidot/window ani od pisania solvera od nowa. Najpierw zabezpiecz i rozlicz
istniejącą poprawkę Neumanna oraz napraw tożsamość artefaktów.

Każde zadanie ma własny wynik i bramkę. Prowadź ledger: ID, status, source SHA,
zmienione symbole, komenda, exit code, dowód, otwarte problemy. Dozwolone statusy:
`not_started`, `in_progress`, `implemented`, `verified`, `blocked`,
`not_applicable_with_reason`. `implemented` nie jest kwalifikacją.

Przed edycją czytaj plik i istotnych konsumentów. Ponownie sprawdzaj aktualny
master: poniższe SHA są snapshotem audytu, nie poleceniem cofnięcia repozytorium.
Przy istniejącej równoważnej poprawce zweryfikuj ją i zalicz zadanie bez
ponownego przepisywania. Odkryta wada otrzymuje ID, reprodukcję i regression test.
Hipoteza nie staje się potwierdzonym błędem przez wpisanie jej do planu.

Stosuj `AGENTS.md`, instrukcje backend/contracts/scientific/frontend odpowiednio
do obszaru. Skille: `executing-plans`, `backend-golden-masterplan`,
`fem-native-backend-architecture`, `scientific-documentation-contract`, a przy
konkretnych zmianach także `test-driven-development`, `resource-first-api-check`
i właściwy frontend-v2 skill. `using-git-worktrees` przed izolacją;
`verification-before-completion` i `finishing-a-development-branch` przy odbiorze.
Nie uruchamiaj niezwiązanych workflow tylko z powodu tej listy.

## 2. Tożsamość źródeł i stan faktyczny

Zweryfikowane w czasie przygotowania planu:

| Element | Wartość / dowód |
|---|---|
| Główny checkout | `C:/git/fullmag/fullmag` |
| Lokalny master i lokalny ref origin/master w audycie | `1620d2762d99b58cddcfc93f7eb505b84dfbf178`; nie wykonywano fetch |
| HEAD checkoutu | `c6fd35e909bb1fbc7b62fc35e1c180c6cef8374b`, branch `fix/viewport-3d-audit-s16-postprocessing-20260909` |
| Różnica HEAD względem mastera | trzy pliki postprocessingu viewportu; analizowany solver odpowiada masterowi |
| Finalizacja historyczna | `e3241af9a7815b63809cb8b99e83be5efbc51a18` |
| Integracja finalizacji | `4c7897f218eb0c32612db1f43a844502a316b4f6`, merge z 2026-09-01; ancestor mastera |
| Późniejsza poprawka Gamma | `f0986ede9853828dfd573a2bee12302385213321`; nie jest ancestor badanego mastera |
| Tip późniejszej diagnozy | `93e1ca38423ddb661a21c76b05bb02bfaf5c9826`, branch `codex/k0-exchange-only-diagnosis-20260901`; dwa commity poza masterem |

Checkout zawiera cudze zmiany: modyfikacje submodułów oraz w chwili przygotowania
planu usunięcia artefaktów UI. Nie przywracaj, nie stage'uj i nie sprzątaj ich.
Nie usuwaj żadnego z dwóch historycznych worktree: późniejszy zawiera dowód
naukowy poza śledzonymi plikami Git.

### 2.1. Korekta wcześniejszego raportu: wynik Neumanna istnieje

Oryginalny bundle wykresu odnaleziono pod:

`C:/git/fullmag/worktrees/k0-exchange-only-diagnosis/examples/fem_eigen_k0_kittel_periodic_airbox.zarr`

Istotne pliki wewnątrz `artifacts/`:

- `fmr/kittel_fit.v1.json`;
- `eigen/diagnostics/solver.v1.json`;
- `metadata.json`;
- `eigen/modes/sample_0000/mode_0000.json`;
- `validation/kittel_k0_pbc/kittel_vs_fem_pure_neumann.png`.

Niezależny recompute częstotliwości Kittela z 15 pól, `Ms=800000 A/m` oraz
`gamma0=221100 rad/(s A/m)` dał maksimum błędu względnego
**5.194679480952314e-14**. Wykres zaokrągla je do `5.20e-14`.
To około `5.20e-12%`, nie kilka procent. Diagnostyka zapisuje
`solver_adapter=k0_poisson_airbox_cpu_schur_slepc`, `execution_lane=production_cpu`,
`outer_boundary_kind=pure_neumann`, `gauge_policy=mean_zero_augmented`,
`robin_beta=0`, `solve_succeeded=true`.

`metadata.build_identity`:

- `built_at_utc=2026-09-01T15:56:42Z`;
- `git_commit=4c7897f218eb0c32612db1f43a844502a316b4f6`;
- `worktree_state=dirty`;
- `source_snapshot_sha256=e5679faa14d8f6fc5010aef436c117aad52194e02caab50f3411d49ae5a8fd3a`.

Ten build zawiera dirty snapshot. Sam `git_commit` nie utożsamia go z czystym
merge commitem ani z późniejszym `f0986ede9`. S00 musi rozliczyć patch/manifest.
Nie należy powtarzać twierdzenia, że brak jakiegokolwiek wykonanego wyniku
Neumanna. Potwierdzono dane i ich liczbową zgodność, ale nie wykonano teraz nowego
native solve ani pełnego odtworzenia runtime.

### 2.2. Ten sam bundle ma realny błąd kontraktu artefaktów

Aktualny `scripts/verify_fem_frequency_domain_eigen_artifacts.py` zwrócił exit 1:

```text
eigen/modes/sample_0000/mode_0000.json.source_mesh_topology_sha256
vs source_mesh_identity.topology_fingerprint:
got      sha256:f4fec5288a6d60572e746a6f49d0609e6e59400a6e90bcecc90a05daa166ab2f
expected sha256:24b579a71f974f28bf441ab35adca69326ad4faf8514a3daacb00f449190cc03
```

To potwierdzona niespójność historycznego bundle, nie dowód błędnych
częstotliwości. Przyczyna w aktualnym writerze wymaga regression testu.
`eigen_output.rs::write_eigen_v2_bundle` tworzy `source_mesh_identity` z
`plan.mesh.topology_fingerprint_v6()`, a następnie kopiuje osobny
`source_mesh_topology_sha256` z legacy mode. Nie naprawiać przez wyłączenie
porównania, ręczne podmienienie hashy ani zmodyfikowanie historycznego wyniku.

Ponadto bundle zapisuje:

- Kittel `validation_status=passed`, lecz `status=partial`, `complete=false`,
  `stop_reason=statistical_fit_covariance_not_available`;
- `runtime_id=runtime:not_provided`, `run_id=run:current`, `stage_id=stage:eigenmodes`
  w artefakcie Kittela;
- ogólne provenance `demag_operator_kind=fem_poisson_robin` i
  `resolved_demag_realization=fem_poisson_robin`, mimo dynamicznego Neumanna;
- ogólne `status=completed`, ale `completion.converged=false`.

Nie wszystkie te pola muszą być błędami: statyczny demag i dynamiczny operator
mogą mieć osobne role, a brak covariance dotyczy fitu, nie solve'u. S04/S10 mają
wyeliminować niejednoznaczność i wykazać semantykę testami.

### 2.3. Stary Robin to osobny punkt odniesienia

`C:/fullmag-cache/state/fem-gpu/reports/k0-kittel-cpu-v3/artifacts` zawiera
15-punktowy wynik Robin: max `0.039032979923277054`, mediana około `0.0372463`,
fit `M_eff=738461.5384615323 A/m`, `beta=25e6 1/m`, gauge `none`.
Ogólny walidator i jego opcje Kittela przeszły. Nie jest to wynik poprawionego
Neumanna ani pełna bramka produkcyjna. Zachować jako kontrolę negatywną.

Katalogi historycznych `periodic-antidot-q1-cpu-current/artifacts` i
`k0-kittel-gpu-v3/artifacts` pod tym samym reports root miały wyłącznie
`field-storage.v1.json`. To brak terminalnego wyniku tych przebiegów, nie
globalny dowód nieistnienia innych runów. S00 wykonuje ograniczoną inwentaryzację.

## 3. Zakres końcowego produktu

Zakres podstawowy: FEM P1/double, dokładne Bloch k=0, modal eigen z dynamicznym
demag, jednorodny film i periodyczny antidot, CPU oraz GPU, selected/nearest i
uczciwie certyfikowane okno, bias sweep, artefakty/FMS/API/Control Room.
Natywna implementacja zachowuje obecne ograniczenia materiałów i operatorów;
anisotropy/DMI, fe_order>1, FDM eigen, pełne nonzero-k demag oraz nowe sprzężenia
nie są domyślnie dopisywane do zakresu. Unsupported ma być konsekwentne we
wszystkich warstwach, również przy reużyciu cache.

Oryginalny plan 27 obejmuje też powierzchnie FMR/driven response. S11 rozlicza
K0-P7 i modal-versus-driven jako osobny produkt: nie wolno ani pominąć tej pozycji,
ani nadać driven statusu produkcyjnego na podstawie modal qualification.

Dense oracle jest dopuszczalny do niezależnego małego testu. Produkcyjny claim
skalowalnego wybranego widma wymaga matrix-free i rzeczywistego rozmiaru >1024.
Nazwa `production_cpu`/`production_gpu` jest lane'em, nie certyfikatem wydania.

## 4. Rejestr poprawek i rozstrzygnięć

| ID | Priorytet i klasa | Ustalenie | Zadanie |
|---|---|---|---|
| K0-01 | P1, luka integracji | Poprawka `f0986ede9` poza masterem; stary worktree scalony | S00–S02 |
| K0-02 | P1, kontrakt fizyczny | Master nie rozróżnia dynamicznego Gamma przy wyborze airbox BC | S01–S03 |
| K0-03 | P1, ograniczenie poprawki | Neumann dokładny dla jednorodnej harmonicznej; nie dla każdej G≠0 antydotu na skończonej granicy | S01, S06–S07 |
| K0-04 | P1, potwierdzony artifact failure | Dwa hashe topologii w bundle Neumanna | S04 |
| K0-05 | P1, provenance do rozliczenia | Dirty build identity; runtime placeholders; statyczny Robin/dynamiczny Neumann mieszają role | S00, S04, S10 |
| K0-06 | P1, brak funkcji GPU | Produkcyjny adapter wymaga Robin/gauge none | S08 |
| K0-07 | P1, luka kwalifikacji | Domyślne progi skryptu zbieżności luźniejsze niż K0-G7; brak pełnej bramki mediany | S05 |
| K0-08 | P1, luka parytetu | Skrypt częstotliwości/residuali nie porównuje pełnych podprzestrzeni i zespolonych modów | S09 |
| K0-09 | P1, brak końcowego dowodu | Pełne okno antydotu Q1 niepotwierdzone | S07, S13 |
| K0-10 | P1, brak końcowego dowodu | GPU residency/scale/robustness oraz Q2 niepotwierdzone | S08–S09, S13 |
| K0-11 | P1, brak końcowego dowodu | FMS restart, API i rzeczywisty overlay/WebGL na tych samych artefaktach | S10, S12–S13 |
| K0-12 | P2, ryzyko metryki | Uniformity zależy od airbox nodes/heurystyki layoutu i fallbacku wag | S05 |
| K0-13 | P2, semantyka | Sukces solve, kompletność widma, fit i qualification muszą być rozdzielone | S04, S10–S11 |
| K0-14 | P1, kwalifikacja release | Brak jednego immutable candidate i kompletnego DOD-01–14 | S13–S14 |
| K0-15 | P1, audyt do domknięcia | Binding acceptance/source/operator i spójność statycznej energii z dynamiczną liniaryzacją | S03 |

Nie deklarować naprawy K0-12/K0-15 bez wykazania problemu lub pozytywnego testu
aktualnego kodu. Nie kwalifikować wyniku tylko dlatego, że żadna nowa wada nie
została znaleziona podczas review.

## 5. Decyzje fizyczne i numeryczne

1. Ujednolicić w nocie 0830: potencjał, znaki, SI, phasor, oryginalny pencil,
   warunki boczne, zewnętrzne i gauge. Dla płaskiej granicy harmoniczna ma DtN
   `partial_n(phi_G) + |k+G| phi_G = 0`. W Gamma tylko G=0 redukuje się do
   jednorodnego Neumanna. Nie pisać, że każde pole okresowe jest jednorodne.
2. Dla filmu uniform Neumann/mean-zero jest kontrolą dokładnego problemu.
   Dla antydotu skończony airbox z Neumannem może być kwalifikowany jako
   przybliżenie dopiero po wykazaniu błędu obcięcia. Jeśli nie mieści się w
   budżecie przy praktycznym koszcie, wdrożyć boundary operator DtN albo
   istniejącą zgodną metodę periodycznego exterior, z osobną notą/ADR i testami.
   Nie wybierać nowej biblioteki przed sprawdzeniem istniejących operatorów.
3. Static H_eff0 i dynamiczna pochodna muszą odpowiadać zadeklarowanej energii
   i warunkom fizycznym. Zmiana wyłącznie dynamicznego Robin na Neumann nie
   wystarcza jako dowód dla niejednorodnego equilibrium antydotu.
4. Gauge usuwa arbitralną stałą potencjału; nie może zmieniać pola ani widma.
   Testować zgodność RHS z nullspace i mean-zero, a nie maskować problemu
   sztuczną dodatnią diagonalą lub przypięciem fizycznie innego problemu.
5. Zachować oryginalne residuale q/phi/gauge, mean weights z FE i niezależny
   recompute. Nie używać samego SLEPc residual jako full descriptor proof.
6. Nie traktować wyniku `5e-14` jako obowiązkowej uniwersalnej tolerancji na
   wszystkich meshach. Dla uniform fixture oczekiwać bliskiej precyzji double
   zgodności; dla kwalifikacji obowiązują jawne budżety z S05/S06.

Podstawa fizyczna: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`,
`0831-fem-dynamic-pencil-modal-response-and-krylov.md`, `0800-fem-static-pbc-demag.md`.
Kontekst periodycznej magnetostatyki: Bruckner et al., Scientific Reports 11,
9202 (2021), https://www.nature.com/articles/s41598-021-88541-9.
Wzór DtN wyżej wynika z Fourierowskiego rozwiązania równania Laplace'a na
zewnątrz płaskiej komórki; jest rozumowaniem do udokumentowania, nie claimem
o istniejącym operatorze DtN w Fullmag.

## 6. Kolejność i zależności

```text
S00 inventory + evidence
  -> S01 physics contract
  -> S02 planner/integration -> S03 native CPU/handoff -> S06 CPU science -> S07 window
  -> S04 artifact identity -> S10 API/FMS -> S12 browser preparation
  -> S05 validators -------------------------------> S06 / S09
S03 + S06 -> S08 GPU gauge/residency -> S09 parity/robustness
S03 + S04 -> S11 driven/FMR (separate scope)
S07 + S09 + S10 + S11 + S12 -> S13 frozen qualification -> S14 release/integration
```

S04/S05 można wykonywać równolegle po uzgodnieniu S01. Prace źródłowe UI nie
muszą czekać na GPU; końcowy browser proof musi używać poprawnych CPU/GPU
artefaktów. Jeden owner koordynuje ABI, wspólne schemas, staging i buildy.
Delegacja tylko dla niezależnych zadań zgodnie z hostem i AGENTS; modelu nie
zmieniać dla oszczędności ani na podstawie liczby plików.

## 7. Zadania implementacyjne

### S00 — zabezpieczenie dowodów, baseline i izolacja

**Wejście:** zlecenie wykonania; obecny master i oba historyczne branche.

**Praca:**

- Ustalić ponownie checkout/status/refs i właścicieli aktywnych zasobów.
- Zarejestrować jedno worktree zadania według storage governance; nie przejmować
  `k0-exchange-only-diagnosis` i nie usuwać jego `.zarr`.
- W kontrolowanym storage zachować kopię bundle Neumanna, manifest plików/SHA256,
  build identity, komendę historyczną jeśli dostępna, wykres i jego input.
  Brak historycznej komendy/manifestu oznaczyć, nie odtwarzać z domysłu.
- Porównać dirty snapshot `e5679f...` z runtime manifestem i patchem, jeśli
  zachowane. Nie przypisywać wyniku wprost do `f0986ede9` bez tego dowodu.
- `git show` obu niezintegrowanych commitów: podzielić poprawki fizyki, ABI,
  Docker/build, przykłady i dokumentację; wykluczyć unrelated/WIP/generated.
- Przenieść tylko sprawdzone zmiany niezależne od S01 na aktualny master w
  worktree zadania. Integracja kontraktu Gamma pozostaje w S02 po S01;
  w S00 rozliczyć kandydatów i jawnie odnotować odroczenie niezweryfikowanych
  hunków. Nie wykonywać ślepego merge całego historycznego worktree.

**Wynik:** ledger baseline, source map, inventory istniejących Q1/Q2/Q3,
chronologiczna tabela Robin vs Neumann, zachowane artefakty.
**Odbiór:** samodzielne odtworzenie błędu 5.195e-14 oraz artifact failure;
brak zmian w historycznych danych. Komendy C01–C03.
**Commit:** `docs(fem): bind K0 remediation baseline and evidence`.

### S01 — kontrakt granicy i zakresu produkcyjnego

**Pliki:** nota 0830 i jej source-map, nota 0831/0800 w zakresie wspólnego
kontraktu, `docs/architecture/backend-golden-masterplan.md`, capability MD/JSON,
oryginalny plan 27 i historyczny audyt (krótki odsyłacz do nowego planu).

**Zmiana:** wdrożyć decyzje sekcji 5; rozdzielić static/dynamic BC oraz rolę gauge,
film/antidot, modal/driven, selected/window, source/executable/validated.
Usunąć z aktualnych opisów tezę, że zmiana rozmiaru bocznej komórki PBC jest
naprawą fizycznego Kittela. Zamrozić parametry i progi S05/S06 przed solve.
Jeżeli zmienia się publiczna semantyka, zastosować ADR-check; nie tworzyć
alternatywnej fizyki w UI ani osobnego ukrytego parametru.

**Odbiór:** każda zmieniana decyzja ma source/test anchor; walidacja source-map
C04; jawny zakres przybliżenia i brak promocji capability.
**Commit:** `docs(fem): define K0 exterior and qualification contract`.

### S02 — integracja planner/IR/DSL i fail-closed device resolution

**Pliki:** `crates/fullmag-plan/src/mesh.rs::build_air_box_config`,
`crates/fullmag-plan/src/fem.rs`, `crates/fullmag-plan/src/tests.rs`,
`crates/fullmag-ir/src/plan.rs`, `packages/fullmag-py`,
`crates/fullmag-runner/src/fem/eigen_execution_resolution.rs`,
`eigen_execution.rs`, `eigen_tests.rs`; istniejące przykłady K0.

**Zmiana:** przenieść poprawkę Gamma po S01, zachować publiczny intent.
Jawne GPU bez gauge support odrzuca przed solve; auto może wybrać CPU jedynie
zgodnie z policy z zapisanym powodem. Nie zmieniać user precision ani engine
przy okazji. Static Robin dla odrębnego, skończonego modelu pozostaje legalny.
Sprawdzić wywołania `build_air_box_config` dla eigen, response, relax/time domain.
Nie mylić zerowego markera oznaczającego brak essential BC z brakującym meshem.

**Testy:** dynamic eigen i response Gamma; static/open Robin; Dirichlet;
niezerowe k; brak par phi/m; pełne 3D PBC bez konwencji; unsupported order/
material/precision; strict cpu/gpu/auto przy available/unavailable GPU;
Python->IR->planner->native diagnostics oraz UI-export round-trip.

**Odbiór:** zgodne requested/resolved i stabilne rejection reasons; C05,
targetowane Python tests wyszukane przed edycją, C07 CPU po zmianie ABI/native.
**Commit:** `fix(fem): resolve exact Gamma boundary and device support`.

### S03 — natywne CPU, spójna liniaryzacja i binding equilibrium

**Pliki:** `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp::assemble_native_magnetic_a_qq`,
`poisson_airbox_schur_matshell.cpp`, `poisson_airbox_modal_eigen.cpp::apply_poisson_airbox_modal_residual_certification`,
`backends/fem/src/api.cpp`, `native/include/fullmag_fem.h`,
`crates/fullmag-runner/src/fem/relax/finalize.rs`,
`eigen_equilibrium_contract.rs`, `eigen_certificate.rs`,
`crates/fullmag-runner/src/native_fem/frequency_domain.rs`.

**Zmiana:** wykorzystać istniejącą augmentację CPU, uzupełnić wyłącznie wykazane
luki. Bind: m0, accepted criterion/threshold/unit, mesh/region/material,
static i dynamic BC, operator/pencil, source identity i digest pól recompute.
Zachować frozen result ABI; rozszerzać caller-sized/versioned envelope po testach
layoutu i prefix-size. Nie dodawać physics assembly do runnera ani bridge.

**Testy:** oryginalny residual q/phi/gauge; constant-shift invariance phi;
kompatybilność RHS; dodatnie FE mean weights; perturbacja tangent i finite
difference H_demag oraz energia/field directional derivative na uniform i
niejednorodnym stanie; mass scaling; periodic seams/corners; zgodność static
operator derivative z modal operator. Mutacje digestu, materiału, BC, m0,
acceptance i source odrzucane przed solve. Torque i energy acceptance zachowują
user-owned semantics, bez nowego ukrytego progu relaksacji.

**Odbiór:** C05–C07 CPU plus managed kontrakty zmienionych operatorów. Jeśli
statyka/dynamika realizują różne przybliżenia, zgłosić i naprawić lub jawnie
zakwalifikować błąd; uniform Kittel sam nie zamyka tej pozycji.
**Commit:** `fix(fem): certify K0 linearization and mean-zero CPU operator`.

### S04 — jedna tożsamość meshu, provenance i publikacja wyników

**Pliki:** `crates/fullmag-runner/src/fem/eigen_output.rs::write_eigen_v2_bundle`,
`eigen_native_artifacts.rs::native_modal_artifacts`, `eigen_native_window.rs`,
`eigen_path.rs`, `crates/fullmag-runner/src/eigen/artifacts/mod.rs`,
`crates/fullmag-runner/src/eigen/artifacts/kittel.rs`, `dispatch.rs`,
`scripts/verify_fem_frequency_domain_eigen_artifacts.py` i istniejące testy.

**Zmiana:** odtworzyć konflikt hashy z 2.2 w minimalnym teście. Ustalić, czy
chodzi o fingerprint algorithm, pełny/reduced mesh, source/target transfer
czy przestarzały cache. Ten sam source mesh musi mieć ten sam canonical digest
w certyfikacie, spectrum, mode meta, manifest i binary resource.
Różne siatki wymagają jawnego mapowania, nie nadpisania pola.

Identyfikatory run/stage/sample/raw-mode/revision/mesh/owner/runtime mają
rzeczywistego producenta. Cache wiąże geometry/material/BC/equilibrium i source;
inwalidacja po zmianie dowolnego inputu. Per-sample sweep nie przejmuje
niepowiązanej topologii stage 0. Static demag realization nie udaje dynamicznego
BC. `completed`, `solve_succeeded`, `converged`, `fields_available`,
`selected_only`, `window_complete`, fit i qualification pozostają osobne.

**Testy:** nowy bundle z 15 próbkami; cache hit/miss; inny mesh następnej próbki;
stary checksum, zmiana kolejności węzłów, niezgodny source/target, brak runtime ID;
nearest sukces bez pełnego okna; błąd/anulowanie z częściowymi artefaktami.

**Odbiór:** nowy wynik Neumanna przechodzi C03; historyczny niespójny bundle
nadal jest odrzucany. Bez ręcznej edycji historycznych JSON.
**Commit:** `fix(eigen): bind modal artifacts to canonical mesh identity`.

### S05 — wiarygodne walidatory i metryki naukowe

**Pliki:** `scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py`,
`verify_fem_frequency_domain_eigen_artifacts.py`, ich testy,
`crates/fullmag-runner/src/eigen/artifacts/kittel.rs::k0_kittel_mode_uniformity_score`,
`crates/fullmag-runner/src/fem/eigen_native_window.rs::node_mass_weights_from_tangent_mass`,
`eigen_path_artifacts.rs::eigen_path_node_mass_weights_from_json`, recipes `justfile`.

**Zmiana:** osobne smoke i qualification profile, jeden owner progów używany
przez recipes/validators/docs. Odbiór docelowy nie dziedziczy domyślnego 5%.
Walidator wylicza błędy ze solved points i stałych materiału, sprawdza medianę,
source/operator/BC/gauge, liczbę pól i distinct mesh/airbox runs. Nie ufa samemu
`summary.status=passed`. Nie porównuje fit M_eff do siebie jako orakla.

Uniformity i overlap liczyć na magnetycznym obszarze z właściwą metryką FE.
Zweryfikować hipotezę: zero-weight airbox jest odrzucany przez helper, po czym
fallback bez wag obniża score uniform moda. Nie wnioskować o XYZ/tangent layout
jedynie z podzielności długości przez 2/3. Jawna reprezentacja lub istniejący
typed adapter ma rozstrzygać layout. Airbox-only refinement nie zmienia score.

**Testy:** near-roundoff Neumann pass; Robin 3.9% nie przechodzi qualification;
mediana ponad próg przy poprawnym max; podmienione summary; powielone roots;
zmiana dwóch parametrów zbieżności naraz; nonfinite/negative thresholds;
nieustalony rząd zbieżności nie udaje wiarygodnej ekstrapolacji;
uniform mod z różną liczbą zerowych airbox nodes ma score 1 w ustalonej definicji.

**Progi docelowe zgodnie z K0-G7:** max/median frequency 0.02/0.01;
finest-two mesh/airbox 0.01/0.005; M_eff mesh/truncation/reference error
0.01/0.005/0.005; relative uncertainty 0.0025; scaled Jacobian condition <=1e6;
uniform overlap >=0.95; branch/subspace continuity >=0.85; full residual,
Poisson, tangent leakage, seam mismatch <=1e-8. Zdefiniować normy i miary
oddzielnie; nie utożsamiać automatycznie squared uniformity z overlap.

**Odbiór:** C06; negative fixtures rzeczywiście odrzucane przez qualification.
**Commit:** `fix(validation): enforce K0 scientific acceptance budgets`.

### S06 — CPU film: rekwalifikacja i zbieżność

**Właściciele:** `examples/fem_eigen_k0_kittel_periodic_airbox.py`, managed
recepty Kittel/convergence, capture i validators. Przed nowym runem zachować
rozliczone istniejące wyniki; rerun ma konkretny powód: nowy source/BC/artifact fix.

**Macierz:** film 160×80×10 nm, PBC x/y, 15 pól 5–100 mT, Ms=800000 A/m,
Aex=13e-12 J/m, gamma0=221100, alpha=0 dla modal solve, CPU double.
Trzy rozdzielczości in-plane przy stałym airboxie; trzy wysokości airboxu przy
stałej siatce magnetycznej; oddzielna kontrola layers=1/4/8 oraz bocznych komórek
80×40, 160×80, 320×160 nm o tej samej fizyce uniform Gamma.
Rejestrować zrealizowaną siatkę i h_z, nie tylko input hmax.

Zachować osobne Zeeman-only, exchange-only kontrolne i demag/full-film cases.
Exchange nonzero-k jest istniejącą kontrolą diagnostyczną, nie rozszerzeniem
produkcji nonzero-k demag. Kittel nigdy nie trafia do RHS, assembly, targetu,
wyboru moda ani relaxed equilibrium.

**Odbiór:** S05 budgets, te same pola/materiał, pełne residuale, rzeczywiste BC,
curve i errors z surowych solved points, provenance i C03. Zgodność uniform
5e-14 jest zachowanym historycznym punktem odniesienia, nie obietnicą każdego runu.
**Commit:** `test(fem): qualify CPU K0 film and independent convergence`.

### S07 — CPU nearest i kompletne okno na rzeczywistym antydocie

**Pliki:** `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp`,
`poisson_airbox_schur_matshell.cpp`, `window_partition.cpp`,
`contour_interval_solver.cpp` tylko jeśli używany przez wybraną trasę,
`crates/fullmag-runner/src/fem/eigen_native_window.rs`,
`backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp`,
`window_partition_test.cpp`, istniejący `examples/fem_periodic_antidot_relax_eigenmodes.py`.

**Zmiana:** prześledzić faktyczny selected/window call graph. Najpierw mały
reprodukcyjny przypadek, następnie skalowanie. Zidentyfikować koszt i awarie
base/refinement, shifted KSP, accumulation i teardown przed długim Q1.
Zachować brak dużych tymczasowych wyników na stosie i ograniczoną pamięć
kandydatów. Nie przenosić pełnej macierzy do runnera i nie nazywać dense Schura
matrix-free. Dobierać nev/ncv/adaptację do saturation i lokalnego pokrycia.

`nearest` to selected_only. Dwa podobne przebiegi nie są same w sobie dowodem
kompletności: testować brakujące mody, degeneracje i liczenie klastrów. Mały
niezależny full-spectrum oracle oraz negatywne sztucznie pominięte mody muszą
sprawdzać certyfikat. Jeśli nie ma wystarczającego count/coverage evidence,
wynik ma pozostać incomplete, niezależnie od liczby zaakceptowanych modów.

**Canonical Q1:** dokładnie istniejąca geometria/materiały/skrypt antydotu,
okno 0.5–30 GHz, historyczny schedule 16 base + 34 refinement jako baseline,
8 requested i 4 zapisane mody. Snapshot wejść i equilibrium cache są obowiązkowe.
Schedule można zmienić po dowodzie równoważności/pokrycia; nie wolno zmieniać
fizyki ani zawężać okna, żeby test stał się zielony. Limit eksportu pól nie jest
liczbą wszystkich modów w oknie. Wyjaśnić semantykę count i truncated results.

**Testy:** exact/near shift, cluster na brzegu okna, zdegenerowane mody, retries,
zero valid modes, interval saturation, timeout/cancel, niskie memory admission,
regresja stack/teardown; residual każdego opublikowanego moda.
Przed drogim runem zapisać konkretny limit czasu/RAM na danym hoście na podstawie
pomiaru małego przypadku. Przekroczenie daje terminalny partial/failed + progress,
nie bezterminowe zużycie CPU. S13 zapisuje przyjęty envelope.

**Odbiór:** C07 CPU + nowy managed Q1; terminalne spectrum/mode/window certificate,
niezależne sprawdzenie kompletności i zbieżności airboxu dla nieuniform modów.
**Commit:** `fix(fem): certify and bound CPU K0 window execution`.

### S08 — GPU mean-zero, produkcyjny Schur i pomiar wykonania

**Pliki:** `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`,
`backends/fem/gpu/cuda/frequency_domain/modal_krylov.cu` jako bounded reference,
`backends/fem/src/api.cpp` caller-sized attestation,
`crates/fullmag-runner/src/native_fem/frequency_domain.rs::validate_modal_gpu_attestation_v1`,
`backends/fem/tests/frequency_domain/gpu_k0_modal_petsc_slepc_test.cpp`.

**Zmiana:** produkcyjna obsługa mean-zero/nullspace, zgodne gauge RHS i
rekonstrukcja phi/eta/residual na urządzeniu. Wybrać augmentację lub projected
nullspace zgodnie z definiteness bloku i możliwościami PETSc/hypre; nie stosować
preconditionera SPD do nieprzeanalizowanego saddle-point. Zachować ten sam
operator fizyczny co CPU. Zniesienie guardu Robin/none dopiero po testach.

Vec/MatShell/ST/KSP/BV oraz apply/orthogonalization/reductions muszą realizować
zadeklarowaną device ścieżkę. Attestation z pomiarów i runtime obiektów, nie
stałych zer i tokenów z requestu. Reuse keyed by mesh/material/equilibrium/BC/
shift wraz z poprawną inwalidacją. Brak capability do pomiaru pozostaje unavailable.

**Testy:** brak CUDA, CPU-backed vector, zły hypre policy, stale signature,
missing gauge weights, incompatible RHS, invalid count/NaN, strict GPU failure,
oracle parity; pełny mini graph PETSc/SLEPc i cancel/teardown.
**Odbiór:** C07 GPU, trzy rosnące wymiary matrix-free (jeden >1024), zgodne
UUID/device/libs/precision; independent profiler i native attestation.
**Commit:** `feat(fem): support mean-zero K0 in device modal solver`.

### S09 — CPU/GPU parity, odporność i koszty

**Pliki:** `scripts/verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py`,
`capture_fem_eigen_k0_periodic_airbox_performance.py`,
`verify_fem_eigen_k0_periodic_airbox_performance.py`, testy i managed recipes.

**Zmiana:** porównywać klastry i ich invariant subspaces w tej samej metryce FE,
z mapowaniem mesh/DOF i wyrównaniem fazy/bazy. Sama zgodność pierwszej
częstotliwości albo parowanie po indeksie nie wystarcza. Wykorzystać istniejące
tracking/mass helpers, nie tworzyć drugiej biblioteki modalnej.

**Progi:** cluster frequency relative <=1e-8, sine largest subspace angle <=1e-8,
aligned complex mode relative <=1e-7, full residual każdego lane <=1e-8,
zero accepted/rejected mismatches. Równowaga: istniejący explicit physical
tolerance; nie żądać identycznych bajtów po niezależnej relaksacji.

**Odporność:** minimum 3 powtórzenia; reuse/invalidation, near/exact shift,
cancellation w setup/base/refinement/publication, controlled allocation failure,
device-loss test w odizolowanej trasie bez resetowania współdzielonego GPU,
osobne memcheck/racecheck/synccheck, bezpieczny teardown.

**Residency:** zgodnie z K0-G3 computational H2D/D2H/full-vector crossings i
hot-loop host synchronizations zero; ograniczone telemetry scalar payload <=256 B
z liczbą związaną z callbackami. Koszt setup i eksportu raportować osobno;
jeśli stos wymaga dozwolonej synchronizacji, zmienić jawny kontrakt po review,
a nie usuwać jej z pomiaru. Nie wymyślać minimalnego GPU speedup.

**Odbiór:** C06 + C09, surowe traces i peak RAM/VRAM, time-to-first-mode,
time-to-window, operator applies, brak wycieków po powtórzeniach. Mały film
nie zastępuje GPU antydotu Q2.
**Commit:** `test(fem): enforce K0 subspace parity and GPU robustness`.

### S10 — typowane artefakty/API/FMS i state semantics

**Pliki:** runner z S04; `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`,
`crates/fullmag-session`, `apps/control-room/src/kernel/api`, OpenAPI/generowane
pliki, resource hooks, `FrequencyDomainPublishedState` i konsumenci.

**Zmiana:** transport kompletu tożsamości oraz requested/resolved BC/device/
precision/runtime. Revision-aware cache per run/stage/sample/mode/mesh;
stale snapshot nie trafia do aktualnego viewportu. Schemas generować, nie
edytować ręcznie. Backend -> facade -> hooks -> adapter -> UI, binary fields.

Nie utożsamiać completed z converged/qualified, covariance_missing z błędem
eigensolve ani selected_only z całym spektrum. FMS zawiera wszystkie zależności
artefaktów, mesh i certyfikatów; import waliduje digests przed publikacją.
Starszy niespójny bundle odrzucić lub obsłużyć jawną wersjonowaną migracją,
nigdy silent relabel. Nie naprawiać braku payloadu fallbackiem do latest live mesh.

**Testy:** C10, C11, export->stop procesu->nowy proces->import bez starej historii;
corrupt/missing/partial/cancelled bundles, case-fold/path traversal, import innej
sesji i dwa etapy z różną topologią. API meta/vector muszą odpowiadać temu samemu
polu i sample. Naruszenie danych odrzucane przed zmianą active result.
**Commit:** `fix(api): preserve K0 artifact identity and result states`.

### S11 — Kittel fit, FMR i oddzielny driven K0

**Pliki:** `crates/fullmag-runner/src/eigen/artifacts/kittel.rs`, istniejące
response/FMR writers i validators, `backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp`,
GPU driven owner wskazany przez call graph, `FmrModalSpectrumModel`,
`FmrResponseSweepModel`, Inspectory, publiczne przykłady i plan 27 K0-P7.

**Zmiana:** oracle comparison vs estymacja parametrów z covariance to odrębne
rezultaty. Nie zamieniać `statistical_fit_covariance_not_available` w fałszywy
PASS statystycznego fitu. Jeśli zakres oryginalnego produktu wymaga fitu,
dokończyć istniejący estymator, uncertainty, conditioning i identifiability;
stałe gamma/Ms oracle nie udają dopasowanych parametrów.

K0-P7: driven source, polarization, damping, jednostki susceptibility/absorbed
power i częstotliwości; modal resonance nie jest intensywnością FMR. Weryfikować
response bezpośrednio z operatorem, a modal reconstruction z jego completeness
i niezależnymi sample checks. Zmiana dynamicznego BC obejmuje również response
callerów zgodnie z S02/S03. Zachować osobne CPU/GPU support i scope.

**Testy:** analytic small driven response, damping/sign/units, pole RF zero,
różna polarization, detuning/resonance, modal-vs-direct response, missing covariance,
fit nieidentyfikowalny i negative uncertainty. Nie porównywać wartości w Hz z GHz.
**Odbiór:** produktowe powierzchnie oryginalnego planu rozliczone; driven claim
wymaga własnych wyników i Q3-D, bez promocji z Q3-M. Unsupported extensions
oznaczone, nie ukryte ani wliczone do sukcesu.
**Commit:** `fix(fmr): separate modal validation from driven and fit qualification`.

### S12 — Control Room: pełny scenariusz użytkownika

**Pliki:** `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx`,
Results adapters, `apps/control-room/src/kernel/visualization/ModeFieldOverlayIntentController.ts`,
stosowne viewport-3d adapters/layers i testy. Nie rozszerzać do ogólnego redesignu.

**Zmiana:** wybrać field-sweep sample i raw mode z tabeli/wykresu/drzewa;
ten sam wybór aktualizuje Inspector i unified viewport. Re/Im/amplitude/phase,
phase rotation i per-object composition zachowują jednostki i tożsamość.
Statusy naukowe dostępne bez pokazywania surowych JSON. Authoring sweepu
round-trips przez Python/IR; niedostępny GPU widoczny przed uruchomieniem.

**Browser matrix:** CPU i GPU modal Q3-M; osobny driven Q3-D jeśli kwalifikowany;
FMS restart/import; zmiana sample/mode/phase; brakujące/corrupt/stale pole;
zmiana mesh generation; unmount/remount i 60 s obserwacji.
Canvas widoczny, context not lost, drawing buffer >0; screenshot rzeczywistego
pola, nie tylko DOM; brak przecieków, nadmiarowych fetchów i remountów Inspectora.
Nie używać mocka ani syntetycznego pola jako końcowego dowodu native render.

**Odbiór:** C11, frontend test/lint/typecheck zgodnie z instrukcjami oraz
browser receipts z run/artifact/source identity. Przy zmianie mutacji Inspectora
także wymagany test stabilności Object/Airbox.
**Commit:** `fix(control-room): complete native K0 results workflow`.

### S13 — immutable candidate i pełna kwalifikacja

**Wejście:** implementacja S00–S12, dotknięte source tests i review zakończone.
Zamrozić czysty runtime-relevant source i managed manifest przed końcowym
Q1/Q2/Q3. Nie zmieniać źródeł podczas zbierania dowodów.

**Praca:** Q1 CPU film/convergence/antidot/window; Q2 GPU science/parity/residency/
robustness; Q3-M API/FMS/browser CPU+GPU; Q3-D driven niezależnie. Stare dowody
mogą wspierać diagnozę, ale mają mieć własną tożsamość i zakres. Zmiana źródeł
po freeze wymaga nowego kandydata i ponowienia dotkniętych bramek; nie mieszać
wyników różnych operatorów w jednym PASS.

**Evidence record:** pełny SHA, dirty=false lub jawny niedopuszczony status;
runtime snapshot/manifest hash, recepta i input hashes, urządzenie/UUID/precision,
wersje MFEM/PETSc/SLEPc/hypre/CUDA, mesh/material/BC/equilibrium/operator identity,
exit/terminal reason, czas/RAM/VRAM, artifact hashes, wynik każdego validatora.
Przechowywać raw logs/traces i verifier execution proof, nie sam summary PASS.

**Odbiór:** wszystkie właściwe DOD-01–14, brak open blockers, osobne CPU/GPU scope;
C12; niezależny review matematyki i kontraktów. `not_applicable` tylko z
dozwolonym reason code exact scope, nie jako sposób pominięcia GPU/window/UI.
**Commit:** `test(fem): bind final K0 qualification evidence` (małe manifesty;
duże wyniki pozostają w zarządzanym storage).

### S14 — promocja, integracja i przekazanie

Zaktualizować capability/readiness wyłącznie dla zakresu S13. Zachować odrębną
tożsamość runtime commit i governance promotion commit zgodnie z planem 27.
Wykonać końcowy przegląd diffu, CI i wymagane review. Po autoryzowanym zleceniu
implementacji stosować pełny cykl AGENTS: logiczne commity -> push branch -> PR
do master -> checks/review -> merge -> bezpieczny fast-forward głównego checkoutu
-> weryfikacja integracji -> cleanup wyłącznie worktree zadania po sprawdzeniu
ownership/procesów/mountów/untracked. Zlecenie samego planowania tego nie
uruchamia; ograniczone zlecenie S00 nie autoryzuje realizacji S01–S14 ani
promocji solvera.

Raport końcowy: wykonane ID, scope CPU/GPU/driven, source/runtime/evidence IDs,
testy, PR/merge, zachowane wyniki i ograniczenia. Przy blokadzie zapisać stan
w rejestrze i kontynuować niezależną autoryzowaną pracę. Nie nazywać pełnego
wdrożenia zakończonym na samym commicie albo otwartym PR.

## 8. Komendy i sposób uruchamiania kontroli

Poniższe ścieżki są względem repozytorium wykonawczego, chyba że podano absolute.
Przed build/run przeczytać aktualny `justfile` i wykonać resolver storage zgodnie
z AGENTS. Nowe outputy muszą trafić do rozwiązanego profilu, nie do historycznego
`C:/fullmag-cache` ani examples/*.zarr. Historyczne ścieżki służą odczytowi.
Zmienne `$artifactRoot`, `$candidateRoot`, `$dodRecord` oznaczają zweryfikowane
istniejące wyniki zapisane przez wykonawcę w ledgerze, nie literalne ścieżki.

### C01 — identyfikacja, tylko odczyt

```powershell
git status --short
git rev-parse --show-toplevel
git rev-parse master HEAD
git worktree list --porcelain
git merge-base --is-ancestor e3241af9a7815b63809cb8b99e83be5efbc51a18 master
git log --oneline master..codex/k0-exchange-only-diagnosis-20260901
git show --stat f0986ede9853828dfd573a2bee12302385213321
```

Jeśli sandbox zgłosi dubious ownership dla potwierdzonego repo, użyć per-command
`git -c safe.directory=C:/git/fullmag/fullmag ...`, bez zmiany global config.

### C02 — liczbowy odczyt historycznego Neumanna, bez nowego solve

```powershell
python -B -c 'import json,math,pathlib; p=pathlib.Path("C:/git/fullmag/worktrees/k0-exchange-only-diagnosis/examples/fem_eigen_k0_kittel_periodic_airbox.zarr/artifacts/fmr/kittel_fit.v1.json"); pts=json.loads(p.read_text())["points"]; exact=lambda x:221100/(2*math.pi)*math.sqrt(x["bias_field_a_per_m"][0]*(x["bias_field_a_per_m"][0]+800000)); print(len(pts),max(abs(x["solved_frequency_hz"]-exact(x))/exact(x) for x in pts))'
```

### C03 — artefakty

```powershell
python -B scripts/verify_fem_frequency_domain_eigen_artifacts.py $artifactRoot
python -B scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-k0-kittel-field-sweep --require-k0-kittel-periodic-airbox-demag $artifactRoot
```

Druga komenda dotyczy fixture zawierającego Kittel validation metadata; nie
dodawać oracle do antydotu tylko po to, żeby ją uruchomić. S05 dodaje docelowy
qualification profile i wpisuje jego rzeczywistą komendę do ledgeru.

### C04 — dokumentacja naukowa

```powershell
python -B .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json --repo-root .
python -B -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
```

Przy publikacji także public-example guard, Sphinx i rendered checks zgodnie
ze skillem. Plan wewnętrzny nie wymaga budowania całej publicznej dokumentacji.

### C05 — Rust source contracts, nie kwalifikacja native FEM

```powershell
cargo test -p fullmag-plan --lib
cargo test -p fullmag-runner --lib fem::eigen_tests
```

Uruchamiać przez repozytoryjny kontrolowany build/test entry z profilem storage;
nie budować MFEM na hoście w zastępstwie managed route. Weryfikować liczbę
wykonanych testów: pusty filtr nie jest PASS. Odpowiednie testy ABI/handoff dodać
do istniejących modułów i ich nazwę zapisać w ledgerze po implementacji.

### C06 — Python validation contracts

```powershell
python -B -m pytest -q -p no:cacheprovider scripts/test_verify_fem_eigen_k0_periodic_airbox_convergence.py scripts/test_verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py scripts/test_verify_fem_eigen_k0_periodic_airbox_performance.py scripts/test_verify_fem_frequency_domain_production_dod.py
```

### C07 — rzeczywiste Windows/container native contracts

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/windows/verify_fem_frequency_domain_native_contract.ps1 -Device cpu
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/windows/verify_fem_frequency_domain_native_contract.ps1 -Device gpu
```

Istniejący `just verify-fem-frequency-domain-native-contract` wybiera GPU.
Nie uznawać go za wykonanie obu lane'ów. Windows entry korzysta z Docker Desktop
i storage wrappera. Nie wprowadzać WSL jako ukrytej zależności.

### C08 — managed scientific recipes: istniejące, do sprawdzenia przed wykonaniem

```text
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-cpu
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-gpu
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
just verify-fem-frequency-domain-eigen-k0-gpu-petsc-slepc
just verify-fem-frequency-domain-eigen-k0-gpu-adapter-scale-contract
```

Te recepty istnieją, ale część historycznych ciał zawiera bash/readlink i stare
ścieżki. Istnienie nie dowodzi przenośności Windows ani poprawnych final-state
records. S06/S08 mają zweryfikować routing przez obecny storage shell i w razie
potrzeby naprawić receptę przez istniejący Windows/container launcher. Dla
canonical antidot/Q1/Q2/S13 brak potwierdzonej w tej analizie jednej pełnej
recepty: odpowiedni owner ma dodać cienki managed entry, jawne input/output,
timeout i final state oraz test launchera. Nie zastępować go ręcznym Dockerem.

### C09 — parity

```powershell
python -B scripts/verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py --cpu $cpuArtifactRoot --gpu $gpuArtifactRoot
```

S09 rozszerza tę istniejącą komendę o pełne modal/subspace kryteria lub jawny
qualification profile. Obecny PASS częstotliwości nie wystarcza dla K0-G6.

### C10 — FMS/API source checks

```powershell
cargo test -p fullmag-session
cargo test -p fullmag-api session_import
cargo test -p fullmag-api router_v2
```

Profile storage jak C05. Testy handlerów nie zastępują procesu restart/import.

### C11 — frontend po zmianach kontraktu

```powershell
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
```

Generowanie tylko przy zmianie schemy. Focused testy do iteracji obejmują
ModeFieldOverlayIntentController, FrequencyDomainPublishedState,
FrequencyDomainResultInspectors, FieldSweepInspectors i FMR models. Browser
komendę ustalić z aktualnych scripts projektu, nie wpisywać fikcyjnego istniejącego
testu; S12 ma dostarczyć reprodukowalny scenariusz i receipt.

### C12 — finalny exact-scope DoD

```powershell
python -B scripts/verify_fem_frequency_domain_production_dod.py --record $dodRecord --bundle-root $candidateRoot
```

Record i scope catalog mają pochodzić z istniejącej schema i infrastruktury
planu 27. Nie tworzyć równoległego uproszczonego certyfikatu produkcyjnego.

## 9. Pokrycie oryginalnego planu i Definition of Done

| Oryginalny zakres | Nowe zadania | Warunek |
|---|---|---|
| G0/R0–R3 integracja i runtime | S00, S02, S13–S14 | source/runtime identity i kontrolowana integracja |
| C1 fizyka | S01 | warunki, jednostki, ograniczenia, source map |
| C2 DSL/IR/planner | S02, S10, S12 | round-trip i fail-closed |
| C3/R4 equilibrium/ABI | S03 | binding i oryginalny operator |
| N1 assembly | S03, S06 | native FE i independent checks |
| N2/R6/R7 CPU | S06–S07 | selected + complete window + convergence |
| N3/R9 GPU | S08–S09 | gauge, residency, parity, scale, robustness |
| A1S artefakty | S04–S05 | spójne digests, statusy, walidatory |
| A1E/R1 immutable evidence | S13 | jeden finalny candidate |
| A2 API/FMS | S10 | procesowy round-trip |
| U0/U1/U2/R8 | S10–S12 | Results, fit/FMR, mode fields, browser |
| K0-P7 driven | S11–S13 | oddzielna kwalifikacja, bez modal promotion |
| Q1/Q2/Q3 | S13 | CPU/GPU i finalny native browser |
| G2/R10 | S14 | scope-bound promotion i integracja |

| DOD | Owner w tym planie |
|---|---|
| 01 Physics note | S01 |
| 02 Python/UI round-trip | S02, S12 |
| 03 IR validation | S02 |
| 04 Planner legality | S02, S08, S13 |
| 05 Equilibrium/mesh certs | S03–S04 |
| 06 Native assembly | S03, S06 |
| 07 Engine/window/lifecycle | S07–S08 |
| 08 Full residual | S03, S08–S09 |
| 09 Artifacts/OpenAPI/UI | S04, S10–S12 |
| 10 Analytical validation | S05–S06, S09, S11 |
| 11 Convergence | S05–S07, S09 |
| 12 CPU/GPU parity | S09 |
| 13 Performance/residency | S07–S09 |
| 14 Release regression | S13–S14 |

## 10. Kryterium zakończenia i zakazy skrótów

- Wszystkie wymagane zadania verified, zero niewyjaśnionych artifact failures.
- Osobne exact scope CPU, GPU i driven; brak globalnego procentu „gotowości”.
- Film Neumanna ma zachowany historyczny wynik i poprawny nowy bundle;
  antydot ma własną convergence/coverage, nie oracle Kittela jako substytut.
- Dokładne hardware/precision/source/runtime/artifacts są związane w S13.
- Recepta, udany build, test mocka, wykryte GPU i pusty folder nie są run proof.
- Nie rozluźniać progów, nie zmieniać Ms/geometrii/okna dla zielonego testu,
  nie wpisywać fałszywych zer transferów i nie podmieniać digestów ręcznie.
- Po poprawce ponawiać dotknięte testy, nie wszystkie bez powodu. Nie przechodzić
  do promocji z brakującymi wymaganymi lane'ami.
- Przy blokadzie zapisać konkretną przyczynę, evidence i następny krok; nie
  wykonywać destrukcyjnych operacji infrastruktury pod pretekstem kwalifikacji.

## 11. Weryfikacja samego planu

Podczas opracowania sprawdzono aktualne Git refs, źródła wskazanych głównych
ownerów, istniejące CLI validators, Windows native entry i skrypty frontendowe.
Odnaleziono wejściowy bundle wykresu, ponownie przeliczono Kittela, odczytano
native diagnostics/build identity i odtworzono odrzucenie identity przez validator.
Nie wykonano nowego native solve, GPU trace ani browser proof.

Plan nie twierdzi, że każda potencjalna wada całego repo została znaleziona.
Kompletny jest zakres prac koniecznych do rozliczenia oryginalnego K0 planu,
potwierdzonych problemów i kwalifikacji; review nowych zmian może dodać regresje
do ledgeru, bez ukrywania ich w „pozostałych drobiazgach”.
