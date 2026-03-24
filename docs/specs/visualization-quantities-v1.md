# Visualization Quantities v1

- Status: stable cross-cutting spec
- Parent architecture: `docs/specs/fullmag-application-architecture-v2.md`

## 1. Purpose

This specification defines how Fullmag exposes simulation quantities to the browser control room.

The key rule is:

> The visualization layer must be quantity-driven, not hardcoded to one field.

This is required to achieve the intended amumax-style workflow:

- one simulation run,
- one main visualization surface,
- many selectable physical quantities,
- with the available set growing as the solver implements more terms.

## 2. Scope

This spec covers:

- quantity identity,
- quantity metadata,
- quantity categories,
- frontend selector semantics,
- API/control-plane representation,
- short-term artifact adaptation.

This spec does **not** define:

- the physical equations themselves,
- how a given quantity is numerically computed,
- the low-level storage layout of `.zarr` / `.h5`,
- backend-specific kernel interfaces.

Those belong elsewhere.

## 3. Core rule

The control room must not be built around a single hardcoded field like `m`.

Instead, every run exposes a **quantity registry**:

```text
run/session -> quantity registry -> selected quantity -> 2D view / 3D view / scalar traces
```

The quantity registry is the canonical bridge between:

- implemented solver outputs,
- artifact storage,
- live session updates,
- browser visualization controls.

## 4. Quantity classes

Each quantity belongs to one of these kinds:

- `vector_field`
- `scalar_field`
- `tensor_field`
- `energy_density`
- `global_scalar`

### Examples

#### Vector fields

- `m`
- `H_ex`
- later:
  - `H_demag`
  - `H_dmi`
  - `H_ani`
  - `H_zee`
  - `H_eff_total`
  - `dm_dt`

#### Scalar fields

- later local scalar observables per cell/node/element

#### Energy densities

- later `e_ex_density`
- later `e_demag_density`
- later `e_dmi_density`

#### Global scalars

- `E_ex`
- later `E_demag`
- later `E_dmi`
- later `E_total`

## 5. Quantity metadata

Every visualization quantity must carry metadata with this logical shape:

```text
id
label
kind
unit
location
components
derivations
availability
status
```

### 5.1 Required fields

- `id`
  - stable machine identifier
  - example: `m`, `H_ex`, `E_ex`

- `label`
  - user-facing display name
  - example: `Magnetization`, `Exchange Field`, `Exchange Energy`

- `kind`
  - one of the classes from section 4

- `unit`
  - SI unit string or `dimensionless`

- `location`
  - where the quantity lives numerically:
  - `cell`
  - `node`
  - `element`
  - `global`

- `availability`
  - `live`
  - `artifact_only`
  - `planned`

- `status`
  - aligned with product capability vocabulary

### 5.2 Component metadata

Vector and tensor quantities must declare component semantics.

For a vector quantity the default component set is:

- `x`
- `y`
- `z`
- `magnitude`

For magnetization-style fields the UI may later add domain-specific derived views, but those are not
part of the v1 required contract.

## 6. UI selector model

The control room must expose three related selectors:

1. **quantity**
   - example: `m`, `H_ex`, later `H_demag`

2. **representation**
   - 2D
   - 3D
   - scalar trace

3. **component / derived view**
   - example:
     - `x`
     - `y`
     - `z`
     - `magnitude`

### Important rule

If a quantity is not available for a given run, the browser must not synthesize it.

The browser only renders quantities present in the run/session quantity registry.

## 7. Phase-1 minimum quantity registry

For the current executable exchange-only baseline, the minimum quantity registry is:

- `m`
  - kind: `vector_field`
  - unit: `dimensionless`
  - location: `cell`
  - availability: `live` + `artifact_only`

- `H_ex`
  - kind: `vector_field`
  - unit: `A/m`
  - location: `cell`
  - availability: `artifact_only` in the bootstrap shell

- `E_ex`
  - kind: `global_scalar`
  - unit: `J`
  - location: `global`
  - availability: `live` + `artifact_only`

This is enough to structure the viewer correctly from the start.

## 8. Growth rule as solver terms are implemented

Each new solver contribution must extend the quantity registry at the same time it becomes
executable.

Examples:

### When `Demag` becomes executable

Add:

- `H_demag`
- `E_demag`

### When `DMI` becomes executable

Add:

- `H_dmi`
- `E_dmi`

### When full effective field reporting becomes executable

Add:

- `H_eff_total`

### When torque reporting becomes executable

Add:

- `dm_dt`

## 9. API contract

The session/run API must expose the quantity registry explicitly.

At minimum, each run/session state payload should carry:

```text
quantities: [
  {
    id,
    label,
    kind,
    unit,
    location,
    availability,
    components
  },
  ...
]
```

The browser must use this registry to populate selectors.

## 10. Artifact adapter rule

Artifact files do not need to be the same as the browser quantity model.

The adapter layer is responsible for translating:

```text
JSON / CSV / later Zarr / HDF5 -> quantity registry + quantity payloads
```

That means:

- artifacts remain backend-owned,
- the quantity registry remains control-plane-owned,
- the browser remains quantity-driven.

## 11. FDM and FEM compatibility

The same quantity model must work for both FDM and FEM.

What changes is the numerical location:

- FDM often uses `cell`
- FEM may use `node` or `element`

The selector model must not assume a Cartesian grid forever.
It must assume only:

- quantity identity,
- quantity kind,
- quantity location,
- renderer compatibility.

## 12. Acceptance criteria

This spec is satisfied when:

1. the control room is no longer hardcoded to `m`,
2. the UI uses a real quantity selector,
3. Phase-1 at least exposes `m`, `H_ex`, and `E_ex`,
4. adding a new solver term naturally adds new selectable quantities,
5. the same quantity model can later support both FDM and FEM.
