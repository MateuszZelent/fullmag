# Initial Magnetization Policy v0

- Status: accepted
- Last updated: 2026-03-23
- Parent spec: `docs/specs/exchange-only-full-solver-architecture-v1.md`
- Related physics note: `docs/physics/0200-llg-exchange-reference-engine.md`

---

## 1. Purpose

This document freezes the supported initial magnetization kinds for the exchange-only release.
A uniform `m0` alone is not enough for a meaningful exchange-only solver — the effective field
is identically zero for a uniform state. Richer initializations are required to exercise the
exchange operator.

## 2. Supported initialization kinds

### 2.1 `uniform(vector)`

**Status**: implemented (Python + Rust IR).

Sets every cell/node to the same unit vector.

| Parameter | Type | Unit | Constraints |
|-----------|------|------|-------------|
| `direction` | `(f64, f64, f64)` | dimensionless | non-zero; normalized at lowering time |

Python API: `fm.init.uniform(direction=(1, 0, 0))`

IR variant:
```rust
InitialMagnetizationIR::Uniform { value: [f64; 3] }
```

### 2.2 `random(seed)`

**Status**: new — to be implemented in Phase 1.

Generates random unit vectors at every cell/node, deterministically from a seed.
Essential for reproducible relaxation studies in exchange-only mode.

| Parameter | Type | Unit | Constraints |
|-----------|------|------|-------------|
| `seed` | `u64` | — | > 0 |

Python API: `fm.init.random(seed=42)`

IR variant:
```rust
InitialMagnetizationIR::RandomSeeded { seed: u64 }
```

### Sampling contract

- The random generator is backend-owned.
- The seed guarantees identical magnetization for the same grid/mesh and seed.
- Different grid/mesh sizes with the same seed may produce different patterns — the seed
  does not define a spatial function, only a deterministic per-cell sequence.

### 2.3 `from_function(fn, sample_points)`

**Status**: deferred to Phase 2 (requires grid knowledge at lowering time).

Evaluates a Python callable at physical coordinates during lowering, producing a sampled field.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `fn` | `Callable[[float, float, float], tuple[float, float, float]]` | must return unit vectors |
| `sample_points` | backend-provided | injected by planner during lowering |

Python API: `fm.init.from_function(fn)` — **stub only in Phase 1**.

IR variant:
```rust
InitialMagnetizationIR::SampledField { values: Vec<[f64; 3]> }
```

### Sampling contract

- The callable is evaluated at cell centers (FDM) or node positions (FEM) during lowering.
- The callable never runs inside the hot loop — sampling happens once before time integration.
- The resulting `SampledField` IR stores the sampled values; the callable itself is not serialized.

### 2.4 Deferred

- Vortex initializer (parametric vortex core).
- File-loaded magnetization (checkpointed state).
- Domain-wall profiles (parametric).

## 3. Normalization policy

All initial magnetization vectors must be unit vectors ($|\mathbf{m}| = 1$) at the start of
time integration.

- `uniform`: the direction vector is normalized during `to_ir()` serialization.
- `random`: each generated vector is normalized per-cell by the backend.
- `sampled_field`: all values must satisfy $|v| \approx 1$. The validator rejects fields
  where any vector deviates more than $10^{-6}$ from unit length.

## 4. Validation rules

| Kind | Rule |
|------|------|
| `Uniform` | `value` must be non-zero |
| `RandomSeeded` | `seed` must be > 0 |
| `SampledField` | `values` must be non-empty; all vectors must be unit (tolerance $10^{-6}$) |
| All | `initial_magnetization` field on `MagnetIR` is required (not `Option`) for exchange-only runs |

## 5. IR representation

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InitialMagnetizationIR {
    Uniform { value: [f64; 3] },
    RandomSeeded { seed: u64 },
    SampledField { values: Vec<[f64; 3]> },
}
```

All three variants are legal in `ProblemIR`. `SampledField` is the IR-level output of
`from_function()` after lowering; a Python-authored problem would never write `SampledField`
directly — the planner fills it.
