# Raport Task 1: zamrożona fizyka racetrack M1

## Wynik

Zamrożono kontrakt `racetrack_m1_v1` dla osi `x=track`, `y=transverse`,
`z=HM→FM`, dodatniego conventional current `+x` i normalnej HM→FM `+z`.
Fixture jest jawnie syntetyczny i nie jest przypisany jednemu rzeczywistemu
materiałowi. Nie zmieniono statusu kwalifikacji żadnej ścieżki GPU.

Commit:

```text
125c9afec02dbce994a702a2693b4de78c1e5732
docs(physics): freeze solved-current racetrack contract
```

## Zmiany

- Dodano pełne równania charge continuity, direct SHE, steady-spin reactions,
  mixing boundary, torque balance i Gilbert LLG oraz kompletną tabelę znaków.
- Dodano wersjonowany fixture z 32 dokładnymi wartościami, jednostkami,
  ograniczeniami, ścieżkami ProblemIR i motywacją literaturową lub benchmarkową.
- Dodano kontrakt `skyrmion_hall_angle_v1`: signed-density centre, dobór okna
  według stabilności prędkości, ważona regresja, covariance,
  `Theta_H=atan2(v_y,v_x)` i reason codes fail-closed.
- Dodano source map obserwabli topological charge oraz jawne
  `planned_not_implemented` symbole Tasks 2–8. Wpisy planowane nie udają
  istniejących deklaracji źródłowych.
- Rozszerzono kanoniczny test dokumentacyjny
  `scripts/test_fdm_gpu_m1_contract_docs.py` o dokładne wartości, równania,
  znaki i ownership przyszłych symboli.

## Korekta ścieżki testu z briefu

Brief wskazywał nieistniejący plik `scripts/test_validate_physics_docs.py`.
Repozytorium posiada kanoniczny, page-specific gate
`scripts/test_fdm_gpu_m1_contract_docs.py`; rozszerzono właśnie ten test.
Nie utworzono drugiego, konkurencyjnego walidatora o podobnej roli.

## TDD RED

```text
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
12 passed, 1 failed, 70 subtests passed
```

Oczekiwany błąd RED: `FileNotFoundError` dla nieistniejącego jeszcze
`tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json`.

## GREEN i walidacja

```text
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
13 passed, 102 subtests passed in 0.35s

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json --repo-root .
PASS

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0940-topological-charge-observable.source-map.json --repo-root .
PASS

python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
Ran 22 tests; OK

python3 -m pytest scripts/test_validate_topological_charge_runtime.py -q
4 passed in 0.05s

python3 scripts/check_public_doc_examples.py --root public_docs/site
Public documentation Python examples passed: public_docs/site

git diff --check
PASS

git show --check --oneline --no-renames HEAD
125c9afec docs(physics): freeze solved-current racetrack contract; PASS
```

## Self-review

- Staging sprawdzono osobnym `git diff --cached --name-only`; commit zawiera
  wyłącznie siedem plików Task 1.
- Niezależna, wcześniejsza zmiana `.superpowers/sdd/progress.md` nie została
  wystage'owana ani zmodyfikowana w ramach Task 1.
- Wszystkie mapowane bieżące źródła mają realną ścieżkę i stabilny symbol;
  przyszłe nazwy są oddzielone w `planned_symbols` z owner task i evidence gate.
- Kontrakt odróżnia implementację, wykonywalność, walidację i kwalifikację.
  Obecność dokumentu, fixture lub testu nie promuje FDM GPU.

## Ograniczenia i dalsze bramki

Task 1 zamraża kontrakt i dane wejściowe. Nie dostarcza publicznego runnera,
bindingu kontekstu, stage checkpointu, provenance, GPU trajectory ani
kwalifikacji workloadu. Te elementy pozostają jawnie przypisane Tasks 2–12 i
wymagają świeżych zarządzanych testów exact-tuple oraz rzeczywistego GPU.

## Korekty po niezależnym review

### Wynik

Zamknięto wszystkie wskazane findingi Critical i Important bez rozszerzania
Task 1 na implementację runtime. Fixture określa teraz jeden kanoniczny wariant
`ProblemIR`: dokładny requested tuple `fdm/gpu/double/strict`, siatkę
`256x64x4`, rozłączne połówotwarte placementy HM/FM, jawnie zorientowane
powierzchnie terminali i izolacji, gauge `zero_mean`, obie strony interfejsu,
trzy deterministyczne maski oraz pełny harmonogram sześciu niezależnych
przebiegów ze wspólnego checkpointu. Równe wymiary HM i FM w osiach `x,y` są
częścią normalizacji, a żadne pole BC, maski, etapu ani execution intent nie
może zostać uzupełnione backendowym defaultem.

Korekta znaku `theta_SH` rozdziela odpowiedź produkcyjnego fixture z `P=0.4`
na `T_P + T_SHE -> T_P - T_SHE`. Dokładna nieparzystość jest testowana tylko
w oracle czystego SHE z jedynym override `P=0`; dokumentacja nie przypisuje
pełnej nieliniowej prędkości dokładnego prawa parzystości.

`skyrmion_hall_angle_v1` zamraża signed-density centre, wszystkie ciągłe okna,
dokładne progi i tie-break, wspólne wagi z podłogą wariancji `1e-18 m2`,
ważoną regresję z interceptem, pełną dwuwymiarową covariance prędkości z
`N-2`, główną gałąź `atan2` i jednoznaczną kolejność reason codes. Nota 0940
ma etykiety i source-map dla wszystkich 15 kanonicznych równań, jawne źródła
path+symbol lub `DOC-ANCHOR` oraz mapę twierdzeń numerycznych. Nowe komórki
symboli i jednostek SI używają składni MyST `$...$`.

### TDD RED review-fix

```text
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
5 failed, 13 passed, 102 subtests passed
```

Pięć nowych testów odtworzyło niezależnie: niepełny fixture/IR, błędny oracle
`theta_SH`, niedeterministyczny kontrakt Hall angle, niepełną source-map 0940
oraz surowe tokeny SI w nowych tabelach.

### GREEN i bramki po korekcie

```text
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
18 passed, 102 subtests passed in 0.29s

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json --repo-root .
PASS

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0940-topological-charge-observable.source-map.json --repo-root .
PASS

python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
Ran 22 tests; OK

python3 -m pytest scripts/test_validate_topological_charge_runtime.py -q
4 passed in 0.05s

python3 scripts/check_public_doc_examples.py --root public_docs/site
Public documentation Python examples passed: public_docs/site

git diff --check
PASS

python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base 125c9afec02dbce994a702a2693b4de78c1e5732 --head HEAD --repo-root .
PASS
```

### Granica kwalifikacji

Korekta pozostaje kontraktem dokumentacyjnym i fixture. Nie stanowi dowodu
wykonania FDM GPU, implementacji `SkyrmionTrajectoryV1` ani
`SkyrmionHallAngleV1`, kalibracji niepewności lub produkcyjnej kwalifikacji
racetrack. Te statusy pozostają `planned_not_implemented`/`unsupported` do
czasu przejścia własnych zarządzanych bramek runtime na dokładnym requested
tuple.

## Korekty po drugim niezależnym review

### Rozstrzygnięcie findingów

1. **Critical — niepełny `normalized_problem_ir_contract`: zamknięty.**
   `fixture.v1.json` zawiera teraz `contract_kind=typed_expected_lowering_map`
   oraz pełny `expected_lowering` dla bieżących serializowanych typów:
   `CurrentModuleIR::CurrentTransport` z modelem `ohmic_poisson`, coupling
   `one_way`, kompletną domeną, materiałami, trzema BC, gauge i solverem;
   `SpinTransportModuleIR` z `current_source_id`, mode `steady`, solverem,
   requested execution i wersją konstytutywną; oraz
   `DriftDiffusionSpinTorque` z `solve_id`, targetem i wersją formuły.
   Kontrakt obejmuje też materiał FM, energy terms `Exchange`, `Demag` i
   `InterfacialDMI` z normalną `+z`, oba `StudyIR`, integrator `rk4`,
   `BackendPolicyIR`, validation profile i runtime selection.

   Test Python buduje te rekordy bieżącymi publicznymi konstruktorami i wymaga
   dokładnej równości ich `to_ir()`. Nowy test integracyjny `fullmag-ir` parsuje
   ten sam JSON bieżącymi typami Rust i sprawdza krytyczne pola po ponownej
   serializacji. Nie utworzono fikcyjnego pola `definition`: charge definition
   pozostaje zgodnie z serde spłaszczona w `CurrentTransport`.

2. **Critical — nieistniejące cele harmonogramu: zamknięty.** Wszystkie ścieżki
   materiałów i interfejsu używają rzeczywistych indeksów tablic ProblemIR.
   Każdy drive zapisuje osobne `problem_ir_overrides` dla
   `current_modules[0].boundaries[0].outward_current_density_Apm2` oraz
   `current_modules[0].boundaries[1].outward_current_density_Apm2`. Usunięto
   `boundaries[current_sweep]`. Indeksy etapów `1..6`, `entrypoint_kind=flat_run`,
   czas, krok i sampling pozostają częścią jawnego kontraktu workflow.

   Publiczne rekordy charge/spin/torque i obiekt pomocniczy HM są dziś
   reprezentowalne, natomiast publiczny `Problem` nie potrafi jeszcze wyrazić
   mutacji BC pomiędzy etapami ani restartu każdego drive z nazwanego
   checkpointu. `public_lowering_boundary` zamraża dokładnie te dwie luki;
   sześcioprzebiegowy harmonogram nie udaje pola bieżącego ProblemIR.

3. **Important — niedostatecznie dokładne testy semantyki: zamknięty.** Testy
   wymagają teraz literalnie charge continuity i znaku `E=-grad V`, kolejności
   indeksów `epsilon_ika` direct SHE i implikacji `Q_zy>0`, wszystkich trzech
   steady reactions, orientacji `n=+e_z`, definicji skoków i znaków mixing BC,
   ujemnego prefaktora torque bez `R_sf` oraz pełnego jawnego Gilbert RHS.
   Zakres forbidden jest dokładnie zamrożony dla CPU, FP32, prescribed torque,
   prescribed current density, Oersted, iSHE, M2, M3, MTJ, PBC, thermal noise i
   multi-GPU.

4. **Important — surowe tokeny SI w nowych wierszach: zamknięty.** Nowe wiersze
   `m`, `alpha`, `B_eff`, `T_P` i `T_SHE` w 0970 używają `$...$` zarówno dla
   symbolu, jak i jednostki. Jeden test pilnuje nowych tabel maszynowych 0940 i
   0970 bez globalnego odrzucania legalnego MathJax w pozostałej, starszej
   treści.

### TDD RED drugiego review

```text
python3 -m unittest scripts.test_fdm_gpu_m1_contract_docs.RacetrackM1PhysicsContractDocsTests
Ran 10 tests
FAILED (failures=6, errors=2)

KeyError: 'contract_kind'
KeyError: 'stage_index'
forbidden_fallbacks: brak iSHE/M2/M3/MTJ/PBC/thermal/multi-GPU
raw math cells: m, alpha, B_eff, T_P, T_SHE

cargo test -p fullmag-ir --test racetrack_m1_fixture
FAILED: contract_kind left None, right typed_expected_lowering_map
```

RED był kontrolowany: oba testy skompilowały się i zatrzymały dokładnie na
brakujących polach fixture, nie na błędzie importu, składni ani zależności.

### GREEN drugiego review

```text
python3 -m unittest scripts.test_fdm_gpu_m1_contract_docs.RacetrackM1PhysicsContractDocsTests
Ran 10 tests; OK

cargo test -p fullmag-ir --test racetrack_m1_fixture
1 passed; 0 failed

python3 scripts/test_fdm_gpu_m1_contract_docs.py
Ran 22 tests; OK

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json --repo-root .
PASS

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0940-topological-charge-observable.source-map.json --repo-root .
PASS

python3 -m unittest discover \
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
Ran 22 tests; OK

python3 -m pytest scripts/test_validate_topological_charge_runtime.py -q
4 passed

python3 scripts/check_public_doc_examples.py --root public_docs/site
Public documentation Python examples passed

python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py \
  --base ccd22952b8422814999d44bfca5874a2d59fabda --head HEAD --repo-root .
PASS

git show --check --oneline --no-renames HEAD
PASS
```

### Granica dowodu po korekcie

Korekta dowodzi dokładności bieżących nazw i kształtów wire przez publiczne
lowering Python oraz parser Rust. Nie dowodzi publicznej wykonywalności pełnego
workflow, materializacji masek, mutacji etapów, restartu, działania GPU ani
kwalifikacji fizycznej. Status pozostaje kontraktowy do przejścia dalszych
bramek Tasks 2--12.

## Końcowa korekta prawdziwości Task 1

### Zamknięte findingi

1. Każdy `problem_ir_path` używa wyłącznie rzeczywistych nazw pól i liczbowych
   indeksów tablic. Publiczny lowering buduje kompletną, parsowalną projekcję
   `ProblemIR` przez `Box`, `Translate`, `Material`, `Ferromagnet` i `Problem`.
   Kolejność geometrii jest rzeczywistą kolejnością serializacji `[fm, hm]`;
   oba boksy są przetłumaczone do fixture bounds zaczynających się w
   `[0,0,0]`, a rozmiary są pod `geometry.entries[*].base.size`. Materiał FM
   ma indeks `materials[0]`. Resolver testu dereferencjonuje wszystkie 32
   ścieżki; dla 26 parametrów nie-workflow wymaga też dokładnej wartości.
   Sześć amplitud drive pozostaje jawnymi override tego samego istniejącego
   pola terminala, nie sześcioma jednoczesnymi wartościami bazowego ProblemIR.

2. Planned source map odpowiada planowi path+owner Task: Task 2 wskazuje
   `crates/fullmag-ir/src/spin_transport.rs`, Task 7
   `crates/fullmag-runner/src/artifacts.rs`, a oba symbole Task 8 planowany
   `crates/fullmag-api/src/analysis/skyrmion_trajectory.rs`. Test wymaga całej
   dokładnej mapy Tasks 2--8 i dopuszcza nieistniejącą ścieżkę wyłącznie wtedy,
   gdy plan deklaruje ją dosłownie jako `Create`.

3. Rust fixture deserializuje cały `expected_lowering` jako `ProblemIR`, parsuje
   osobno `GeometryIR` i `ValidationProfileIR`, a requested runtime sprawdza w
   rzeczywistym miejscu `ProblemMeta.runtime_metadata["runtime_selection"]`.
   README i nota 0970 opisują dokładnie tę granicę. Jeden bazowy
   `TimeEvolution` jest bieżącym `StudyIR`; relaksacja i sześć restartowanych
   drive nadal są zewnętrznym kontraktem workflow, nie fikcyjną tablicą etapów
   ProblemIR.

### Kontrolowany RED

```text
python3 -m unittest scripts.test_fdm_gpu_m1_contract_docs.RacetrackM1PhysicsContractDocsTests
Ran 10 tests
FAILED (failures=2, errors=1)

KeyError: 'geometry'
geometry_entry_order: ['hm', 'fm'] != ['fm', 'hm']
planned path/owner mapping: Task 2/7/8 mismatch

cargo test -p fullmag-ir --test racetrack_m1_fixture
1 failed
ProblemIR.ir_version must be a string
```

Oba testy skompilowały się lub załadowały fixture i zatrzymały dokładnie na
niepełnym typowanym lowering oraz błędnych mapowaniach. Dodatkowy RED z
self-review wymusił rzeczywiste placementy obu centrowanych `Box`:

```text
test_racetrack_expected_lowering_matches_public_python_dsl
FAILED: expected HM kind 'translate', got 'box'
```

### Świeże GREEN i bramki przed commitem

```text
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
22 passed, 151 subtests passed in 0.71s

cargo test -p fullmag-ir --test racetrack_m1_fixture
1 passed; 0 failed

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json --repo-root .
PASS

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0940-topological-charge-observable.source-map.json --repo-root .
PASS

python3 -m unittest discover \
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
Ran 22 tests; OK

python3 -m pytest scripts/test_validate_topological_charge_runtime.py -q
4 passed in 0.04s

python3 scripts/check_public_doc_examples.py --root public_docs/site
Public documentation Python examples passed: public_docs/site

git diff --check
PASS
```

```text
python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py \
  --base 1b981ecd36447aaf6766c41a649da10fd8f7cd25 --head HEAD --repo-root .
PASS

git show --check --oneline --no-renames HEAD
PASS
```

### Granica dowodu

Ta korekta dowodzi istnienia i typu ścieżek, zgodności publicznego loweringu z
fixture oraz zgodności future-owner mapy z zaakceptowanym planem. Nie dowodzi
wykonania transportu, materializacji masek, etapowego restartu, działania CUDA
ani kwalifikacji fizycznej. Nie zmieniono równań ani statusu capability.

## Korekta czterech Important findings po review Task 1

### Zamknięty zakres

1. Fixture i rzeczywisty publiczny lowering używają dokładnie
   `SpinSolverPolicy(engine="native_m1_v1")`. Test odrzuca `auto`, `gmres`,
   nieobecny jawny zakaz fallbacku oraz każdą rozbieżność pełnej projekcji
   `Problem.to_ir()`.
2. Kanoniczny stan początkowy jest rzeczywistym publicznym
   `fm.texture.neel_skyrmion(...).with_mapping(space="world").translate(...)`,
   serializowanym jako `magnets[0].initial_magnetization` typu
   `preset_texture`. Fixture, nota i README zamrażają centrum, promień, szerokość
   ściany, chirality, helicity, parametr polaryzacji, profile, normalizację,
   znak rdzenia/tła i radialnie outward ścianę. Próbki środka, ściany i dalekiego
   tła przechodzą przez bieżący publiczny evaluator, a pełny wire jest
   porównywany z aktualnym publicznym loweringiem.
3. `skyrmion_hall_angle_v1` nie deklaruje już nieistniejących wariancji pozycji.
   Bieżący planowany producer signed-density moment nie wytwarza statystycznej
   niepewności próbki, dlatego kontrakt jawnie wybiera
   `weight_policy=equal_weight_v1`, `w_n=1`, estymuje pełną macierz kowariancji z
   reszt obu współrzędnych i zachowuje dokładny zestaw pól próbki oraz
   proweniencji wejściowej.
4. Dokładna lista zabronionego zakresu obejmuje teraz `adaptive_geometry`.
   Fixture, nota, README i test wymagają niezmiennej geometrii, siatki, masek i
   indeksowania komórek we wszystkich sześciu drive.

### Kontrolowany RED

```text
PYTHONPATH=packages/fullmag-py/src \
python3 -m unittest scripts.test_fdm_gpu_m1_contract_docs.RacetrackM1PhysicsContractDocsTests

Ran 11 tests
FAILED (failures=2, errors=1)

expected solver engine: native_m1_v1; actual public lowering: auto
forbidden_fallbacks: missing adaptive_geometry
KeyError: 'weight_policy'
```

RED ładował bieżące publiczne klasy i fixture; zatrzymał się dokładnie na trzech
lukach kontraktu, nie na imporcie, składni ani zależności. Po materializacji
publicznego seedu pozostały wyłącznie oczekiwane braki dokumentacyjne, które
zamknięto bez dodawania nowej klasy Python lub fikcyjnego pola ProblemIR.

### Świeże GREEN i pełne bramki

```text
PYTHONPATH=packages/fullmag-py/src \
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
23 passed, 151 subtests passed in 0.67s

cargo test -p fullmag-ir --test racetrack_m1_fixture
1 passed; 0 failed

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json --repo-root .
PASS

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0940-topological-charge-observable.source-map.json --repo-root .
PASS

python3 -m unittest discover \
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
Ran 22 tests; OK

python3 -m pytest scripts/test_validate_topological_charge_runtime.py -q
4 passed in 0.06s

python3 scripts/check_public_doc_examples.py --root public_docs/site
Public documentation Python examples passed: public_docs/site

python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py \
  --base ec0610144fbac13292c0d636379adb5699936e1e --head HEAD --repo-root .
PASS

git diff --cached --check
PASS

git show --check --oneline --no-renames HEAD
5cb0518f3 docs(physics): correct racetrack seed and Hall contract
```

### Commit i granica dowodu

Commit: `5cb0518f3` (`docs(physics): correct racetrack seed and Hall contract`).
Indeks zawierał wyłącznie cztery artefakty dokumentacji/source map, test
kontraktowy oraz fixture z README. Istniejący, obcy
`.superpowers/sdd/progress.md` pozostał poza indeksem i bez zmian tego zadania.

Ta korekta dowodzi dokładności kontraktu dokumentacyjnego, bieżącego publicznego
loweringu Python, parsowalności typed `ProblemIR`, deterministycznej definicji
regresji i jawnego fail-closed scope. Nie uruchamia workloadu, nie dowodzi
transportu charge/spin, masek, restartu etapów, runtime CUDA ani produkcyjnej
kwalifikacji. Status pozostaje planowany i niekwalifikowany do zamknięcia Tasks
2--12.

## Końcowa korekta kompletności source map Task 1

### Zakres i wynik

- Mapa 0940 obejmuje teraz wszystkie normatywne reguły
  `skyrmion_hall_angle_v1`: dokładne progi okna, pełną enumerację kandydatów i
  tie-break, equal-weight WLS z interceptem, kowariancję reszt i prędkości,
  wymagania proweniencji oraz precedencję reason codes. Każdy wpis Task 1 ma
  jawnego właściciela i odsyła do istniejącego `DOC-ANCHOR` ze statusem
  `planned_contract`.
- Symbol $N$ pozostaje wyłącznie liczbą przekrojów profilu FEM. Próbki okna
  Halla używają wszędzie $N_w$; mapa zawiera też brakujący symbol
  $Q_{\mathrm{med}}$.
- Istniejące równanie `fdm-gpu-m1-neumann-compatibility` jest mapowane przez
  bieżący kernel CUDA `label_reference_components_kernel`, actual-device test
  `gpu_m1_charge_uniform_v1_contract.cpp::main` oraz preflight runnera
  `validate_boundary_faces`. Status dowodu równania to
  `source_and_actual_device_tests`; nie zmieniono fizyki ani kwalifikacji.
- Test kontraktu sprawdza teraz kierunek dokument -> mapa dla etykiet i claims
  Task 1, zamiast ograniczać się do kierunku mapa -> dokument.

### Kontrolowany RED

```text
PYTHONPATH=packages/fullmag-py/src python3 -m unittest \
  scripts.test_fdm_gpu_m1_contract_docs.RacetrackM1PhysicsContractDocsTests.test_skyrmion_hall_angle_v1_is_fully_deterministic \
  scripts.test_fdm_gpu_m1_contract_docs.RacetrackM1PhysicsContractDocsTests.test_topological_source_map_covers_equations_and_numerical_claims \
  scripts.test_fdm_gpu_m1_contract_docs.RacetrackM1PhysicsContractDocsTests.test_task_1_transport_equations_are_mapped_from_document_to_source_map \
  scripts.test_fdm_gpu_m1_contract_docs.RacetrackM1PhysicsContractDocsTests.test_new_topological_tables_use_myst_inline_math

Ran 4 tests
FAILED (failures=4)
```

RED zatrzymał się wyłącznie na brakach $N_w$, metadata/claims 0940 i wpisie
równania Neumanna 0970; nie wystąpił błąd importu, składni ani zależności.

### Świeże GREEN i bramki

```text
PYTHONPATH=packages/fullmag-py/src \
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
24 passed, 163 subtests passed in 0.85s

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0940-topological-charge-observable.source-map.json --repo-root .
PASS

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json --repo-root .
PASS

python3 -m unittest discover \
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
Ran 22 tests; OK

python3 -m pytest scripts/test_validate_topological_charge_runtime.py -q
4 passed in 0.07s

python3 scripts/check_public_doc_examples.py --root public_docs/site
Public documentation Python examples passed: public_docs/site

python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py \
  --base 5cb0518f3 --head HEAD --repo-root .
PASS

git diff --check
PASS

git diff --cached --check
PASS

git show --check --oneline --no-renames HEAD
cb103405c docs(physics): complete racetrack source maps
```

### Commit i granica dowodu

Commit: `cb103405c5716ea7e6ef4696bcd1e2ba52437d64`
(`docs(physics): complete racetrack source maps`). Osobna inspekcja indeksu
wykazała dokładnie pięć plików dokumentacji, source map i testu. Raport oraz
istniejący, obcy `.superpowers/sdd/progress.md` pozostały poza indeksem.

Ta korekta zamyka wyłącznie kompletność i identyfikowalność source map. Nie
implementuje `SkyrmionTrajectoryV1` ani `SkyrmionHallAngleV1`, nie uruchamia
racetrack workloadu i nie promuje żadnej ścieżki GPU do stanu validated lub
production-qualified.

## Końcowa korekta review: MyST dla wierszy Neumanna

### Zakres i przyczyna

Review wykazał, że nowe wiersze maszynowej tabeli symboli 0970 dla `$b_K$`,
`$K$`, `$C$` i `$\bar V_C$` nie stosowały składni MyST `$...$` konsekwentnie
w komórkach symbolu i jednostki SI. Istniejący test sprawdzał wcześniejsze
wiersze, lecz pomijał te cztery identyfikatory.

### Kontrolowany RED

```text
PYTHONPATH=packages/fullmag-py/src \
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q

4 failed, 24 passed, 163 subtests passed
```

Po rozszerzeniu istniejącego testu o `b_K`, `K`, `C` i `V_bar_C` każde
niepowodzenie wskazało dokładnie brak delimitatorów w komórce LaTeX tych
wierszy.

### GREEN i bramki

```text
PYTHONPATH=packages/fullmag-py/src \
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
24 passed, 167 subtests passed in 0.69s

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json --repo-root .
PASS (exit 0)

git diff --check
PASS (exit 0)
```

Zmiana pozostaje czysto dokumentacyjna: nie zmienia równań, source map,
implementacji runtime ani statusu kwalifikacji FDM GPU.
