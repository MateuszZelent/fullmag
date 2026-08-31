# Plan implementacji obróconego interfejsowego DMI i bimeronu Göbel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodać `RotatedInterfacialDMI` z pracy Göbel 2019 do całego kontraktu Fullmag, wykonać produkcyjne realizacje FDM CPU/GPU i FEM CPU/GPU oraz zakwalifikować stabilny bimeron w cienkiej warstwie.

**Architecture:** Jedna backend-neutralna interakcja `EnergyTermIR::RotatedInterfacialDmi` zachowuje równanie, znak i jednostkę `D` od Python DSL do receipt. FDM używa zorientowanej energii ścian i odpowiadającej jej wariacji; FEM używa wspólnego residualu kwadraturowego, z MFEM na CPU i w pełni device-resident CUDA na GPU. Nowe ilości są publikowane przez kanoniczny katalog, a dwa scenariusze Göbel FDM/FEM korzystają z tych samych parametrów i niezależnej bramki stabilizacji.

**Tech Stack:** Python 3/fullmag DSL, Rust/serde/planner/runner/API, TypeScript/React Control Room, C++17/MFEM, CUDA, libCEED/hypre tam gdzie używa ich istniejący runtime, MyST/Sphinx, pytest/cargo test/CTest/Playwright, kontenerowe receptury `just`.

## Global Constraints

- Kanoniczna energia: `D * (m_z*d_x(m_x) - m_x*d_x(m_z) + m_x*d_y(m_y) - m_y*d_y(m_x))`.
- `D` ma jednostkę `J/m^2`, może mieć dowolny skończony znak i nie może być normalizowane do istniejącego iDMI lub bulk DMI.
- Implementacja obejmuje FDM CPU, FDM GPU FP64/FP32, FEM CPU i FEM GPU; brak kernela lub capability kończy się błędem, nigdy fallbackiem.
- Stan FEM pozostaje typowany: `tet4`, `prism6`, `pyramid5`; nie wolno spłaszczać produkcyjnej siatki do niejawnych tetraedrów.
- FDM CPU `double` jest referencją dla FDM; FEM CPU/MFEM `double` jest referencją dla FEM.
- Native FEM/MFEM/CUDA/hypre/libCEED buduje i uruchamia wyłącznie repozytoryjna droga kontenerowa `just`.
- Windowsowe cache i buildy pozostają poza checkoutem: `C:\fullmag-build`, `C:\fullmag-cache` i `C:\fullmag-tmp` albo jawne `FULLMAG_WINDOWS_*_ROOT`.
- Dokumentacja fizyki powstaje przed kodem i przechodzi `scientific-documentation-contract` wraz z source map, strict Sphinx i walidacją HTML.
- Wszystkie publiczne scenariusze używają `fm.study(...)`, jawnego engine/device/mode oraz `study.stages.add_*`; `fm.Problem(...)` nie trafia do publicznych bloków.
- Istniejące niepowiązane zmiany w submodułach i `docs/physics/exotic_dmi/` pozostają nietknięte.
- Każde twierdzenie runtime rozdziela source test, managed runtime, GPU device proof i naukową stabilizację; brak dowodu jest `NOT VERIFIED`.

---

## Mapa plików i odpowiedzialności

### Nowe pliki

- `docs/physics/0406-rotated-interfacial-dmi.md` — kanoniczna publikacyjna nota fizyczna.
- `docs/physics/0406-rotated-interfacial-dmi.source-map.json` — stabilne mapowanie równań/API na symbole i testy.
- `crates/fullmag-engine/src/fdm/shared/rotated_interfacial_dmi.rs` — czyste wzory energii, pola i wektora brzegowego FDM.
- `backends/fdm/gpu/cuda/interactions/rotated_interfacial_dmi.cuh` — device helpers wspólne dla FP64/FP32 i multilayer.
- `backends/fem/cpu/mfem/interactions/dmi_rotated_interfacial.hpp` — granica modułu FEM CPU.
- `backends/fem/cpu/mfem/interactions/dmi_rotated_interfacial.cpp` — MFEM element loop, energia i projekcja residualu.
- `backends/fem/gpu/cuda/interactions/dmi/rotated_dmi_quadrature.hpp` — typowany opis kwadratury GPU.
- `backends/fem/gpu/cuda/interactions/dmi/rotated_dmi_quadrature.cpp` — przygotowanie MFEM geometry/basis podczas setupu.
- `backends/fem/gpu/cuda/interactions/dmi/rotated_dmi_kernels.hpp` — publiczne wrappery CUDA.
- `backends/fem/gpu/cuda/interactions/dmi/rotated_dmi_kernels.cu` — device residual, pole i energia dla typed P1.
- `tests/standard_problems/bimeron/goebel_2019/common.py` — jedna tabela parametrów i kryteriów.
- `tests/standard_problems/bimeron/goebel_2019/scenario_fdm.py` — reprodukcja FDM.
- `tests/standard_problems/bimeron/goebel_2019/scenario_fem.py` — reprodukcja FEM z jedną warstwą `prism6`.
- `tests/standard_problems/bimeron/goebel_2019/verify.py` — bramka energii, rdzeni, tła, topological charge i provenance.
- `tests/standard_problems/bimeron/goebel_2019/test_contract.py` — testy scenariuszy i kryteriów.
- `tests/standard_problems/bimeron/goebel_2019/thresholds.v1.json` — zamrożone progi po niezależnych oracle operatora.

### Główne pliki modyfikowane

- `packages/fullmag-py/src/fullmag/model/energy.py`, `problem.py`, `__init__.py` i `packages/fullmag-py/src/fullmag/__init__.py` — publiczny konstruktor i eksport.
- `crates/fullmag-ir/src/study.rs`, `validation.rs`, `plan.rs` — semantyka i plany.
- `crates/fullmag-plan/src/fdm.rs`, `fem.rs`, `validate.rs`, `quantities.rs` — lowering, legality i outputy.
- `crates/fullmag-authoring/src/builder.rs`, `adapters.rs` oraz `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` — round-trip authoringu.
- `crates/fullmag-quantities/src/id.rs`, `catalog.rs`, `registry.rs` — kanoniczne ilości.
- `apps/control-room/src/shared/domain/physics/interactions.ts`, `apps/control-room/src/kernel/api/quantityIds.ts` — authoring i selekcja ilości.
- `crates/fullmag-engine/src/fdm/shared/terms.rs`, `fdm/cpu/fields.rs` — runtime FDM CPU.
- `native/include/fullmag_fdm.h`, `backends/fdm/include/context.hpp`, `backends/fdm/api/c_api.cpp` — FDM ABI.
- `backends/fdm/gpu/cuda/interactions/*.cu`, `integrators/*.cu`, `runtime/reductions_fp64.cu` — FDM CUDA.
- `native/include/fullmag_fem.h`, `backends/fem/cpu/mfem/interactions/dmi.*`, `effective_field.cpp` — FEM ABI i kompozycja CPU.
- `backends/fem/include/dmi_weak_residual.hpp`, `src/dmi_weak_residual.cpp` — wspólny residual elementowy.
- `backends/fem/gpu/cuda/state/*`, `integrators/rk/*`, `relaxation/*` — FEM GPU, stats i transakcje.
- `crates/fullmag-runner/src/native_fem.rs`, `fdm/gpu/cuda/native.rs`, `quantities.rs`, `capabilities.rs`, `artifacts.rs`, `types.rs` — ABI bindings, receipt i artefakty.
- `justfile` — zarządzane receptury operatora i reprodukcji.

---

### Task 1: Opublikować kanoniczny kontrakt fizyczny

**Files:**
- Create: `docs/physics/0406-rotated-interfacial-dmi.md`
- Create: `docs/physics/0406-rotated-interfacial-dmi.source-map.json`
- Modify: `docs/physics/README.md`
- Test: `.agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py`

**Interfaces:**
- Consumes: zatwierdzona specyfikacja `docs/superpowers/specs/2026-08-31-rotated-interfacial-dmi-bimeron-design.md` i DOI `10.1103/PhysRevB.99.060407`.
- Produces: etykiety MyST, równania `rdmi-energy`, `rdmi-field`, `rdmi-natural-bc`, publiczne API `fm.RotatedInterfacialDMI` i source anchors używane przez kolejne taski.

- [ ] **Step 1: Utworzyć source map wskazujący nieistniejące jeszcze symbole i potwierdzić czerwony test**

```json
{
  "schema_version": "fullmag.scientific-source-map.v1",
  "page": "docs/physics/0406-rotated-interfacial-dmi.md",
  "claims": [
    {
      "id": "rdmi-energy-and-field",
      "sources": [
        {"path": "crates/fullmag-engine/src/fdm/shared/rotated_interfacial_dmi.rs", "symbol": "rotated_interfacial_dmi_field"},
        {"path": "backends/fem/src/dmi_weak_residual.cpp", "symbol": "dmi_accumulate_rotated_interfacial_residual"}
      ]
    },
    {
      "id": "rdmi-python-ir",
      "sources": [
        {"path": "packages/fullmag-py/src/fullmag/model/energy.py", "symbol": "RotatedInterfacialDMI"},
        {"path": "crates/fullmag-ir/src/study.rs", "symbol": "EnergyTermIR::RotatedInterfacialDmi"}
      ]
    }
  ]
}
```

Run:

```powershell
& 'C:\Users\Mateusz\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0406-rotated-interfacial-dmi.source-map.json --repo-root .
```

Expected: FAIL wskazujący brak strony i brak symboli produkcyjnych.

- [ ] **Step 2: Napisać kompletną notę fizyczną**

Strona zawiera dokładnie wymagane etykiety kontraktu i następujące trzy centralne równania:

```markdown
(governing-equations)=
## Równania rządzące

```{math}
:label: rdmi-energy
E_{\mathrm{rDMI}}=\int_{\Omega_m}D\left(
m_z\partial_xm_x-m_x\partial_xm_z+
m_x\partial_ym_y-m_y\partial_ym_x\right)\,\mathrm dV.
```

```{math}
:label: rdmi-field
\mathbf H_{\mathrm{rDMI}}=\frac{2D}{\mu_0M_s}
\left(\partial_xm_z-\partial_ym_y,\;\partial_ym_x,\;-\partial_xm_x\right)^\mathsf T.
```

```{math}
:label: rdmi-natural-bc
2A\partial_n\mathbf m+D(n_xm_z-n_ym_y,\;n_ym_x,\;-n_xm_x)^\mathsf T=\mathbf0.
```
```

Nota definiuje każdy symbol i jednostkę SI, pokazuje pełny `fm.study(...).terms.add(fm.RotatedInterfacialDMI(...))`, fragment `ProblemIR`, macierz czterech lane’ów, failure semantics, walidację, bibliografię Göbel 2019 oraz finalny source-code index.

- [ ] **Step 3: Uruchomić walidator strukturalny i jego testy**

Run:

```powershell
& 'C:\Users\Mateusz\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
```

Expected: PASS wszystkich testów walidatora; walidacja source map nadal zgłasza wyłącznie jeszcze niezaimplementowane symbole i jest zapisana jako oczekiwany RED Task 1.

- [ ] **Step 4: Commit dokumentacyjnego kontraktu**

```powershell
git add docs/physics/0406-rotated-interfacial-dmi.md docs/physics/0406-rotated-interfacial-dmi.source-map.json docs/physics/README.md
git commit -m "docs: define rotated interfacial DMI physics"
```

---

### Task 2: Dodać Python DSL i `ProblemIR`

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/energy.py`
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py`
- Modify: `packages/fullmag-py/src/fullmag/model/__init__.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/validation.rs`
- Test: `packages/fullmag-py/tests/test_api.py`
- Test: `crates/fullmag-ir/tests/ir_tests.rs`

**Interfaces:**
- Consumes: `require_finite(value, "D")` i istniejący tagged enum `EnergyTermIR`.
- Produces: `RotatedInterfacialDMI(D: float).to_ir()` i `EnergyTermIR::RotatedInterfacialDmi { d: f64 }`.

- [ ] **Step 1: Napisać czerwone testy Python**

```python
def test_rotated_interfacial_dmi_serializes_exact_contract() -> None:
    assert fm.RotatedInterfacialDMI(D=-3.0e-3).to_ir() == {
        "kind": "rotated_interfacial_dmi",
        "D": -3.0e-3,
    }


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_rotated_interfacial_dmi_rejects_non_finite_d(value: float) -> None:
    with pytest.raises(ValueError, match="D must be finite"):
        fm.RotatedInterfacialDMI(D=value)
```

Run:

```powershell
$env:PYTHONPATH='packages/fullmag-py/src'; & 'C:\Users\Mateusz\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m pytest packages/fullmag-py/tests/test_api.py -k rotated_interfacial_dmi -q
```

Expected: FAIL z brakiem `fullmag.RotatedInterfacialDMI`.

- [ ] **Step 2: Napisać czerwone testy Rust IR**

```rust
#[test]
fn rotated_interfacial_dmi_round_trips_and_validates_sign() {
    let term = EnergyTermIR::RotatedInterfacialDmi { d: -3.0e-3 };
    let json = serde_json::to_value(&term).unwrap();
    assert_eq!(json, serde_json::json!({"kind":"rotated_interfacial_dmi","D":-3.0e-3}));
    assert_eq!(serde_json::from_value::<EnergyTermIR>(json).unwrap(), term);
}

#[test]
fn rotated_interfacial_dmi_rejects_non_finite_d() {
    let mut problem = minimal_problem();
    problem.energy_terms.push(EnergyTermIR::RotatedInterfacialDmi { d: f64::NAN });
    assert!(problem.validate().unwrap_err().iter().any(|e| e.contains("RotatedInterfacialDmi.D must be finite")));
}
```

Run:

```powershell
$env:CARGO_HOME='C:\fullmag-cache\cargo-home'; $env:CARGO_TARGET_DIR='C:\fullmag-build\rotated-dmi-ir'; cargo test -p fullmag-ir rotated_interfacial_dmi -- --nocapture
```

Expected: FAIL, wariant enumu nie istnieje.

- [ ] **Step 3: Dodać minimalny konstruktor i wariant IR**

```python
@dataclass(frozen=True, slots=True)
class RotatedInterfacialDMI:
    D: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "D", require_finite(self.D, "D"))

    def to_ir(self) -> dict[str, object]:
        return {"kind": "rotated_interfacial_dmi", "D": self.D}
```

```rust
RotatedInterfacialDmi {
    #[serde(rename = "D")]
    d: f64,
},
```

W `validate_dmi_energy_terms` dodać osobny licznik duplikatów oraz:

```rust
EnergyTermIR::RotatedInterfacialDmi { d } => {
    if !d.is_finite() {
        errors.push("RotatedInterfacialDmi.D must be finite".to_string());
    }
}
```

- [ ] **Step 4: Uruchomić testy GREEN i formatowanie**

Run: oba polecenia z kroków 1–2 oraz:

```powershell
cargo fmt -p fullmag-ir -- --check
```

Expected: PASS testów `rotated_interfacial_dmi`; formatowanie PASS.

- [ ] **Step 5: Commit semantycznego rdzenia**

```powershell
git add packages/fullmag-py/src/fullmag packages/fullmag-py/tests/test_api.py crates/fullmag-ir/src crates/fullmag-ir/tests/ir_tests.rs
git commit -m "feat: add rotated interfacial DMI contract"
```

---

### Task 3: Rozszerzyć planner i capability matrix

**Files:**
- Modify: `crates/fullmag-ir/src/plan.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-plan/src/validate.rs`
- Modify: `crates/fullmag-plan/src/physics_graph.rs`
- Test: `crates/fullmag-plan/src/tests.rs`

**Interfaces:**
- Consumes: `EnergyTermIR::RotatedInterfacialDmi { d }`.
- Produces: `FdmPlanIR.rotated_interfacial_dmi: Option<f64>` i `FemPlanIR.rotated_interfacial_dmi: Option<f64>` dla time-domain/relaxation; eigen i frequency response odrzucają operator jawnie.

- [ ] **Step 1: Napisać testy planowania czterech lane’ów i failure semantics**

```rust
#[test]
fn rotated_interfacial_dmi_plans_for_fdm_and_fem_time_domain() {
    for backend in [BackendKind::Fdm, BackendKind::Fem] {
        for device in [DeviceKind::Cpu, DeviceKind::Gpu] {
            let mut ir = time_domain_problem(backend, device);
            ir.energy_terms.push(EnergyTermIR::Exchange);
            ir.energy_terms.push(EnergyTermIR::RotatedInterfacialDmi { d: 3.0e-3 });
            let planned = plan(&ir).expect("rotated DMI must plan");
            match planned.backend {
                BackendPlanIR::Fdm(ref p) => assert_eq!(p.rotated_interfacial_dmi, Some(3.0e-3)),
                BackendPlanIR::Fem(ref p) => assert_eq!(p.rotated_interfacial_dmi, Some(3.0e-3)),
            }
        }
    }
}

#[test]
fn rotated_interfacial_dmi_rejects_open_boundary_without_exchange() {
    let mut ir = time_domain_problem(BackendKind::Fdm, DeviceKind::Cpu);
    ir.energy_terms.push(EnergyTermIR::RotatedInterfacialDmi { d: 3.0e-3 });
    let error = plan(&ir).unwrap_err().to_string();
    assert!(error.contains("RotatedInterfacialDmi with open magnetic boundaries requires Exchange"));
}

#[test]
fn rotated_interfacial_dmi_rejects_unimplemented_frequency_domain() {
    let mut ir = frequency_response_problem();
    ir.energy_terms.push(EnergyTermIR::RotatedInterfacialDmi { d: 3.0e-3 });
    assert!(plan(&ir).unwrap_err().to_string().contains("RotatedInterfacialDmi is not implemented for frequency-domain execution"));
}
```

Run:

```powershell
$env:CARGO_TARGET_DIR='C:\fullmag-build\rotated-dmi-plan'; cargo test -p fullmag-plan rotated_interfacial_dmi -- --nocapture
```

Expected: FAIL przez brak pól planu i match arms.

- [ ] **Step 2: Dodać pola planu i lowering**

Do obu planów time-domain dodać:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub rotated_interfacial_dmi: Option<f64>,
```

W ekstraktorach FDM/FEM użyć oddzielnej zmiennej i odrzucać duplikat:

```rust
EnergyTermIR::RotatedInterfacialDmi { d } => {
    if rotated_interfacial_dmi.replace(*d).is_some() {
        errors.push("RotatedInterfacialDmi is declared more than once".to_string());
    }
}
```

Przed konstrukcją planu wymagać exchange, jeżeli istnieje otwarta granica magnetyczna. PBC nie znosi wymogu exchange na pozostałych otwartych osiach.

- [ ] **Step 3: Dodać jawne capability i output legality**

`H_rotated_dmi`, `E_rotated_dmi` i `eden_rotated_dmi` są legalne tylko przy aktywnym `rotated_interfacial_dmi`. Komunikat błędu ma dokładną postać:

```rust
"quantity 'H_rotated_dmi' requires RotatedInterfacialDmi(...)"
```

Planner zachowuje wartość `D == 0.0` jako requested intent, ale ustawia wykonawczy operator jako no-op z nadal obecnym wpisem provenance.

- [ ] **Step 4: Uruchomić testy GREEN**

Run:

```powershell
$env:CARGO_TARGET_DIR='C:\fullmag-build\rotated-dmi-plan'; cargo test -p fullmag-plan rotated_interfacial_dmi -- --nocapture
```

Expected: PASS wszystkich nowych testów oraz brak regresji testów DMI w `fullmag-plan`.

- [ ] **Step 5: Commit plannera**

```powershell
git add crates/fullmag-ir/src/plan.rs crates/fullmag-plan/src
git commit -m "feat: plan rotated DMI across FDM and FEM"
```

---

### Task 4: Dodać kanoniczne ilości i agregację energii

**Files:**
- Modify: `crates/fullmag-quantities/src/id.rs`
- Modify: `crates/fullmag-quantities/src/catalog.rs`
- Modify: `crates/fullmag-quantities/src/registry.rs`
- Modify: `crates/fullmag-plan/src/quantities.rs`
- Modify: `crates/fullmag-runner/src/quantities.rs`
- Modify: `crates/fullmag-runner/src/capabilities.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `apps/control-room/src/kernel/api/quantityIds.ts`
- Test: `crates/fullmag-quantities/src/lib.rs`
- Test: `crates/fullmag-runner/src/quantities.rs`

**Interfaces:**
- Consumes: pola planu `rotated_interfacial_dmi`.
- Produces: `QuantityId::{HDmiRotated,ERotatedDmi,EdenRotatedDmi}`, wire IDs `H_rotated_dmi`, `E_rotated_dmi`, `eden_rotated_dmi`; istniejące `E_dmi` pozostaje sumą wszystkich typów DMI.

- [ ] **Step 1: Napisać czerwony test katalogu**

```rust
#[test]
fn rotated_dmi_quantities_have_canonical_units_and_domains() {
    assert_eq!(normalize_quantity_id("H_rotated_dmi").unwrap(), QuantityId::HDmiRotated);
    assert_eq!(catalog_entry(QuantityId::HDmiRotated).unit, "A/m");
    assert_eq!(catalog_entry(QuantityId::ERotatedDmi).unit, "J");
    assert_eq!(catalog_entry(QuantityId::EdenRotatedDmi).unit, "J/m^3");
    assert_eq!(catalog_entry(QuantityId::HDmiRotated).spatial_domain, SpatialDomain::MagneticOnly);
}
```

Run:

```powershell
$env:CARGO_TARGET_DIR='C:\fullmag-build\rotated-dmi-quantities'; cargo test -p fullmag-quantities rotated_dmi -- --nocapture
```

Expected: FAIL przez brak wariantów.

- [ ] **Step 2: Dodać trzy ID i pełne wpisy katalogu**

```rust
HDmiRotated => "H_rotated_dmi",
ERotatedDmi => "E_rotated_dmi",
EdenRotatedDmi => "eden_rotated_dmi",
```

Każdy wariant trafia do `QuantityId::ALL`, parsera aliasów, registry, provider kind, support class i katalogu. `ERotatedDmi` jest skalarem, `HDmiRotated` wektorem node/cell, a `EdenRotatedDmi` skalarem przestrzennym.

- [ ] **Step 3: Rozszerzyć stats bez zmiany znaczenia `E_dmi`**

Do struktur raportu Rust dodać:

```rust
#[serde(rename = "E_rotated_dmi")]
pub e_rotated_dmi: f64,
```

Agregacja ma być jawna:

```rust
stats.e_dmi = stats.e_interfacial_dmi + stats.e_bulk_dmi + stats.e_rotated_dmi;
```

Nie zmieniać wire ID istniejącego `E_dmi` ani jego jednostki.

- [ ] **Step 4: Uzupełnić frontend ID i testy dostępności**

```ts
h_rotated_dmi: "H_rotated_dmi",
e_rotated_dmi: "E_rotated_dmi",
eden_rotated_dmi: "eden_rotated_dmi",
```

Test sprawdza jednostki i to, że quantity descriptor pojawia się dla FDM/FEM CPU/GPU wyłącznie przy aktywnym planie.

- [ ] **Step 5: Uruchomić testy GREEN**

Run:

```powershell
$env:CARGO_TARGET_DIR='C:\fullmag-build\rotated-dmi-quantities'; cargo test -p fullmag-quantities rotated_dmi -- --nocapture; cargo test -p fullmag-runner rotated_dmi_quantities -- --nocapture
pnpm --dir apps/control-room test -- quantityIds
```

Expected: PASS.

- [ ] **Step 6: Commit katalogu**

```powershell
git add crates/fullmag-quantities crates/fullmag-plan/src/quantities.rs crates/fullmag-runner/src apps/control-room/src/kernel/api/quantityIds.ts
git commit -m "feat: publish rotated DMI quantities"
```

---

### Task 5: Dodać authoring API i Control Room round-trip

**Files:**
- Modify: `crates/fullmag-authoring/src/builder.rs`
- Modify: `crates/fullmag-authoring/src/adapters.rs`
- Modify: `crates/fullmag-authoring/tests/physics_graph_contract.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify: `apps/control-room/src/shared/domain/physics/interactions.ts`
- Modify: `apps/control-room/src/shared/domain/physics/interactions.test.ts`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`

**Interfaces:**
- Consumes: `{kind:"rotated_interfacial_dmi",D:f64}`.
- Produces: `ScriptBuilderMagneticInteractionKind::RotatedInterfacialDmi`, stabilny authoring JSON `{d: 0.003}` i `study.terms.add(fm.RotatedInterfacialDMI(D=...))` w eksporcie.

- [ ] **Step 1: Napisać test round-trip Rust**

```rust
#[test]
fn rotated_dmi_authoring_round_trip_preserves_signed_d() {
    let entry = ScriptBuilderMagneticInteractionEntry {
        kind: ScriptBuilderMagneticInteractionKind::RotatedInterfacialDmi,
        enabled: true,
        params: Some(serde_json::json!({"d": -0.003})),
    };
    let script = export_interaction(&entry).unwrap();
    assert!(script.contains("fm.RotatedInterfacialDMI(D=-0.003)"));
    assert_eq!(parse_exported_interaction(&script).unwrap(), entry);
}
```

Expected RED: enum variant missing.

- [ ] **Step 2: Rozszerzyć enum, porządek i normalizację**

```rust
ScriptBuilderMagneticInteractionKind::RotatedInterfacialDmi => {
    let mut params = params_map(entry.params.as_ref());
    let d = params.get("d").and_then(Value::as_f64).unwrap_or(3.0e-3);
    params.insert("d".to_string(), Value::from(d));
    ScriptBuilderMagneticInteractionEntry {
        kind: ScriptBuilderMagneticInteractionKind::RotatedInterfacialDmi,
        enabled: entry.enabled,
        params: Some(Value::Object(params)),
    }
}
```

Nie wiązać tego parametru z `Material.Dind` ani `Material.Dbulk`.

- [ ] **Step 3: Dodać API parse/render i test endpointu**

Mapowanie ID jest dokładnie `rotated_interfacial_dmi`; payload parametru używa `d`, a script export używa publicznego `D`.

```rust
"rotated_interfacial_dmi" => Ok(ScriptBuilderMagneticInteractionKind::RotatedInterfacialDmi),
```

- [ ] **Step 4: Dodać Control Room interaction spec**

```ts
{
  availability: "study",
  description: "Göbel rotated interfacial DMI with D21 = D32 = D for in-plane bimerons.",
  fields: [{
    defaultValue: "0.003",
    description: "Signed rotated interfacial DMI coefficient.",
    id: "d",
    kind: "number",
    label: "D",
    required: true,
    unit: "J/m^2",
  }],
  id: "rotated_interfacial_dmi",
  label: "Rotated interfacial DMI",
  scope: "global",
  storage: "study",
}
```

Test obejmuje dodatnie, ujemne i zerowe `D`, stabilny draft oraz patch JSON.

- [ ] **Step 5: Regenerować OpenAPI i uruchomić testy**

Run:

```powershell
$env:CARGO_TARGET_DIR='C:\fullmag-build\rotated-dmi-api'; cargo test -p fullmag-authoring rotated_dmi -- --nocapture; cargo test -p fullmag-api rotated_dmi -- --nocapture
pnpm --dir apps/control-room test -- interactions.test.ts
pnpm --dir apps/control-room typecheck
```

Expected: PASS; wygenerowane pliki nie zawierają ręcznych zmian poza wynikiem generatora.

- [ ] **Step 6: Commit authoringu**

```powershell
git add crates/fullmag-authoring crates/fullmag-api apps/control-room/src/shared/domain/physics apps/control-room/src/kernel/api/generated
git commit -m "feat: author rotated DMI across API and UI"
```

---

### Task 6: Zaimplementować referencyjny operator FDM CPU

**Files:**
- Create: `crates/fullmag-engine/src/fdm/shared/rotated_interfacial_dmi.rs`
- Modify: `crates/fullmag-engine/src/fdm/shared/mod.rs`
- Modify: `crates/fullmag-engine/src/fdm/shared/terms.rs`
- Modify: `crates/fullmag-engine/src/fdm/cpu/fields.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference/direct_snapshot.rs`
- Test: `crates/fullmag-engine/src/lib.rs`
- Test: `crates/fullmag-runner/src/fdm/cpu/reference/tests.rs`

**Interfaces:**
- Consumes: `EffectiveFieldTerms.rotated_interfacial_dmi: Option<f64>`.
- Produces: `rotated_interfacial_dmi_field`, in-place/SoA accumulation, `rotated_interfacial_dmi_energy`, density i direct snapshot.

- [ ] **Step 1: Napisać manufactured-solution i derivative RED tests**

```rust
#[test]
fn rotated_dmi_linear_texture_matches_strong_field() {
    let problem = periodic_xy_problem_with_rotated_dmi(2.5e-3);
    let m = linear_normalized_fixture(&problem.grid);
    let h = problem.rotated_interfacial_dmi_field(&m);
    for (cell, expected) in interior_expected_rotated_field(&problem, &m) {
        assert_vec_close(h[cell], expected, 1.0e-11, 1.0e-7);
    }
}

#[test]
fn rotated_dmi_energy_directional_derivative_matches_field() {
    let (problem, m, direction) = masked_open_boundary_fixture();
    let eps = 1.0e-7;
    let fd = (problem.rotated_dmi_energy(&renormalized_add(&m, &direction, eps))
        - problem.rotated_dmi_energy(&renormalized_add(&m, &direction, -eps))) / (2.0 * eps);
    let action = field_energy_action(&problem, &m, &direction);
    assert_relative_eq!(fd, action, epsilon = 2.0e-8 * fd.abs().max(1.0));
}
```

Expected RED: methods missing.

- [ ] **Step 2: Dodać czyste wzory wspólne**

```rust
pub fn rotated_interfacial_dmi_field(
    d: f64,
    mu0_ms: f64,
    dx_m: Vector3,
    dy_m: Vector3,
) -> Vector3 {
    let p = 2.0 * d / mu0_ms;
    [p * (dx_m[2] - dy_m[1]), p * dy_m[0], -p * dx_m[0]]
}

pub fn rotated_interfacial_dmi_face_energy(
    d: f64,
    left: Vector3,
    right: Vector3,
    axis: usize,
    surface: f64,
) -> f64 {
    let a = scale(add(left, right), 0.5);
    let j = sub(right, left);
    let density_integral = match axis {
        0 => d * (a[2] * j[0] - a[0] * j[2]),
        1 => d * (a[0] * j[1] - a[1] * j[0]),
        2 => 0.0,
        _ => unreachable!(),
    };
    surface * density_integral
}
```

- [ ] **Step 3: Dodać korektę otwartych granic i maski**

```rust
if xp { correction = add(correction, [-qx * m[2], 0.0,  qx * m[0]]); }
if xm { correction = add(correction, [ qx * m[2], 0.0, -qx * m[0]]); }
if yp { correction = add(correction, [ qy * m[1],-qy * m[0], 0.0]); }
if ym { correction = add(correction, [-qy * m[1], qy * m[0], 0.0]); }
```

`qx=D/(mu0*Ms*dx)` i `qy=D/(mu0*Ms*dy)`. Na osi periodycznej odpowiadające flagi powierzchni muszą pozostać fałszywe.

- [ ] **Step 4: Wpiąć allocating, in-place, SoA, energię i obserwable**

`H_eff` dodaje operator dokładnie raz we wszystkich ścieżkach CPU. `dmi_energy_joules` pozostaje agregatem, natomiast `e_rotated_dmi` i density są dostępne osobno.

- [ ] **Step 5: Uruchomić testy FDM CPU**

Run:

```powershell
$env:CARGO_TARGET_DIR='C:\fullmag-build\rotated-dmi-fdm-cpu'; cargo test -p fullmag-engine rotated_dmi --lib -- --nocapture; cargo test -p fullmag-runner rotated_dmi -- --nocapture
```

Expected: PASS manufactured solution, derivative, boundary, mask, allocating/in-place/SoA i snapshot.

- [ ] **Step 6: Commit FDM CPU**

```powershell
git add crates/fullmag-engine crates/fullmag-runner/src/fdm/cpu
git commit -m "feat: implement rotated DMI in FDM CPU"
```

---

### Task 7: Zaimplementować FDM CUDA i natywne ABI

**Files:**
- Modify: `native/include/fullmag_fdm.h`
- Modify: `crates/fullmag-fdm-sys/src/lib.rs`
- Modify: `backends/fdm/include/context.hpp`
- Modify: `backends/fdm/api/c_api.cpp`
- Create: `backends/fdm/gpu/cuda/interactions/rotated_interfacial_dmi.cuh`
- Modify: `backends/fdm/gpu/cuda/interactions/demag_fp64.cu`
- Modify: `backends/fdm/gpu/cuda/interactions/demag_fp32.cu`
- Modify: `backends/fdm/gpu/cuda/interactions/multilayer_dmi.cu`
- Modify: `backends/fdm/gpu/cuda/interactions/energy_density_fp64.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/multilayer_heun.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/multilayer_explicit_rk.cu`
- Modify: `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs`
- Test: `backends/fdm/tests/dmi_boundary_cuda_runtime.cpp`
- Test: `backends/fdm/tests/energy_density_observable_contract.cpp`
- Test: `backends/fdm/tests/multilayer_abi_v2_contract.cpp`

**Interfaces:**
- Consumes: `FdmPlanIR.rotated_interfacial_dmi`.
- Produces: ABI fields `has_rotated_interfacial_dmi`, `dmi_D_rotated_interfacial`; CUDA field/energy/density FP64/FP32 bez host fallbacku.

- [ ] **Step 1: Rozszerzyć czerwone ABI i CUDA tests**

Test runtime uruchamia `D=+3e-3` i `D=-3e-3` dla periodic/open/masked fixtures, porównuje pełne pole z niezależnym host oracle i wymaga:

```cpp
check(receipt.executed_device == FULLMAG_FDM_DEVICE_GPU, "rotated DMI fell back from GPU");
check(receipt.executed_precision == requested_precision, "rotated DMI changed precision");
check(max_relative_error_fp64 < 2.0e-12, "FP64 rotated DMI parity failed");
check(max_relative_error_fp32 < 3.0e-5, "FP32 rotated DMI parity failed");
```

Expected RED: plan fields absent.

- [ ] **Step 2: Rozszerzyć ABI append-only**

Do ogona `fullmag_fdm_plan_desc` i `fullmag_fdm_multilayer_plan_desc_v2` dodać:

```c
int    has_rotated_interfacial_dmi;
double dmi_D_rotated_interfacial; /* Göbel D21=D32 [J/m^2] */
```

Zaktualizować `struct_size`, layout/sentinel tests, Rust FFI oraz konstrukcję planu. Nie przesuwać pól istniejących wersji bez testu offsetów.

- [ ] **Step 3: Dodać wspólny device helper**

```cpp
template <typename Real>
__device__ inline void add_rotated_dmi_field(
    Real d, Real mu0_ms, Real dx_mx, Real dx_mz, Real dy_mx, Real dy_my,
    Real &hx, Real &hy, Real &hz)
{
    const Real p = Real(2) * d / mu0_ms;
    hx += p * (dx_mz - dy_my);
    hy += p * dy_mx;
    hz -= p * dx_mx;
}
```

Device boundary helper używa dokładnie znaków z Task 6.

- [ ] **Step 4: Wpiąć wszystkie CUDA ścieżki**

Single-grid FP64/FP32, multilayer field, Heun, RK4/RK23/DP45/ABM3 przez wspólną kompozycję, energy density i final reductions muszą sprawdzać osobną flagę. Licznik wykonanych lokalnych operatorów i receipt zawiera `rotated_interfacial_dmi`.

- [ ] **Step 5: Dodać zarządzaną recepturę**

W `justfile` utworzyć `verify-fdm-gpu-rotated-dmi-runtime`, która buduje `fullmag_fdm`, `fdm_dmi_boundary_cuda_runtime`, `fdm_energy_density_observable_contract`, uruchamia CTest i Rust ABI tests w kontenerze oraz zapisuje JSON receipt pod managed native root.

- [ ] **Step 6: Uruchomić managed CUDA verification**

Run:

```powershell
just verify-fdm-gpu-rotated-dmi-runtime
```

Expected: CTest PASS dla FP64/FP32, single-grid/multilayer, energy derivative, open/mask/PBC; receipt identyfikuje GPU i zero fallbacku.

- [ ] **Step 7: Commit FDM GPU**

```powershell
git add native/include/fullmag_fdm.h crates/fullmag-fdm-sys backends/fdm crates/fullmag-runner/src/fdm/gpu justfile
git commit -m "feat: execute rotated DMI on FDM CUDA"
```

---

### Task 8: Zaimplementować wspólny residual i FEM CPU/MFEM

**Files:**
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `backends/fem/include/dmi_weak_residual.hpp`
- Modify: `backends/fem/src/dmi_weak_residual.cpp`
- Create: `backends/fem/cpu/mfem/interactions/dmi_rotated_interfacial.hpp`
- Create: `backends/fem/cpu/mfem/interactions/dmi_rotated_interfacial.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/dmi.hpp`
- Modify: `backends/fem/cpu/mfem/interactions/dmi.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/effective_field.cpp`
- Modify: `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/state_io.cpp`
- Modify: `backends/fem/core/fem_field_buffers.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Test: `backends/fem/tests/dmi_weak_residual.cpp`
- Test: `backends/fem/tests/dmi_contract.cpp`
- Test: `backends/fem/tests/fem_mixed_p1_contract.cpp`
- Test: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`

**Interfaces:**
- Consumes: `FemPlanIR.rotated_interfacial_dmi`.
- Produces: `dmi_accumulate_rotated_interfacial_residual`, `compute_rotated_interfacial_dmi_field`, `ctx.dmi.h_rotated_interfacial_xyz`, osobna energia i snapshot.

- [ ] **Step 1: Napisać czerwony niezależny residual oracle**

```cpp
const double expected[3] = {
    d * w * (shape * (-grad_m[2][0] + grad_m[1][1]) + m[2] * grad_shape[0] - m[1] * grad_shape[1]),
    d * w * (-shape * grad_m[0][1] + m[0] * grad_shape[1]),
    d * w * ( shape * grad_m[0][0] - m[0] * grad_shape[0]),
};
```

Test porównuje helper, finite-difference energii oraz zmianę znaku `D` dla tet4, prism6 i pyramid5 fixtures.

- [ ] **Step 2: Zaimplementować residual i energię**

```cpp
void dmi_accumulate_rotated_interfacial_residual(
    const DmiElementData &data,
    double d,
    double residual[3])
{
    if (residual == nullptr || d == 0.0 || data.weight == 0.0) return;
    const double mx = data.m_q[0], my = data.m_q[1], mz = data.m_q[2];
    const double sx = data.grad_shape[0], sy = data.grad_shape[1];
    residual[0] += d * data.weight *
        (data.shape * (-data.grad_m[2][0] + data.grad_m[1][1]) + mz * sx - my * sy);
    residual[1] += d * data.weight *
        (-data.shape * data.grad_m[0][1] + mx * sy);
    residual[2] += d * data.weight *
        ( data.shape * data.grad_m[0][0] - mx * sx);
}
```

Energia kwadraturowa używa dokładnie równania `rdmi-energy`.

- [ ] **Step 3: Rozszerzyć FEM ABI i runtime state**

Do końca `fullmag_fem_plan_desc` dodać:

```c
int    has_rotated_interfacial_dmi;
double rotated_interfacial_dmi_constant;
```

Do ogona `fullmag_fem_step_stats` dodać `double rotated_interfacial_dmi_energy_joules;`. Zaktualizować layout tests i Rust bindings.

- [ ] **Step 4: Dodać MFEM element loop**

Nowy moduł korzysta z `prepare_dmi_periodic_input`, `refresh_dmi_grid_functions_from_magnetization`, `DmiElementWorkspace`, `mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder())` i `dmi_project_lumped_field`. Nie kopiuje polityki PBC ani workspace.

- [ ] **Step 5: Wpiąć kompozycję, transakcje i relaksację**

`effective_field.cpp` zeruje bufor gdy interakcja wyłączona, dodaje go do `H_eff` dokładnie raz i publikuje osobną energię. Transaction snapshot/restore obejmuje bufor i energię, a PG-BB/nonlinear-CG direct energy increment liczy składnik osobno.

- [ ] **Step 6: Uruchomić managed FEM CPU tests**

Najpierw dodać `fem_rotated_dmi_weak_residual` do CMake, następnie uruchomić kontenerową recepturę `verify-fem-rotated-dmi-runtime` w trybie CPU:

```powershell
just verify-fem-rotated-dmi-runtime device=cpu
```

Expected: weak residual, mixed P1, PBC, effective field i relaxation derivative PASS dla tet/prism/pyramid; brak MFEM fallbacku.

- [ ] **Step 7: Commit FEM CPU**

```powershell
git add native/include/fullmag_fem.h crates/fullmag-fem-sys backends/fem crates/fullmag-runner/src/native_fem.rs justfile
git commit -m "feat: implement rotated DMI in FEM CPU"
```

---

### Task 9: Dodać typowaną kwadraturę FEM GPU

**Files:**
- Create: `backends/fem/gpu/cuda/interactions/dmi/rotated_dmi_quadrature.hpp`
- Create: `backends/fem/gpu/cuda/interactions/dmi/rotated_dmi_quadrature.cpp`
- Modify: `backends/fem/gpu/cuda/mesh/mesh_geometry_state.hpp`
- Modify: `backends/fem/gpu/cuda/mesh/mesh_geometry_upload.hpp`
- Modify: `backends/fem/gpu/cuda/mesh/mesh_geometry_upload.cpp`
- Modify: `backends/fem/gpu/cuda/state/gpu_state.cpp`
- Modify: `backends/fem/gpu/cuda/state/gpu_state.hpp`
- Modify: `backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp`
- Test: `backends/fem/tests/source_facade_gpu_state_contract.cpp`
- Test: `backends/fem/tests/cuda_tetra_gradient_contract.cpp`
- Test: `backends/fem/tests/fem_mixed_p1_contract.cpp`

**Interfaces:**
- Consumes: kanoniczne `cell_types`, `cell_offsets`, `cell_nodes`, MFEM FE geometry i magnetic mask podczas setupu.
- Produces: device buffers `RotatedDmiElementDesc[]`, `element_nodes[]`, `quadrature_desc[]`, `shape[]`, `grad_shape_xyz[]`; hot loop nie używa hosta.

- [ ] **Step 1: Napisać czerwone testy typed topology upload**

Test buduje jedną komórkę każdego typu, oznacza ją jako magnetyczną i wymaga:

```cpp
check(state.rotated_dmi_quadrature.element_count == 3, "typed DMI element count lost");
check(state.rotated_dmi_quadrature.max_element_arity == 6, "prism6 arity lost");
check(state.rotated_dmi_quadrature.host_to_device_bytes > 0, "quadrature was not uploaded");
```

Uszkodzony offset i nieznany cell type muszą zwrócić typowany błąd przed CUDA launch.

- [ ] **Step 2: Zdefiniować stabilne deskryptory**

```cpp
struct RotatedDmiElementDesc {
    uint32_t node_offset;
    uint32_t node_count;
    uint32_t quadrature_offset;
    uint32_t quadrature_count;
};

struct RotatedDmiQuadratureDesc {
    uint32_t basis_offset;
    double weight;
};
```

`basis_offset` wskazuje równoległe tablice `shape` i `grad_shape_xyz`; każda pozycja jest związana z konkretnym lokalnym node. Deskryptory są wyprowadzane z MFEM `CalcShape` i `CalcPhysDShape` w setupie, więc prism6/pyramid5 zachowują własne funkcje bazowe i orientację.

- [ ] **Step 3: Wykonać upload raz na lifecycle**

Setup odrzuca nieskończone wagi, niedodatni Jacobian measure, niezgodne arity i element magnetyczny bez kwadratury. Transfer audit księguje dokładne bajty. Bufory są zwalniane w `gpu_state_free`; checkpoint nie serializuje statycznej geometrii, lecz receipt wiąże jej digest.

- [ ] **Step 4: Uruchomić managed source/runtime tests**

```powershell
just verify-fem-rotated-dmi-runtime device=gpu phase=topology
```

Expected: typed upload PASS dla tet4/prism6/pyramid5 i zero dodatkowych H2D po rozpoczęciu RK hot loop.

- [ ] **Step 5: Commit typed GPU geometry**

```powershell
git add backends/fem/gpu/cuda/interactions/dmi/rotated_dmi_quadrature.* backends/fem/gpu/cuda/mesh backends/fem/gpu/cuda/state backends/fem/gpu/cuda/runtime backends/fem/tests
git commit -m "feat: upload typed FEM DMI quadrature to GPU"
```

---

### Task 10: Zaimplementować FEM GPU field, energię i relaksację

**Files:**
- Create: `backends/fem/gpu/cuda/interactions/dmi/rotated_dmi_kernels.hpp`
- Create: `backends/fem/gpu/cuda/interactions/dmi/rotated_dmi_kernels.cu`
- Modify: `backends/fem/gpu/cuda/fields/field_buffer_state.hpp`
- Modify: `backends/fem/gpu/cuda/fields/field_buffer_memory.cpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_dmi_energy_reductions.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_stats.hpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_stats_publication.cpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_total_energy_reduction.cu`
- Modify: `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp`
- Modify: `backends/fem/gpu/cuda/relaxation/pgbb.cpp`
- Modify: `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Test: `backends/fem/tests/source_facade_cuda_kernels_contract.cpp`
- Test: `backends/fem/tests/source_facade_gpu_rk_contract.cpp`
- Test: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`
- Test: `backends/fem/tests/llg_time_domain_qualification.cpp`

**Interfaces:**
- Consumes: device typed quadrature i `ctx.dmi.rotated_interfacial_D`.
- Produces: `gpu.fields.h_rotated_dmi`, scalar slot `RotatedDmiEnergy`, direct energy increment oraz device receipt bez host compute.

- [ ] **Step 1: Napisać czerwony CUDA residual/energy parity test**

Każdy cell type używa tej samej magnetyzacji nodalnej i porównuje device residual z `dmi_accumulate_rotated_interfacial_residual`. Test dodatkowo sprawdza directional derivative `E(m+eps*q)-E(m-eps*q)`.

Expected RED: kernel i buffer nie istnieją.

- [ ] **Step 2: Zaimplementować kernel kwadraturowy**

Wątek obsługuje jeden element. Dla każdego punktu kwadratury odtwarza `m_q` i `grad_m`, a następnie dla każdego lokalnego node wykonuje:

```cpp
const double rx = d * w * (shape * (-grad_m[2][0] + grad_m[1][1]) + m_q[2] * sx - m_q[1] * sy);
const double ry = d * w * (-shape * grad_m[0][1] + m_q[0] * sy);
const double rz = d * w * ( shape * grad_m[0][0] - m_q[0] * sx);
atomicAdd(&residual_x[node], rx);
atomicAdd(&residual_y[node], ry);
atomicAdd(&residual_z[node], rz);
```

Drugi kernel projektuje przez lumped mass i `Ms` z prefaktorem `-1/(mu0*Ms*mass)`. Energy reduction używa tego samego `m_q`, `grad_m`, `D` i `w`.

- [ ] **Step 3: Wpiąć RK i `H_eff`**

`gpu_rk_compute_dmi_field_contributions` wywołuje nowy kernel przy aktywnej fladze. `rk_effective_field.cu` dodaje trzy składowe dokładnie raz. Brak quadrature buffer zwraca `GPU RK rotated DMI requires typed device quadrature`, bez próby CPU.

- [ ] **Step 4: Wpiąć stats i transakcyjną relaksację**

Nowy `GpuFinalScalarSlot::RotatedDmiEnergy` uczestniczy w total energy i osobnym polu stats. Direct difference kernel liczy spolaryzowaną różnicę energii z tym samym funkcjonałem. PG-BB i nonlinear-CG checkpoint/rollback obejmują nowy scalar i field revision.

- [ ] **Step 5: Uruchomić managed GPU tests**

```powershell
just verify-fem-rotated-dmi-runtime device=gpu phase=operator
```

Expected: tet4/prism6/pyramid5 residual/energy PASS, CPU–GPU FP64 parity PASS, zero host field computation/transfer w hot loop, device receipt wskazuje CUDA.

- [ ] **Step 6: Commit FEM GPU**

```powershell
git add backends/fem/gpu backends/fem/tests backends/fem/CMakeLists.txt
git commit -m "feat: execute rotated DMI on FEM GPU"
```

---

### Task 11: Spiąć runner, snapshoty, provenance i resource API

**Files:**
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `crates/fullmag-runner/src/native_fem/tests/plan_contracts.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- Modify: `crates/fullmag-runner/src/preview.rs`
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-runner/src/interactive_runtime.rs`
- Modify: `crates/fullmag-api/src/preview.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify: `apps/control-room/src/kernel/resources/fieldAvailabilityResources.ts`
- Test: `apps/control-room/src/kernel/resources/fieldAvailabilityResources.test.tsx`

**Interfaces:**
- Consumes: natywne pola/energie obu backendów.
- Produces: snapshot `H_rotated_dmi`, density `eden_rotated_dmi`, scalar `E_rotated_dmi`, agregat `E_dmi`, requested/resolved/executed provenance.

- [ ] **Step 1: Napisać test E2E materializacji ilości**

```rust
#[test]
fn active_rotated_dmi_materializes_all_public_quantities() {
    let run = execute_small_rotated_dmi_fixture(DeviceKind::Cpu).unwrap();
    assert_nonzero_vector(run.field("H_rotated_dmi"));
    assert_nonzero_scalar_field(run.field("eden_rotated_dmi"));
    assert_eq!(run.scalar("E_rotated_dmi"), integrate(run.field("eden_rotated_dmi")));
    assert_eq!(run.scalar("E_dmi"), run.scalar("E_rotated_dmi"));
}
```

Expected RED: quantity materializer missing.

- [ ] **Step 2: Rozszerzyć natywne mapowania i snapshoty**

FEM i FDM mają osobne enumy snapshotu, ale wspólny wire ID. Każdy accessor zwraca bezpośredni bufor operatora; nie może ponownie liczyć pełnego `H_eff`.

- [ ] **Step 3: Rozszerzyć receipts**

Manifest publikuje:

```json
{
  "requested_interaction": "rotated_interfacial_dmi",
  "resolved_realization": "goebel_rotated_interfacial_dmi_v1",
  "executed_device": "gpu",
  "executed_precision": "double",
  "fallback": false
}
```

`D` jest zapisane w SI, a source identity i hash planu wiążą operator.

- [ ] **Step 4: Dodać resource API/frontend test**

Field descriptor ma `spatial_domain="magnetic_only"`, unit `A/m`, dostępność dla czterech lane’ów i pending state przed pierwszym snapshotem. Frontend nie hardcoduje fallbacku do `H_dmi`.

- [ ] **Step 5: Uruchomić testy**

```powershell
$env:CARGO_TARGET_DIR='C:\fullmag-build\rotated-dmi-runner'; cargo test -p fullmag-runner rotated_dmi -- --nocapture; cargo test -p fullmag-api rotated_dmi -- --nocapture
pnpm --dir apps/control-room test -- fieldAvailabilityResources.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit integracji runtime**

```powershell
git add crates/fullmag-runner crates/fullmag-api apps/control-room/src/kernel/resources
git commit -m "feat: expose rotated DMI runtime resources"
```

---

### Task 12: Dodać scenariusze Göbel 2019 i niezależny verifier

**Files:**
- Create: `tests/standard_problems/bimeron/goebel_2019/__init__.py`
- Create: `tests/standard_problems/bimeron/goebel_2019/common.py`
- Create: `tests/standard_problems/bimeron/goebel_2019/scenario_fdm.py`
- Create: `tests/standard_problems/bimeron/goebel_2019/scenario_fem.py`
- Create: `tests/standard_problems/bimeron/goebel_2019/verify.py`
- Create: `tests/standard_problems/bimeron/goebel_2019/test_contract.py`
- Create: `tests/standard_problems/bimeron/goebel_2019/thresholds.v1.json`
- Modify: `justfile`

**Interfaces:**
- Consumes: `fm.RotatedInterfacialDMI`, istniejący `fm.texture.bimeron`, topological-charge v2 resource i oba backendy.
- Produces: source-pinned FDM/FEM artifacts oraz JSON qualification receipt.

- [ ] **Step 1: Napisać czerwony test wspólnego kontraktu scenariuszy**

```python
def test_fdm_and_fem_scenarios_share_goebel_parameters() -> None:
    fdm = load_scenario_ast("scenario_fdm.py")
    fem = load_scenario_ast("scenario_fem.py")
    for name, value in {
        "TRACK_SIZE": (500e-9, 40e-9, 0.5e-9),
        "MS": 0.58e6,
        "AEX": 15e-12,
        "D_ROTATED": 3e-3,
        "KU_X": 0.8e6,
        "ALPHA": 0.3,
    }.items():
        assert fdm.constant(name) == value
        assert fem.constant(name) == value
    assert fdm.periodic_axes() == (True, False, False)
    assert fem.periodic_axes() == (True, False, False)
```

Expected RED: scenariusze nie istnieją.

- [ ] **Step 2: Utworzyć jeden moduł parametrów**

```python
TRACK_SIZE = (500e-9, 40e-9, 0.5e-9)
MS = 0.58e6
AEX = 15e-12
D_ROTATED = 3e-3
KU_X = 0.8e6
ALPHA = 0.3
TEMPERATURE = 0.0
BIMERON_RADIUS = 10e-9
BIMERON_WALL_WIDTH = 3e-9
LLG_HOLD_TIME = 1e-9
```

Promień i wall width są wspólne; ich wartości są mniejsze niż połowa szerokości toru i rozdzielczość obu siatek zapewnia co najmniej trzy próbki na wall width.

- [ ] **Step 3: Napisać stage-first scenariusz FDM**

```python
study = fm.study("goebel_2019_bimeron_fdm")
study.engine("fdm")
study.device("auto", precision="double")
study.mode("strict")
study.cell(1e-9, 1e-9, 0.5e-9)
study.pbc(x=True)
film = study.geometry(fm.Box(size=TRACK_SIZE, name="film"), name="film")
film.Ms, film.Aex, film.alpha = MS, AEX, ALPHA
film.Ku1, film.anisU = KU_X, (1.0, 0.0, 0.0)
film.m = fm.texture.bimeron(radius=BIMERON_RADIUS, wall_width=BIMERON_WALL_WIDTH, plane="xy")
study.terms.add(fm.RotatedInterfacialDMI(D=D_ROTATED))
study.demag(realization="auto")
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=20_000, tolT=1e-6)
study.stages.add_run(stage_id="hold", until=LLG_HOLD_TIME)
```

Siatka ma `dx=dy=1e-9`, `dz=0.5e-9` i PBC `x`.

- [ ] **Step 4: Napisać stage-first scenariusz FEM**

FEM używa tych samych pól, wywołuje `study.pbc(x=True)` oraz:

```python
film.mesh.thin_film(
    minimum_element_size=0.5e-9,
    maximum_element_size=1.0e-9,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)
```

Magnetyczna warstwa musi pozostać `prism6`; Airbox może zawierać niemagnetyczne `pyramid5/tet4`. PBC `x` i demag `poisson_robin` są jawne.

- [ ] **Step 5: Zaimplementować verifier**

Verifier czyta finalny manifest, receipt, tabelę i magnetyzację. Używa istniejącego topological-charge v2 algorytmu i wymaga:

```python
assert final_energy_j < initial_energy_j
assert abs(final_topological_charge) >= 0.8
assert initial_topological_charge * final_topological_charge > 0.0
assert max_mz >= 0.5 and min_mz <= -0.5
assert background_mean_mx >= 0.8
assert hold_min_abs_topological_charge >= 0.8
assert receipt["fallback"] is False
```

Dwa rdzenie są rozdzielone o co najmniej `2 * min(dx,dy)` i pozostają wewnątrz centralnych 80% szerokości toru.

- [ ] **Step 6: Zamrozić progi operatora, nie dopasowywać ich do bimeronu**

`thresholds.v1.json` zawiera:

```json
{
  "schema_version": "goebel-bimeron-thresholds.v1",
  "min_abs_topological_charge": 0.8,
  "min_core_abs_mz": 0.5,
  "min_background_mx": 0.8,
  "fdm_cpu_gpu_fp64_field_rtol": 2e-12,
  "fem_cpu_gpu_fp64_residual_rtol": 5e-11,
  "fp32_field_rtol": 3e-5
}
```

- [ ] **Step 7: Dodać managed recipes**

`just verify-goebel-bimeron-fdm device=cpu|gpu` i `just verify-goebel-bimeron-fem device=cpu|gpu` uruchamiają source-pinned scenariusz, verifier i zapisują receipt poza checkoutem. `just qualify-goebel-bimeron` wykonuje cztery lane’y i generuje zbiorcze porównanie bez ukrywania brakujących wyników.

- [ ] **Step 8: Uruchomić testy kontraktu scenariusza**

```powershell
& 'C:\Users\Mateusz\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m pytest tests/standard_problems/bimeron/goebel_2019/test_contract.py -q
```

Expected: PASS.

- [ ] **Step 9: Commit scenariuszy**

```powershell
git add tests/standard_problems/bimeron/goebel_2019 justfile
git commit -m "test: add Goebel bimeron reproduction"
```

---

### Task 13: Wykonać pełną kwalifikację i zamknąć publikację

**Files:**
- Modify: `docs/physics/0406-rotated-interfacial-dmi.source-map.json`
- Modify: `docs/physics/0406-rotated-interfacial-dmi.md`
- Create: `docs/validation/2026-08-31-goebel-bimeron-qualification.md`
- Modify: `public_docs/site/physics/foundations/observables.md`
- Modify: `public_docs/site/physics/interactions/dmi/index.md`

**Interfaces:**
- Consumes: wszystkie testy i cztery managed receipts.
- Produces: końcową macierz kwalifikacji, aktualną source map i publikacyjny status każdej realizacji.

- [ ] **Step 1: Uruchomić pełne testy semantyczne**

```powershell
$env:CARGO_TARGET_DIR='C:\fullmag-build\rotated-dmi-final'; cargo test -p fullmag-ir rotated_interfacial_dmi -- --nocapture; cargo test -p fullmag-plan rotated_interfacial_dmi -- --nocapture; cargo test -p fullmag-quantities rotated_dmi -- --nocapture; cargo test -p fullmag-authoring rotated_dmi -- --nocapture; cargo test -p fullmag-api rotated_dmi -- --nocapture
$env:PYTHONPATH='packages/fullmag-py/src'; & 'C:\Users\Mateusz\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m pytest packages/fullmag-py/tests/test_api.py tests/standard_problems/bimeron/goebel_2019/test_contract.py -q
pnpm --dir apps/control-room typecheck
```

Expected: wszystkie PASS.

- [ ] **Step 2: Uruchomić cztery zarządzane runtime’y**

```powershell
just verify-fdm-gpu-rotated-dmi-runtime
just verify-fem-rotated-dmi-runtime device=cpu
just verify-fem-rotated-dmi-runtime device=gpu
just qualify-goebel-bimeron
```

Expected: zakończone receipts FDM CPU/GPU i FEM CPU/GPU; źródło, urządzenie, precision, brak fallbacku, operator field/energy derivative i stabilizacja bimeronu są jawne.

- [ ] **Step 3: Uruchomić sanitizer i brak transferów hot-loop**

Managed receptura uruchamia `compute-sanitizer --tool memcheck` dla FDM/FEM CUDA fixture i sprawdza transfer audit: zero pełnych field H2D/D2H pomiędzy granicami publikacji.

- [ ] **Step 4: Zaktualizować source map i walidować dokumentację**

Po istnieniu wszystkich symboli:

```powershell
& 'C:\Users\Mateusz\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0406-rotated-interfacial-dmi.source-map.json --repo-root .
& 'C:\Users\Mateusz\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' scripts/check_public_doc_examples.py --root public_docs/site
```

Expected: PASS.

- [ ] **Step 5: Zbudować strict Sphinx i walidować HTML**

Użyć repozytoryjnej receptury public docs z warnings-as-errors, następnie:

```powershell
& 'C:\Users\Mateusz\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0406-rotated-interfacial-dmi.source-map.json --repo-root . --rendered-html public_docs/site/_build/html/physics/interactions/dmi/rotated-interfacial.html
```

Expected: PASS; MathJax i copy controls obecne.

- [ ] **Step 6: Napisać raport kwalifikacyjny**

Raport po polsku zawiera tabelę `FDM CPU`, `FDM GPU FP64`, `FDM GPU FP32`, `FEM CPU`, `FEM GPU`, oddzielne kolumny source/build/runtime/science, linki do receipts, mesh counts, Q, energie, core extrema i brak fallbacku. Każda niewykonana bramka jest `NOT VERIFIED`, nie `PASS`.

- [ ] **Step 7: Uruchomić końcowy diff audit i commit**

```powershell
git diff --check
git status --short
git diff --cached --name-only
git add docs/physics/0406-rotated-interfacial-dmi.md docs/physics/0406-rotated-interfacial-dmi.source-map.json docs/validation/2026-08-31-goebel-bimeron-qualification.md public_docs/site/physics
git commit -m "docs: qualify Goebel bimeron reproduction"
```

Expected: staging zawiera wyłącznie dokumentację końcowej kwalifikacji; niepowiązane submoduły i PDF-y pozostają poza commitem.

---

## Punkty przeglądu

1. Po Task 5: przegląd semantycznego spine — physics note, Python/IR/planner, quantities i authoring.
2. Po Task 7: przegląd FDM CPU/GPU wraz z energy derivative i managed CUDA receipt.
3. Po Task 10: przegląd FEM CPU/GPU, typed topology i braku host fallbacku.
4. Po Task 13: completion audit wymaganie-po-wymaganiu względem specyfikacji; dopiero wtedy można ogłosić ukończenie.
