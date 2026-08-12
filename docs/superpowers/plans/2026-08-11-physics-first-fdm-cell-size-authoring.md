# Physics-first FDM `cell_size` Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zastąpić kanoniczne publiczne konfigurowanie FDM przez `study.fdm(...)`, `FDMGrid` i `FDMDemag` wspólnym kontraktem `body.mesh(cell_size=...)`, `study.universe.mesh(cell_size=...)` i `study.demag()`, bez zmiany istniejącego API FEM.

**Architecture:** Python DSL zapisuje `cell_size` jako authoring intent per obiekt i dla wspólnej domeny, a podczas budowy dokumentu obniża go do jednego kontraktu FDM w `ProblemIR`. Planner wylicza dokładne liczności wspólnej domeny z żądanego `common_cell_size`, zachowuje requested/resolved provenance i wybiera istniejący transfer `identity` albo `push_pull`; stare klasy pozostają wyłącznie adapterami migracyjnymi.

**Tech Stack:** Python 3, pytest/unittest, Rust, serde, `fullmag-ir`, `fullmag-plan`, istniejące CPU/CUDA FDM multilayer runtime, MyST/Sphinx.

## Global Constraints

- FEM `minimum_element_size` i `maximum_element_size` nie zmieniają semantyki ani serializacji.
- Kanoniczny zapis FDM to `mesh(cell_size=(dx, dy, dz))`; nie dodawać publicznych nazw z prefiksem `fdm_`.
- `study.demag()` pozostaje fizycznym żądaniem i automatycznie rozwiązuje realizację.
- `study.mode("strict")` nie zaokrągla geometrii, liczności ani rozmiarów komórek.
- Wiele różnych siatek natywnych wymaga jawnego `study.universe.mesh(cell_size=...)`.
- Stare API jest adapterem kompatybilności, a nie drugą ścieżką planowania.
- Dokumentacja użytkownika i kod są po angielsku; ten plan pozostaje po polsku zgodnie z `AGENTS.md`.
- Nie modyfikować istniejącego brudnego submodułu `external_solvers/3`.

---

### Task 1: Publiczny Python DSL i authoring state

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/model/discretization.py`
- Test: `packages/fullmag-py/tests/test_api.py`
- Test: `packages/fullmag-py/tests/test_fdm_multilayer_contract.py`

**Interfaces:**
- Consumes: istniejące `GeometryMeshHandle`, `StudyUniverseHandle`, `StudyObjectsMeshDefaultsHandle`, `FDM`, `FDMGrid`, `FDMDemag`.
- Produces: `GeometryMeshHandle.__call__(..., cell_size: Sequence[float] | None = None)`, `StudyUniverseHandle.mesh(..., cell_size: Sequence[float] | None = None)`, `study.objects.mesh.defaults(cell_size=...)` oraz jeden znormalizowany `FDM` adapter IR.

- [ ] **Step 1: Napisać testy RED dla nowego zapisu**

```python
def test_fdm_cell_size_authoring_lowers_per_object_and_universe():
    study = fm.Study("two-layers")
    study.engine("fdm")
    bottom = study.geometry(fm.Box(size=(100e-9, 50e-9, 10e-9)), name="bottom")
    top = study.geometry(
        fm.Box(size=(100e-9, 50e-9, 10e-9)).translate((0.0, 0.0, 20e-9)),
        name="top",
    )
    bottom.mesh(cell_size=(2e-9, 2e-9, 10e-9))
    top.mesh(cell_size=(5e-9, 5e-9, 10e-9))
    study.universe.mesh(cell_size=(2e-9, 2e-9, 2.5e-9))
    study.demag()

    ir = study.to_ir()
    fdm = ir["backend_policy"]["discretization_hints"]["fdm"]
    assert fdm["per_magnet"]["bottom"]["cell"] == [2e-9, 2e-9, 10e-9]
    assert fdm["per_magnet"]["top"]["cell"] == [5e-9, 5e-9, 10e-9]
    assert fdm["demag"]["common_cell_size"] == [2e-9, 2e-9, 2.5e-9]
```

Dodać testy: defaults + override, trzy niedodatnie/nieskończone składowe, konflikt `cell_size` z FEM kwargs, brak wspólnej domeny dla różnych siatek oraz zachowanie niezmienionej serializacji FEM.

- [ ] **Step 2: Uruchomić testy i potwierdzić RED**

Run: `python3 -m pytest packages/fullmag-py/tests/test_api.py packages/fullmag-py/tests/test_fdm_multilayer_contract.py -q`

Expected: FAIL z powodu nieobsługiwanego `cell_size` lub braku `common_cell_size`.

- [ ] **Step 3: Dodać minimalne authoring state i walidację**

Rozszerzyć istniejące konfiguracje mesh o znormalizowaną trójkę `cell_size`. Nie dodawać równoległego buildera FDM. Podczas `to_ir()` zebrać defaults i per-obiekt overrides, utworzyć istniejące `FDMGrid` tylko wewnętrznie oraz zapisać wspólny rozmiar w `FDMDemag.common_cell_size`.

```python
def _normalize_cell_size(value: Sequence[float], context: str) -> tuple[float, float, float]:
    cell = as_vector3(value, context)
    for axis, component in zip("xyz", cell, strict=True):
        require_positive(component, f"{context}[{axis}]")
    return cell
```

Konflikt z dowolnym aktywnym FEM control ma zgłaszać `ValueError` zawierający oba alternatywne kontrakty.

- [ ] **Step 4: Zachować stare API jako adapter migracyjny**

`study.fdm(...)`, `fdm(...)`, `FDMGrid` i `FDMDemag` nadal obniżają się do tego samego `FDM.to_ir()`. Dodać `DeprecationWarning` ze wskazaniem `body.mesh(cell_size=...)`, `study.universe.mesh(cell_size=...)`, `study.demag()`; nie emitować ostrzeżenia z wewnętrznego użycia adaptera przez nowy builder.

- [ ] **Step 5: Uruchomić testy Python**

Run: `python3 -m pytest packages/fullmag-py/tests/test_api.py packages/fullmag-py/tests/test_fdm_multilayer_contract.py packages/fullmag-py/tests/test_script_builder_roundtrip.py -q`

Expected: PASS; FEM snapshots bez zmian poza testami, które świadomie migrują kanoniczny eksport.

- [ ] **Step 6: Commit**

```bash
git add packages/fullmag-py/src/fullmag/world.py packages/fullmag-py/src/fullmag/model/discretization.py packages/fullmag-py/tests/test_api.py packages/fullmag-py/tests/test_fdm_multilayer_contract.py packages/fullmag-py/tests/test_script_builder_roundtrip.py
git commit -m "feat(python): author FDM grids through mesh cell_size"
```

### Task 2: Kanoniczny eksport i round-trip UI/Python

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Test: `packages/fullmag-py/tests/test_fdm_ui_roundtrip.py`
- Test: `packages/fullmag-py/tests/test_script_builder_roundtrip.py`

**Interfaces:**
- Consumes: znormalizowane FDM hints z Task 1.
- Produces: eksport skryptu zawierający wyłącznie `body.mesh(cell_size=...)`, opcjonalne `study.objects.mesh.defaults(cell_size=...)`, `study.universe.mesh(cell_size=...)` i `study.demag()`.

- [ ] **Step 1: Zmienić oczekiwania round-trip na nowy zapis i potwierdzić RED**

```python
assert 'free.mesh(cell_size=(1e-09, 1e-09, 1e-09))' in script
assert 'study.universe.mesh(cell_size=(2e-09, 2e-09, 1e-09))' in script
assert "study.demag()" in script
assert "FDMGrid" not in script
assert "FDMDemag" not in script
assert "study.fdm(" not in script
```

Run: `python3 -m pytest packages/fullmag-py/tests/test_fdm_ui_roundtrip.py packages/fullmag-py/tests/test_script_builder_roundtrip.py -q`

Expected: FAIL na starym kanonicznym eksporcie.

- [ ] **Step 2: Zaimplementować jeden renderer nowego kontraktu**

Renderer ma zachować stabilną kolejność: geometria → per-object mesh → universe mesh → interactions. Zaawansowane stare wartości strategii, których nowy podstawowy zapis nie reprezentuje, mają użyć jawnego kompatybilnego bloku polityki wykonania, nigdy odtworzonego `study.fdm(...)`.

- [ ] **Step 3: Uruchomić round-trip**

Run: `python3 -m pytest packages/fullmag-py/tests/test_fdm_ui_roundtrip.py packages/fullmag-py/tests/test_script_builder_roundtrip.py -q`

Expected: PASS i strukturalnie równoważny IR po ponownym wykonaniu eksportu.

- [ ] **Step 4: Commit**

```bash
git add packages/fullmag-py/src/fullmag/runtime/script_builder.py packages/fullmag-py/src/fullmag/world.py packages/fullmag-py/tests/test_fdm_ui_roundtrip.py packages/fullmag-py/tests/test_script_builder_roundtrip.py
git commit -m "refactor(python): export canonical FDM mesh authoring"
```

### Task 3: `ProblemIR` requested common cell size

**Files:**
- Modify: `crates/fullmag-ir/src/mesh_hints.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`
- Test: `crates/fullmag-ir/src/lib.rs`
- Test: `crates/fullmag-plan/src/tests.rs`

**Interfaces:**
- Consumes: JSON `fdm.demag.common_cell_size: [f64; 3]` z Python.
- Produces: `FdmDemagHintsIR.common_cell_size: Option<[f64; 3]>` z serde default, walidacją SI i zachowaniem kompatybilności starych dokumentów.

- [ ] **Step 1: Dodać test deserializacji/round-trip i potwierdzić RED**

Test ma zdeserializować `common_cell_size: [2e-9, 2e-9, 2.5e-9]`, sprawdzić dokładną wartość oraz odrzucić zero, `NaN` i konflikt z `common_cells`/`common_cells_xy`.

Run: `cargo test -p fullmag-ir common_cell_size -- --nocapture`

Expected: FAIL, ponieważ pole nie istnieje lub nie jest walidowane.

- [ ] **Step 2: Dodać pole i walidację**

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub common_cell_size: Option<[f64; 3]>,
```

Pole jest wzajemnie wykluczające z licznościami starego API. Stare payloady bez pola pozostają poprawne.

- [ ] **Step 3: Uruchomić testy IR**

Run: `cargo test -p fullmag-ir common_cell_size -- --nocapture`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/fullmag-ir/src/mesh_hints.rs crates/fullmag-ir/src/lib.rs
git commit -m "feat(ir): preserve requested FDM common cell size"
```

### Task 4: Planner wspólnej domeny i transfer niezagnieżdżony

**Files:**
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: `crates/fullmag-plan/src/geometry.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`

**Interfaces:**
- Consumes: `common_cell_size`, natywne `per_magnet` cells i union bounds.
- Produces: dokładne `common_cells`, `convolution_cell_size`, `three_d`, per-layer `identity|push_pull` oraz błędy osiowe bez zaokrąglania.

- [ ] **Step 1: Dodać planner test dla 2/5/10 nm i domeny 2/2/2.5 nm**

Test tworzy dwa boksy `100 x 50 x 10 nm`, drugi przesunięty o `20 nm` w Z, i oczekuje:

```rust
assert_eq!(multilayer.common_cells, [50, 25, 12]);
assert_eq!(multilayer.convolution_cell_size, [2e-9, 2e-9, 2.5e-9]);
assert_eq!(multilayer.mode, FdmMultilayerMode::ThreeD);
assert!(multilayer.layers.iter().any(|layer| layer.transfer_kind == PushPull));
```

Dodać przypadki RED dla niedzielącego extentu, braku wspólnego rozmiaru przy różnych native cells i konfliktu starych common counts.

Run: `cargo test -p fullmag-plan fdm_common_cell_size -- --nocapture`

Expected: FAIL przed implementacją.

- [ ] **Step 2: Wyliczać liczności bez zaokrąglania**

Dla każdej osi obliczyć `extent / requested_cell`, sprawdzić bliskość liczby całkowitej tą samą tolerancją co native grid, a następnie wykonać kontrolowane rzutowanie do `u32`. Błąd zawiera oś, extent, requested cell i informację o `strict`.

- [ ] **Step 3: Rozwiązać transfer**

`identity` jest legalne tylko przy zgodnym origin, rozmiarze komórki i rastrze. Każdy przypadek 5/2 używa istniejącego `push_pull`; planner nie tworzy nowego, niesprawdzonego interpolatora.

- [ ] **Step 4: Uruchomić testy planera**

Run: `cargo test -p fullmag-plan fdm_common_cell_size -- --nocapture`

Expected: PASS.

Run: `cargo test -p fullmag-plan fdm_multilayer -- --nocapture`

Expected: PASS bez regresji istniejących trybów 2D/3D.

- [ ] **Step 5: Commit**

```bash
git add crates/fullmag-plan/src/fdm.rs crates/fullmag-plan/src/geometry.rs crates/fullmag-plan/src/tests.rs
git commit -m "feat(plan): resolve FDM convolution cell size"
```

### Task 5: Dowody numeryczne CPU/CUDA i provenance

**Files:**
- Modify: `crates/fullmag-runner/src/fdm/multilayer.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Test: właściwe istniejące moduły testowe w tych plikach.

**Interfaces:**
- Consumes: plan z per-layer `transfer_kind`, native/common cell sizes i common cells.
- Produces: niezmienione fizycznie wykonanie `push_m`/`pull_h`, parity CPU/CUDA oraz requested/resolved dane w resource/provenance.

- [ ] **Step 1: Dodać niezagnieżdżone fixture 5/2**

Fixture sprawdza zachowanie całkowitego momentu przez `push_m`, adjointność
`<push_m(m), h>_Vc = <m, pull_h(h)>_Vn`, wzajemność objętościową i energię bez podwojenia.

- [ ] **Step 2: Uruchomić testy RED/GREEN CPU**

Run: `cargo test -p fullmag-runner fdm_multilayer -- --nocapture`

Expected: PASS istniejącej implementacji albo kontrolowany RED wskazujący brak obsługi ratio 5/2; w drugim przypadku naprawić wspólny kod transferu, nie test.

- [ ] **Step 3: Zweryfikować CUDA przez repozytoryjny managed route**

Najpierw znaleźć odpowiadający przepis: `rg -n "fdm.*multilayer|multilayer.*fdm" justfile Justfile justfiles`.

Uruchomić dokładny znaleziony recipe obejmujący CPU FP64, CUDA FP64 i istniejącą bramkę FP32. Nie zastępować go hostowym CUDA buildem. Expected: PASS z aktualnym source SHA i runtime provenance.

- [ ] **Step 4: Rozszerzyć test resource/provenance**

JSON musi zawierać requested `common_cell_size`, resolved `common_cells`, `convolution_cell_size`, strategię, mode i per-layer `transfer_kind`.

Run: `cargo test -p fullmag-api fdm_multilayer_layout -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/fullmag-runner/src/fdm/multilayer.rs crates/fullmag-runner/src/fdm/gpu/cuda/native.rs crates/fullmag-api/src/router_v2/tests.rs
git commit -m "test(fdm): qualify heterogeneous cell-size transfer"
```

### Task 6: Publikacyjna dokumentacja angielska i pełna migracja przykładów

**Files:**
- Modify: `docs/physics/0100-mesh-and-region-discretization.md`
- Modify: `docs/physics/0100-mesh-and-region-discretization.source-map.json`
- Modify: `docs/physics/0421-fdm-multilayer-convolution-demag.md`
- Modify: `docs/physics/0421-fdm-multilayer-convolution-demag.source-map.json`
- Modify: wszystkie kanoniczne docs/examples znalezione przez finalny stale-API scan.

**Interfaces:**
- Consumes: zweryfikowane zachowanie Tasks 1–5.
- Produces: angielską dokumentację nowego API, pełne tabele parametrów, source mapping, FEM/FDM porównanie, opis `strict`, przykład 2/5/10 nm i brak starego API w kanonicznych przykładach.

- [ ] **Step 1: Zaktualizować publikacyjny kontrakt przed deklaracją wsparcia**

Dokumentacja wyjaśnia różnicę między native mesh i common convolution domain, matematykę ratio 5/2, `push_pull`, requested/resolved provenance, tryby 2D/3D oraz zachowanie FEM bez zmian.

- [ ] **Step 2: Zaktualizować source maps i indeks źródeł**

Każdy nowy parametr publiczny mapuje ścieżkę Python, typ, default, jednostkę SI, walidację, znaczenie, backend support i dokładną ścieżkę/symbol implementacji.

- [ ] **Step 3: Usunąć stary zapis z kanonicznych przykładów**

Run: `rg -n "study\.fdm\(|fm\.fdm\(|FDMGrid\(|FDMDemag\(" docs --glob '*.md' --glob '!superpowers/**'`

Expected: trafienia wyłącznie w jawnie oznaczonych sekcjach migracji/historycznych; żaden bieżący tutorial nie używa starego zapisu.

- [ ] **Step 4: Uruchomić walidatory naukowej dokumentacji i build Sphinx**

Najpierw odczytać repozytoryjny recipe/validator wskazany przez `scientific-documentation-contract`, następnie uruchomić go dokładnie dla zmienionych notatek i pełny build dokumentacji. Expected: PASS bez brakujących parametrów, source-map drift ani MyST/MathJax errors.

- [ ] **Step 5: Commit**

```bash
git add docs/physics docs
git commit -m "docs(fdm): publish mesh cell_size authoring"
```

### Task 7: Końcowy audyt kompletności

**Files:**
- Modify: tylko pliki wymagane przez wykryte regresje.

**Interfaces:**
- Consumes: wszystkie wcześniejsze deliverables.
- Produces: requirement-by-requirement evidence dla całej specyfikacji.

- [ ] **Step 1: Uruchomić pełne właściwe testy Python, IR, planner, runner i API**

Powtórzyć wszystkie komendy z Tasks 1–6 na finalnym drzewie. Każdy wynik musi być świeży i PASS.

- [ ] **Step 2: Sprawdzić publiczny eksport**

Wykonać przykładowy skrypt, wyeksportować go ponownie i potwierdzić strukturalną równoważność IR oraz brak starego API w eksporcie.

- [ ] **Step 3: Sprawdzić zakres diffu i brudne pliki**

Run: `git status --short`

Expected: wyłącznie zachowany, niezwiązany stan `external_solvers/3`; żadnych niezatwierdzonych plików zadania.

- [ ] **Step 4: Opublikować dokumentację**

Wypchnąć commity na `master`, obserwować właściwy workflow publikacyjny do sukcesu i otworzyć opublikowaną stronę. Potwierdzić, że live HTML zawiera `mesh(cell_size=...)` oraz nie pokazuje starego kanonicznego przykładu.

- [ ] **Step 5: Zamknąć cel dopiero po audycie specyfikacji**

Porównać każdą sekcję `docs/superpowers/specs/2026-08-11-physics-first-fdm-cell-size-authoring-design.md` z kodem, testami, artefaktami runtime i live docs. Brak dowodu oznacza dalszą pracę, nie zakończenie.
