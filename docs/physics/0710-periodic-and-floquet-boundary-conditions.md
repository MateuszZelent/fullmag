# Periodic and Floquet Boundary Conditions

## Convention

Fullmag uses SI units and stores Bloch wavevectors in `rad_per_m`.

For static periodic fields and zero-phase dynamic studies, paired boundary
nodes satisfy:

```text
m_dst = m_src
```

For frequency-domain Floquet studies, the dynamic perturbation satisfies:

```text
delta_m_dst = delta_m_src * exp(-i k dot delta_r)
delta_r = r_dst - r_src
```

The canonical phase convention identifier is:

```text
exp_minus_i_k_dot_delta_r
```

## Capability Policy

If a mesh declares `periodic_node_pairs` and the selected backend does not
enforce them in the active operator, the planner or runtime must reject the
study. A warning is not sufficient because it would produce physically invalid
results.

FEM static and time-domain paths currently reject periodic meshes unless a
future solver path explicitly enforces the static reduction map. FEM eigen
supports periodic and Floquet phase reduction for exchange, anisotropy,
external field, and DMI terms.

Dynamic demagnetization for nonzero-k Floquet FEM is not implemented. Requests
with `include_demag=true` and `spin_wave_bc.kind='floquet'` must fail with a
capability error.

FDM uses axis-wise periodicity. The CPU reference path supports periodic
exchange/DMI stencils and truncated-image periodic demagnetization. The CUDA FDM
path supports periodic exchange/DMI wrapping and consumes the same
truncated-image Newell spectra for periodic demag; the native backend receives
explicit FFT dimensions because periodic axes use `N` instead of `2N`.

## Mesh Metadata

`periodic_boundary_pairs.translation` is the authoritative source-to-destination
translation. If it is present, node pairs must satisfy:

```text
r_dst - r_src ~= translation
```

within the pair tolerance. Duplicate source or destination node mappings for the
same `pair_id` are invalid.

Runtime artifacts expose the validated pair metadata as:

```text
mesh/periodic_pairs.v1.json
```

The v2 browser/API resource for the same contract is:

```text
/v2/sessions/current/meshing/mesh/periodic_pairs.v1
```

The payload uses `schema_version = "periodic_pairs.v1"` and includes each
`pair_id`, source/destination markers, expected translation, paired node count,
unpaired source/destination counts, residual diagnostics, and a validation
status. The API prefers the active FEM mesh snapshot and falls back to the
artifact file after a completed run.

## Sign Test

For exchange-only dispersion without DMI or other nonreciprocal terms:

```text
f(k) = f(-k)
```

For `k = pi / L` and `delta_r = [L, 0, 0]`, the Floquet phase is:

```text
exp(-i pi) = -1
```
