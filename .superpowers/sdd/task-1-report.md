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
