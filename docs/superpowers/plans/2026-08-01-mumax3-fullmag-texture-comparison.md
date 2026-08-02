# Plan ilościowego porównania końcowej tekstury MuMax3 i Fullmaga

> Zakres tego planu obejmuje wyłącznie końcowy, zeropolowy stan równowagowy po `relax()`/`minimize()` w MuMax3 i po `relax` w Fullmagu. Dynamika, trajektorie czasowe i pierwsze przejście przez `<mx>=0` są poza zakresem.

## Status realizacji — 2026-08-02

Zrealizowany został offline'owy rdzeń porównania oraz kontrakt zapisu końcowego
stanu:

- MuMax3/amumax: `/home/kkingstoun/git/3/build/mumax3`, jawny przebieg
  `relax(); save(m); tablesave()` i natywny `-storage-format=zarr`;
- Fullmag: etap `add_save_state(... dataset="m")` po relaxacji i `fields=[]`
  w scenariuszu PG-BB;
- Python: loader MuMax3 `(t,z,y,x,component)`, loader Fullmag `(node,3)`,
  dokładna restrykcja jednowarstwowego `prism6` oraz metryki komponentowe i
  wektorowe w `fullmag.analysis`;
- CLI: `scripts/compare_relaxed_magnetization.py`;
- testy modułu porównania: `8 passed` po naprawie całkowania przyciętych
  wielokątów i dodaniu regresji kolejności węzłów; testy scenariusza i
  collect-results: `65 passed`; walidator noty
  naukowej: PASS.

Świeża para produkcyjna została wykonana bez dynamiki:

- amumax `/home/kkingstoun/git/3/build/mumax3` (v3.11.2, commit `13ac56f1`)
  wykonał czysty skrypt `relax(); save(m); tablesave()` z `-s -webui-disable`
  i natywnym `-storage-format=zarr`. Artefakt
  `.fullmag/reports/mumax-fullmag-validation-smoke/amumax-standardproblem4-relax.zarr`
  ma jedną klatkę `m` o shape `(1,1,32,128,3)` oraz osobne kanały tabeli
  `mx,my,mz`; nie użyto konwertera OVF.
- Fullmag wykonał `projected_gradient_bb` przez zarządzaną recepturę
  `just fem-managed-headless gpu`, a następnie końcowy etap
  `flat_save_state`; artefakt `states/relaxed_m.zarr.zip` zawiera wyłącznie
  `m(node,component)` dla 32 075 węzłów.
- CLI zapisał JSON w
  `.fullmag/reports/mumax-fullmag-validation-smoke/comparison/`
  `relaxed-texture-comparison.json`.
- Manifest wejść i komendy znajduje się w
  `.fullmag/reports/mumax-fullmag-validation-smoke/comparison/`
  `amumax-relax-manifest.json`.

Operator restrykcji został poprawiony po kontroli produkcyjnej: dla
czworokątów/pięciokątów powstałych po przecięciu `prism6` z komórką FDM używa
shoelace area-centroid, a nie średniej arytmetycznej wierzchołków. Test
regresyjny wymusza zachowanie całki dla pola afinicznego.

Kontrola produkcyjna wykryła również rozbieżność kolejności węzłów: stan `m`
Fullmaga jest zapisany po re-orderingu wspólnej siatki przez Rust planner,
natomiast `.fullmag-mesh` zachowuje kolejność przed plannerem. Loader korzysta
teraz z pełnego `execution_plan.backend_plan.mesh` z run bundle i odnotowuje
`node_order="native_planner_mesh"`; przy podanym run bundle bez tych metadanych
kończy się błędem zamiast mieszać wartości z innymi współrzędnymi.

Wynik jest ilościowy, ale nie jest jeszcze kwalifikacją zgodności solverów.
Coverage wynosi `0.9999999999984–1.0000000000015`, a względny błąd objętości
`5.52e-15`; błąd całki FEM→Cartesian jest około `5.4e-37`, `3.4e-37` i
`5.9e-41` dla `(x,y,z)`. Po zastosowaniu właściwej kolejności węzłów średnia
restrykcji Fullmaga zgadza się z natywną tabelą do poziomu zaokrąglenia
(`(0.97837365, 0.10333565, 4.4887e-6)`).

Na wspólnej siatce pozostaje fizyczna/numerical różnica obu rozwiązań:
vector RMS `0.0548477`, cosine similarity `0.9984958`, `mx` RMS `0.0299922`,
`my` RMS `0.0459209`, `mz` RMS `8.56e-5`, vector max `0.2411974` i `p99
0.2058739`. Średnie MuMax3 z tekstury i tabeli nadal różnią się tylko o
`3.3e-9` oraz `4.7e-9`. Nie jest to jeszcze physics PASS; potrzebna jest
seria zbieżności z Etapu 9.

Dowód natywnego uruchomienia ma ograniczoną świeżość binarki: zarządzany
runtime, który ukończył przebieg, jest czystym wariantem commit `ada50ce6`
(GPU `RTX 4080 SUPER`, `fem_native_gpu`, CUDA/HYPRE device, bez fallbacku).
Ten wariant poprzedza poprawkę `1066306c` zachowującą solver IR przy finalnym
`save_state`, dlatego przebieg użył jednorazowego wrappera
`/tmp/fullmag-sp4-managed-wrapper.py`, który zmienił wyłącznie przechwycenie
stage IR; nie zmieniał równań, parametrów ani natywnego backendu. Jest to
jawnie oznaczone w manifeście jako ograniczenie świeżości end-to-end runtime.
Budowa runtime z aktualnego HEAD została zablokowana przez niezwiązaną
migrację spin-transport (`coupled_checkpoint`/`MeshIR` API) oraz brak miejsca
na osobnym cache; nie użyto obejścia ani nie nadpisano dirty runtime.

## Cel

Zbudować powtarzalny przepływ w Pythonie, który dla µMAG Standard Problem 4:

1. potwierdza, że oba wejścia są świeżymi, końcowymi stanami relaksacji tego samego problemu fizycznego;
2. porównuje natywne średnie magnetyzacji obu solverów;
3. ogranicza nodalne pole FEM Fullmaga do dokładnych komórek kartezjańskich MuMax3 z zachowaniem całki objętościowej;
4. oblicza ilościowe i przestrzenne metryki różnicy tekstur;
5. rozdziela błąd artefaktu, błąd reprezentacji siatki i rzeczywistą różnicę rozwiązania.

Implementacja planu nie zmienia `ProblemIR`, publicznego authoringu, plannera ani UI. Jest to offline analysis API i workflow walidacyjny SP4.

Warunkiem wejściowym jest zgodność problemu fizycznego, sprawdzana przed porównaniem pola: `500×125×3 nm`, `Ms=800 kA/m`, `Aex=13 pJ/m`, brak anizotropii i pola zewnętrznego, ten sam znormalizowany stan początkowy wynikający z `(1,0.1,0)` oraz ta sama konwencja zredukowanej magnetyzacji. `alpha=0.02` ma zostać zapisane w provenance, ale dla poprawnie osiągniętego minimum nie powinno zmieniać stanu równowagowego.

Oba skrypty muszą jawnie zapisać końcową magnetyzację po relaksacji. W użytym amumax służy do tego `save(m)` po `relax()` (równoważny przebieg można wykonać przez `minimize()`), a `tablesave()` zapisuje końcową średnią. W Fullmagu nie należy używać `film.save(...)`, ponieważ ta metoda zapisuje już załadowany stan obiektu, a nie wynik późniejszego etapu solvera. Istniejącym odpowiednikiem końcowego snapshotu jest `study.stages.add_save_state(...)` bezpośrednio po etapie `relax`. Jedynym zapisywanym polem wektorowym ma być `m` ze wszystkimi trzema komponentami; tabela skalarów pozostaje osobnym dowodem zbieżności i natywnej średniej.

## Stan wyjściowy potwierdzony 2026-08-01

- MuMax3 używa layoutu `m.shape == (t,z,y,x,3)`; osie komponentów mają kolejność `(x,y,z)`.
- Skrypt referencyjny `external_solvers/3/test/standardproblem4.mx3` opisuje
  siatkę `128×32×1` i próbkę `500×125×3 nm`; autorytatywny przebieg tego
  raportu używa osobnego skryptu amumax z `relax(); save(m); tablesave()`.
- Obecny `external_solvers/3/test/standardproblem4.zarr` nie może być wejściem referencyjnym: tablica `m` ma 11 klatek z czasami `0–1 ns`, podczas gdy aktualny skrypt i log nie zawierają etapu dynamicznego. Store łączy dane z różnych uruchomień.
- Istniejący wynik Fullmaga dla projected-gradient BB zawiera końcową średnią około `(0.9783736, 0.1033357, 4.49e-6)`, lecz autosave zapisuje `H_ex`, `H_demag`, `H_eff`, a nie końcowe pole `m`. Jest tylko diagnostyką: nie dowodzi zgodności z aktualną lokalną tolerancją scenariusza i nie pozwala porównać tekstury.
- Magnetyczna część kanonicznego mesha Fullmaga składa się z 16 088 elementów `prism6` w jednej warstwie przez grubość. Airbox zawiera osobne `pyramid5` i `tet4`.
- `tests/standard_problems/mumag/sp4/fem/verify.py::project_midplane` korzysta z punktowej interpolacji `LinearNDInterpolator`. To nie jest zachowujące objętość odwzorowanie FEM→FDM.
- `tests/standard_problems/mumag/sp4/fem/verify.py::relaxation_matrix_metrics` używa `np.mean(values, axis=0)`. Taka średnia po węzłach nie jest fizyczną średnią objętościową FEM.

## Decyzja projektowa

### Wybrane odwzorowanie

Kanonicznym porównaniem nie będzie interpolacja w środkach komórek. Zostanie zbudowany operator restrykcji objętościowej:

```math
\left(R_{FEM\rightarrow FDM}\mathbf m_h\right)_i
=\frac{1}{|C_i\cap\Omega_m|}
  \int_{C_i\cap\Omega_m}\mathbf m_h(\mathbf x)\,dV,
```

gdzie `C_i` jest komórką MuMax3, `Ω_m` domeną magnetyczną, a `m_h` nodalnym polem P1 Fullmaga.

Dla obecnego SP4, jednowarstwowych elementów `prism6` i `Nz=1`, operator może być policzony dokładnie:

1. trójkątną podstawę pryzmatu przycina się do prostokątów komórek MuMax3 w `xy`;
2. całkę liniowych funkcji barycentrycznych liczy się z pola i centroidu przyciętego wielokąta;
3. całkę po `z` liczy się jako średnią wkładów odpowiadających sobie dolnych i górnych węzłów;
4. wagi zapisuje się jako rzadki operator wielokrotnego użycia.

Nie wolno normalizować wektora po uśrednieniu w komórce. Norma mniejsza od jedności jest informacją o zmienności pola wewnątrz komórki.

### Dlaczego nie punktowa interpolacja

Interpolacja w centrum komórki jest przydatna jako szybki obraz diagnostyczny, ale:

- nie zachowuje całki magnetyzacji;
- pomija średnią przez grubość;
- globalna triangulacja SciPy nie respektuje koniecznie elementów i markerów mesha Fullmaga;
- może przypisać błąd interpolacji solverowi.

Wersja pierwsza ma obsługiwać tylko kanoniczny magnetyczny `prism6`, osiowo wyrówniony film i target `Nz=1`. Inna topologia ma kończyć się jawnym błędem. Nie wolno przechodzić automatycznie na `LinearNDInterpolator`.

## Kontrakt średnich i dekompozycja błędu

Natywna średnia FEM musi pochodzić z runtime Fullmaga, gdzie magnetyzacja jest ważona `Ms` i lumped volume:

```math
\langle\mathbf m_h\rangle_{FEM,native}
=\frac{\int_{\Omega_m}M_s(\mathbf x)\mathbf m_h(\mathbf x)\,dV}
       {\int_{\Omega_m}M_s(\mathbf x)\,dV}.
```

Natywna średnia MuMax3 pochodzi z tabeli skalarów tego samego końcowego zapisu. Raport ma pokazać osobno:

```math
\Delta_{native}
=\langle\mathbf m\rangle_{FEM,native}
-\langle\mathbf m\rangle_{MuMax,table},
```

```math
\Delta_{restriction}
=\langle R\mathbf m_h\rangle
-\langle\mathbf m_h\rangle_{FEM,native},
```

```math
\Delta_{storage}
=\langle\mathbf m\rangle_{MuMax,array}
-\langle\mathbf m\rangle_{MuMax,table}.
```

Dopiero po zaakceptowaniu `Δrestriction` i `Δstorage` wolno interpretować `Δnative` oraz lokalne różnice tekstur jako różnicę solverów.

## Pliki docelowe

Nowe moduły i testy:

- `packages/fullmag-py/src/fullmag/analysis/magnetization_comparison.py`
- `packages/fullmag-py/src/fullmag/analysis/fem_cartesian_restriction.py`
- `packages/fullmag-py/tests/test_magnetization_comparison.py`
- `scripts/compare_relaxed_magnetization.py`

Modyfikowane kontrakty i scenariusze:

- `packages/fullmag-py/src/fullmag/analysis/__init__.py`
- `docs/physics/0980-mumag-standard-problem-4-fem-application-validation.md`
- `docs/physics/0980-mumag-standard-problem-4-fem-application-validation.source-map.json`
- `external_solvers/3/test/standardproblem4.mx3`
- `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`
- `tests/standard_problems/mumag/sp4/fem/test_scenarios.py`
- `tests/standard_problems/mumag/sp4/fem/collect_results.py`
- `tests/standard_problems/mumag/sp4/fem/test_collect_results.py`
- `tests/standard_problems/mumag/sp4/fem/verify.py`
- `tests/standard_problems/mumag/sp4/fem/test_contract.py`
- `tests/standard_problems/mumag/sp4/fem/test_relaxation_matrix.py`
- `tests/standard_problems/mumag/sp4/README.md`
- `scripts/run_fem_sp4_scenario.sh`
- `justfile`

## Plan implementacji

### Etap 1 — opisać kontrakt naukowy przed kodem

1. Rozszerzyć `docs/physics/0980-mumag-standard-problem-4-fem-application-validation.md` o:

   - równanie restrykcji FEM→Cartesian;
   - zasady osi, jednostek i kolejności komponentów;
   - definicje trzech różnic średniej;
   - regułę bez renormalizacji po uśrednieniu;
   - ograniczenie v1 do `prism6`, jednej warstwy i `Nz=1`;
   - rozdzielenie natywnego wyniku solvera od wyniku postprocessingu;
   - listę metryk i testów zbieżności.

2. Rozszerzyć source map o przyszłe symbole:

   - `load_mumax_magnetization`;
   - `load_fullmag_fem_magnetization`;
   - `build_prism6_cartesian_restriction`;
   - `restrict_fem_magnetization`;
   - `compare_magnetization_textures`.

3. Najpierw uruchomić walidator i odnotować oczekiwany RED dla brakujących symboli, następnie po implementacji uzyskać PASS:

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0980-mumag-standard-problem-4-fem-application-validation.source-map.json \
  --repo-root .
python3 -m unittest discover \
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
```

Kryterium: dokument jednoznacznie definiuje wynik naukowy, a source map wskazuje ścieżki i symbole realizacji.

### Etap 2 — loader końcowego stanu MuMax3/MMpp

1. Wprowadzić w `magnetization_comparison.py` typy:

```python
@dataclass(frozen=True, slots=True)
class CartesianGrid:
    shape_zyx: tuple[int, int, int]
    bounds_min_m: tuple[float, float, float]
    bounds_max_m: tuple[float, float, float]


@dataclass(frozen=True, slots=True)
class StructuredMagnetization:
    values: np.ma.MaskedArray
    times_s: np.ndarray
    grid: CartesianGrid
    source: str
    source_sha256: str
    axis_order: tuple[str, str, str, str, str] = (
        "t", "z", "y", "x", "component"
    )
    component_order: tuple[str, str, str] = ("x", "y", "z")
```

2. Zaimplementować dwa wejścia:

```python
def load_mumax_magnetization(path: str | Path) -> StructuredMagnetization:
    """Load and validate one final relaxed MuMax3 magnetization snapshot."""


def load_mumax_magnetization(
    path: str | Path,
    *,
    dataset: str = "m",
    require_single_frame: bool = False,
) -> StructuredMagnetization:
    """Load the MMpp/MuMax Zarr contract without importing MMpp."""
```

3. Zachować `t` jako wymiar formatu, ale w tym workflow wymagać dokładnie jednej zaakceptowanej klatki końcowej. Nie wybierać automatycznie „ostatniej” z wieloklatkowego store.

4. Użyć `np.asanyarray`, aby nie zgubić `MaskedArray`. Dla prostokątnego SP4 aktywna maska nie jest wymagana; w częściowo wypełnionej domenie musi być jawna.

5. Walidować:

   - shape `(1,1,32,128,3)` dla kanonicznego przebiegu;
   - osie `(t,z,y,x,component)` i komponenty `(x,y,z)`;
   - skończone wartości i `|m| ≤ 1+1e-5`;
   - zgodność `Nx/Ny/Nz`, `Tx/Ty/Tz`, czasu pola i ostatniego wiersza tabeli;
   - efektywne `Ms=800e3 A/m`, `Aex=13e-12 J/m`, brak pola zewnętrznego i stan początkowy;
   - SHA-256 skryptu, metadanych i store;
   - manifest zakończonego uruchomienia `relax()`/`minimize()`.

6. Dodać test regresyjny, który odrzuca obecny mieszany Zarr z 11 niezerowymi czasami, gdy skrypt/log opisuje wyłącznie stan końcowy bez dynamiki.

Testy:

```bash
PYTHONPATH=packages/fullmag-py/src pytest -q \
  packages/fullmag-py/tests/test_magnetization_comparison.py
```

Kryterium: loader przyjmuje świeży jednoklatkowy fixture, wykrywa zamianę `x/y`, flip osi, złą jednostkę, niespójny czas i stary artefakt.

### Etap 3 — publikacja i loader końcowego pola FEM

1. W `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py` usunąć okresowe zapisy pól `H_ex`, `H_demag` i `H_eff`. Zachować `TableAutosave`, ale pozostawić `fields=[]`, aby w ciągu relaksacji nie powstawały żadne okresowe pola wektorowe.

2. Bezpośrednio po konfiguracji etapu `relax` dodać istniejący etap końcowego snapshotu:

```python
study.stages.add_save_state(
    artifact_name="relaxed_m.zarr",
    format="zarr",
    dataset="m",
)
```

Runtime zapisze jeden stan `(node,component)` jako Zarr ZipStore:

`artifacts/states/relaxed_m.zarr.zip`.

Nie dodawać `fm.FieldAutosave("m", every_steps=...)`: obecny scheduler zapisuje również krok `0`, więc dawałby co najmniej stan początkowy i końcowy zamiast pojedynczego wyniku po relaksacji.

3. Napisać RED test `test_projected_gradient_bb_writes_only_final_m_state`, który sprawdza zmaterializowany stage pipeline:

```python
def test_projected_gradient_bb_writes_only_final_m_state() -> None:
    payload = _export_run_config(
        RELAXATION_SCENARIOS["relax_projected_gradient_bb"]
    )
    relax, save_state = payload["stages"]
    assert relax["entrypoint_kind"] == "flat_relax"
    assert relax["ir"]["study"]["sampling"]["stage_autosave"]["fields"] == []
    assert save_state["entrypoint_kind"] == "flat_save_state"
    assert save_state["action"] == {
        "kind": "save_state",
        "artifact_name": "relaxed_m.zarr",
        "format": "zarr",
        "dataset": "m",
    }
```

Expected RED przed zmianą: scenariusz zawiera trzy pola `H_*` i nie ma etapu `save_state`.

Zmienić również istniejący test parametryczny relaksacji: dla `relax_projected_gradient_bb` oczekiwać sekwencji `flat_relax`, `flat_save_state`, a politykę relaksacji nadal sprawdzać na pierwszym etapie. Pozostałe scenariusze zachowują dotychczasową sekwencję jednego etapu.

W `test_projected_gradient_scenario_requests_one_exact_uniform_prism_layer` zastąpić rozpakowanie `[stage]` przez `relax_stage, save_state_stage`. Sprawdzenia topologii i `StageAutosave` wykonywać na `relax_stage`, a dla `save_state_stage` powtórzyć dokładne sprawdzenie action z testu powyżej. To zapobiega przypadkowemu pominięciu nowego etapu przez istniejący test mesha.

4. Collector nie kopiuje już ostatniej próbki z okresowego autosave. Ma sprawdzić, że `artifacts/states/relaxed_m.zarr.zip` istnieje, dataset `m` ma shape `(n_nodes,3)`, a następnie zapisać obok sidecar manifest walidowany fragmentem JSON Schema:

```json
{
  "type": "object",
  "required": [
    "quantity", "axes", "component_order", "unit",
    "mesh_topology_fingerprint", "magnetic_markers",
    "accepted_step", "native_mean_source", "state_sha256"
  ],
  "properties": {
    "quantity": {"const": "m"},
    "axes": {"const": ["node", "component"]},
    "component_order": {"const": ["x", "y", "z"]},
    "unit": {"const": "1"},
    "mesh_topology_fingerprint": {
      "type": "string", "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "magnetic_markers": {"const": [1]},
    "accepted_step": {"type": "integer", "minimum": 0},
    "native_mean_source": {"const": "scalars.csv"},
    "state_sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"}
  }
}
```

5. Zaimplementować loader:

```python
@dataclass(frozen=True, slots=True)
class FemMagnetizationState:
    values_nc: np.ndarray
    mesh: MeshData
    magnetic_cell_indices: np.ndarray
    active_node_indices: np.ndarray
    topology_fingerprint: str
    accepted_step: int
    native_mean: tuple[float, float, float]
    source: str


def load_fullmag_fem_magnetization(
    state_path: str | Path,
    *,
    mesh_path: str | Path,
    run_bundle: str | Path,
    magnetic_markers: tuple[int, ...] = (1,),
) -> FemMagnetizationState:
    """Load one final FEM m(node,component) state with run provenance."""
```

6. Loader ma otwierać wyłącznie końcowy dataset `m` z `relaxed_m.zarr.zip`, używać `fullmag.meshing.persistence.load_mesh_artifact`, wyznaczać węzły z elementów o markerze magnetycznym i odrzucać:

   - airbox w aktywnej masce;
   - niezgodny fingerprint;
   - inną liczbę lub kolejność węzłów;
   - shape inny niż `(n_nodes,3)`;
   - dodatkowy wymiar czasu lub próbki w artefakcie final-state;
   - obecność innej quantity pola niż `m` w artefakcie final-state;
   - `np.mean` po węzłach jako źródło średniej.

Testy:

```bash
PYTHONPATH=packages/fullmag-py/src:. pytest -q \
  tests/standard_problems/mumag/sp4/fem/test_scenarios.py \
  tests/standard_problems/mumag/sp4/fem/test_collect_results.py \
  packages/fullmag-py/tests/test_magnetization_comparison.py
```

Kryterium: istnieje dokładnie jeden Zarr final-state zawierający wyłącznie `m(node,component)`, związany z końcowym accepted step, właściwym meshem i natywną średnią runtime.

### Etap 4 — dokładna restrykcja `prism6 → Cartesian`

1. Utworzyć `fem_cartesian_restriction.py` z publicznym kontraktem:

```python
@dataclass(frozen=True, slots=True)
class Prism6CartesianRestriction:
    grid: CartesianGrid
    voxel_offsets: np.ndarray
    node_indices: np.ndarray
    node_weights: np.ndarray
    coverage_zyx: np.ndarray
    mesh_fingerprint: str

    def apply(self, values_nc: np.ndarray) -> np.ndarray:
        """Return float64 magnetization with shape (1,z,y,x,3)."""
```

2. Najpierw napisać testy RED dla:

   - stałego pola, które musi zostać zachowane dokładnie;
   - niesymetrycznego pola liniowego, np. `(0.2+0.1x, -0.3+0.2y, 0.4+0.15z)`;
   - dwóch pryzmatów przecinających wiele komórek;
   - odwróconej orientacji elementu;
   - niepełnego coverage;
   - obecności magnetycznego `tet4` lub `pyramid5`;
   - pomieszanej pary węzłów dolnych i górnych;
   - docelowego `Nz>1`.

3. Operator ma:

   - korzystać tylko z `element_markers == magnetic_marker`;
   - wymagać jednorodnego `Ms`, zgodnie z problemem SP4;
   - przed clippingiem przeskalować współrzędne `xy` do indeksowych współrzędnych siatki, aby uniknąć utraty precyzji na polach rzędu `1e-18 m²`;
   - przycinać podstawy trójkątów algorytmem Sutherlanda–Hodgmana;
   - składać rzadkie wagi nodalne raz dla danego fingerprintu mesha i gridu;
   - akumulować w `float64`;
   - przechowywać wagi jako ułamki objętości komórki, dzielić sumę ważoną przez coverage i zapisywać coverage każdej komórki;
   - kończyć się błędem dla nieobsługiwanej geometrii bez fallbacku.

4. Bramki operatora:

   - pola stałe i liniowe: błąd średniej komponentu `≤ 5e-12`;
   - realny mesh SP4: różnica średniej restrykcji i natywnej średniej `≤ 5e-8`;
   - coverage każdej komórki filmu: `|coverage-1| ≤ 5e-12`.

Testy:

```bash
PYTHONPATH=packages/fullmag-py/src pytest -q \
  packages/fullmag-py/tests/test_magnetization_comparison.py
```

Kryterium: operator zachowuje całkę dla pól stałych/liniowych i nie dotyka elementów airboxa.

### Etap 5 — metryki końcowej tekstury

1. Zaimplementować `compare_magnetization_textures(candidate, reference, mask, grid)`.

2. Raportować dla `mx`, `my`, `mz`:

   - bias;
   - MAE;
   - RMSE;
   - p95 i p99 wartości bezwzględnej;
   - maximum absolute error;
   - korelację, albo `null` dla stałej składowej.

3. Raportować dla wektora:

   - vector RMSE;
   - relative L2;
   - średnią cosine similarity;
   - średni, p95 i p99 błąd kątowy;
   - liczbę komórek pominiętych z powodu normy `≤ 1e-12`.

4. Wyznaczyć osobne metryki dla:

   - długich krawędzi próbki;
   - krótkich krawędzi;
   - narożników;
   - wnętrza.

Domyślna szerokość pasa brzegowego wynosi `12e-9 m` i zawsze trafia do raportu.

5. Przed średnią przez grubość FEM policzyć różnicę odpowiadających sobie węzłów top–bottom. Raportować RMS i maximum dla każdego komponentu. To kontroluje, ile informacji traci porównanie z MuMax3 `Nz=1`.

6. Testować tożsamość dekompozycji:

```math
\langle Rm_{FEM}\rangle-\langle m_{MuMax,array}\rangle
=\Delta_{native}+\Delta_{restriction}-\Delta_{storage}.
```

Testy:

```bash
PYTHONPATH=packages/fullmag-py/src pytest -q \
  packages/fullmag-py/tests/test_magnetization_comparison.py
```

Kryterium: identyczne pola dają zera, a syntetyczny bias, obrót, maska i błąd brzegowy dają analitycznie oczekiwane wyniki.

### Etap 6 — naprawić relaksacyjny tor walidatora SP4

1. W `verify.py` pozostawić istniejący `LinearNDInterpolator` tylko dla funkcji dynamicznych poza zakresem tego planu.

2. Refaktoryzować wyłącznie ścieżkę końcowego stanu relaksacji tak, aby:

   - używa `build_prism6_cartesian_restriction` oraz
     `restrict_fem_magnetization`;
   - pobierała `mean_m` z ostatniego wiersza `scalars.csv`;
   - nigdy nie używała `project_midplane` ani `np.mean(values, axis=0)` do wyniku naukowego;
   - odrzucała raport, gdy bramka zachowania średniej nie przechodzi.

3. Test kontraktu powinien analizować symbol ścieżki relaksacyjnej, a nie zabraniać importu SciPy w całym pliku. Ma potwierdzić użycie restrykcji objętościowej i brak średniej po węzłach w tej funkcji.

Testy:

```bash
PYTHONPATH=packages/fullmag-py/src:. pytest -q \
  tests/standard_problems/mumag/sp4/fem/test_contract.py \
  tests/standard_problems/mumag/sp4/fem/test_relaxation_matrix.py
```

Kryterium: relaksacyjny raport korzysta z natywnej średniej oraz nowego operatora; kod dynamiczny pozostaje nietknięty.

### Etap 7 — CLI i audytowalny raport (wersja v1 wykonana)

Wersja v1 dostarcza `scripts/compare_relaxed_magnetization.py` oraz
JSON-serializowalny raport metryk i provenance. Osobny bundle map
przestrzennych i wykresy pozostają świadomie odroczonym rozszerzeniem; nie są
używane do bieżącej kwalifikacji.

1. Utworzyć CLI z argumentami:

```text
--mumax PATH
--fullmag-state PATH
--fullmag-mesh PATH
--fullmag-run-bundle PATH (wymagany dla native planner mesh)
--output PATH
--high-error-threshold 1e-3
```

Nie dodawać selektora czasu ani indeksu. Każde wejście musi jednoznacznie publikować jeden końcowy stan relaksacji.

2. Kody zakończenia:

   - `0`: artefakty i operator przyjęte; metryki zapisane;
   - `2`: niejednoznaczne lub niezgodne wejścia;
   - `3`: nieprzechodząca bramka coverage, storage albo restrykcji.

Różnica fizyczna sama nie daje błędu procesu, dopóki nie istnieje zatwierdzona tolerancja kwalifikacyjna oparta na serii zbieżności.

3. Zapisać:

```text
comparison.json
summary.csv
report.md
comparison.zarr/mumax_m                 (1,z,y,x,3)
comparison.zarr/fullmag_on_mumax_grid   (1,z,y,x,3)
comparison.zarr/delta                   (1,z,y,x,3)
comparison.zarr/angle_deg               (1,z,y,x)
comparison.zarr/coverage                (z,y,x)
plots/mx.png
plots/my.png
plots/mz.png
plots/delta_norm.png
plots/angle_deg.png
```

4. `report.md` ma mieć stałą kolejność:

   1. identyfikacja i świeżość wejść;
   2. geometria, osie, jednostki i stan końcowy;
   3. natywne średnie solverów;
   4. `Δstorage` i `Δrestriction`;
   5. `Δnative`;
   6. metryki tekstury;
   7. brzeg, narożniki i wnętrze;
   8. zmienność top–bottom FEM;
   9. mapy przestrzenne;
   10. ostrożna klasyfikacja możliwej przyczyny.

5. README ma zawierać wykonywalny przykład MMpp z rzeczywistymi ścieżkami projektu:

```python
from fullmag.analysis import (
    compare_relaxed_states,
)

report = compare_relaxed_states(
    ".fullmag/reports/mumax-fullmag-validation-smoke/"
    "amumax-standardproblem4-relax.zarr",
    fullmag_state_path=(
        ".fullmag/reports/mumax-fullmag-validation-smoke/"
        "fullmag-fem-sp4-managed-ada50ce-20260802/states/relaxed_m.zarr.zip"
    ),
    fullmag_mesh_path=(
        "tests/standard_problems/mumag/sp4/fem/scenarios/"
        "relax_projected_gradient_bb.fullmag-mesh"
    ),
    fullmag_run_bundle=(
        ".fullmag/reports/mumax-fullmag-validation-smoke/"
        "fullmag-fem-sp4-managed-ada50ce-20260802"
    ),
)
```

Przed publikacją przykładu należy potwierdzić finalne ścieżki wytwarzane przez collector i skorygować README, jeśli runtime używa innego katalogu. Test dokumentacji ma wykonać przykład na fixture, a nie na dużych artefaktach.

Testy:

```bash
PYTHONPATH=packages/fullmag-py/src:. pytest -q \
  packages/fullmag-py/tests/test_magnetization_comparison.py
```

Kryterium: identyczny fixture daje raport z zerowym RMSE; stary Zarr, błędna oś, niepełne coverage i niespójny final step są odrzucane.

### Etap 8 — świeże uruchomienia i pierwszy raport (wykonano 2026-08-02)

1. Nie używać mieszanego `external_solvers/3/test/standardproblem4.zarr`.
   Czysty skrypt amumax zapisano jako
   `.fullmag/reports/mumax-fullmag-validation-smoke/amumax-standardproblem4-relax.mx3`:

```go
setgridsize(128, 32, 1)
setcellsize(500e-9/128, 125e-9/32, 3e-9)
Msat = 800e3
Aex = 13e-12
alpha = 0.02
m = uniform(1, 0.1, 0)
relax()
save(m)
tablesave()
```

2. Uruchomienie wykonano wskazanym binarnym amumax, bez dynamiki i bez
   ingerencji w skrypt użytkownika:

```bash
/home/kkingstoun/git/3/build/mumax3 -s -webui-disable -f \
  -storage-format=zarr \
  -o .fullmag/reports/mumax-fullmag-validation-smoke/amumax-standardproblem4-relax.zarr \
  .fullmag/reports/mumax-fullmag-validation-smoke/amumax-standardproblem4-relax.mx3
```

   Artefakt natywny ma `shape_tzyxc == [1,1,32,128,3]`, `t=0`, kompletne
   komponenty `(x,y,z)`, tabelę końcową `mx,my,mz` oraz status ukończenia.
   Hashy binarki, skryptu i store, wersji/commit, GPU, parametrów i komendy
   dowodzi `comparison/amumax-relax-manifest.json`.

3. Fullmag uruchomiono przez zarządzaną recepturę GPU w czystym wariancie
   runtime `ada50ce635c114b838a97b885a738f002805fd4d`. Końcowy etap
   `add_save_state(... dataset="m")` zapisał wyłącznie
   `states/relaxed_m.zarr.zip`; tabela accepted steps i kwalifikacja torque są
   w run bundle, a pola okresowe pozostają wyłączone (`fields=[]`).

4. Postprocessing wykonano jawnie:

```bash
PYTHONPATH=packages/fullmag-py/src \
python3 scripts/compare_relaxed_magnetization.py \
  --mumax .fullmag/reports/mumax-fullmag-validation-smoke/amumax-standardproblem4-relax.zarr \
  --fullmag-state .fullmag/reports/mumax-fullmag-validation-smoke/fullmag-fem-sp4-managed-ada50ce-20260802/states/relaxed_m.zarr.zip \
  --fullmag-mesh tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.fullmag-mesh \
  --fullmag-run-bundle .fullmag/reports/mumax-fullmag-validation-smoke/fullmag-fem-sp4-managed-ada50ce-20260802 \
  --output .fullmag/reports/mumax-fullmag-validation-smoke/comparison/relaxed-texture-comparison.json
```

5. Raport nie nadaje arbitralnego physics PASS/FAIL. Rozdziela zachowanie
   objętości (`5.52e-15`), restrykcję (błąd całki `5.4e-37–5.9e-41`), różnicę
   tablica-versus-textura amumax (`3.3e-9`, `4.7e-9`) oraz różnicę solverów.
   Raport używa `node_order="native_planner_mesh"` z
   `execution_plan.backend_plan.mesh`; średnia po restrykcji zgadza się z
   natywną tabelą do błędu zaokrąglenia. Pozostałe różnice są różnicą pól
   solverów, nie artefaktem kolejności węzłów ani awarią operatora
   FEM→Cartesian: vector RMS `0.0548477`, cosine `0.9984958`, vector max
   `0.2411974`.

Kryterium tego etapu jest spełnione: istnieje świeży, samowystarczalny raport
końcowego stanu, a stary mieszany Zarr nie jest cytowany jako wynik.

### Etap 9 — zbieżność przed przypisaniem przyczyny solverowi

Wykonać osobne serie, zmieniając po jednym parametrze:

1. MuMax3: `128×32×1` i co najmniej `256×64×1` przy tej samej domenie.
2. Fullmag: mesh bazowy i dwa poziomy zagęszczenia domeny magnetycznej.
3. Fullmag: airbox bazowy i powiększony przy zamrożonym magnetic submesh.
4. Relaksacja: bazowy oraz ostrzejszy warunek torque, a pomocniczo drugi algorytm relaksacji, jeśli pozostała różnica nie jest zbieżna.

Każda seria ma zachować osobne manifesty i raporty. Nie mieszać efektu siatki FDM, mesha FEM, airboxa i kryterium relaksacji w jednym przebiegu.

Dopiero stabilna pozostałość po tych seriach uzasadnia audyt implementacji exchange, demag, warunków brzegowych, parametrów materiałowych, znaków lub jednostek.

## Pełna weryfikacja implementacji

Testy postprocessingu i kontraktów:

```bash
PYTHONPATH=packages/fullmag-py/src:. pytest -q \
  packages/fullmag-py/tests/test_magnetization_comparison.py \
  tests/standard_problems/mumag/sp4/fem/test_scenarios.py \
  tests/standard_problems/mumag/sp4/fem/test_collect_results.py \
  tests/standard_problems/mumag/sp4/fem/test_contract.py \
  tests/standard_problems/mumag/sp4/fem/test_relaxation_matrix.py
```

Dokumentacja:

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0980-mumag-standard-problem-4-fem-application-validation.source-map.json \
  --repo-root .
python3 -m unittest discover \
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
```

Dowód runtime nie może być zastąpiony testem hostowym. Należy użyć zarządzanej receptury PG-BB z Etapu 8 i zachować jej identity/provenance w raporcie.

## Kolejność interpretacji raportu

1. Preflight nie przechodzi: nie porównywać liczb; artefakt jest stary, częściowy lub niespójny.
2. `Δstorage` jest duże: tabela MuMax3 i tablica `m` nie opisują tego samego końcowego stanu lub maski.
3. `Δrestriction` jest duże: problem leży w topologii, coverage, node order lub operatorze FEM→Cartesian.
4. Błąd koncentruje się na krawędziach: sprawdzić demag, airbox i rozdzielczość brzegu.
5. Błąd jest prawie stałym obrotem w całym wnętrzu: sprawdzić stan początkowy, parametry materiałowe i kryterium relaksacji.
6. Różnica top–bottom FEM jest duża: MuMax3 `Nz=1` traci istotną informację przez grubość.
7. Różnica maleje z refinementem jednej strony: nie kwalifikować solvera na bazowej dyskretyzacji.
8. Różnica pozostaje stabilna po kontrolowanych seriach: rozpocząć audyt operatorów fizycznych i ich konwencji.

## Poza zakresem

- dynamika i dopasowanie czasów;
- pierwsze przejście przez `<mx>=0`;
- ogólna restrykcja dowolnych `tet4`, `pyramid5` i wielowarstwowych meshy;
- automatyczne zastępowanie nieobsługiwanej topologii interpolacją punktową;
- zmiany w `ProblemIR`, plannerze, OpenAPI lub Control Room;
- ustalenie uniwersalnego progu physics PASS na podstawie jednej pary przebiegów.

## Kryterium ukończenia

Plan zostanie zrealizowany, gdy:

- oba wejścia są świeżymi, manifestowanymi końcowymi stanami relaksacji;
- Fullmag publikuje końcowe `m`, właściwy mesh, accepted step i natywną średnią;
- MuMax3 publikuje jedną końcową klatkę zgodną z tabelą i skryptem;
- stałe i liniowe pola przechodzą testy dokładnej restrykcji;
- realny SP4 zachowuje średnią FEM w tolerancji operatora, z użyciem natywnej
  kolejności węzłów planera;
- raport JSON zawiera dekompozycję średniej, metryki tekstury i provenance;
  mapy przestrzenne są świadomie odroczone jako osobne rozszerzenie v1;
- wykonano co najmniej jeden zarządzany przebieg Fullmaga i odpowiadający mu świeży przebieg MuMax3;
- raport jasno odróżnia dowód runtime od samych testów postprocessingu;
- użyty amumax zapisuje `m` i `tablesave()` natywnie do jednego Zarr, a
  lokalny `external_solvers/3` pozostaje nietknięty poza zmianami użytkownika.
