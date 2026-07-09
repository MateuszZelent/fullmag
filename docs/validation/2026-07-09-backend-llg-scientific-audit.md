# Audyt naukowo-numeryczny standardowego solvera FEM LLG, statyki i relaksacji

Data audytu: 2026-07-09  
Zakres publikacji: standardowy nieliniowy FEM w dziedzinie czasu, statyka,
relaksacja i używane przez nie interakcje.  
Poza zakresem: cały FDM oraz wszystkie solver-y frequency-domain, modalne,
eigen, driven response i Floquet.

Pełny manifest pokrycia znajduje się w
[`2026-07-09-backend-llg-audit-coverage.md`](2026-07-09-backend-llg-audit-coverage.md).

## 1. Werdykt wykonawczy

Solver FEM ma szeroką, realnie wykonywalną implementację CPU/MFEM i CUDA dla
standardowego LLG oraz kilku algorytmów relaksacji. Zarządzany runtime ukończył
jednorodny smoke dla CPU i GPU `llg_overdamped`, PG-BB i NCG oraz dla CPU TPI.
Nie oznacza to jednak kwalifikacji fizycznej całej ścieżki.

**Nie można obecnie uznać standardowego FEM LLG/relaksacji za całościowo
physics-validated ani bezpieczny naukowy default.** Audyt skonsolidował 42
unikalne ustalenia:

| Priorytet | Liczba | Znaczenie w tym audycie |
|---|---:|---|
| P0 | 9 | zwykła akceptowana konfiguracja może dać błędną fizykę, pominąć aktywny człon albo pozostawić publiczny stan po błędzie |
| P1 | 9 | istotny błąd pola, obserwabli, warunku brzegowego, zbieżności lub publicznego kontraktu |
| P2 | 21 | błąd zdolności, odporności, algorytmu rozwojowego, dokumentacji lub luka wymagająca ukierunkowanego testu |
| P3 | 3 | utrzymaniowy drift, niejednoznaczny zakres dokumentacji i stare instrukcje operacyjne |

Dwa dodatkowe ustalenia dokumentacyjne nie są liczone ponownie: `DOC-002`
potwierdza błędy termiczne `FEM-TD-PHY-THERM-001/002`, a `DOC-020` potwierdza
błąd czasu Oersteda `FEM-TD-NUM-RK-001`. `CAP-007` jest dokumentacyjną stroną
tego samego braku osiągalności strict-GPU thermal co
`CAP-THERM-GPU-001`.

Najpilniejsze blokery to:

1. niespójna realizacja ostrych elementowych `A/Ms` poza exchange;
2. transponowane gradienty tetraedru w CPU Zhang-Li;
3. czasowo zależny Oersted liczony dla złego czasu we wszystkich etapach RK;
4. błędna kowariancja i retry szumu Browna;
5. niedowymiarowana pochodna energii Armijo w PG-BB/NCG/TPI;
6. brak macierzy legalności relaksacja × STT/thermal/Oersted;
7. commit stanu GPU przed omylną finalizacją statystyk hybrid Robin;
8. zaakceptowany FEM antenna-Zeeman mask, który nie ma nośnika w natywnym ABI.

## 2. Zakres, mianowniki i metoda

### 2.1 Kod backendu

Pełny bieżący wszechzbiór `backends/fem` zawiera 556 plików. Prosty filtr
katalogowy usuwa 102 pliki z poddrzew `frequency_domain`, pozostawiając 454.
Semantyczna selekcja usuwa jeszcze cztery pliki dedykowane wyłącznie
częstotliwości/eigen:

- `backends/fem/cpu/mfem/runtime/eigen_dense.cpp`;
- `backends/fem/cpu/mfem/runtime/eigen_dense.hpp`;
- `backends/fem/cmake/FindPETSc.cmake`;
- `backends/fem/cmake/FindSLEPc.cmake`.

Finalny mianownik kodu to **450/450 przeczytanych plików**. Pliki mieszane,
takie jak `backends/fem/CMakeLists.txt`, `backends/fem/src/api.cpp` i testy
fasad, pozostają w zakresie, lecz oceniono wyłącznie ich obowiązki
time-domain/static/relaxation.

### 2.2 Dokumentacja i publiczny łańcuch

- otwarto i sklasyfikowano 805/805 kandydatów Markdown;
- 332 dokumenty weszły do właściwego mianownika FEM time-domain;
- przeanalizowano 1328 plików możliwego łańcucha publicznego;
- dodatkowe korzenie `examples`, `fullmag-cli`, `fullmag-engine`,
  `fullmag-authoring` i `fullmag-quantities` dodały 169 plików: 89 wybrano,
  80 wykluczono po przeczytaniu;
- rejestr twierdzeń zawiera 5402 kolejne wiersze o pełnym, 11-polowym
  schemacie.

Sprawdzony łańcuch to:

```text
Python DSL / UI authoring
  -> ProblemIR
  -> walidacja i planner FEM
  -> runner oraz requested/resolved execution
  -> fullmag-fem-sys i native/include/fullmag_fem.h
  -> backends/fem/src/api.cpp
  -> CPU/MFEM albo strict GPU/CUDA
  -> pola, energie, statystyki, artefakty i zasoby sesji
```

### 2.3 Klasy dowodu

Audyt rozdziela:

- `source_present` — kod istnieje;
- `planner_legal` — publiczny problem przechodzi walidację;
- `public_executable` — rzeczywiście dociera do utrzymywanego runtime;
- `runtime_proven_for_fixture` — konkretny zarządzany przypadek wykonał się;
- `physics_validated` — równanie zostało porównane z analityką,
  kierunkową pochodną, zbieżnością lub zaakceptowanym benchmarkiem.

Przejście smoke testu nie promuje automatycznie żadnego członu do
`physics_validated`.

### 2.4 Mapa identyfikatorów roboczych do skonsolidowanych

Dwa niezależne workstreamy użyły częściowo kolidujących nazw `CAP-*`.
Raport nadaje im jednoznaczne identyfikatory końcowe; pozostałe ID zachowują
nazwy workstreamu.

| ID końcowe | ID źródłowe | Dyspozycja |
|---|---|---|
| `CAP-ANT-001` | contracts `CAP-006` | samodzielny brak carrier-a antenna Zeeman |
| `CAP-FEM-001` | solver `CAP-001` | anisotropy-only baseline plannera |
| `CAP-FEM-002` | solver `CAP-002` | niespójne listy quantity validation |
| `CAP-THERM-GPU-001` | solver `CAP-THERM-GPU-001` + contracts `CAP-007` | jeden wspólny brak publicznego seeda strict GPU |
| `CAP-VALID-001` | contracts `CAP-005` | brak named validated workloads dla STT/Oersted |
| `CAP-DOC-MEL-001` | contracts `CAP-002` | drift statusu magnetoelastic |
| `CAP-DOC-TPI-001` | contracts `CAP-003` | sprzeczny status CPU TPI |
| `CAP-DOC-DEMAG-001` | contracts `CAP-004` | sprzeczny status Fredkin–Koehler |
| `FEM-TD-PHY-THERM-001/002` | solver ID + contracts `DOC-002` | dowód dokumentacyjny scalony z dwoma błędami solvera |
| `FEM-TD-NUM-RK-001` | solver ID + contracts `DOC-020` | dowód dokumentacyjny scalony z błędem czasu Oersteda |

`ABI-001` pozostaje solverowym P2; kontrakt `LLG-ABI` tylko przejmuje jego
obowiązek naprawczy i nie tworzy dodatkowego ustalenia.

## 3. Kanoniczne kontrakty użyte w ocenie

W konwencji repozytorium `gamma_mu0` ma jednostkę `m/(A s)`, `H` ma `A/m`, a
zredukowane równanie Gilberta ma postać

\[
\frac{d\mathbf m}{dt}=
-\frac{\gamma_{\mu_0}}{1+\alpha^2}
\left[\mathbf m\times\mathbf H_\mathrm{eff}
+\alpha\,\mathbf m\times(\mathbf m\times\mathbf H_\mathrm{eff})\right]
+\boldsymbol\tau_\mathrm{direct}.
\]

Dla członów konserwatywnych obowiązuje

\[
\delta E=-\mu_0\int_{\Omega_m}M_s\,
\mathbf H_\mathrm{eff}\cdot\delta\mathbf m\,dV.
\]

Pola mają `A/m`, gęstości energii `J/m^3`, a energie całkowite `J`.
Bezpośrednie STT ma `1/s` i nie może być po cichu traktowane jako gradient
energii. Stan zaakceptowany musi mieć skończone `|m|=1` na węzłach
magnetycznych. Dla nieautonomicznego pola etap RK `j` musi liczyć człon dla
`t_n+c_j dt`, a finalne pola dla `t_n+dt`.

## 4. Ustalenia P0

### 4.1 FEM-TD-PHY-MAT-001 — elementowe współczynniki conformal kończą się na exchange

**Oczekiwane.** Jeden zaakceptowany model materiału musi być używany przez
wszystkie pola, energie, metryki, szum i momenty.

**Rzeczywiste.** Planner i ABI przenoszą nieciągłe elementowe `A` i `Ms`.
`backends/fem/cpu/mfem/runtime/mfem_context.cpp:348-384` tworzy elementowe
współczynniki tylko dla form exchange. Lokalne interakcje, termika, STT,
metryki i upload GPU czytają pola węzłowe albo skalarne fallbacki;
`backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp:61-63` nie przenosi
elementowych map materiału na urządzenie.

**Skutek.** Jedna publiczna konfiguracja może rozwiązywać hybrydowy, fizycznie
niespójny problem materiałowy; CPU i GPU mogą realizować inne `Ms`.

**Granica poprawki.** Albo wspólny elementowy/kwadraturowy accessor dla
każdego członu i obserwabli, albo jawne odrzucenie niewspieranej kombinacji.

**Wymagany dowód.** Dwa tetraedry z ostrym skokiem `Ms/A`, analityczne pola i
energie dla każdego członu oraz parity CPU/GPU.

### 4.2 FEM-TD-PHY-STT-001 — CPU Zhang-Li używa kolumn zamiast wierszy macierzy odwrotnej

**Rzeczywiste.** `backends/fem/cpu/mfem/interactions/stt_zhang_li.cpp:82-96`
przypisuje gradienty funkcji kształtu z kolumn `J^{-1}`. Dla mapy
`x=p0+J xi` prawidłowe gradienty są wierszami `J^{-1}`. CUDA ma postać
wierszową w
`backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu:67-77`.

**Kontrprzykład.** Dla `p1=(2,0,0)`, `p2=(1,1,0)`, `p3=(0,0,1)` oczekiwane
`grad N1=(0.5,-0.5,0)`, a CPU otrzymuje `(0.5,0,0)`. Obecny test CPU używa
osiowego tetraedru jednostkowego i maskuje transpozycję.

**Skutek.** Zły kierunek i amplituda `(u·grad)m` na zwykłych skośnych
tetraedrach oraz cicha rozbieżność CPU/GPU.

**Wymagany dowód po poprawce.** Skew-tetra oracle, pochodna pola afinicznego,
parity momentu i trajektorii CPU/GPU.

### 4.3 FEM-TD-NUM-RK-001 — Oersted używa `t_n` w każdym etapie i finalnym polu

`backends/fem/cpu/mfem/interactions/oersted_cylinder.cpp:99-122` i
`backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.cu:40-62` czytają
`ctx.state.current_time`. Interfejs etapu
`backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp:21-59` nie przenosi czasu
etapu, a czas jest zwiększany dopiero po finalnym odświeżeniu w
`backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp:264-316` i
`backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu:62-112`.

**Skutek.** Heun, RK4, RK23 i RK45 próbkują sinus/pulse w złej fazie; przy
nieciągłości impulsu błąd może być jakościowy, a opublikowane `H_Oe/H_eff`
jest o jeden krok czasowo nieświeże.

**Poprawka.** Jawny `evaluation_time` w całym łańcuchu RHS/interakcji oraz
finalizacja dla kandydata `t_n+dt` przed atomowym commit-em.

### 4.4 FEM-TD-PHY-THERM-001 — CPU losuje nowy Wiener increment po odrzuceniu kroku

Seed w
`backends/fem/cpu/mfem/interactions/thermal_brown_sampler.cpp:98-145`
zawiera bieżący czas i `dt`. Po odrzuceniu
`backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp:228-239` zmienia `dt`,
więc CPU losuje nową zmienną normalną. Test obecnie wymaga tej błędnej zmiany.
GPU kluczuje przez zaakceptowany `step_count` i zachowuje draw.

Adaptacyjny stochastic LLG powinien zachować tę samą standardową zmienną
normalną dla retry i zmienić tylko skalę `dt^{-1/2}`; w przeciwnym razie
akceptacja warunkuje rozkład szumu. Regułę tę podaje
[Leliaert et al. 2017](https://doi.org/10.1063/1.5003957).

### 4.5 FEM-TD-PHY-THERM-002 — dodatkowy czynnik `1+alpha^2` w amplitudzie Browna

Przy zadeklarowanej surowej `gamma_mu0` prawidłowa wariancja komponentu pola
to

\[
\sigma^2=\frac{2\alpha k_BT}
{\gamma_{\mu_0}\mu_0M_sV\,dt}.
\]

CPU w
`backends/fem/cpu/mfem/interactions/thermal_brown_sigma.cpp:38-41` oraz CUDA w
`backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.cu:72-75`
zastępują `gamma_mu0` przez
`gamma_mu0(1+alpha^2)`, mimo że LLG już dzieli RHS przez `1+alpha^2`.
Amplituda jest zaniżona o `1/sqrt(1+alpha^2)`; dla `alpha=1` daje
`1/sqrt(2)` wartości oczekiwanej. Niezależną postać tej konwencji podaje
[magnum.np, Scientific Reports 2023](https://www.nature.com/articles/s41598-023-39192-5).

CPU jest publicznie osiągalny. Kod GPU zawiera ten sam błąd, ale publiczna
ścieżka strict-GPU thermal jest dodatkowo fail-closed przez
`CAP-THERM-GPU-001`.

### 4.6 FEM-TD-REL-001 — Armijo dodaje wielkość `A m^2` do energii w J

`backends/fem/cpu/mfem/relaxation/relaxation_math.cpp:431-496` definiuje
gradient `g=-P_m H_eff` i metrykę objętościową. PG-BB, NCG i TPI sprawdzają

```text
E_trial <= E_current + c * step * <p,g>_M
```

bez `mu0 Ms`. Fizyczna pochodna kierunkowa to
`-mu0 integral Ms H_eff·delta_m dV` w J. Implementacje CUDA PG-BB/NCG
powielają tę samą skalę.

**Skutek.** Warunek dostatecznego spadku oraz skala BB/NCG zależą arbitralnie
od materiału i siatki. Dla zmiennego `Ms` kierunek zaakceptowany jako descent
w metryce kodu nie musi być descent fizycznej energii.

**Wymagany dowód.** Pochodna różnicowa całkowitej energii wzdłuż stycznego
kierunku dla każdego członu, co najmniej dla dwóch wartości `Ms`.

### 4.7 FEM-TD-REL-002 — relaksacja akceptuje człony niezgodne z funkcją celu

- STT jest dodawane tylko do RHS RK i jest ignorowane przez PG-BB/NCG/TPI.
- Thermal i Oersted wchodzą do `H_eff`, lecz nie do `E_total` używanego przez
  line search.
- Planner nie ma macierzy legalności algorytm relaksacji × interakcja.
- `llg_overdamped` może wykonywać STT, ale stop używa `max|m×H_eff|`, bez
  bezpośredniego momentu.

Konfiguracja może więc zakończyć „relaksację” przy niezerowym rzeczywistym RHS
albo minimalizować kierunek, który nie jest pochodną raportowanej energii.
STT i stochastic thermal powinny być odrzucane dla kanonicznego
`Relaxation`, dopóki nie istnieje osobny driven-steady-state/annealing
workflow. Oersted wymaga zgodnej energii Zeemana przed dopuszczeniem do
minimizerów energii.

### 4.8 FEM-TD-GPU-NUM-001 — hybrid Robin może zwrócić błąd po commit-cie stanu

Plan dopuszcza hybrid CPU-Poisson, ale finalna redukcja energii Robin wymaga
strict-device workspace.
`backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu:108-120`
aktualizuje czas, krok i własność stanu przed `gpu_rk_finalize_step_stats`;
reduktor może następnie zwrócić błąd. Publiczny caller dostaje failure, chociaż
`m/time/step` już się zmieniły.

To narusza atomowość kroku. Należy wspierać hybrid Robin w redukcji albo
odrzucać kombinację w preflight, a wszystkie omylne finalizacje wykonać przed
commit-em lub zapewnić pełny rollback.

### 4.9 CAP-ANT-001 — antenna Zeeman mask jest planowany, lecz znika przed backendem

`crates/fullmag-plan/src/fem.rs:2193-2217` wypełnia
`FemPlanIR.antenna_zeeman_masks`, quantity availability reklamuje `H_ant`, a
GPU fallback prowadzi do CPU. `native/include/fullmag_fem.h:167-265` nie ma
jednak nośnika anteny/maski, a produkcyjny
`crates/fullmag-runner/src/native_fem.rs` nie przekazuje tego payloadu do
natywnego FEM.

**Skutek.** Zaakceptowany problem LLG wymuszany anteną w dziedzinie czasu
(nie frequency-domain driven-response) może ewoluować bez żądanego pola,
jednocześnie raportując aktywne `H_ant`. Fallback GPU→CPU nie naprawia braku
nośnika CPU.

**Poprawka.** Pełny carrier planner→runner→ABI→CPU/GPU→readback albo jawne
odrzucenie i niedostępność `H_ant`.

## 5. Ustalenia P1

| ID | Ustalenie | Najważniejsze kotwice | Skutek / wymagany test |
|---|---|---|---|
| FEM-TD-PHY-ANI-001 | Jednorodna oś PMA `0`, `NaN` lub `Inf` jest akceptowana. | `backends/fem/cpu/mfem/interactions/anisotropy.cpp:21-31,76-111` | PMA znika albo tworzy nonfinite pole; testy zero/NaN/Inf przez publiczny create. |
| FEM-TD-PHY-DMI-001 | Periodic DMI nie redukuje słabego residualu i masy po klasach okresowych; CPU bulk/interfacial i GPU zachowują się różnie. | `backends/fem/cpu/mfem/interactions/dmi_bulk.cpp:63-70`, `backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp:57-68`, `backends/fem/cpu/mfem/interactions/effective_field.cpp:130-159,188-190`, `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu:39-90` | zależność od numeracji siatki, możliwa zła chiralia; skew-periodic helix, convergence i CPU/GPU parity. |
| FEM-TD-OBS-001 | `mx/my/mz` to średnia po liczbie węzłów, nie po objętości FEM. | `backends/fem/cpu/mfem/runtime/step_metrics.cpp:20-45`, `backends/fem/gpu/cuda/observables/observable_kernels.cu:55-92` | wynik zależy od zagęszczenia siatki; nierównomierna siatka z wagami masy. |
| FEM-TD-OBS-003 | Analityczne `H_Oe` publikuje bazę dla prądu 1 A, nie aktualne pole `I(t)H_basis`. | `backends/fem/cpu/mfem/interactions/oersted_cylinder.cpp:80-135`, `backends/fem/cpu/mfem/runtime/state_io.cpp:227-230,308-310`, `backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.cu:40-85` | artefakt różni się od członu, który sterował LLG; sprawdzić `H_eff(with)-H_eff(without)`. |
| FEM-TD-NUM-DEMAG-001 | Kilka ścieżek Hypre zbiera residual/iteracje, ale nie odrzuca braku zbieżności przed publikacją pola. | `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp:323-354`, `backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp:186-212`, `backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp:235-266`, `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp:220-238` | potencjał i energia o niekontrolowanym błędzie; wymusić `max_iter=1` i oczekiwać failure. |
| FEM-TD-NUM-DEMAG-002 | FEM/BEM przyjmuje dowolny niepusty podzbiór `boundary_faces`, bez pełności, domknięcia i orientacji. | `backends/fem/cpu/mfem/interactions/demag_fem_bem_surface.cpp:188-248` | jedna poprawna ściana tetraedru może udawać całą powierzchnię BEM; missing/duplicate/reversed/nonmanifold tests. |
| FEM-TD-GPU-OBS-001 | Strict-GPU nie odświeża publicznego potencjału Poissona, a full-domain `H_demag` ma inne semantyki w airbox. | `backends/fem/gpu/cuda/demag_poisson/demag_state.hpp:19`, `backends/fem/gpu/cuda/state/gpu_state.cpp:476,519`, `backends/fem/src/api.cpp:317-350`, `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp:264-290` | stary `phi` i zerowe próbki airbox; test świeżości dwóch stanów oraz parity punktowe. |
| FEM-TD-NUM-RK-003 | Normalizacja zostawia wektor zero i nie odrzuca `NaN/Inf` przed commit-em. | `backends/fem/cpu/mfem/integrators/llg_rhs.cpp:16-27`, `backends/fem/gpu/cuda/fields/vector_field_kernels.cu:13-27` | naruszenie `|m|=1`; zero/subnormal/NaN/Inf i atomowość failure. |
| DOC-019 | Python zamienia brak `dt_initial` na `dt_min`; runtime używa równości jako sentinela i nie odróżnia jawnego minimum. | `packages/fullmag-py/src/fullmag/model/dynamics.py:21-73`, `crates/fullmag-runner/src/lib.rs:45-63` | utrata intencji i inny startowy krok; round-trip omitted/equal/distinct. |

## 6. Ustalenia P2 i P3

| ID | Priorytet | Ustalenie |
|---|---|---|
| ABI-001 | P2 | Time-domain `fullmag_fem_plan_desc` nie ma `abi_version/struct_size`; mismatch bundla może zmienić interpretację pól, ale normalna ścieżka freshness ogranicza zasięg. |
| CAP-FEM-001 | P2 | Planner odrzuca poprawny anisotropy-only FEM, bo baseline nie liczy uniaxial/cubic jako aktywnej fizyki. |
| CAP-FEM-002 | P2 | Walidacja SaveField/Snapshot/SaveQuantity używa różnych list i nazw dla `H_ani_cubic`, `H_oe`, `H_therm`; activity gating jest niespójny. |
| CAP-THERM-GPU-001 | P2 | Planner ustawia `thermal_seed_config=None`, runner przekazuje seed 0, strict GPU thermal odrzuca seed 0, choć capability reklamuje thermal. Błąd fail-closed. |
| FEM-TD-PHY-ANI-002 | P2 | TPI zawsze używa osi jednorodnej, mimo że właściwe pole/energia obsługuje osie PMA per-node. |
| FEM-TD-OBS-002 | P2 | Kopiowane pole `torque` używa jednorodnego alpha i pomija direct STT; nie należy go utożsamiać z całym RHS ani `max_torque_Apm`. |
| FEM-TD-GPU-NUM-002 | P2 | Strict GPU ignoruje żądany `demag_interval_s` i liczy demag w każdym etapie; jest to drift polityki/provenance/kosztu, nie dowód mniej dokładnego pola chwilowego. |
| FEM-TD-NUM-RK-002 | P2 | RK23 i RK45 używają tych samych nieprzeskalowanych wykładników PI 0.7/0.4, a zaakceptowany krok nie może zmniejszyć następnego `dt`. |
| FEM-TD-NUM-TPI-001 | P2 | Rozwojowy CPU TPI dodaje `Ms`-mass do surowej sztywności `A` bez normalnego `2/mu0` i miesza różne wagi słabych członów. |
| FEM-TD-REL-003 | P2 | PG-BB/NCG dopuszcza wzrost energii do `max(1e-23 J, 1e-12 relative)`; wpływ wymaga sweep-u skal energii i szumu redukcji. |
| FEM-TD-ROB-001 | P2 | `effective_field_contract` wymaga jawnego zerowania wyłączonych buforów, którego kod nie zawiera; przy obecnie niemutowalnym enablement nie wykazano stale-field w produkcji. |
| CAP-VALID-001 | P2 | Publiczne FEM STT/Oersted mają `production_executable`, ale zero nazwanych workloadów w `validated_workloads`; jest to luka dowodowa, nie samodzielny błąd wykonania. |
| DOC-001 | P2 | Wspólna nota STT mnoży przez `mu0` drugi raz, mimo że symbol gamma ma już zredukowane jednostki. Kod RHS używa poprawnej konwencji. |
| DOC-005 | P2 | Nota relaksacji zapisuje `a^T M a` zamiast bilinearnego `a^T M b`. |
| DOC-010 | P2 | Noty DMI żądają dodatniego `D`, choć znak jest fizycznym wyborem chiralii i publiczne API akceptuje ujemne `D`. |
| DOC-011 | P2 | Nota obserwabli podaje dla bulk DMI `D` jednostkę `J/m^3`; dla `D m·curl(m)` powinno być `J/m^2`. |
| DOC-012 | P2 | Nota integratorów nie definiuje kompletnego ABM3 startup/history/rollback ani stochastic retry. |
| DOC-018 | P2 | Publiczny demag `atol` nie ma nazwanej normy residualu, skalowania ani jednostki. |
| CAP-DOC-MEL-001 | P2 | Tabela magnetoelastic miesza roadmapę quasistatic z bieżącym stanem; wykonywalny jest tylko prescribed strain. |
| CAP-DOC-TPI-001 | P2 | CPU TPI jest jednocześnie nazywany production-executable i wyłączony z bieżącego production subset. |
| CAP-DOC-DEMAG-001 | P2 | Jedna nota nazywa Fredkin-Koehler kolejno niezaimplementowanym, zaimplementowanym i odroczonym; dense reference trzeba oddzielić od scalable production. |
| DOC-013 | P3 | Noty modułów wskazują stare `native/backends/fem/...` zamiast bieżących właścicieli `backends/fem/...`. |
| DOC-015 | P3 | Spec dystrybucji reklamuje stare komendy `make fem-gpu-*`, sprzeczne z kanoniczną kontenerową ścieżką `just`. |
| DOC-017 | P3 | Dokumenty cubic nie rozdzielają jasno dwuparametrowego zakresu CPU reference od natywnego modelu `K1/K2/K3`; nie wykazano pominięcia `K3` przez natywny solver. |

## 7. Werdykt moduł po module

| Moduł | CPU | Strict GPU | Werdykt naukowy |
|---|---|---|---|
| LLG Gilbert | zaimplementowany | zaimplementowany | znak, `gamma_mu0` i człony alpha są zgodne z deklarowaną konwencją; brak blanket qualification wszystkich interakcji |
| Exchange | MFEM weak form | CUDA/device action | zwykła nieperiodyczna skala i energia poprawne; P0 dla ostrych elementowych materiałów poza exchange |
| Demag Poisson | kilka realizacji CPU/Hypre | device/hybrid Hypre | P1 brak gate-u zbieżności; P0 atomowość hybrid Robin; P1 obserwable GPU |
| Demag FEM/BEM | dense/reference CPU | brak równoważnej produkcyjnej ścieżki | P1 walidacja pełności powierzchni; status dokumentacyjny niespójny |
| Zeeman uniform | działa | działa | pole/energia poprawne; osobny P0 dotyczy antenna mask bez ABI |
| PMA/uniaxial | działa | działa | równanie pola/energii poprawne; P1 walidacja osi, P2 TPI per-node axis, P2 planner anisotropy-only |
| Cubic anisotropy | działa | działa | implementacja `K1/K2/K3` zgodna w deklarowanym uniform frame; nota pomija `K3` |
| DMI bez PBC | interfacial i bulk | interfacial i bulk | nie wykazano błędu znaku/skali w zwykłym weak residual/energy fixture |
| DMI z PBC | niespójna projekcja/redukcja | brak redukcji klas | P1: niepoprawny słaby problem okresowy i ryzyko zależności od numeracji |
| Thermal Brown | publicznie osiągalny | kod istnieje, publiczna strict ścieżka fail-closed | P0 amplituda w obu implementacjach i retry CPU; brak stochastic qualification |
| Slonczewski STT | działa w RK | działa w RK | prefaktory zgodne z zadeklarowanym kontraktem; brak validated workload; nielegalne w minimizerach energii |
| Zhang-Li STT | P0 gradient tetra | implementacja wierszowa | CPU daje zły wynik na skośnej siatce; brak parity workload |
| Oersted | cylinder i pole jawne | cylinder i pole jawne | przestrzenna formuła cylindra poprawna; P0 czas RK, P1 readback, P0 mismatch minimizera |
| Magnetoelastic | prescribed strain | lokalny device field | nie wykazano błędu znaku ani field-energy pairing; szersze mechanics odrzucane, dokumentacja niejasna |
| SOT | brak natywnej implementacji | brak natywnej implementacji | ma pozostać jawnym capability rejection, nie interakcją FEM |

## 8. Werdykt algorytm po algorytmie

| Workflow | Implementacja | Dowód runtime w audycie | Blokery |
|---|---|---|---|
| Deterministyczne Heun/RK4/RK23/RK45 | CPU i GPU | smoke relaksacji nie kwalifikuje wszystkich czterech metod | Oersted stage-time P0, normalizacja P1, controller P2, demag policy/finalization |
| Stochastic LLG | CPU i kod GPU | brak właściwego stochastic runtime workload | retry CPU P0, sigma P0, strict GPU reachability P2 |
| `llg_overdamped` | CPU i GPU | 4-krokowy managed smoke PASS | interakcja/stop legality P0; fixture nie zawiera STT/thermal/Oersted |
| PG-BB | CPU i GPU | 4-krokowy managed smoke PASS | Armijo/gradient P0, objective legality P0, tolerance P2 |
| NCG | CPU i GPU | 4-krokowy managed smoke PASS | te same P0/P2; różne preconditioner policies CPU/GPU wymagają osobnej kwalifikacji |
| TPI | CPU development lane | 4-krokowy managed smoke PASS | mieszane jednostki operatora P2, per-node PMA axis P2; brak GPU |
| Static snapshot | CPU i częściowo device readback | pośrednio wykonywany w smoke | średnia objętościowa, torque, H_Oe i GPU phi/H semantics |

## 9. Hipotezy sprawdzone i obalone

Nie wykazano osobnego błędu w:

- znaku zwykłego LLG i umieszczeniu `1/(1+alpha^2)`;
- zwykłym nieperiodycznym exchange oraz jego `2/mu0` w ścieżce pola;
- parze pole/energia uniform Zeeman;
- lokalnym równaniu uniaxial/PMA i cubic w zadeklarowanym uniform frame;
- parze pole/energia prescribed-strain magnetoelastic;
- zadeklarowanych prefaktorach Slonczewski;
- nieperiodycznym DMI weak residual/energy na istniejącym prostym fixture;
- invalidacji cache demag po zmianie próbnego `m` w direct minimizerach;
- topologii retry szumu na GPU — GPU zachowuje draw, CPU nie;
- strukturze „step w operatorze i retraction” TPI — sam ten fakt nie oznacza
  podwójnego kroku; realny problem dotyczy skali i wag operatora.

Te negatywne wyniki są ograniczone do sprawdzonych kontraktów i nie są
promocją do `physics_validated`.

## 10. Walidacja wykonywalna

| Gate | Wynik | Interpretacja |
|---|---|---|
| `just ensure-managed-fem-runtime` | PASS przy pierwszym freeze | repozytoryjny bundle i manifest istniały i były świeże dla sprawdzanej iteracji |
| `just verify-fem-relaxation-source-contract` | PASS w kontenerze | ownership/call topology buduje się; brak dowodu równania |
| `just verify-fem-relaxation-runtime` | PASS | CPU/GPU `llg_overdamped`, PG-BB, NCG oraz CPU TPI wykonały 4 kroki; GPU TPI poprawnie pominięty |
| `just verify-fem-relaxation-convergence` | PASS po ponowieniu na stabilnym bundlu | kompletna macierz CPU/GPU wykonała 16-krokowe przypadki i spełniła minimum 1% spadku energii oraz limit 1.25 wzrostu finalnego momentu |
| `just verify-fem-relaxation-cpu-gpu-consistency-smoke` | PASS: 6/6 wierszy, 3/3 par | identyczny solver-mesh i równe wyniki CPU/GPU, lecz preset uniform exchange-only kończy po 0 lub 1 kroku z zerowym momentem, więc jest to trywialny plumbing smoke |

Przypadek runtime był jednorodny i nie zawierał PMA, DMI, termiki, STT,
czasowego Oersteda, ostrych elementowych materiałów, periodic DMI, wymuszonego
braku zbieżności demag ani hybrid Robin failure. Z tego powodu wynik PASS nie
zamyka żadnego P0/P1.

Nie wykonano jeszcze oficjalnego workloadu w rodzaju
[NIST µMAG Standard Problem 4](https://www.ctcms.nist.gov/~rdm/std4/spec4.html),
który sprawdza znak i trajektorię dynamiczną średniej magnetyzacji. Brak takiej
bramki jest powodem, dla którego raport nie używa blanket
`physics_validated`.

## 11. Szczegółowe instrukcje naprawy

Poniższy playbook jest częścią wyniku audytu, ale nie twierdzi, że poprawki
zostały już zaimplementowane. Dla każdego rekordu podaje właściciela, minimalną
bezpieczną zmianę, odrzucone skróty, propagację między warstwami, test czerwony,
zarządzany gate, benchmark, tolerancję, migrację/provenance, zależności i checklistę.
Rejestr solverowy ma 27 pozycji. Rejestr kontraktowy ma 18 rekordów, z których
`DOC-002`, `DOC-020` i `CAP-007` są dowodami tych samych przyczyn co trzy
pozycje solverowe; dlatego poniżej opisano wszystkie rekordy źródłowe, ale liczba
unikalnych planów naprawy pozostaje 42.

### 11.1 Playbook 27 ustaleń solverowych

Data: 2026-07-09  
Status: instrukcja wdrożeniowa po audycie; kod solvera nie został zmieniony  
Zakres: wyłącznie standardowy nieliniowy FEM w dziedzinie czasu, statyka,
relaksacja oraz używane przez nie interakcje CPU/MFEM i strict GPU/CUDA  
Poza zakresem: cały FDM oraz frequency-domain, modal, eigen, driven response i
Floquet

Ten dokument opisuje naprawę dokładnie 27 ustaleń zatwierdzonych w
`.fullmag/audits/2026-07-09-backend-llg/reviews/fem-time-review.md`: P0 8, P1 8,
P2 11. Nie jest twierdzeniem, że poprawki zostały wdrożone. Każdy punkt wymaga
osobnego cyklu red-green, świeżego przeglądu i zarządzanego dowodu runtime.

#### 1. Wspólny protokół wdrażania

1. Najpierw zaktualizować właściwą notę w `docs/physics/`; równanie, jednostki,
   warunki brzegowe, CPU/GPU, obserwable, tolerancje i provenance muszą być
   zamknięte przed zmianą kodu.
2. Dodać minimalny test, który na niezmienionym kodzie odtwarza konkretny błąd.
   Test musi nie przechodzić z przyczyny podanej w ustaleniu, nie z powodu
   brakującego fixture lub błędu kompilacji.
3. Zmienić tylko właściciela defektu oraz konieczne warstwy kontraktu. Nie
   dodawać fizyki do `backends/fem/src/api.cpp`, `Context` ani ogólnego
   runnerowego dispatchu.
4. Uruchomić test po zmianie, następnie cofnąć zmianę implementacyjną i
   potwierdzić, że test ponownie nie przechodzi; przywrócić zmianę i ponownie
   uzyskać PASS. To jest wymagany dowód red-green.
5. Każda zmiana natywnego FEM zaczyna weryfikację od kontenerowej ścieżki repo:
   `just rebuild-fem-runtime`, potem `just ensure-managed-fem-runtime`.
6. Obecny bazowy `justfile` nie ma jednej bramki uruchamiającej wszystkie testy
   time-domain. Należy dodać kontenerową receptę **[NOWY]**
   `just verify-fem-time-domain-native-contract`, która w profilu `fem-gpu`
   buduje i uruchamia wskazane niżej targety CMake. Testy source/text pozostają
   wyłącznie kontraktami strukturalnymi; oracles numeryczne DMI CUDA,
   derivative/Armijo, ANI/TPI i REL-003 muszą być osobnymi linkowanymi
   executable targets. Dopóki agregującej recepty nie ma w bazowym HEAD, nie
   wolno przedstawiać samego hostowego `ctest` jako dowodu końcowego.
7. Po kontraktach uruchomić odpowiedni istniejący gate runtime:
   `just verify-fem-relaxation-runtime`,
   `just verify-fem-relaxation-convergence`,
   `just verify-fem-relaxation-cpu-gpu-consistency-smoke`,
   `just verify-fem-relaxation-production-benchmark`,
   `just verify-fem-demag-poisson-contract` albo
   kontenerową receptę `just fem-gpu-headless` z przypisanym do ustalenia,
   wersjonowanym skryptem walidacyjnym.
8. Capability może otrzymać `validated` dopiero po zapisaniu nazwanego
   workloadu, tolerancji, artefaktów i świeżego wyniku PASS. Smoke oznacza tylko
   `runtime_proven_for_fixture`.

##### 1.1 Wspólne zasady tolerancji

- Każde porównanie liczb zmiennoprzecinkowych stosuje jawną metrykę składową
  albo jawną normę i predykat mieszany
  `|a-b| <= atol + rtol*max(|a|,|b|)`. Seed, enumy, generacje i liczniki
  porównuje się dokładnie. Test wyłącznie względny nie jest ważny przy zerze.
- Test algebraiczny CPU względem niezależnej analityki zaczyna od
  `rtol <= 1e-12` w tej metryce; `atol` wynika z wymiarowej skali oracla.
- Lokalny oracle GPU FP64 względem CPU zaczyna od `rtol <= 1e-10`; `atol`
  wynika ze skali pola lub energii i jest zapisany w manifeście testu.
- Solve iteracyjny używa niezależnie policzonego true residualu na constrained
  true DOFs, z obsługą essential rows i projekcji gauge/nullspace. Sama liczba
  iteracji ani backendowa wartość telemetryczna nie jest dowodem.
- Pochodna energii: centralna różnica po retrakcji, sweep epsilon, widoczny
  obszar zbieżności drugiego rzędu i mieszany abs/rel residual; odrzucać
  kierunki degenerujące, a przy demag uwzględniać błąd solve i truncation FD.
- Test statystyczny definiuje burn-in, ESS, liczbę niezależnych seedów i korektę
  wielokrotnych porównań. Pojedynczy 95% przedział ma około 5% ryzyka fałszywej porażki i
  nie kwalifikuje termiki.
- Test failure-atomicity wymaga dokładnej niezmienności committed `m`, czasu,
  indeksu kroku, źródeł, publicznych statystyk i stochastic interval. Scratch i
  cache pochodny nie muszą być bitowo identyczne: mogą zostać odtworzone albo
  atomowo unieważnione przed retry; retry musi przejść semantyczny oracle.

#### 2. P0 — naprawy blokujące zwykłe wyniki

##### 2.1 FEM-TD-PHY-MAT-001 — elementowe `A/Ms` są realizowane tylko przez exchange

**Przyczyna źródłowa.** `fullmag_fem_plan_desc` przenosi
`ms_element_field/a_element_field`, a `copy_plan_material_fields()` je kopiuje,
lecz `context_initialize_mfem()` tworzy z nich współczynniki wyłącznie dla form
exchange. Lokalne pola, energia Zeemana, DMI, STT, termika, metryki i
`initialize_context_gpu_state()` używają nodalnych `Ms_field/A_field` albo
skalarnego fallbacku. Publicznie zaakceptowany materiał ma więc dwie
równoczesne realizacje.

**Aktualni właściciele.** ABI:
`native/include/fullmag_fem.h` (`fullmag_fem_plan_desc`); import i walidacja:
`backends/fem/core/fem_material_fields.cpp`
(`initialize_material_plan_fields`, `copy_plan_material_fields`,
`validate_material_fields`); MFEM:
`backends/fem/cpu/mfem/runtime/mfem_context.cpp`
(`context_initialize_mfem`); GPU:
`backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp`
(`initialize_context_gpu_state`); nodalny accessor:
`backends/fem/include/fem_common.hpp` (`scalar_field_value`); lowering:
`crates/fullmag-plan/src/fem.rs` (`build_region_material_fields`) i
`crates/fullmag-runner/src/native_fem.rs`.

**Minimalna bezpieczna korekta.** Natychmiast dodać fail-closed w plannerze i
native create: gdy istnieje elementowe `Ms`, odrzucić każdą kombinację, której
aktywny człon lub wybrany lane nie ma elementowej/kwadraturowej realizacji.
Elementowe `A` wolno pozostawić wyłącznie w exchange, gdzie jest faktycznie
używane. Komunikat ma wymieniać pierwszy niewspierany człon i resolved device.
To zatrzymuje błędne wyniki bez udawania kompletnej obsługi.

**Docelowa korekta.** Po publikacji kontraktu materiałowego w
`docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`
zbudować jeden backend-neutralny opis współczynników na elementach/kwadraturze.
Każdy residual, energia, `mu0 Ms`-metryka, sigma termiczna i STT ma pobierać
`Ms/A` z tego opisu. GPU potrzebuje elementowych tablic oraz kernelowych
accessorów, nie projekcji ostrego skoku do współdzielonych węzłów.

**Odrzucone alternatywy.** Uśrednienie elementowego `Ms` do węzłów zaciera
interfejs i zależy od lokalnej gęstości siatki. Użycie wartości elementu
reprezentatywnego na węźle jest zależne od numeracji. Ciche pozostawienie
elementowego `Ms` tylko dla exchange utrzymuje pierwotny błąd.

**Propagacja CPU/GPU/kontrakt.** Zmiana obejmuje note, Python/ProblemIR
heterogeneous materials, planner legality, ABI, import, wszystkie CPU energy i
field owners, GPU upload/kernels, statystyki oraz material provenance. CPU i GPU
muszą konsumować te same element IDs i tę samą regułę kwadratury; osobne
uśrednianie per lane jest niedopuszczalne.

**Test-first reproducer.** Rozszerzyć
`backends/fem/tests/fem_material_fields_contract.cpp` i
`backends/fem/tests/mfem_context_contract.cpp` o dwa tetraedry współdzielące
węzły, `Ms={0.7,1.1} MA/m` oraz `A={8,13} pJ/m`. Czerwony test ma najpierw
wykazać, że anisotropy/Zeeman/thermal/STT otrzymują nodalny fallback. Dla
minimalnej korekty test oczekuje jednoznacznego odrzucenia przed utworzeniem
backendu; dla docelowej korekty porównuje elementowe całki pola i energii.
Targety: `fem_material_fields_contract`, `fem_mfem_context_contract`, następnie
interaction targets każdego włączonego członu.

**Zarządzany gate.** Nowa agregująca recepta native-contract, potem
`just rebuild-fem-runtime`, `just verify-fem-relaxation-production-benchmark`
z dodanym dwumateriałowym scenariuszem i
`just verify-fem-relaxation-cpu-gpu-consistency-smoke` na identycznej siatce.

**Benchmark i akceptacja.** Dla każdej interakcji porównać energię i pochodną
kierunkową z całką elementową; `rtol <= 1e-6` dla pochodnej, CPU/GPU
`rtol <= 1e-10` dla lokalnych pól FP64. Refinement nie może przesuwać ostrego
interfejsu ani zmieniać limitu energii przez sposób nodalnego uśrednienia.

**Migracja/provenance.** Bezpieczne odrzucenie zawęża wcześniejszą, błędnie
reklamowaną capability i wymaga czytelnego migration error. Pełna obsługa musi
zapisać material realization (`element_quadrature`, order, CPU/GPU) w resolved
provenance. Stare artefakty bez tej informacji nie mogą być oznaczane jako
porównywalne.

**Kolejność i zależności.** Najpierw fail-closed; potem ABI-001; następnie
kontrakt materiałowy; później CPU; później GPU; na końcu parity. Pełna korekta
nie jest obecnie wsparta przez gotowy wspólny accessor i wymaga nowego,
udokumentowanego subsystemu.

**Checklist zamknięcia.** [ ] niewspierane kombinacje odrzucane; [ ] każdy
aktywny człon ma elementowy oracle; [ ] CPU/GPU używają tych samych map; [ ]
metryki i termika używają właściwego `Ms`; [ ] provenance podaje realization;
[ ] dwumateriałowy managed workload ma świeży PASS.

##### 2.2 FEM-TD-PHY-STT-001 — CPU Zhang-Li używa transponowanych gradientów tetraedru

**Przyczyna źródłowa.** `tetrahedron_gradients()` wyznacza `J^{-1}`, ale
składa `grad N1..N3` z kolumn. Dla `x=p0+J xi` gradienty baz P1 są wierszami
`J^{-1}`. Test CPU używa tetraedru osiowego, dla którego błąd jest niewidoczny;
CUDA `stt_tetra_gradients_device()` ma prawidłową postać wierszową.

**Aktualni właściciele.** CPU:
`backends/fem/cpu/mfem/interactions/stt_zhang_li.cpp`
(`tetrahedron_gradients`, `add_zhang_li_stt_rhs_aos`); GPU:
`backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu`
(`stt_tetra_gradients_device`, `zhang_li_element_rhs_kernel`); testy:
`backends/fem/tests/stt_contract.cpp` i
`backends/fem/tests/cuda_tetra_gradient_contract.cpp`.

**Minimalna bezpieczna korekta.** W CPU przypisać trzy wiersze odwrotnej
macierzy do `grad N1/N2/N3`, a `grad N0` policzyć jako
`-(grad N1+grad N2+grad N3)`. Nie zmieniać znaku prądu, beta ani prefaktorów
STT. Następnie wyciągnąć wspólny hostowy oracle geometrii używany przez oba
testy, nie wspólną implementację CPU/CUDA w hot loop.

**Odrzucone alternatywy.** Transponowanie `J` przy budowie nie naprawia
kontraktu i może zepsuć DMI. Ograniczenie mesh do tetraedrów ortogonalnych jest
nierealne. Zmiana CUDA na kolumny pogorszyłaby poprawny lane.

**Propagacja CPU/GPU/kontrakt.** Kod produkcyjny zmienia się tylko w CPU; GPU
pozostaje oraclem. Wspólny kontrakt geometrii, test parity i dokumentacja STT
muszą pinować mapę `x=p0+Jxi` oraz kierunek prądu. Provenance nie wymaga nowego
pola, ale wersja solvera i kwalifikowany workload muszą odróżnić stare wyniki.

**Test-first reproducer.** W `fem_stt_contract` użyć
`p0=(0,0,0)`, `p1=(2,0,0)`, `p2=(1,1,0)`, `p3=(0,0,1)` oraz afiniczne `m(x)`.
Oczekiwane `grad N1=(0.5,-0.5,0)`; obecny CPU daje `(0.5,0,0)`. Sprawdzić
wszystkie cztery gradienty, `sum grad Ni=0`, pochodną afiniczną oraz końcowy
Zhang-Li RHS. Czerwony test musi przegrywać na pierwszej składowej y.

**Zarządzany gate.** **[NOWY]** `just verify-fem-time-domain-native-contract` ma uruchamiać
`fem_stt_contract` i `fem_cuda_tetra_gradient_contract`; potem
`just rebuild-fem-runtime` oraz rozszerzony
`just verify-fem-relaxation-production-benchmark` z Zhang-Li CPU/GPU.

**Benchmark i akceptacja.** Lokalny RHS na skośnym tetraedrze: CPU względem
analityki początkowo `rtol <= 1e-12`, GPU względem CPU początkowo
`rtol <= 1e-10`, zawsze w metryce mieszanej z wymiarowym `atol`. Dla krótkiej
deterministycznej trajektorii wykonać badanie zbieżności po `dt` i rozdzielczości;
dopiero z jego asymptotycznego zakresu zamrozić w manifeście próg porównania po
10 krokach. Wartość `1e-8` nie może być przyjęta bez tego badania. Znak
prędkości tekstury odwraca się przy zmianie znaku prądu.

**Migracja/provenance.** Wyniki CPU Zhang-Li wykonane przed poprawką na
nieortogonalnych tetraedrach są naukowo nieporównywalne i powinny dostać
ostrzeżenie w release notes. Publiczne API nie zmienia się.

**Kolejność i zależności.** Niezależna, pierwsza poprawka P0. Jeżeli fixture
używa elementowego `Ms`, wykonać go dopiero po FEM-TD-PHY-MAT-001; podstawowy
skew-tetra test używa jednorodnego `Ms` i nie czeka.

**Checklist zamknięcia.** [ ] czerwony skew test; [ ] wiersze `J^-1`; [ ]
afiniczny oracle; [ ] CUDA bez zmiany równania; [ ] managed parity; [ ] release
note o nieporównywalności starych trajektorii.

##### 2.3 FEM-TD-NUM-RK-001 — Oersted jest liczony dla `t_n` we wszystkich etapach RK

**Przyczyna źródłowa.** `evaluate_rk_stage_rhs()` nie przyjmuje czasu etapu,
a `oersted_current_scale()` i `gpu_rk_oersted_scale()` czytają
`ctx.state.current_time`. `gpu_rk_finalize_accepted_step()` i CPU final refresh
liczą pole zanim licznik czasu przejdzie do `t_n+dt`.

**Aktualni właściciele.** CPU:
`backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp`
(`evaluate_rk_stage_rhs`),
`backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`
(`context_step_explicit_rk_mfem`),
`backends/fem/cpu/mfem/interactions/oersted_cylinder.cpp`
(`oersted_current_scale`, `add_oersted_cylinder_field`); GPU:
`backends/fem/gpu/cuda/integrators/rk/rk_stage_schedule.cu`
(`gpu_rk_run_stage_attempt`),
`backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.cu`
(`gpu_rk_oersted_scale`, `gpu_rk_accumulate_oersted_field`) i
`backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu`.

**Minimalna bezpieczna korekta.** Dodać jawny `evaluation_time_s` do CPU i GPU
RHS/field-refresh API. Każdy etap przekazuje `t_n+c_j*dt`; final refresh
przekazuje `t_n+dt`. `ctx.state.current_time` zmienia się dopiero w atomowym
commit-cie po wszystkich omylnych obliczeniach. Oersted envelope nie może
samodzielnie czytać globalnego czasu.

**Odrzucone alternatywy.** Tymczasowe ustawianie i cofanie
`ctx.state.current_time` w każdym etapie psuje cache, przerwania i provenance.
Liczenie Oersteda tylko raz na krok redukuje rząd metody. Przesunięcie samego
finalnego czasu nie naprawia etapów.

**Propagacja CPU/GPU/kontrakt.** Zmiana obejmuje wszystkie cztery tableaus,
FSAL eligibility, demag refresh policy korzystającą z czasu, Oersted CPU/GPU,
snapshot finalny oraz telemetry `time_seconds`. FSAL jest legalny także dla
deterministycznego nieautonomicznego RHS, jeżeli ostatni etap jest dokładnie
`f(t_n+dt,y_{n+1})` i pełny stan źródeł jest identyczny z pierwszym etapem
następnego kroku. Cache trzeba unieważnić przy nowym źródle stochastic,
nieciągłości impulsu albo niezgodnym stanie po retry. Wartość requested i
accepted time pozostaje w runnerze bez zmiany publicznej semantyki.

**Test-first reproducer.** Rozszerzyć `backends/fem/tests/oersted_contract.cpp`
i `backends/fem/tests/rk_explicit_contract.cpp`. Dla sinusoidy z okresem
`4*dt` rejestrować skalę dla wszystkich `c_j` Heun, RK4, RK23, RK45 oraz dla
finalnego `t_n+dt`; dla Pulse ustawić krawędź między dwoma etapami i jawnie
zamrozić lewo- albo prawostronną wartość na krawędzi. Osobno sprawdzić legalny
FSAL z identycznym pełnym stanem źródeł i inwalidację dla stochastic/pulse/retry.
Obecny kod zwróci tę samą skalę dla wszystkich próbek. Porównanie sinus używa
metryki mieszanej z `rtol=1e-14` i `atol` wyprowadzonym ze skali envelope.

**Zarządzany gate.** Native-contract targety `fem_oersted_contract` i
`fem_rk_explicit_contract`; potem `just rebuild-fem-runtime`,
`just verify-fem-relaxation-runtime` oraz scenariusz Oersted w
`just verify-fem-relaxation-production-benchmark` dla każdego wspieranego RK,
nie tylko Heun.

**Benchmark i akceptacja.** Dla makrospinu z sinusoidalnym polem porównać z
referencyjnym rozwiązaniem przy `dt/2`, `dt/4`, `dt/8`; obserwowany rząd ma być
zgodny z tableau do chwili dominacji tolerancji. CPU/GPU próbkują identyczne
czasy i trajektorie mieszczą się w błędzie dyskretyzacji. Snapshot `H_oe` po
kroku jest równy polu dla `t_n+dt`.

**Migracja/provenance.** API nie zmienia się, ale trajektorie z czasowym
Oerstedem są celowo inne. Artefakt powinien zapisać `field_evaluation_time_s`
lub jednoznacznie wiązać pola z accepted time. FSAL raportuje reuse wyłącznie,
gdy finalny etap, accepted state i pełny stan źródeł spełniają warunek
tożsamości; sama nieautonomiczność nie jest powodem wyłączenia.

**Kolejność i zależności.** Wykonać przed FEM-TD-OBS-003 i
FEM-TD-GPU-NUM-002, które potrzebują tego samego jawnego czasu; połączyć z
transakcyjnym commit-em FEM-TD-GPU-NUM-001.

**Checklist zamknięcia.** [ ] jawny czas CPU; [ ] jawny czas GPU; [ ] wszystkie
`c_j`; [ ] final `t_n+dt`; [ ] Pulse edge; [ ] FSAL poprawny; [ ] snapshot i
provenance wskazują accepted time.

##### 2.4 FEM-TD-PHY-THERM-001 — CPU losuje nowy Wiener increment po retry

**Przyczyna źródłowa.** `deterministic_thermal_seed()` miesza
`current_time` i `current_dt`, a cache w `ThermalBrownRuntimeState` jest
kluczowany parą `(time,dt)`. Odrzucenie adaptacyjne zmienia dt, więc
`refresh_thermal_brown_field()` losuje nowe normalne. Dla `seed=0` strumień
`mt19937_64` również przechodzi do nowych próbek. GPU prawidłowo kluczuje
próbkę zaakceptowanym `step_count`.

**Aktualni właściciele.** CPU:
`backends/fem/cpu/mfem/interactions/thermal_brown_sampler.hpp`
(`ThermalBrownRuntimeState`),
`backends/fem/cpu/mfem/interactions/thermal_brown_sampler.cpp`
(`deterministic_thermal_seed`, `refresh_thermal_brown_field`) i
`backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`; GPU oracle:
`backends/fem/gpu/cuda/integrators/rk/rk_thermal_field.cu`
(`gpu_rk_compute_thermal_field_contribution`); test:
`backends/fem/tests/thermal_brown_contract.cpp`.

**Minimalna bezpieczna korekta.** Stan termiki ma przechowywać surowy wektor
`xi ~ N(0,1)`, numer zaakceptowanego interwału i flagę ważności. Losować `xi`
raz dla `step_count`; każdy retry używa dokładnie tego samego `xi` i wylicza
`H_th=xi*sigma(dt_retry)`. Cache unieważnia się dopiero po zaakceptowanym
kroku albo jawnym resecie stanu, nie po zmianie dt.

**Odrzucone alternatywy.** Zachowanie już przeskalowanego `H_th` bez ponownego
skalowania daje złą wariancję po zmianie dt. Cofanie RNG do zapisanego stanu jest
trudniejsze, szczególnie dla system entropy, i nie definiuje stabilnego
CPU/GPU klucza. Wyłączenie adaptivity dla termiki byłoby bezpiecznym awaryjnym
ograniczeniem, lecz usuwa reklamowaną funkcję.

**Propagacja CPU/GPU/kontrakt.** CPU zmienia sampler; GPU topology pozostaje,
ale test ma chronić oba lane. Seed policy i accepted step index muszą znaleźć
się w provenance. Restart/checkpoint musi zachować seed, step index i stan
interwału, jeżeli restart następuje w trakcie retry.

**Kontrakt sLLG przed kwalifikacją.** Poprawka samplera może otrzymać status
`sampling_correct`, ale nie `statistically_validated`, dopóki publikacyjna nota
nie wybierze jawnie interpretacji sLLG (rekomendowany pierwszy kontrakt:
Stratonovich), nie zdefiniuje jednego Wiener incrementu współdzielonego przez
wszystkie ewaluacje etapów attemptu, dziedziczenia tego incrementu po retry,
relacji `Delta W=sqrt(dt) xi`, kolejności normalizacji/retrakcji i macierzy
legalnych integratorów. Najmniejsza kwalifikowalna ścieżka może dopuścić tylko
wyprowadzony stochastic-Heun; pozostałe RK/adaptive kombinacje pozostają
fail-closed albo jawnie `sampling-only`, dopóki nie mają własnego schematu i
testu słabej zbieżności. Capability rozdziela `sampling-only`,
`stochastic-integrator-executable` i `statistically-validated`.

**Test-first reproducer.** Odwrócić obecne oczekiwanie w
`fem_thermal_brown_contract`: wymusić jeden reject, zapisać `xi`, zmniejszyć dt
i wymagać bitowej identyczności surowego `xi`. Nie dzielić składowych przez
wartości bliskie zeru. Dla `s=sqrt(dt_first/dt_retry)` sprawdzić pole przez
`|H_retry-s H_first| <= atol+rtol*|s H_first|`, z `atol` proporcjonalnym do
`epsilon_machine*sigma_retry`. Powtórzyć dla fixed seed i wstrzykniętego,
deterministycznego resolvera entropy.

**Zarządzany gate.** `fem_thermal_brown_contract` w nowej native-contract
recepcie, `just rebuild-fem-runtime`, a następnie dedykowany stochastic
scenariusz przez `just fem-gpu-headless` oraz pełny workload dołączony do
`just verify-fem-relaxation-production-benchmark`.

**Benchmark i akceptacja.** Po zamknięciu powyższego kontraktu sLLG, dla
izotropowego makrospinu w stałym polu użyć
analitycznego oracla
`<cos(theta)>=coth(xi)-1/xi`, `xi=mu0 Ms V H/(k_B T)`. Manifest ustala burn-in,
ESS, liczbę seedów i korektę wielokrotnych porównań; nie opierać gate-u na
jednym przedziale 95%. Surową wariancję pola testować osobno przy stałym `dt`,
bez biasu adaptacyjnej selekcji, a forced-rejection ensemble oddzielnie od
no-rejection. CPU/GPU wymagają zgodności prawa rozkładu, nie identycznej
trajektorii, dopóki PRNG nie jest wspólny.

**Migracja/provenance.** Dla stałego seeda zmienia się deterministyczna
trajektoria CPU; jest to poprawka breaking-reproducibility i musi być opisana.
Provenance zapisuje requested seed policy, resolved seed i accepted interval
index.

**Kolejność i zależności.** Wdrożyć razem z FEM-TD-PHY-THERM-002 i po
CAP-THERM-GPU-001, aby publiczny seed miał jedno znaczenie. Sampling sigma/retry
można zamknąć przed wyborem pełnego schematu, ale statystyczna kwalifikacja
następuje dopiero po kontrakcie sLLG i obu poprawkach.

**Checklist zamknięcia.** [ ] cache surowego `xi`; [ ] reuse po reject; [ ]
rescale dt; [ ] fixed i entropy; [ ] checkpoint semantics; [ ] jawna konwencja
sLLG; [ ] one increment per attempt/stages; [ ] integrator legality; [ ]
sampling vs validation statuses; [ ] CPU/GPU law test; [ ] equilibrium i
dt-invariance PASS przed `statistically-validated`.

##### 2.5 FEM-TD-PHY-THERM-002 — dodatkowe `1+alpha^2` w amplitudzie Browna

**Przyczyna źródłowa.** `thermal_brown_sigma()` i CUDA kernel tworzą
`gamma0=gamma_mu0*(1+alpha^2)`, mimo że wejściowe `gamma_mu0` jest surową
wartością Gilberta, a `llg_rhs_aos()` dopiero później tworzy
`gamma_bar=gamma_mu0/(1+alpha^2)`. Damping correction jest więc zastosowana
dwukrotnie.

**Aktualni właściciele.** Kanoniczna nota:
`docs/physics/fem_thermal_brown.md`; CPU:
`backends/fem/cpu/mfem/interactions/thermal_brown_sigma.cpp`
(`thermal_brown_sigma`); GPU:
`backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.cu`
(`thermal_field_blocks_kernel`); konwencja LLG:
`backends/fem/cpu/mfem/integrators/llg_rhs.cpp`; test:
`backends/fem/tests/thermal_brown_contract.cpp`.

**Minimalna bezpieczna korekta.** Najpierw zapisać w nocie, że argument jest
`gamma_mu0 [m/(A s)]`, nie `gamma_bar`. Następnie użyć bezpośrednio
`gamma_mu0` w mianowniku
`sigma^2=2 alpha k_B T/(gamma_mu0 mu0 Ms V dt)` na CPU i GPU. Nie zmieniać
`llg_rhs_aos()`.

**Odrzucone alternatywy.** Przekazanie `gamma_bar` do termiki wymagałoby
zmiany publicznego kontraktu gamma i grozi trzecim przeliczeniem. Usunięcie
`1+alpha^2` z LLG zmieniłoby deterministyczną konwencję. Kalibracja sigma
empirycznym mnożnikiem maskuje błąd jednostkowy.

**Propagacja CPU/GPU/kontrakt.** Note, CPU, CUDA, test, komentarz ABI i
provenance convention version muszą zmienić się razem. Per-node alpha/Ms oraz
elementowe Ms wymagają dodatkowo FEM-TD-PHY-MAT-001.

**Test-first reproducer.** W `fem_thermal_brown_contract` użyć `alpha=1`; obecny
wynik ma stosunek `1/sqrt(2)` do niezależnego wzoru. Dodać sweep
`alpha={1e-3,0.1,1}`, `T`, `Ms`, `V`, `dt`; każda zależność potęgowa ma być
sprawdzona osobno. CPU oracle `rtol <= 1e-14`; CUDA porównanie skali
`rtol <= 1e-12`.

**Zarządzany gate.** `fem_thermal_brown_contract` przez kontenerową
native-contract receptę, `just rebuild-fem-runtime`, następnie stochastic
managed workload użyty także dla FEM-TD-PHY-THERM-001.

**Benchmark i akceptacja.** Surowa poprawność amplitudy zamyka
`sampling_correct`. Rozkład równowagowy i `dt`-invariance wolno stosować jako
gate `statistically-validated` dopiero po jawnej konwencji sLLG, stage/retry
increment semantics, normalizacji/retrakcji i kwalifikacji konkretnego
integratora z THERM-001. Wtedy użyć Langevinowskiego oracla makrospinu,
burn-in, ESS, wielu seedów i korekty wielokrotnych porównań. Surową wariancję każdej składowej
`H_th` mierzyć przy stałym `dt` osobno od adaptacyjnego ensemble; gate nie może
być pojedynczym 95% przedziałem. Przełączenie `alpha=1` nie może wykazać
historycznego czynnika 1/2 w wariancji.

**Migracja/provenance.** Wyniki termiczne sprzed poprawki mają złą efektywną
temperaturę zależną od alpha. Zapisać `thermal_covariance_convention` w
provenance i nie mieszać starych/nowych trajektorii w jednym ensemble.

**Kolejność i zależności.** Note przed kodem; poprawka CPU i GPU w jednym
review; retry z FEM-TD-PHY-THERM-001; publiczny seed z CAP-THERM-GPU-001;
statystyka na końcu.

**Checklist zamknięcia.** [ ] note pin gamma; [ ] CPU wzór; [ ] CUDA wzór; [ ]
alpha sweep; [ ] variance CI; [ ] equilibrium; [ ] provenance convention.

##### 2.6 FEM-TD-REL-001 — Armijo nie używa joule-valued pochodnej energii

**Przyczyna źródłowa.** `tangent_gradient_from_field()` tworzy
`g=-P_m H_eff`, a `metric_dot_fields()` waży tylko lumped volume. PG-BB, NCG i
TPI porównują energię J z `step*<p,g>`, które pomija `mu0 Ms`; CUDA powtarza tę
samą metrykę w `tangent_gradient_norm_kernel()` i `metric_dot_kernel()`.

**Aktualni właściciele.** Wspólna matematyka CPU:
`backends/fem/cpu/mfem/relaxation/relaxation_math.cpp`
(`metric_dot_fields`, `tangent_gradient_from_field`); algorytmy:
`projected_gradient_bb.cpp`, `nonlinear_cg.cpp`,
`tangent_plane_implicit.cpp`; GPU:
`backends/fem/gpu/cuda/relaxation/pgbb_kernels.cu`, `pgbb.cpp`,
`nonlinear_cg.cpp`; energie:
`backends/fem/cpu/mfem/runtime/step_metrics.cpp` i odpowiednie redukcje CUDA.

**Minimalna bezpieczna korekta.** Zachować field-gradient `g=-P_m H`, ale dla
line search zdefiniować pochodną celu w dżulach
`phi'(0)=-mu0 sum_i Ms_i V_i H_i·p_i = mu0 sum_i Ms_i V_i g_i·p_i`.
Waga `mu0 Ms_i V_i` obowiązuje w descent check i Armijo; BB curvature oraz PR+
mogą używać tej samej udokumentowanej geometrii. Nie wolno natomiast użyć tej
nieznormalizowanej wielkości jako kryterium stopu. Telemetria stopu pozostaje
RMS/max pola lub momentu w `A/m`, niezależna od objętości i liczby węzłów. Po
zmianie jednostek ponownie wyprowadzić albo skalibrować `kGradientFloor`,
`kBbCurvatureScale`, `kDefaultStepSize`, `kMinStepSize`, `kMaxStepSize`, reset
i completion metrics. Nazwy line-search funkcji mają mówić `energy_metric`.

**Odrzucone alternatywy.** Dodanie `mu0 Ms` tylko do prawej strony Armijo
pozostawia BB/NCG w innej geometrii. Przemnożenie samego `g` i pozostawienie
volume metric zmienia jednostki direction/step oraz preconditioner i wymaga
pełnego ponownego wyprowadzenia. Globalne średnie `Ms` są błędne dla materiałów
heterogenicznych.

**Propagacja CPU/GPU/kontrakt.** Note
`docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md` musi podać metrykę,
jednostkę step i pochodną. CPU i GPU korzystają z nodalnego `Ms`; ostre
elementowe `Ms` czekają na FEM-TD-PHY-MAT-001. Qualification artifact zapisuje
metric ID i line-search convention.

**Test-first reproducer.** `relaxation_source_contract.cpp` pozostaje testem
tekstowym/strukturalnym. Dodać osobny linkowany executable target
`fem_relaxation_energy_derivative_contract`: jednorodne i dwie różne wartości
`Ms`, styczny `p`, retrakcja `R_m(±epsilon p)`, centralna różnica całkowitej
energii oraz `-mu0 sum Ms_i V_i H_i·p_i`. Użyć mixed abs/rel, odrzucać
kierunki degenerujące, a dla demag uwzględnić błąd solve i FD. Test obecnego
kodu ma wykazać skalowanie wyniku z brakującym `mu0 Ms`.

**Zarządzany gate.** Strukturalny `fem_relaxation_source_contract` oraz osobny
`fem_relaxation_energy_derivative_contract` przez **[NOWY]**
`just verify-fem-time-domain-native-contract`, potem `just rebuild-fem-runtime`,
`just verify-fem-relaxation-convergence`,
`just verify-fem-relaxation-cpu-gpu-consistency-smoke` i pełny
`just verify-fem-relaxation-production-benchmark`.

**Benchmark i akceptacja.** Directional-derivative matrix dla exchange,
Zeeman, PMA, cubic, DMI, demag i prescribed-strain magnetoelasticity. Sweep
epsilon ma osiągać zamrożony mixed abs/rel bound, z osobno widocznym błędem FD
i solve. PG-BB/NCG CPU/GPU porównywać przez energię, final torque i obserwable
niezmiennicze względem symetrii; nie wymagać identycznego węzłowego minimum.

**Migracja/provenance.** Step sizes i liczba iteracji zmienią się; nie
utrzymywać zgodności trajektorii pseudoczasu. Zapisać `gradient_metric`,
`armijo_derivative_units=J` i preconditioner policy. Publiczny końcowy stan i
energia pozostają kompatybilne semantycznie.

**Kolejność i zależności.** Po FEM-TD-PHY-MAT-001 fail-closed i
FEM-TD-REL-002; przed FEM-TD-REL-003 i pełną kwalifikacją TPI. Każda
interakcja musi najpierw mieć poprawną parę field-energy.

**Checklist zamknięcia.** [ ] note z jednostkami; [ ] CPU energy metric; [ ]
GPU energy metric; [ ] BB/NCG wszystkie iloczyny; [ ] derivative matrix; [ ]
heterogeneous Ms; [ ] qualification provenance; [ ] managed parity.

##### 2.7 FEM-TD-REL-002 — relaksacja dopuszcza człony niezgodne z funkcją celu

**Przyczyna źródłowa.** Planner sprawdza nazwę algorytmu, ale nie macierz
algorytm-interakcja. PG-BB/NCG/TPI używają `H_eff`, lecz `E_total` pomija
thermal i Oersted; STT jest dodawane wyłącznie w RHS RK. `llg_overdamped`
wykonuje direct STT, ale stop publikuje `max|m x H_eff|`, nie normę całego RHS.

**Aktualni właściciele.** Planner:
`crates/fullmag-plan/src/validate.rs` (`plan_study_controls`,
`is_direct_relaxation_minimizer`); native dispatch:
`backends/fem/cpu/mfem/runtime/backend_step.cpp`
(`run_backend_relaxation_step`); field/energy:
`backends/fem/cpu/mfem/interactions/effective_field.cpp` i
`backends/fem/cpu/mfem/runtime/step_metrics.cpp`; direct torque:
`backends/fem/cpu/mfem/interactions/stt.cpp` (`add_stt_rhs_aos`) oraz
`backends/fem/gpu/cuda/integrators/rk/rk_direct_torques.cu`; snapshot/stop:
`backends/fem/cpu/mfem/runtime/snapshot.cpp` i `stage_completion.cpp`.

**Minimalna bezpieczna korekta.** Dodać jeden jawny validator legalności w
plannerze i odpowiedni defense-in-depth przed pierwszym native relax step.
Kanoniczny `Relaxation` odrzuca thermal, Slonczewski/Zhang-Li oraz **każdy**
Oersted dla wszystkich algorytmów. Także stały Oersted w `llg_overdamped` jest
niespójny, ponieważ bieżące `E_total` nie zawiera jego energii i może
opublikować fałszywy plateau/stop. Ten fail-closed obowiązuje, dopóki nie
istnieje `E_oe=-mu0 integral Ms m·H_oe dV` w tym samym objective.

**Docelowe rozszerzenia.** Driven STT wymaga osobnego workflow steady-state z
residualem całego RHS. Thermal annealing wymaga osobnego workflow z harmonogramem
temperatury i statystycznym stopem. Po dodaniu zgodnego `E_oe` statyczny
prescribed Oersted można dopuścić do minimizera. Dla źródła czasowego nie wolno
wymagać monotoniczności energii bez jawnego bilansu pracy zewnętrznej.

**Odrzucone alternatywy.** Ciche ignorowanie STT jest pierwotnym błędem.
Dodanie STT do `E_total` jest fizycznie nieuprawnione. Użycie field torque jako
stopu dla driven RHS daje fałszywą zbieżność. Thermal z pojedynczym energy
tolerance nie definiuje równowagi.

**Propagacja CPU/GPU/kontrakt.** Python i ProblemIR muszą zwracać ten sam
błąd co planner/native. Capability matrix rozdziela relaxation,
driven-steady-state i annealing. CPU/GPU stosują identyczną macierz legalności,
a provenance zapisuje resolved workflow i stop metric.

**Test-first reproducer.** W `crates/fullmag-plan/src/tests.rs` dodać tabelę
czterech algorytmów FEM razy STT, thermal, stały Oersted i czasowy Oersted.
Obecny planner przyjmie niedozwolone wiersze. W
`backends/fem/tests/relaxation_source_contract.cpp` bezpośredni native caller
ma otrzymać błąd przed zmianą stanu. Tabela obejmuje stały i czasowy Oersted
dla wszystkich algorytmów. Dodatkowy test pokazuje, że STT-only ma niezerowy
pełny RHS przy zerowym field torque.

**Zarządzany gate.** Planner tests muszą być częścią kontenerowej bramki,
native `fem_relaxation_source_contract`, potem
`just verify-fem-relaxation-runtime` i managed negative cases dla każdej
niedozwolonej kombinacji. Po dodaniu odrębnego workflow potrzebny jest jego
osobny `just` gate; obecnie go nie ma.

**Benchmark i akceptacja.** Dla odrzucanych kombinacji akceptacją jest błąd
przed utworzeniem artefaktów i bitowo niezmieniony stan. Dla przyszłego driven
workflow akceptacją jest normowany pełny RHS poniżej jawnej tolerancji; dla
annealing zgodność rozkładu, nie monotoniczna energia.

**Migracja/provenance.** Jest to zamierzone zawężenie wcześniej akceptowanych,
lecz niesemantycznych planów. Komunikat migracyjny wskazuje nowy workflow, gdy
ten istnieje. Requested interactions nie mogą znikać z provenance po
odrzuceniu/fallbacku.

**Kolejność i zależności.** Validator fail-closed można wdrożyć natychmiast.
Statyczny Oersted dla minimizerów może zostać ponownie włączony dopiero po
FEM-TD-OBS-003, FEM-TD-NUM-RK-001, implementacji `E_oe` i energy derivative
gate. Driven workflow i bilans pracy czasowego źródła nie są częścią tej
naprawy.

**Checklist zamknięcia.** [ ] tabela planner; [ ] native defense; [ ] zero
mutacji przy reject; [ ] identyczne CPU/GPU; [ ] capability rozdziela workflow;
[ ] komunikat migracyjny; [ ] brak fałszywego stopu field-only.

##### 2.8 FEM-TD-GPU-NUM-001 — hybrid Robin może zawieść po commit-cie stanu

**Przyczyna źródłowa.** `gpu_rk_plan_device_resident()` dopuszcza
`hybrid_cpu_poisson`, lecz `gpu_rk_reduce_final_demag_energy_terms()` wywołuje
device-only `reduce_device_demag_robin_boundary_energy()`. Tymczasem
`gpu_rk_finalize_accepted_step()` zwiększa czas/krok i oznacza device source of
truth, zanim `run_backend_step()` wywoła omylną finalizację statystyk.

**Aktualni właściciele.** Plan GPU:
`backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp`
(`gpu_rk_plan_device_resident`); finalizacja:
`rk_final_refresh.cu` (`gpu_rk_finalize_accepted_step`),
`rk_demag_energy_reductions.cu`
(`gpu_rk_reduce_final_demag_energy_terms`),
`backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`
(`reduce_device_demag_robin_boundary_energy`) i
`backends/fem/cpu/mfem/runtime/backend_step.cpp` (`run_backend_step`). Backup
magnetyzacji istnieje w `rk_workspace_state.hpp` jako `m_backup`.

**Minimalna bezpieczna korekta.** Preflight ma odrzucać hybrid+Robin przed
pierwszym krokiem, dopóki hybrid path nie dostarcza potencjału potrzebnego do
energii powierzchniowej. Niezależnie przebudować transakcję: obliczyć final RHS,
energie, redukcje i host-visible stats przed commit-em liczników. Po błędzie
niezmienione pozostają committed `m`, czas, indeks kroku, źródła, publiczne
statystyki i stochastic interval. Scratch/cache Hypre nie musi być bitowo
identyczny; cache pochodny można odtworzyć albo atomowo unieważnić przed retry.
Commit jest ostatnią operacją, która nie może zawieść.

**Odrzucone alternatywy.** Samo przesunięcie inkrementacji time/step nie cofa
już zmienionego device `m`. Pominięcie energii Robin fałszuje `E_total`.
Zwrócenie sukcesu mimo błędu redukcji ukrywa utratę obserwabli. Host fallback po
commit-cie nie gwarantuje atomowości.

**Propagacja CPU/GPU/kontrakt.** Planner/capability musi jawnie pokazać, czy
hybrid Robin jest unsupported czy supported. GPU step transaction obejmuje
committed m, time, step, pełny stan źródeł, stochastic interval i stats;
FSAL/demag cache/residency są pochodne i muszą być ważne albo jawnie
unieważnione przed retry. CPU semantyka failure-atomic jest oraclem kontraktu,
nie kodem do współdzielenia.

**Test-first reproducer.** Rozszerzyć
`backends/fem/tests/gpu_rk_plan.cpp`,
`backends/fem/tests/cuda_demag_robin_energy_contract.cpp` i
`backends/fem/tests/rk_explicit_contract.cpp`. Utworzyć hybrid Robin bez device
Robin workspace, zapisać committed stan, wykonać krok i wymagać preflight error
albo semantycznego rollbacku. Obecny kod zmienia time/step. Dodać osobne
fault-injection tests po utworzeniu kandydata i podczas final-stat; po każdym
błędzie retry musi dać wynik zgodny z czystym przebiegiem w metryce mieszanej.

**Zarządzany gate.** Targety powyżej w native-contract recepcie,
`just rebuild-fem-runtime`, `just verify-fem-demag-poisson-contract` i managed
hybrid Robin negative test. Po pełnej obsłudze uruchomić
`just verify-fem-relaxation-cpu-gpu-consistency-smoke` z Robin.

**Benchmark i akceptacja.** Minimalny wariant: kombinacja jest odrzucana przed
krokiem, zero artefaktów zaakceptowanego stanu. Pełny wariant: energia Robin
CPU/hybrid/device na tej samej siatce w zamrożonej metryce mieszanej, a każda
wymuszona awaria pozostawia identyczny committed stan i pozwala poprawnie
powtórzyć krok; nie wymagać bitowej tożsamości scratch/cache Hypre.

**Migracja/provenance.** Requested `gpu+hybrid+Robin` musi kończyć się jawnym
unsupported bez cichego CPU fallbacku w strict mode. Po implementacji
provenance zapisuje resolved demag mode oraz źródło Robin energy.

**Kolejność i zależności.** Natychmiast preflight reject; transakcja razem z
FEM-TD-NUM-RK-001 final-time; pełna hybrid Robin energia po
FEM-TD-NUM-DEMAG-001. Backup istnieje, ale pełny rollback pól/cache nie ma
obecnie gotowego helpera i wymaga jawnej implementacji.

**Checklist zamknięcia.** [ ] preflight; [ ] final stats przed commit; [ ] pełny
rollback; [ ] retry po failure; [ ] Robin energy parity; [ ] strict provenance;
[ ] managed negative/positive case.

#### 3. P1 — integralność pól, warunków brzegowych i obserwabli

##### 3.1 FEM-TD-PHY-ANI-001 — jednorodna oś PMA zero/nonfinite jest akceptowana

**Przyczyna źródłowa.** `normalize_axis_if_nonzero()` dzieli tylko wtedy, gdy
norma przekracza próg, lecz `normalize_anisotropy_axes()` nie odrzuca
jednorodnej osi zero, NaN ani Inf. Walidacja per-node istnieje i pokazuje
prawidłowy wzorzec. Planner wysokiego poziomu ma własne sprawdzenie, lecz
bezpośredni ABI caller i defense-in-depth pozostają nieszczelne.

**Aktualni właściciele.** Native import i walidacja:
`backends/fem/cpu/mfem/interactions/anisotropy.cpp`
(`initialize_anisotropy_plan_fields`, `normalize_anisotropy_axes`); pole:
`backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp`; planner:
`crates/fullmag-plan/src/fem.rs` (`validate_uniaxial_anisotropy_axis`); test:
`backends/fem/tests/anisotropy_contract.cpp`.

**Minimalna bezpieczna korekta.** Ustalić jeden kontrakt
`axis_norm_sq_min=1e-30` dla wszystkich warstw. Planner i native mają liczyć
stabilnie skalowaną normę kwadratową (bez overflow/underflow), odrzucać
niefinitywną oś albo `norm_sq <= axis_norm_sq_min`, a potem normalizować
dokładnie raz. Nie opisywać obecnego `norm_sq <= 1e-30` w plannerze i
`len <= 1e-30` w native jako tego samego progu. Walidacja zachodzi tylko, gdy
uniaxial anisotropy jest aktywne.

**Odrzucone alternatywy.** Domyślne zastąpienie osi zero przez z bez wiedzy
użytkownika zmienia problem. Pozostawienie tylko walidacji Python/planner nie
chroni ABI. Clamp NaN/Inf ukrywa uszkodzone wejście.

**Propagacja CPU/GPU/kontrakt.** GPU importuje już znormalizowany Context, więc
nie powinien mieć drugiej tolerancji. Python, ProblemIR, planner i native
zwracają zgodny błąd. W provenance zapisywać oś znormalizowaną oraz requested
oś, jeżeli normalizacja zmieniła jej długość.

**Test-first reproducer.** W `fem_anisotropy_contract` dodać aktywne Ku z
osiami `(0,0,0)`, `1e-20*(1,0,0)`, długością tuż pod, równą i tuż nad `1e-15`,
NaN oraz Inf. Dodać duże, skończone poprawne osie, aby dowieść stabilnej normy,
oraz pozytywny przypadek `(0,0,2)` normalizowany do z. Sprawdzać ten sam wynik
planner/native podczas create, przed wyliczeniem pola.

**Zarządzany gate.** `fem_anisotropy_contract` w native-contract recepcie,
`just rebuild-fem-runtime`, a następnie makrospin PMA CPU/GPU przez
`just verify-fem-relaxation-production-benchmark`.

**Benchmark i akceptacja.** Dla jednego domenowego makrospinu oczekiwać
`H_ani=2 Ku (m·u)u/(mu0 Ms)` i `E=-Ku V(m·u)^2`; relative error `<=1e-12` CPU
i `<=1e-10` GPU. Relaksacja z małego wychylenia kończy równolegle do `±u`.

**Migracja/provenance.** Dotychczasowe plany z osią zero zaczną być odrzucane;
komunikat ma wskazywać `anisotropy_axis` i normę. Poprawne osie zachowują API.

**Kolejność i zależności.** Niezależna poprawka; przed CAP-001 managed PMA
workload, aby anisotropy-only acceptance nie otworzyło błędnego native wejścia.

**Checklist zamknięcia.** [ ] zero; [ ] near-zero; [ ] NaN/Inf; [ ] planner i
native ten sam próg; [ ] GPU konsumuje normalizowaną oś; [ ] analytic macrospin.

##### 3.2 FEM-TD-PHY-DMI-001 — periodic DMI nie redukuje residualu po klasach

**Przyczyna źródłowa.** CPU bulk projektuje wejściowe `m`, interfacial nie;
oba najpierw dzielą pełny residual przez lokalną masę, po czym
`compute_effective_fields_for_magnetization()` kopiuje wartość reprezentanta na
klasę. Prawidłowy problem okresowy wymaga redukcji residualu i ważonej masy
przed dzieleniem. GPU `gpu_rk_compute_one_dmi_field()` nie wykonuje ani ogólnej
projekcji wejścia, ani redukcji klas.

**Aktualni właściciele.** CPU residual:
`backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp`
(`compute_interfacial_dmi_field`) i `dmi_bulk.cpp`
(`compute_bulk_dmi_field`); projekcja:
`backends/fem/src/dmi_weak_residual.cpp` (`dmi_project_lumped_field`);
kompozycja:
`backends/fem/cpu/mfem/interactions/effective_field.cpp`; GPU:
`backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu`; referencyjny wzorzec
class mass istnieje w
`backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp` i
`backends/fem/gpu/cuda/exchange/exchange_kernels.cu`.

**Minimalna bezpieczna korekta.** Jeżeli nie da się wdrożyć całej redukcji w
jednym review, planner/native mają odrzucać `DMI+PBC`. Docelowo dla obu form
użyć macierzy prolongacji klas `P`: projektować `m` do zgodnych klas, złożyć
pełny residual `r`, a następnie policzyć
`r_c=P^T r`, `W_c=P^T diag(M_i Ms_i)P`,
`H_c=-(mu0 W_c)^(-1)r_c` i `H_full=P H_c`, gdzie `M_i` jest nodalną lumped
objętością. To nie jest post-hoc uśrednienie pola. W każdej klasie okresowej
muszą być zgodne `Ms`, `D_ind`, `D_bulk`, magnetic mask i material ID; w
przeciwnym razie plan jest odrzucany. GPU wykonuje tę samą redukcję na device.

**Odrzucone alternatywy.** Kopia reprezentanta po lokalnej projekcji nie jest
redukcją słabego residualu. Średnia pól po klasie daje inny denominator przy
nierównych masach. Poprawienie tylko bulk albo tylko CPU utrzymuje drift.

**Propagacja CPU/GPU/kontrakt.** Wspólny kontrakt periodic class reduction ma
obsługiwać interfacial i bulk DMI, energię, TPI DMI action i obserwable.
Nie należy przenosić całych implementacji CPU/GPU do jednego monolitu;
współdzielone są równania, mapy klas i test vectors.

**Podstawa zewnętrzna.** Oficjalny kontrakt MFEM buduje periodyczność przez
identyfikację wierzchołków/topologii, więc residual i mass muszą być składane w
tej samej przestrzeni ograniczonej, a nie korygowane przez kopię pola po solve
([MFEM periodic boundaries](https://mfem.org/howto/periodic-boundaries/)).
Słaby oracle bulk DMI powinien być zgodny ze zbieżnym sformułowaniem FEM
[Davoli et al.](https://arxiv.org/abs/2010.15541). Naturalne warunki brzegowe
interfacial DMI opisane przez
[Rohart i Thiaville](https://arxiv.org/abs/1310.0666) dotyczą fizycznej krawędzi;
nie wolno ich ponownie dodawać na parze ścian zidentyfikowanych okresowo.

**Test-first reproducer.** Rozszerzyć
`backends/fem/tests/dmi_weak_residual.cpp` o skośną komórkę okresową z klasami
o nierównej lumped mass. Oracle liczy `P^T r` i `P^T diag(M_i Ms_i)P` bez
wywołania produkcyjnej projekcji. Dodać permutację numerów węzłów, przypadki
niezgodnego `Ms/D_ind/D_bulk/mask/material ID` i wymagać identycznego
pola/energii dla legalnego przypadku. `source_facade_cuda_kernels_contract.cpp`
pozostaje testem tekstowym; dodać osobny linkowany executable CUDA target, np.
`fem_cuda_periodic_dmi_contract`, z realnym device fixture.

**Zarządzany gate.** `fem_dmi_weak_residual`, `fem_dmi_contract` i
`fem_cuda_periodic_dmi_contract` przez **[NOWY]**
`just verify-fem-time-domain-native-contract`; `just rebuild-fem-runtime`;
następnie rozszerzyć **obie istniejące** receptury o scenariusze z aktywnym DMI:
`just verify-fem-periodic-antidot-relaxation-runtime` dla CPU oraz
`just verify-fem-periodic-antidot-relaxation-gpu-runtime` dla GPU. Obecny
periodic-antidot bez DMI nie jest dowodem tej naprawy.

**Benchmark i akceptacja.** Użyć jednoznacznych oracles chirality przy
niezmienionych `D` i geometrii: bulk
`m=(0,cos(qx),sin(qx))`, `E_D/V=-Dq`; interfacial dla `n=z`
`m=(sin(qx),0,cos(qx))`, `E_D/V=Dq`; w obu porównać `q` i `-q`. Nie używać
nieokreślonego „lustrzanego odbicia”, bo `m` jest wektorem osiowym. Tolerancje
mieszane wyprowadzić ze skal `H_D=2|Dq|/(mu0 Ms)` i `E_D=|Dq|V`; zamrozić je
po refinement. Wynik jest niezmienny na permutację i zbiega przy refinement,
a CPU/GPU spełniają te same wymiarowe bounds.

**Migracja/provenance.** Do czasu pełnej poprawki capability `DMI+PBC` ma być
unsupported. Po wdrożeniu provenance zapisuje periodic reduction method oraz
liczbę klas. Stare periodic-DMI wyniki nie są porównywalne.

**Kolejność i zależności.** Fail-closed natychmiast; pełna naprawa po
FEM-TD-PHY-MAT-001 dla klas z materiałami i przed TPI re-enable. Ordinary
nonperiodic DMI pozostaje bez zmiany.

**Checklist zamknięcia.** [ ] input projection obu form; [ ] residual sum; [ ]
`Ms*M` class mass; [ ] expand; [ ] GPU device reduction; [ ] permutation;
[ ] chirality/refinement; [ ] truthful capability/provenance.

##### 3.3 FEM-TD-OBS-001 — średnia magnetyzacja jest node-count weighted

**Przyczyna źródłowa.** `average_magnetization_components()` sumuje aktywne
węzły i dzieli przez count. CUDA `magnetization_sum_blocks_kernel()` oraz
`gpu_rk_publish_final_step_stats()` robią to samo. Oba lane mają już lumped
mass, lecz observable jej nie używa.

**Aktualni właściciele.** CPU:
`backends/fem/cpu/mfem/runtime/step_metrics.cpp`
(`average_magnetization_components`, `fill_common_step_metrics`); GPU:
`backends/fem/gpu/cuda/observables/observable_kernels.cu`
(`magnetization_sum_blocks_kernel`) i
`backends/fem/gpu/cuda/integrators/rk/rk_step_stats_publication.cpp`
(`gpu_rk_publish_final_step_stats`); test:
`backends/fem/tests/step_metrics_contract.cpp`; kontrakt:
`docs/physics/0910-table-autosave-observables.md`.

**Minimalna bezpieczna korekta.** Liczyć
`<m>=sum_i M_i m_i/sum_i M_i` wyłącznie po magnetic mask. Nie pomijać
magnetycznego węzła dlatego, że `m` jest bliskie zero; FEM-TD-NUM-RK-003 ma
odrzucić taki stan. GPU kernel otrzymuje istniejące `lumped_mass` i redukuje
trzy ważone sumy plus total volume.

**Odrzucone alternatywy.** Średnia po elementach bez funkcji bazowych dubluje
węzły i nie odpowiada `integral m dV`. Liczba węzłów jest zależna od adaptacji.
Osobna konwencja GPU jest niedopuszczalna.

**Propagacja CPU/GPU/kontrakt.** Zmieniają się step stats, tabele, wykresy,
artefakty i każdy stop/benchmark korzystający z mx/my/mz. Nazwa observable
pozostaje, ale provenance powinien zapisać `volume_lumped` averaging.

**Test-first reproducer.** W `fem_step_metrics_contract` utworzyć co najmniej
trzy węzły o masach `{1,2,7}` i różnych `m`; oracle jest ręczną ważoną sumą.
Obecna node mean ma dać inną wartość. Ten sam fixture uruchomić przez CUDA
reduction. Sprawdzić refinement przez podział jednego elementu bez zmiany pola.

**Zarządzany gate.** `fem_step_metrics_contract` i CUDA observable target w
native-contract recepcie, `just rebuild-fem-runtime`,
`just verify-fem-relaxation-cpu-gpu-consistency-smoke` oraz Box500 gate.

**Benchmark i akceptacja.** Analityczny piecewise-constant/linear field na
nierównomiernej siatce: błąd do lumped FEM integral `<=1e-12` CPU i
`<=1e-10` GPU. Lokalne refinement nie zmienia średniej bardziej niż błąd
aproksymacji i CPU/GPU publikują ten sam szereg.

**Migracja/provenance.** Historyczne mx/my/mz na nierównych siatkach zmienią
się. Dodać averaging convention do metadanych tabeli; nie zmieniać jednostki ani
ID.

**Kolejność i zależności.** Po poprawnej lumped-mass inicjalizacji; niezależne
od algorytmu. Test z invalid zero state po FEM-TD-NUM-RK-003.

**Checklist zamknięcia.** [ ] CPU weighted sum; [ ] GPU weighted reduction;
[ ] total magnetic volume; [ ] no zero-vector skip; [ ] refinement invariant;
[ ] table/provenance metadata.

##### 3.4 FEM-TD-OBS-003 — `H_oe` publikuje unit-current basis zamiast pola

**Przyczyna źródłowa.** `initialize_oersted_cylinder_field()` zapisuje w
`ctx.oersted.h_xyz` bazę dla 1 A. `add_oersted_cylinder_field()` i CUDA RHS
skalują ją prądem/envelope tylko podczas sumowania H_eff. `context_copy_field_f64`
i GPU snapshot zwracają surowe `h_xyz/device h_oe` jako A/m.

**Aktualni właściciele.** Oersted aggregate i cylinder:
`backends/fem/cpu/mfem/interactions/oersted.cpp`,
`oersted_cylinder.cpp`; readback:
`backends/fem/cpu/mfem/runtime/state_io.cpp`
(`context_copy_field_f64`) i `snapshot.cpp`; GPU:
`backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.cu`; async snapshot:
`backends/fem/src/api.cpp` (`gpu_snapshot_source_field`,
`schedule_gpu_snapshot_payload`).

**Minimalna bezpieczna korekta.** Nazwać storage `h_basis_per_ampere` i nigdy
nie wystawiać go jako `H_oe`. Dodać interaction-owned materializację
`H_oe(t)=I*envelope(t)*basis`; explicit nodal Oersted pozostaje już finalnym
polem. CPU copy i GPU snapshot mają korzystać z materializowanego pola dla
accepted `evaluation_time_s` z FEM-TD-NUM-RK-001.

**Odrzucone alternatywy.** Przeskalowanie bufora basis in-place niszczy
ponowne użycie i może mnożyć skalę kolejny raz. Zmiana jednostki publicznego
`H_oe` na A/m/A łamie canonical quantity; jeżeli basis ma być dostępna, potrzebuje
osobnego ID technicznego, nie zastąpienia pola.

**Propagacja CPU/GPU/kontrakt.** Quantity catalog, field store, native ABI
observable, CPU/GPU snapshot i H_eff decomposition muszą zgadzać się co do
czasu. `H_oe` ma A/m i jest dokładnie tym członem, który wszedł do H_eff.

**Test-first reproducer.** W `backends/fem/tests/oersted_contract.cpp` ustawić
`I=2 A` i sinus envelope różny od 1. Porównać `copy(H_oe)` z
`H_eff(with Oersted)-H_eff(without Oersted)` dla dwóch czasów. Obecny output
pozostaje basis. Powtórzyć przez CPU copy, GPU sync i async snapshot.

**Zarządzany gate.** `fem_oersted_contract`, `fem_state_io_contract`,
`fem_snapshot_contract` oraz GPU snapshot target w native-contract recepcie;
`just rebuild-fem-runtime`; Oersted scenario w
`just verify-fem-relaxation-production-benchmark`.

**Benchmark i akceptacja.** Cylinder: `|H|=|I(t)|/(2 pi r)` na zewnątrz i
odpowiednia postać liniowa wewnątrz; znak zmienia się z `I(t)`. Decomposition
identity ma `rtol<=1e-12` CPU, `<=1e-10` GPU, a snapshot odpowiada accepted
time bit-for-bit z buforem użytym przez final RHS.

**Migracja/provenance.** Publiczny ID zostaje `H_oe`; historyczne artefakty
mogą mieć złą amplitudę i muszą zostać oznaczone solver-version. Provenance
zapisuje realization, current i evaluation time.

**Kolejność i zależności.** Po FEM-TD-NUM-RK-001. Oersted energy dla direct
minimizerów jest osobnym warunkiem FEM-TD-REL-002.

**Checklist zamknięcia.** [ ] basis niepubliczna; [ ] scaled CPU field; [ ]
scaled GPU field; [ ] sync/async snapshot; [ ] decomposition; [ ] cylinder
oracle; [ ] accepted-time metadata.

##### 3.5 FEM-TD-NUM-DEMAG-001 — niektóre solve-y publikują wynik bez zbieżności

**Przyczyna źródłowa.** CPU Hypre Poisson, periodic reduced Poisson, Hypre
FEM/BEM oraz strict-device Hypre odczytują iterations/residual, ale wracają
success bez niezależnej bramki zbieżności. Serial FEM/BEM i relaxacyjny
preconditioner pokazują prawidłowy wzorzec walidacji.

**Aktualni właściciele.** CPU:
`backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp`
(`solve_demag_poisson_hypre`), `demag_poisson_periodic.cpp`
(`solve_demag_periodic_poisson_reduced`),
`demag_fem_bem_linear_solve.cpp` (`solve_demag_fem_bem_sparse_system`); GPU:
`backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`
(`compute_device_demag_for_device_stage_impl`) i `hypre_device_solver.cpp`
(`read_demag_poisson_hypre_solver_stats`); test:
`backends/fem/tests/demag_poisson_contract.cpp` i
`demag_fem_bem_contract.cpp`.

**Minimalna bezpieczna korekta.** Nie reinterpretować istniejącego `atol` jako
progu true residualu. Najpierw zdefiniować `r=b-Ax` na constrained true DOFs,
obsługę essential rows oraz projekcję gauge/nullspace dla Neumanna/PBC.
Następnie albo wprowadzić wersjonowane `residual_abs_l2_tolerance` z jednostką
RHS i niezależnym pomiarem, albo odrzucać obecne `Some(atol)` do czasu takiego
kontraktu. `requested_backend_atol` zachować w provenance. Wartości Hypre
telemetry pozostają diagnostyką. Na failure nie wykonywać recovery, energii,
cache store ani publication; zwrócić solver, iterations, true residual, limit,
gauge i realization w błędzie.

**Odrzucone alternatywy.** `iterations<max_iter` nie dowodzi zbieżności.
Sprawdzenie tylko `GetFinalResidualNorm()` bez zdefiniowania względnej/absolutnej
normy jest niejednoznaczne. Warning i dalsza publikacja utrzymuje błędny wynik.

**Propagacja CPU/GPU/kontrakt.** `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`
ma zdefiniować normę i jednostkę `atol`. Planner/ABI/provenance zachowują
requested i achieved tolerances. Każda realization CPU/GPU stosuje ten sam
acceptance predicate, mimo osobnych operatorów.

**Test-first reproducer.** `max_iterations=1` samo nie gwarantuje
nonconvergence. Użyć znanego wielowymiarowego układu SPD bez skutecznego
preconditionera albo jawnego fault injection i niezależnie wykazać
przekroczenie residualu. Dodać pozytywny manufactured solution z ręcznie
policzonym constrained/gauge-aware residualem. Test failure-atomicity sprawdza,
że poprzednie H/phi nie zostały opublikowane jako nowe, a cache jest ważny albo
jawnie unieważniony.

**Zarządzany gate.** `just verify-fem-demag-poisson-contract` rozszerzony o
wszystkie cztery ścieżki, `just rebuild-fem-runtime`, potem
`just verify-fem-relaxation-production-benchmark` CPU/GPU z wymuszonym
nonconvergence oraz normalnym converged solve.

**Benchmark i akceptacja.** Manufactured Poisson: każdy accepted solve spełnia
niezależny constrained/gauge-aware residual bound. Fizyczną walidację
kuli/ellipsoidy opisać manifestem konkretnej geometrii, sekwencji siatek i
metryki demag factor; progi zamrozić dopiero po badaniu zbieżności, nie wpisywać
globalnego `2%`. Tolerancja fizyczna nie zastępuje algebraicznej.

**Migracja/provenance.** Część wcześniej „udanych” runów zacznie kończyć się
błędem. Artefakty zapisują converged flag, achieved residual, norm, iterations
i limits. Nie zmieniać po cichu max_iterations.

**Kolejność i zależności.** Przed pełnym hybrid Robin i przed kwalifikacją
każdego workflow używającego demag. Można wdrażać per realization, ale
capability każdego niezamkniętego lane pozostaje nievalidated.

**Checklist zamknięcia.** [ ] niezależny residual CPU; [ ] periodic; [ ]
FEM/BEM Hypre; [ ] device Hypre; [ ] no recovery on fail; [ ] telemetry/provenance;
[ ] manufactured solve; [ ] physical refinement.

##### 3.6 FEM-TD-NUM-DEMAG-002 — FEM/BEM akceptuje otwarty podzbiór powierzchni

**Przyczyna źródłowa.** `build_demag_boundary_surface()` wyprowadza wszystkie
rekordy ścian, lecz jeśli caller poda niepusty `boundary_faces`, sprawdza każdą
ścianę osobno i nigdy nie porównuje zbioru z kompletnym zewnętrznym brzegiem.
Jedna poprawna ściana tetraedru przechodzi.

**Aktualni właściciele.** Surface extraction i orientation:
`backends/fem/cpu/mfem/interactions/demag_fem_bem_surface.cpp`
(`build_face_records`, `add_oriented_boundary_face`,
`build_demag_boundary_surface`); test:
`backends/fem/tests/demag_fem_bem_contract.cpp`; kontrakt:
`docs/physics/0870-fem-bem-demag-open-boundary.md` i
`docs/physics/fem_demag_fem_bem.md`.

**Minimalna bezpieczna korekta.** Zbudować kanoniczny set wszystkich rekordów
z `count==1`. Dla supplied list odrzucić duplikat, brak i dodatkową/interior
face; wymagać dokładnej równości setów. Orientację można kanonizować istniejącym
`add_oriented_boundary_face()` względem opposite node; wtedy odwrócona kolejność
wejścia jest akceptowana, ale wynikowa normalna zawsze zewnętrzna. Następnie
sprawdzić edge incidence dokładnie 2 dla zamkniętej triangulacji.

**Odrzucone alternatywy.** Sam test edge incidence nie dowodzi, że jest to
właściwy zewnętrzny brzeg. Ignorowanie supplied list bez informacji w
provenance ukrywa błąd caller-a. Wymaganie identycznej kolejności/orientacji jest
niepotrzebne, skoro można kanonizować geometrycznie.

**Propagacja CPU/GPU/kontrakt.** Dotyczy CPU FEM/BEM; brak równoważnego strict
GPU modelu nie uzasadnia GPU zmian. Mesh/ABI validation i provenance mają
zapisać `boundary_source=derived|caller_verified` oraz liczbę faces/nodes.

**Test-first reproducer.** W `fem_demag_fem_bem_contract` użyć tetraedru i
przypadków: jedna ściana, brak jednej, duplikat, interior face, nonmanifold,
pełny set w permutowanej kolejności, odwrócone wszystkie windingi. Obecny kod
akceptuje podzbiór. Pełny supplied i auto-derived operator/energia mają być
identyczne.

**Zarządzany gate.** `fem_demag_fem_bem_contract` w native-contract recepcie,
`just rebuild-fem-runtime`, a następnie managed CPU FEM/BEM skrypt przez
`just fem-gpu-headless` z `FULLMAG_FEM_EXECUTION=cpu` w repozytoryjnej recepcie.

**Benchmark i akceptacja.** Pełny tetra test jest dokładnym topologicznym
oraclem. Dla geometrii fizycznej użyć jednorodnie namagnesowanej kuli/ellipsoidy
i refinement; pole/energia dla caller-verified i auto-derived surface są
identyczne w tolerancji solvera, a błąd demag factor maleje.

**Migracja/provenance.** Niepełne listy zaczną być odrzucane z listą brakujących
face keys. Poprawne listy o innym windingu pozostają kompatybilne dzięki
kanonizacji. Provenance ujawnia źródło powierzchni.

**Kolejność i zależności.** Przed skalowalną kwalifikacją FEM/BEM i po
ustaleniu residual gate FEM-TD-NUM-DEMAG-001. Niezależne od RK.

**Checklist zamknięcia.** [ ] exact exterior set; [ ] duplicates; [ ] missing;
[ ] interior/nonmanifold; [ ] canonical orientation; [ ] edge incidence; [ ]
auto/supplied parity; [ ] physical refinement.

##### 3.7 FEM-TD-GPU-OBS-001 — strict GPU publikuje stale `phi` i inne `H_demag` w airbox

**Przyczyna źródłowa.** `poisson_solution_full` jest alokowane i zwalniane,
ale nie zapisywane. `gpu_snapshot_source_field()` zwraca null dla DEMAG_PHI,
więc sync path czyta hostowy MFEM GridFunction nieodświeżany przez strict GPU.
GPU recovery przekazuje magnetic mask i zeruje air nodes, gdy CPU zachowuje
oddzielne pełnodomenowe pole wizualne.

**Aktualni właściciele.** Device state:
`backends/fem/gpu/cuda/demag_poisson/demag_state.hpp` i
`backends/fem/gpu/cuda/state/gpu_state.cpp`; solve/recovery:
`backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`; snapshot routing:
`backends/fem/src/api.cpp` (`gpu_snapshot_source_field`,
`schedule_gpu_snapshot_payload`); CPU readback:
`backends/fem/cpu/mfem/runtime/state_io.cpp`
(`copy_demag_phi_observable_f64`, `context_copy_field_f64`).

**Minimalna bezpieczna korekta.** Po accepted strict solve utrzymywać aktualny
pełny device potential i dodać scalar-device snapshot path dla `demag_phi`.
Recovery ma tworzyć dwa interaction-owned outputs: full-domain
`H_demag_visual` bez magnetic mask oraz magnetic-only `H_demag` do LLG.
Publiczny full-domain quantity czyta visual buffer; RHS czyta masked buffer.

**Odrzucone alternatywy.** Download host potential przy każdym kroku łamie
strict-device/hot-loop. Zmiana publicznego quantity na magnetic-only obniża
istniejący kontrakt airbox i rozbiega CPU/GPU. Użycie stale host GridFunction
jest pierwotnym błędem.

**Propagacja CPU/GPU/kontrakt.** Quantity domain, binary snapshot codec,
sync/async API, field store i viewport muszą rozróżniać full-domain i
magnetic-only. CPU zachowuje obecne `h_visual_xyz`; GPU dostaje równoważny
owner. Potential gauge convention musi być zapisana.

**Test-first reproducer.** Rozszerzyć `fem_state_io_contract`,
`fem_snapshot_contract`, `fem_gpu_state_runtime_contract` oraz CUDA demag test.
Wykonać dwa strict-GPU solve-y dla różnych m, pobrać phi i H na air nodes;
obecne phi się nie zmienia, a H jest zero. Dla pure Neumann/PBC usuwać wyłącznie
jawnie zadeklarowaną stałą gauge. Dla Dirichlet/Robin porównywać absolutne
`phi` oraz residual brzegowy; odejmowanie najlepiej dopasowanej stałej
maskowałoby błąd BC.

**Zarządzany gate.** `just verify-fem-demag-poisson-contract`,
`just rebuild-fem-runtime`, managed strict GPU run oraz
`just verify-fem-relaxation-cpu-gpu-consistency-smoke` rozszerzony o próbki
full-domain.

**Benchmark i akceptacja.** Dwa-state freshness: checksum/generation zwiększa
się dokładnie po solve. Na identycznej mesh CPU/GPU porównują gauge-normalized
phi tylko dla pure Neumann/PBC, a dla Dirichlet/Robin absolutne phi i residual
brzegowy. Mixed L2 bound wyprowadzić z tolerancji solve i badania siatki; nie
używać globalnego `1e-6`. Airbox H zbiega przy refinement, a magnetic-only H
użyte w RHS pozostaje zero poza magnetem.

**Migracja/provenance.** Publiczne dane strict GPU zmienią się ze stale/zero na
wartości fizyczne. Field metadata zapisuje domain, location, gauge i source
device. Dodatkowy device buffer wpływa na memory telemetry.

**Kolejność i zależności.** Po FEM-TD-NUM-DEMAG-001; przed porównaniami
snapshot CPU/GPU. Nowe bufory należą do demag subsystemu, nie jako płaskie pola
`Context`.

**Checklist zamknięcia.** [ ] populated phi; [ ] scalar GPU snapshot; [ ]
full-domain H; [ ] masked RHS H; [ ] gauge metadata; [ ] two-state freshness;
[ ] airbox CPU/GPU parity; [ ] memory telemetry.

##### 3.8 FEM-TD-NUM-RK-003 — normalizacja przyjmuje zero i nonfinite `m`

**Przyczyna źródłowa.** CPU `normalize_aos_field()` i CUDA
`normalize_unit_vectors_kernel()` dzielą tylko dla `norm>0`. Zero pozostaje,
NaN nie spełnia porównania, a Inf może dać nieokreślone składowe. Stage i
accepted paths nie przenoszą statusu błędu.

**Aktualni właściciele.** CPU:
`backends/fem/cpu/mfem/integrators/llg_rhs.cpp`
(`normalize_aos_field`),
`backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`; GPU:
`backends/fem/gpu/cuda/fields/vector_field_kernels.cu`
(`normalize_unit_vectors_kernel`, `fullmag_cuda_normalize_vectors`) i
`backends/fem/gpu/cuda/integrators/rk/rk_stage_schedule.cu`; test:
`backends/fem/tests/llg_rhs_contract.cpp`.

**Minimalna bezpieczna korekta.** Zmienić normalizację na omylną operację:
scaled-hypot bez overflow/underflow, kontrola finite oraz jawny minimalny norm
zapisany w nocie integratora. CPU zwraca status z indeksem pierwszego węzła.
GPU ustawia device error flag i przerywa przed field evaluation; flaga musi
wejść do kontrolowanego readbacku, a stan nie może zostać commit-owany.

**Granica obecnego kodu.** Nie ma dziś device error channel z gwarantowanym
sprawdzeniem przed każdym stage field evaluation. Wydajna pełna poprawka GPU
wymaga nowego status buffer/reduction i pomiaru kosztu. Do czasu wdrożenia
strict GPU powinien fail-closed dla wykrytej nieprawidłowości, nawet kosztem
synchronizacji; nie wolno zastępować wektora arbitralnym kierunkiem i kontynuować.

**Odrzucone alternatywy.** `m=(1,0,0)` jako fallback ukrywa niestabilność i
zmienia topologię. Clamp NaN nie definiuje fizyki. Sprawdzenie dopiero po
H_eff pozwala nonfinite zanieczyścić solve-y i cache.

**Propagacja CPU/GPU/kontrakt.** Error przechodzi RK attempt, finalization,
stage completion i publiczny runtime. Failed node/norm i dt trafiają do
diagnostyki, nie do artefaktu pola. Retry adaptacyjne może zmniejszyć dt tylko
dla skończonego near-zero candidate; NaN/Inf jest twardym błędem.

**Test-first reproducer.** Zmienić obecny test, który akceptuje zero.
`fem_llg_rhs_contract` sprawdza zero, subnormal, NaN, +Inf i overflow-safe
finite vector. Dodać cancellation stage w `fem_rk_explicit_contract` oraz CUDA
wariant; każdy failure pozostawia wcześniejsze m/time/step bitowo bez zmian.

**Zarządzany gate.** `fem_llg_rhs_contract`, `fem_rk_explicit_contract` i CUDA
target w native-contract recepcie; `just rebuild-fem-runtime`, wszystkie
integratory w `just bench-fem-box500-consistency quick`.

**Benchmark i akceptacja.** Normalne trajektorie utrzymują
`max_i ||m_i|-1| <= 5e-13` CPU i `<=5e-12` GPU FP64. Patologiczny dt kończy się
jawnym reject/error, nigdy NaN artifact. Dodatkowy GPU status check nie może
naruszyć uzgodnionego performance gate.

**Migracja/provenance.** Run, który wcześniej trwał z invalid m, teraz kończy
się błędem z node index. Nie należy automatycznie zmieniać dt bez zapisania
rejected attempt. Threshold jest częścią wersjonowanego numerical contract.

**Kolejność i zależności.** Po atomowym rollbacku FEM-TD-GPU-NUM-001; przed
wszystkimi benchmarkami. Dokładny near-zero threshold nie jest obecnie
udokumentowany i musi zostać zatwierdzony przed kodem.

**Checklist zamknięcia.** [ ] physics threshold; [ ] safe norm CPU; [ ] device
flag; [ ] pre-field abort; [ ] failure atomicity; [ ] adaptive semantics; [ ]
norm-defect benchmark; [ ] performance gate.

#### 4. P2 — kontrakty, algorytmy rozwojowe i odporność

##### 4.1 ABI-001 — time-domain plan ABI nie ma version/size envelope

**Przyczyna źródłowa.** C `fullmag_fem_plan_desc` i jego Rust mirror zaczynają
się bez `abi_version` i `struct_size`; `fullmag_fem_backend_create()` przekazuje
cały obiekt bez walidacji layoutu do `initialize_backend_runtime()`. Nowa
biblioteka może czytać poza starszym callerem, a stara biblioteka może
interpretować przesunięte pola nowego callera.

**Aktualni właściciele.** `native/include/fullmag_fem.h`,
`crates/fullmag-fem-sys/src/lib.rs` (`fullmag_fem_plan_desc` i bind),
`backends/fem/src/api.cpp` (`fullmag_fem_backend_create`),
`backends/fem/cpu/mfem/runtime/backend_lifecycle.cpp`
(`initialize_backend_runtime`) oraz konstruktor w
`crates/fullmag-runner/src/native_fem.rs`.

**Minimalna bezpieczna korekta.** Nie wstawiać pól na początek starego structu.
Dodać wersjonowany descriptor i symbol create, którego pierwsze pola to
`abi_version` i `struct_size`. Stary `fullmag_fem_backend_create` pozostaje
legacy shimem tłumaczącym dokładnie znany stary layout. Nowy caller wymaga
nowego symbolu; połączenie z old library kończy się czystym missing-symbol/
version error zamiast silent misread. Opcjonalny tail czytać wyłącznie, gdy
`struct_size >= offsetof(field)+sizeof(field)`.

**Odrzucone alternatywy.** Dodanie pól do istniejącego początku jest natychmiast
ABI-breaking. Pole size na końcu nadal wymaga odczytu poza starym allocation.
Sama kontrola freshness manifestu nie jest granicą bezpieczeństwa ABI.

**Propagacja CPU/GPU/kontrakt.** Jeden descriptor obowiązuje oba lane. Rust FFI
potrzebuje compile-time size/alignment/offset assertions. Manifest runtime i
provenance zapisują ABI version; planner physics nie zmienia się.

**Test-first reproducer.** Rozszerzyć `backends/fem/tests/contract_validation.cpp`
i `fem_plan_fields_contract.cpp` o skompilowany legacy caller, skrócony nowy
descriptor, zbyt nową wersję i prawidłowy tail. Rust test porównuje size,
align i offsets C/Rust. Obecny symbol nie może bezpiecznie odrzucić skróconego
obiektu.

**Zarządzany gate.** Dodać te targety do kontenerowej native-contract recepty,
`just rebuild-fem-runtime`, `just ensure-managed-fem-runtime`, a następnie
CPU/GPU create smoke przez `just verify-fem-relaxation-runtime`.

**Benchmark i akceptacja.** Fizyczny benchmark nie dotyczy layoutu; wymagany
jest jednak ten sam homogeneous fixture przed/po migracji z bitowo tymi samymi
polami wejściowymi i zgodnymi energiami/statystykami. Każdy mismatch wersji
odrzucany przed pierwszym odczytem tail.

**Migracja/provenance.** Przez co najmniej jeden cykl utrzymać legacy symbol i
zliczać jego użycie; ustalić datę usunięcia. Błąd podaje caller/library ABI,
minimalny size i runtime manifest. Nowy runner używa wyłącznie wersjonowanego
symbolu.

**Kolejność i zależności.** Przed dodawaniem nowych pól ABI dla termiki lub
materiałów. Może być pierwszym kontraktowym taskiem całego programu napraw.

**Checklist zamknięcia.** [ ] nowy versioned symbol; [ ] legacy shim; [ ] tail
guards; [ ] C/Rust offsets; [ ] old/new matrix; [ ] manifest ABI; [ ] CPU/GPU
create smoke; [ ] removal policy.

##### 4.2 CAP-001 — planner odrzuca anisotropy-only FEM

**Przyczyna źródłowa.** Baseline predicate w `crates/fullmag-plan/src/fem.rs`
liczy exchange, demag, Zeeman, DMI i magnetoelastic, ale pomija istniejący
`has_active_anisotropy()`. Prawidłowe pole/energia native nigdy nie są osiągane.

**Aktualni właściciele.** Planner `build_fem_plan` w
`crates/fullmag-plan/src/fem.rs`, helpery
`has_active_uniaxial_anisotropy`, `has_active_cubic_anisotropy`,
`has_active_anisotropy`; testy `crates/fullmag-plan/src/tests.rs`; publiczne
modele anisotropy w `packages/fullmag-py/src/fullmag/model`.

**Minimalna bezpieczna korekta.** Do baseline dodać aktywną anisotropy ze
wszystkich materiałów, korzystając z istniejącego helpera i field overrides.
Zachować negative test dla problemu naprawdę pozbawionego aktywnej fizyki.
Długofalowo predicate budować z jednej listy aktywnych interakcji używanej przez
lowering i capability, lecz nie blokować małej bezpiecznej poprawki.

**Odrzucone alternatywy.** Sztuczne dodanie exchange `A=0` w Pythonie ukrywa
błąd. Samo usunięcie baseline dopuści puste problemy. Sprawdzanie tylko
pierwszego materiału powtarza błąd multi-region.

**Propagacja CPU/GPU/kontrakt.** Planner acceptance musi przejść przez obecny
ABI i oba lane. Capability matrix i quantity availability dla `H_ani/E_ani`
muszą mówić to samo. Walidacja osi FEM-TD-PHY-ANI-001 pozostaje obowiązkowa.

**Test-first reproducer.** W `crates/fullmag-plan/src/tests.rs` dodać osobno
uniaxial-only, cubic-only i aktywną anisotropy tylko w drugim regionie; obecny
baseline zwraca błąd. Dodać truly-empty negative case.

**Zarządzany gate.** Planner tests w kontenerowej bramce, `just rebuild-fem-runtime`,
managed CPU/GPU PMA macrospin przez `just verify-fem-relaxation-production-benchmark`.

**Benchmark i akceptacja.** Pole i energia makrospinu jak w ANI-001; planner,
CPU i GPU przechodzą bez pomocniczego exchange/demag. Relaxed state pokrywa się
z osią easy-axis, a hard-axis daje właściwy maksimum/minimum zależnie od znaku Ku.

**Migracja/provenance.** To rozszerzenie legalności bez zmiany skryptu. Plan i
provenance mają wskazać anisotropy jako interaction spełniający baseline.

**Kolejność i zależności.** Po ANI-001, aby nowe osiągalne wejście było
defensywnie walidowane; razem z CAP-002 dla outputów PMA.

**Checklist zamknięcia.** [ ] uniaxial-only; [ ] cubic-only; [ ] later region;
[ ] empty reject; [ ] CPU/GPU macrospin; [ ] capability/provenance.

##### 4.3 CAP-002 — output forms używają różnych quantity ID i activity gates

**Przyczyna źródłowa.** `validate_executable_outputs()` ma ręczne allowlisty,
specjalny `H_OE`, brak `H_ani_cubic/H_therm`, a `SaveQuantity` sprawdza tylko
cadence/duplicates. Tymczasem `fullmag-quantities` normalizuje canonical IDs, a
runner ma osobny `fem_plan_enables_quantity()`.

**Aktualni właściciele.** `crates/fullmag-plan/src/validate.rs`
(`validate_executable_outputs`),
`crates/fullmag-quantities/src/id.rs` (`normalize_quantity_id`), `catalog.rs` i
`registry.rs`, `crates/fullmag-runner/src/quantities.rs`
(`fem_plan_enables_quantity`) oraz
`packages/fullmag-py/src/fullmag/model/outputs.py`.

**Minimalna bezpieczna korekta.** Każdy Field, Snapshot i SaveQuantity najpierw
normalizować przez `fullmag_quantities::normalize_quantity_id`, a następnie
przepuszczać przez jedną tabelę shape+backend support+active interaction.
Alias `H_OE` jest akceptowany tylko na granicy normalizacji i od razu staje się
`H_oe`. Ten sam wynik activity przenieść do runnera zamiast utrzymywać drugą
listę.

**Odrzucone alternatywy.** Dopisanie trzech stringów do allowlisty nie naprawia
driftu między formami. Walidacja dopiero przy zapisie tworzy częściowe runy.
Zwracanie zera dla inactive quantity fałszuje dostępność.

**Propagacja CPU/GPU/kontrakt.** Catalog, planner, runner field store, artifact
metadata i publiczny Python muszą używać canonical ID. Availability zależy od
aktywnej interakcji oraz rzeczywistego lane, nie tylko obecności enumu ABI.

**Test-first reproducer.** Tabela w `crates/fullmag-plan/src/tests.rs`: trzy
formy output razy `H_ani`, `H_ani_cubic`, `H_oe`, `H_therm` razy active/inactive.
Każda forma ma identyczny wynik i canonical ID. Python round-trip sprawdza alias
`H_OE` oraz eksport `H_oe`.

**Zarządzany gate.** Planner/quantity tests w kontenerowej bramce,
`just rebuild-fem-runtime`, następnie managed run zapisujący wszystkie cztery
fields każdą formą i porównujący artefakty.

**Benchmark i akceptacja.** Dla aktywnego prostego problemu ten sam quantity
odczytany live, Field, Snapshot i SaveQuantity jest numerycznie identyczny;
inactive request kończy się przed runtime. Field oracle wynika z właściwej
interakcji, nie z samego katalogu.

**Migracja/provenance.** Artefakty zapisują canonical ID; alias może pozostać
wejściowo z deprecation warning. Nie zmieniać istniejących plików bez wersji
schematu.

**Kolejność i zależności.** Po ustaleniu semantyki OBS-002 torque i OBS-003
H_oe; można wcześniej naprawić PMA/thermal ID. Nie tworzyć lokalnej trzeciej
listy.

**Checklist zamknięcia.** [ ] one normalizer; [ ] one activity table; [ ] trzy
output forms; [ ] active/inactive; [ ] aliases only at boundary; [ ] runtime
field-store; [ ] artifact canonical IDs.

##### 4.4 CAP-THERM-GPU-001 — publiczny strict GPU thermal zawsze dostaje seed 0

**Przyczyna źródłowa.** `FemPlanIR` ma `thermal_seed_config`, lecz planner
ustawia `None`; Python/ProblemIR nie ma nośnika. Runner mapuje None do zero, a
`gpu_rk_plan_device_resident()` i `gpu_rk_compute_thermal_field_contribution()`
odrzucają aktywną termikę z seed zero.

**Aktualni właściciele.** Typy:
`crates/fullmag-ir/src/study.rs` (`SeedPolicy`, `ThermalSeedConfig`) i
`crates/fullmag-ir/src/plan.rs`; planner:
`crates/fullmag-plan/src/fem.rs`; runner:
`crates/fullmag-runner/src/native_fem.rs`; ABI:
`native/include/fullmag_fem.h` i `crates/fullmag-fem-sys/src/lib.rs`; GPU:
`backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` i `rk_thermal_field.cu`.

**Minimalna bezpieczna korekta.** Dodać physics-first publiczny seed policy bez
sentinela liczbowego. Python przyjmuje dokładnie `0 <= seed <= 2^64-1`, odrzuca
ujemne, overflow i `bool`; `None` oznacza `system_entropy`, a każda wartość
`u64`, włącznie z zerem, oznacza `fixed`. Po ABI-001 wersjonowany descriptor
przenosi osobno policy/presence i wartość. `system_entropy` jest rozwiązywane
dokładnie raz przez wstrzykiwalny runnerowy resolver do dowolnego `u64` przed
create; resolved value i requested policy są zapisane w provenance. GPU
sprawdza obecność/policy, nie `seed != 0`.

**Odrzucone alternatywy.** Stały ukryty seed 1 daje powtarzalne, ale
niezamówione ensemble. Losowanie osobno w CPU/GPU łamie provenance i restart.
Użycie zera jako sentinela traci legalny `fixed 0`; samo usunięcie GPU check bez
osobnego presence/policy nadal nie rozróżnia intencji.

**Propagacja CPU/GPU/kontrakt.** Python, ProblemIR, planner, runner, ABI,
checkpoint i provenance muszą nieść requested policy, presence i resolved
seed. CPU i GPU używają tego samego kontraktu. Stary ABI może zachować
`0=entropy` wyłącznie w legacy shimie; nie potrafi wyrazić `fixed 0`, więc ten
przypadek musi failować przed native create do czasu nowego symbolu. Wdrożenie
pól ABI czeka na ABI-001.

**Test-first reproducer.** Python/IR/runner/ABI test matrix obejmuje `None`, `0`,
`1`, `2^64-1`, `-1`, `2^64` i `True`. Planner aktywnej temperatury oczekuje
policy/presence. Runner wstrzykuje resolvery zwracające zero i znaną wartość
niezerową, sprawdza dokładnie jedno wywołanie, zachowanie wartości przez retry
i zapis do provenance. Native/GPU akceptuje `present fixed/resolved seed=0`, a
odrzuca brak presence przy aktywnej termice. Nie testować probabilistycznie, że
dwa wywołania system entropy dają różne liczby.

**Zarządzany gate.** Kontenerowe planner/native targets,
`fem_thermal_brown_contract`, `just rebuild-fem-runtime` oraz strict GPU
stochastic script przez `just fem-gpu-headless`.

**Benchmark i akceptacja.** Fixed `0` i fixed nonzero: identyczność powtórzeń
per lane. System entropy: managed run sprawdza obecność rozwiązanej wartości,
zapis policy/value i deterministyczny replay ze zmaterializowanego seeda, nie
`seed!=0` ani przypadkową nierówność dwóch losowań. Physics qualification to
equilibrium/statistics z THERM-001/002 i jawnego kontraktu sLLG, nie sam create
PASS.

**Migracja/provenance.** Nowy publiczny parametr jest opcjonalny z domyślnym
`system_entropy`; eksport Python musi zachować jawny fixed seed. Restart używa
tego samego resolved seed i accepted step index.

**Kolejność i zależności.** ABI-001, potem publiczny carrier, potem
THERM-001/002, na końcu stochastic qualification.

**Checklist zamknięcia.** [ ] Python u64 bez bool; [ ] `None` vs fixed presence;
[ ] fixed zero; [ ] entropy resolve once do dowolnego u64; [ ] versioned ABI
policy/value; [ ] legacy fail-closed; [ ] strict GPU reachable; [ ] checkpoint;
[ ] requested/resolved provenance; [ ] statistics gate po kontrakcie sLLG.

##### 4.5 FEM-TD-PHY-ANI-002 — TPI ignoruje per-node osie PMA

**Przyczyna źródłowa.** `compute_uniaxial_anisotropy_field()` wybiera
per-node axis, ale `add_uniaxial_anisotropy_jacobian()` zawsze używa
`ctx.anisotropy.uniaxial_axis`. Field/objective i implicit curvature opisują
inne problemy.

**Aktualni właściciele.** Pole:
`backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp`; walidacja/import:
`anisotropy.cpp`; TPI:
`backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`
(`add_uniaxial_anisotropy_jacobian`,
`add_local_anisotropy_tangent_hessian`).

**Minimalna bezpieczna korekta.** Dopóki TPI-001 nie jest zamknięty, odrzucać
TPI z per-node axis. Po re-enable wyciągnąć z ownera anisotropy jeden
`uniaxial_axis_at_node(ctx,i)` używany przez field, energy i Jacobian; nie
duplikować logiki trzech tablic.

**Odrzucone alternatywy.** Uśredniona oś usuwa heterogeniczność. Ciche użycie
osi pierwszego regionu jest pierwotnym błędem. Poprawa samego Jacobianu przed
skalą TPI-001 nie kwalifikuje algorytmu.

**Propagacja CPU/GPU/kontrakt.** TPI jest CPU-only development lane. Publiczna
capability musi odrzucać kombinację, dopóki test nie przejdzie. Zwykłe RK CPU/GPU
anisotropy pozostaje bez zmiany.

**Test-first reproducer.** `fem_relaxation_source_contract` pozostaje testem
tekstowym. W osobnym linkowanym executable target użyć rozłączonych
macrospinów z osiami x i z, bez exchange/demag/Zeeman, oraz wspólnego
`uniaxial_axis_at_node(ctx,i)`. Dla `H=(a s+b s^3)u` sprawdzić osobno surowy
`J_H=(a+3b s^2)u⊗u`: `J_H delta_m` względem różnicy H. Następnie po
naprawie skali sprawdzić pełny tangent Hessian block
`mu0 Ms_i V_i B_i^T[(m_i·H_i)I-J_H,i]B_i` względem drugiej pochodnej energii po
retrakcję. Obecny kod używa jednej osi.

**Zarządzany gate.** Strukturalne targety i osobny linkowany ANI/TPI executable
przez **[NOWY]** `just verify-fem-time-domain-native-contract`, potem
`just rebuild-fem-runtime`; CPU TPI w `just verify-fem-relaxation-runtime` i
convergence dopiero po TPI-001.

**Benchmark i akceptacja.** Dwa rozłączne macrospiny PMA: raw J_H i pełny
tangent Hessian spełniają osobne mieszane bounds w sweep epsilon, energia
maleje, a każdy macrospin ustawia się do swojej osi. Jeśli benchmark używa
sprzężonych regionów, musi mieć analityczne rozwiązanie pełnego sprzężenia.

**Migracja/provenance.** Do czasu re-enable planner zwraca development
unsupported. Po wdrożeniu provenance zapisuje `anisotropy_axis=per_node` dla
TPI.

**Kolejność i zależności.** TPI-001 najpierw; ANI-001 walidacja osi i CAP-001
anisotropy-only reachability przed tym testem. Pełna poprawka nie jest
samodzielnie kwalifikowalna dziś.

**Checklist zamknięcia.** [ ] fail-closed teraz; [ ] one axis accessor; [ ]
field/energy/Jacobian; [ ] finite-difference Jv; [ ] TPI convergence; [ ]
development capability honest.

##### 4.6 FEM-TD-OBS-002 — kopiowany `torque` pomija local alpha i direct STT

**Przyczyna źródłowa.** `copy_torque_observable_f64()` rekonstruuje
field-derived LL torque z uniform alpha i H_eff. Nie czyta `alpha_field` i nie
dodaje Slonczewski/Zhang-Li RHS, mimo że katalog opisuje quantity jako total
LL torque divided by gamma0.

**Aktualni właściciele.** Readback:
`backends/fem/cpu/mfem/runtime/state_io.cpp`
(`copy_torque_observable_f64`); actual RHS:
`backends/fem/cpu/mfem/integrators/llg_rhs.cpp` i
`backends/fem/cpu/mfem/interactions/stt.cpp`; GPU actual RHS:
`backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu` oraz
`rk_direct_torques.cu`; canonical metadata:
`crates/fullmag-quantities/src/catalog.rs` (`QuantityId::Torque`).

**Minimalna bezpieczna korekta.** Najpierw w physics note rozdzielić trzy
quantity: field-derived torque/gamma, direct torque i total RHS/gamma z
jednoznaczną jednostką. Następnie dodać jeden RHS decomposition owner używany
przez stepper i observables; local alpha jest wybierane per node, direct STT
jest dodawane dokładnie raz. Jeżeli publiczne `torque` ma pozostać total, katalog
i output zwracają total.

**Odrzucone alternatywy.** Dopisanie STT tylko w state_io dubluje równanie i
może oddryfować. Przemianowanie etykiety bez nowego total quantity zachowuje
mylący publiczny kontrakt. Utożsamienie z `max_torque_Apm` jest błędne, bo ten
scalar obecnie oznacza `max|m x H_eff|`.

**Propagacja CPU/GPU/kontrakt.** Note, quantity catalog, ABI observable,
field store, API metadata i CPU/GPU RHS decomposition. Nie dodawać solver logic
do runnera; runner tylko mapuje quantity IDs.

**Test-first reproducer.** `fem_state_io_contract`: dwa węzły z różnym alpha;
STT-only przy H_eff=0; combined field+STT. Oracle wywołuje niezależne równanie,
nie production helper. GPU snapshot ma te same trzy rozkłady. Obecny `torque`
jest zero dla STT-only.

**Zarządzany gate.** `fem_state_io_contract`, `fem_stt_contract`, GPU RHS
targets w native-contract recepcie; `just rebuild-fem-runtime`; STT scenario w
`just verify-fem-relaxation-production-benchmark`.

**Benchmark i akceptacja.** Dekompozycja nodewise sumuje się do actual RK RHS
po uwzględnieniu gamma convention z `rtol<=1e-10`. STT-only ma właściwy znak i
niezerowe total, field component zero. CPU/GPU snapshot parity `rtol<=1e-8`.

**Migracja/provenance.** Jeżeli semantyka publicznego `torque` się zmienia,
zwiększyć schema/quantity metadata version i zachować wyraźne legacy ID albo
migrator. Nie zmieniać danych pod tą samą niewersjonowaną etykietą.

**Kolejność i zależności.** Physics decision przed kodem; Zhang-Li po STT-001;
relaxation legality REL-002 nie może czekać na ten observable.

**Checklist zamknięcia.** [ ] canonical semantics/units; [ ] local alpha; [ ]
direct STT; [ ] one RHS decomposition; [ ] CPU/GPU parity; [ ] API metadata;
[ ] versioned migration.

##### 4.7 FEM-TD-GPU-NUM-002 — strict GPU ignoruje demag refresh interval

**Przyczyna źródłowa.** CPU/hybrid używa
`demag_poisson_should_refresh_field()`, lecz
`gpu_rk_compute_demag_for_device_stage()` wywołuje strict device solve dla
każdego etapu. Device demag nie ma cache decision, mimo że plan/provenance
przenosi `demag_interval_s`.

**Aktualni właściciele.** Policy CPU:
`backends/fem/cpu/mfem/interactions/demag_poisson_cache.cpp`; aggregate:
`demag.cpp`; GPU dispatch:
`backends/fem/gpu/cuda/integrators/rk/rk_demag_dispatch.cu`; solve:
`backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`; policy forwarding w
`crates/fullmag-runner/src/native_fem.rs`.

**Minimalna bezpieczna korekta.** Najpierw, jeśli strict GPU nie implementuje
policy, odrzucać jawnie nondefault interval lub resolved policy ustawiać
`every_stage` z ostrzeżeniem tylko w nie-strict mode. Docelowo dodać
demag-owned device cache validity i last refresh **accepted solver time**.
Pośrednie stany RK nie zerują cadence przy każdej zmianie magnetyzacji.
Zewnętrzne `set_magnetization` oraz zmiana operatora, materiału lub BC muszą
unieważniać cache. PG-BB/NCG/TPI odrzucają niezerowy interval, dopóki nie ma
osobnej polityki zgodnej z ich funkcją celu.

**Odrzucone alternatywy.** Ciche liczenie częściej nie realizuje requested
scheme i fałszuje koszt/provenance. Host cache copy łamie strict residency.
Cache tylko po step_count nie rozróżnia etapów i trial states.

**Propagacja CPU/GPU/kontrakt.** Requested/resolved refresh policy, solve
counts, FSAL/final refresh i performance telemetry muszą być spójne. CPU i GPU
mogą mieć osobne cache, ale dla LLG decyzję wiąże accepted time oraz jawne
external/operator/material/BC invalidations, nie każdy stage-state generation.

**Test-first reproducer.** Rozszerzyć `fem_field_refresh_contract`,
`fem_gpu_rk_plan` i CUDA timing contract. Dla interval większego niż całe okno
policzyć solve-y dla accepted-time policy wszystkich czterech RK; pośrednie
stage states nie odświeżają demag tylko z powodu zmiany m. Osobno sprawdzić
invalidation przez external `set_magnetization`, operator, materiał i BC oraz
rejection niezerowego interval dla PG-BB/NCG/TPI.

**Zarządzany gate.** Native targets, `just rebuild-fem-runtime`,
`just verify-fem-relaxation-production-benchmark` i demag performance gate
`just verify-fem-gpu-demag-performance-benchmark`.

**Benchmark i akceptacja.** Solve count dokładnie odpowiada resolved policy;
CPU/GPU z tą samą frozen-field cadence mają zgodne energie/trajectory w
ustalonej tolerancji. Provenance count i profiler count są identyczne.

**Migracja/provenance.** Jawnie zapisać requested interval, resolved cadence,
cache hits/misses i solve count. Strict unsupported kończy się przed krokiem.

**Kolejność i zależności.** Po RK-001 explicit evaluation time i DEMAG-001
convergence; przed performance qualification.

**Checklist zamknięcia.** [ ] fail-closed nondefault; [ ] device cache; [ ]
accepted-time cadence; [ ] explicit external/operator/material/BC invalidation;
[ ] minimizer reject; [ ] all RK solve counts; [ ] provenance/profile
agreement; [ ] performance PASS.

##### 4.8 FEM-TD-NUM-RK-002 — PI controller nie uwzględnia rzędu estymatora

**Przyczyna źródłowa.** `adaptive_pi_step()` i
`gpu_rk_adaptive_pi_step()` stosują stałe 0.7/0.4 bez podziału przez rząd błędu,
a accepted ratio clampują do minimum 1. `ExplicitTableau` już przechowuje
`order_est`, ale controller go nie otrzymuje.

**Aktualni właściciele.**
`backends/fem/cpu/mfem/integrators/adaptive_dt.hpp` i
`backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`,
`rk_tableau.hpp`, GPU `rk_adaptive_runtime.cu`, test
`backends/fem/tests/adaptive_dt_contract.cpp` i nota
`docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`.

**Minimalna bezpieczna korekta.** Zdefiniować `p=order_est+1`, czyli potęgę
lokalnego embedded error, i zapisać bezpośrednio
`ratio=safety*error_n^(-0.7/p)*error_(n-1)^(0.4/p)`. Nie podstawiać tych
wykładników do obecnej postaci
`error^(-alpha)*(prev/error)^beta`, bo dałaby wykładnik bieżącego błędu
`-1.1/p`; równoważnie przy zachowaniu starej postaci należałoby użyć
`alpha=0.3/p`, `beta=0.4/p`. Accepted ratio clampować do
`[dt_shrink_min,dt_grow_max]`, więc może być mniejszy od 1. CPU/GPU wywołują
wspólną czystą scalar policy albo identyczne test vectors.

**Odrzucone alternatywy.** Osobne magic constants RK23/RK45 utrudniają audit.
Zmiana tylko reject exponent nie naprawia accepted sequence. Brak shrink po
accepted near-limit step powoduje późniejsze zbędne rejecty.

**Propagacja CPU/GPU/kontrakt.** Note, tableau/controller interface, telemetry
dt suggested, restart state `prev_error_norm` i oba lane. Publiczne parametry
safety/growth/shrink zachowują znaczenie.

**Test-first reproducer.** W `fem_adaptive_dt_contract` podać identyczną
sekwencję błędów RK23 i RK45 oraz ręczny oracle. Dodać accepted error blisko 1,
dla którego ratio<1. Wyniki CPU/GPU porównywać metryką mieszaną albo użyć
wspólnej hostowej scalar policy; nie wymagać bitowej zgodności osobnych
wywołań `pow`.

**Zarządzany gate.** `fem_adaptive_dt_contract`, `fem_rk_explicit_contract` i
GPU target w native-contract recepcie; `just rebuild-fem-runtime`; wszystkie
integratory w `just bench-fem-box500-consistency quick`.

**Benchmark i akceptacja.** Gładki makrospin ODE z referencją wysokiej
dokładności: global error skaluje się z tolerancją/rzędem, liczba rejectów nie
rośnie patologicznie, CPU/GPU podejmują te same decyzje w FP64. Nie ustalać
akceptacji wyłącznie przez mniejszą liczbę kroków.

**Migracja/provenance.** Adaptive step trace i trajectory zmienią się;
controller formula/order muszą trafić do provenance. Tolerancje publiczne nie
zmieniają jednostek.

**Kolejność i zależności.** Po RK-001 stage-time i THERM-001 retry semantics;
przed adaptive stochastic qualification.

**Checklist zamknięcia.** [ ] note formula; [ ] order from tableau; [ ] accepted
shrink; [ ] CPU/GPU vector parity; [ ] tolerance convergence; [ ] provenance
controller ID.

##### 4.9 FEM-TD-NUM-TPI-001 — TPI miesza niezgodne skale słabych operatorów

**Przyczyna źródłowa.** `assemble_tangent_plane_operator()` dodaje
Ms-weighted mass i surową exchange stiffness z `DiffusionIntegrator(A)` przez
jeden liczbowy `implicit_weight`; lokalne i matrix-free DMI/demag używają
volume mass oraz H-field derivatives. Suma nie ma jednej jednostki.

**Aktualni właściciele.** TPI:
`backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`
(`assemble_tangent_plane_operator`, `MatrixFreeTangentPlaneOperator`,
`solve_tangent_plane_linear_system`); forms:
`backends/fem/cpu/mfem/interactions/exchange_operator.cpp` i
`exchange_mass_projection.cpp`; test:
`backends/fem/tests/relaxation_source_contract.cpp`; nota:
`docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`.

**Minimalna bezpieczna korekta.** Wyłączyć publiczne TPI w plannerze/native
capability i zwracać development unsupported. Nie ma bezpiecznej lokalnej
zmiany współczynnika. Przed re-enable opublikować pełne dyskretne równanie z
jedną metryką i jednostką step, następnie wyprowadzić mass, exchange, local,
DMI i demag blocks z tej samej energii/Hessian convention.

**Odrzucone alternatywy.** Sam mnożnik `2/mu0` przy exchange nie rozstrzyga
Ms/volume weighting innych bloków. Strojenie implicit_weight benchmarkiem
maskuje brak jednostek. Pozostawienie development executable pozwala uzyskiwać
wyniki bez fizycznego kontraktu.

**Propagacja CPU/GPU/kontrakt.** Aktualnie tylko CPU; GPU pozostaje unsupported.
Physics note, capability, planner, native dispatch i provenance mają mówić
jednoznacznie disabled. Po redesign każdy blok dostaje osobny Jv oracle.

**Test-first reproducer.** Najpierw test planner/native rejection.
`fem_relaxation_source_contract` pozostaje testem tekstowym. Dla redesign dodać
osobny linkowany executable target, wyekstrahować małą macierz 1-2 tetra i
porównać każdy block z finite-difference Hessian/Jv kanonicznej energii. Dla
lokalnej PMA sprawdzić osobno surowy `J_H delta_m` i pełny tangent Hessian po
retrakcji zgodnie z ANI-002. Test obecnej sumy ujawnia różne skalowanie po
zmianie `Ms`.

**Zarządzany gate.** Gate rejection w native-contract oraz osobny linkowany
TPI executable przez **[NOWY]** `just verify-fem-time-domain-native-contract` i
`just verify-fem-relaxation-runtime` oczekujący jawnego skip/unsupported TPI.
Po pełnej implementacji: rebuild, convergence i osobny managed TPI benchmark.

**Benchmark i akceptacja.** Każdy block Jv przechodzi epsilon sweep z mieszanym
abs/rel bound wyprowadzonym ze skali operatora, błędu FD i ewentualnego solve;
zmiana `Ms`/mesh daje przewidziane skalowanie. Energię, final torque i
obserwable porównywać z PG-BB/NCG w sposób niezmienniczy względem symetrii, nie
przez identyczny węzłowy stan. Sam 4-step smoke nie wystarcza.

**Migracja/provenance.** TPI zmienia status z development executable na
unsupported do czasu kwalifikacji. Stare wyniki nie dostają validated. Po
powrocie provenance podaje equation/metric version.

**Kolejność i zależności.** Disable natychmiast; REL-001 energy metric i
ANI-002 przed redesign; DEMAG-001 przed demag block. Pełna poprawka nie jest
obecnie wsparta przez kanoniczne wyprowadzenie i jest jawnie zablokowana.

**Checklist zamknięcia.** [ ] public disable; [ ] native disable; [ ] physics
derivation; [ ] per-block units; [ ] per-block Jv; [ ] Ms/mesh scaling; [ ]
minimum parity; [ ] requalification before re-enable.

##### 4.10 FEM-TD-REL-003 — absolutny energy noise floor może dopuścić wzrost

**Przyczyna źródłowa.** CPU/GPU PG-BB/NCG używają
`max(1e-23 J,1e-12*max(|Ecurrent|,|Etrial|))` bez pomiaru błędu redukcji dla
danego mesh/solver. Zachowanie jest pewne; materialny wpływ pozostaje
`risk_requires_test`.

**Aktualni właściciele.** CPU
`backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp` i
`nonlinear_cg.cpp` (`line_search_energy_tolerance`); GPU odpowiednio
`backends/fem/gpu/cuda/relaxation/pgbb.cpp` i `nonlinear_cg.cpp`; dokument
`docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`.

**Minimalna bezpieczna korekta.** Najpierw zmierzyć, nie zgadywać. Publikować
`energy_increase_j`, applied allowance i reason w diagnostyce. Sweep określa
górny bound szumu z powtarzalnych redukcji; dopiero wtedy zastąpić stały floor
skalą wynikającą z machine epsilon, sumy modułów członów i zmierzonego solver
residual. Wzrost większy od bound zawsze odrzucać.

**Odrzucone alternatywy.** Ustawienie zera może powodować fałszywe odrzucenia
od roundoff. Pozostawienie 1e-23 bez danych jest niekalibrowane. Tolerance jako
parametr użytkownika przerzuca odpowiedzialność fizyczną bez oracla.

**Propagacja CPU/GPU/kontrakt.** Jedna formuła allowance, osobne zmierzone
reduction bounds CPU/GPU i jawna provenance. REL-001 musi najpierw naprawić
Armijo derivative, inaczej sweep miesza dwa defekty.

**Test-first reproducer.** `fem_relaxation_source_contract` pozostaje testem
tekstowym. Dodać osobny linkowany executable target dla energy-reduction error:
skale od `1e-28` do `1e-18 J`, kontrolowane dodatnie delty wokół `1e-23`,
high-precision albo compensated reference, zmieniona kolejność redukcji,
liczba wątków/bloków, rozmiar siatki i residual solvera. Obecny kod akceptuje
zaprogramowany mały wzrost.

**Zarządzany gate.** Osobny executable target przez **[NOWY]**
`just verify-fem-time-domain-native-contract`, `just rebuild-fem-runtime`,
`just verify-fem-relaxation-convergence` i production benchmark z zachowanymi
logami/diagnostyką allowance.

**Benchmark i akceptacja.** Z porównania z high-precision/compensated reference
oraz wariantów kolejności, równoległości, siatki i residualu wyprowadzić
deterministyczne ograniczenie forward error. Losową niedeterministyczność,
jeżeli istnieje, mierzyć osobno; `100` powtórzeń i etykieta `99%` nie zastępują
tego bound. Żaden zaakceptowany wzrost nie przekracza ograniczenia, a końcowe
minimum pozostaje zgodne z reference reduction. Wynik może wykazać, że obecny
floor jest bezpieczny; wtedy zamknięcie polega na dowodzie i diagnostyce, nie
wymuszonej zmianie liczby.

**Migracja/provenance.** Zapis allowance formula/version i liczby monotone-noise
accepts. Zmiana może zwiększyć backtracks; nie obiecywać identycznego pseudoczasu.

**Kolejność i zależności.** Po REL-001 i DEMAG-001. To finding nie uzasadnia
patcha bez sweepu; propozycja numeryczna nie jest obecnie wsparta pomiarem.

**Checklist zamknięcia.** [ ] diagnostics; [ ] energy-scale sweep; [ ] CPU/GPU
noise bound; [ ] calibrated formula albo dowód obecnej; [ ] no excess increase;
[ ] outcome parity; [ ] provenance.

##### 4.11 FEM-TD-ROB-001 — kontrakt zerowania disabled buffers jest naruszony

**Przyczyna źródłowa.** `compute_effective_fields_for_magnetization()` zawsze
dodaje `h_uniaxial`, `h_interfacial` i `h_cubic` do H_eff, ale dla wyłączonych
gałęzi nie zeruje tych interaction-owned buffers. Enablement jest obecnie
niemutowalne i inicjalizacja zwykle zeruje pamięć, więc runtime impact nie
został wykazany; source contract wymaga jednak jawnego invariantu.

**Aktualni właściciele.** Kompozycja:
`backends/fem/cpu/mfem/interactions/effective_field.cpp`
(`compute_effective_fields_for_magnetization`); inicjalizacja buforów:
`backends/fem/core/fem_field_buffers.cpp`; test:
`backends/fem/tests/effective_field_contract.cpp`
(`disabled_local_field_buffers_are_zeroed_before_composition`).

**Minimalna bezpieczna korekta.** Nie dodawać czterech operacji O(N) `assign()`
do każdego hot-loop RHS. Bieżący bezpieczny kontrakt to jednorazowa zerowa
inicjalizacja wszystkich interaction-owned buffers oraz niezmienne flagi
enablement przez cały lifetime kontekstu. Udowodnić oba warunki i poprawić
przestarzały test tekstowy. Jeżeli w przyszłości powstanie runtime toggle,
wyczyścić bufor raz na przejściu/generation change i jawnie unieważnić cache;
ta funkcja nie jest częścią obecnej naprawy.

**Odrzucone alternatywy.** Zerowanie pełnych buforów przy każdym etapie dodaje
stały koszt pamięciowy mimo niezmiennego planu. Usunięcie testu bez formalnego
immutable-lifetime proof obniża ochronę. Symulowanie nieobsługiwanego togglingu
przez ręczną zmianę flagi w teście nie opisuje legalnego runtime contract.

**Propagacja CPU/GPU/kontrakt.** CPU source i test; sprawdzić analogiczne GPU
field clear paths, ale nie zmieniać ich bez dowodu luki. Quantity inactive
powinien zostać odrzucony przez CAP-002, a wewnętrzny buffer nadal zero.

**Test-first reproducer.** Zmienić `fem_effective_field_contract`, aby sprawdzał
jednorazową zerową inicjalizację oraz brak legalnej ścieżki mutującej enablement
po utworzeniu kontekstu. Dodać fixture tworzony od początku z wyłączonym członem:
jego buffer, energia, contribution i snapshot pozostają zero przez kolejne RHS.
Osobny source contract ma zabraniać O(N) clear w hot-loop. Sentinel po
ręcznym, nielegalnym toggle nie jest poprawnym oraclem obecnego API.

**Zarządzany gate.** `fem_effective_field_contract` w
`just verify-fem-relaxation-source-contract` lub agregującej native recepcie,
`just rebuild-fem-runtime`, podstawowy `just verify-fem-relaxation-runtime`.

**Benchmark i akceptacja.** To robustness/performance contract, nie osobny
physics benchmark. W decomposition fixture H_eff z wyłączonym członem jest
bitowo równy sumie pozostałych, snapshot disabled field jest zero, a profil nie
zawiera dodatkowego O(N) clear na etap. Włączenie członu nadal przechodzi jego
analityczny oracle.

**Migracja/provenance.** Brak publicznej zmiany. Jeżeli runtime kiedyś dopuści
toggling, generation/cache invalidation musi zostać jawnie zaprojektowane;
niniejsza poprawka nie autoryzuje tej funkcji.

**Kolejność i zależności.** Mała niezależna poprawka; CAP-002 activity gating
może być wdrożony równolegle. Nie rozszerzać na refactor kompozycji.

**Checklist zamknięcia.** [ ] zero-init wszystkich buffers; [ ] immutable
enablement proof; [ ] zero energies/readback; [ ] H_eff decomposition; [ ] no
O(N) hot-loop clear; [ ] GPU audit bez nieuzasadnionej zmiany; [ ] source
contract PASS.

#### 5. Kolejność programu napraw

1. **Natychmiastowe fail-closed:** MAT-001 niewspierane elementowe materiały,
   REL-002 niedozwolone interakcje, DMI-001 PBC, TPI-001 oraz hybrid Robin.
2. **Granice danych:** ABI-001, CAP-THERM-GPU-001, CAP-001 i CAP-002.
3. **Lokalne błędy algebraiczne:** STT-001, ANI-001, THERM-002, ROB-001.
4. **Transakcja i czas:** GPU-NUM-001, RK-001, RK-003, GPU-NUM-002, RK-002.
5. **Demag i PBC:** DEMAG-001, DEMAG-002, GPU-OBS-001, DMI-001 pełna wersja.
6. **Relaksacja:** REL-001, potem pomiar REL-003; TPI pozostaje wyłączony do
   pełnego wyprowadzenia i ANI-002.
7. **Obserwable:** OBS-001, OBS-002, OBS-003 i end-to-end quantity checks.
8. **Kwalifikacja:** directional derivatives, stochastic equilibrium,
   refinement, CPU/GPU parity, signed nonlinear LLG workload i dopiero potem
   aktualizacja `validated_workloads`.

#### 6. Globalne kryterium ukończenia

Program nie jest zamknięty, dopóki każde z 27 ID nie ma: czerwonego testu na
starym kodzie; minimalnej poprawki lub jawnego fail-closed; świeżego PASS
native w kontenerze; właściwego managed runtime gate; benchmarku z oraclem i
tolerancją; zgodności note-Python-IR-planner-ABI-CPU/GPU-observable; oraz
requested/resolved provenance. TPI, pełne elementowe materiały, wydajny device
invalid-state channel i skalibrowany energy noise floor są jawnie oznaczone
jako wymagające nowego kontraktu lub pomiaru, a nie jako gotowe jednowierszowe
poprawki.

### 11.2 Playbook 18 rekordów kontraktowo-dokumentacyjnych

#### 1. Cel, zakres i reguła liczenia

Ten dokument jest implementacyjnym przewodnikiem naprawczym do ustaleń z
`.fullmag/audits/2026-07-09-backend-llg/contracts/document-findings.md`. Obejmuje
wyłącznie standardowy nieliniowy FEM: dynamikę LLG w czasie, statykę,
relaksację, interakcje, publiczny model problemu, planner, runtime, ABI,
provenance i dokumentację. Nie obejmuje FDM ani żadnego solvera
frequency/modal/eigen/driven/Floquet.

Kotwice odświeżono względem bieżącego drzewa przy HEAD
`b554346b43a79be1b681189cb5f44fb3bdb4b06a`. Przed implementacją każdej fazy
trzeba ponownie zamrozić HEAD i odświeżyć numery linii, ponieważ w repozytorium
trwa równoległa praca.

Rejestr kontraktowy ma 18 wpisów. Trzy są opisem tych samych defektów co
rejestr solvera i nie mogą zwiększać skonsolidowanej liczby problemów:

| Wpis kontraktowy | Właściciel skonsolidowanej naprawy | Dyspozycja |
|---|---|---|
| `DOC-002` | `FEM-TD-PHY-THERM-001` + `FEM-TD-PHY-THERM-002` | jedna zmiana kontraktu termiki, dokumentacja przed kodem |
| `DOC-020` | `FEM-TD-NUM-RK-001` | jedna zmiana czasu ewaluacji RK/Oersted |
| `CAP-007` | `CAP-THERM-GPU-001` | jedna zmiana publicznego carrier-a seeda i reachability GPU |

Po dyspozycji świeżego review obowiązują dwie korekty priorytetu:

- `DOC-017` ma priorytet **P3**, ponieważ dowody wskazują na niejednoznaczny
  zakres dokumentowany dla Rust reference i native FEM; istniejący natywny
  test obejmuje `K1/K2/K3`, więc nie jest to dowiedziony defekt solvera;
- `CAP-005` ma priorytet **P2**, ponieważ brak workloadów walidacyjnych nie jest
  dowodem błędnego wyniku na osiągalnej ścieżce.

Po usunięciu trzech duplikatów pozostaje 15 unikalnych ustaleń publicznego
kontraktu: P0 = 1, P1 = 1, P2 = 10, P3 = 3. Razem z 27 ustaleniami solvera
skonsolidowany audyt ma 42 problemy: P0 = 9, P1 = 9, P2 = 21, P3 = 3.

#### 2. Wspólna kolejność wdrożenia i kryteria publikacji

Każda naprawa musi przejść przez te warstwy w podanej kolejności:

1. Zaktualizować właściwą notę `docs/physics/` jako źródło prawdy: równanie,
   jednostki, znaki, ograniczenia, lane CPU/GPU i plan walidacji.
2. Dodać test kontraktu, który na starej implementacji lub starej dokumentacji
   nie przechodzi. Dla zmian semantyki IR dodać też fixture migracji starego
   payloadu.
3. Zmienić publiczne authoring/`ProblemIR`/planner. Nie wolno używać wartości
   liczbowej jako ukrytego sentinela ani gubić różnicy między intencją żądaną i
   wartością rozwiązaną.
4. Dopiero potem zmienić runner, C ABI i backend, jeśli dany problem ich dotyczy.
   Nowe pola C ABI zależą od zamknięcia `ABI-001`; nie wolno dopisywać ich do
   niezwymiarowanego `fullmag_fem_plan_desc` bez `abi_version/struct_size`.
5. Uruchomić testy lokalne/source-contract, następnie
   `just ensure-managed-fem-runtime`, a na końcu odpowiedni kontenerowy gate
   runtime. Hostowy `cargo`, `cmake` lub bezpośredni plik wykonywalny nie jest
   dowodem zamknięcia FEM.
6. Zmienić `production_executable`, `validated_workloads` lub inne publiczne
   statusy dopiero po zapisaniu świeżego artefaktu z identyfikatorem runtime,
   lane, precyzją, tolerancjami, hashem wejścia i wynikiem walidatora.

Każde porównanie zmiennoprzecinkowe musi wskazać porównywane składowe albo
normę i stosować mieszany predykat
`|a-b| <= atol + rtol*max(|a|,|b|)`, z `atol` wyprowadzonym ze skali fizycznej
lub błędu dyskretyzacji. Seed, enumy, generacje i liczniki porównuje się
dokładnie. Source/text contracts dowodzą wyłącznie struktury; numeryczne oracles
DMI CUDA, derivative/Armijo, ANI/TPI i redukcji energii wymagają osobnych
linkowanych executable targets.

Nazwy gate-ów istniejących w repozytorium są zapisywane bez prefiksu. Nazwy
oznaczone **[NOWY]** są receptami, które trzeba dopiero dodać do `justfile`; nie
są przedstawiane jako obecnie dostępne komendy.

Globalne kryterium akceptacji dokumentacji:

- każdy wymieniony path istnieje albo jest jawnie oznaczonym historycznym
  odwołaniem;
- nie ma sprzecznych statusów w `docs/physics`, capability matrix, Pythonie i
  publicznym runtime;
- round-trip nie zmienia wartości ani nie zaciera supplied/omitted;
- requested i resolved są zapisane oddzielnie w provenance;
- gate managed działa na jednym, świeżym bundlu i nie korzysta z artefaktów
  innego HEAD.

#### 3. Instrukcje problem po problemie

##### 3.1 `DOC-001` — P2, unikalny: dodatkowe `mu0` w nocie STT

**Przyczyna.** `docs/physics/0820-shared-spin-torque-family-and-stno-artifact-workflow.md:31-38`
zapisuje `-gamma mu0 m x H_eff`, a tabela na liniach `81-96` nadaje `gamma`
jednostkę zredukowanego `gamma_mu0`, `m/(A s)`. Kanoniczny kontrakt
`docs/physics/llg_conventions.md:13-22,77-82` i wykonywalny RHS
`backends/fem/cpu/mfem/integrators/llg_rhs.cpp:52-68` stosują tylko jeden
zredukowany współczynnik.

**Minimalna korekta i warstwy.** Wybrać bez alternatyw kontrakt używany przez
kod: w równaniu 0820 zastąpić `-gamma mu0` przez `-gamma_mu0`; w tabeli nazwać
symbol wyłącznie `gamma_mu0` i dopisać, że bezpośrednie momenty STT mają `1/s`
i nie podlegają ponownemu mnożeniu przez `gamma` ani `mu0`. Nie zmieniać
`backends/fem/cpu/mfem/integrators/llg_rhs.cpp`, ABI ani wartości publicznego
`LLG.gamma`, bo źródło wykonawcze jest zgodne z
`docs/physics/llg_conventions.md`.

**Bezpieczna kolejność.** Nota 0820 -> assertion dokumentacyjny w
`backends/fem/tests/interaction_docs_contract.cpp` -> testy istniejącego RHS.
Nie łączyć tej korekty z przeskalowaniem parametrów Slonczewski/Zhang-Li.

**Kompatybilność, round-trip, provenance.** Brak zmiany serializacji i liczb.
Canonical Python nadal przekazuje zredukowane `gamma_mu0`; provenance powinno
zachować istniejącą wartość i może jawnie nazwać konwencję
`reduced_gamma_mu0_h_field` bez zmiany schematu wymaganej do zamknięcia błędu.

**Testy i gate.** Dodać test wymiarowy dokumentu oraz przypadek macrospin z
jednorodnym `H_eff` i bez STT, który porównuje RHS z
`-gamma_mu0/(1+alpha^2)[m×H+alpha m×(m×H)]`. Dla direct STT sprawdzić, że
zmiana `gamma_mu0` w części pola nie skaluje ponownie dostarczonego `tau_direct`.
Uruchomić targety `fem_interaction_docs_contract` i `fem_llg_rhs_contract` w
kontenerze przez **[NOWY]** `just verify-fem-time-domain-native-contract`, a następnie
`just ensure-managed-fem-runtime` tylko jeśli zmieniono źródło wykonywalne.

**Akceptacja.** W repozytorium istnieje jedna definicja konwencji; podstawienie
jednostek daje `1/s`; żaden publiczny payload ani wynik liczbowy nie zmienia się.
Zależności: brak; `CAP-005` nadal blokuje status `validated` STT.

##### 3.2 `DOC-002` — duplikat P0: Brown sigma i retry stochastic

**Dyspozycja.** Nie tworzyć drugiej poprawki ani drugiego wpisu release-note.
Właścicielami są `FEM-TD-PHY-THERM-001` (tożsamość losowania po odrzuceniu) i
`FEM-TD-PHY-THERM-002` (nadmiarowe `1+alpha^2`).

**Wspólna granica zmiany.** Najpierw poprawić
`docs/physics/fem_thermal_brown.md:17-35,58-65,89-104`, definiując
`sigma^2 = 2 alpha k_B T/(gamma_mu0 mu0 Ms V dt)` oraz jedną standardową
zmienną normalną na zaakceptowany przedział. Potem zmienić jednocześnie CPU
`backends/fem/cpu/mfem/interactions/thermal_brown_sigma.cpp`, CPU sampler/cache
`backends/fem/cpu/mfem/interactions/thermal_brown_sampler.cpp` i CUDA
`backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.cu`; retry zmienia wyłącznie
skalę `dt^-1/2`. Testy w `backends/fem/tests/thermal_brown_contract.cpp`, które
obecnie sankcjonują dodatkowy czynnik i redraw, muszą najpierw stać się
regresją starego błędu.

**Round-trip/provenance.** Seed/policy i stochastic increment identity muszą być
osobne od amplitudy. Requested seed policy/presence, resolved seed obejmujący
pełną domenę `u64`, accepted step index i retry count mają być dostępne w
artefakcie bez publikowania całego stanu RNG. Zmiana zależy od
`CAP-007/CAP-THERM-GPU-001` dla publicznego carrier-a seeda.

**Zależność stochastic-integrator.** Sigma i same-`xi` retry mogą zamknąć status
`sampling_correct`, lecz Langevin equilibrium nie jest ważnym oraclem, dopóki
nota physics nie wybierze jawnej interpretacji sLLG (np. Stratonovich), nie
zdefiniuje jednego Wiener incrementu współdzielonego przez wszystkie stage
evaluations attemptu, retry/rescaling, kolejności normalizacji/retrakcji i
macierzy kwalifikowanych integratorów. Statusy `sampling-only`,
`stochastic-integrator-executable` i `statistically-validated` pozostają
oddzielne; niekwalifikowane RK/adaptive kombinacje są fail-closed albo jawnie
niezwalidowane.

**Gate i akceptacja.** Analityczny przypadek `alpha=1`; forced rejection
zachowuje bitowo ten sam surowy standardowy Gaussian `xi`, natomiast pole
spełnia mieszany bound względem
`sqrt(dt_old/dt_new) H_old`, z `atol` proporcjonalnym do
`epsilon_machine*sigma_retry`. Nie dzielić składowych przez wartości bliskie
zeru. Surową wariancję pola sprawdzać osobno przy stałym `dt`, bez biasu
adaptacyjnej selekcji. Dopiero po zamknięciu kontraktu sLLG równowaga używa
izotropowego makrospinu w stałym polu i
oracla `<cos(theta)>=coth(xi)-1/xi`, `xi=mu0 Ms V H/(k_B T)`, z ustalonym
burn-in, ESS, liczbą seedów i korektą wielokrotnych porównań. Jeden przedział
95% nie jest stabilnym gate-em. Zamknięcie następuje jeden raz pod ID solverów,
a `DOC-002` otrzymuje status `resolved_by` wskazujący oba ID.

##### 3.3 `DOC-005` — P2, unikalny: niebilinearny iloczyn masowy w nocie relaksacji

**Przyczyna.** `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md:214-239`
drukuje `<a,b>_M = a^T M a`. Wykonywalny helper
`backends/fem/cpu/mfem/relaxation/relaxation_math.cpp:431-460` poprawnie liczy
`sum_i w_i a_i·b_i` na węzłach magnetycznych.

**Minimalna korekta.** Zmienić ostatnie `a` na `b` i zdefiniować operator jako
`M_vec = M_L \otimes I_3`, gdzie `M_L` jest dodatnim lumped mass na aktywnych
węzłach. Metryka jest dodatnio określona wyłącznie na aktywnych magnetycznych
DOF; na pełnej przestrzeni zawierającej maskowane węzły jest półokreślona.
Oddzielnie zdefiniować normę aktywnej przestrzeni
`||a||_M^2=<a,a>_M`. Nie zmieniać helpera tylko po to, aby dostosować go do
literówki.

**Kolejność i zależności.** Nota -> assertion w
`fem_relaxation_source_contract` -> test algebraiczny helpera. Ta korekta jest
niezależna od P0 `FEM-TD-REL-001`: poprawny iloczyn bilinearny nie naprawia
brakującego `mu0 Ms` w fizycznej pochodnej energii.

**Testy.** Dla różnych wektorów sprawdzić bilinearność w obu argumentach,
symetrię, dodatnią określoność na aktywnych DOF i zero dla wektorów
M-ortogonalnych. Na pełnej maskowanej przestrzeni sprawdzić półokreśloność;
odrzucenie niedodatniej masy dotyczy tylko aktywnych DOF. Gate:
`just verify-fem-relaxation-source-contract`.

**Akceptacja.** Nota i helper definiują tę samą operację; PG-BB/NCG zachowują
ten sam publiczny payload i provenance; nie podnosić ich statusu walidacji do
czasu zamknięcia `FEM-TD-REL-001/002`.

##### 3.4 `DOC-010` — P2, unikalny: dokumentacja zabrania ujemnego `D`

**Przyczyna.** `docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md:370-400` i
`docs/physics/0470-fem-bulk-dmi-mfem-gpu.md:318-346` jednocześnie wymagają
dodatniego `D` i definiują test `D -> -D`. Publiczny Python
`packages/fullmag-py/src/fullmag/model/energy.py:126-156`, walidacja
`crates/fullmag-ir/src/validation.rs:194-226` oraz test planera
`crates/fullmag-plan/src/tests.rs:4384-4414` słusznie wymagają jedynie wartości
skończonej i zachowują znak.

**Minimalna korekta.** W obu notach zastąpić „positive” przez „finite, signed”
i zapisać, że znak wybiera chiralność. Nie wprowadzać osobnego pola chirality,
bo byłaby to niepotrzebna i potencjalnie niebijektywna zmiana API. Ujednolicić
ten sam tekst w `docs/physics/fem_dmi.md`.

**Warstwy i rollout.** Physics note -> Python/IR validation fixtures -> planner
-> native descriptor -> runtime/provenance. Nie zmieniać wartości `D`, nie brać
wartości bezwzględnej i nie odwracać znaku w adapterze UI. Control Room dla
interfacial DMI ma pole `d` w
`apps/control-room/src/shared/domain/physics/interactions.ts:260-277`; jego
walidacja musi dopuszczać liczby ujemne. Bulk DMI jest tam nadal deferred i nie
wolno promować jego edycji tylko w ramach tej poprawki.

**Round-trip/provenance.** Python -> JSON -> `EnergyTermIR`/material ->
`FemPlanIR` -> export musi zachować bitowo znak `D`. Provenance ma podać
`dmi_kind`, signed coefficient i konwencję znaku; nie może przechowywać tylko
`abs(D)`.

**Testy.** Dodać dla bulk i interfacial przypadki `+D`, `-D`, `0`, `NaN`,
`Inf`; ujemne przechodzi, nonfinite odpada. Dodać round-trip dla energy term i
material `Dind/Dbulk`. Fizyczny gate: para ściana Néela/helisa Blocha z
odwróceniem chiralii i `E(+D,m)=E(-D,m_chirality_reversed)`. Dla PBC uruchomić
ten gate dopiero po `FEM-TD-PHY-DMI-001`; zwykła nieperiodyczna ścieżka nie
zależy od tej naprawy.

**Akceptacja.** Każda publiczna powierzchnia dopuszcza skończone signed `D`,
ujemna wartość dociera niezmieniona do natywnego planu, a oba znaki przechodzą
managed nonperiodic chirality workload.

##### 3.5 `DOC-011` — P2, unikalny: błędna jednostka bulk DMI w całym metadanym kontrakcie

**Przyczyna.** Dla `w=D m·curl(m)` pochodna wnosi `1/m`, więc `D` ma `J/m^2`.
Poprawnie podaje to `docs/physics/0470-fem-bulk-dmi-mfem-gpu.md:122-132`.
Błędne `J/m^3` występuje nie tylko w
`docs/physics/0870-active-observable-and-energy-availability.md:29-36`, lecz
także w:

- `packages/fullmag-py/src/fullmag/model/structure.py:99-102` dla warningu
  `Material.Dbulk`;
- `crates/fullmag-quantities/src/id.rs:63-66` dla komentarza `MatDbulk`;
- `crates/fullmag-quantities/src/catalog.rs:870-876` dla publicznego katalogu
  `mat_Dbulk`;
- `apps/control-room/src/shared/domain/physics/interactions.ts:279-298` dla pola
  `d_bulk`.

**Minimalna korekta.** Zmienić wszędzie jednostkę współczynnika bulk DMI na
`J/m^2`; pozostawić gęstość energii `eden_dmi` jako `J/m^3`, pole `H_dmi_bulk`
jako `A/m` i energię całkowitą jako `J`. Nie przeskalowywać liczb i nie dodawać
konwersji, bo backend już interpretuje `D` w równaniu ciągłym, a defekt dotyczy
opisu/metadanych.

**Rollout.** Nota 0470/0870 -> Python docstring i warning -> canonical quantity
catalog -> API quantity metadata -> Control Room adapter. Jeśli wygenerowany
OpenAPI zawiera tylko typ `unit: string`, nie zmieniać schematu; odświeżyć
fixture/snapshot wartości zwracanej przez resource quantity catalog.

**Kompatybilność.** To semantyczna korekta etykiety bez migracji wartości.
Release note musi powiedzieć wprost: historyczne liczby `Dbulk` nie są
automatycznie mnożone przez długość; zmienia się deklarowana jednostka, nie
wartość. Eksport starego problemu ma zachować tę samą liczbę.

**Testy i gate.** Rozszerzyć testy `crates/fullmag-quantities/src/catalog.rs`
o `mat_Dbulk == J/m²`, test API o identyczną jednostkę i test UI modelu o
`J/m^2`/renderowane `J/m²`. Dodać dokumentacyjny test wymiarowy
`D[J/m²] * curl[1/m] = w[J/m³]`. Managed solver run nie jest potrzebny do
zamknięcia etykiety; istniejący DMI runtime fixture powinien jedynie potwierdzić,
że liczby nie uległy zmianie.

**Akceptacja.** `rg` nie znajduje bieżącego kontraktu `Dbulk` z `J/m^3`, poza
gęstością energii lub jawnie oznaczonym historycznym tekstem; API i UI zwracają
`J/m²`; serializowany coefficient jest numerycznie identyczny przed i po.

##### 3.6 `DOC-012` — P2, unikalny: niekompletny kontrakt ABM3 i retry stochastic

**Przyczyna.** `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md:189-204`
opisuje tylko trzy bufory ABM3, a nie równania, startup, reset i rollback.
Sekcja `135-169` definiuje czasy etapów RK, lecz nie tożsamość szumu po
odrzuceniu. Referencyjny FEM ma implementację w
`crates/fullmag-engine/src/fem.rs:2072-2133`; natywny runner jawnie odrzuca
`Abm3` w `crates/fullmag-runner/src/native_fem.rs:933-953`, mimo że wspólny
planner parsuje go w `crates/fullmag-plan/src/validate.rs:298-313`.

**Kontrakt do opublikowania.** Dla stałego `dt` zapisać dokładnie:

```text
m*      = R[m_n + dt(23 f_n - 16 f_(n-1) + 5 f_(n-2))/12]
m_(n+1) = R[m_n + dt(5 f(m*,t_(n+1)) + 8 f_n - f_(n-1))/12]
```

`R` jest nodalną retrakcją do sfery. Startup wykonuje zaakceptowane kroki
Heuna i zapisuje RHS na zaakceptowanych stanach, aż istnieją trzy próbki.
Historia obraca się wyłącznie po akceptacji; zmiana `m` z zewnątrz, operatora,
materiału, BC, aktywnych interakcji lub `dt` unieważnia całą historię. Ponieważ
powyższe współczynniki są stałokrokowe, tolerowanie zmiany `dt` do 10% w
`crates/fullmag-engine/src/fdm/cpu/state.rs:290-324` nie jest wystarczającym
kontraktem dla FEM: albo resetować przy każdej zmianie ponad wyłącznie
roundoff, albo zaimplementować jawne współczynniki variable-step. Ten plik jest
tu wyłącznie wskazaniem współdzielonego helpera historii importowanego przez
referencyjną ścieżkę FEM; nie rozszerza audytu na solver FDM.

**Lane/capability.** Nota i planner muszą powiedzieć jednoznacznie: ABM3 jest
obecnie tylko wewnętrznym Rust FEM reference, nie natywnym MFEM CPU/GPU.
Najmniejsza bezpieczna poprawka publiczna to odrzucenie `abm3` dla
`BackendTarget::Fem` w plannerze przed runtime; późniejsza promocja wymaga
osobnego ABI i managed gate.

**Stochastic retry.** W tej nocie odwołać się do jednego kontraktu z
`docs/physics/fem_thermal_brown.md`: retry zachowuje draw i skaluje amplitudę. Nie powielać
drugiej definicji. Właściwa implementacja jest liczona pod `DOC-002`.

**Round-trip/provenance.** Zachować authored `integrator="abm3"` w IR nawet,
gdy planner odrzuca lane; błąd capability nie może przepisać go na Heun.
Jeżeli kiedyś zostanie wykonany, provenance musi podać startup method,
`constant_dt=true`, reset count i historię accepted-only.

**Testy.** Polynomial ODE order-3, trzy kroki startup, reset przy zmianie `dt`,
reset po `set_magnetization`, brak rotacji po sztucznym failure i zgodność
alokacji po startup. Dodać planner test, że native FEM ABM3 odpada wcześnie z
czytelnym komunikatem, a reference-only fixture nadal działa. Gate dokumentu i
reference testy nie są dowodem native runtime; przyszła promocja wymaga
**[NOWY]** `just verify-fem-abm3-runtime` na managed bundlu.

**Akceptacja.** Niezależny implementer może odtworzyć algorytm i state machine
z noty; publiczny native FEM nie dociera do późnego ABI error; żadna retry
stochastic nie losuje nowego incrementu.

##### 3.7 `DOC-013` — P3, unikalny: ścieżki sprzed relokacji backendu

**Przyczyna.** Bieżące noty modułowe nadal używają prefiksu
`native/backends/fem/`, chociaż właścicielem jest prefiks
`backends/fem/`.
W zakresie audytu są to wszystkie następujące bieżące dokumenty i kotwice
(pominięto jawnie historyczne noty migracyjne oraz dokumenty frequency-domain):

- `docs/physics/llg_conventions.md:5-9`;
- `docs/physics/fem_anisotropy_uniaxial.md:5-6`;
- `docs/physics/fem_anisotropy_cubic.md:5-6`;
- `docs/physics/fem_dmi.md:7-15`;
- `docs/physics/fem_thermal.md:5-9`;
- `docs/physics/fem_thermal_brown.md:5-9`;
- `docs/physics/fem_stt.md:5-8`;
- `docs/physics/fem_oersted.md:5-8`;
- `docs/physics/fem_magnetoelastic.md:6-9`;
- `docs/physics/fem_demag_fem_bem.md:6,14`;
- `docs/physics/0813-native-fem-dmi-weak-residual.md:163`;
- `docs/physics/0823-native-fem-cpu-pbc-demag-reduced-warm-start.md:139`;
- `docs/physics/0825-native-fem-cpu-local-energy-cache.md:127`.

**Minimalna korekta.** Dla każdego literału rozwiązać aktualny odpowiednik i
dopiero potem zmienić prefiks. Przykłady, które istnieją w bieżącym drzewie:
`backends/fem/src/mfem_bridge.cpp`,
`backends/fem/tests/dmi_weak_residual.cpp`,
`backends/fem/cpu/mfem/interactions/*` i `backends/fem/gpu/cuda/*`. Nie robić
globalnego search/replace w dokumentach historycznych:
`docs/architecture/backend-golden-masterplan.md`, relokacyjny audit i historyczne
specy mogą poprawnie opisywać starą ścieżkę jako starą.

**Rollout.** Naprawić tylko bieżące noty S1 -> sprawdzić każdy rozwinięty
skrót `.hpp/.cpp` oraz wildcard -> dodać lint do
`scripts/check_repo_consistency.py`, który skanuje canonical-current docs i
pozwala na starą ścieżkę wyłącznie w jawnie oznaczonych sekcjach historycznych.
Nie zmieniać treści równań ani statusów w tym samym patchu.

**Kompatybilność/provenance.** Brak zmiany publicznego API i runtime. W
provenance źródeł/build manifestach nowe artefakty powinny już używać
`backends/fem`; historycznych artefaktów nie przepisywać.

**Test i akceptacja.** `python3 scripts/check_repo_consistency.py` oraz
dedykowany test path-existence przechodzą; żaden aktualny S1 module note nie
wskazuje nieistniejącego `native/backends/fem`; celowo historyczne wystąpienia
są na allowliście z uzasadnieniem. Managed runtime nie jest potrzebny.

##### 3.8 `DOC-015` — P3, unikalny: nieistniejące komendy `make fem-gpu-*`

**Przyczyna.** `docs/specs/runtime-distribution-and-managed-backends-v1.md:286-308`
reklamuje cztery komendy `make`, których bieżący repozytoryjny kontrakt nie
definiuje. G0 w `AGENTS.md:22-31` oraz `justfile` wskazują kontenerowy route
`just`.

**Minimalna korekta.** W specyfikacji zastąpić listę dokładnymi istniejącymi
wejściami i opisać ich różne role:

- `just ensure-managed-fem-runtime` (`justfile:2735-2749`) — sprawdza kompletność
  i świeżość bundla, w razie potrzeby wywołuje rebuild;
- `just rebuild-fem-runtime` (`justfile:3128-3136`) — wymuszony eksport bundla;
- `just fem-managed-headless cpu examples/fem_relax_gpu_smoke.py` albo
  `just fem-managed-headless gpu examples/fem_relax_gpu_smoke.py`
  (`justfile:3098-3123`) — run na już zarządzanym runtime;
- `just fem-gpu-headless examples/fem_relax_gpu_smoke.py`
  (`justfile:3085-3096`) — deweloperski run w kontenerze, który buduje bieżące
  źródła;
- dla relaksacji objętej tym audytem: `just verify-fem-relaxation-source-contract`,
  `just verify-fem-relaxation-runtime`, `just verify-fem-relaxation-convergence`,
  `just verify-fem-relaxation-cpu-gpu-consistency-smoke` i
  `just verify-fem-relaxation-production-benchmark`
  (`justfile:86-88,1651-1659,1984-2043`) — odpowiednio dowód source, runtime,
  zbieżności, parity i workload produkcyjny.

Nie prezentować surowego `docker compose` jako publicznego zamiennika. Może
pozostać szczegółem implementacji recepty `just`.

**Rollout i kompatybilność.** To dokumentacyjna zmiana operacyjna. Jeśli
zewnętrzne skrypty nadal używają starych komend, nie tworzyć cichych Makefile
shimów tylko po to, aby utrwalić niekanoniczny route; dodać sekcję migracji
z dokładnymi mapowaniami: `make fem-gpu-build` na
`just rebuild-fem-runtime`, `make fem-gpu-check` na
`just ensure-managed-fem-runtime`, a `make fem-gpu-test` na właściwy named
gate z powyższej listy. `make fem-gpu-shell` nie ma publicznego odpowiednika i
należy go usunąć z instrukcji, nie zastępować surowym `docker compose`.
Runtime manifest i provenance muszą zawierać hash bundla utworzonego przez
wskazaną receptę.

**Testy.** Dodać docs lint, który z każdej backticked komendy zaczynającej się
od `just` wyciąga nazwę recipe i sprawdza ją względem `just --list`; osobny
deny-list test blokuje nowe `make
fem-gpu-*` w aktualnych instrukcjach. Po zmianie komend wykonać
`just ensure-managed-fem-runtime`; nie trzeba uruchamiać wszystkich ciężkich
workloadów tylko dla edycji tekstu.

**Akceptacja.** Nowy maintainer może z dokumentu odbudować, sprawdzić i
uruchomić managed FEM bez nieistniejącej komendy; wszystkie nazwy recipe są
rozwiązywalne przez bieżący `justfile`.

##### 3.9 `DOC-017` — P3, unikalny: niejednoznaczny zakres cubic reference vs native

**Źródło niejednoznaczności.** `docs/physics/0570-fem-cubic-anisotropy-axis-validation.md:10-26`
wymienia `Kc3`, lecz równanie ma tylko `Kc1/Kc2` i dodatkowo mówi, że Rust CPU
reference używa dwóch współczynników. Pełny kontrakt natywny jest poprawnie
zapisany w `docs/physics/fem_anisotropy_cubic.md:10-39`; test
`backends/fem/tests/anisotropy_contract.cpp:434-473` jawnie sprawdza składnik
`K3 sigma^2` w energii i polu. Te dowody uzasadniają korektę dokumentacji i
podział statusu; nie uzasadniają zgłoszenia błędu native solvera.

**Minimalna korekta.** W 0570 zapisać
`e=Kc1 sigma+Kc2 m1^2m2^2m3^2+Kc3 sigma^2` i jego pochodną. Następnie oddzielić
status implementacji: natywny FEM obsługuje `K1/K2/K3`, natomiast wewnętrzny
Rust reference nie jest obecnie oracle dla `K3`, jeśli nadal go nie zawiera.
Nie wolno usuwać `Kc3` z publicznego API ani ABI, aby dopasować model do
niepełnego reference.

**Round-trip/provenance.** `Kc3=0` zachowuje wsteczną zgodność; niezerowe `Kc3`
ma przechodzić przez `MaterialIR`, pola per-node, `FemPlanIR`, ABI i provenance
bez zmiany. Dokumentacyjna korekta nie zmienia serialized value.

**Testy.** Zachować istniejący natywny K3 test; dodać K3-only (`K1=K2=0`)
energy/field directional derivative i assertion, że obie noty zawierają tę samą
formułę. Jeżeli Rust reference ma być reklamowany jako pełny cubic oracle,
najpierw dodać mu K3 i parity; w przeciwnym razie zaznaczyć ograniczenie.

**Gate i akceptacja.** `fem_anisotropy_contract` i docs consistency test
przechodzą w **[NOWY]** `just verify-fem-time-domain-native-contract`. Brak potrzeby
managed runtime, o ile nie zmieniono kodu. Status pozostaje P3 i nie blokuje
zwykłych wyników natywnych.

##### 3.10 `DOC-018` — P2, unikalny: niezdefiniowane `atol` demag i residual telemetry

**Przyczyna.** `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md:31-40,57-84,128-146,203-219`
nazywa `atol` bezwymiarowym, lecz nie definiuje wektora residualu, normy ani
skalowania. Runner przekazuje wartość bezpośrednio przez
`crates/fullmag-runner/src/native_fem.rs:989-997` i
`native/include/fullmag_fem.h:130-138`; CPU używa `SetAbsTol` w
`backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp:248-266`, a
publikowany `last_residual` pochodzi z backendowego getter-a na liniach
`331-352`. To nie dowodzi, że telemetryczna liczba jest tym samym kryterium co
publiczne `atol`.

Oficjalny hypre definiuje dla PCG kryterium z normą zależną od
preconditionera, `<C r,r>`, a getter raportuje finalny względny residual;
[dokumentacja hypre](https://hypre.readthedocs.io/en/latest/api-sol-krylov.html).
MFEM rozróżnia `GetFinalNorm()` i `GetFinalRelNorm()`;
[dokumentacja MFEM](https://docs.mfem.org/html/classmfem_1_1IterativeSolver.html).
Nie wolno więc opisać bieżącej liczby jako uniwersalnego, fizycznego residualu
bez dodatkowego pomiaru.

**Docelowy kontrakt.** Zdefiniować backend-neutralny true residual
`r=A u-b` na true DOFs i co najmniej dwie jawne liczby:

```text
residual_abs_l2 = ||r||_2                  [jednostka złożonego RHS]
residual_rel_l2 = ||r||_2 / max(||b||_2,b_floor)   [1]
```

`b_floor` musi być nazwane i zapisane w provenance. Publiczne `rtol` może
dotyczyć `residual_rel_l2`. Dla `atol` są dwie bezpieczne opcje:

1. rekomendowana: wycofać bieżące backendowe `atol` z publicznego kontraktu
   time-domain i odrzucać `Some(atol)` do czasu implementacji true-residual;
2. pełna: zmienić nazwę na `residual_abs_l2_tolerance`, nadać jej jednostkę RHS,
   liczyć residual niezależnie po solve i nie utożsamiać go z
   `Hypre*::SetAbsTol`.

Nie zmieniać po cichu znaczenia istniejącego pola. W okresie migracji zachować
`requested_backend_atol` jako deprecated provenance i dodać nowy wersjonowany
field dla kanonicznej normy.

**Rollout.** Physics note -> wersjonowany IR/API migration -> runner/ABI ->
true-residual obliczany identycznie na CPU/GPU -> telemetry schema -> UI. Ta
zmiana zależy od `FEM-TD-NUM-DEMAG-001`: solver musi failować przy
niezbieżności, a nie tylko publikować residual.

**Testy.** Residual liczyć na constrained true DOFs z jawnym traktowaniem
essential rows oraz projekcją gauge/nullspace dla Neumanna/PBC. (a) Skalowanie
`A,b` przez stałą nie zmienia `residual_rel_l2`; (b) znane małe `A,u,b` daje
ręcznie policzoną normę; (c) znany wielowymiarowy układ SPD bez skutecznego
preconditionera albo fault injection wymusza przekroczenie residualu i brak
publikacji; samo `max_iterations=1` nie gwarantuje porażki; (d) CPU/GPU
raportują tę samą definicję; (e) CG/GMRES i AMG/Jacobi nie zmieniają nazwy ani
znaczenia telemetry. Managed gate powinien rozszerzyć istniejący demag contract
i wykonać `just ensure-managed-fem-runtime` plus właściwy demag runtime
workload.

**Akceptacja.** Każde pole tolerance/residual ma nazwę normy, jednostkę i
denominator; UI nie porównuje backendowego relative getter-a z publicznym
absolute threshold; niezbieżny solve kończy się błędem przed publikacją.

##### 3.11 `DOC-019` — P1, unikalny: utrata supplied/omitted dla `dt_initial`

**Przyczyna.** Python ma prawidłowy typ `float | None` w
`packages/fullmag-py/src/fullmag/model/dynamics.py:21-33`, lecz `to_ir()` na
liniach `57-73` zamienia `None` na `dt_min`. Rust IR już ma właściwe
`Option<f64>` w `crates/fullmag-ir/src/study.rs:291-308`, ale
`crates/fullmag-runner/src/lib.rs:52-63` ponownie traktuje równość z `dt_min`
jako sentinel i wybiera `1e-13 s`.

**Minimalna korekta.** Python przy `None` nie dodaje klucza `dt_initial` lub
serializuje JSON `null`; jawna liczba, także równa `dt_min`, pozostaje `Some`.
Runner upraszcza wybór do:

```text
fixed_timestep.or_else(|| adaptive.map(|a| a.dt_initial.unwrap_or(DEFAULT)))
```

Usunąć test `resolve_initial_timestep_falls_back_when_seed_matches_dt_min` w
`crates/fullmag-runner/src/lib.rs:787-800` i zastąpić go testem, że jawna równa
wartość jest respektowana. Test missing na liniach `804-817` nadal ma wybierać
default.

**Rollout i migracja.** Physics note 0510 -> Python serializer -> `ProblemIR`
fixture -> planner -> wszystkie wywołania wspólnego resolvera -> provenance.
Stare payloady, w których Python wpisał `dt_initial==dt_min`, są
nierozróżnialne. Migracja nie może zgadywać intencji: traktować istniejącą
liczbę jako **jawnie podaną**, a brak/null jako omitted. Opisać tę jednorazową
zmianę kompatybilności w release note.

**Round-trip/UI.** Python -> IR -> canonical script musi odróżniać trzy stany:
omitted, explicit equal, explicit distinct. Control Room nie ma obecnie
odnalezionego dedykowanego autora `dt_initial`; dopóki go nie dodano, ma
zachować nieznany/istniejący klucz przy round-trip i nie twierdzić, że potrafi
go edytować. Jeśli pole UI zostanie dodane, musi mieć osobny stan „auto” zamiast
podstawiać `dt_min`.

**Provenance.** Zapisać `requested_dt_initial_s: null|value`,
`resolved_dt_initial_s: value` i `resolution_reason: default|explicit|fixed`.
Nie używać porównania float jako dowodu intencji.

**Testy i gate.** Trzy Python serialization tests, trzy Rust deserialization i
resolver tests, canonical script export/import, native plan assertion oraz
krótki managed FEM run pokazujący pierwszy zaakceptowany/proponowany `dt` dla
każdego stanu. Ponieważ resolver jest współdzielony, dodać regresję innych
callerów bez wykonywania audytu FDM; zmiana nie może przypadkiem zmienić ich
jawnego `dt_initial`.

**Akceptacja.** Omitted wybiera default, explicit equal wybiera dokładnie
`dt_min`, explicit distinct wybiera podaną liczbę; oba pola requested/resolved
są widoczne i round-trip zachowuje stan.

##### 3.12 `DOC-020` — duplikat P0: czas etapu RK dla Oersted

**Dyspozycja.** Jedynym właścicielem skonsolidowanego błędu jest
`FEM-TD-NUM-RK-001`. `DOC-020` opisuje konflikt z notą i nie stanowi osobnego
defektu.

**Wspólna naprawa.** Nota
`docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md:135-169`
pozostaje źródłem `t_n+c_j dt`. Implementacja musi dodać jawny
`evaluation_time` od `rk_tableau` przez CPU
`backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp:21-59` i GPU
`backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.cu:40-62` do każdej
nieautonomicznej interakcji. Finalne `H_oe/H_eff` należy policzyć dla kandydata
`t_n+dt` przed atomowym commit-em czasu/stanu; nie wolno chwilowo modyfikować
`ctx.state.current_time` wewnątrz etapów.

**Zależności i provenance.** Ten sam carrier czasu jest potrzebny późniejszej
pełnej realizacji `CAP-006` antenna waveform. Provenance/snapshot musi wiązać
field timestamp z accepted state timestamp. Sama nieautonomiczność nie wyłącza
FSAL: reuse jest legalny, gdy ostatni etap jest dokładnie
`f(t_n+dt,y_{n+1})` i pełny stan źródeł jest identyczny z pierwszym etapem
następnego kroku. Cache unieważnia nowe źródło stochastic, nieciągłość impulsu
albo niezgodny stan po retry; na krawędzi impulsu trzeba zamrozić lewo- albo
prawostronną konwencję.

**Gate i akceptacja.** Stage-time spy dla Heun/RK4/RK23/RK45, sinus i pulse
edge, final-field freshness, rollback oraz managed CPU/GPU trajectory parity.
Zamknąć raz pod `FEM-TD-NUM-RK-001`; `DOC-020` oznaczyć `resolved_by`.

##### 3.13 `CAP-002` — P2, unikalny: magnetoelastic miesza stan bieżący i roadmapę

**Przyczyna.** `docs/physics/0720-fem-magnetoelastic-small-strain-mfem-gpu.md:122-128`
używa strzałki `internal-reference -> public-executable`, której nie da się
odczytać jako jednego stanu. Jednocześnie checklist na liniach `143-162` jest
otwarty. Bieżący właściciel modułu
`docs/physics/fem_magnetoelastic.md:59-103` i planner
`crates/fullmag-plan/src/fem.rs:462-518` mówią jednoznacznie: wykonywalne jest
tylko prescribed strain; quasistatic i elastodynamics są jawnie odrzucane.

**Minimalna korekta statusu.** Zastąpić szeroki wiersz trzema niezależnymi
feature ID i osobnymi lane/status/validation:

| Feature ID | FEM CPU | FEM GPU | Walidacja |
|---|---|---|---|
| `magnetoelastic_prescribed_strain` | `production_executable` po potwierdzeniu aktualnej reachability | `production_executable` tylko jeśli strict-GPU carrier i managed smoke przechodzą; inaczej jawnie niżej | osobne named workloads, brak blanket validated |
| `magnetoelastic_quasistatic` | `semantic_only` | `semantic_only` | planner rejection |
| `magnetoelastic_elastodynamic` | `semantic_only` | `semantic_only` | planner rejection |

Kolumnę „target milestone” trzymać oddzielnie od „current status”; nie używać
strzałki w polu bieżącego stanu. W `docs/specs/capability-matrix-v0.md` szeroki
wiersz `Magnetoelastic` należy zastąpić tym samym podziałem. Jeśli odpowiadający
payload API/UI ma tylko jeden boolean, nie mapować go na trzy tryby; rozszerzyć
payload lub pozostawić UI w stanie deferred. Obecny tekst Control Room w
`apps/control-room/src/shared/domain/physics/interactions.ts:460-500` słusznie
nie obiecuje pełnego authoringu i powinien zachować tę ostrożność.

**Round-trip/provenance.** `MechanicsIR::PrescribedStrain`,
`QuasistaticElasticity` i `Elastodynamics` muszą round-tripować jako trzy różne
intencje nawet wtedy, gdy dwie są odrzucane. Provenance dla wykonanego przypadku
ma podawać `requested_mechanics_mode=prescribed_strain`, resolved carrier
`native_nodal_prescribed_strain`, lane i brak mechanical solve. Nie wolno
opisywać prescribed field jako quasistatic elasticity.

**Testy.** Zachować/rozszerzyć planner tests
`crates/fullmag-plan/src/tests.rs:2078-2182`: prescribed planuje, quasistatic i
elastodynamic odrzucają. Dodać machine-doc consistency test jednego current
statusu na mode/lane. Dla GPU wykonać pole/energia i CPU/GPU parity przed
ustawieniem executable. Managed gate może być częścią **[NOWY]**
`just verify-fem-time-domain-local-interactions-runtime`.

**Akceptacja.** Dla każdej z trzech intencji istnieje dokładnie jeden bieżący
status; żaden rejected mechanics solver nie jest reklamowany jako wykonujący
się; prescribed-strain artifact nie sugeruje rozwiązania równania sprężystości.

##### 3.14 `CAP-003` — P2, unikalny: sprzeczny status TPI

**Przyczyna.** `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md:25-52`
i `docs/specs/capability-matrix-v0.md:148-157` nazywają CPU TPI
production-executable, lecz `0510:330-339` nazywa go under development.
Python dodatkowo mówi „not yet executable” w
`packages/fullmag-py/src/fullmag/model/study.py:526-528`, chociaż planner i
runner dopuszczają CPU w `crates/fullmag-plan/src/validate.rs:361-372` oraz
`crates/fullmag-runner/src/fem/relax/algorithm.rs:111-137`. GPU auto fallback
ma jawny reason w `crates/fullmag-runner/src/dispatch.rs:858-873,8986-9013`.

**Jednoznaczna decyzja bieżąca.** Do czasu zamknięcia
`FEM-TD-NUM-TPI-001` i `FEM-TD-PHY-ANI-002` przyjąć:

- CPU/MFEM: `development_executable`, nie production-qualified i nie validated;
- forced GPU: unsupported;
- auto GPU w trybie pozwalającym na development: fallback do CPU z
  `fem_gpu_relaxation_algorithm_cpu_only`;
- strict production mode: odrzucenie TPI przed runtime.

Jeżeli capability vocabulary nie zna `development_executable`, dodać ten stan
raz do wspólnego słownika zamiast wciskać TPI w fałszywe `semantic_only` lub
`production_executable`. Alternatywnie rozdzielić trzy osie:
`implemented=true`, `execution_scope=development`, `validated=false`; wszystkie
powierzchnie muszą korzystać z tych samych pól.

**Rollout.** Physics note 0510 -> capability matrix -> Python docstring ->
planner legality względem `ValidationProfileIR.execution_mode` -> runner
fallback -> provenance/API/UI. Nie zmieniać identyfikatora algorytmu.

**Round-trip/provenance.** Authored `tangent_plane_implicit` pozostaje w IR.
Przy fallback zapisać requested algorithm, requested GPU, resolved CPU,
fallback reason i `energy_minimizer_realization=native_mfem_backend_relax_step`.
Przy strict rejection nie tworzyć pozornego executed artifact.

**Testy i managed gate.** Cztery przypadki: explicit CPU+extended wykonuje;
CPU+strict odrzuca; forced GPU odrzuca; auto GPU+extended fallbackuje i zachowuje
provenance. Istniejący `just verify-fem-relaxation-runtime` sprawdza krótki CPU
TPI smoke, ale nie kwalifikuje fizyki. Promocja do production wymaga po
naprawach solvera convergence/energy directional derivative i osobnego workloadu
w `just verify-fem-relaxation-convergence`.

**Akceptacja.** Python, physics note, capability matrix, planner, runtime i UI
odpowiadają identycznie na pytanie „czy CPU TPI jest produkcyjny?”: nie, jest
development-executable. Nie ma cichego GPU execution ani ukrytego fallbacku.

##### 3.15 `CAP-004` — P2, unikalny: trzy statusy Fredkin–Koehler

**Przyczyna.** `docs/physics/0540-fem-demag-multi-model-architecture.md:40-47`
mówi „only airbox”, linie `220-246` opisują zaimplementowaną ścieżkę dense
reference, a `261-265` ponownie odkłada implementację Fredkin–Koehler. Kod
faktycznie rozpoznaje model: `packages/fullmag-py/src/fullmag/model/energy.py:49-123`,
`crates/fullmag-ir/src/plan.rs:390-500`, planner
`crates/fullmag-plan/src/fem.rs:2125-2160` i runner test
`crates/fullmag-runner/src/native_fem.rs:3999-4025`. Operator jawnie deklaruje
`O(N_b^2)` i mode `dense_reference` w
`backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.hpp:18-46`.

**Minimalna korekta statusu.** Przepisać notę na trzy osobne byty:

1. `fredkin_koehler_dense_reference`: CPU, body-only, executable wyłącznie na
   validation/development scale, nie production-scale;
2. `fredkin_koehler_scalable`: niezaimplementowany docelowy operator H2/FMM-like;
3. `bem` jako odrębny przyszły model, nie alias current dense FK.

Usunąć zdanie „only airbox”; odroczony punkt nazwać
`scalable Fredkin–Koehler implementation`, nie ogólnym Fredkin–Koehler.

**Granica bezpieczeństwa.** Dodać jawny, udokumentowany cap liczby boundary
DOFs/nodes przed alokacją macierzy dense. Wartość cap musi wynikać z benchmarku
pamięci/czasu i być zapisana w capability/provenance; nie zgadywać jej w kodzie.
Przekroczenie ma failować z komunikatem proponującym airbox, a nie próbować
alokacji produkcyjnej.

**Round-trip/provenance.** Publiczne `Demag(model="fredkin_koehler")` pozostaje
kompatybilne. Przez co najmniej jedną wersję zachować istniejące
`resolved_demag_realization="fem_fredkin_koehler"`, ale dodać
`demag_operator_realization="dense_reference"`, complexity `O(Nb^2)` i
boundary count. Nowe artifacty nie mogą nazywać tego scalable production.

**Zależności.** Przed jakąkolwiek promocją zamknąć
`FEM-TD-NUM-DEMAG-002` (pełność/domknięcie/orientacja powierzchni) i
`FEM-TD-NUM-DEMAG-001` (fail on nonconvergence). Brak GPU parity nie może być
ukryty pod ogólnym FEM status.

**Testy.** Planner body-only bez airbox; exact resolved realization; provenance
dense_reference; cap-1 przechodzi, cap+1 failuje; analityczna kula/ellipsoida;
porównanie z rosnącym airbox; surface invalid cases. Gate managed musi być
osobnym CPU workloadem, np. **[NOWY]**
`just verify-fem-demag-fredkin-koehler-dense-reference-runtime`.

**Akceptacja.** Każdy dokument i payload rozróżnia current dense reference od
future scalable; duża siatka failuje przed alokacją; validated zostaje puste do
czasu świeżego analitycznego i cross-model artefaktu.

##### 3.16 `CAP-005` — P2, unikalny: STT/Oersted nie mają named validated workloads

**Przyczyna.** Machine matrix
`docs/specs/capability-matrix-v0.json:17-39,78-147,183-192` prawidłowo odróżnia
`production_executable`, ale wszystkie odpowiednie `validated_workloads` są
puste. Noty
`docs/physics/0820-shared-spin-torque-family-and-stno-artifact-workflow.md:276-304`
i
`docs/physics/0850-native-fem-stt-and-generalized-oersted-from-prescribed-current.md:253-289`
wymieniają plan testów, jednak nie wskazują
świeżych lane-specific artifactów. W repo istnieją tylko lokalne kontrakty
`backends/fem/tests/stt_contract.cpp` i
`backends/fem/tests/oersted_contract.cpp`; `justfile` nie
ma obecnie dedykowanego managed STT/Oersted runtime gate.

**Minimalna korekta.** Nie obniżać osiągalnej ścieżki tylko z powodu braku
walidacji i nie promować jej na podstawie source test. Utworzyć rejestr
workloadów z proponowanymi, stabilnymi ID:

| ID [NOWY] | Zakres i oracle | Minimalny warunek |
|---|---|---|
| `fem_td_slonczewski_macrospin_v1` | równoległe `m||p` daje zero; prąd skaluje liniowo | signed torque względem wzoru, finite, zero w alignment |
| `fem_td_slonczewski_gilbert_equivalence_v1` | direct RHS vs równoważne pole dla nonzero alpha | mieszany CPU/analityka bound, początkowo `rtol<=1e-12`, z wymiarowym `atol` |
| `fem_td_zhang_li_skew_tet_affine_v1` | analityczny gradient pola afinicznego na skośnym tetra | CPU/analityka początkowo `rtol<=1e-12`, GPU/CPU `rtol<=1e-10`, oba mixed po naprawie `FEM-TD-PHY-STT-001` |
| `fem_td_zhang_li_wall_sign_v1` | 1D wall, znak prędkości i skalowanie current | właściwy znak; convergence względem h/dt |
| `fem_td_oersted_cylinder_profile_v1` | Ampere inside/outside i right-hand rule | mixed CPU/analityka początkowo `rtol<=1e-12`, GPU/CPU `rtol<=1e-10`, wymiarowy `atol` |
| `fem_td_oersted_midpoint_wire_v1` | udokumentowana suma midpoint Biot-Savart | błąd względem niezależnej sumy w ustalonej tolerancji dyskretyzacji |
| `fem_td_stt_oersted_cpu_gpu_trajectory_v1` | krótka deterministyczna trajektoria bez demag ambiguity | identyczny input, double, signed observables i jawna tolerancja per-step |

Wartości tolerancji dla wall/trajectory oraz końcowej trajektorii CPU/GPU trzeba
ustalić przed pierwszą promocją na podstawie convergence study po `dt` i
rozdzielczości i zamrozić w workload manifest. Nie wolno użyć stałego progu
nodewise po dziesięciu krokach ani dopasować tolerancji po jednej regresji.

**Rollout.** Najpierw zamknąć `FEM-TD-PHY-STT-001`, `FEM-TD-NUM-RK-001` i
`FEM-TD-OBS-003`, bo inaczej odpowiednie workloady mają z definicji błędny
oracle/readback. Następnie dodać przykłady wejściowe, niezależne walidatory,
manifest workloadów i **[NOWY]**
`just verify-fem-time-domain-stt-oersted-runtime`, który zaczyna od
`just ensure-managed-fem-runtime` i uruchamia CPU/GPU na tym samym bundlu.

**Artefakty/provenance.** Każdy wynik ma zawierać workload ID/version, input
hash, HEAD, runtime manifest hash, requested/resolved device/engine/precision,
fallback, integrator, dt, mesh hash, material parameters, tolerancje i wynik
oracle. CPU i GPU dostają oddzielne wpisy `validated_workloads`; brak GPU
artefaktu nie może odziedziczyć statusu CPU.

**Testy metakontraktu.** JSON schema odrzuca nieznany workload ID, duplikat i
artifact bez lane/hash/tolerance. Docs test wymaga, aby każde
`validated_workloads` wskazywało istniejący manifest, a manifest na świeży
artefakt. Source contracts nadal działają jako warunek wstępny, nie dowód
fizyczny.

**Akceptacja.** Każdy niepusty workload w capability matrix ma przechodzący,
świeży managed artifact dla dokładnie tej lane; `production_executable` i
`validated` pozostają odrębnymi polami. Priorytet pozostaje P2.

##### 3.17 `CAP-006` — P0, unikalny: antenna Zeeman mask znika przed natywnym FEM

**Przyczyna.** Publiczny carrier istnieje do `FemPlanIR`:

- Python `AntennaFieldSource` w
  `packages/fullmag-py/src/fullmag/model/antenna.py:150-224`;
- `CurrentModuleIR` w `crates/fullmag-ir/src/study.rs:88-110`;
- resolved pole `field_xyz` w `crates/fullmag-ir/src/plan.rs:57-70`;
- materializacja maski w
  `crates/fullmag-plan/src/antenna_zeeman.rs:21-120` i zapis planu w
  `crates/fullmag-plan/src/fem.rs:2193-2217`.

Potem carrier znika: `native/include/fullmag_fem.h:167-285` nie ma antenna
payloadu, `crates/fullmag-runner/src/native_fem.rs:927-1320` przekazuje Zeeman,
STT, Oersted, thermal i magnetoelastic, ale nie maskę. Mimo to availability
`crates/fullmag-runner/src/quantities.rs:155-165` wystawia `H_ant`, a dispatch
`crates/fullmag-runner/src/dispatch.rs:939-963` fallbackuje każdą antenę na CPU,
który również nie ma carrier-a.

**Faza 0 — natychmiastowa bezpieczna poprawka.** Przed jakimkolwiek runtime
odrzucać FEM, gdy `antenna_zeeman_masks` nie jest puste, z komunikatem
`prescribed_zeeman_mask is planned but not executable on native FEM: missing native carrier`.
Pierwsza granica to planner FEM po materializacji maski, przed zwróceniem
`BackendPlanIR`. Druga, niezależna defense-in-depth granica musi działać w
runnerze przed zbudowaniem native descriptor i odrzucać każdy bezpośrednio
skonstruowany/prebuilt `FemPlanIR` z niepustym `antenna_zeeman_masks`. Usunąć
lub zawęzić fallback `has_any_antenna_field_source`: nie może przedstawiać CPU
jako rozwiązania dla `PrescribedZeemanMask`. `H_ant` dla konkretnego
odrzuconego planu nie może być advertised/materialized; native plan
availability pozostaje `false`. Globalny katalog quantity może pozostać, bo
inne lane używają tego ID.

**Faza 1 — pełna realizacja CPU.** Po zamknięciu `ABI-001` dodać wersjonowany
carrier do C ABI: liczba źródeł, spłaszczony bazowy `field_xyz` w `A/m`,
waveform kind/parametry i ownership/lifetime. Dedykowany moduł antenna Zeeman
ma przechowywać przestrzenny profil, obliczać skalę dla jawnego
`evaluation_time`, dodawać `H_ant` do `H_eff`, udostępniać readback i liczyć
`E_ant=-mu0 integral Ms m·H_ant dV`. Nie wkładać tej fizyki do
`backends/fem/src/mfem_bridge.cpp`, `Context` jako płaskich pól ani magazynu
Oersted.

**Faza 2 — GPU.** Dopiero po CPU managed acceptance dodać rezydentny buffer
lokalnego pola, device waveform evaluation i osobny readback cadence. Usunąć
CPU fallback dla wspieranego prescribed mask; forced GPU failuje, dopóki pełna
ścieżka nie istnieje.

**Round-trip/provenance.** Zachować źródło, obiekt, `amplitude_B_T`, kierunek,
spatial profile i waveform. Runtime ma dodatkowo zapisać sampled location
`fem_node_lumped`, resolved field unit `A/m`, realization
`prescribed_zeeman_mask_native_cpu|gpu`, requested/resolved lane i fallback.
Nie utożsamiać `H_ant` z current-generated `H_Oe`.

**Zależności.** ABI extension zależy od `ABI-001`; waveform zależy od jawnego
czasu etapu `FEM-TD-NUM-RK-001`; per-element/nodal materiałowe wagi muszą być
spójne z `FEM-TD-PHY-MAT-001` dla energii.

**Testy.** Faza 0 wymaga testu planera oraz osobnego runner testu z ręcznie
zbudowanym/prebuilt `FemPlanIR`, który musi zostać odrzucony przed native
descriptor. Pełna realizacja: planner-to-ABI nonzero payload; maska uniform i zero/outside;
analityczne `H_ant` i `E_ant`; sinus/pulse na wszystkich `c_j`; różnica
`H_eff(with)-H_eff(without)=H_ant`; one-step trajectory; output availability;
rollback. Managed CPU gate przed GPU, potem double CPU/GPU parity. Proponowany
**[NOWY]** `just verify-fem-time-domain-antenna-zeeman-runtime` musi zapisać
field, energy, timestamps i runtime identity.

**Akceptacja Fazy 0.** Żaden zaakceptowany FEM plan nie może zawierać maski,
której backend nie użyje; fallback nie omija rejection; `H_ant` nie jest
fałszywie dostępne. **Akceptacja pełna.** Nonzero mask dociera do ABI, zmienia
`H_eff` i trajektorię `m`, daje poprawne readback/energy i przechodzi managed CPU, a GPU status
zmienia się dopiero po parity.

##### 3.18 `CAP-007` — duplikat P2: strict-GPU thermal bez publicznego seeda

**Dyspozycja.** Ten sam defekt jest zapisany w solver register jako
`CAP-THERM-GPU-001`; liczyć i zamykać raz.

**Pełna przyczyna publicznego kontraktu.** Python ma `ThermalNoise.seed` w
`packages/fullmag-py/src/fullmag/model/energy.py:497-525`, ale kanoniczny Rust
`ProblemIR` przechowuje tylko top-level `temperature` w
`crates/fullmag-ir/src/lib.rs:141-143`; `EnergyTermIR` na
`crates/fullmag-ir/src/study.rs:206-266` nie ma wariantu `ThermalNoise`.
Planowy `ThermalSeedConfig` istnieje w
`crates/fullmag-ir/src/study.rs:433-465`, lecz planner zawsze wpisuje `None` w
`crates/fullmag-plan/src/fem.rs:2254-2263`. Runner zamienia to na zero
`crates/fullmag-runner/src/native_fem.rs:1316-1320`, a strict GPU słusznie
odrzuca zero w `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp:122-124` i
`backends/fem/gpu/cuda/integrators/rk/rk_thermal_field.cu:49-52`, mimo że
`crates/fullmag-runner/src/capabilities.rs:245-257` reklamuje `thermal`.

**Docelowy model IR.** Thermal noise nie jest energią konserwatywną. Dodać
kanoniczny top-level/dynamics stochastic config zawierający temperature i
`ThermalSeedConfig`, a legacy Python `ThermalNoise` migrować do tego
kontraktu. Stary JSON `energy_terms[{kind:"thermal_noise"}]` musi mieć migrator,
który wyciąga temperature/seed i usuwa pseudo-energy term; konflikt z top-level
temperature/seed ma być jawnie odrzucony. Publiczny Python przyjmuje wyłącznie
`0 <= seed <= 2^64-1`, odrzucając wartości ujemne, overflow i `bool`.
`seed=None` mapuje requested policy `system_entropy`; każda wartość `u64`,
włącznie z zerem, mapuje `fixed`.

**Rozwiązanie entropy i ABI.** Planner/runtime przed native create używa
wstrzykiwalnego resolvera entropy i rozwiązuje politykę dokładnie raz do
dowolnego `u64`, również zera. Żądana polityka pozostaje `system_entropy`, a
resolved seed trafia do provenance/checkpoint. Po `ABI-001` wersjonowany
descriptor przenosi osobno policy/presence i wartość; GPU sprawdza obecność, a
nie `seed != 0`. Stary ABI może zachować `0=entropy` wyłącznie w legacy shimie;
`fixed 0` musi failować przed native create do czasu nowego symbolu, nie zostać
reinterpretowane.

**Fail-closed wariant przejściowy.** Dopóki carrier nie istnieje, usunąć
`thermal` z `FemNativeGpu.supported_terms` i odrzucać w capability/plannerze,
nie dopiero wewnątrz RK. CPU status należy opisać osobno; nie dziedziczy GPU
reachability.

**Round-trip/provenance/checkpoint.** Python i UI muszą odróżnić fixed seed,
entropy i brak termiki. Canonical script export zachowuje fixed value lub
`seed=None`; run artifact zapisuje requested policy i resolved seed. Restart z
checkpointu używa zapisanego resolved seed i accepted-step/RNG position, nie
losuje nowego.

**Testy.** Legacy migration; conflict validation; fixed/entropy round-trip;
macierz `None`, `0`, `1`, `2^64-1`, `-1`, `2^64`, `True`; planner
`Some(ThermalSeedConfig)`; wersjonowane ABI policy/presence/value. Test
resolvera wstrzykuje kolejno zero i znany seed nonzero, wymaga dokładnie jednego
wywołania, zachowania wartości przez retry i zapisu do provenance/checkpoint.
Nie testować probabilistycznie, że dwa wywołania system entropy dają różne
liczby. Dwa runy z tym samym zmaterializowanym seedem są identyczne; managed
test sprawdza presence/value i deterministyczny replay. Strict GPU
capability-to-runtime reachability oraz checkpoint replay pozostają
obowiązkowe. Managed gate jest częścią skonsolidowanej naprawy termiki i wymaga
świeżego bundla.

**Akceptacja.** Publiczny fixed seed, również zero, dociera bez zmiany przez
wersjonowane ABI; entropy jest rozwiązane raz i reprodukowalne z artefaktu;
capability mówi prawdę; GPU odrzuca brak policy/presence, nie wartość zero;
`CAP-007` wskazuje `resolved_by=CAP-THERM-GPU-001`.

#### 4. Macierz kolejności napraw

| Faza | ID | Powód kolejności | Warunek wyjścia |
|---|---|---|---|
| A0 — natychmiast fail-closed | `CAP-006` | obecnie zaakceptowany drive może zniknąć | planner rejection i brak fałszywego `H_ant` |
| A1 — wspólne P0 solver/docs | `DOC-002`, `DOC-020`, `CAP-007` | dokumentacja musi poprzedzić zmianę kodu i carrier-a | skonsolidowane solver IDs zamknięte raz |
| B — semantyka publiczna | `DOC-019`, `DOC-018` | supplied/omitted i residual contract wpływają na reprodukowalność | round-trip + requested/resolved + managed proof |
| C — jednostki i równania dokumentów | `DOC-001`, `DOC-005`, `DOC-010`, `DOC-011`, `DOC-012` | usuwają błędne oracle i metadane | docs/source/API consistency gates |
| D — capability truth | `CAP-002`, `CAP-003`, `CAP-004`, `CAP-005` | nie promować lane przed naprawą zależnych solver bugs | jednoznaczne stany i named artifacts |
| E — higiena | `DOC-013`, `DOC-015`, `DOC-017` | niskie ryzyko, lecz potrzebne do wiarygodnego handoffu | path/command/formula lint |
| F — pełna antenna realization | `CAP-006` Faza 1/2 | wymaga ABI, stage-time i material weighting | managed CPU, następnie GPU parity |

#### 5. Minimalny pakiet końcowej weryfikacji

Po wdrożeniu wszystkich napraw z tego przewodnika należy wykonać, na jednym
zamrożonym HEAD i jednym managed runtime bundle:

1. dokumentacyjny path/command/equation consistency lint;
2. Python public API tests dla DMI units/sign, thermal seed i `dt_initial`;
3. Rust IR migration/round-trip/planner/capability tests;
4. natywne targety `fem_interaction_docs_contract`,
   `fem_llg_rhs_contract`, `fem_anisotropy_contract`,
   `fem_dmi_weak_residual`, `fem_stt_contract`, `fem_oersted_contract`,
   `fem_demag_fem_bem_contract` i `fem_relaxation_source_contract` przez
   kontenerową receptę `just`;
5. `just ensure-managed-fem-runtime`;
6. istniejące `just verify-fem-relaxation-runtime` i
   `just verify-fem-relaxation-convergence` po zamknięciu ich blockerów;
7. nowe managed workload gates wymienione w sekcjach CAP-005, CAP-006 i dla
   seeded thermal;
8. automatyczną kontrolę, że każde `validated_workloads` wskazuje świeży
   artifact dokładnie tej lane i bundla.

Raport końcowy może oznaczyć problem jako rozwiązany wyłącznie wtedy, gdy jego
lokalne kryterium akceptacji oraz wszystkie zależności z tej macierzy są
spełnione. Zmiana tekstu bez odpowiedniego testu, albo passing source test bez
managed runtime dla twierdzenia wykonawczego, nie zamyka ustalenia.

## 12. Kolejność napraw

### Faza A — zatrzymać błędne zwykłe wyniki

1. Zhang-Li inverse-row i wspólny skew-tetra oracle CPU/CUDA.
2. Thermal note jako źródło prawdy, usunięcie dodatkowego `1+alpha^2`, cache
   draw na retry CPU i publiczny seed policy dla GPU.
3. Jawny czas etapu RK i oddzielny skalowany bufor `H_Oe`.
4. Joule-valued discrete gradient `-mu0 Ms H` i macierz legalności relaksacji.
5. Spójne elementowe materiały albo jawne odrzucenie niewspieranych członów.
6. Carrier antenna mask albo bezpieczne odrzucenie przed runtime.
7. Atomowa finalizacja hybrid Robin.

### Faza B — integralność solvera i obserwabli

1. Gate zbieżności każdej ścieżki demag.
2. Pełność/domknięcie/orientacja powierzchni FEM/BEM.
3. Class-summed periodic DMI na CPU i GPU.
4. Volume-weighted `m_avg`, rozdzielone field/direct/total torque, świeże
   `phi/H_demag/H_Oe`.
5. Walidacja PMA axis i niepoprawnych stanów RK.

### Faza C — kwalifikacja

1. directional-derivative matrix dla każdej interakcji konserwatywnej;
2. zbieżność po siatce i CPU/GPU parity na identycznej siatce;
3. equilibrium/dt-invariance dla stochastic LLG;
4. oficjalny signed nonlinear LLG workload;
5. named workloads w capability matrix dopiero po rzeczywistym PASS;
6. osobna kwalifikacja TPI przed zmianą statusu development.

## 13. Ograniczenia i zasady interpretacji

- Audyt nie zmienia kodu solvera ani kanonicznych not fizycznych.
- P0/P1 są oparte na statycznie dowiedzionym przepływie lub algebrze; tam,
  gdzie brakuje pomiaru wielkości skutku, raport mówi to jawnie.
- Stare raporty i aktywne plany są tropem, nie dowodem aktualnego runtime.
- CPU i GPU pozostają osobnymi lane-ami kwalifikacji.
- Obecność kodu CUDA nie dowodzi publicznej osiągalności strict GPU.
- `production_executable` nie oznacza `physics_validated`.
- Końcowa tabela pokrycia jest dowodem kompletności plikowej; niniejszy raport
  niesie rozumowanie fizyczne i numeryczne.

## 14. Kryteria zamknięcia przyszłej naprawy

Naprawa nie jest zakończona, dopóki:

- każdy P0/P1 nie ma testu odtwarzającego wcześniejszy błąd;
- fizyka note→Python→ProblemIR→planner→ABI→CPU/GPU→observable jest spójna;
- strict device nie degraduje się bez jawnego requested/resolved provenance;
- wszystkie wspierane RK i algorytmy relaksacji przechodzą właściwe dla siebie
  macierze interakcji;
- tolerancje pochodzą z analityki, zbieżności lub zaakceptowanego benchmarku;
- zarządzany runtime i artefakty publikują dokładnie stan, który wykonał
  obliczenie.

## 15. Prompt dla sesji naprawiającej problemy jeden po drugim

Poniższy prompt jest przeznaczony do wklejenia w nowej sesji uruchomionej w
katalogu głównym repozytorium. Opcjonalnie na końcu można dopisać
`START_ID=<KANONICZNE_ID>`. Dozwolone są wyłącznie końcowe, skonsolidowane ID z
rejestru ustaleń i mapy w sekcji 2.4. Bez tego sesja wybiera pierwszy
niezamknięty problem z kolejki 42 unikalnych problemów, zgodnie z zależnościami
z sekcji 11 i kolejnością z sekcji 12.

```text
Pracujesz w repozytorium /home/kkingstoun/git/fullmag/fullmag.

Cel: naprawiać problemy ze standardowego nieliniowego solvera FEM LLG,
statyki i relaksacji dokładnie jeden problem naraz, aż wszystkie 42 unikalne
problemy z audytu zostaną faktycznie zamknięte dowodem. Nie ograniczaj się do
planu ani opisu: dla wybranego ID wykonaj implementację, testy, dokumentację,
managed runtime, jeśli wymaga go rekord lub zmieniono kod wykonywalny, oraz
review. Dopiero po pełnym zamknięciu jednego ID przejdź do następnego.

Zakres bezwzględny:
- tylko standardowy FEM time-domain, statyka, relaksacja i używane interakcje;
- pomiń cały FDM;
- pomiń frequency-domain, modal, eigen, driven-response i Floquet;
- time-domain antenna/Oersted pozostają w zakresie;
- nie zmieniaj niczego poza aktualnie wybranym problemem i jego koniecznymi
  warstwami kontraktu;
- zachowaj wszystkie obce zmiany w brudnym worktree.

Najpierw przeczytaj w całości:
1. AGENTS.md;
2. docs/validation/2026-07-09-backend-llg-scientific-audit.md;
3. dla mianowników i ścieżek:
   docs/validation/2026-07-09-backend-llg-audit-coverage.md;
4. mapę kanonicznych i źródłowych ID w sekcji 2.4, a następnie sekcję 11 dla
   wybranego problemu, jego aliasów, zależności i kryteriów akceptacji;
5. właściwą notę docs/physics oraz wszystkie pliki implementacji, callerów i
   testów wskazane przez ten rekord;
6. docs/architecture/backend-golden-masterplan.md i odpowiednie skills:
   using-superpowers, brainstorming, physics-publication,
   backend-golden-masterplan, fem-native-backend-architecture,
   systematic-debugging, test-driven-development,
   subagent-driven-development, requesting-code-review oraz
   verification-before-completion. Jeśli zmiana dotyka ProblemIR/publicznego
   API/capability, załaduj też problem-ir-design, python-api-class i
   capability-matrix-check odpowiednio do zakresu.

Tożsamość problemów i aliasy:
- `CAP-ANT-001` = contracts `CAP-006`;
- `CAP-FEM-001` = solver `CAP-001`;
- `CAP-FEM-002` = solver `CAP-002`;
- `CAP-THERM-GPU-001` = solver `CAP-THERM-GPU-001` + contracts `CAP-007`;
- `CAP-VALID-001` = contracts `CAP-005`;
- `CAP-DOC-MEL-001` = contracts `CAP-002`;
- `CAP-DOC-TPI-001` = contracts `CAP-003`;
- `CAP-DOC-DEMAG-001` = contracts `CAP-004`;
- contracts `DOC-002` jest wspólnym aliasem dowodowym dla
  `FEM-TD-PHY-THERM-001` i `FEM-TD-PHY-THERM-002`;
- contracts `DOC-020` jest aliasem dowodowym `FEM-TD-NUM-RK-001`;
- contracts `CAP-007` jest aliasem dowodowym `CAP-THERM-GPU-001`.

Nigdy nie dodawaj `DOC-002`, `DOC-020` ani `CAP-007` do niezależnej kolejki i
nie licz ich jako osobnych zamknięć. `DOC-002` jest zamknięte dopiero po
zamknięciu obu kanonicznych problemów thermal. Jeżeli użytkownik poda samo
źródłowe `CAP-002`, zatrzymaj się i zażądaj kanonicznego `CAP-FEM-002` albo
`CAP-DOC-MEL-001`; nie wybieraj znaczenia po cichu. Pozostałe, nieprzemianowane
ID solverowe i `DOC-*` są już kanoniczne.

Tryb pracy: Subagent-Driven.
- Główny agent koordynuje i pilnuje zakresu.
- Dla każdego ID użyj świeżego subagenta implementującego.
- Po implementacji uruchom świeżego reviewera zgodności ze specyfikacją.
- Po poprawkach uruchom drugiego świeżego reviewera jakości kodu i fizyki.
- Implementer nie zatwierdza własnej pracy.
- Nie uruchamiaj kilku problemów równolegle, jeśli dotykają wspólnego ABI,
  Context, material accessora, RK state, demag state albo capability matrix.

Protokół dla KAŻDEGO problemu:

A. Re-derywacja przed zmianą
1. Zapisz bieżący HEAD, git status oraz hash plików objętych problemem.
2. Zweryfikuj aktualne kotwice raportu w pełnych funkcjach i wszystkich
   callerach; sprawdź CPU i GPU osobno.
3. Ponownie wyprowadź równanie, jednostki SI, znak, dyskretyzację, warunki
   brzegowe, material/mask semantics, energię i observable.
4. Sprawdź planner legality i publiczną osiągalność. Kod nieosiągalny nie może
   być przedstawiony jako zwykły runtime defect; zaakceptowana konfiguracja
   nie może być uznana za bezpieczną tylko dlatego, że istnieje kernel.
5. Jeżeli hipoteza została obalona przez aktualny kod, nie implementuj
   wymyślonej poprawki. Udokumentuj dowód, uruchom review i zamknij rekord jako
   disproven z dokładnymi kotwicami.

B. Physics/spec first
1. Dla fizyki lub numeryki najpierw popraw albo utwórz publikacyjną notę w
   docs/physics: równanie, symbole i jednostki, znaki, założenia, FEM CPU/GPU,
   API/ProblemIR/planner/runtime/provenance, walidacja i deferred work.
2. Dla zmiany ABI/publicznego modelu najpierw ustal migrację, supplied vs
   omitted, requested vs resolved, kompatybilność starych payloadów i
   fail-closed behavior.
3. Nie zmieniaj statusu capability na validated bez nazwanego workloadu i
   świeżego artefaktu.

C. Test-first, obowiązkowy red-green
1. Dodaj najmniejszy test odtwarzający dokładnie błąd. Na starej implementacji
   musi FAIL z właściwej przyczyny.
2. Zapisz komendę i fragment czerwonego wyniku.
3. Nie zmieniaj testu tak, aby błogosławił stary wynik. Oracle ma pochodzić z
   analityki, niezależnej arytmetyki, kierunkowej pochodnej, zbieżności,
   oficjalnego benchmarku albo jawnego failure contract.
4. Tolerancję wyprowadź ze skali, precyzji i zbieżności; nie wymyślaj stałej.

D. Minimalna implementacja end-to-end
1. Zaimplementuj granicę poprawki opisaną dla ID w sekcji 11 raportu.
2. Jeżeli pełna obsługa wymaga niegotowej architektury, najpierw wprowadź
   bezpieczne odrzucenie/fail-closed, a pełną realizację traktuj jako osobny,
   jawnie zależny etap tego samego ID.
3. Propaguj semantykę przez wszystkie konieczne warstwy:
   physics note -> Python/UI authoring -> ProblemIR -> validation/planner ->
   runner -> C ABI -> CPU/GPU owners -> fields/energies/stats -> artifacts i
   requested/resolved provenance.
4. CPU i GPU współdzielą równania, znaki, jednostki, mapy i oracle, ale mają
   osobne realizacje runtime. Nie dodawaj fizyki do Context ani
   backends/fem/src/api.cpp.
5. Nie rób refaktoryzacji niezwiązanej z ID.

E. Weryfikacja natywnego FEM
1. Przed buildem przeczytaj właściwe recipe w justfile.
2. Natywne MFEM/CUDA/hypre/libCEED zawsze buduj i sprawdzaj przez kontenerowe
   recipe repo. Host cargo/cmake/ctest są wyłącznie diagnostyką.
3. Typowa kolejność po zmianie natywnej:
   - ukierunkowany source/algebra contract w kontenerze;
   - just rebuild-fem-runtime;
   - just ensure-managed-fem-runtime;
   - named managed runtime gate z sekcji 11;
   - fizyczny oracle/benchmark i, jeśli dotyczy, CPU/GPU parity na tej samej
     zrealizowanej siatce.
4. Przeczytaj cały log i artefakty. Smoke PASS nie oznacza physics_validated.
5. Dla failure atomicity porównaj dokładnie committed m/time/step/source,
   publiczne statystyki i stochastic interval przed i po błędzie. Pochodny
   cache może zostać odtworzony albo jawnie unieważniony przed retry.
   Provenance może zarejestrować rejected attempt, ale nie może opublikować go
   jako accepted artifact ani zmienić requested/resolved semantics.
6. Dla demag sprawdź rzeczywisty constrained/gauge-aware residual. Dla energii
   wykonaj sweep centralnej pochodnej po retrakcji.
7. Dla stochastic najpierw zdefiniuj konwencję sLLG, one-increment-per-attempt,
   stage/retry scaling, normalizację/retrakcję i legalną macierz integratorów.
   Dopiero potem użyj statystyki, ESS i wielu seedów; jedna trajektoria ani
   pojedynczy przedział ufności nie kwalifikuje solvera.

F. Review checkpoint
1. Fresh spec reviewer sprawdza zgodność z problemem, physics note, zakresem i
   kryteriami akceptacji.
2. Napraw wszystkie uwagi i ponów testy.
3. Fresh quality/physics reviewer sprawdza uproszczenia, znaki, jednostki,
   CPU/GPU drift, rollback, wydajność i brak ukrytej zmiany publicznej fizyki.
4. Nie przechodź dalej bez APPROVED obu review.

G. Zamknięcie jednego ID
1. Utwórz lub zaktualizuj
   .fullmag/audits/2026-07-09-backend-llg/remediation/progress.md z:
   kanonicznym ID, wszystkimi źródłowymi aliasami, starym/nowym HEAD, plikami,
   testem red, testem green, managed commands i exits, artefaktami/hashami,
   benchmarkiem/tolerancjami, requested/resolved lane, review verdicts oraz
   pozostałymi ograniczeniami.
2. Uruchom git diff --check i kontrolę, że diff dotyczy tylko ID.
3. Nie commituj, nie pushuj i nie twórz PR bez wyraźnej prośby użytkownika.
4. Raportuj problem jako resolved tylko wtedy, gdy wszystkie checkboxy z jego
   sekcji 11 i zależności są spełnione. W przeciwnym razie status to partial
   albo blocked z dokładnym brakującym dowodem.
5. Dopiero wtedy wybierz następny niezamknięty ID zgodnie z zależnościami.

Na początku odpowiedzi podaj:
- wybrane ID i severity;
- dlaczego jest następne w kolejności zależności;
- dokładne kryterium sukcesu;
- pliki/warstwy w zakresie;
- test, który najpierw ma być czerwony;
- kontenerowe recipe końcowego dowodu.

Nie kończ na analizie. Kontynuuj aż aktualnie wybrany problem zostanie
naprawiony i zweryfikowany albo do chwili wykazania konkretnego blokera
wymagającego decyzji/zasobu spoza zakresu.
```
