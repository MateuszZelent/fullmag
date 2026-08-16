# Kompozycyjny model obiektów fizycznych — plan wdrożenia

> **Dla agentów wykonawczych:** WYMAGANY SUB-SKILL: użyj `subagent-driven-development` (zalecane) albo `executing-plans`, realizując zadania kolejno. Kroki używają składni checkbox (`- [ ]`) do śledzenia postępu.

**Cel:** Zastąpić publiczny podział `magnets[]`/`auxiliary_geometries[]` jednym
kanonicznym `objects[]`, w którym `object_id`, `name`, `type` i jawnie dodane
moduły mają odrębne znaczenia oraz identycznie round-tripują przez Python,
`ProblemIR`, planner, FEM/FDM, API v2 i Control Room.

**Architektura:** `PhysicsObjectIR` jest jedynym publicznym właścicielem
tożsamości obiektu. Magnetyzacja, current, spin i torque są osobnymi modułami
z referencjami po `object_id`; planner buduje prywatną projekcję magnetyczną
dla istniejących backendów. `SceneDocument.objects` staje się authoringowym
odpowiednikiem `ProblemIR.objects`, a UI buduje Explorer wyłącznie z obiektów i
`physics_graph`.

**Tech Stack:** Python 3, pytest, Rust/Serde, `fullmag-ir`,
`fullmag-authoring`, `fullmag-plan`, `fullmag-runner`, Axum/Utoipa/OpenAPI v2,
TypeScript 5.8, React 19, Next.js 16, Vitest, Playwright, FEM/MFEM i FDM/CUDA
uruchamiane przez kontenerowe receptury `just`.

## Globalne ograniczenia

- Kanoniczna specyfikacja:
  `docs/superpowers/specs/2026-08-13-compositional-physics-object-authoring-design.md`.
- Decyzja architektoniczna: `docs/adr/0024-compositional-physics-object-model.md`.
- Semantyka obecności modułu:
  `docs/physics/0995-physics-module-scope-and-activation.md`.
- `object_id` jest niezmienne; rename zmienia `name`, nigdy referencje.
- Dozwolone `type`: `geometry`, `ferromagnet`, `conductor`, `antenna`.
- `type` nie tworzy modułu, nie wybiera operatora i nie podnosi capability.
- Sam odczyt `object.current`/`object.spin_transport` nie mutuje authoringu.
- Elektroda jest BC powierzchniowym modułu current, nie obiektem.
- Publiczny IR ma jedno źródło prawdy. Legacy `magnets` jest tylko wejściem
  migratora, nigdy równoległym polem edytowalnym w nowym writerze.
- Nie zmieniamy równań ani kwalifikacji solverów w tej migracji.
- Przed ciężkimi buildami potwierdź mounty; `just ensure-managed-fem-runtime`
  jest kanoniczną recepturą odtworzenia/wyboru runtime. Cargo używa
  `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects` i
  `CARGO_INCREMENTAL=0`.
- Native FEM/MFEM/CUDA jest weryfikowane wyłącznie przez kontenerowe receptury
  `just`.
- Nie modyfikować ani nie stage'ować `.superpowers/sdd/task-1-report.md`.
- Każdy commit poprzedzić osobnym `git diff --cached --name-only`.

---

## Struktura plików

Nowe pliki:

- `crates/fullmag-ir/src/physics_object.rs` — typy `PhysicsObjectIR`,
  `PhysicsObjectTypeIR`, `ObjectMaterialAssignmentIR`, `PhysicsInterfaceIR`,
  `MagnetizationModuleIR` i ich walidacja.
- `crates/fullmag-ir/tests/physics_object_ir.rs` — kontrakt wersji, migracji,
  serializacji oraz rename.
- `crates/fullmag-plan/src/object_model.rs` — jedyna projekcja publicznych
  obiektów/modułów na dane wejściowe backendów.
- `crates/fullmag-plan/tests/object_model_resolution.rs` — maski/markery,
  wymagania materiałowe oraz brak inferencji z `type`.
- `packages/fullmag-py/src/fullmag/model/physics_object.py` — publiczne
  archetypy, referencje obiektu/regionu/powierzchni i rekord magnetyzacji.
- `packages/fullmag-py/src/fullmag/object_authoring.py` — uchwyty
  `PhysicsObjectHandle`, `ObjectCurrentBuilder`, `ObjectSpinTransportBuilder`,
  `ObjectSpinTorqueBuilder` oraz `InterfaceHandle`.
- `packages/fullmag-py/tests/test_physics_object_authoring.py` — API, brak
  side-effectów akcesorów i lowering.
- `packages/fullmag-py/tests/test_physics_object_script_roundtrip.py` — golden
  Python -> IR -> canonical Python -> IR.
- `crates/fullmag-authoring/tests/physics_object_scene_contract.rs` —
  SceneDocument, rename, migracja i zależności.
- `apps/control-room/src/shared/domain/physics/physicsObject.ts` — parser typu,
  identity i rozpoznanie modułów bez heurystyk legacy.
- `apps/control-room/src/shared/domain/physics/physicsObject.test.ts` — testy
  domenowe.
- `apps/control-room/src/modules/inspector/panels/PhysicsObjectInspectorPanel.tsx`
  — wspólny szablon Inspectora z sekcjami archetypu.
- `apps/control-room/src/modules/inspector/panels/PhysicsObjectInspectorPanel.test.tsx`
  — routing, draft, responsywność i dostępność.
- `apps/control-room/scripts/smoke-physics-object-authoring.mjs` — browser smoke
  obiektu neutralnego, FM, HM i modułu current.
- `scripts/verify_physics_object_runtime_artifacts.py` — walidacja, że scenario
  bez modułu nie publikuje transportu, a scenario z modułem publikuje dokładne
  ID i realizację.

Główne modyfikowane pliki:

- `crates/fullmag-ir/src/lib.rs`
- `crates/fullmag-authoring/src/scene.rs`
- `crates/fullmag-authoring/src/adapters.rs`
- `crates/fullmag-authoring/src/validation.rs`
- `crates/fullmag-authoring/src/physics_graph.rs`
- `crates/fullmag-plan/src/lib.rs`
- `crates/fullmag-plan/src/physics_graph.rs`
- `crates/fullmag-runner/src/dispatch.rs`
- `crates/fullmag-runner/src/physics_graph_execution.rs`
- `crates/fullmag-runner/tests/physics_graph_runtime.rs`
- `packages/fullmag-py/src/fullmag/world.py`
- `packages/fullmag-py/src/fullmag/model/problem.py`
- `packages/fullmag-py/src/fullmag/model/__init__.py`
- `packages/fullmag-py/src/fullmag/__init__.py`
- `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- `crates/fullmag-api/src/schemas/authoring.rs`
- `crates/fullmag-api/src/router_v2/mod.rs`
- `crates/fullmag-api/src/openapi_v2.rs`
- `apps/control-room/src/kernel/api/apiTypes.ts`
- `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`
- `apps/control-room/src/modules/explorer/explorerTypes.ts`
- `apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts`
- `apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts`
- `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`
- `apps/control-room/src/design/styles/inspector-physics.css`
- `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`
- `tests/standard_problems/transport/racetrack_m1_v1/scenario.py`
- `justfile`

---

### Zadanie 1: `ProblemIR 0.4` i typowany kontrakt obiektu

**Pliki:**

- Utwórz: `crates/fullmag-ir/src/physics_object.rs`
- Utwórz: `crates/fullmag-ir/tests/physics_object_ir.rs`
- Utwórz: `tests/golden/problem_ir/bootstrap_v0_3_object_migration.json`
- Modyfikuj: `crates/fullmag-ir/src/lib.rs`
- Modyfikuj: `crates/fullmag-ir/src/validation.rs`

**Interfejsy:**

- Konsumuje: legacy `MagnetIR`, `GeometryIR`, `MaterialIR`, `RegionIR`.
- Produkuje: `PhysicsObjectIR`, `PhysicsObjectTypeIR`,
  `ObjectMaterialAssignmentIR`, `PhysicsInterfaceIR`,
  `MagnetizationModuleIR`, jawny `ProblemIRV04` wire model i kontrolowany
  konwerter `0.3.0 -> 0.4.0`. Publiczny writer pozostaje na 0.3 w tym zadaniu.

- [ ] **Krok 1: Napisz czerwony test publicznego kształtu IR**

```rust
#[test]
fn v0_4_object_type_does_not_imply_magnetization() {
    let mut problem = ProblemIRV04::bootstrap_example();
    problem.objects = vec![PhysicsObjectIR::new(
        "obj_hm",
        "heavy_metal",
        PhysicsObjectTypeIR::Conductor,
        "heavy_metal_geom",
    )];
    problem.magnetization_modules.clear();

    let value = serde_json::to_value(problem).unwrap();
    assert_eq!(value["objects"][0]["type"], "conductor");
    assert_eq!(value["magnetization_modules"], serde_json::json!([]));
    assert!(value.get("magnets").is_none());
}
```

- [ ] **Krok 2: Uruchom test i potwierdź RED**

Uruchom:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 cargo test -p fullmag-ir --test physics_object_ir -- --nocapture
```

Oczekiwane: błąd kompilacji dla brakujących `PhysicsObjectIR`, `objects` i
`magnetization_modules`.

- [ ] **Krok 3: Dodaj typy i zamkniętą walidację**

W `physics_object.rs` dodaj:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PhysicsObjectTypeIR {
    Geometry,
    Ferromagnet,
    Conductor,
    Antenna,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PhysicsObjectIR {
    pub schema_version: String,
    pub object_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub object_type: PhysicsObjectTypeIR,
    pub geometry_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_assignment_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ObjectMaterialAssignmentIR {
    pub schema_version: String,
    pub assignment_id: String,
    pub target: RegionRefIR,
    pub material_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PhysicsInterfaceIR {
    pub schema_version: String,
    pub interface_id: String,
    pub name: String,
    pub side_a: SurfaceRefIR,
    pub side_b: SurfaceRefIR,
    pub side_a_to_side_b: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MagnetizationModuleIR {
    pub schema_version: String,
    pub module_id: String,
    pub target: RegionRefIR,
    pub material_id: String,
    pub initial_magnetization: InitialMagnetizationIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absorbing_boundary: Option<AbsorbingBoundaryLayerIR>,
}
```

Konfiguracja siatki pozostaje w istniejącym `MeshSemanticsIR` i wskazuje
`object_id`; nie należy do modułu magnetyzacji.

Dodaj konstruktory wymagające niepustych ID/nazw i dokładnych wersji
`physics_object.v1`, `object_material_assignment.v1`,
`physics_interface.v1` oraz `magnetization_module.v1`. Dodaj osobny
`ProblemIRV04` i jawny konwerter, ale nie zmieniaj jeszcze `IR_VERSION`,
standardowego `ProblemIR` ani publicznego writera 0.3.

- [ ] **Krok 4: Dodaj jednoznaczną migrację `0.3 -> 0.4`**

Konwerter ma dla każdego legacy magnetu utworzyć dokładnie jeden obiekt i jeden
moduł magnetyzacji. Geometrie niebędące magnesami otrzymują typ z jawnego
legacy hintu `antenna`, a bez hintu `geometry`. Kolizja ID albo brak geometrii
zwraca `Err`, nigdy suffix generowany zależnie od kolejności.

Fixture obejmuje co najmniej dwa obiekty, transformowane geometry assets, dwa
regiony z różnymi materiałami, material parameter fields, surface BC,
zorientowany interfejs cross-object, kolizję nazwy, brak geometrii,
niejednoznaczną referencję legacy oraz dokładny JSON Pointer każdego
`unresolved`.

Dodaj testy:

```rust
#[test]
fn v0_3_magnet_migrates_to_object_and_magnetization_module() {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/golden/problem_ir/bootstrap_v0_3_object_migration.json"
    )).unwrap();
    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();
    assert_eq!(value["ir_version"], "0.4.0");
    assert_eq!(value["objects"].as_array().unwrap().len(), 2);
    assert_eq!(value["magnetization_modules"].as_array().unwrap().len(), 1);
    assert!(value.get("magnets").is_none());
}
```

- [ ] **Krok 5: Dodaj walidację identity i referencji**

Walidator ma odrzucać duplikaty `object_id`, `name`, `assignment_id` i
`interface_id`, brakujące `geometry_id`, brakujący target magnetyzacji lub
materiału, niezgodny materiał, nieistniejące powierzchnie i interfejs bez
dwóch różnych właścicieli. Nie odrzuca `type="conductor"` z modułem
magnetyzacji wyłącznie z powodu typu.

- [ ] **Krok 6: Uruchom pełny pakiet IR**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 cargo test -p fullmag-ir --tests -- --nocapture
```

Oczekiwane: wszystkie testy `fullmag-ir` przechodzą; jawny `ProblemIRV04` nie
zawiera `magnets`, a standardowy publiczny writer nadal emituje poprawne 0.3.

- [ ] **Krok 7: Commit**

```bash
git add crates/fullmag-ir/src/physics_object.rs crates/fullmag-ir/src/lib.rs \
  crates/fullmag-ir/src/validation.rs crates/fullmag-ir/tests/physics_object_ir.rs \
  tests/golden/problem_ir/bootstrap_v0_3_object_migration.json
git diff --cached --name-only
git commit -m "feat(ir): add compositional physics objects"
```

---

### Zadanie 2: SceneDocument jako bezstratny model authoringu

**Pliki:**

- Utwórz: `crates/fullmag-authoring/tests/physics_object_scene_contract.rs`
- Modyfikuj: `crates/fullmag-authoring/src/scene.rs`
- Modyfikuj: `crates/fullmag-authoring/src/adapters.rs`
- Modyfikuj: `crates/fullmag-authoring/src/validation.rs`
- Modyfikuj: `crates/fullmag-authoring/src/physics_graph.rs`

**Interfejsy:**

- Konsumuje: `PhysicsObjectIR`, `MagnetizationModuleIR` z zadania 1.
- Produkuje: `SceneObject.object_type`, opcjonalny `label`, opcjonalny
  `SceneMaterialAssignment`, `SceneInterface`, deterministyczny lowering
  SceneDocument <-> jawny `ProblemIRV04`.

- [ ] **Krok 1: Napisz test rename bez zmiany referencji**

```rust
#[test]
fn rename_preserves_object_id_and_module_targets() {
    let mut scene = fixture_scene_with_current("obj_hm", "heavy_metal");
    scene.objects[0].name = "bottom_heavy_metal".into();
    let problem = scene_to_problem_ir(&scene).unwrap();
    assert_eq!(problem.objects[0].object_id, "obj_hm");
    let value = serde_json::to_value(problem.current_modules[0].clone()).unwrap();
    assert_eq!(value["domain"][0]["object_id"], "obj_hm");
}
```

- [ ] **Krok 2: Potwierdź RED**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 cargo test -p fullmag-authoring \
  --test physics_object_scene_contract -- --nocapture
```

- [ ] **Krok 3: Zastąp `role` polem `object_type`**

Docelowy `SceneObject`:

```rust
pub struct SceneObject {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub object_type: PhysicsObjectTypeIR,
    pub geometry: SceneGeometry,
    #[serde(default)]
    pub transform: Transform3D,
}
```

Nie zachowuj na `SceneObject` alternatywnych pól fizyki ani materiału. Czytnik SceneDocument migruje legacy
`role="magnet"` do `ferromagnet`, `role="antenna"` do `antenna`, a inne role
do `geometry`; writer nie emituje `role`.

SceneDocument otrzymuje root collections `material_assignments` i
`interfaces`. `SceneMaterialAssignment` zachowuje `assignment_id`, dokładny
object/region target i `material_id`. `SceneInterface` zachowuje obie
`SurfaceRefIR` oraz `side_a_to_side_b`. Stare `material_ref` jest wyłącznie
wejściem migratora.

- [ ] **Krok 4: Przenieś magnetyzację z cechy obiektu do modułu**

Migrator legacy Scene -> nowy SceneDocument tworzy `MagnetizationModuleIR`
tylko, gdy istnieje dawne `magnetization_ref` i materiał zawiera wymagane
parametry magnetyczne. Brak magnetyzacji nie jest uzupełniany stanem uniform.
Nowy SceneDocument przechowuje moduł w root family collection i nie zapisuje
`magnetization_ref` na obiekcie.

Normatywna własność danych po migracji:

| Dane | Jedyny właściciel SceneDocument | Derived |
|---|---|---|
| identity/geometry/type | `objects[]` | tree/viewport projections |
| object/region material | `material_assignments[]` | Inspector grouping |
| magnetization/current/spin/torque/Oersted | root family collections z `module_id` | `physics_graph` |
| interfejs geometryczny | `interfaces[]` | graph interface scope |
| zależności i activation | wynik normalizera graphu | Explorer status |

`physics_stack`, `magnetization_ref` i ScriptBuilder mogą być czytane przez
migrator, lecz po przełączeniu writera nie są alternatywnymi edytowalnymi
źródłami. Dodaj test odrzucający sprzeczny legacy payload i test bezpośredni
Scene <-> ProblemIRV04 bez skryptu pośredniego.

- [ ] **Krok 5: Zaostrz walidację SceneDocument**

Usuń warunek `object.role != "magnet"` z walidacji materiału. Zastąp go
walidacją zależną od obecnego modułu. Dodaj testy neutralnej geometrii bez
materiału, conductora z materiałem elektrycznym i ferromagnetyka bez
magnetyzacji jako poprawnego draftu, który zostanie odrzucony dopiero przy
próbie uruchomienia badania wymagającego LLG.

Dodaj golden round-trip dwóch regionów jednego obiektu z różnymi materiałami
i niezależnymi material parameter fields; żadna ścieżka nie może spłaszczyć
ich do pojedynczego `material_ref`.

- [ ] **Krok 6: Uruchom authoring i graph contracts**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 cargo test -p fullmag-authoring --tests -- --nocapture
```

- [ ] **Krok 7: Commit**

```bash
git add crates/fullmag-authoring/src/scene.rs \
  crates/fullmag-authoring/src/adapters.rs \
  crates/fullmag-authoring/src/validation.rs \
  crates/fullmag-authoring/src/physics_graph.rs \
  crates/fullmag-authoring/tests/physics_object_scene_contract.rs
git diff --cached --name-only
git commit -m "feat(authoring): normalize typed physics objects"
```

---

### Zadanie 3: Bazowy Python `PhysicsObjectHandle`

**Pliki:**

- Utwórz: `packages/fullmag-py/src/fullmag/model/physics_object.py`
- Utwórz: `packages/fullmag-py/src/fullmag/object_authoring.py`
- Utwórz: `packages/fullmag-py/tests/test_physics_object_authoring.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/world.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/model/problem.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/model/__init__.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/__init__.py`

**Interfejsy:**

- Konsumuje: `PhysicsObjectIR` shape z zadania 1.
- Produkuje: `StudyBuilder.object(...) -> PhysicsObjectHandle`, registry po ID
  i nazwie, `ObjectRef`, `ObjectRegionHandle`, `ObjectSurfaceHandle`.

- [ ] **Krok 1: Dodaj rzeczywisty helper capture i test, że typ nie tworzy fizyki**

```python
from pathlib import Path
from tempfile import TemporaryDirectory
import textwrap

import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import export_builder_draft


def _capture_scene(source: str):
    with TemporaryDirectory() as directory:
        path = Path(directory) / "scenario.py"
        path.write_text(textwrap.dedent(source), encoding="utf-8")
        loaded = fm.load_problem_from_script(path, lightweight_assets=True)
        return build_scene_document_from_builder(export_builder_draft(loaded))


def test_conductor_type_does_not_create_current_or_magnetization():
    scene = _capture_scene("""
        import fullmag as fm
        study = fm.study("objects")
        hm = study.object(
            fm.Box(100e-9, 40e-9, 5e-9),
            name="heavy_metal",
            type="conductor",
        )
    """)
    assert scene["objects"][0]["name"] == "heavy_metal"
    assert scene["objects"][0]["type"] == "conductor"
    assert scene["magnetization_modules"] == []
    assert scene["current_transports"] == []
```

- [ ] **Krok 2: Potwierdź RED**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_physics_object_authoring.py -q
```

- [ ] **Krok 3: Dodaj model tożsamości i walidację**

```python
PhysicsObjectType = Literal["geometry", "ferromagnet", "conductor", "antenna"]

@dataclass(frozen=True, slots=True)
class ObjectRef:
    object_id: str

@dataclass(frozen=True, slots=True)
class ObjectSurfaceRef:
    object_id: str
    surface_id: str
    orientation: tuple[float, float, float]
```

`PhysicsObjectHandle` przechowuje `_object_id`, `_name`, `_type`, `_shape` i
referencję do stanu studium. `StudyBuilder.object` wymaga jawnego `name`,
sprawdza unikalność ID/nazwy i zwraca uchwyt. Wygenerowany ID jest
deterministycznym `obj_<slug>`, ale kolizja jest błędem wymagającym jawnego
`object_id`, nie automatycznego numerowania.

Nie dodawaj `StudyBuilder.build()`: repozytoryjny kontrakt jest stage-first i
jest przechwytywany przez `load_problem_from_script`. Testy obiektów korzystają
z `_capture_scene`, a pełny ProblemIR jest testowany po atomowym przełączeniu
writera w zadaniu 7.

- [ ] **Krok 4: Dodaj lookup po nazwie bez serializacji nazwy jako referencji**

```python
study = fm.study("lookup")
hm = study.object(fm.Box(10e-9, 10e-9, 2e-9), name="heavy_metal")
assert study.objects["heavy_metal"] is hm
assert hm.ref.object_id == "obj_heavy_metal"
hm.rename("bottom_heavy_metal")
assert hm.ref.object_id == "obj_heavy_metal"
```

Lowering wszystkich `RegionRef`/`SurfaceRef` zapisuje wyłącznie ID.

- [ ] **Krok 5: Oddziel material assignment od modułu**

Dodaj `hm.material.assign(material, region=None)`, które tworzy przypisanie
materiałowe, ale nie tworzy graph node. Brak materiału jest legalny dla
obiektu `geometry` i authoringowego draftu każdego typu.

- [ ] **Krok 6: Uruchom testy Python**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_physics_object_authoring.py \
  packages/fullmag-py/tests/test_physics_scope_graph.py -q
```

- [ ] **Krok 7: Commit**

```bash
git add packages/fullmag-py/src/fullmag/model/physics_object.py \
  packages/fullmag-py/src/fullmag/object_authoring.py \
  packages/fullmag-py/src/fullmag/world.py \
  packages/fullmag-py/src/fullmag/model/problem.py \
  packages/fullmag-py/src/fullmag/model/__init__.py \
  packages/fullmag-py/src/fullmag/__init__.py \
  packages/fullmag-py/tests/test_physics_object_authoring.py
git diff --cached --name-only
git commit -m "feat(python): add canonical physics objects"
```

---

### Zadanie 4: Obiektowe moduły magnetyzacji i current transport

**Pliki:**

- Modyfikuj: `packages/fullmag-py/src/fullmag/object_authoring.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/world.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/model/problem.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/model/current_transport.py`
- Modyfikuj: `packages/fullmag-py/tests/test_physics_object_authoring.py`

**Interfejsy:**

- Konsumuje: istniejące `CurrentTransport`, `RegionRef`, `ChargeBoundary`,
  `ChargePotentialGauge`, materiały transportowe.
- Produkuje: `object.magnetization.configure`, `object.current.solve`,
  `CurrentModuleHandle.electrode`, dokładne scope'y po `object_id`.

- [ ] **Krok 1: Napisz test braku side-effectu akcesorów**

```python
def test_reading_module_accessors_does_not_author_modules():
    scene = _capture_scene("""
        import fullmag as fm
        study = fm.study("accessors")
        body = study.object(fm.Box(1e-6, 100e-9, 5e-9), name="body")
        assert body.current is body.current
        assert body.magnetization is body.magnetization
    """)
    assert scene["current_transports"] == []
    assert scene["magnetization_modules"] == []
```

- [ ] **Krok 2: Dodaj jawne tworzenie magnetyzacji**

```python
module = free_layer.magnetization.configure(
    name="free_layer_m",
    material=cofeb,
    initial_state=fm.texture.uniform(1, 0, 0),
)
assert module.target.object_id == free_layer.object_id
```

Drugie `configure` z tym samym `name` aktualizuje wyłącznie w jawnej metodzie
`replace`; zwykłe `configure` odrzuca duplikat ID.

- [ ] **Krok 3: Dodaj current solve jako cienki builder istniejącej rodziny**

```python
charge = hm.current.solve(
    name="hm_charge",
    conductivity_s_per_m=5.0e6,
    gauge=fm.ChargePotentialGauge(kind="dirichlet_reference"),
)
```

Builder tworzy `CurrentTransport(model="ohmic_poisson",
domain=(RegionRef(hm.object_id),))` oraz dokładnie jedno
`ChargeTransportMaterialAssignment` z `ChargeTransportMaterial` zbudowanym z
`conductivity_s_per_m`. Nie dodaje domyślnych elektrod ani domyślnego prądu.

- [ ] **Krok 4: Dodaj elektrody powierzchniowe**

`hm.surface(selector, orientation=...)` zwraca typowany `ObjectSurfaceRef`.
`charge.electrode(...)` dołącza istniejący wariant `ChargeBoundary` z
`SurfaceRef`; sprawdza właściciela solve domain i unikalność nazwy BC.

Test:

```python
source = charge.electrode(
    name="source",
    surface=hm.surface("x-", orientation=(-1.0, 0.0, 0.0)),
    outward_current_density_Apm2=1.0e12,
)
assert source.surface.object_id == hm.object_id
```

Builder mapuje ten zapis dokładnie na
`NormalCurrentElectrode(id=name, surfaces=(surface,),
outward_current_density_Apm2=...)`. Dla `potential_V` tworzy
`VoltageElectrode`; podanie obu wymuszeń jest błędem.

- [ ] **Krok 5: Zamroź maszynę activation dla modułów current**

Dodaj testy i normalizację według tabeli:

| Stan authoringu | Activation | Wykonanie |
|---|---|---|
| moduł bez kompletnego BC | `configured` | zakazane |
| kompletne BC, wszystkie wymuszenia zero | `inactive` | zakazane |
| kompletne niezerowe BC | `active` | dozwolone po capability |
| brak named dependency/target | `blocked` | zakazane |
| nieznana rodzina zachowana z nowszego IR | `unsupported` | zakazane |

Każda zmiana BC przelicza stan current oraz wszystkich dependent spin/torque
edges atomowo. Explorer nadal pokazuje `configured`, `inactive`, `blocked` i
`unsupported` jako istniejące rekordy.

- [ ] **Krok 6: Uruchom testy current i scope graph**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_physics_object_authoring.py \
  packages/fullmag-py/tests/test_current_transport.py \
  packages/fullmag-py/tests/test_physics_scope_graph.py -q
```

- [ ] **Krok 7: Commit**

```bash
git add packages/fullmag-py/src/fullmag/object_authoring.py \
  packages/fullmag-py/src/fullmag/world.py \
  packages/fullmag-py/src/fullmag/model/problem.py \
  packages/fullmag-py/src/fullmag/model/current_transport.py \
  packages/fullmag-py/tests/test_physics_object_authoring.py
git diff --cached --name-only
git commit -m "feat(python): compose object-scoped current modules"
```

---

### Zadanie 5: Spin transport, interfejs i transportowy torque

**Pliki:**

- Modyfikuj: `packages/fullmag-py/src/fullmag/object_authoring.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/model/spin_transport.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/model/spin_torque.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/model/couplings.py`
- Modyfikuj: `packages/fullmag-py/tests/test_physics_object_authoring.py`
- Modyfikuj: `tests/standard_problems/transport/racetrack_m1_v1/scenario.py`

**Interfejsy:**

- Konsumuje: `SpinDriftDiffusion`, `MixingConductanceSpinInterface`,
  `TransparentSpinInterface`, `DriftDiffusionSpinTorque`, uchwyt current z
  zadania 4 i root `PhysicsInterfaceIR` z zadania 1.
- Produkuje: `object.spin_transport.she`, `study.interface`,
  `interface.spin_mixing.configure`, `object.spin_torque.from_transport`.

- [ ] **Krok 1: Napisz pełny test grafu HM/FM**

W tym samym pliku zdefiniuj fixture `racetrack_study` jako kompletny builder:
tworzy `cofeb` i materiał HM, dwa obiekty, przypisania, current, spin,
oriented root interface i torque dokładnie publicznymi uchwytami opisanymi w
tym zadaniu. Fixture zwraca draft akceptowany przez
`build_scene_document_from_builder`; nie wywołuje nieistniejącego `build()`.

```python
def test_hm_fm_handles_lower_to_exact_dependency_graph(racetrack_study):
    scene = build_scene_document_from_builder(racetrack_study)
    modules = {module["id"]: module for module in scene["physics_graph"]["modules"]}
    assert modules["hm_spin"]["depends_on"] == ["hm_charge"]
    assert modules["hm_fm"]["applies_to"][0]["kind"] == "cross_object"
    assert modules["transport_torque"]["depends_on"] == ["hm_spin"]
    assert modules["transport_torque"]["solve_domain"] == [
        {"object_id": "obj_free_layer"}
    ]
```

- [ ] **Krok 2: Potwierdź RED**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_physics_object_authoring.py \
  -k hm_fm_handles -q
```

- [ ] **Krok 3: Dodaj builder SHE bez duplikowania fizyki**

Builder wypełnia istniejące `SpinDriftDiffusion(id, current_source_id, domain,
materials, interfaces, boundaries, solver, requested_execution, mode)` i
wymaga uchwytu `CurrentModuleHandle`. Nie przyjmuje tekstowego source ID w
nowym API. Argumenty materiałowe buildera są dokładnie zgodne z
`SpinTransportMaterial`: `sigma_s_Spm`, `polarization_p`, `theta_sh`,
`lambda_sf_m`, opcjonalne `lambda_j_m`, `lambda_phi_m` i parametry
capacitance/DOS.

- [ ] **Krok 4: Dodaj zorientowany interfejs**

```python
interface = study.interface(
    name="hm_fm",
    side_a=hm.surface("z+", orientation=(0.0, 0.0, 1.0)),
    side_b=free_layer.surface("z-", orientation=(0.0, 0.0, -1.0)),
)
```

Walidacja wymaga różnych `object_id`, przeciwnych orientacji w tolerancji
kontraktu i jawnych selectorów. Interfejs jest rejestrowany raz jako root
`PhysicsInterfaceIR`; mixing module zapisuje `interface_id`, a nie drugą kopię
stron.

- [ ] **Krok 5: Dodaj mixing i torque z uchwytów**

`interface.spin_mixing.configure(spin_transport=spin,
g_up_Spm2=..., g_down_Spm2=..., g_r_Spm2=..., g_i_Spm2=...)` tworzy
`MixingConductanceSpinInterface` rozszerzony o kanoniczne `interface_id`.
`free_layer.spin_torque.from_transport(...)` tworzy istniejący
`DriftDiffusionSpinTorque(id, solve_id, target)`. Lowering zachowuje wszystkie
parametry rodzinne i stabilne dependency IDs.

- [ ] **Krok 6: Przenieś publiczny fixture racetracku**

`tests/standard_problems/transport/racetrack_m1_v1/scenario.py` ma używać
`study.object` oraz obiektowych modułów bez konstruktorów strukturalnych
`Problem(...)`. Golden IR aktualizuj dopiero po przejściu testu semantycznej
równości, nie przez bezkrytyczne nadpisanie.

Fixture zachowuje dokładnie `x- = -J_x`, `x+ = +J_x`, interfejs
`hm:z+ -> fm:z-`, pełne zbiory powierzchni insulating/spin oraz flat
module-level `study`. Test porównuje te rekordy z `fixture.v1.json`, a nie z
duplikatem oczekiwań wpisanym ręcznie w test.

- [ ] **Krok 7: Uruchom testy spin/racetrack**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_spin_drift_diffusion.py \
  packages/fullmag-py/tests/test_spin_torque.py \
  packages/fullmag-py/tests/test_physics_object_authoring.py \
  tests/standard_problems/transport/racetrack_m1_v1/test_public_scenario.py -q
```

- [ ] **Krok 8: Commit**

```bash
git add packages/fullmag-py/src/fullmag/object_authoring.py \
  packages/fullmag-py/src/fullmag/model/spin_transport.py \
  packages/fullmag-py/src/fullmag/model/spin_torque.py \
  packages/fullmag-py/src/fullmag/model/couplings.py \
  packages/fullmag-py/tests/test_physics_object_authoring.py \
  tests/standard_problems/transport/racetrack_m1_v1/scenario.py \
  tests/standard_problems/transport/racetrack_m1_v1/python_problem_ir.v1.json
git diff --cached --name-only
git commit -m "feat(python): compose HM FM transport interfaces"
```

---

### Zadanie 6: Canonical script export i adaptery legacy

**Pliki:**

- Utwórz: `packages/fullmag-py/tests/test_physics_object_script_roundtrip.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modyfikuj: `packages/fullmag-py/src/fullmag/world.py`
- Modyfikuj: `packages/fullmag-py/tests/test_script_builder_roundtrip.py`

**Interfejsy:**

- Konsumuje: nowe obiekty i moduły z zadań 3–5.
- Produkuje: canonical Python bez `geometry()`/`antenna_object()`, kontrolowane
  adaptery odczytu legacy i golden round-trip.

- [ ] **Krok 1: Napisz test dwóch przebiegów round-trip**

```python
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import (
    export_builder_draft,
    rewrite_loaded_problem_script,
)


def _load(path: Path):
    return fm.load_problem_from_script(path, lightweight_assets=True)


def _scene(loaded):
    return json.loads(json.dumps(
        build_scene_document_from_builder(export_builder_draft(loaded)),
        sort_keys=True,
    ))


def test_canonical_export_uses_objects_and_explicit_modules(racetrack_source):
    with TemporaryDirectory() as directory:
        first_path = Path(directory) / "first.py"
        first_path.write_text(racetrack_source, encoding="utf-8")
        first = _load(first_path)
        rendered = rewrite_loaded_problem_script(
            first,
            overrides=export_builder_draft(first),
        )["rendered_source"]
        assert "study.object(" in rendered
        assert "type=\"conductor\"" in rendered
        assert ".current.solve(" in rendered
        assert ".spin_transport.she(" in rendered
        assert "study.geometry(" not in rendered
        assert "study.antenna_object(" not in rendered
        second_path = Path(directory) / "second.py"
        second_path.write_text(rendered, encoding="utf-8")
        assert _scene(_load(second_path)) == _scene(first)
```

`racetrack_source` jest fixture w tym samym pliku i zawiera kompletny,
samowystarczalny stage-first skrypt HM/FM; nie jest niezdefiniowanym fixture
pytest.

- [ ] **Krok 2: Potwierdź RED**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_physics_object_script_roundtrip.py -q
```

- [ ] **Krok 3: Przepisz exporter w kolejności zależności**

Exporter emituje: study, obiekty, materiały/przypisania, regiony, moduły
magnetyzacji/current/spin, interfejsy, torque, global physics, etapy. Nazwy
lokalnych zmiennych wynikają z `name`, lecz wszystkie referencje w IR
pozostają po ID.

- [ ] **Krok 4: Dodaj deprecacje legacy bez zmiany zachowania starych skryptów**

`geometry(shape, name)` deleguje do `object(..., type="ferromagnet")`, a
`antenna_object` do `object(..., type="antenna")`. Każdy adapter emituje
`FutureWarning` raz na callsite. Nie generuje ostrzeżenia podczas odczytu
starego zapisanego IR przez migrator.

- [ ] **Krok 5: Dodaj jawny namespace global physics**

`StudyBuilder.physics.external_field.uniform(name, B)` jest cienkim builderem
istniejącego `RegionalFieldDrive` z `FieldTarget.global_domain()`. Sam odczyt
`study.physics` nie tworzy rekordu. Exporter emituje ten zapis wyłącznie dla
dokładnego globalnego uniform field; inne waveform/profile pozostają przy
`study.field_drives.add(...)`. Dodaj round-trip obu wariantów.

- [ ] **Krok 6: Dodaj statyczny gate eksportera**

```bash
rg -n 'study\.(geometry|antenna_object)\(' \
  tests/standard_problems examples public_docs/site
```

Oczekiwane: brak nowych kanonicznych przykładów; jawne fixture legacy mogą
pozostać wyłącznie w katalogu testów migracji.

- [ ] **Krok 7: Uruchom oba pakiety round-trip**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_physics_object_script_roundtrip.py \
  packages/fullmag-py/tests/test_script_builder_roundtrip.py -q
```

- [ ] **Krok 8: Commit**

```bash
git add packages/fullmag-py/src/fullmag/runtime/scene_document.py \
  packages/fullmag-py/src/fullmag/runtime/script_builder.py \
  packages/fullmag-py/src/fullmag/world.py \
  packages/fullmag-py/tests/test_physics_object_script_roundtrip.py \
  packages/fullmag-py/tests/test_script_builder_roundtrip.py
git diff --cached --name-only
git commit -m "feat(python): export canonical physics object scripts"
```

---

### Zadanie 7: Planner, maski FDM, markery FEM i proweniencja

**Pliki:**

- Utwórz: `crates/fullmag-plan/src/object_model.rs`
- Utwórz: `crates/fullmag-plan/tests/object_model_resolution.rs`
- Modyfikuj: `crates/fullmag-plan/src/lib.rs`
- Modyfikuj: `crates/fullmag-plan/src/fdm.rs`
- Modyfikuj: `crates/fullmag-plan/src/fem.rs`
- Modyfikuj: `crates/fullmag-plan/src/physics_graph.rs`
- Modyfikuj: `crates/fullmag-runner/src/dispatch.rs`
- Modyfikuj: `crates/fullmag-runner/src/physics_graph_execution.rs`
- Modyfikuj: `crates/fullmag-runner/tests/physics_graph_runtime.rs`

**Interfejsy:**

- Konsumuje: `ProblemIR.objects`, `magnetization_modules`, graph scope refs.
- Produkuje: `ResolvedObjectModel`, prywatną `ResolvedMagneticObject`,
  certyfikaty masek/markerów i identity provenance.

- [ ] **Krok 1: Napisz test zakazu inferencji z typu**

W tym samym pliku zdefiniuj lokalny fixture `object_type_only_problem()`:
zbuduj `ProblemIR::bootstrap_example()`, przeprowadź go przez jawny
`migrate_v0_3_problem_ir_to_v0_4`, pozostaw jeden obiekt o zadanym `type` i
wyczyść wszystkie kolekcje modułów fizyki. Nie wprowadzaj niezdefiniowanego
helpera testowego.

```rust
#[test]
fn ferromagnet_type_without_module_does_not_enter_llg_or_transport() {
    let problem = object_type_only_problem(PhysicsObjectTypeIR::Ferromagnet);
    let resolved = resolve_object_model(&problem).unwrap();
    assert!(resolved.magnetic_objects.is_empty());
    assert!(resolved.current_domains.is_empty());
}
```

- [ ] **Krok 2: Napisz test dokładnej realizacji zakresu**

Fixture `hm_fm_problem()` powstaje przez migrację kanonicznego
`expected_lowering.json` z zadania 1. `certified_fdm_topology_from_fixture()`
buduje rzeczywistą warstwę komórek z jej `counts` i położenia, natomiast
`single_tet_fem_topology_with_object_markers()` tworzy po jednym `Tet4` na HM
i FM, dwa różne markery elementów oraz dwa `FemDomainRegionMarkerIR`. Żaden
fixture nie wiąże obiektu przez nazwę geometrii.

```rust
#[test]
fn same_scope_resolves_to_fdm_mask_and_fem_markers_with_one_identity() {
    let problem = hm_fm_problem();
    let fdm = resolve_object_model_for_fdm(
        &problem,
        &certified_fdm_topology_from_fixture(),
    ).unwrap();
    let fem = resolve_object_model_for_fem(
        &problem,
        &single_tet_fem_topology_with_object_markers(),
    ).unwrap();
    assert_eq!(fdm.objects["obj_hm"].semantic_id, "obj_hm");
    assert_eq!(fem.objects["obj_hm"].semantic_id, "obj_hm");
    assert_ne!(fdm.objects["obj_hm"].realization_digest, "");
    assert_ne!(fem.objects["obj_hm"].realization_digest, "");
}
```

- [ ] **Krok 3: Potwierdź RED**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 cargo test -p fullmag-plan \
  --test object_model_resolution -- --nocapture
```

- [ ] **Krok 4: Dodaj jedyny resolver modelu obiektowego**

`resolve_object_model(problem)` indeksuje obiekty po ID, wiąże moduły i
zwraca błędy zbiorcze. Wszystkie ścieżki planera korzystają z tego wyniku.
Usuń bezpośrednie wyszukiwanie magnetów po nazwie i aliasowanie
`magnet.name == geometry.name`.

- [ ] **Krok 5: Przenieś backendowe dane magnetyczne do prywatnej projekcji**

`ResolvedMagneticObject` zawiera dokładnie dane wymagane dotychczas przez
backend, ale powstaje z `MagnetizationModuleIR + PhysicsObjectIR + MaterialIR`.
Nie jest serializowany do publicznego `ProblemIR`.

- [ ] **Krok 6: Rozszerz realization provenance**

Każdy rekord zapisuje `object_id`, authored `name`, `type`, `scene_revision`,
realization kind (`fdm_cell_mask` albo `fem_element_markers`), digest i zależne
module IDs. Rename zmienia snapshot authored metadata, ale nie semantic ID.

- [ ] **Krok 7: Przełącz atomowo publiczny writer i pełny łańcuch migracji**

Dopiero po przejściu kontraktów Python/Scene/planner ustaw standardowy writer
na `ProblemIR 0.4.0`, `IR_VERSION = 0.4.0` i `PREVIOUS_IR_VERSION = 0.3.0`.
Standardowy reader przyjmuje bezpośrednio 0.4 i 0.3, a starsze dane przechodzą
wyłącznie przez audytowalny łańcuch `0.1 -> 0.2 -> 0.3 -> 0.4`. Dodaj fixture
każdego kroku oraz raport migracji zapisujący wersję źródłową, kolejne kroki,
ostrzeżenia i mapę zachowanych ID. Przed commitem uruchom publiczny test
`Python -> ProblemIR 0.4 -> planner`; nie pozostawiaj okresu, w którym writer
emituje 0.4, a planner nadal oczekuje `magnets`.

- [ ] **Krok 8: Dodaj statyczny gate usunięcia publicznych odczytów magnets**

```bash
rg -n 'problem\.magnets|ProblemIR.*magnets|\.magnets\b' \
  crates/fullmag-plan crates/fullmag-runner crates/fullmag-engine
```

Oczekiwane: zero trafień poza jawnie nazwanymi testami migracyjnymi i
prywatnym typem projekcji niezawierającym pola `ProblemIR.magnets`.

- [ ] **Krok 9: Uruchom testy Python, IR, planera i runnera**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_physics_object_lowering.py \
  packages/fullmag-py/tests/test_physics_object_script_roundtrip.py -q
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 cargo test -p fullmag-ir --tests -- --nocapture
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 cargo test -p fullmag-plan --tests -- --nocapture
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 cargo test -p fullmag-runner \
  --test physics_graph_runtime -- --nocapture
```

- [ ] **Krok 10: Commit**

```bash
git add crates/fullmag-plan/src/object_model.rs crates/fullmag-plan/src/lib.rs \
  crates/fullmag-plan/src/fdm.rs crates/fullmag-plan/src/fem.rs \
  crates/fullmag-plan/src/physics_graph.rs \
  crates/fullmag-plan/tests/object_model_resolution.rs \
  crates/fullmag-runner/src/dispatch.rs \
  crates/fullmag-runner/src/physics_graph_execution.rs \
  crates/fullmag-runner/tests/physics_graph_runtime.rs \
  crates/fullmag-ir/src/lib.rs crates/fullmag-ir/src/model.rs \
  packages/fullmag-py/src/fullmag/model/problem.py
git diff --cached --name-only
git commit -m "feat(plan): resolve compositional physics objects"
```

---

### Zadanie 8: API v2, OpenAPI i wygenerowany klient

**Pliki:**

- Modyfikuj: `crates/fullmag-api/src/router_v2/handlers/model.rs`
- Modyfikuj: `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- Modyfikuj: `crates/fullmag-api/src/router_v2/mod.rs`
- Modyfikuj: `crates/fullmag-api/src/schemas/authoring.rs`
- Modyfikuj: `crates/fullmag-api/src/openapi_v2.rs`
- Modyfikuj: `crates/fullmag-api/src/router_v2/tests.rs`
- Regeneruj: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regeneruj: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Regeneruj: `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`
- Modyfikuj: `apps/control-room/src/kernel/api/apiTypes.ts`
- Modyfikuj: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modyfikuj: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`

**Interfejsy:**

- Konsumuje: `SceneObject` z zadania 2.
- Produkuje: typowane create/patch/read object resources, revision precondition,
  dependency-safe delete, wygenerowane typy frontendowe.

- [ ] **Krok 1: Napisz test API create/rename/delete**

Test korzysta z istniejących `sample_scene_document()` i
`test_app_state_with_live_session()`. W tym samym module zdefiniuj cienkie
helpery HTTP `post_object`, `patch_object_name`, `get_authoring_scene` i
`delete_object` jako wywołania routera przez `tower::ServiceExt::oneshot`;
helpery zawsze przekazują `base_revision` zwrócone przez poprzednią odpowiedź.
Nie używaj niezdefiniowanych fixture ani alternatywnego serwera testowego.

```rust
#[tokio::test]
async fn object_identity_survives_rename_and_blocks_dependent_delete() {
    let app = test_app_state_with_live_session(sample_scene_document()).await;
    let created = post_object(&app, None, "heavy_metal", "conductor").await;
    let object_id = created.object_id;
    patch_object_name(&app, &object_id, "bottom_hm").await;
    let scene = get_authoring_scene(&app).await;
    assert_eq!(scene["objects"][0]["id"], object_id);
    assert_eq!(scene["objects"][0]["name"], "bottom_hm");
    assert_eq!(delete_object(&app, &object_id).await.status(), 409);
}
```

- [ ] **Krok 2: Potwierdź RED**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 cargo test -p fullmag-api \
  object_identity_survives_rename_and_blocks_dependent_delete -- --nocapture
```

- [ ] **Krok 3: Zmień schema request/resource**

`ObjectCreateRequest` wymaga `name`, `type`, `geometry`, a `object_id` i `label`
są opcjonalne. Normalny authoring nie przesyła ID: serwer przydziela je
atomowo i zwraca. Jawne ID jest akceptowane wyłącznie przez import/migrację,
z walidacją kolizji. `ObjectPatchRequest` pozwala zmienić `name` i `label`,
ale nie `object_id` ani `type`. Zmiana `type` jest osobną transakcją
`reclassify_object` w istniejącym `/model/transactions`; waliduje zgodność
modułów, zapisuje proweniencję i albo przechodzi atomowo, albo nie zmienia
sceny. Materiał pozostaje osobnym root `material_assignments[]`.

- [ ] **Krok 4: Rozszerz istniejące cienkie handlery obiektowe**

Zachowaj istniejące ścieżki:

```text
POST   /v2/sessions/current/model/objects
PATCH  /v2/sessions/current/model/objects/{object_id}
DELETE /v2/sessions/current/model/objects/{object_id}
```

Implementację zachowaj w istniejących handlerach `model.rs` i `authoring.rs`.
Lista nadal pochodzi z revisioned `model/authoring`; nie dodawaj redundantnego
cache ani ręcznego endpointu tylko dla komponentu. Delete zwraca `409` z listą
zależnych module/interface IDs.

- [ ] **Krok 5: Regeneruj OpenAPI i klient**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 pnpm --dir apps/control-room generate:api
```

Nie edytuj ręcznie plików `generated/*`.

- [ ] **Krok 6: Uruchom kontrakty API**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 cargo test -p fullmag-api --tests -- --nocapture
pnpm --dir apps/control-room exec vitest run \
  src/kernel/api/ControlRoomApi.test.ts \
  src/kernel/api/openapiV2GeneratedContract.test.ts
pnpm --dir apps/control-room check:api-hygiene
```

- [ ] **Krok 7: Commit**

```bash
git add crates/fullmag-api/src/router_v2/handlers/model.rs \
  crates/fullmag-api/src/router_v2/handlers/model/authoring.rs \
  crates/fullmag-api/src/router_v2/mod.rs \
  crates/fullmag-api/src/schemas/authoring.rs \
  crates/fullmag-api/src/openapi_v2.rs \
  crates/fullmag-api/src/router_v2/tests.rs \
  apps/control-room/src/kernel/api/generated/openapi-v2.json \
  apps/control-room/src/kernel/api/generated/openapi-v2-types.ts \
  apps/control-room/src/kernel/api/generated/openapi-v2-client.ts \
  apps/control-room/src/kernel/api/apiTypes.ts \
  apps/control-room/src/kernel/api/ControlRoomApi.ts \
  apps/control-room/src/kernel/api/ControlRoomApi.test.ts
git diff --cached --name-only
git commit -m "feat(api): expose typed physics objects"
```

---

### Zadanie 9: Explorer z obiektów i faktycznie zapisanych modułów

**Pliki:**

- Utwórz: `apps/control-room/src/shared/domain/physics/physicsObject.ts`
- Utwórz: `apps/control-room/src/shared/domain/physics/physicsObject.test.ts`
- Modyfikuj: `apps/control-room/src/modules/explorer/explorerTypes.ts`
- Modyfikuj: `apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts`
- Modyfikuj: `apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts`
- Modyfikuj: `apps/control-room/src/modules/explorer/builders/physicsGraphTree.ts`
- Modyfikuj: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Modyfikuj: `apps/control-room/src/modules/explorer/builders/physicsGraphTree.test.ts`

**Interfejsy:**

- Konsumuje: generated `SceneObjectResource.type`, physics graph resource.
- Produkuje: `objectType` zamiast `objectRole`, per-object module children,
  `Interfaces` i `Global Physics` bez pustych rodzin.

- [ ] **Krok 1: Napisz test pustego conductora**

W `buildModelTree.test.ts` zdefiniuj lokalne, typowane helpery zamiast
pozostawiać pseudokod: `snapshotWithObject` zwraca minimalny
`ModelTreeSnapshot` z jednym obiektem i bez graph modules;
`snapshotWithInactiveCurrent` dodaje dokładnie jeden authored graph node
`hm_charge` ze statusem `inactive`; `findNode` przechodzi rekurencyjnie po
`children` i rzuca błąd przy braku ID; `flattenKinds` i `flattenLabels`
rekurencyjnie zwracają wartości dla całego poddrzewa.

```typescript
it("does not invent current or spin nodes from conductor type", () => {
  const tree = buildModelTree(snapshotWithObject({
    id: "obj_hm",
    name: "heavy_metal",
    type: "conductor",
  }));
  const object = findNode(tree, "model:object:obj_hm");
  expect(flattenKinds(object)).not.toContain("physics.module");
  expect(flattenLabels(object)).not.toContain("Current Transport");
  expect(flattenLabels(object)).not.toContain("Spin Transport");
});
```

- [ ] **Krok 2: Napisz test obecnego, nieaktywnego modułu**

```typescript
it("keeps an authored inactive module visible", () => {
  const tree = buildModelTree(snapshotWithInactiveCurrent("obj_hm"));
  const module = findNode(tree, "physics:module:hm_charge");
  expect(module.status).toBe("inactive");
  expect(module.objectId).toBe("obj_hm");
});
```

- [ ] **Krok 3: Potwierdź RED**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/shared/domain/physics/physicsObject.test.ts \
  src/modules/explorer/builders/buildModelTree.test.ts \
  src/modules/explorer/builders/physicsGraphTree.test.ts
```

- [ ] **Krok 4: Usuń heurystyki `role`, tagów i visualization hintów**

`sceneModelTreeAdapter` czyta wyłącznie `object.type`. Forward-unknown typ
mapuje na `unsupported`, zachowuje ID i blokuje mutacje. Nie sprawdza
`role:antenna`, `visualization_hint.role` ani obecności magnetization_ref do
ustalenia archetypu.

- [ ] **Krok 5: Przebuduj dzieci obiektu**

Każdy obiekt zawsze ma Identity/Geometry; Materials tylko przy przypisaniach;
Magnetization/Current/Spin/Torque tylko przy odpowiadającym graph module.
Interfejs jest w pojedynczej gałęzi `Interfaces` z linkami do stron. Globalny
field/Oersted jest w `Global Physics` zgodnie ze scope.

- [ ] **Krok 6: Uruchom testy i typecheck**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/shared/domain/physics/physicsObject.test.ts \
  src/modules/explorer/builders/buildModelTree.test.ts \
  src/modules/explorer/builders/physicsGraphTree.test.ts
pnpm --dir apps/control-room typecheck
```

- [ ] **Krok 7: Commit**

```bash
git add apps/control-room/src/shared/domain/physics/physicsObject.ts \
  apps/control-room/src/shared/domain/physics/physicsObject.test.ts \
  apps/control-room/src/modules/explorer/explorerTypes.ts \
  apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts \
  apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts \
  apps/control-room/src/modules/explorer/builders/physicsGraphTree.ts \
  apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts \
  apps/control-room/src/modules/explorer/builders/physicsGraphTree.test.ts
git diff --cached --name-only
git commit -m "feat(explorer): render compositional physics objects"
```

---

### Zadanie 10: Produkcyjne Inspectory i authoring modułów

**Pliki:**

- Utwórz: `apps/control-room/src/modules/inspector/panels/PhysicsObjectInspectorPanel.tsx`
- Utwórz: `apps/control-room/src/modules/inspector/panels/PhysicsObjectInspectorPanel.test.tsx`
- Modyfikuj: `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/ObjectGeneralPanel.tsx`
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx`
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.tsx`
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx`
- Modyfikuj: `apps/control-room/src/design/styles/inspector-physics.css`

**Interfejsy:**

- Konsumuje: typed resource client i node identity z zadań 8–9.
- Produkuje: responsywny Inspector Identity/Geometry/Materials/Physics/
  Availability, transakcyjne `Add Physics`, brak pustych graph nodes.

- [ ] **Krok 1: Napisz test routingu każdego typu**

W pliku testowym zdefiniuj `selectionForObject(type)` jako pełny
`ExplorerNode` z rzeczywistym `objectId` i `resourceRef`, a `renderInspector`
jako repozytoryjny wrapper renderujący `InspectorRouteCatalog` z providerem
sesji i typowanym `ControlRoomApi`. `mockApi` jest jawnie zbudowanym mockiem
tego interfejsu; jego mutacje są `vi.fn()`, bez `as any` i bez globalnego
mockowania `fetch`.

```tsx
it.each(["geometry", "ferromagnet", "conductor", "antenna"])(
  "routes %s to the typed object inspector",
  (type) => {
    renderInspector(selectionForObject(type));
    expect(screen.getByTestId("fm-physics-object-inspector")).toBeVisible();
    expect(screen.getByText(type)).toBeVisible();
  },
);
```

- [ ] **Krok 2: Napisz test anulowania draftu**

```tsx
it("does not materialize a module when Add Physics is cancelled", async () => {
  const api = mockApi();
  renderInspector(selectionForObject("conductor"), api);
  await userEvent.click(screen.getByRole("button", { name: "Add physics" }));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.model.createCurrentTransport).not.toHaveBeenCalled();
});
```

- [ ] **Krok 3: Potwierdź RED**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/panels/PhysicsObjectInspectorPanel.test.tsx
```

- [ ] **Krok 4: Zbuduj panel na istniejących prymitywach Inspectora**

Użyj `InspectorGroup`, `FieldRow`, wspólnego action bara i dokładnie tych
samych breakpointów/overflow rules co Inspector wizualizacji. Wszystkie klasy
CSS mają prefix `fm-` i używają `--fm-*` tokenów. Nie kopiuj całego CSS;
wydziel współdzielony układ tylko tam, gdzie obie powierzchnie rzeczywiście
mają tę samą odpowiedzialność.

- [ ] **Krok 5: Dodaj transakcyjne Identity i Add Physics**

Rename wysyła `patchObject(objectId, {base_revision, name})`. Zmiana `type`
nie zmienia modułów. Paleta `Add Physics` filtruje akcje po archetypie i
capability, ale zapisuje moduł dopiero po Apply. Current/spin/torque korzystają
z istniejących typowanych mutacji API.

- [ ] **Krok 6: Zachowaj oddzielne Inspectory semantycznych dzieci**

`object.geometry`, `object.material`, `physics.module`, interface i electrode
mają osobne routes/panele. Wspólny wygląd nie może spłaszczyć ich do jednego
generycznego JSON Inspectora.

- [ ] **Krok 7: Uruchom testy, typecheck, lint i React Doctor**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/panels/PhysicsObjectInspectorPanel.test.tsx \
  src/modules/inspector/inspectorDescriptor.test.ts \
  src/modules/inspector/inspectorCssContract.test.ts \
  src/modules/inspector/inspectorDesignSystemContract.test.ts
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

Następnie uruchom repozytoryjny `react-doctor` zgodnie z jego `SKILL.md` i
odrzuć zmianę, jeżeli wynik pogarsza się względem baseline.

- [ ] **Krok 8: Commit**

```bash
git add apps/control-room/src/modules/inspector/panels/PhysicsObjectInspectorPanel.tsx \
  apps/control-room/src/modules/inspector/panels/PhysicsObjectInspectorPanel.test.tsx \
  apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx \
  apps/control-room/src/modules/inspector/panels/ObjectGeneralPanel.tsx \
  apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx \
  apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.tsx \
  apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx \
  apps/control-room/src/design/styles/inspector-physics.css
git diff --cached --name-only
git commit -m "feat(inspector): author typed object physics"
```

---

### Zadanie 11: Browser smoke i wizualna kwalifikacja UI

**Pliki:**

- Utwórz: `apps/control-room/scripts/smoke-physics-object-authoring.mjs`
- Utwórz: `apps/control-room/scripts/smoke-physics-object-authoring-isolation.node-test.mjs`
- Modyfikuj: `apps/control-room/package.json`

**Interfejsy:**

- Konsumuje: kompletne API/Explorer/Inspector.
- Produkuje: powtarzalny test prawdziwej przeglądarki i screenshoty dowodowe
  dla FDM/FEM oraz szerokiego/wąskiego Inspectora.

- [ ] **Krok 1: Napisz izolowany test kontraktu smoke scriptu**

Test ma sprawdzić, że skrypt wymaga czterech asercji: brak current node przed
Apply, obecność po Apply, zachowanie ID po rename i brak current po usunięciu
modułu. Musi również sprawdzić breakpoint 1280x800 oraz 820x900.

- [ ] **Krok 2: Dodaj browser workflow**

Scenariusz:

1. utwórz `conductor` o nazwie `heavy_metal`;
2. potwierdź brak Current/Spin/Torque;
3. otwórz Inspector i anuluj `Add Current Transport`;
4. potwierdź brak węzła;
5. utwórz moduł i potwierdź węzeł z właściwym `object_id`;
6. zmień nazwę i potwierdź zachowanie ID/modułu;
7. przełącz fixture FDM/FEM i potwierdź to samo drzewo semantyczne;
8. zapisz screenshoty obu szerokości.

- [ ] **Krok 3: Dodaj komendę package**

```json
"smoke:physics-object-authoring": "node scripts/smoke-physics-object-authoring.mjs"
```

- [ ] **Krok 4: Uruchom test izolacji i real browser smoke**

```bash
node --test \
  apps/control-room/scripts/smoke-physics-object-authoring-isolation.node-test.mjs
pnpm --dir apps/control-room smoke:physics-object-authoring
```

Oczekiwane: PASS, widoczny Inspector bez poziomego overflow i artefakty PNG z
obu viewportów.

- [ ] **Krok 5: Commit**

```bash
git add apps/control-room/scripts/smoke-physics-object-authoring.mjs \
  apps/control-room/scripts/smoke-physics-object-authoring-isolation.node-test.mjs \
  apps/control-room/package.json
git diff --cached --name-only
git commit -m "test(ui): qualify physics object authoring"
```

---

### Zadanie 12: Scenariusze runtime bez prądu i z rozwiązanym prądem

**Pliki:**

- Utwórz: `scripts/verify_physics_object_runtime_artifacts.py`
- Utwórz: `scripts/test_verify_physics_object_runtime_artifacts.py`
- Modyfikuj: `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`
- Modyfikuj: `tests/standard_problems/transport/racetrack_m1_v1/scenario.py`
- Modyfikuj: `crates/fullmag-runner/tests/physics_graph_runtime.rs`
- Modyfikuj: `justfile`

**Interfejsy:**

- Konsumuje: pełny publiczny przepływ Python -> IR -> planner -> runtime.
- Produkuje: świeży dowód negatywny FEM bez current oraz pozytywny FDM z
  current/spin/torque, na trwałym magazynie buildów.

- [ ] **Krok 1: Napisz test walidatora artefaktów**

```python
def test_no_current_contract_rejects_transport_provenance(tmp_path):
    artifact = tmp_path / "metadata.json"
    artifact.write_text(json.dumps({
        "physics_graph": {"modules": []},
        "execution_provenance": {"charge_transport": {"status": "executed"}},
    }))
    with pytest.raises(AssertionError, match="unexpected charge transport"):
        verify_no_current(artifact)
```

- [ ] **Krok 2: Dodaj walidator dwóch trybów**

`verify_no_current` wymaga braku module kind current/spin/torque, braku pól
`V_electric`, `J_charge`, `mu_s` i braku provenance solvera transportowego.
`verify_solved_current` wymaga dokładnych module IDs, niezerowego accepted
`J_charge`, spin snapshot, torque binding i realization digest.

- [ ] **Krok 3: Przenieś SP4 FEM na `study.object`**

Scenariusz pozostaje flat module-level `study`, nie dodaje current/spin/torque
i zachowuje wszystkie dotychczasowe parametry SP4 oraz `tolT=1e-6 T`.

- [ ] **Krok 4: Dodaj recepturę managed runtime**

W `justfile` dodaj `verify-physics-object-runtime-contract`, która:

1. wymaga zapisywalnych `/tmp/fullmag-zfn2-build` oraz
   `/mnt/fullmag-zfn2-native` i kończy się czytelną instrukcją odtworzenia
   mountów, jeżeli host po restarcie ich nie udostępnia;
2. korzysta z istniejącego `ensure-managed-fem-runtime`, który jest
   autorytatywną drogą odtworzenia/budowy runtime; nie wywołuje nieistniejącej
   receptury `restore-build-volumes` ani nie uruchamia rekurencyjnie samej siebie;
3. uruchamia SP4 FEM headless przez istniejący managed lane i walidator
   `verify_no_current`;
4. uruchamia istniejący `verify-fdm-physics-graph-runtime` racetrack lane i
   walidator
   `verify_solved_current`;
5. zapisuje artefakty pod `/mnt/fullmag-zfn2-native/physics-objects/`;
6. nie deklaruje GPU physics qualification, jeśli użyty lane jej nie ma.

Scenariusz racetrack ma dokładny stage lifecycle:

1. `set_spin_torque_enabled(False)` i zerowy prąd;
2. relaksacja oraz checkpoint `relaxed_zero_current`;
3. sześć niezależnych runów, z których każdy zaczyna od
   `add_load_state("relaxed_zero_current")`;
4. trzy amplitudy prądu i oba znaki przez `set_transport_current(...)`;
5. `set_spin_torque_enabled(True)` dopiero dla etapów napędzanych;
6. zapis `m`, `J_charge`, `mu_s`, torque i obserwabli położenia skyrmionu do
   późniejszego wyznaczenia kąta Halla.

- [ ] **Krok 5: Uruchom test walidatora**

```bash
python3 -m pytest scripts/test_verify_physics_object_runtime_artifacts.py -q
```

- [ ] **Krok 6: Uruchom managed runtime gate**

```bash
just ensure-managed-fem-runtime
just verify-physics-object-runtime-contract
```

Oczekiwane: SP4 kończy się bez próby FEM M1 steady transport; racetrack
publikuje dokładne current/spin/torque IDs. Build i artefakty znajdują się na
zamontowanych wolumenach pod `/zfn2/mateuszz/git/fullmag/build-volumes/`.

- [ ] **Krok 7: Commit**

```bash
git add scripts/verify_physics_object_runtime_artifacts.py \
  scripts/test_verify_physics_object_runtime_artifacts.py \
  tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py \
  tests/standard_problems/transport/racetrack_m1_v1/scenario.py \
  crates/fullmag-runner/tests/physics_graph_runtime.rs justfile
git diff --cached --name-only
git commit -m "test(runtime): prove object-scoped physics activation"
```

---

### Zadanie 13: Dokumentacja, capability i finalna bramka migracji

**Pliki:**

- Modyfikuj: `docs/physics/0995-physics-module-scope-and-activation.md`
- Modyfikuj: `docs/physics/0995-physics-module-scope-and-activation.source-map.json`
- Modyfikuj: `docs/specs/capability-matrix-v0.json`
- Modyfikuj: `docs/superpowers/specs/2026-08-13-compositional-physics-object-authoring-design.md`
- Modyfikuj: `public_docs/site/physics/` tylko w istniejącym kanonicznym
  rozdziale authoringu, bez duplikowania równań.

**Interfejsy:**

- Konsumuje: wszystkie wdrożone symbole i świeże artefakty.
- Produkuje: dokładny source map, uczciwy status backendów, brak legacy w
  kanonicznej dokumentacji i końcowy raport dowodów.

- [ ] **Krok 1: Zaktualizuj notę fizyki przed promocją claimów**

Dodaj `PhysicsObject`, `object_id/name/type`, magnetization module oraz
Python-to-IR mapping. Nie kopiuj równań transportu. Macierz realizacji ma
osobne wiersze FDM CPU, FDM GPU, FEM CPU i FEM GPU; promocja dotyczy wyłącznie
authoringu/scope, nie fizyki solvera.

- [ ] **Krok 2: Zaktualizuj source map po symbolach**

Każdy claim wskazuje repo-relative path i symbol, między innymi:

```text
crates/fullmag-ir/src/physics_object.rs::PhysicsObjectIR
packages/fullmag-py/src/fullmag/object_authoring.py::PhysicsObjectHandle
crates/fullmag-plan/src/object_model.rs::resolve_object_model
apps/control-room/src/shared/domain/physics/physicsObject.ts::physicsObjectFromResource
```

- [ ] **Krok 3: Uruchom walidatory dokumentacji**

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0995-physics-module-scope-and-activation.source-map.json \
  --repo-root .
python3 -m unittest discover \
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
```

- [ ] **Krok 4: Uruchom statyczne bramki migracji**

```bash
rg -n '"magnets"|auxiliary_geometries|role:antenna|role="magnet"' \
  crates packages/fullmag-py/src apps/control-room/src
rg -n 'study\.(geometry|antenna_object)\(' \
  examples public_docs/site tests/standard_problems
```

Oczekiwane: trafienia wyłącznie w migratorach, adapterach deprecacji i
jawnych fixture legacy. Każde trafienie ma komentarz/test potwierdzający
status kompatybilności.

- [ ] **Krok 5: Uruchom finalny zestaw regresji**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/physics-objects \
CARGO_INCREMENTAL=0 cargo test -p fullmag-ir -p fullmag-authoring \
  -p fullmag-plan -p fullmag-api --tests -- --nocapture
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_physics_object_authoring.py \
  packages/fullmag-py/tests/test_physics_object_script_roundtrip.py \
  tests/standard_problems/transport/racetrack_m1_v1/test_public_scenario.py -q
pnpm --dir apps/control-room test
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
just verify-physics-object-runtime-contract
pnpm --dir apps/control-room smoke:physics-object-authoring
```

- [ ] **Krok 6: Wykonaj code review i zamknij tylko dowiedzione statusy**

Użyj `requesting-code-review` i `google-eng-review-practices`. Raport końcowy
ma osobno podać: source implemented, executable, numerically validated,
browser-qualified i production-qualified. Nie promuj FDM GPU/FEM GPU na
podstawie samego authoringu.

- [ ] **Krok 7: Commit dokumentacji i capability**

```bash
git add docs/physics/0995-physics-module-scope-and-activation.md \
  docs/physics/0995-physics-module-scope-and-activation.source-map.json \
  docs/specs/capability-matrix-v0.json \
  docs/superpowers/specs/2026-08-13-compositional-physics-object-authoring-design.md \
  public_docs/site/physics
git diff --cached --name-only
git commit -m "docs: publish compositional object authoring"
```

---

## Bramka końcowa

Nie wolno uznać planu za wdrożony, dopóki wszystkie poniższe warunki nie są
spełnione jednocześnie:

1. Nowy writer `ProblemIR 0.4` nie emituje `magnets` ani
   `auxiliary_geometries`.
2. Legacy `0.3` migruje deterministycznie do `objects` i jawnych modułów.
3. `type` bez modułu nie uruchamia LLG, current, spin, torque ani Oersteda.
4. Rename zachowuje wszystkie ID, dependency edges i checkpoint identity.
5. Python i UI round-tripują ten sam znormalizowany IR.
6. FDM i FEM rozwiązują ten sam semantic scope do właściwych masek/markerów.
7. SP4 FEM bez current nie uruchamia M1 transportu.
8. Racetrack z jawnie dodanym current publikuje current/spin/torque
   realization provenance.
9. Explorer nie pokazuje pustych rodzin, a każdy obecny moduł ma właściwy
   Inspector.
10. OpenAPI, wygenerowane typy, klient, resource hooks i SceneDocument są
    zgodne rewizyjnie.
11. Browser smoke przechodzi dla FDM i FEM przy dwóch szerokościach.
12. Żaden status fizycznej kwalifikacji backendu nie został podniesiony bez
    osobnego dowodu runtime/numerics/device.
