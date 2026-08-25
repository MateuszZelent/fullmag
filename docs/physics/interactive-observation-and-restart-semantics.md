# Interaktywna obserwacja zaakceptowanego stanu i semantyka restartu

- Status: zaakceptowany kontrakt docelowy; realizacja runtime niekwalifikowana
- Właściciele: Fullmag core
- Ostatnia aktualizacja: 2026-08-18
- Powiązany ADR: [ADR 0025](../adr/0025-persistent-runtime-and-observation-sources.md)
- Powiązane specyfikacje: [observable materialization](../superpowers/specs/2026-08-15-fdm-fem-observable-materialization-parity-design.md), [API v2](../specs/resource-first-control-room-api-v2.md), [capability matrix](../specs/capability-matrix-v0.md)

(problem-statement)=
## 1. Problem fizyczny i produktowy

Po zaakceptowaniu kroku solvera użytkownik musi móc obserwować ten sam stan
magnetyczny bez wykonywania kolejnego kroku, niezależnie od tego, czy źródłem
jest bieżący runtime, czy niezmienna ramka autosave. Pole lub energia mają
znaczenie naukowe tylko wtedy, gdy ich magnetyzacja, zegar, `ProblemIR`, plan,
domena i wszystkie wymagane nośniki pierwotne tworzą jedną atomową tożsamość.

`LiveRuntime` pozostaje rezydentny do jawnego `close`, udanego atomowego swapu
albo fatalnego stanu `failed_unusable`. `ObservationRuntime` jest odrębnym,
rezydentnym ewaluatorem jednej wybranej ramki historycznej. Nie ma API
`step`, `run`, `relax`, `resume` ani publishera live-state i nigdy nie zastępuje
`LiveRuntime`.

(governing-equations)=
## 2. Równania kontraktu obserwacji

Quantity deterministyczna dla wybranego źródła ma postać

(observation-functional)=
```{math}
:label: eq-observation-functional
q_i = \mathcal{F}_i\!\left(\mathbf{m}, t, \mathcal{P}, \Pi, \mathcal{D}, \mathcal{C}_i\right),
```

gdzie $\mathcal{C}_i$ jest zbiorem dodatkowych pierwotnych nośników wymaganych
przez $q_i$. Brak któregokolwiek wymaganego nośnika kończy się typowanym
`unsupported_missing_primary_state`; zabronione jest podstawienie zera albo
przybliżenia wyglądającego jak wynik fizyczny.

Trwała tożsamość zaakceptowanego stanu jest rekordem content-bound:

```{math}
:label: eq-accepted-state-id
I_{\mathrm{acc}} = (R,U,n,d_{\Gamma},d_S,d_D,d_{\Pi}),
\qquad \Gamma=(n,t,\Delta t).
```

`AcceptedStateId` ma dokładnie pola `run_id`, `stage_id`, `accepted_step`,
`clock_digest`, `state_digest`, `domain_digest` i `plan_digest`. `run_id`
ustanawia trwałą przestrzeń nazw gałęzi wykonania, `stage_id` zachowuje
opcjonalną tożsamość stage, a `accepted_step` jest zaakceptowanym numerem kroku.
Równość identyfikatorów jest równością wszystkich siedmiu pól; zgodność samych
digestów nie scala stanów pochodzących z różnych runów lub stage'y.

Preimage jest wersjonowany i kanoniczny. `clock_digest` jest
`SHA256("fullmag.observation-clock.v1" || canon(accepted_step, t_bits,
dt_bits))`, gdzie `t_bits` i `dt_bits` są bitwise reprezentacjami wartości
IEEE-754, również dla braku `dt`. `state_digest` jest
`SHA256("fullmag.accepted-state.v1" || canon(ObservationClock,
primary_carriers))`; obejmuje kanoniczny `ObservationClock` z bitwise `t` i
`dt` oraz komplet pierwotnych nośników zaakceptowanego stanu. `domain_digest`
obejmuje kanoniczną domenę, grid/mesh, ownership i materiały. `plan_digest`
obejmuje znormalizowany `ProblemIR`, resolved plan i requested/resolved
execution. Każdy digest jest liczony z długościowo prefiksowanych bajtów, z
ustaloną kolejnością pól i bez zależności od kolejności mapy lub platformy.

`AcceptedStateGeneration` ma dokładnie pola `runtime_epoch` i
`accepted_revision`; jest lokalnym guardem przeciw stale command i nie wchodzi
do trwałych digestów. Kanoniczny `AcceptedStateRef` jest parą
`(AcceptedStateId, AcceptedStateGeneration)`.

Dostępność nie wynika z cache:

(quantity-availability)=
```{math}
:label: eq-quantity-availability
\mathcal{A}=\mathcal{Q}_{\mathrm{catalog}}
\cap\mathcal{Q}_{\mathcal{P}}
\cap\mathcal{Q}_{\Pi}
\cap\mathcal{Q}_{\mathrm{lane}}
\cap\mathcal{Q}_{\mathcal{C}}.
```

Kontynuacja zależy również od stanu algorytmicznego $K_n$:

(resume-trajectory)=
```{math}
:label: eq-resume-trajectory
S_{n+1}=\Phi(S_n,K_n), \qquad
\widetilde S_{n+1}=\Phi(S_n,\widetilde K_n).
```

`LogicalResume` odtwarza fizyczne $S_n$, ale może użyć
$\widetilde K_n\ne K_n$, więc dalsza trajektoria numeryczna może się zmienić.
`ExactResume` odtwarza również komplet wymaganych $K_n$ i zachowuje tę samą
zdyskretyzowaną trajektorię w identycznym deterministycznym runtime.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $q_i$ | kanoniczne pole albo skalar o identyfikatorze $i$ | $\text{quantity-dependent}$ |
| $\mathcal{F}_i$ | backend-neutralny funkcjonał quantity | $1$ |
| $\mathbf{m}$ | zredukowana magnetyzacja | $1$ |
| $t$ | czas zaakceptowanego stanu | $\mathrm{s}$ |
| $\Delta t$ | ostatni zaakceptowany krok czasu, jeżeli istnieje | $\mathrm{s}$ |
| $n$ | numer zaakceptowanego kroku | $1$ |
| $\Gamma$ | `ObservationClock` | $1$ jako rekord; składowe podano wyżej |
| $\mathcal{P}$ | znormalizowany `ProblemIR` | $1$ |
| $\Pi$ | rozstrzygnięty plan wykonania | $1$ |
| $\mathcal{D}$ | tożsamość domeny/gridu/mesha i materiałów | $1$ |
| $\mathcal{C}_i$ | dodatkowe pierwotne nośniki quantity $i$ | $\text{carrier-dependent}$ |
| $I_{\mathrm{acc}}$ | `AcceptedStateId` | $1$ |
| $R$ | trwałe `run_id` | $1$ |
| $U$ | opcjonalne `stage_id` | $1$ |
| $d_{\Gamma}$ | `clock_digest` | $1$ |
| $d_S$ | `state_digest` zegara i pierwotnych nośników | $1$ |
| $d_D$ | `domain_digest` | $1$ |
| $d_{\Pi}$ | `plan_digest` | $1$ |
| $G$ | `AcceptedStateGeneration` | $1$ |
| $e$ | lokalna epoka runtime | $1$ |
| $r$ | lokalna rewizja accepted state | $1$ |
| $\mathcal{A}$ | zbiór dostępnych quantity | $1$ |
| $\mathcal{Q}_{*}$ | zbiory ograniczeń katalogu, fizyki, planu, lane'u i nośników | $1$ |
| $S_n$ | fizyczny stan pierwotny kroku $n$ | $\text{carrier-dependent}$ |
| $K_n$ | stan kontynuacji integratora, RNG i układów sprzężonych | $\text{carrier-dependent}$ |
| $\Phi$ | operator jednego kroku numerycznego | $1$ |

(assumptions-and-validity)=
## 4. Założenia, kategorie quantity i granice ważności

Quantity zależne wyłącznie od $\mathbf m,t,\mathcal P,\Pi,\mathcal D$ obejmują
deterministyczne pola aktywnych interakcji, odpowiadające energie i gęstości
energii, o ile bieżący plan ma ich realizację. Wymuszenia czasowe muszą być
ewaluowane dla czasu ramki. `H_therm` wymaga dokładnego algorytmu i stanu RNG.
Quantity transportowe wymagają zaakceptowanych nośników charge/spin; dynamiczny
Oersted wymaga właściwego rozwiązania sprzężonego. Magnetoelastyka może wymagać
przemieszczenia i prędkości. Samo `m` nie uprawnia do ich rekonstrukcji.

Autosave frame jest immutable `ObservationSource`, nie checkpointem resume.
Pełna historia pozostaje na dysku; RAM/VRAM przechowuje accepted primary state,
plan/domenę/materiały, operatory/workspaces, wszystkie policzone quantity
bieżącego źródła oraz jedną wybraną ramkę i jej cache prezentacyjny.

Obecna ścieżka FDM CPU coupled M3 ma ograniczony, wykonywalny checkpoint
`fullmag.fdm.coupled_m3_checkpoint.v1`. Payload obejmuje bieżącą i poprzednią
magnetyzację, czas i poprzednie `dt`, zaakceptowane nośniki charge/spin/Oersted,
stany przejściowe, historie nieliniowe, error controller, rewizje, liczniki
accepted/rejected/rollback, kursor telemetryki oraz seed i accepted-interval
counter RNG.
Pole `payload_sha256` jest SHA-256 kanonicznej serializacji całego checkpointu
z pustym polem digestu. Brak, zły format albo niezgodność digestu kończą restore
błędem przed zmianą workflow. Payloady utworzone przed dodaniem digestu są
jawnie odrzucane; nie są migrowane heurystycznie. Ten ograniczony dowód nie
promuje zwykłego FDM CPU, autosave ani wszystkich układów sprzężonych do
ogólnego `ExactResume`.

W ścieżce FDM CPU coupled Heun runner buduje kandydat magnetyzacji w istniejących
buforach integratora, a kandydat transportu w cache próby chronionym przez
`begin_attempt`/`rollback`; gorąca pętla nie klonuje pełnego stanu. Najpierw
zatwierdza workflow transportowy, następnie podmienia zaakceptowany stan
magnetyzacji, a licznik zaakceptowanego interwału termicznego zwiększa dokładnie
raz dopiero po obu tych operacjach. Błąd końcowego
`workflow.commit()` pozostawia magnetyzację, stan transportu i licznik RNG bez
zmian; retry używa tego samego interwału termicznego. Jest to ograniczony dowód
atomowości coupled Heun, a nie kwalifikacja adaptacyjnego stochastycznego LLG.
Termiczny generator FDM CPU jest licznikowy: każda ewaluacja pola wyznacza cztery
wartości uniform dla aktywnego cella z klucza `(seed, thermal_counter, cell,
stream)` i nie przesuwa mutable kursora losowań. Stanową metryką RNG jest więc
`thermal_counter`, a nie liczba ponownych obliczeń hashy podczas RHS. Checkpoint
wymusza `thermal_counter == accepted_steps`, co dowodzi dokładnie jednego commit
interwału termicznego na zaakceptowany krok; `rollback_count` zlicza wyłącznie
próby posiadające aktywny checkpoint transakcji.

(python-api)=
## 5. Python API

Task 0 nie dodaje publicznej klasy ani parametru Python. Istniejące authoring
`fm.study(...)`, stage i autosave pozostają źródłem `ProblemIR`; wybór
`ObservationSource`, `ComputeQuantities`, `.fms`, `LogicalResume` i
`ExactResume` są kontraktami runtime/API, a nie alternatywnym modelem fizyki.

Poniższy istniejący wzorzec stage-first zapisuje pełne `m`; nie obiecuje, że
ramka jest checkpointem resume:

```python
# %%
import fullmag as fm

study = fm.study("observation_contract_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(True)

# %%
film = study.geometry(fm.Box(size=(40e-9, 20e-9, 4e-9), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.demag()

# %%
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=1000,
    tolT=1e-6,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(every_steps=10, quantities=["step", "mx", "my", "mz"]),
        fields=[fm.FieldAutosave(quantity="m", every_steps=10)],
    )
)
```

| Publiczny obiekt/parametr | Typ | Domyślna wartość | Jednostka SI | Walidacja | Znaczenie | Lane'y | `ProblemIR` |
|---|---|---|---|---|---|---|---|
| `TableAutosave.t_sampl` | `float \| "auto" \| None` | `None` | $\mathrm{s}$ albo polityka | dokładnie jedno z `t_sampl`/`every_steps`; dodatnia skończona liczba lub `"auto"` | czasowa kadencja tabeli | według stage/lane | `sampling.stage_autosave.table.sample_period_s` albo `sampling.stage_autosave.table.sample_period_policy` |
| `TableAutosave.every_steps` | `int \| None` | `None` | $1$ | dokładnie jedno z `t_sampl`/`every_steps`; dodatni `int`, nie `bool` | krokowa kadencja tabeli | według stage/lane | `sampling.stage_autosave.table.every_steps` |
| `TableAutosave.quantities` | `Sequence[str] \| None` | `None` | $\text{quantity-dependent}$ | `None` wybiera kanoniczny zestaw domyślny; jawna sekwencja nie może być pusta i zawiera tylko wspierane quantity | bazowe kolumny tabeli | według katalogu i stage/lane | `sampling.stage_autosave.table.quantities[]` |
| `TableAutosave.extra_quantities` | `Sequence[str]` | `()` | $\text{quantity-dependent}$ | tylko wspierane quantity; duplikaty są deterministycznie deduplikowane z listą bazową | dodatkowe kolumny scalane do `quantities` | według katalogu i stage/lane | `sampling.stage_autosave.table.quantities[]` po scaleniu |
| `TableAutosave.expressions` | `Sequence[str]` | `()` | $\text{expression-dependent}$ | każde wyrażenie jest normalizowane i walidowane; duplikat nie jest ponownie dodawany przez `add_expression` | pochodne kolumny skalarne | według expression evaluator lane'u | `sampling.stage_autosave.table.expressions[]` |
| `TableAutosave.table_id` | `str` | `"default"` | $1$ | niepusty po usunięciu zewnętrznych białych znaków | stabilna tożsamość tabeli | wszystkie lane'y obsługujące table autosave | `sampling.stage_autosave.table.table_id` |
| `FieldAutosave.quantity` | `str` | wymagany | $\text{quantity-dependent}$ | niepusty i wspierany przez kanoniczny katalog `SaveField` | identyfikator zapisywanego pola | według katalogu i stage/lane | `sampling.stage_autosave.fields[].quantity` |
| `FieldAutosave.every` | `float \| "auto" \| None` | `None` | $\mathrm{s}$ albo polityka | dokładnie jedno z `every`/`every_steps`; dodatnia skończona liczba lub `"auto"` | czasowa kadencja pola | według stage/lane | `sampling.stage_autosave.fields[].every_seconds` albo `sampling.stage_autosave.fields[].sample_period_policy` |
| `FieldAutosave.every_steps` | `int \| None` | `None` | $1$ | dokładnie jedno z `every`/`every_steps`; dodatni `int`, nie `bool` | krokowa kadencja pola | według stage/lane | `sampling.stage_autosave.fields[].every_steps` |
| `StageAutosave.target` | `str` | `"main"` | $1$ | niepusty; zaczyna się alfanumerycznie i zawiera tylko litery, cyfry, `.`, `_`, `-` | logiczny cel zapisu | wszystkie lane'y obsługujące autosave | `sampling.stage_autosave.target` |
| `StageAutosave.layout` | `str` | `"continuous"` | $1$ | jedno z `continuous`, `separate` | układ artefaktu autosave | wszystkie lane'y obsługujące autosave | `sampling.stage_autosave.layout` |
| `StageAutosave.format` | `str` | `"zarr"` | $1$ | jedno z `zarr`, `hdf5`, `txt`; `txt` zabrania pól | format artefaktu autosave | zależnie od formatu i stage/lane | `sampling.stage_autosave.format` |
| `StageAutosave.table` | `TableAutosave \| None` | `None` | $1$ | `TableAutosave` lub `None`; co najmniej table albo jedno field | polityka tabeli zaakceptowanych próbek | według stage/lane | `sampling.stage_autosave.table` |
| `StageAutosave.fields` | `Sequence[FieldAutosave]` | `()` | $1$ | wyłącznie `FieldAutosave`, unikalne quantity; co najmniej table albo jedno field; brak pól dla `txt` | jawna lista pól autosave; `m` jest obserwacyjnym nośnikiem pierwotnym | według stage/lane | `sampling.stage_autosave.fields[]` |

(problem-ir)=
## 6. `ProblemIR`, planner i proweniencja

Nie ma zmiany schematu `ProblemIR`. Istniejący `sampling.stage_autosave`
pozostaje polityką zapisu. `AcceptedStateRef`, `ObservationSource` i wynik
`ComputeQuantities` należą do runtime/proweniencji; nie mogą zostać dopisane do
IR tylko po to, aby obsłużyć ekran. Requested backend/device/precision oraz
resolved execution pozostają oddzielne i są częścią proweniencji batchu.

Brak implementacji `ObservationRuntime` nie może promować capability.
Capability matrix rozdziela source presence, executability, validation i
production qualification dla każdego z czterech lane'ów.

(round-trip-and-failure-semantics)=
## 7. Round-trip i semantyka błędów

Python↔`ProblemIR` round-trip nie zmienia się. Historyczne compute nie mutuje
IR ani live accepted state. Brak nośnika zwraca
`unsupported_missing_primary_state` z listą braków. Stale
`AcceptedStateGeneration` odrzuca komendę. Wymuszony GPU/backend nigdy nie
uruchamia cichego fallbacku. `.fms` powstaje wyłącznie po jawnym Save/Export;
import waliduje integralność, buduje kandydacki runtime i wykonuje jeden
atomowy swap albo pozostawia aktywną sesję bez zmian.

`requested intent` i `resolved execution` pozostają osobnymi polami
proweniencji. `validation errors` są typowane, a `unsupported combinations`
są odrzucane przed alokacją albo compute, bez degradacji lane'u.

FDM CPU przenosi stabilny `EngineErrorCode` niezależnie od tekstu diagnostyki.
Kontrakt rozróżnia co najmniej: niepoprawne wejście i krok czasu, `NaN`,
`+/-Inf`, brak capability, brak pamięci, błąd solvera, brak zbieżności,
błąd przerwania,
błąd solvera sprzężonego oraz trzy terminalne zakończenia kontrolera
adaptacyjnego. `NaN` i `Inf` nie mogą być scalone w jeden powód. Konwersja
silnik→runner zapisuje kod bez parsowania komunikatu; tekst pozostaje wyłącznie
diagnozą dla człowieka. Błąd sprzężonego etapu lub commitu zachowuje kod
`coupled_solver_failure` i nie commituje magnetyzacji, transportu ani licznika
interwału termicznego.

(discrete-realization)=
## 8. Realizacje dyskretne i status lane'ów

| Solver | Device | Neutralny kontrakt | Obecny status dowodów |
|---|---|---|---|
| FDM | CPU | rezydentny live state, osobny historical evaluator, jeden `ComputeQuantities` | coupled M3 ma unit/integration proof kompletnego checkpointu i restartu z SHA-256; persistent observation i ogólny `ExactResume` pozostają niezakwalifikowane |
| FDM | GPU | te same identyfikatory, jednostki i błędy; osobne CUDA buffers/workspaces | source obecny fragmentarycznie; brak kwalifikacji persistent observation |
| FEM | CPU | te same źródła i batch; osobna realizacja MFEM/hypre | source obecny fragmentarycznie; brak kwalifikacji persistent observation |
| FEM | GPU | te same źródła i batch; osobna realizacja MFEM/hypre/libCEED/CUDA | source obecny fragmentarycznie; brak kwalifikacji persistent observation |

FDM/FEM oraz CPU/GPU współdzielą kontrakt, nie mutable implementację. Nowa
fizyka i ownership nie trafiają do `Context`, `mfem_bridge.cpp`, runnerowego
`dispatch.rs` ani ogólnego `execute.rs`.

(implementation-mapping)=
## 9. Mapowanie implementacji docelowej

`LiveRuntime` pozostaje jedynym właścicielem step/run/publisher. Docelowy
`ObservationRuntime` rekonstruuje wyłącznie neutralne operatory potrzebne do
quantity. Jedna operacja `ComputeQuantities(source, quantity_ids)` materializuje
kanoniczne payloady jako jeden atomowy batch; osobny cache sampling/presentation
nie zmienia ich tożsamości ani capability. HTTP v2 jest źródłem prawdy,
WebSocket tylko invaliduje. Pola pozostają wyłącznie w kanonicznym binarnym
field data plane, a skalarne wyniki batchu należą do cienkiego zasobu
`observation-results/{observation_id}/scalars`; nie powstaje drugi field API ani
drugi codec.

(validation)=
## 10. Walidacja i kryteria akceptacji

Wymagane są osobne dowody: source presence, kompilacja, wykonywalność publiczna,
walidacja numeryczna i production qualification. Minimalny zestaw obejmuje:

1. compute current i frame zwracają te same quantity dla identycznego
   `AcceptedStateId`;
2. historical compute nie zmienia live clock, magnetyzacji, generacji, cache,
   kolejki ani publishera;
3. energia całkowana zgadza się ze skalarem tego samego batchu;
4. quantity czasowa używa czasu ramki;
5. brak RNG/coupled carriera daje typed unsupported;
6. logical resume jawnie może rozbiec trajektorię, a exact resume odtwarza
   wszystkie wymagane nośniki;
7. import `.fms` jest all-or-nothing;
8. każda lane wymaga własnego runtime receipt; GPU receipt zawiera device ID i
   dowód braku fallbacku.

Dla ograniczonego FDM CPU coupled M3 dodatkowe testy sprawdzają zgodność
trajektorii i zaakceptowanego artefaktu po resume z przebiegiem nieprzerwanym,
zgodność termicznego accepted-interval counter, odrzucenie każdego mismatchu
publicznej tożsamości oraz odrzucenie skończonej korupcji magnetyzacji przez
`payload_sha256` bez modyfikacji workflow.

Obecny status persistent observation pozostaje kontraktem
źródłowym/dokumentacyjnym bez runtime receipts. Wyjątkiem o wąskim zakresie
jest unit/integration proof checkpointu FDM CPU coupled M3; nie kwalifikuje on
całej lane ani pozostałych kontraktów tej strony.

(limitations)=
## 11. Ograniczenia, kompletność i prace odroczone

- [x] kontrakt fizyczny, symbole i SI
- [x] cztery lane'y i brak silent fallbacku
- [x] brak zmian Python/`ProblemIR` opisany jawnie
- [x] runtime/API/proweniencja opisane
- [x] walidacja i typowane błędy opisane
- [ ] implementacja `AcceptedStateRef` i `ObservationRuntime`
- [ ] atomowy autosave frame descriptor i reader
- [ ] transactional `.fms` runtime import/export
- [ ] receipts numeryczne, managed CPU/GPU i browser/WebGL

(scientific-bibliography)=
## 12. Bibliografia naukowa

1. W. F. Brown Jr., *Micromagnetics*, Wiley, 1963, DOI: [10.1002/9780470172914](https://doi.org/10.1002/9780470172914).
2. L. Exl et al., “LaBonte's method revisited,” *J. Appl. Phys.* 115, 17D118 (2014), DOI: [10.1063/1.4862839](https://doi.org/10.1063/1.4862839).
3. F. Abert, “Micromagnetics and spintronics: models and numerical methods,” *Eur. Phys. J. B* 92, 120 (2019), DOI: [10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
4. A. Vansteenkiste et al., “The design and verification of MuMax3,” *AIP Advances* 4, 107133 (2014), DOI: [10.1063/1.4899186](https://doi.org/10.1063/1.4899186).

(source-code-index)=
## 13. Indeks kodu źródłowego i dowodów

| Twierdzenie | Ścieżka | Symbol | Odpowiedzialność | Lane | Dowód |
|---|---|---|---|---|---|
| docelowy funkcjonał obserwacji | `docs/physics/interactive-observation-and-restart-semantics.md` | `DOC-ANCHOR:observation-functional` | planowany backend-neutralny funkcjonał quantity | wszystkie | planned contract, bez runtime proof |
| docelowa accepted-state identity | `docs/adr/0025-persistent-runtime-and-observation-sources.md` | `DOC-ANCHOR:accepted-state-identity` | planowany `AcceptedStateRef` | wszystkie | planned contract, bez runtime proof |
| docelowa availability | `docs/physics/interactive-observation-and-restart-semantics.md` | `DOC-ANCHOR:quantity-availability` | planowane przecięcie katalogu, fizyki, planu, lane'u i nośników | wszystkie | planned contract, bez runtime proof |
| docelowa semantyka resume | `docs/physics/interactive-observation-and-restart-semantics.md` | `DOC-ANCHOR:resume-trajectory` | planowane rozróżnienie logical/exact | wszystkie | planned contract, bez runtime proof |
| obecny eager batch do zastąpienia | `crates/fullmag-runner/src/interactive/runtime.rs` | `build_atomic_terminal_update` | bieżąca luka: terminalny snapshot FDM | FDM CPU/GPU | superseded/gap evidence, nie źródło równania docelowego |
| bieżąca komenda pól | `crates/fullmag-cli/src/interactive_runtime_host.rs` | `compute_current_fields` | bieżąca luka: materializacja current | wszystkie | gap evidence, nie źródło równania docelowego |
| checkpoint session store | `crates/fullmag-session/src/capture.rs` | `capture_checkpoint` | bieżący capture CAS | wszystkie | gap evidence, exact restore nieudowodniony |
| checkpoint coupled M3 | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `coupled_checkpoint` | materializacja pełnego accepted continuation state, liczników accepted/rejected/rollback i digestu | FDM CPU coupled M3 | unit/integration proof |
| integralność checkpointu coupled M3 | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `coupled_checkpoint_payload_sha256` | SHA-256 kanonicznego payloadu bez pola digestu | FDM CPU coupled M3 | test korupcji skończonej wartości |
| atomowy restore coupled M3 | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `restore_coupled_checkpoint` | walidacja digestu, tożsamości i kompletności przed commit | FDM CPU coupled M3 | resume i mutation tests |
| trial coupled Heun bez skutków ubocznych RNG | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `heun_trial_with_external_stage_terms_and_lte` | budowa kandydata magnetyzacji bez zatwierdzania interwału termicznego | FDM CPU coupled Heun | unit/integration fault injection |
| atomowy owner coupled Heun | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_coupled_heun_trial` | wspólny commit workflow, magnetyzacji i licznika RNG po sukcesie | FDM CPU coupled Heun | workflow-commit failure regression |
| stabilne kody błędów silnika | `crates/fullmag-engine/src/fdm/shared/types.rs` | `EngineErrorCode` | osobne powody dla NaN, Inf, capability, OOM, solvera, zbieżności, przerwania i terminalnych decyzji adaptacyjnych | FDM CPU | unit/integration proof |
| propagacja kodu silnik→runner | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `engine_run_error` | zapis kodu powodu bez parsowania tekstu diagnostycznego | FDM CPU | coupled fault-injection regression |
| publiczne `TableAutosave` | `packages/fullmag-py/src/fullmag/model/study.py` | `class TableAutosave` | authoring, walidacja i lowering tabeli | wszystkie | source presence; bez promocji runtime |
| publiczne `FieldAutosave` | `packages/fullmag-py/src/fullmag/model/study.py` | `class FieldAutosave` | authoring, walidacja i lowering pola | wszystkie | source presence; bez promocji runtime |
| publiczne `StageAutosave` | `packages/fullmag-py/src/fullmag/model/study.py` | `class StageAutosave` | authoring, walidacja i lowering polityki stage | wszystkie | source presence; bez promocji runtime |
