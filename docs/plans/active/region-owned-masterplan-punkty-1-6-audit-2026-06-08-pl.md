# Audyt zamknięcia punktów 1-6 masterplanu region-owned

Data audytu: 2026-06-08  
Audytowany plan: `docs/plans/active/region-owned-implementation-masterplan-2026-06-04-pl.md`  
Zakres audytu: sekcje `## 1` do `## 6` planu, czyli:

1. Teza architektoniczna
2. Zakres
3. Nazewnictwo docelowe
4. Warstwa fizyczna
5. Docelowy Python DSL
6. ProblemIR

Ten raport nie ocenia jako "zamknięte 100%" dalszych sekcji masterplanu, takich
jak planner, SceneDocument, meshing, OpenAPI, frontend, runtime i backend. Tamte
warstwy pojawiają się tylko wtedy, gdy są bezpośrednim dowodem albo brakiem dla
punktów 1-6.

## Werdykt

Punkty 1-6 można uznać za zamknięte w zakresie kontraktu physics -> Python DSL
-> ProblemIR.

To nie oznacza zamknięcia całego masterplanu. Sekcje 7-27 nadal muszą być
audytowane osobno, bo obejmują planner, SceneDocument, meshing, OpenAPI,
frontend, runtime i backend. Dla punktów 1-6 obecny stan spełnia wymagania
semantyczne:

- nota fizyczna ma status `accepted implementation contract`;
- publiczny Python DSL ma `region.texture = ...` i `RegionTextureOverride`;
- script export odtwarza region texture override;
- `ProblemIR::validate()` waliduje
  `object_regions[].texture_override.initial_magnetization`;
- `piecewise` jest jawnie deferred poza v1 punktów 1-6;
- normalizacja z sekcji 6.6 jest jawnie przypisana do planner/authoring/runtime
  diagnostics, a nie do `fullmag-ir`.

## Macierz statusu punktów 1-6

| Punkt | Status | Ocena | Główne dowody | Braki / ryzyko |
|---|---:|---|---|---|
| 1. Teza architektoniczna | Zamknięty dla punktów 1-6 | Kontrakt "object owns `m`, region is selector" jest zapisany w fizyce i wsparty przez IR/testy. | Physics note sekcja 2.1; `object_region_without_overrides_is_continuous_with_parent_object`; `ObjectRegionIR.owner_object`; mesh-only region nie tworzy material field ani coupling. | Runtime/backend proof należy do sekcji 7-27. |
| 2. Zakres | Zamknięty jako deklaracja zakresu | Sekcja 2 jest zakresem całego masterplanu, nie checklistą do domknięcia w punktach 1-6. | Plan jawnie wymienia dalsze warstwy w sekcjach 7-27. | Implementacyjne zamknięcie całego zakresu wymaga osobnego audytu sekcji 7-27. |
| 3. Nazewnictwo docelowe | Zamknięty dla punktów 1-6 | Najważniejsze pojęcia są rozdzielone: `ObjectRegionIR`, `MaterialParameterFieldIR`, `CouplingIR`, `RegionTextureOverrideIR`, legacy `RegionIR`. | `crates/fullmag-ir/src/model.rs`; Python `RegionRegistry`; `RegionTextureOverride`. | Rozbicie na osobne pliki `model/regions.py` jest deferred jako refaktor organizacyjny. |
| 4. Warstwa fizyczna | Zamknięty dla punktów 1-6 | Nota fizyczna opisuje jeden obiekt = jedno `m`, exchange, RKKY, airbox, FDM/FEM i mesh-only region semantics. | `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`; testy IR dla ciągłości regionu, `Ms=0`, free surface object-object, RKKY endpointów i texture override validation. | Directional derivative/runtime parity należą do sekcji runtime/backend. |
| 5. Docelowy Python DSL | Zamknięty dla v1 punktów 1-6 | Działa rejestr regionów, stable `owner:rN`, `study.regions`, `region.delete`, `rename_region`, material overrides, region texture override, `fm.fields`, `fm.shapes`, `fm.couplings`, script round-trip. | `world.py`; `structure.py`; `test_api.py`; script export z `region.texture = ...`. | `piecewise` jest jawnie deferred poza v1; `RegionMeshPolicy` jako osobna klasa jest refaktorem publicznej ergonomii, nie warunkiem semantycznym. |
| 6. ProblemIR | Zamknięty dla punktów 1-6 | Typy IR są obecne, `ProblemIR` ma `object_regions`, `material_parameter_fields`, `couplings`, walidacja obejmuje owner refs, shape, mesh policy, material values, texture override, coupling endpoints, conflicts i disabled region semantics. | `model.rs`; `lib.rs::validate_region_owned_semantics`; `ir_tests.rs`. | Planner freshness/capability flags z 6.6 są jawnie przeniesione do audytu sekcji 7-19. |

## Szczegółowa analiza po domknięciu braków

### 1. Teza architektoniczna

Kod zachowuje rozdział: obiekt materiałowy jest właścicielem pola `m`,
`ObjectRegion` jest authored selectorem, `MaterialParameterAssignmentIR` jest
osobnym authored intentem, a `CouplingIR` nie jest material override. Sam region
bez override'ów nie tworzy material field ani coupling.

Status: zamknięte dla punktów 1-6.

### 2. Zakres

Sekcja 2 jest deklaracją zakresu całego masterplanu. W tym raporcie potwierdza
tylko, że sekcje 1-6 mają poprawny kontrakt wejściowy dla dalszych sekcji.
Meshing, runtime, backend, OpenAPI i frontend pozostają przedmiotem osobnych
audytów.

Status: zamknięte jako deklaracja zakresu, nie jako zamknięcie całego
masterplanu.

### 3. Nazewnictwo docelowe

Po domknięciu braków istnieją wszystkie pojęcia wymagane przez sekcje 1-6:

- `ObjectRegion`,
- `RegionRegistry`,
- `RegionMaterialOverride`,
- `RegionTextureOverride`,
- `MaterialParameterField`,
- `CouplingRegistry`,
- `ObjectRegionIR`,
- `RegionTextureOverrideIR`,
- `MaterialParameterAssignmentIR`,
- `CouplingIR`.

Plan został doprecyzowany, że obecne rozmieszczenie descriptors w
`model/structure.py` jest akceptowane w v1, a rozbicie na osobne pliki jest
refaktorem organizacyjnym.

Status: zamknięte dla punktów 1-6.

### 4. Warstwa fizyczna

Nota fizyczna `0104-material-regions-parameter-fields-and-interface-couplings.md`
ma status `accepted implementation contract` i opisuje wymagane rozróżnienie
material object / authored region / material field / coupling / airbox. Z punktu
widzenia sekcji 1-6 kontrakt jest gotowy.

Testy runtime i backend parity, w tym directional derivative field/energy,
należą do dalszych sekcji masterplanu i nie są kryterium zamknięcia punktów
1-6.

Status: zamknięte dla punktów 1-6.

### 5. Python DSL

Zaimplementowany publiczny flow:

- `film.add_region(...)`,
- `film.regions[...]`,
- `study.regions[...]` jako read-only flattened registry,
- `region.mesh(...)`,
- `region.material.Ms = ...` i `region.set_material(...)`,
- `region.texture = fm.texture...`,
- `region.delete()`,
- `film.remove_region(...)`,
- `film.rename_region(...)`,
- `fm.fields.constant/linear/radial/sampled`,
- `fm.shapes.*`,
- `study.couplings.*`.

`piecewise` jest jawnie deferred poza v1 punktów 1-6. `RegionMeshPolicy` jako
osobna publiczna klasa nie jest warunkiem semantycznym v1, ponieważ `mesh_policy`
jest stabilnie serializowane przez `ObjectRegion.mesh(...)`.

Status: zamknięte dla v1 punktów 1-6.

### 6. ProblemIR

`ProblemIR` ma typed sections dla:

- `object_regions`,
- `material_parameter_fields`,
- `couplings`.

Walidacja obejmuje:

- region owner refs,
- unikalność `region_id`,
- unikalność nazw w ownerze,
- shape validity,
- mesh policy validity,
- material scalar validity,
- material conflict detection,
- region/coupling owner mismatch,
- disabled region endpoint rules,
- RKKY/interlayer surface endpoints,
- airbox rejection,
- `texture_override.initial_magnetization`.

Sekcja 6.6 została doprecyzowana w masterplanie: `fullmag-ir` odpowiada za
typed IR, validation i stable id/reference semantics; planner/runtime odpowiada
za wyprowadzanie `requires_mesh_rebuild`,
`requires_material_field_realization` i
`requires_conformal_region_boundary`, bo te flagi zależą od aktualnego meshu,
asset provenance i wybranego trybu wykonania.

Status: zamknięte dla punktów 1-6.

## Weryfikacja wykonana podczas audytu

### Python

Polecenie:

```bash
PYTHONPATH=packages/fullmag-py/src .fullmag/local/python/bin/python -m unittest packages.fullmag-py.tests.test_api
```

Wynik:

```text
Ran 183 tests in 2.168s
OK
```

Smoke publicznego eksportu `RegionTextureOverride`:

```bash
PYTHONPATH=packages/fullmag-py/src .fullmag/local/python/bin/python - <<'PY'
import fullmag as fm
assert 'RegionTextureOverride' in fm.__all__
assert hasattr(fm, 'RegionTextureOverride')
film = fm.geometry(fm.Box(size=(10e-9, 10e-9, 2e-9)), name='film')
region = film.add_region('core', fm.Cylinder(radius=2e-9, height=2e-9))
region.texture = fm.texture.uniform(1, 0, 0)
ir = region.to_ir()
assert ir['texture_override']['initial_magnetization']['kind'] == 'preset_texture'
assert ir['texture_override']['initial_magnetization']['preset_kind'] == 'uniform'
print('ok')
PY
```

Wynik:

```text
ok
```

### Rust IR

Pierwsze uruchomienie hostowego `cargo test` bez `CARGO_TARGET_DIR` nie mogło
utworzyć `target/debug` w repo przez uprawnienia. Powtórzono test jako
pomocniczy host smoke z targetem w `/tmp`.

Polecenia:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-region-gaps-target cargo test -p fullmag-ir region_owned -- --nocapture
CARGO_TARGET_DIR=/tmp/fullmag-region-gaps-target cargo test -p fullmag-ir object_region -- --nocapture
CARGO_TARGET_DIR=/tmp/fullmag-region-gaps-target cargo test -p fullmag-ir -- --nocapture
```

Wyniki:

```text
region_owned: 1 passed
object_region: 5 passed
fullmag-ir: 9 unit tests passed, 68 integration tests passed, 0 doctests
```

Uwaga: to są testy IR, nie finalny dowód runtime FEM/FDM.

## Konkluzja

Po domknięciu braków punkty 1-6 masterplanu są poprawnie zamknięte dla warstw:

- physics note,
- Python DSL,
- canonical script export,
- ProblemIR typing,
- ProblemIR validation.

Następny audyt produkcyjny powinien przejść do sekcji 7-19, bo tam znajdują się
planner, meshing, material realization, FDM/FEM backend, OpenAPI, frontend i
runtime provenance.
