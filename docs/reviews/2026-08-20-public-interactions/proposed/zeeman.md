---
title: Zeeman interaction — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
target: public_docs/site/physics/interactions/zeeman/index.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Zeeman interaction

## Audit verdict

| Area | Verdict |
|---|---|
| B-versus-H convention | Correct and unusually explicit. |
| Energy and effective field | Correct for `Zeeman(B)` with `B` supplied in tesla. |
| Backend description | Broadly complete, but too much implementation detail is duplicated on the root page. |
| Python example | Uses the stage-first builder and the public `study.b_ext` surface. |
| Completeness | Needs analytic expected values, time/spatial field ownership boundaries, and a single initializer convention. |

No physics correction is required for the uniform static field. The principal improvement is to
make the simple public contract prominent and move backend internals to method/source pages.

## Required corrections

1. State at the beginning of both physics and Python API pages that the constructor value is
   magnetic flux density `B_ext` in tesla, not `H_ext` in A/m.
2. Use one canonical magnetization initializer in all interaction examples. Mixing
   `fm.texture.uniform(...)` and legacy `fm.init.UniformMagnetization(...)` obscures the public API.
3. Add an explicit expected energy and resolved-field value to the minimal example.
4. Keep uniform static Zeeman, regional field drives, RF antennas, tabulated waveforms, and solved
   Oersted fields as separate public contracts. Do not gradually overload `Zeeman(B)`.
5. Replace large hand-maintained IR excerpts with serializer-generated fragments tested against
   the live schema.

## Proposed canonical physical content

`fullmag.Zeeman(B)` supplies a uniform prescribed magnetic flux density
`B_ext = (B_x, B_y, B_z)` in tesla. The backend resolves

```math
H_ext = \frac{B_ext}{\mu_0}.
```

The energy is

```math
E_Z[m]
= -\mu_0\int_{\Omega_m} M_s\,m\cdot H_ext\,dV
= -\int_{\Omega_m} M_s\,m\cdot B_ext\,dV.
```

The functional derivative gives

```math
H_Z = -\frac{1}{\mu_0 M_s}\frac{\delta E_Z}{\delta m}
    = H_ext.
```

For a uniform material and magnetization in a body of volume `V`,

```math
E_Z = -M_s V\,m\cdot B_ext.
```

This scalar macrospin result should be shown directly in the user documentation because it gives
an immediate unit and sign check.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `B_ext` | authored external magnetic flux density | T |
| `H_ext` | resolved external magnetic field | A/m |
| `M`, `Ms` | magnetization and saturation magnetization | A/m |
| `m` | reduced magnetization | 1 |
| `mu0` | vacuum permeability | N/A^2 |
| `E_Z` | Zeeman energy | J |
| `V` | magnetic volume | m^3 |

## Sign and ownership convention

- Positive `B_z` lowers the energy of `m_z > 0` and raises the energy of `m_z < 0`.
- Reversing `B_ext` reverses `H_ext` and the conservative torque.
- `Zeeman` does not solve Maxwell equations and does not depend on electric-current closure.
- A spatial or time-dependent prescribed field requires a distinct source object with explicit
  interpolation, support, frame, and sampling semantics.
- `H_ext`, `E_ext`, and `eden_ext` are optional observables; the interaction does not silently
  enable output storage.

## Capability matrix

| Solver | Device | Recommended status | Evidence required |
|---|---|---|---|
| FDM | CPU | `reference_executable` or stronger | exact B-to-H conversion, masking, energy integration |
| FDM | GPU | `production_executable` | FP32/FP64 executed-device field and energy parity |
| FEM | CPU | `production_executable` | nodal field, material weighting, quadrature/reduction |
| FEM | GPU | `production_executable` | device-resident field and energy reduction evidence |

Because the field is local, unsupported status should normally reflect integration/output/runtime
limitations rather than the algebra itself.

## Stage-first example with expected values

```python
# %% Uniform 0.1 T field
import fullmag as fm

nm = 1.0e-9
study = fm.study("zeeman_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))

film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.b_ext(0.0, 0.0, 0.1)  # tesla
study.solver(integrator="rk45", fix_dt=1.0e-15, gamma=2.211e5)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

The documentation test should assert that the authored field remains `(0, 0, 0.1)` T in requested
intent and resolves to approximately

```math
H_z = \frac{0.1}{\mu_0} \approx 7.957747\times 10^4\;\mathrm{A/m}.
```

It should not replace the serialized tesla value with the backend A/m value during round-trip.

## Required validation suite

1. **Conversion:** compare each component with `B_i / mu0`.
2. **Macrospin energy:** verify `E_Z = -Ms V m·B` for parallel, antiparallel, and orthogonal states.
3. **Directional derivative:** compare the energy finite difference with field work.
4. **Sign reversal:** `B -> -B` must reverse the field and swap parallel/antiparallel energies.
5. **Rotation covariance:** rotate geometry-independent state and field together.
6. **Precession:** in a field-only, zero-damping macrospin, recover the declared gyromagnetic
   precession frequency for the exact gamma convention used by the integrator.
7. **CPU/GPU:** compare resolved field and energy separately from the time integrator.
8. **Round-trip:** preserve tesla-valued requested intent through script and scene export.

## Recommended extensions

- introduce a dedicated typed `PrescribedField` source for regional and time-dependent drives;
- expose coordinate-frame ownership for imported or rotating field data;
- add field-map artifact checksums and interpolation provenance;
- publish Kittel/macrospin tutorial pages without overloading the uniform Zeeman constructor.

## Bibliography

- W. F. Brown Jr., *Micromagnetics*, Wiley, 1963.
- A. Aharoni, *Introduction to the Theory of Ferromagnetism*, 2nd ed., Oxford University Press,
  2000.
