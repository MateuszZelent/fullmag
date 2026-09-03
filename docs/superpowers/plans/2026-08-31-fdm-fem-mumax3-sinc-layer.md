# Plan porównania FDM/FEM/MuMax3 dla warstwy Py z impulsem sinc

> **Dla wykonawców agentowych:** przed zakończeniem każdej fazy uruchom wskazaną weryfikację i zachowaj jej wynik w artefaktach eksperymentu.

**Cel:** uruchomić identyczny problem `500 nm x 500 nm x 10 nm` bez PBC w FDM,
FEM i MuMax3, najpierw wykonać tę samą relaksację, zapisać stan końcowy oraz
porównać energie po relaksacji i po dokładnie `4 ns` dynamicznego przebiegu.

**Architektura:** wspólny skrypt Fullmag przełącza jawny backend, urządzenie i
realizację demagu; niezależny skrypt MuMax3 odwzorowuje ten sam wzór pola. W
macierzy porównawczej są FDM CPU/GPU, FEM Poisson–Robin CPU/GPU, FEM
Fredkin–Köhler CPU/GPU oraz MuMax3 GPU. Geometria i fizyka pozostają wspólne;
różnią się tylko dyskretyzacja FDM/FEM oraz wybrana realizacja demagu.
Wyniki są parsowane do tabel skalarów poza checkoutem.

**Technologie:** Python DSL Fullmag, canonical ProblemIR, managed FEM
`just`/Docker Desktop, MuMax3, CSV/JSON, testy `unittest`.

## Ograniczenia globalne

- Nie modyfikować produkcyjnych solverów, API ani istniejących dirty changes.
- Nie dodawać `save("m")`, `snapshot`, `autosave(m)` ani równoważnego zapisu pól.
- Dla FEM najpierw użyć repozytoryjnej ścieżki container-backed `just`; nie
  budować hostowym `cargo`/`cmake` ani ręcznym `docker compose`.
- Zachować źródło, stan dirty worktree, hash manifestu runtime i identyfikator
  urządzenia w metadanych.
- Wszystkie raporty i dokumenty pisać po polsku; kod i nazwy symboli po angielsku.

## Zadanie 1: test kontraktu konfiguracji

**Pliki:**

- `tests/fem_fdm_mumax3_sinc_layer/__init__.py`
- `tests/fem_fdm_mumax3_sinc_layer/test_contract.py`

Najpierw napisać test, który ładuje `fullmag_case.py` dla obu jawnych backendów
i asercjami sprawdza IR: `500e-9`, `2.5e-9`, `200x200x1`, brak PBC, materiał Py,
`B=(0.1,0,0)`, globalny uniform `RegionalFieldDrive`, `cutoff=10e9`,
`t0=2e-9`, aktywację tylko w dynamicznym stage, automatyczny Nyquist guard
`1.3`, `T=4e-9`, listę energii i brak wyjść typu field. Test musi również
wymagać identycznej kolejności `relax → save_state → table_autosave → run`
dla FDM i FEM, algorytmu `llg_overdamped`, `tolT=1e-5`, `max_steps=50000`,
zapisu artefaktu `relaxed_state` oraz tego samego zestawu kolumn tabeli.
Dla FEM test wymaga zachowania pierwotnego układu: Poisson–Robin używa jednej
warstwy elementów `prism6` przez grubość, z trójkątną siatką ściany i bez
zmiany rozmiaru komórki 2.5 nm w płaszczyźnie. Fredkin–Köhler jest osobnym
wariantem body-only z jawną siatką tetraedryczną; jego inna siatka i operator
demagu są jedynymi zamierzonymi różnicami względem Poisson–Robin. Nie wolno
podmieniać wariantu prism na all-tet/P2 tylko po to, aby uzyskać inny profil
dokładności.

**Weryfikacja:** uruchomić test przed implementacją i potwierdzić kontrolowaną
czerwoną fazę, następnie po implementacji:

```text
python -m unittest tests.fem_fdm_mumax3_sinc_layer.test_contract
```

## Zadanie 2: skrypt wspólnego przypadku Fullmag

**Plik:** `tests/fem_fdm_mumax3_sinc_layer/fullmag_case.py`

Zaimplementować jedną funkcję konfigurującą wspólny problem. Backend wybierać
wyłącznie przez `FULLMAG_SINC_LAYER_BACKEND`, realizację FEM przez
`FULLMAG_SINC_LAYER_DEMAG`; brak lub inna wartość ma kończyć się błędem. Dla
FDM ustawić `engine("fdm")`, jawny device w double, manual universe dokładnie
wielkości warstwy, `cell(2.5 nm, 2.5 nm, 10 nm)` i otwarty demag. Dla FEM
Poisson–Robin ustawić `engine("fem")`, jawny device z env, airbox `1 um`, jego
mesh `50..100 nm` oraz swept-prism mesh: `2.5 nm`, `through_thickness_elements=1`,
`sweep_face_meshing="triangular"`, `element_family="prism"` i `order=1`.
Dla Fredkin–Köhler jawnie wyłączyć airbox i użyć body-only free-tetrahedral
mesh P1. Brak wykonawczego operatora FK nie może być maskowany fallbackiem do
Poisson–Robin ani CPU przy żądaniu GPU.

Zdefiniować `Py`, stan `+x`, bias `+x` oraz poprzeczny uniform sinc `1 mT +y`.
FDM i FEM wykonują w tym samym skrypcie relaksację z wyłączonym napędem,
zapisują `relaxed_state`, a następnie uruchamiają dynamiczny benchmark od tego
stanu przez dokładnie 5000 kroków do `until=4e-9` (`dt=0.8 ps`). Tabela ma tylko
kolumny skalarne: czas/krok, trzy średnie magnetyzacji i wszystkie terminy
energii. Nie wywoływać żadnego zapisu pola.

**Weryfikacja:** test kontraktu, eksport IR dla FDM/FEM oraz syntaktyczne
uruchomienie loadera bez solve.

## Zadanie 3: niezależny skrypt MuMax3

**Plik:** `tests/fem_fdm_mumax3_sinc_layer/mumax3_case.mx3`

Ustawić `SetGridSize(200,200,1)`, `SetCellSize(2.5e-9,2.5e-9,10e-9)`,
`SetPBC(0,0,0)`, parametry Py, `m=uniform(1,0,0)`, bias `100 mT` i
`B_ext=vector(100e-3, 1e-3*sinc(2*pi*10e9*(t-20/fcut)), 0)`. Wykonać
`minimize()` z `MinimizerStop=1e-5` i `MinimizeMaxSteps=50000`, zapisać
wiersz końca relaksacji, a następnie uruchomić identyczny dynamiczny czas
`40/fcut` przez 5000 kroków (`FixDt=0.8 ps`) z
`tableautosave(1/(2*1.3*fcut))`. Dodać do tabeli magnetyzację i `E_exch`,
`E_demag`, `E_zeeman`, `E_anis`, `E_total`; nie używać `save(m)` ani
`autosave(m)`.

**Weryfikacja:** parser tekstu sprawdza brak `PBC` innych niż zero, brak zapisów
pola, obecność wzoru sinc i nominalnego okresu tabeli.

## Zadanie 4: parser i porównanie tabel

**Plik:** `scripts/analysis/compare_fdm_fem_mumax3_sinc_layer.py`

Dodać parser tabel Fullmag i MuMax3, walidację nazw/jednostek oraz normalizację
kolumn. Wygenerować CSV z wierszami `time_s, backend, mx, my, mz` oraz energią
każdego backendu. Zbudować tabelę porównawczą po wspólnej osi czasu; gdy czasy
nie są identyczne, użyć jawnej interpolacji liniowej i oznaczyć ją w metadanych.
Policzyć końcowe i maksymalne różnice `L_inf` dla `mx/my/mz` oraz osobno dla
energii. Mapowanie MuMax `E_zeeman` na `e_ext+e_drive` ma być zapisane w raporcie.

**Weryfikacja:** test parsera na małym fixture z nagłówkami obu formatów,
odrzucenie brakujących kolumn i odrzucenie wykrytego snapshotu pola.

## Zadanie 5: przygotowanie managed runtime i uruchomienie

Najpierw sprawdzić aktywne procesy i wolne miejsce. Następnie użyć:

```text
just ensure-managed-fem-runtime
```

FEM Poisson–Robin uruchomić przez kanoniczny
`scripts/windows/run_fullmag_fem.ps1` z `BuildMode=true` (a po zbudowaniu
ponownie `BuildMode=false`), `Backend=fem`, osobno dla CPU i GPU,
`RunMode=headless`, po przygotowaniu runtime container-backed. FDM uruchomić
przez repozytoryjny headless launcher osobno dla CPU i GPU. MuMax3 uruchomić z
`mumax3 -gpu 0` i dedykowany katalog wyników poza checkoutem. Warianty FEM
Fredkin–Köhler pozostają `NOT VERIFIED`, dopóki runtime nie ma gotowego
operatora CPU/GPU dla tego przypadku.

Nie zatrzymywać istniejących kontenerów innych prac. Każdy przebieg zapisać z
logiem stdout/stderr, źródłem, manifestem urządzenia i ścieżką tabeli.

## Zadanie 6: raport i bramki końcowe

**Artefakty poza repo:** osobne katalogi `fdm`, `fem`, `mumax3`, `comparison`
z tabelami skalarów, logami i metadanymi. Opcjonalny raport repozytoryjny:
`docs/audits/2026-08-31-fdm-fem-mumax3-sinc-layer-results.md` tylko po
rzeczywistym przebiegu.

Raport ma zawierać parametry, trasy wykonania, hash źródła/runtime, liczbę
wierszy, kolumny, czas końcowy, osobną tabelę `po relaksacji` i osobną tabelę
`po 4 ns` dla `avg mx/my/mz` oraz wszystkich energii. Każda niepełna lub
nieporównywalna część, w szczególności FEM Fredkin–Köhler przed implementacją
operatora, otrzymuje `NOT VERIFIED`.

**Weryfikacja końcowa:**

```text
python -m unittest tests.fem_fdm_mumax3_sinc_layer.test_contract
python scripts/analysis/compare_fdm_fem_mumax3_sinc_layer.py --verify-only ...
```

Przed końcowym komunikatem ponownie sprawdzić `git status --short`, listę
zmienionych plików i brak artefaktów pola magnetyzacji. Nie wykonywać commit,
push, reset ani cleanupu cudzych zmian.
