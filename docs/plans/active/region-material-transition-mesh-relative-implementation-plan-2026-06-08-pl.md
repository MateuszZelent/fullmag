# Region-Owned Mesh-Relative Material Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodać do Fullmag prosty, region-owned mechanizm lokalnych defektów materiałowych, w którym `region.material.Ms = ...` i `region.set_material_field("Ms", ...)` domyślnie materializują ciągłe, mesh-relative przejście bez sztucznego ostrego interfejsu, a użytkownik jawnie wybiera także stronę/zakres gradientu względem granicy regionu oraz sposób podawania szerokości, podczas gdy jawny tryb `sharp` pozostaje opcją zaawansowaną.

**Architecture:** Publiczny Python DSL dostaje ergonomiczny uchwyt `ObjectRegion.material` oraz `ObjectRegion.material_transition(...)`, ale wewnętrznie kontrakt jest explicite rozdzielony na: authored region selector, transition policy, boundary anchoring policy, width units, material field realization i planner capability gates. FDM i FEM mają wspólną semantykę authored intent (`mesh_relative`, `metric`, `sharp`) oraz zasięgu gradientu (`boundary`, `inside`, `outside`), ale osobne realizacje numeryczne: FDM sampluje gładkie pola na siatce kartezjańskiej, a FEM buduje continuous coefficient field z signed-distance do authored region boundary i lokalnego `h`.

**Tech Stack:** Python DSL (`packages/fullmag-py`), ProblemIR (`crates/fullmag-ir`), execution planner (`crates/fullmag-plan`), canonical script export (`packages/fullmag-py/src/fullmag/runtime/script_builder.py`), physics docs (`docs/physics`), rollout docs (`docs/plans/active`).

---

## File Structure

### Modify

- `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`
- `docs/specs/capability-matrix-v0.md`
- `docs/specs/capability-matrix-v0.json`
- `docs/plans/active/region-owned-implementation-masterplan-2026-06-04-pl.md`
- `packages/fullmag-py/src/fullmag/model/structure.py`
- `packages/fullmag-py/src/fullmag/world.py`
- `packages/fullmag-py/src/fullmag/__init__.py`
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- `crates/fullmag-api/src/schemas/authoring.rs`
- `crates/fullmag-ir/src/model.rs`
- `crates/fullmag-ir/src/lib.rs`
- `crates/fullmag-ir/tests/ir_tests.rs`
- `crates/fullmag-plan/src/lib.rs`
- `crates/fullmag-plan/src/material.rs`
- `crates/fullmag-plan/src/fdm.rs`
- `crates/fullmag-plan/src/fem.rs`
- `crates/fullmag-plan/src/validate.rs`
- `crates/fullmag-plan/src/tests.rs`
- `apps/control-room/src/modules/inspector/panels/region/ObjectRegionMaterialFieldsModel.ts`
- `apps/control-room/src/modules/inspector/panels/region/ObjectRegionOverviewPanel.tsx`
- `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.ts`
- `examples/permalloy_box_relax_300x1000x10nm.py`
- `examples/region_owned_gradient_ms.py`

### Create

- `crates/fullmag-plan/src/material_transition.rs`
- `packages/fullmag-py/tests/test_region_material_transition.py`

### Responsibilities

- `structure.py` owns authored Python DSL surface for regions, transitions, and serialization into Python-side IR dicts.
- `world.py` owns runtime-facing ergonomic handles and high-level object/region authoring behavior.
- `model.rs` and `lib.rs` own canonical ProblemIR vocabulary and validation.
- `material_transition.rs` owns backend-neutral transition classification and helper math.
- `fdm.rs` and `fem.rs` own backend-specific lowering/materialization.
- `validate.rs` owns legal/illegal combinations for strict vs extended execution.
- `script_builder.py` owns canonical round-trip script export so UI/scene export preserves the new semantics.
- `scene_document.py`, `crates/fullmag-api/src/schemas/authoring.rs`, and `apps/control-room` region panels own UI/API round-trip preservation for scene-authored regions.

---

## Contract Decisions This Plan Implements

1. `region.material.Ms = 400e3` no longer means “sharp by default”.  
   For `Ms` and `Aex`, the default region-local transition is `mesh_relative(cells=3)`.
2. `region.material_transition(...)` is a region-scoped authored default that applies to region-local `material.*` assignments and `region.set_material_field(...)`.
3. Smooth transition scope relative to the region boundary is user-selectable:
   - `scope="boundary"`: smooth across the boundary on both sides,
   - `scope="inside"`: smooth only into the region interior,
   - `scope="outside"`: smooth only into the exterior of the region.
   The default is `scope="boundary"`.
4. Transition width units are user-selectable:
   - `cells=N` or `kind="mesh_relative"`: width in local mesh cells,
   - `width=...` or `kind="metric"`: width in SI length units.
   The default for `Ms`/`Aex` is `cells=3`.
5. `sharp` is opt-in and has no `scope`, because there is no smooth gradient to anchor. Only explicit `transition="sharp"` (or equivalent low-level API) should enter the current conformal/project capability path.
6. `mesh_relative` means transition width is computed from the local discretization scale, not a fixed metric distance.  
   FDM uses local cell size; FEM uses node/element-local `h`.
7. One magnetic object still owns one `m`. Region-local transition does not create a second magnetization field, a hidden interface coupling, or a separate material object.
8. A void is still geometry, not `Ms=0`. This mechanism is for local defects in continuous media, not for replacing geometric holes.
9. Smooth transition realization requires a supported signed-distance evaluator for the authored region shape. In v1, unsupported shapes must trigger a capability error instead of silently falling back to a binary mask or a guessed bounding-box distance.

---

### Task 1: Freeze the physics and public contract

**Files:**
- Modify: `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`
- Modify: `docs/plans/active/region-owned-implementation-masterplan-2026-06-04-pl.md`
- Modify: `docs/plans/active/region-material-transition-mesh-relative-implementation-plan-2026-06-08-pl.md`

- [ ] **Step 1: Update the physics note with the new transition vocabulary**

Add a subsection to the physics note that defines three authored intents for region-local material modification:

```md
### 2.x Region-local material transition semantics

For one continuous magnetic object, a region-local parameter override does not
automatically imply a sharp material interface.

Authored transition intents:

- `mesh_relative(cells=N)`: smooth transition width tied to local mesh scale,
- `metric(width=...)`: smooth transition width tied to a physical distance,
- `sharp`: discontinuous coefficient jump that may require conformal FEM realization.

Boundary anchoring intents:

- `scope="boundary"`: transition spans both sides of the region boundary,
- `scope="inside"`: transition is consumed only inside the region,
- `scope="outside"`: transition is consumed only outside the region.

Default for region-local `Ms` and `Aex` overrides in one object:

- `mesh_relative(cells=3, scope="boundary")`.
```

- [ ] **Step 2: Add the numerical interpretation for continuous defects**

Extend the physics note with the realization rule:

```md
For a region-local smooth defect, Fullmag materializes a coefficient field
`p(x)` from a support mask / signed-distance function to the authored region
boundary:

```text
p(x) = p_parent + w(x) (p_region - p_parent)
```

where `w(x)` is a smooth transition function, the transition width is either
metric (`width`) or mesh-relative (`N * h_local(x)`), and the support of `w(x)`
is controlled by the authored scope:

- `boundary`: symmetric neighborhood of the interface,
- `inside`: only points inside the region are smoothed,
- `outside`: only points outside the region are smoothed.
```

- [ ] **Step 3: Replace the “sharp by implication” wording in the masterplan**

In the region-owned masterplan, replace wording that treats every region-local constant `Ms/Aex` override as intrinsically sharp with wording that separates:

```md
- authored region-local override,
- authored transition policy,
- resolved numerical realization.
```

The sharp strict/conformal gate must be documented as applying only to explicit `sharp` realization intent.

- [ ] **Step 4: Self-check the doc diff**

Run:

```bash
rg -n "sharp by default|projection is not allowed|mesh_relative|material_transition" docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md docs/plans/active/region-owned-implementation-masterplan-2026-06-04-pl.md
```

Expected: the new `mesh_relative` vocabulary appears, and no edited paragraph still implies that every region-local constant override is sharp by default.

- [ ] **Step 5: Commit**

```bash
git add docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md \
  docs/plans/active/region-owned-implementation-masterplan-2026-06-04-pl.md \
  docs/plans/active/region-material-transition-mesh-relative-implementation-plan-2026-06-08-pl.md
git commit -m "docs: define mesh-relative region material transitions"
```

---

### Task 2: Add the ergonomic Python DSL surface on `ObjectRegion`

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/structure.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Test: `packages/fullmag-py/tests/test_region_material_transition.py`

- [ ] **Step 1: Write the failing Python API tests**

Create tests that pin the user-facing contract:

```python
import fullmag as fm
from fullmag.world import flat_world


def test_region_material_ms_defaults_to_mesh_relative_transition():
    fm.reset()
    body = fm.geometry(fm.Box(size=(100e-9, 20e-9, 10e-9), name="body"), name="body")
    defect = body.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))
    defect.material.Ms = 400e3
    problem = flat_world._build_problem().to_ir(include_geometry_assets=False)
    region = problem["object_regions"][0]
    assert region["material_transition"] == {"kind": "mesh_relative", "cells": 3, "scope": "boundary"}


def test_region_material_transition_can_be_overridden_before_assignment():
    fm.reset()
    body = fm.geometry(fm.Box(size=(100e-9, 20e-9, 10e-9), name="body"), name="body")
    defect = body.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))
    defect.material_transition(cells=5, scope="inside")
    defect.material.Ms = 400e3
    region = flat_world._build_problem().to_ir(include_geometry_assets=False)["object_regions"][0]
    assert region["material_transition"] == {"kind": "mesh_relative", "cells": 5, "scope": "inside"}


def test_region_material_transition_accepts_metric_width():
    fm.reset()
    body = fm.geometry(fm.Box(size=(100e-9, 20e-9, 10e-9), name="body"), name="body")
    defect = body.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))
    defect.material_transition(kind="metric", width=2e-9, scope="outside")
    defect.material.Ms = 400e3
    region = flat_world._build_problem().to_ir(include_geometry_assets=False)["object_regions"][0]
    assert region["material_transition"] == {"kind": "metric", "width": 2e-9, "scope": "outside"}


def test_region_set_material_field_uses_region_support_without_redeclaring_shape():
    fm.reset()
    body = fm.geometry(fm.Box(size=(100e-9, 20e-9, 10e-9), name="body"), name="body")
    defect = body.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))
    defect.set_material_field("Ms", fm.fields.linear(base=800e3, gradient=(1e11, 0.0, 0.0), unit="A/m"))
    region = flat_world._build_problem().to_ir(include_geometry_assets=False)["object_regions"][0]
    assert region["material_overrides"][0]["parameter"] == "Ms"
    assert region["material_overrides"][0]["value"]["kind"] == "linear"
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
pytest packages/fullmag-py/tests/test_region_material_transition.py -q
```

Expected: failures for missing `material_transition`, missing `ObjectRegion.material_transition(...)`, and/or missing `ObjectRegion.set_material_field(...)`.

- [ ] **Step 3: Add the new transition model to `ObjectRegion`**

In `packages/fullmag-py/src/fullmag/model/structure.py`, add a Python-side authored transition object and region methods:

```python
@dataclass(frozen=True, slots=True)
class MaterialTransitionSpec:
    kind: str
    cells: int | None = None
    width: float | None = None
    scope: str = "boundary"

    def to_ir(self) -> dict[str, object]:
        payload = {"kind": self.kind}
        if self.cells is not None:
            payload["cells"] = int(self.cells)
        if self.width is not None:
            payload["width"] = float(self.width)
        if self.kind != "sharp":
            payload["scope"] = self.scope
        return payload


def _default_region_transition_for_parameter(parameter: str) -> MaterialTransitionSpec | None:
    parameter = _normalize_parameter_name(parameter)
    if parameter in {"Ms", "Aex"}:
        return MaterialTransitionSpec(kind="mesh_relative", cells=3, scope="boundary")
    return None
```

Then extend `ObjectRegion`:

```python
_material_transition: MaterialTransitionSpec | None = field(default=None, repr=False, compare=False)

def material_transition(self, *, cells: int | None = None, width: float | None = None, kind: str = "mesh_relative", scope: str = "boundary") -> "ObjectRegion":
    if scope not in {"boundary", "inside", "outside"}:
        raise ValueError("scope must be one of: boundary, inside, outside")
    if kind == "mesh_relative":
        if cells is None:
            raise ValueError("cells is required for mesh_relative transition")
        if int(cells) < 1:
            raise ValueError("cells must be >= 1")
        self._material_transition = MaterialTransitionSpec(kind="mesh_relative", cells=int(cells), scope=scope)
    elif kind == "metric":
        if width is None:
            raise ValueError("width is required for metric transition")
        self._material_transition = MaterialTransitionSpec(kind="metric", width=float(width), scope=scope)
    elif kind == "sharp":
        self._material_transition = MaterialTransitionSpec(kind="sharp")
    else:
        raise ValueError(f"unsupported material transition kind: {kind}")
    return self

def set_material_field(self, parameter: str, value: float | tuple[float, float, float] | MaterialParameterField, *, unit: str | None = None, priority: int | None = None, conflict_policy: str = "error") -> "ObjectRegion":
    return self.set_material(parameter, value, unit=unit, priority=priority, conflict_policy=conflict_policy)
```

- [ ] **Step 4: Make `region.material.Ms = ...` auto-populate the default transition**

Extend `ObjectRegion.set_material(...)` so that it attaches the default transition only when the user did not choose one already:

```python
if self._material_transition is None:
    default_transition = _default_region_transition_for_parameter(parameter)
    if default_transition is not None:
        self._material_transition = default_transition
```

and serialize it:

```python
if self._material_transition is not None:
    payload["material_transition"] = self._material_transition.to_ir()
```

- [ ] **Step 5: Export the new symbol**

In `packages/fullmag-py/src/fullmag/__init__.py`, export `MaterialTransitionSpec` only if we want it public.  
If we keep it internal, do not export it; only keep the ergonomic `region.material_transition(...)` surface public.  
For v1, prefer internal-only:

```python
__all__ = [
    ...
    # no public MaterialTransitionSpec export in v1
]
```

- [ ] **Step 6: Run Python tests**

Run:

```bash
pytest packages/fullmag-py/tests/test_region_material_transition.py -q
pytest packages/fullmag-py/tests/test_api.py -q
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add packages/fullmag-py/src/fullmag/model/structure.py \
  packages/fullmag-py/src/fullmag/world.py \
  packages/fullmag-py/src/fullmag/__init__.py \
  packages/fullmag-py/tests/test_region_material_transition.py
git commit -m "feat: add region-owned material transition DSL"
```

---

### Task 3: Extend `ProblemIR` with transition intent

**Files:**
- Modify: `crates/fullmag-ir/src/model.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`
- Modify: `crates/fullmag-ir/tests/ir_tests.rs`

- [ ] **Step 1: Write the failing IR tests**

Add tests that require `ObjectRegionIR` to preserve transition metadata:

```rust
#[test]
fn object_region_material_transition_round_trips() {
    let mut ir = ProblemIR::default();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "film:defect".to_string(),
        owner_object: "film".to_string(),
        name: "defect".to_string(),
        shape: RegionShapeIR::Sphere { radius: 5e-9, center: [0.0, 0.0, 0.0] },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: vec![],
        texture_override: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
        material_transition: Some(MaterialTransitionSpecIR::MeshRelative {
            cells: 3,
            scope: MaterialTransitionScopeIR::Boundary,
        }),
    });
    let json = serde_json::to_string(&ir).unwrap();
    let decoded: ProblemIR = serde_json::from_str(&json).unwrap();
    assert_eq!(
        decoded.object_regions[0].material_transition,
        Some(MaterialTransitionSpecIR::MeshRelative {
            cells: 3,
            scope: MaterialTransitionScopeIR::Boundary,
        })
    );
}
```

- [ ] **Step 2: Run the IR tests and confirm failure**

Run:

```bash
cargo test -p fullmag-ir object_region_material_transition_round_trips -- --nocapture
```

Expected: compile failure for missing `material_transition` or missing `MaterialTransitionSpecIR`.

- [ ] **Step 3: Add the new IR enum and field**

In `crates/fullmag-ir/src/model.rs`, add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MaterialTransitionSpecIR {
    MeshRelative {
        cells: u32,
        #[serde(default = "default_material_transition_scope")]
        scope: MaterialTransitionScopeIR,
    },
    Metric {
        width: f64,
        #[serde(default = "default_material_transition_scope")]
        scope: MaterialTransitionScopeIR,
    },
    Sharp,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterialTransitionScopeIR {
    Boundary,
    Inside,
    Outside,
}

fn default_material_transition_scope() -> MaterialTransitionScopeIR {
    MaterialTransitionScopeIR::Boundary
}
```

and extend `ObjectRegionIR`:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub material_transition: Option<MaterialTransitionSpecIR>,
```

- [ ] **Step 4: Validate transition payloads in `crates/fullmag-ir/src/lib.rs`**

Add a helper like:

```rust
fn validate_material_transition(
    value: &Option<MaterialTransitionSpecIR>,
    source: &str,
    errors: &mut Vec<String>,
) {
    match value {
        Some(MaterialTransitionSpecIR::MeshRelative { cells, .. }) if *cells == 0 => {
            errors.push(format!("{source}.cells must be >= 1"));
        }
        Some(MaterialTransitionSpecIR::Metric { width, .. }) if !width.is_finite() || *width <= 0.0 => {
            errors.push(format!("{source}.width must be > 0"));
        }
        _ => {}
    }
}
```

and call it from region validation.

- [ ] **Step 5: Run IR tests**

Run:

```bash
cargo test -p fullmag-ir -- --nocapture
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add crates/fullmag-ir/src/model.rs crates/fullmag-ir/src/lib.rs crates/fullmag-ir/tests/ir_tests.rs
git commit -m "feat: add material transition intent to object regions"
```

---

### Task 4: Add planner-neutral transition helpers and migration rules

**Files:**
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/specs/capability-matrix-v0.json`
- Create: `crates/fullmag-plan/src/material_transition.rs`
- Modify: `crates/fullmag-plan/src/lib.rs`
- Modify: `crates/fullmag-plan/src/material.rs`
- Modify: `crates/fullmag-plan/src/validate.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`

- [ ] **Step 1: Write failing planner tests for default smooth semantics**

Add tests that express the new contract:

```rust
#[test]
fn fem_region_local_ms_without_explicit_transition_is_not_treated_as_sharp() {
    let mut ir = default_test_problem_ir();
    let mut region = default_test_object_region();
    region.material_transition = Some(fullmag_ir::MaterialTransitionSpecIR::MeshRelative {
        cells: 3,
        scope: fullmag_ir::MaterialTransitionScopeIR::Boundary,
    });
    region.material_overrides.push(fullmag_ir::RegionMaterialOverrideIR {
        parameter: fullmag_ir::MaterialParameterNameIR::Ms,
        value: fullmag_ir::MaterialParameterFieldIR::Constant { value: 400e3.into(), unit: Some("A/m".to_string()) },
        priority: 0,
        conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
    });
    ir.object_regions.push(region);
    let planned = plan(&ir).expect("mesh-relative region defect should plan without sharp conformal gate");
    assert!(!format!("{planned:?}").contains("requires a conformal boundary"));
}

#[test]
fn fem_region_local_ms_with_sharp_transition_still_requires_conformal_in_strict() {
    let mut ir = default_test_problem_ir();
    let mut region = default_test_object_region();
    region.material_transition = Some(fullmag_ir::MaterialTransitionSpecIR::Sharp);
    region.material_overrides.push(fullmag_ir::RegionMaterialOverrideIR {
        parameter: fullmag_ir::MaterialParameterNameIR::Ms,
        value: fullmag_ir::MaterialParameterFieldIR::Constant { value: 400e3.into(), unit: Some("A/m".to_string()) },
        priority: 0,
        conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
    });
    ir.object_regions.push(region);
    let err = plan(&ir).expect_err("sharp region defect should stay on the strict conformal gate");
    assert!(err.reasons.iter().any(|reason| reason.contains("requires a conformal boundary")));
}
```

- [ ] **Step 2: Run those planner tests and confirm failure**

Run:

```bash
cargo test -p fullmag-plan fem_region_local_ms_without_explicit_transition_is_not_treated_as_sharp -- --nocapture
cargo test -p fullmag-plan fem_region_local_ms_with_sharp_transition_still_requires_conformal_in_strict -- --nocapture
```

Expected: current code fails because every constant `Ms/Aex` region override is treated as sharp.

- [ ] **Step 3: Create `material_transition.rs` and centralize transition classification**

Add a helper file:

```rust
use fullmag_ir::{
    MaterialParameterNameIR, MaterialTransitionScopeIR, MaterialTransitionSpecIR, ObjectRegionIR,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ResolvedTransitionKind {
    SmoothMeshRelative { cells: u32, scope: MaterialTransitionScopeIR },
    SmoothMetric { width: f64, scope: MaterialTransitionScopeIR },
    Sharp,
    None,
}

pub fn resolved_region_transition(
    region: &ObjectRegionIR,
    parameter: MaterialParameterNameIR,
) -> ResolvedTransitionKind {
    match (&region.material_transition, parameter) {
        (Some(MaterialTransitionSpecIR::MeshRelative { cells, scope }), _) => {
            ResolvedTransitionKind::SmoothMeshRelative {
                cells: *cells,
                scope: *scope,
            }
        }
        (Some(MaterialTransitionSpecIR::Metric { width, scope }), _) => {
            ResolvedTransitionKind::SmoothMetric {
                width: *width,
                scope: *scope,
            }
        }
        (Some(MaterialTransitionSpecIR::Sharp), _) => ResolvedTransitionKind::Sharp,
        (None, MaterialParameterNameIR::Ms | MaterialParameterNameIR::Aex) => {
            ResolvedTransitionKind::SmoothMeshRelative {
                cells: 3,
                scope: MaterialTransitionScopeIR::Boundary,
            }
        }
        _ => ResolvedTransitionKind::None,
    }
}
```

Wire it into `crates/fullmag-plan/src/lib.rs`:

```rust
mod material_transition;
```

- [ ] **Step 4: Change `validate.rs` to gate only explicit sharp jumps**

Refactor the current sharp detection:

```rust
let has_sharp_override = ...
```

into:

```rust
let has_explicit_sharp_override = ...
    && crate::material_transition::resolved_region_transition(region, parameter)
        == crate::material_transition::ResolvedTransitionKind::Sharp;
```

Only the `Sharp` path should keep the current strict/extended conformal vs project logic.

Smooth paths must also pass a signed-distance support check. For v1, accept only region shapes with explicit evaluators (`box`, `cylinder`, `sphere`) and block unsupported `csg`/imported shapes with:

```text
smooth material transition for region '<region_id>' requires signed-distance support for shape '<kind>'
```

- [ ] **Step 5: Add the capability vocabulary**

Update `docs/specs/capability-matrix-v0.md` and `docs/specs/capability-matrix-v0.json` with an explicit capability such as:

```text
material_transition.smooth_signed_distance_shape
```

Required behavior:

- `box`, `cylinder`, `sphere`: supported for v1 smooth transitions,
- `csg`, imported, sampled, or unknown region shapes: blocked,
- no hidden fallback to bounding boxes,
- diagnostic must include region id, shape kind, requested transition kind, backend, and execution mode.

- [ ] **Step 6: Preserve backward compatibility deliberately**

Add one migration warning in planner diagnostics for the ambiguous low-level case:

```rust
if region.material_transition.is_none() && region.realization_policy != RegionRealizationPolicyIR::Inherit {
    warnings.push(format!(
        "region '{}' sets realization_policy='{}' without explicit material_transition; sharp behavior now requires material_transition='sharp'",
        region.region_id,
        region.realization_policy.as_str(),
    ));
}
```

This keeps old advanced scripts from silently drifting.

- [ ] **Step 7: Run the planner tests**

Run:

```bash
cargo test -p fullmag-plan fem_region_local_ms_without_explicit_transition_is_not_treated_as_sharp -- --nocapture
cargo test -p fullmag-plan fem_region_local_ms_with_sharp_transition_still_requires_conformal_in_strict -- --nocapture
```

Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add crates/fullmag-plan/src/material_transition.rs \
  docs/specs/capability-matrix-v0.md \
  docs/specs/capability-matrix-v0.json \
  crates/fullmag-plan/src/lib.rs \
  crates/fullmag-plan/src/material.rs \
  crates/fullmag-plan/src/validate.rs \
  crates/fullmag-plan/src/tests.rs
git commit -m "feat: classify region material transitions in planner"
```

---

### Task 5: Realize smooth region defects on FDM

**Files:**
- Modify: `crates/fullmag-plan/src/material.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`

- [ ] **Step 1: Write the failing FDM test**

Add an FDM-focused test that ensures a region-local `Ms` defect lowers to a sampled/smoothed field, not a binary jump:

```rust
#[test]
fn fdm_mesh_relative_region_ms_lowers_to_material_field_plan() {
    let mut ir = default_test_problem_ir();
    let mut region = default_test_object_region();
    region.material_transition = Some(fullmag_ir::MaterialTransitionSpecIR::MeshRelative {
        cells: 3,
        scope: fullmag_ir::MaterialTransitionScopeIR::Boundary,
    });
    region.material_overrides.push(fullmag_ir::RegionMaterialOverrideIR {
        parameter: fullmag_ir::MaterialParameterNameIR::Ms,
        value: fullmag_ir::MaterialParameterFieldIR::Constant { value: 400e3.into(), unit: Some("A/m".to_string()) },
        priority: 0,
        conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
    });
    ir.object_regions.push(region);
    let planned = plan(&ir).expect("fdm smooth region defect should plan");
    assert!(format!("{planned:?}").contains("material_field_plans"));
}
```

- [ ] **Step 2: Run the FDM test and confirm failure**

Run:

```bash
cargo test -p fullmag-plan fdm_mesh_relative_region_ms_lowers_to_material_field_plan -- --nocapture
```

Expected: failure because current region constant overrides do not lower to a smooth sampled plan.

- [ ] **Step 3: Add a backend-neutral smooth transition sampler in `material.rs`**

Add helper math:

```rust
use fullmag_ir::MaterialTransitionScopeIR;

/// Signed distance convention: distance < 0 means inside the authored region,
/// distance > 0 means outside the authored region.
pub fn smooth_transition_weight(
    signed_distance: f64,
    width: f64,
    scope: MaterialTransitionScopeIR,
) -> f64 {
    if width <= 0.0 {
        return if signed_distance <= 0.0 { 1.0 } else { 0.0 };
    }
    let half = 0.5 * width;
    match scope {
        MaterialTransitionScopeIR::Boundary => {
            let t = ((half - signed_distance) / width).clamp(0.0, 1.0);
            smoothstep(t)
        }
        MaterialTransitionScopeIR::Inside => {
            if signed_distance >= 0.0 {
                0.0
            } else {
                let t = (-signed_distance / width).clamp(0.0, 1.0);
                smoothstep(t)
            }
        }
        MaterialTransitionScopeIR::Outside => {
            if signed_distance <= 0.0 {
                1.0
            } else {
                let t = (1.0 - signed_distance / width).clamp(0.0, 1.0);
                smoothstep(t)
            }
        }
    }
}

fn smoothstep(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}
```

This convention means:

- `scope=boundary`: the transition band is centered on the boundary and spans both sides,
- `scope=inside`: parent value is used outside; region value is reached after `width` inside,
- `scope=outside`: region value is full inside; parent value is reached after `width` outside.

and a width resolver:

```rust
pub fn fdm_transition_width_from_cells(cell_size: [f64; 3], cells: u32) -> f64 {
    let h = cell_size[0].min(cell_size[1]).min(cell_size[2]);
    h * cells as f64
}
```

- [ ] **Step 4: Lower region-local smooth defects into field plans in `fdm.rs`**

In the FDM planner path, when `resolved_region_transition(...)` is `SmoothMeshRelative` or `SmoothMetric`, build a `MaterialFieldPlan` instead of treating the constant as a regionwise sharp mask:

```rust
match resolved_transition_kind {
    ResolvedTransitionKind::SmoothMeshRelative { cells, scope } => {
        // sample signed distance from authored region shape on the FDM grid
        // compute width = cells * local cell size
        // then call smooth_transition_weight(distance, width, scope)
        // emit a cellwise MaterialFieldPlan for Ms/Aex
    }
    ResolvedTransitionKind::SmoothMetric { width, scope } => {
        // width comes from metric transition spec
        // then call smooth_transition_weight(distance, width, scope)
    }
    ResolvedTransitionKind::Sharp => {
        // existing sharp path
    }
    ResolvedTransitionKind::None => {}
}
```

If the region shape has no signed-distance evaluator, return the capability error from Task 4 instead of emitting a discontinuous field.

- [ ] **Step 5: Run the focused and broader FDM tests**

Run:

```bash
cargo test -p fullmag-plan fdm_mesh_relative_region_ms_lowers_to_material_field_plan -- --nocapture
cargo test -p fullmag-plan -- --nocapture
```

Expected: targeted test passes; broader suite stays green or exposes adjacent callers that still assume “constant region override == sharp”.

- [ ] **Step 6: Commit**

```bash
git add crates/fullmag-plan/src/material.rs crates/fullmag-plan/src/fdm.rs crates/fullmag-plan/src/tests.rs
git commit -m "feat: lower smooth region defects on fdm"
```

---

### Task 6: Realize smooth region defects on FEM with local `h`

**Files:**
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-plan/src/material.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`

- [ ] **Step 1: Write the failing FEM smooth-defect test**

Add a test that requires smooth region-local `Ms` to lower without a conformal marker:

```rust
#[test]
fn fem_mesh_relative_region_ms_lowers_to_continuous_field_without_conformal_marker() {
    let mut ir = default_test_problem_ir();
    let mut region = default_test_object_region();
    region.material_transition = Some(fullmag_ir::MaterialTransitionSpecIR::MeshRelative {
        cells: 3,
        scope: fullmag_ir::MaterialTransitionScopeIR::Boundary,
    });
    region.material_overrides.push(fullmag_ir::RegionMaterialOverrideIR {
        parameter: fullmag_ir::MaterialParameterNameIR::Ms,
        value: fullmag_ir::MaterialParameterFieldIR::Constant { value: 400e3.into(), unit: Some("A/m".to_string()) },
        priority: 0,
        conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
    });
    ir.object_regions.push(region);
    let planned = plan(&ir).expect("smooth region defect should not require conformal marker");
    assert!(format!("{planned:?}").contains("material_field_plans"));
}
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```bash
cargo test -p fullmag-plan fem_mesh_relative_region_ms_lowers_to_continuous_field_without_conformal_marker -- --nocapture
```

Expected: failure because current FEM path only knows sharp conformal/project treatment for constant region overrides.

- [ ] **Step 3: Add local `h` estimation helpers**

In `crates/fullmag-plan/src/material.rs` or `fem.rs`, add a helper for local mesh scale:

```rust
fn estimate_node_local_h(
    node_index: usize,
    adjacency: &[Vec<usize>],
    nodes: &[[f64; 3]],
) -> f64 {
    let mut best = f64::INFINITY;
    for &other in &adjacency[node_index] {
        let dx = nodes[node_index][0] - nodes[other][0];
        let dy = nodes[node_index][1] - nodes[other][1];
        let dz = nodes[node_index][2] - nodes[other][2];
        best = best.min((dx * dx + dy * dy + dz * dz).sqrt());
    }
    if best.is_finite() { best } else { 0.0 }
}
```

- [ ] **Step 4: Lower smooth region defects to continuous nodal/element fields**

In `gather_fem_material_field_plans(...)`, branch before the current sharp handling:

```rust
if matches!(resolved_transition_kind, ResolvedTransitionKind::SmoothMeshRelative { .. } | ResolvedTransitionKind::SmoothMetric { .. }) {
    // sample authored region signed distance at nodes/elements
    // width = cells * local h or explicit metric width
    // then call smooth_transition_weight(distance, width, scope)
    // build continuous nodal field plan
    continue;
}
```

If the region shape has no signed-distance evaluator, return the capability error from Task 4 instead of sampling a bounding box or creating a conformal marker implicitly.

Important rule for implementation:

```rust
// smooth region defect:
// - no conformal marker required
// - no duplicate interface nodes
// - no "sharp parameter override" planner error
// - one shared magnetization field remains
```

- [ ] **Step 5: Keep the existing sharp conformal path intact**

Do not delete or weaken:

```rust
build_conformal_region_element_fields(...)
```

The sharp path must remain for:

```rust
region.material_transition(kind="sharp")
```

and still use the current strict/extended gating.

- [ ] **Step 6: Run the focused and broader FEM tests**

Run:

```bash
cargo test -p fullmag-plan fem_mesh_relative_region_ms_lowers_to_continuous_field_without_conformal_marker -- --nocapture
cargo test -p fullmag-plan fem_sharp_aex_region_requires_conformal_in_strict -- --nocapture
cargo test -p fullmag-plan fem_sharp_aex_region_allows_projection_in_extended_with_warning -- --nocapture
```

Expected: smooth test passes; both sharp legacy tests still pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add crates/fullmag-plan/src/fem.rs crates/fullmag-plan/src/material.rs crates/fullmag-plan/src/tests.rs
git commit -m "feat: lower smooth region defects on fem"
```

---

### Task 7: Preserve round-trip, examples, and diagnostics

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `examples/permalloy_box_relax_300x1000x10nm.py`
- Modify: `examples/region_owned_gradient_ms.py`
- Modify: `packages/fullmag-py/tests/test_region_material_transition.py`
- Modify: `crates/fullmag-plan/src/tests.rs`

- [ ] **Step 1: Write the failing round-trip test**

Add a script-export test:

```python
def test_region_material_transition_round_trips_to_python_script():
    with TemporaryDirectory() as tmp_dir:
        script_path = Path(tmp_dir) / "region_transition.py"
        script_path.write_text(
            textwrap.dedent(
                """
                import fullmag as fm

                study = fm.study("region_transition")
                film = study.geometry(
                    fm.Box(size=(100e-9, 20e-9, 10e-9), name="body"),
                    name="body",
                )
                defect = film.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))
                defect.material_transition(cells=4, scope="inside")
                defect.material.Ms = 400e3
                study.exchange()
                """
            ).strip()
            + "\n",
            encoding="utf-8",
        )
        loaded = load_problem_from_script(script_path, lightweight_assets=True)
        script = rewrite_loaded_problem_script(loaded)["rendered_source"]

    assert 'defect.material_transition(cells=4, scope="inside")' in script
    assert 'defect.material.Ms = 400000.0' in script
```

The test file must import:

```python
import textwrap
from pathlib import Path
from tempfile import TemporaryDirectory

from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import rewrite_loaded_problem_script
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```bash
pytest packages/fullmag-py/tests/test_region_material_transition.py -q
```

Expected: exported script does not yet emit `material_transition(...)`.

- [ ] **Step 3: Extend script export**

In `packages/fullmag-py/src/fullmag/runtime/script_builder.py`, after region creation:

```python
if region.material_transition is not None:
    transition = region.material_transition
    if transition["kind"] == "mesh_relative":
        lines.append(f"{region_var}.material_transition(cells={int(transition['cells'])}, scope={_py_repr(str(transition.get('scope', 'boundary')))})")
    elif transition["kind"] == "metric":
        lines.append(f"{region_var}.material_transition(kind='metric', width={_py_number(float(transition['width']))}, scope={_py_repr(str(transition.get('scope', 'boundary')))})")
    elif transition["kind"] == "sharp":
        lines.append(f"{region_var}.material_transition(kind='sharp')")
```

- [ ] **Step 4: Refresh the example that motivated the feature**

Update `examples/permalloy_box_relax_300x1000x10nm.py` to use the new simple contract:

```python
hole_refinement = body.add_region(
    "hole_refinement",
    fm.Cylinder(radius=20e-9, height=10e-9),
    priority=10,
)
hole_refinement.mesh(minimum_element_size=0.5e-9, maximum_element_size=1e-9, order=1)
hole_refinement.material.Ms = 400e3
```

If the example wants an explicit non-default transition:

```python
hole_refinement.material_transition(cells=4, scope="inside")
```

- [ ] **Step 5: Add planner provenance text for resolved transition**

Add one human-readable note/warning in planner output or execution provenance for region-owned smooth fields:

```rust
"region 'body:defect' resolved to smooth mesh-relative material transition (cells=3)"
```

This is important so users can inspect what the planner actually did.

- [ ] **Step 6: Run end-to-end targeted verification**

Run:

```bash
pytest packages/fullmag-py/tests/test_region_material_transition.py -q
cargo test -p fullmag-plan -- --nocapture
just fullmag force=True static fem gpu /home/kkingstoun/git/fullmag/fullmag/examples/permalloy_box_relax_300x1000x10nm.py
```

Expected:

- Python tests pass,
- planner tests pass,
- the example no longer fails with the current strict sharp-conformal error when using the default smooth region transition.

- [ ] **Step 7: Commit**

```bash
git add packages/fullmag-py/src/fullmag/runtime/script_builder.py \
  examples/permalloy_box_relax_300x1000x10nm.py \
  examples/region_owned_gradient_ms.py \
  packages/fullmag-py/tests/test_region_material_transition.py \
  crates/fullmag-plan/src/tests.rs
git commit -m "feat: round-trip smooth region material transitions"
```

---

### Task 8: Preserve SceneDocument, OpenAPI, and Control Room authoring

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- Modify: `crates/fullmag-api/src/schemas/authoring.rs`
- Modify: `apps/control-room/src/modules/inspector/panels/region/ObjectRegionMaterialFieldsModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/region/ObjectRegionOverviewPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.ts`
- Test: `packages/fullmag-py/tests/test_region_material_transition.py`
- Test: `apps/control-room/src/modules/inspector/panels/region/ObjectRegionMaterialFieldsModel.test.ts`

- [ ] **Step 1: Write the failing SceneDocument round-trip test**

Extend the Python round-trip test so `material_transition` survives builder draft -> scene document -> builder draft:

```python
from fullmag.runtime.script_builder import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    export_builder_draft,
)


def test_region_material_transition_survives_scene_document_round_trip():
    with TemporaryDirectory() as tmp_dir:
        script_path = Path(tmp_dir) / "region_transition_scene.py"
        script_path.write_text(
            textwrap.dedent(
                """
                import fullmag as fm

                study = fm.study("region_transition_scene")
                film = study.geometry(
                    fm.Box(size=(100e-9, 20e-9, 10e-9), name="body"),
                    name="body",
                )
                defect = film.add_region("defect", fm.Cylinder(radius=10e-9, height=10e-9))
                defect.material_transition(kind="metric", width=2e-9, scope="outside")
                defect.material.Ms = 400e3
                study.exchange()
                """
            ).strip()
            + "\n",
            encoding="utf-8",
        )
        loaded = load_problem_from_script(script_path, lightweight_assets=True)
        draft = export_builder_draft(loaded)
        scene = build_scene_document_from_builder(draft)
        rebuilt = build_builder_from_scene_document(scene)

    transition = rebuilt["geometries"][0]["object_regions"][0]["material_transition"]
    assert transition == {"kind": "metric", "width": 2e-9, "scope": "outside"}
```

- [ ] **Step 2: Run the SceneDocument test and confirm failure**

Run:

```bash
pytest packages/fullmag-py/tests/test_region_material_transition.py -q
```

Expected: failure because SceneDocument does not yet preserve `material_transition`.

- [ ] **Step 3: Add `material_transition` to SceneDocument conversion**

In `packages/fullmag-py/src/fullmag/runtime/scene_document.py`, include `material_transition` in both directions wherever region payloads are copied:

```python
if region.get("material_transition") is not None:
    scene_region["material_transition"] = dict(region["material_transition"])
```

and:

```python
if scene_region.get("material_transition") is not None:
    builder_region["material_transition"] = dict(scene_region["material_transition"])
```

- [ ] **Step 4: Extend OpenAPI authoring schemas**

In `crates/fullmag-api/src/schemas/authoring.rs`, add typed schemas:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneMaterialTransition {
    MeshRelative { cells: u32, scope: SceneMaterialTransitionScope },
    Metric { width: f64, scope: SceneMaterialTransitionScope },
    Sharp,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneMaterialTransitionScope {
    Boundary,
    Inside,
    Outside,
}
```

Then add `material_transition: Option<SceneMaterialTransition>` to `SceneObjectRegion` and `SceneObjectRegionPatch`.

- [ ] **Step 5: Regenerate frontend API types**

Run the repo's existing OpenAPI/type-generation command. If no dedicated target is obvious, inspect `just --list` and the package scripts before adding any new command.

Expected: `apps/control-room/src/kernel/api/generated/openapi-v2-types` or the current generated type file reflects `material_transition`.

- [ ] **Step 6: Add minimal Control Room display/edit model coverage**

Add or extend a model test so region panels can read committed transition metadata:

```ts
expect(model.materialTransition).toEqual({
  kind: "mesh_relative",
  cells: 3,
  scope: "boundary",
});
```

For v1, the UI may display the resolved transition metadata without a full editor. It must not drop the field during patch/save.

- [ ] **Step 7: Run frontend validation**

Run:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test
```

Expected: generated types and region panels compile with the new optional field.

- [ ] **Step 8: Commit**

```bash
git add packages/fullmag-py/src/fullmag/runtime/scene_document.py \
  packages/fullmag-py/tests/test_region_material_transition.py \
  crates/fullmag-api/src/schemas/authoring.rs \
  apps/control-room/src/modules/inspector/panels/region/ObjectRegionMaterialFieldsModel.ts \
  apps/control-room/src/modules/inspector/panels/region/ObjectRegionOverviewPanel.tsx \
  apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.ts \
  apps/control-room/src/kernel/api/generated
git commit -m "feat: preserve material transitions in scene authoring"
```

---

## Self-Review Checklist

- Spec coverage:
  - Ergonomiczne `region.material.*` and `region.set_material_field(...)`: Task 2
  - `region.material_transition(cells=...)`: Tasks 2 and 3
  - Boundary anchoring (`boundary` / `inside` / `outside`): Tasks 1, 2, 3, 4, 5, 6, 7, 8
  - User choice of cells vs metric width: Tasks 1, 2, 3, 4, 5, 6, 7, 8
  - Domyślny `mesh_relative(cells=3)` for `Ms/Aex`: Tasks 2 and 4
  - FDM smooth realization: Task 5
  - FEM smooth realization with local `h`: Task 6
  - Sharp explicit fallback and existing conformal/project gates: Tasks 4 and 6
  - Script round-trip and example closure: Task 7
  - SceneDocument/OpenAPI/Control Room preservation: Task 8
- Placeholder scan:
  - No placeholder markers or deferred-action phrases remain.
- Type consistency:
  - Public Python name: `material_transition(...)`
  - Canonical IR name: `MaterialTransitionSpecIR`
  - Canonical scope enum: `MaterialTransitionScopeIR`
  - Planner helper: `resolved_region_transition(...)`
  - Transition kinds: `mesh_relative`, `metric`, `sharp`

---

## Risks to Watch During Execution

1. **Semantic drift between `material_overrides` and `material_parameter_fields`:**  
   v1 should keep region ergonomics simple without forcing a full unification refactor. Do not widen scope unless tests prove the duplication is blocking correctness.

2. **Over-eager smoothing on parameters that should stay sharp:**  
   This plan intentionally defaults `Ms/Aex` to smooth region transitions. Do not silently broaden that default to every material parameter without physics review.

3. **FEM local `h` estimation instability:**  
   Start with the simplest stable estimator (nearest neighbor edge length / node adjacency minimum). Do not over-design adaptive width estimation in v1.

4. **Breaking existing strict sharp tests:**  
   The old conformal/project tests must remain green. Smooth-default support is an addition, not a replacement for the explicit sharp path.

5. **Unsupported signed-distance shapes:**  
   Production v1 may support only analytic `box`, `cylinder`, and `sphere` distance evaluators. Unsupported `csg`/imported shapes must capability-block smooth transitions until a robust evaluator exists.

---

## Execution Handoff

Plan complete and saved to `docs/plans/active/region-material-transition-mesh-relative-implementation-plan-2026-06-08-pl.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
