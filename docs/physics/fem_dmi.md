# FEM Dzyaloshinskii-Moriya Interaction

- Status: native FEM CPU module contract, MFEM execution path requires runtime validation
- Last updated: 2026-05-16
- Implementation: `native/backends/fem/cpu/mfem/interactions/dmi.hpp/.cpp`
- Test: `native/backends/fem/tests/dmi_contract.cpp`
- Residual helpers: `native/backends/fem/src/dmi_weak_residual.cpp`

## Pole

The native FEM CPU DMI module owns interfacial and bulk DMI for the MFEM bridge.
Both variants assemble a weak residual over MFEM elements and recover an
observable `H_DMI` field in `A/m` with lumped-mass projection. The ordinary LLG
RHS converts this field to `dm/dt`; this module does not apply gamma, damping,
or direct-torque scaling.

For interfacial DMI the implemented energy density is:

```text
e_iDMI = D [(m.n) div(m) - (m.grad)(m.n)]
```

For bulk DMI the implemented energy density is:

```text
e_bulk = D m . curl(m)
```

## Energia

The module integrates the same quadrature expression used by the element loop
and returns energy in joules when requested by the caller. Field recovery uses:

```text
H_DMI = project_lumped(residual, Ms)
```

where `Ms` can be the scalar material fallback or a per-node `Ms_field`.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| interfacial DMI coefficient | `D_i` | current executable contract |
| bulk DMI coefficient | `D_b` | current executable contract |
| interface normal | `n` | unit vector |
| saturation magnetization | `Ms` | `A/m` |
| DMI field | `H_DMI` | `A/m` |
| DMI energy | `E_DMI` | `J` |

The audit reports still flag the public-unit boundary as unresolved:
interfacial `J/m^2` must not be silently mixed with an effective volumetric
operator unless the thickness/surface policy is explicit.

## Warunki brzegowe

The executable path is a weak-residual formulation. Natural boundary terms are
part of the variational residual rather than a post-hoc strong-form nodal
average. Production qualification still needs explicit edge and boundary
fixtures, especially for interfacial DMI boundary tilt.

## Dyskretyzacja FEM

The MFEM path unpacks AoS magnetization to component grid functions, loops over
magnetic elements and quadrature points, assembles interfacial or bulk DMI
residuals, projects the residual with lumped mass and `Ms`, and lets the bridge
apply any periodic output projection and energy aggregation.

Bulk DMI projects periodic input magnetization before assembly. The bridge
still owns higher-level orchestration; the element-loop workspace and
residual/projection sequence are owned by `dmi.*`.

## Ograniczenia capability

- Active DMI requires `FULLMAG_HAS_MFEM_STACK`.
- Local non-MFEM builds verify disabled behavior and explicit environment
  errors, but do not compile the MFEM element-loop branch.
- Interfacial and bulk DMI are separate entry points, but still share one
  internal workspace type.
- Public unit semantics for interfacial thin-film DMI remain release-blocking
  before a production label.
- GPU parity is not claimed by this module.

## Testy

Current gate:

- `fem_dmi_contract` checks that disabled interfacial and bulk DMI return zero
  field/energy and that active DMI reports a clear MFEM-stack requirement in a
  non-MFEM build.

Required before production qualification:

- directional derivative check against `dE = -mu0 integral Ms H_DMI . delta_m`;
- domain-wall handedness for interfacial DMI;
- spiral-pitch fixture for bulk DMI;
- boundary-tilt fixture;
- normal-rotation symmetry for `dmi_n_hat`;
- explicit public-unit/thickness policy test;
- MFEM-stack compile and runtime fixture with full MFEM headers.
