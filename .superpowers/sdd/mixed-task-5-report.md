# Slice 5 report: conforming shared-domain prism/pyramid/tet airbox

Status: **DONE_WITH_CONCERNS**

Base revision: `8a91bb9871ee6b09dbd18f403df16ea4b8caf74c`

No files were staged or committed.

## Delivered scope

This slice adds the strict Gmsh 4.15.2 production meshing path for one centered,
axis-aligned magnetic `Box` inside a rectangular volumetric airbox:

- a triangular magnetic source face is extruded into native `prism6` cells with
  the exact requested fixed layer count;
- the magnetic boundary is reused as the inner boundary of a shared GEO
  transition volume; there is no OCC fragment and no duplicated interface;
- a dedicated near-air transition shell owns `pyramid5` at magnetic quad faces
  and may also contain `tet4`;
- a separate far-air GEO volume contains only `tet4` and receives the airbox
  grading field;
- the transition-shell/far-air interface is required to be exclusively `tri3`;
- no prism, pyramid, or quad compatibility splitting is used;
- the asset pipeline selects `single_geometry_geo_mixed` for an explicitly
  requested swept-prism Box and preserves the accepted certificate through
  classification and IR/artifact lowering;
- unsupported sphere/PBC requests fail before Gmsh, and the path is version
  gated to Gmsh 4.15.2 with one deterministic meshing thread and no fallback.

## Root cause and design evidence

The frozen feasibility fixture proves that Gmsh 4.15.2 can mesh a shared GEO
magnet/air topology as `prism6 + pyramid5 + tet4`. The first production attempt
used one air volume for both the quad transition and far-field grading. It was
topologically face-conforming but failed exact volume balance:

- cell volumes: `prism6=1.600000000000e-18 m3`,
  `pyramid5=1.301561536618e-19 m3`,
  `tet4=1.999662475504e-16 m3`;
- cell total: `2.016964037040e-16 m3` versus rectangular CAD volume
  `2.016000000000e-16 m3`, relative error `+4.78193e-4`;
- SciPy convex-hull volume per cell and Gmsh
  `getElementQualities(tags, "volume")` reproduced the same total, excluding
  the Fullmag pyramid integration rule as the cause;
- divergence theorem over the 908 exterior triangles produced
  `2.0159999999999984e-16 m3`, relative error `-7.8e-16`, proving the exterior
  box was exact;
- 28 internal tet/tet faces had both owner centroids on the same side of the
  shared face, proving an overlapping Delaunay partition in the air volume;
- default and Netgen optimization did not alter the error;
  `UntangleMeshGeometry` rejected the hybrid prism mesh.

The fix is a dedicated transition shell. Its deterministic thickness is derived
from requested mesh sizes and available clearance, not a magic constant:

```text
shell_thickness = min(max(h_inner, hmax), 0.5 * minimum_air_clearance)
```

The shell realizes the size transition from `h_inner` to `hmax`. Its outer
triangular surface and the far-air grading field begin at
`max(h_inner, hmax)`. Restricting the grading field to the separate far-air
volume prevents it from perturbing the magnetic quad transition.

For the representative Z/layers=1 case (`4 x 2 x 0.2 um` magnet,
`8 x 6 x 4.2 um` airbox, `hmax=0.8 um`, `h_inner=0.4 um`,
`h_outer=1.2 um`, growth `1.3`), accepted evidence is:

- magnetic: `55 prism6`;
- transition air: `19 pyramid5 + 818 tet4`;
- far air: `2075 tet4`;
- transition-shell outer interface: `352 tri3`;
- explicit material interface marker 10: `19 quad4 + 110 tri3`;
- explicit true outer boundary marker 99: `908 tri3`;
- magnetic relative volume error: `1.565e-15`;
- shared-domain relative volume error: `3.668e-16`;
- recomputable `tetra_decomposition_scaled_jacobian.v1` p05: prism `0.6709`,
  pyramid `0.1259`, tet `0.2534`;
- topology fingerprint:
  `sha256:f9059cb14863c7da1238c0e8daa617d35a7afb54100dc7cfe818d9cdf794cb33`.

## Certificate semantics

`mixed_layer_topology_certificate.v1` is distinct from the body-only
`MeshRealizationReport`. It is constructed only after strict validation and
contains:

- requested/resolved sweep axis and exact requested/realized layer count;
- magnetic plane coordinates and clustering tolerance;
- deterministic transition-shell thickness and shell-interface `tri3` count;
- canonical per-cell `cell_mesh_parts` identity plus derived family counts per
  physical marker and actual GEO part (`magnetic`, `transition_air`, `far_air`);
- facet-family counts per role/marker;
- family Jacobian minima and recomputable tetra-decomposition scaled-Jacobian
  minimum/p05; no durable Gmsh SICN evidence is claimed;
- magnetic, air, and shared-domain volumes plus relative errors bounded by
  `1e-8`;
- marker coverage and zero orphan, nonconforming, non-manifold, and coincident
  interface counts;
- topology fingerprint v2 (including mesh-part identity), exact Gmsh version,
  exact strategy, effective one-thread count, deterministic inputs, explicit
  interface/outer markers, accepted status, and `fallbacks_triggered=[]`.

Runtime/load validation recomputes cell/part/marker legality, counts, plane
coordinates, volumes, Jacobians, scaled quality, shell thickness/interface,
and exhaustive face adjacency. Every two-owner different-material face must
have exactly one explicit material-interface facet with marker 10; every
one-owner face must have exactly one explicit exterior facet with the configured
outer marker. Same-material shell/far faces are not material interfaces. The
certificate survives JSON and NPZ persistence, `oriented_copy`, asset
classification, `to_ir`, and uniform scaling (with rebuilt evidence and
fingerprint); anisotropic scaling fails closed.

## Review remediation wave

The post-implementation review identified two critical and three important
gaps. All five were addressed in one TDD wave:

1. Added canonical persisted `cell_mesh_parts`, strict wire types, exact
   version/strategy constants, recomputation of all durable numeric evidence,
   and JSON/NPZ tamper rejection for volume, Jacobian, scaled quality, shell
   count, version, strategy, and part identity.
2. Made material-interface/exterior completeness exhaustive and marker-aware,
   added explicit markers to the certificate, and reject marker collision
   before importing Gmsh.
3. Uniform scaling rebuilds the certificate; anisotropic scaling of certified
   mixed topology is rejected.
4. Asset routing is now restricted to the exact qualified subset. Multiple or
   non-Box geometry, object/conformal regions, per-object/per-geometry/local
   sizing, boundary layers, optimizer, algorithm changes, order changes,
   non-fixed distribution, non-triangular sweep face, recombine, and PBC all
   fail before any mesh generator.
5. The qualified strategy forces one effective Gmsh thread even when both
   thread environment variables are `8`, without changing general Gmsh thread
   override semantics.

## Final review remediation wave

A final review found five remaining durability gaps. The final TDD wave added
13 focused regressions (initial result: `12 failed, 1 passed`) and repaired all
five:

1. The certificate now stores authored CAD truth explicitly as strict
   `magnetic_bounds_min_m`, `magnetic_bounds_max_m`, `airbox_bounds_min_m`, and
   `airbox_bounds_max_m` triples. Expected volumes come only from these authored
   references. Realized mesh bounds and integrated volumes are recomputed and
   compared to them at construction and load with a `1e-8` relative bound.
   Passing 10x fake authored body/airbox bounds or tampering persisted JSON/NPZ
   authored bounds is rejected.
2. Certified scaling uses exact identity and exact uniform-component tests.
   `[1.0, 1.000001, 1.0]` is anisotropic and rejected. Uniform scaling scales
   the authored bounds first, then rebuilds and revalidates all realized
   evidence; authored truth is never reconstructed from the scaled mesh.
3. Pyramid-base ownership is a durable invariant, not attach-only validation.
   Every `pyramid5` base must be present in the exact set of `quad4`, marker 10,
   `material_interface` facets during construction and load. A fingerprint-
   resigned local-connectivity tamper is rejected by this invariant before
   stale numeric evidence checks.
4. Nested wire maps require actual dictionaries, string outer/inner keys, true
   integer counts (never bool), and exact float metric values. Lists of pairs,
   integer keys, and boolean counts are rejected before normalization.
5. The durable quality identity is now the exact versioned name
   `tetra_decomposition_scaled_jacobian.v1`; the generic `scaled_jacobian`
   label is rejected.

## RED evidence

The real Gmsh RED tests were added before the production implementation:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_mixed_element_meshing.py \
  -k 'shared_domain_box or shared_domain_topology_fingerprint or mixed_layer_topology_certificate' \
  -vv
```

Initial result: `12 selected; 11 failed, 1 passed`. The production generator
rejected every volumetric-airbox request with
`body-only swept prism meshing does not yet support an airbox`; the one passing
case was the pre-existing fail-closed PBC rejection.

## Files changed

- `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`
  - shared GEO box/shell construction, far-air-only grading, Gmsh family/quality
    evidence, exact volume/Jacobian/conformity checks, certificate attachment.
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
  - strict shared-domain Box dispatch, exact extrusion, Gmsh version gate,
    physical extraction, shell/part evidence capture.
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py`
  - certified scaling rebuild/fail-closed behavior and qualified-route thread
    isolation without changing global environment override precedence.
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
  - typed certificate, fingerprint v2, serialization, stale-certificate
    rejection, typed adjacency/count helpers, owned-path propagation.
- `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
  - mixed-GEO asset routing, typed-cell bounds/node summaries, certificate
    preservation, no tet-only cleanup for accepted mixed topology.
- `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`
  - recognizes the strict mixed-GEO build mode as the resolved swept method.
- `packages/fullmag-py/tests/test_mixed_element_meshing.py`
  - real Gmsh layers/axis/partition/shell/marker/fingerprint/persistence/tamper
    tests and asset-pipeline integration.
- `packages/fullmag-py/tests/test_meshing.py`
  - updates the contradictory ArchWaveguide explicit-swept test to the approved
    non-Box fail-closed contract; independent ArchWaveguide paths remain.
- `packages/fullmag-py/tests/test_api.py`
  - mechanical migration of seven stale legacy fixtures to
    `MeshData.from_legacy_tet4`, required by the authoritative API gate.
- `scripts/verify_fem_meshing_production.py`
  - includes the real mixed shared-domain test subset in the production gate.

## GREEN evidence

```bash
TMPDIR=/tmp/fem-mixed-slice5-final \
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q --tb=short \
  packages/fullmag-py/tests/test_mixed_element_meshing.py
```

Fresh final result after the final review wave: `146 passed in 71.93s`, exit 0.
Interpreter:
`/usr/bin/python3` 3.10.12; Gmsh:
`/home/kkingstoun/.local/lib/python3.10/site-packages/gmsh.py` 4.15.2.

```bash
TMPDIR=/tmp/fem-mixed-slice5-final \
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q --tb=short \
  packages/fullmag-py/tests/test_api.py
```

Result after the final review wave: `263 passed, 39 warnings in 22.99s`, exit 0.

The exact previously failing API node also passes independently:

```text
ProblemApiTests::test_fem_backend_derives_mesh_hints_from_fdm_cell_when_missing
1 passed
```

Focused remediation results:

- certificate/persistence/tamper first critical: `19 passed`;
- interface completeness/marker collision: `4 passed`;
- scaling: `2 passed`;
- exact asset routing rejection matrix: `14 passed`;
- thread environment isolation: `1 passed`;
- global environment precedence plus qualified isolation: `2 passed`.
- final authored-CAD/scale/pyramid/wire/quality wave: `13 passed`;
- final durable-interface regression subset after helper propagation: `3 passed`.

Static checks:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m compileall -q \
  packages/fullmag-py/src/fullmag/meshing \
  scripts/verify_fem_meshing_production.py
git diff --check
```

Both passed. `ruff` is not installed in this worktree, so no ruff result is
claimed.

## Authoritative gate and concerns

The authoritative command was run twice:

```bash
just verify-fem-meshing-production
```

Final result: exit 1, with the verifier reporting:

```text
production_evidence_manifest: failed
python_meshing_tests: failed
python_api_mesh_tests: passed
python_mixed_shared_domain_meshing_tests: passed
arch_waveguide_materialization_budget: failed
```

These failures are separated as follows:

1. `python_meshing_tests` has one remaining baseline failure, independently
   reproduced in Slice 4 and again here:
   `FieldStackAcceptanceTests::test_periodic_antidot_frozen_magnetic_submesh_stays_stable_across_airbox_z_padding`.
   The unrelated frozen-air STL path reaches `_derive_facet_roles` with marker
   10 adjacency `[0, 0]`. This slice does not change `_gmsh_extraction.py`, and
   no unrelated relaxation was made. Fresh fail-fast result here was
   `221 passed, 1 skipped, 1 failed in 151.94s`; focused remediation-induced
   thread precedence coverage is green `2 passed`.
2. The external production evidence manifest is absent at
   `.fullmag/reports/fem-meshing-production/evidence.v1.json`.
3. The arch-waveguide budget helper cannot run because the managed local Python
   runtime is absent at `.fullmag/local/python/bin/python`.
4. Because the verifier returns nonzero and the shell script uses `set -e`, the
   downstream Rust API test and frontend generate/lint/typecheck/test phases
   were not reached. No claim is made for those phases.

The implemented meshing slice itself and its newly authoritative mixed check
are green. The overall status remains `DONE_WITH_CONCERNS`, not `DONE`, because
the full repository production gate is not green for the explicitly recorded
baseline/external reasons above.

## Current limitations

- one axis-aligned `Box` only;
- P1 only;
- fixed through-thickness distribution only;
- rectangular bbox airbox only;
- no PBC;
- Gmsh 4.15.2 Delaunay hybrid realization only;
- no object regions, local/per-object sizing, boundary layers, optimizer,
  algorithm override, recombination, or alternate sweep distribution on the
  qualified mixed route;
- this is meshing proof only and does not advertise native FEM solver or
  CPU/GPU physics qualification.

## Final NPZ certificate strictness remediation

The mixed-layer certificate NPZ loader now applies the same top-level shape
contract as the JSON loader: after JSON decoding, the value must be an actual
object (`dict`) or `null`. It no longer coerces a top-level list of key/value
pairs with `dict(raw_certificate)`. The adjacent historical
`realization_report_json` NPZ path was inspected and deliberately left
unchanged because this remediation is scoped to the new mixed certificate.

TDD evidence:

```text
test_npz_load_rejects_top_level_certificate_list_of_pairs
RED: 1 failed, DID NOT RAISE TypeError
GREEN: 1 passed in 1.33s
```

The full final-review focused subset, including the new NPZ regression, passed:

```text
14 passed, 133 deselected in 17.91s
```

The final `compileall` and `git diff --check` reruns both exited 0. The staged
file list was empty. Per review direction, the broad production gate was not
rerun; its previously recorded external/baseline concerns remain unchanged.
