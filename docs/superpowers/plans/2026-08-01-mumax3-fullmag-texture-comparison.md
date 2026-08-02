# Plan ilościowego porównania końcowej tekstury MuMax3 i Fullmaga

> Zakres tego planu obejmuje wyłącznie końcowy, zeropolowy stan równowagowy po `minimize()` w MuMax3 i po `relax` w Fullmagu. Dynamika, trajektorie czasowe i pierwsze przejście przez `<mx>=0` są poza zakresem.

## Cel

Zbudować powtarzalny przepływ w Pythonie, który dla µMAG Standard Problem 4:

1. potwierdza, że oba wejścia są świeżymi, końcowymi stanami relaksacji tego samego problemu fizycznego;
2. porównuje natywne średnie magnetyzacji obu solverów;
3. ogranicza nodalne pole FEM Fullmaga do dokładnych komórek kartezjańskich MuMax3 z zachowaniem całki objętościowej;
4. oblicza ilościowe i przestrzenne metryki różnicy tekstur;
5. rozdziela błąd artefaktu, błąd reprezentacji siatki i rzeczywistą różnicę rozwiązania.

Implementacja planu nie zmienia `ProblemIR`, publicznego authoringu, plannera ani UI. Jest to offline analysis API i workflow walidacyjny SP4.

Warunkiem wejściowym jest zgodność problemu fizycznego, sprawdzana przed porównaniem pola: `500×125×3 nm`, `Ms=800 kA/m`, `Aex=13 pJ/m`, brak anizotropii i pola zewnętrznego, ten sam znormalizowany stan początkowy wynikający z `(1,0.1,0)` oraz ta sama konwencja zredukowanej magnetyzacji. `alpha=0.02` ma zostać zapisane w provenance, ale dla poprawnie osiągniętego minimum nie powinno zmieniać stanu równowagowego.

Oba skrypty muszą jawnie zapisać końcową magnetyzację po relaksacji. W MuMax3 służy do tego `save(m)` po `minimize()`. W Fullmagu nie należy używać `film.save(...)`, ponieważ ta metoda zapisuje już załadowany stan obiektu, a nie wynik późniejszego etapu solvera. Istniejącym odpowiednikiem końcowego snapshotu jest `study.stages.add_save_state(...)` bezpośrednio po etapie `relax`. Jedynym zapisywanym polem wektorowym ma być `m` ze wszystkimi trzema komponentami; tabela skalarów pozostaje osobnym dowodem zbieżności i natywnej średniej.

## Stan wyjściowy potwierdzony 2026-08-01

- MuMax3 używa layoutu `m.shape == (t,z,y,x,3)`; osie komponentów mają kolejność `(x,y,z)`.
- Aktualny skrypt `external_solvers/3/test/standardproblem4.mx3` opisuje siatkę `128×32×1`, próbkę `500×125×3 nm` i kończy się na `minimize()`.
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
- `packages/fullmag-py/tests/test_magnetization_comparison_io.py`
- `packages/fullmag-py/tests/test_fem_magnetization_series.py`
- `packages/fullmag-py/tests/test_fem_cartesian_restriction.py`
- `packages/fullmag-py/tests/test_magnetization_texture_metrics.py`
- `scripts/compare_mumax_fullmag_sp4_textures.py`
- `scripts/test_compare_mumax_fullmag_sp4_textures.py`

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
   - `restrict_prism6_to_cartesian`;
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
    values_tzyxc: np.ndarray
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


def from_mmpp_magnetization(
    dataset: object,
    *,
    root_attrs: Mapping[str, object],
    source: str,
) -> StructuredMagnetization:
    """Consume job[0].m by duck typing without importing MMpp in Fullmag."""
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
   - manifest zakończonego uruchomienia `minimize()`.

6. Dodać test regresyjny, który odrzuca obecny mieszany Zarr z 11 niezerowymi czasami, gdy skrypt/log opisuje wyłącznie `minimize()`.

Testy:

```bash
PYTHONPATH=packages/fullmag-py/src pytest -q \
  packages/fullmag-py/tests/test_magnetization_comparison_io.py
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
  packages/fullmag-py/tests/test_fem_magnetization_series.py
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
  packages/fullmag-py/tests/test_fem_cartesian_restriction.py
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
  packages/fullmag-py/tests/test_magnetization_texture_metrics.py
```

Kryterium: identyczne pola dają zera, a syntetyczny bias, obrót, maska i błąd brzegowy dają analitycznie oczekiwane wyniki.

### Etap 6 — naprawić relaksacyjny tor walidatora SP4

1. W `verify.py` pozostawić istniejący `LinearNDInterpolator` tylko dla funkcji dynamicznych poza zakresem tego planu.

2. Refaktoryzować wyłącznie ścieżkę końcowego stanu relaksacji tak, aby:

   - używała `restrict_prism6_to_cartesian`;
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

### Etap 7 — CLI i audytowalny raport

1. Utworzyć CLI z argumentami:

```text
--mumax-zarr PATH
--fullmag-bundle PATH
--fullmag-mesh PATH
--output-dir PATH
--edge-band-m 12e-9
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
import mmpp
from fullmag.analysis import (
    compare_magnetization_textures,
    from_mmpp_magnetization,
    load_fullmag_fem_magnetization,
    restrict_prism6_to_cartesian,
)

jobs = mmpp.open(
    ".fullmag/reports/standard-problems/mumag/sp4/texture-comparison/"
    "relaxed-s-state/mumax/standardproblem4.zarr"
)
mumax = from_mmpp_magnetization(
    jobs[0].m,
    root_attrs=jobs[0].attributes,
    source=(
        ".fullmag/reports/standard-problems/mumag/sp4/texture-comparison/"
        "relaxed-s-state/mumax/standardproblem4.zarr"
    ),
)
fem = load_fullmag_fem_magnetization(
    ".fullmag/reports/standard-problems/mumag/sp4/texture-comparison/"
    "relaxed-s-state/fullmag/relax_projected_gradient_bb.zarr/"
    "artifacts/states/relaxed_m.zarr.zip",
    mesh_path=(
        ".fullmag/reports/standard-problems/mumag/sp4/texture-comparison/"
        "relaxed-s-state/fullmag/relax_projected_gradient_bb.fullmag-mesh"
    ),
    run_bundle=(
        ".fullmag/reports/standard-problems/mumag/sp4/texture-comparison/"
        "relaxed-s-state/fullmag/relax_projected_gradient_bb.zarr"
    ),
    magnetic_markers=(1,),
)
restricted = restrict_prism6_to_cartesian(fem, mumax.grid)
comparison = compare_magnetization_textures(
    restricted.values_tzyxc[0],
    mumax.values_tzyxc[0],
)
```

Przed publikacją przykładu należy potwierdzić finalne ścieżki wytwarzane przez collector i skorygować README, jeśli runtime używa innego katalogu. Test dokumentacji ma wykonać przykład na fixture, a nie na dużych artefaktach.

Testy:

```bash
PYTHONPATH=packages/fullmag-py/src:. pytest -q \
  scripts/test_compare_mumax_fullmag_sp4_textures.py
```

Kryterium: identyczny fixture daje raport z zerowym RMSE; stary Zarr, błędna oś, niepełne coverage i niespójny final step są odrzucane.

### Etap 8 — świeże uruchomienia i pierwszy raport

1. Nie nadpisywać lokalnego `external_solvers/3/test/standardproblem4.zarr`. Świeży MuMax3 output zapisać w:

   `.fullmag/reports/standard-problems/mumag/sp4/texture-comparison/relaxed-s-state/mumax/standardproblem4.zarr`.

2. W `external_solvers/3/test/standardproblem4.mx3` dodać bezpośrednio po relaksacji dokładnie:

```go
minimize()
save(m)
tablesave()
```

Nie dodawać `autosave(m, ...)`, ponieważ porównanie wymaga jednego stanu końcowego, a nie szeregu czasowego. Zachować wszystkie pozostałe lokalne zmiany użytkownika w skrypcie. Obliczyć SHA-256 wejściowego `.mx3`, skopiować go do katalogu raportu i uruchomić MuMax3 z jawnym outputem. `save(m)` ma utworzyć jedną klatkę `m(t=1,z=1,y=32,x=128,component=3)`, a `tablesave()` ma dopisać odpowiadający jej końcowy wiersz średnich. Manifest ma zawierać:

   - SHA-256 binarki i skryptu;
   - wersję/commit MuMax3, jeśli binarka go raportuje;
   - pełną komendę;
   - identyfikację GPU;
   - rozstrzygnięte parametry problemu fizycznego z outputu/logu, w tym końcowe `Ms=800e3 A/m` mimo wcześniejszego testowego przypisania `1600e3 A/m` w skrypcie;
   - `shape_tzyxc == [1,1,32,128,3]`;
   - status ukończonego `minimize()`;
   - hash wynikowego store.

3. Rozszerzyć `scripts/run_fem_sp4_scenario.sh` o opcjonalny, jawny `output_dir` i dodać niełamiącą istniejących wywołań recepturę `fem-sp4-scenario-output`. Receptura ma używać tego samego zarządzanego runtime co `fem-sp4-scenario`, przekazać `--output-dir`, uruchomić collector i skopiować użyty `.fullmag-mesh` do katalogu raportu wraz z SHA-256. Następnie uruchomić Fullmag wyłącznie tą recepturą:

```bash
just ensure-managed-fem-runtime
just fem-sp4-scenario-output gpu \
  tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py \
  texture-compare-relaxed \
  .fullmag/reports/standard-problems/mumag/sp4/texture-comparison/relaxed-s-state/fullmag/relax_projected_gradient_bb.zarr \
  false
```

Wymagany dowód: FEM GPU `double`, brak fallbacku, identity urządzenia, torque-qualified completion, dokładnie jeden `artifacts/states/relaxed_m.zarr.zip` z datasetem `m(node,component)`, brak okresowych Zarr pól `H_*`, fingerprint mesha i natywne `mx,my,mz`.

4. Dodać recepturę postprocessingu przyjmującą cztery jawne ścieżki i uruchomić ją dla katalogu:

   `.fullmag/reports/standard-problems/mumag/sp4/texture-comparison/relaxed-s-state`.

5. Pierwszy raport ma być opisowy, bez arbitralnego physics PASS/FAIL. Musi odpowiedzieć:

   - ile wynosi różnica natywnych średnich;
   - ile tej różnicy wyjaśnia storage i restrykcja;
   - gdzie przestrzennie leży pozostały błąd;
   - czy błąd koncentruje się na krawędziach, narożnikach, wnętrzu lub przez grubość.

Kryterium: istnieje świeży, samowystarczalny raport końcowego stanu S, a obecny mieszany Zarr nie jest cytowany jako wynik.

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
  packages/fullmag-py/tests/test_magnetization_comparison_io.py \
  packages/fullmag-py/tests/test_fem_magnetization_series.py \
  packages/fullmag-py/tests/test_fem_cartesian_restriction.py \
  packages/fullmag-py/tests/test_magnetization_texture_metrics.py \
  scripts/test_compare_mumax_fullmag_sp4_textures.py \
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
- realny SP4 zachowuje średnią FEM w tolerancji operatora;
- raport zawiera dekompozycję średniej, metryki tekstury i mapy przestrzenne;
- wykonano co najmniej jeden zarządzany przebieg Fullmaga i odpowiadający mu świeży przebieg MuMax3;
- raport jasno odróżnia dowód runtime od samych testów postprocessingu;
- w `external_solvers/3/test/standardproblem4.mx3` dodano wyłącznie autoryzowane `save(m)` i `tablesave()`, a wszystkie pozostałe lokalne zmiany użytkownika pozostały nietknięte.
