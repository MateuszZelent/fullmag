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

```{math}
:label: eq-observation-functional
q_i = \mathcal{F}_i\!\left(\mathbf{m}, t, \mathcal{P}, \Pi, \mathcal{D}, \mathcal{C}_i\right),
```

gdzie $\mathcal{C}_i$ jest zbiorem dodatkowych pierwotnych nośników wymaganych
przez $q_i$. Brak któregokolwiek wymaganego nośnika kończy się typowanym
`unsupported_missing_primary_state`; zabronione jest podstawienie zera albo
przybliżenia wyglądającego jak wynik fizyczny.

Trwała tożsamość zaakceptowanego stanu jest content-bound:

```{math}
:label: eq-accepted-state-id
I_{\mathrm{acc}} = \operatorname{SHA256}\!\left(v \parallel
\operatorname{canon}(\Gamma,\mathcal{P},\Pi,\mathcal{D},\mathcal{C})\right),
\qquad \Gamma=(n,t,\Delta t).
```

Zegar $\Gamma$, łącznie z bitowo jednoznacznymi $t$ i $\Delta t$, jest częścią
digestu. Lokalna generacja $G=(e,r)$ chroni bieżącą epokę runtime; kanoniczny
`AcceptedStateRef` jest parą `(AcceptedStateId, AcceptedStateGeneration)`.

Dostępność nie wynika z cache:

```{math}
:label: eq-quantity-availability
\mathcal{A}=\mathcal{Q}_{\mathrm{catalog}}
\cap\mathcal{Q}_{\mathcal{P}}
\cap\mathcal{Q}_{\Pi}
\cap\mathcal{Q}_{\mathrm{lane}}
\cap\mathcal{Q}_{\mathcal{C}}.
```

Kontynuacja zależy również od stanu algorytmicznego $K_n$:

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
| $q_i$ | kanoniczne pole albo skalar o identyfikatorze $i$ | zależna od quantity; jawna w katalogu |
| $\mathcal{F}_i$ | backend-neutralny funkcjonał quantity | $1$ |
| $\mathbf{m}$ | zredukowana magnetyzacja | $1$ |
| $t$ | czas zaakceptowanego stanu | $\mathrm{s}$ |
| $\Delta t$ | ostatni zaakceptowany krok czasu, jeżeli istnieje | $\mathrm{s}$ |
| $n$ | numer zaakceptowanego kroku | $1$ |
| $\Gamma$ | `ObservationClock` | $1$ jako rekord; składowe podano wyżej |
| $\mathcal{P}$ | znormalizowany `ProblemIR` | $1$ |
| $\Pi$ | rozstrzygnięty plan wykonania | $1$ |
| $\mathcal{D}$ | tożsamość domeny/gridu/mesha i materiałów | $1$ |
| $\mathcal{C}_i$ | dodatkowe pierwotne nośniki quantity $i$ | zależna od nośnika |
| $I_{\mathrm{acc}}$ | `AcceptedStateId` | $1$ |
| $v$ | wersja kanonicznego preimage digestu | $1$ |
| $G$ | `AcceptedStateGeneration` | $1$ |
| $e$ | lokalna epoka runtime | $1$ |
| $r$ | lokalna rewizja accepted state | $1$ |
| $\mathcal{A}$ | zbiór dostępnych quantity | $1$ |
| $\mathcal{Q}_{*}$ | zbiory ograniczeń katalogu, fizyki, planu, lane'u i nośników | $1$ |
| $S_n$ | fizyczny stan pierwotny kroku $n$ | złożona jednostka nośników |
| $K_n$ | stan kontynuacji integratora, RNG i układów sprzężonych | złożona jednostka nośników |
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
study.stages.add_relax(stage_id="relax", max_steps=1000, tolT=1e-6).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(every_steps=10, quantities=["step", "mx", "my", "mz"]),
        fields=[fm.FieldAutosave(quantity="m", every_steps=10)],
    )
)
```

| Publiczny obiekt/parametr | Typ | Domyślna wartość | Jednostka SI | Walidacja i znaczenie | Lane'y | `ProblemIR` |
|---|---|---|---|---|---|---|
| nowy parametr Task 0 | brak | nie dotyczy | $1$ | Task 0 nie zmienia publicznego authoring API | bez promocji | brak zmiany |
| `StageAutosave.table` | `TableAutosave \| None` | `None` | $1$ | polityka tabeli zaakceptowanych próbek | według stage/lane | `sampling.stage_autosave.table` |
| `StageAutosave.fields` | `list[FieldAutosave]` | pusta lista | $1$ | jawna lista pól autosave; `m` jest obserwacyjnym nośnikiem pierwotnym | według stage/lane | `sampling.stage_autosave.fields[]` |
| `FieldAutosave.quantity` | `str` | wymagany | według quantity | niepusty kanoniczny identyfikator | według katalogu | `sampling.stage_autosave.fields[].quantity` |
| `FieldAutosave.every_steps` | `int \| None` | `None` | $1$ | dodatnia kadencja zaakceptowanych kroków | relaxation | `sampling.stage_autosave.fields[].every_steps` |

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

(discrete-realization)=
## 8. Realizacje dyskretne i status lane'ów

| Solver | Device | Neutralny kontrakt | Obecny status dowodów |
|---|---|---|---|
| FDM | CPU | rezydentny live state, osobny historical evaluator, jeden `ComputeQuantities` | kontrakt dokumentacyjny; brak end-to-end receipts |
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
kanoniczne payloady; osobny cache sampling/presentation nie zmienia ich
tożsamości ani capability. HTTP v2 jest źródłem prawdy, WebSocket tylko
invaliduje, a pola korzystają z jednego binarnego field data plane.

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

Obecny status: wyłącznie kontrakt źródłowy/dokumentacyjny. Task 0 nie dostarcza
runtime receipts i nie kwalifikuje żadnej lane.

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
| obecny live runtime i cache | `crates/fullmag-runner/src/interactive/runtime.rs` | `InteractiveRuntime` | bieżący backend i snapshot cache | wszystkie przez adaptery | source presence |
| obecny eager batch do zastąpienia | `crates/fullmag-runner/src/interactive/runtime.rs` | `build_atomic_terminal_update` | terminalny snapshot FDM | FDM CPU/GPU | source presence, nie target |
| host aktywnego runtime | `crates/fullmag-cli/src/interactive_runtime_host.rs` | `InteractiveRuntimeHost` | lifecycle sesji | wszystkie | source presence |
| bieżąca komenda pól | `crates/fullmag-cli/src/interactive_runtime_host.rs` | `compute_current_fields` | materializacja current | wszystkie | source presence |
| status materializacji | `crates/fullmag-runner/src/types.rs` | `LiveFieldMaterializationStatus` | status cache/resource | wszystkie | source presence |
| manifest autosave | `crates/fullmag-runner/src/autosave_storage.rs` | `StageManifest` | trwały zapis próbek | wszystkie | source presence |
| checkpoint session store | `crates/fullmag-session/src/capture.rs` | `capture_checkpoint` | obecny capture CAS | wszystkie | source presence, exact restore nieudowodniony |
| publiczne autosave | `packages/fullmag-py/src/fullmag/model/study.py` | `StageAutosave` | authoring i lowering | wszystkie | testy Python istnieją; bez promocji runtime |

