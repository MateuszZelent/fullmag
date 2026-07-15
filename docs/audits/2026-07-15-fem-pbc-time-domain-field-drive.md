# Audyt FEM PBC: czasowe wzbudzenie polem magnetycznym

- Data audytu: 2026-07-15
- Rewizja: `f6ae1c37a52ba4d5cc1ed962c49d0cfed89fdfdc`
- Przykład bazowy: `examples/fem_periodic_antidot_relax_exchange_coupled.py`
- Zakres: Python DSL, ProblemIR, planner, runner, natywny FEM CPU/GPU, PBC, OpenAPI v2 i Control Room

## 1. Werdykt

Żądanego przypadku nie można dziś uruchomić poprawnie end-to-end:

> FEM z PBC + relaksacja do stanu równowagi + przestrzennie jednorodne albo regionalne pole `B(x,t)` z impulsem `sinc` + precesyjna ewolucja LLG + sterowanie i obserwacja z UI.

Stan poszczególnych fragmentów jest następujący:

| Funkcja | Python | IR/planner | FEM CPU | FEM GPU | UI/API | Werdykt |
|---|---:|---:|---:|---:|---:|---|
| Statyczne globalne `B_ext` | tak | tak | tak | tak | tak | dostępne |
| Czasowa ewolucja LLG | tak | tak | tak | tak | częściowo | dostępna bez żądanego napędu |
| `sinc`/sinus/PWL jako serializowalna funkcja czasu | tak | tak | nie dla natywnego napędu FEM | nie | częściowo | semantyka bez wykonania FEM |
| Pole czasowe ograniczone maską obiektu/regionu | składnia kompatybilności istnieje | maska jest planowana | brak poprawnej konsumpcji | jawne odrzucenie | zapis z UI jest niezgodny ze schematem backendu | niedostępne |
| Globalne pole czasowe jako pierwszy klasowy kontrakt | nie | nie | nie | nie | nie | niedostępne |
| `H_ant` jako obserwowalne pole użyte przez ten sam solver | deklarowane | częściowo | brak dowodu spójności | brak | widoczne w katalogu | semantycznie niespójne |
| PBC `periodic_airbox_k0` dla przykładu bazowego | tak | tak | ograniczona ścieżka | działa w bramce relaksacji | PBC jest widoczne | nie promuje napędu czasowego |

Najbliższa działająca funkcjonalność to:

1. statyczne, globalne `study.b_ext(...)`;
2. precesyjny solver czasowy FEM z etapem `study.stages.add_run(until=...)`;
3. regionalny `sinc` wykonywany tylko przez referencyjny FDM CPU, z dodatkowym zastrzeżeniem dotyczącym próbkowania funkcji czasu w krokach RK.

To nie wystarcza do badanego scenariusza FEM.

## 2. Co obecnie robi wskazany przykład

`examples/fem_periodic_antidot_relax_exchange_coupled.py`:

- wybiera FEM, GPU i podwójną precyzję;
- definiuje komórkę 200 nm × 200 nm × 10 nm z otworem o promieniu 25 nm;
- ustawia PBC w osiach x/y z `demag="periodic_airbox_k0"`;
- ustawia statyczne globalne pole `study.b_ext(10e-3, 0, 0)`;
- włącza exchange i demagnetyzację Poisson/Robin;
- ustawia `dt=1e-13 s`;
- kończy się jednym etapem `add_minimize(method="bb", max_steps=100, ...)`.

W przykładzie nie ma etapu `run`, więc czas fizyczny kończy się na `0.0`. Samo ustawienie `dt` nie uruchamia dynamiki.

Dodanie:

```python
study.stages.add_run(until=2e-9)
```

uruchomiłoby czasową LLG pod wpływem istniejącego statycznego pola. Po relaksacji do równowagi w tym samym polu nie jest to jednak kontrolowane wzbudzenie: bez poprzecznego impulsu stan powinien pozostać blisko równowagi, z wyjątkiem błędu relaksacji i numerycznych zaburzeń.

## 3. Istotna interpretacja fizyczna PBC

Impuls `sinc` w czasie jest szerokopasmowy w częstotliwości, ale nie nadaje automatycznie skończonego wektora falowego.

- Jednorodne przestrzennie pole w pojedynczej komórce okresowej pobudza przede wszystkim mody o niezerowym średnim momencie dynamicznym przy punkcie Γ (`k=0`).
- Antidot może mieszać profile modów wewnątrz komórki, ale okresowość wymusza powtarzanie rozwiązania co komórkę.
- Regionalna maska w pojedynczej komórce również powtarza się okresowo. Jej widmo przestrzenne zawiera składowe sieci odwrotnej, ale nie reprezentuje pojedynczego, izolowanego źródła ani swobodnie propagującego pakietu w nieskończonej próbce.
- Do obserwacji propagującego pakietu o skończonym `k` potrzebna jest większa superkomórka albo wydłużony falowód z lokalnym źródłem i odpowiednio otwartą osią propagacji. PBC można pozostawić w osi poprzecznej.
- Do systematycznej dyspersji `omega(k)` lepszy jest kontrakt Blocha/Floqueta lub seria superkomórek; jednorodny impuls w pojedynczej komórce daje widmo rezonansów Γ, nie pełną dyspersję.

Dla bieżącego przykładu sensownym pierwszym celem jest więc szerokopasmowa spektroskopia czasowa modów Γ. Jeśli celem jest propagacja fali, geometria obliczeniowa powinna zostać zmieniona przed interpretacją wyników.

## 4. Python DSL

### 4.1 Co działa

Statyczny Zeeman jest prostym wektorem:

```python
study.b_ext(Bx, By, Bz)
```

`Zeeman.to_ir()` zapisuje wyłącznie `{"kind": "zeeman", "B": [...]}`. Nie ma parametru `waveform`, `time_origin` ani zakresu aktywnych etapów.

Istnieją serializowalne klasy funkcji czasu:

- `Constant`;
- `Sinusoidal`;
- `Pulse`;
- `PiecewiseLinear`;
- `SincPulse`.

Istnieje również kompatybilnościowa składnia źródła regionalnego:

```python
study.antenna_field_source(
    name="pulse",
    model="prescribed_zeeman_mask",
    object="source_mask",
    B=1e-3,
    direction=(0.0, 1.0, 0.0),
    spatial_profile={"kind": "uniform"},
    waveform=fm.SincPulse(cutoff_hz=20e9, t0=50e-12),
)
```

Python serializuje ten model poprawnie. Składnia nie oznacza jednak, że FEM wykonuje źródło.

### 4.2 Braki

1. Nie ma pierwszoklasowego `RegionalFieldDrive` ani `GlobalFieldDrive`; funkcja jest przeciążeniem `AntennaFieldSource` i `current_modules`.
2. `spatial_profile` jest surowym słownikiem, a nie typowanym publicznym konstruktorem.
3. Nie ma `time_origin="stage" | "absolute"` w rzeczywistym API, chociaż projekt w nocie 0920 go zakłada.
4. Nie ma ograniczenia źródła do wskazanych etapów ani jednoznacznego zachowania po relaksacji.
5. `PiecewiseLinear` istnieje w modelu, ale exporter skryptu nie ma kompletnego, zweryfikowanego round-trip dla wszystkich wariantów.
6. Globalny impuls wymagałby sztucznego obiektu-maskowania pokrywającego domenę. Nie powinien to być kontrakt docelowy.

## 5. ProblemIR i planner

`TimeDependenceIR` obsługuje stałą, sinus, prostokątny impuls, PWL i `sinc_pulse`. Planner potrafi zmaterializować `antenna_zeeman_masks` dla FDM i FEM.

Obecny kontrakt ma jednak charakter kompatybilnościowy. `docs/specs/problem-ir-v0.md` wskazuje jako docelowy osobny `RegionalFieldDriveIR`, obejmujący region, amplitudę/kierunek, profil przestrzenny, waveform, źródło czasu i aktywne etapy.

Ograniczenia planera maski:

- bezpośrednio obsługiwane są tylko wybrane prymitywy i operacje geometrii;
- importowane/ogólne CSG nie mają pełnej ścieżki;
- test planera znaleziony dla `prescribed_zeeman_mask` obejmuje FDM, nie natywne wykonanie FEM;
- nie ma zarządzanej bramki `PBC + FEM + regional sinc + LLG`.

Autorytatywna macierz możliwości klasyfikuje `regional_field_drive` następująco:

- FDM CPU reference: `reference_executable`;
- FDM GPU production: `unsupported`;
- FEM CPU public: `source_visible`;
- FEM GPU public: `unsupported`.

Macierz wprost stwierdza, że FEM materializuje maski w planie, ale natywna ewolucja czasowa nie dowodzi ich konsumpcji.

## 6. Runner i backend FEM

### 6.1 Solver czasowy bez regionalnego źródła

Natywny FEM ma precesyjną LLG i integratory:

- Heun;
- RK4;
- RK23;
- RK45.

Kontenerowy `just verify-fem-time-domain-native-contract` przeszedł. Obejmuje kontrakty integratorów, Oersted, STT, snapshotów i innych istniejących oddziaływań. Nie buduje ani nie uruchamia kontraktu `prescribed_zeeman_mask`.

### 6.2 Krytyczna luka FEM CPU reference

Runner potrafi obliczyć `combined_antenna_zeeman_mask_field_at_time(...)`, ale inicjalizacja problemu ustawia `per_node_field` tylko wtedy, gdy `compute_per_unit_antenna_fields(...)` zwróci dane. Ta funkcja dodaje pola wyłącznie dla modelu `mqs_2p5d_az`; maski `prescribed_zeeman_mask` są pomijane.

W pętli czasowej flaga `has_time_varying` jest również wyliczana jako `!per_unit_antenna_fields.is_empty()`, zamiast uwzględniać `antenna_zeeman_masks`. Skutek:

- statyczna maska może nie zostać wpisana do `per_node_field`;
- czasowa maska nie jest aktualizowana;
- obecność maski w `FemPlanIR` nie jest dowodem pola w RHS LLG.

### 6.3 Krytyczna luka natywnego FEM CPU/GPU

Opis planu przekazywany do natywnego FEM zawiera statyczne `external_field_am` i istniejącą ścieżkę `oersted_field_xyz`, ale nie przekazuje `antenna_zeeman_masks` ani równoważnego bufora regionalnego napędu.

Wybór runtime zachowuje się następująco:

- wymuszone FEM GPU z dowolnym `antenna_field_source` jest jawnie odrzucane;
- tryb pozwalający na fallback wybiera FEM CPU;
- wybrany natywny FEM CPU nadal nie ma kontraktu konsumpcji maski.

Fallback jest więc niebezpieczny semantycznie: może zmienić urządzenie, ale nie naprawia brakującego oddziaływania.

### 6.4 Obserwowalne `H_ant`

`H_ant` istnieje w katalogu quantities i w UI. Runner może obliczyć podgląd maski dla `t=0`, podczas gdy natywny RHS nie dostaje tej maski. Widoczne `H_ant` nie może być traktowane jako dowód, że dokładnie to samo pole uczestniczyło w LLG.

Brakuje bramki sprawdzającej jednocześnie:

1. analityczne `H_ant` w węzłach;
2. wkład do `H_eff`;
3. zmianę energii Zeemana;
4. zmianę trajektorii `m(t)`;
5. zgodność CPU/GPU;
6. zgodność pola wyświetlanego z polem użytym przez solver.

### 6.5 Próbowanie funkcji czasu w Rungego-Kutcie

Referencyjny FDM CPU aktualizuje maskę przed zaakceptowanym krokiem, używając `state.time_seconds`, a następnie przekazuje stałe `per_node_field` do całego kroku integratora. Nie ma dowodu ewaluacji waveformu w czasach podetapów `t_n + c_i dt`.

Dla szybkozmiennego `sinc` i RK4/RK23/RK45 oznacza to zamrożenie pola na cały krok i brak udowodnionego rzędu czasowego. Docelowy natywny kontrakt musi ewaluować skalarny waveform w każdym podetapie RK bez przebudowy maski przestrzennej.

## 7. PBC i wyniki istniejących bramek

Nota `docs/physics/0600-periodic-boundary-conditions.md` nadal ma status `draft` i opisuje FEM static/time-domain PBC jako ograniczoną ścieżkę k=0. Pełna promocja wymaga m.in. dowodów z-padding i primitive-vs-supercell. Zielona pojedyncza receptura nie usuwa tych ograniczeń.

Uruchomione 2026-07-15:

### CPU

`just verify-fem-periodic-antidot-relaxation-runtime` — PASS.

- dokładny przypadek `exchange_coupled` uruchomiono na `fem_cpu_native`;
- 20 188 węzłów, 113 092 tetraedry;
- 43 kroki;
- zatrzymanie na `max_torque_apm = 4.6222e2 A/m` przy progu `5.0e2 A/m`;
- `final_time = 0.0`, ponieważ był to etap minimizacji.

### GPU

`just verify-fem-periodic-antidot-relaxation-gpu-runtime` — receptura PASS.

- dokładny przypadek `exchange_coupled` uruchomiono na `fem_native_gpu`;
- 20 142 węzły, 112 756 tetraedrów;
- zakończenie po `max_steps=100`, nie po kryterium momentu;
- końcowy `max_torque[T] = 1.2529e-1`, więc nie jest to dowód osiągnięcia tego samego progu równowagi co CPU;
- `final_time = 0.0`.

Wniosek: bazowy przykład materializuje się i uruchamia relaksację PBC na CPU/GPU, ale GPU dla `exchange_coupled` nie osiągnęło zadanego kryterium równowagi w 100 krokach. Żadna z tych bramek nie wykonuje LLG z impulsem `sinc`.

## 8. Control Room i OpenAPI

### 8.1 Dostępne elementy

- Inspector Study pozwala edytować statyczny globalny `B_ext` w teslach.
- UI potrafi dodać etap `run` z `until_seconds`.
- Istnieje obiekt anteny, panel amplitudy/kierunku i wybór `constant`, `sinc_pulse` lub `sinusoidal`.
- `H_ant` jest widoczne w wyborze quantities.

### 8.2 Krytyczna niezgodność zapisu źródła

Control Room tworzy moduł o polach:

```text
B, direction, id, kind, model, name, object, spatial_profile, waveform
```

i wysyła go jako `current_modules.modules` przez ogólny `merge_patch` sceny.

Backend deserializuje ten sam fragment jako `Vec<ScriptBuilderCurrentModuleState>`, który wymaga:

```text
kind, name, solver, air_box_factor, antenna_kind, antenna_params, drive
```

Po merge backend ponownie deserializuje cały `SceneDocument`; payload UI nie zawiera wymaganych pól `solver`, `air_box_factor`, `antenna_kind` i `drive`. Realny zapis powinien zakończyć się `400 invalid scene patch payload`. Testy UI używają modeli/makiet API i nie wykrywają tej granicy.

### 8.3 Zbyt luźny OpenAPI

OpenAPI publikuje `SceneResource.current_modules` jako dowolny obiekt z `additionalProperties: true`. Wygenerowane typy nie mogą więc wykryć rozjazdu z `ScriptBuilderCurrentModuleState`.

Specyfikacja resource-first definiuje osobne, typowane zasoby:

```text
/v2/sessions/current/model/antennas
/v2/sessions/current/model/field-drives
```

ale nie ma ich w aktualnym routerze/OpenAPI/kliencie. UI omija planowaną granicę zasobową i mutuje surowe `current_modules`.

### 8.4 Etap Run jest mylący

Inspector pokazuje pola `Integrator`, `Fixed timestep` i `Field refresh`, ale serializer etapu `run` zapisuje tylko:

```text
entrypoint_kind, kind, stage_id, until_seconds
```

Te wartości nie trafiają do etapu. Dodatkowo UI wyświetla stwierdzenie „Antenna fields evaluated as time-dependent Zeeman masks”, chociaż natywny FEM tego nie wykonuje.

### 8.5 Brakujące funkcje UI

- wybór celu globalnego, obiektu albo regionu;
- edycja profilu przestrzennego;
- PWL i pełny waveform editor;
- wybór `time_origin` i aktywnych etapów;
- podgląd maski z jednostkami i rewizją;
- stan unsupported/degraded zależny od lane;
- realny smoke UI → API → eksport Pythona → materializacja → runtime;
- dowód, że `H_ant` wyświetlane w viewport jest polem użytym przez solver.

## 9. Zalecany kontrakt docelowy

Nie należy dalej rozszerzać kompatybilnościowego `AntennaFieldSource`. Docelowy kontrakt powinien być źródłem pola magnetycznego niezależnym od pochodzenia pola:

```text
RegionalFieldDrive
  target: global | object | region
  amplitude_B_T: float
  direction: unit vector
  spatial_profile: uniform | sinc | sampled
  waveform: constant | sinusoidal | pulse | piecewise_linear | sinc_pulse
  time_origin: absolute | stage
  active_stage_ids: [...]
```

`AntennaFieldSource(model="prescribed_zeeman_mask")` może pozostać deserializowanym aliasem kompatybilnościowym, ale Python, UI, ProblemIR i API powinny eksportować nowy kontrakt.

W backendzie:

1. planner materializuje niezmienny bufor przestrzenny w węzłach FEM;
2. natywny CPU/GPU przechowuje ten bufor po stronie właściwego backendu;
3. każdy podetap RK oblicza tylko skalarny mnożnik `f(t_n + c_i dt)`;
4. `H_eff`, energia Zeemana i quantity readback używają tego samego bufora;
5. GPU nie wykonuje callbacku Pythona ani kopiowania pełnego pola co krok;
6. provenance zapisuje żądany cel, sampling, waveform, źródło czasu i rozwiązaną lane.

W API/UI:

1. wdrożyć typowany `/model/field-drives`;
2. oddzielić geometrię anteny od napędu pola;
3. generować typy OpenAPI;
4. użyć resource hooków i rewizji sceny;
5. usunąć surowy zapis `current_modules` z komponentów;
6. pokazywać `unsupported` dla FEM do czasu rzeczywistej bramki runtime.

## 10. Minimalny plan domknięcia

### P0 — poprawność kontraktu

1. Uaktualnić notę 0920: część Python/IR/planner jest częściowo wdrożona, checklist jest nieaktualny.
2. Dodać kanoniczny `RegionalFieldDriveIR` z `global/object/region`, `time_origin` i `active_stage_ids`.
3. Zachować jawny adapter starego `prescribed_zeeman_mask`.
4. Naprawić exporter Pythona dla wszystkich waveformów, zwłaszcza PWL.
5. Uzgodnić ogólną quantity dla napędu; `H_ant` zachować jako alias kompatybilnościowy, jeśli źródłem jest antena.

### P1 — natywny FEM CPU

1. Dodać backendowy moduł regionalnego Zeemana, nie logikę fizyczną w runnerze.
2. Przekazać maskę w planie/ABI i złożyć ją z `H_eff`.
3. Ewaluować waveform w każdym podetapie RK.
4. Dodać `H_drive`/`H_ant`, energię i provenance z jednego źródła danych.
5. Usunąć lub fail-closed oznaczyć obecny CPU fallback, dopóki nie konsumuje maski.

### P2 — GPU i PBC

1. Dodać rezydentny bufor FEM GPU i funkcję czasu po stronie urządzenia lub natywnego planu.
2. Udowodnić CPU/GPU parity pola i krótkiej trajektorii.
3. Dodać zarządzaną bramkę dla aktualnego antidotu: relax → import stanu → run z impulsem `sinc`.
4. Osobno domknąć z-padding i primitive-vs-supercell dla PBC; nie włączać tych dowodów milcząco do testu napędu.

### P3 — UI/API

1. Wdrożyć typowany zasób `field-drives`.
2. Dodać editor celu, kierunku, amplitudy, waveformu, czasu i etapów.
3. Dodać podgląd maski oraz `H_drive` z jednostkami.
4. Dodać browser smoke korzystający z prawdziwego backendu, nie tylko mocków.
5. Sprawdzić eksport kanonicznego skryptu i ponowny import bez driftu.

## 11. Wymagane bramki akceptacyjne

1. **Analityczna maska:** globalna maska daje identyczne `B` we wszystkich aktywnych węzłach; maska regionu jest zerowa poza regionem.
2. **Waveform:** sinus, pulse, PWL i sinc zgadzają się z referencją w punktach oraz na granicach.
3. **RK stage time:** test z szybkozmiennym polem wykazuje oczekiwany rząd Heun/RK4/RK23/RK45.
4. **Energia:** `E = -mu0 integral Ms m dot H_drive dV` zgadza się z niezależnym oraklem.
5. **Trajektoria:** wyłączenie źródła daje trajektorię kontrolną; włączenie daje mierzalną, odtwarzalną odpowiedź.
6. **CPU/GPU:** zgodność `H_drive`, energii i krótkiego `m(t)` w double; single dopiero po kwalifikacji.
7. **PBC antidot:** zrelaksowany stan jest rzeczywiście użyty jako stan początkowy run; `final_time > 0`; `H_drive(t)` i `m(t)` są zapisane.
8. **Widmo Γ:** FFT odpowiedzi ma stabilne piki względem kroku i długości symulacji.
9. **Superkomórka:** jeśli celem jest propagacja, pakiet nie jest interpretowany na podstawie pojedynczej komórki.
10. **UI E2E:** utworzenie źródła w UI, zapis przez prawdziwe API, eksport Pythona, materializacja i runtime przechodzą bez ręcznej korekty JSON.
11. **Viewport:** wyświetlone `H_drive` ma tę samą rewizję/provenance co pole użyte przez solver.
12. **Fail closed:** każda nieobsługiwana lane odrzuca problem przed uruchomieniem, bez zerowania źródła i bez mylącego fallbacku.

## 12. Praktyczna rekomendacja dla badanego układu

Na obecnym kodzie nie należy wykonywać publikacyjnej symulacji FEM z `sinc`, nawet jeśli Python wygeneruje poprawny IR lub UI pokaże `H_ant`.

Można bezpiecznie:

1. relaksować wskazany układ statycznym `B_ext` na CPU;
2. użyć wyniku do testów bazowego time-domain FEM bez czasowego napędu;
3. prototypować kształt waveformu i maski na FDM CPU reference, traktując wynik jako referencyjny i kontrolując mały `dt`;
4. implementację produkcyjną rozpocząć od natywnego FEM CPU z jednorodną maską i dopiero potem przenieść na GPU/PBC.

Dla pierwszego testu po implementacji zalecany jest poprzeczny impuls o małej amplitudzie, np. `B0 = 0.1–1 mT`, `cutoff = 20 GHz`, `t0 = 50 ps`, czas obserwacji 1–2 ns, `dt_max <= 0.1 ps` i zapis `m`/`H_drive` co 1–5 ps. Amplitudę trzeba następnie zmniejszyć i potwierdzić liniowość odpowiedzi.

## 13. Wykonana weryfikacja

| Polecenie | Wynik | Co dowodzi |
|---|---|---|
| `PYTHONPATH=packages/fullmag-py/src python3 -m unittest packages/fullmag-py/tests/test_current_transport.py -v` | 12/12 PASS | serializacja i round-trip kompatybilnościowego źródła |
| `cargo test -p fullmag-plan fdm_prescribed_zeeman_mask_antenna_plans_with_extra_geometry` | 1/1 PASS | planowanie maski FDM |
| `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run ...` | 69/69 PASS | cztery modele UI, nie prawdziwa granica API |
| `just verify-fem-time-domain-native-contract` | PASS | natywne integratory i istniejące kontrakty czasowe, bez regionalnego Zeemana |
| `just verify-fem-periodic-antidot-relaxation-runtime` | PASS | bazowa relaksacja PBC CPU, `final_time=0` |
| `just verify-fem-periodic-antidot-relaxation-gpu-runtime` | receptura PASS | bazowa relaksacja PBC GPU; `exchange_coupled` zatrzymany przez `max_steps` |

Nie uruchomiono testu `PBC + FEM + sinc + run`, ponieważ taki zarządzany test nie istnieje, a aktualny runtime jawnie odrzuca GPU i nie ma udowodnionej konsumpcji maski na CPU.

## 14. Najważniejsze pliki źródłowe

- `examples/fem_periodic_antidot_relax_exchange_coupled.py`
- `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
- `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
- `docs/physics/0600-periodic-boundary-conditions.md`
- `docs/physics/0920-regional-time-domain-field-drive.md`
- `docs/specs/capability-matrix-v0.json`
- `docs/specs/problem-ir-v0.md`
- `docs/specs/resource-first-control-room-api-v2.md`
- `packages/fullmag-py/src/fullmag/model/energy.py`
- `packages/fullmag-py/src/fullmag/model/antenna.py`
- `packages/fullmag-py/src/fullmag/world.py`
- `crates/fullmag-plan/src/antenna_zeeman.rs`
- `crates/fullmag-runner/src/antenna_fields.rs`
- `crates/fullmag-runner/src/fem_reference.rs`
- `crates/fullmag-runner/src/native_fem.rs`
- `crates/fullmag-runner/src/dispatch.rs`
- `crates/fullmag-authoring/src/scene.rs`
- `crates/fullmag-authoring/src/builder.rs`
- `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts`
- `apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx`
- `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`
- `apps/control-room/src/modules/inspector/panels/stages/RunStageInspector.tsx`
