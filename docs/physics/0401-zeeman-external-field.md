# Zeeman external field

- Status: implementation-aligned reference note
- Owners: FullMag physics and backend team
- Last updated: 2026-07-30
- Related ADRs: none
- Related specs: `public_docs/site/physics/interactions/zeeman/index.md`

## 1. Problem statement

The Zeeman interaction represents a prescribed external magnetic flux density that couples
locally to the magnetization. The public Python contract accepts one uniform vector
`Zeeman(B)` in tesla. The planner converts that requested quantity to the resolved magnetic
field `H_ext = B / mu0` in A/m. No backend may silently reinterpret `B` as an H-field.

This note is the internal scientific source of truth. Publication documentation is kept under
`public_docs/site/`; it is derived from this note but has its own user-facing structure and
source maps.

## 2. Physical model

For reduced magnetization `m = M/Ms` in the magnetic domain, the uniform-field energy is

\[
E_Z[\mathbf m] = -\mu_0 \int_{\Omega_m} M_s(\mathbf x)\,
\mathbf m(\mathbf x)\cdot\mathbf H_{\mathrm{ext}}\,\mathrm dV
                 = -\int_{\Omega_m} M_s(\mathbf x)\,
\mathbf m(\mathbf x)\cdot\mathbf B_{\mathrm{ext}}\,\mathrm dV.
\]

The corresponding effective field is

\[
\mathbf H_Z = -\frac{1}{\mu_0 M_s}\frac{\delta E_Z}{\delta\mathbf m}
             = \mathbf H_{\mathrm{ext}}
             = \frac{\mathbf B_{\mathrm{ext}}}{\mu_0}.
\]

The current public constructor is uniform and time independent. Regional and time-dependent
field drives are separate field-drive contracts; they must not be documented as extra
parameters of `Zeeman(B)`.

## 3. Numerical interpretation

### FDM

The planner stores the resolved vector in A/m. The CPU reference expands it to active cells,
adds it to the effective field, and computes the cell energy density with the cell volume.
Inactive cells receive zero external field. The CUDA lane consumes the same resolved field in
the device field and energy paths; this is a separate implementation lane and requires executed
device qualification before it can be called qualified.

### FEM

The FEM planner imports the resolved A/m vector into the Zeeman aggregate. CPU initialization
broadcasts it to a nodal `h_ext_xyz` buffer. The CPU field stage adds that buffer to `H_eff`;
the energy stage uses lumped nodal mass or the saturation-weighted element-quadrature material
path when a spatial `Ms` field is active. The GPU lane uploads the field and material arrays,
adds it during the device RK stage, and reduces the energy on the device.

### Hybrid

There is no hybrid physical definition. A hybrid execution may combine backend realizations,
but its provenance must retain the requested B vector, resolved H vector, backend lane, precision,
and output legality decision.

## 4. API, IR, and planner impact

`Zeeman(B)` validates a finite length-three vector and lowers to an `EnergyTermIR::Zeeman` with
the serialized key `B`. FDM and FEM planning each reject duplicate Zeeman terms, convert each
component by the same `MU0`, and store the result in the native plan as `external_field` in A/m.
`H_ext`, `E_ext`, and `eden_ext` are legal only when a Zeeman source is active.

## 5. Validation strategy

- Verify exact Python validation and `{"kind":"zeeman","B":[...]}` lowering.
- Verify planner conversion against `MU0` in both FDM and FEM paths.
- Verify duplicate-term rejection and fail-closed output validation.
- Compare FDM CPU and qualified CUDA field/energy values for a uniform magnetization.
- Compare FEM CPU lumped/quadrature energy with the device reduction within declared tolerances.
- Verify that inactive FDM cells and non-magnetic FEM nodes do not contribute.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [x] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [ ] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

The public uniform `Zeeman` term does not expose a spatial field, waveform, antenna mask,
regional drive, or solver tolerance. Those belong to separate field-source contracts. CUDA
implementation evidence exists in source, but production qualification remains dependent on
executed-device and parity evidence for the current revision.

## 8. References

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- FullMag Python implementation: `packages/fullmag-py/src/fullmag/model/energy.py`.
- FullMag planner and backend sources listed in the publication source index.
