# ADR 0027 — Canonical FEM mesh policy and quality evidence

**Status:** accepted for implementation

**Date:** 2026-08-27

**Decision makers:** Fullmag core

## Context

Fullmag has working FEM mesh controls, shared-domain tetrahedral generation,
bounded mixed-P1 topology, mesh reports, and an active FMMQ v1 data
path. Their public meanings are nevertheless spread across Python compatibility
aliases, Gmsh field composition, build reports, certificates, API projections,
and Control Room assumptions. A value displayed as a target or quality metric
must have one definition, one unit, one sampling rule, and one failure rule.

The protected product invariant is the three-layer FEM mesh doctrine:

1. study-level universe mesh policy;
2. independent per-object and per-region mesh policy;
3. one realized conforming shared-domain solver mesh.

Requested intent and resolved realization remain separate. Visibility,
selection, isolation, and rendering-derived triangulation never change solver
topology or mesh policy.

(canonical-fem-mesh-policy)=
## Decision

### One canonical policy vocabulary

Canonical public size controls are SI-valued
`maximum_element_size`, `minimum_element_size`,
`maximum_element_growth_rate`, `curvature_factor`, and
`narrow_region_resolution`. Compatibility aliases may be read during the
migration window, but writers emit only the canonical names.

The policy resolves named zones before it builds mesher fields: magnetic bulk,
material/interface, object surface shell, object edge, object corner,
transition air, far air, boundary layer, and swept through-thickness layer.
Every constraint carries its owner, zone, source parameter, requested value,
resolved value, SI unit, and realization status. Airbox lower bounds are not
eligible inside magnetic or interface zones and therefore cannot coarsen an
object boundary.

At a physical point $\mathbf x$, the target size is exactly

```text
h_target(x) = Max(Min(eligible upper constraints at x),
                  Max(eligible lower constraints at x)).
```

An empty upper set has value $+\infty$ and an empty lower set has value $0$.
The result must then be finite and positive wherever a mesh is generated. A
same-zone lower bound above the selected upper bound is a conflict and fails
before Gmsh; cross-zone policy is resolved by eligibility, not by a global
`CharacteristicLengthMin` accident. The global Gmsh clamp is only an
implementation envelope wide enough to realize the scoped policy.

Curvature is an independent upper-constraint source. When and only when the
resolved policy enables it, sampled local radius $R(\mathbf x)$ contributes
`curvature_factor * R(x)` to the upper set. Missing or zero curvature on a flat
entity contributes no curvature constraint. Curvature never mutates the
authored maximum, minimum, growth, edge, corner, or airbox values.

Growth is a relation between adjacent realized cells in the same resolved
growth graph, not a replacement for a maximum size. The report records each
adjacent-cell ratio and the source policy. Topology policy records canonical
cell/facet types and forbids hidden conversion in strict mode.

### Exact layers are not a structured in-plane mesh

`exact_layers=L` means exactly $L$ three-dimensional cell layers and $L+1$
node planes along the resolved sweep direction, within the documented plane
tolerance. It does not promise a Cartesian, tensor-product, mapped, or otherwise
structured in-plane mesh. A triangular source face extruded through exact
layers produces prisms whose in-plane triangulation may remain unstructured.
Structured in-plane intent requires its own future public topology contract and
cannot be inferred from `swept`, `prismatic`, `fixed`, or `exact_layers`.

### Quality evidence is metric- and topology-specific

Every metric record carries a stable metric ID and version, SI unit, topology
family, element identity, sampling points/order, aggregation scope, tolerance,
producer, topology fingerprint, and pass/fail reason. The normative metric and
sampling table lives in
`docs/physics/0105-fem-meshing-production-acceptance.md`.

Negative sampled Jacobians, non-finite values, identity/count mismatch,
unsupported metric/topology combinations, and missing required samples fail
closed. A proxy must use a distinct metric ID and must not be labeled SICN,
gamma, or volume. A histogram or percentile never replaces the per-element
gate that produced it.

(fmmq-v2-contract)=
### FMMQ v2 and v1 compatibility exit

FMMQ v2 is the canonical per-element quality carrier for typed FEM topology.
It binds the payload to the topology fingerprint and revision; identifies each
array by metric ID/version, cell family, SI unit, sampling rule, and exact
global element ordinal; uses explicit section offsets/counts and binary64
values; and rejects unknown required sections, duplicate identities,
non-finite values, count mismatches, and trailing bytes. A mixed payload may
contain separate arrays for `tet4`, `prism6`, `pyramid5`, and `hex8`; consumers
must never apply a tetrahedron metric to another family.

Current FMMQ v1 is an active writer/reader format. Its header records only the
element count and SICN/gamma/volume flags; it carries no cell-family,
topology-fingerprint, mesh-revision, metric-version, sampling, or global-ordinal
identity. The writer can therefore emit arrays for a mixed mesh when arrays are
present, and the transport readers can decode them, but such a payload cannot
qualify mixed topology. The separate Control Room topology guard may decline to
render non-tet4 data; that guard is not a property of the v1 byte format.

FMMQ v1 is not upgraded in place. The v1 reader may be removed only after all
of these criteria hold:

1. every v1 writer has been cut off and every supported writer emits v2;
2. API range delivery, generated clients, Control Room decoding, quality
   mapping, cross-section selection, and persisted-session loading accept v2;
3. a tested migration or read path exists for retained v1 tet4 artifacts;
4. unknown-version, tamper, stale-revision, metric/topology, ordinal, and
   malformed-section tests pass across producer and consumers;
5. two consecutive releases record no production dependence on a v1 writer or
   v1-only consumer; and
6. removal is announced in compatibility documentation.

The current repository has FMMQ v1 writers and readers only; FMMQ v2 is a
planned contract. Mixed quality currently remains in certificate/report JSON.
Neither a mixed v1 payload nor that JSON may be described as FMMQ v2 evidence.

(fem-mesh-v04-cutover)=
### One atomic ProblemIR V04 cutover

Mesh policy moves with the compositional `objects[]` model in the single V04
writer cutover governed by ADR 0024. Python authoring, SceneDocument, typed
Rust V04, normalization, planner ingestion, API resources, UI editing, and
canonical Python export switch together. Until that gate is green, v0.3
remains the only public writer and V04 reader/migrator work remains gated.

There is no period with two editable canonical mesh models, no background
dual-write, and no merge of divergent v0.3/V04 mesh policies. Legacy input is
migrated once to V04, validated, and thereafter edited and exported from the
V04 object identity. Rollback restores the previous single writer before any
V04 artifact is declared canonical; it never writes both models.

## Consequences

- Universe, object, region, interface, and realized shared-domain meanings stay
  distinct and auditable.
- Gmsh field ordering cannot silently define product semantics.
- Exact layers and in-plane structure stop being conflated.
- Quality claims become comparable across API, artifacts, and Control Room.
- FMMQ v2 requires coordinated producer/consumer work and cannot be advertised
  from the current v1 codec.
- This decision does not change FEM runtime selection or the calibrated
  crossover policy in the other ADR 0021.

## Implementation obligations

1. Keep canonical policy validation in Python, ProblemIR, and planner aligned;
   emit requested and resolved policy separately.
2. Lower the exact size algebra and zone eligibility into one deterministic
   field plan; report every selected, clipped, unavailable, degraded, and
   rejected source.
3. Bind topology, exact-layer, growth, and quality evidence to immutable mesh
   identity.
4. Implement FMMQ v2 producer, API, codecs, generated types, and UI consumers
   before promoting mixed quality visualization.
5. Add golden V04 migration and round-trip tests before the one writer cutover.
6. Preserve the bounded topology decision of
   `docs/adr/0021-native-mixed-p1-fem-topology.md`; this ADR supplies its common
   policy and evidence envelope, not a wider executable lane.

## Migration and rollback

The implementation sequence may be staged behind non-writing feature gates,
but there is one externally visible V04 writer cutover. FMMQ v2 is additive:
writers change to v2 only after all current consumers decode it; readers retain
v1 under the exit criteria above. A rollback disables the new writer/codec and
continues to read retained v1 artifacts. It must not reinterpret v2 mixed
quality as v1 or discard requested mesh intent.

## Tests and validation

- Python/IR golden tests for every canonical parameter, alias migration, zone,
  conflict, exact-layer request, and requested/resolved record;
- field-plan tests for the exact upper/lower algebra and curvature independence;
- realized topology, sweep, adjacency-growth, Jacobian, quality, histogram,
  provenance, and failure-semantic tests from note 0105;
- FMMQ v2 byte-layout, range, identity, topology-family, tamper, stale revision,
  non-finite, unknown-version, and v1 compatibility tests;
- V04 whole-document migration and Python/UI round-trip tests proving one
  canonical writer and no parallel editable model;
- managed FEM CPU/GPU and browser evidence only for lanes whose production
  status is being promoted.

## References

- `docs/physics/0100-mesh-and-region-discretization.md`
- `docs/physics/0105-fem-meshing-production-acceptance.md`
- `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`
- `docs/adr/0021-native-mixed-p1-fem-topology.md`
- `docs/adr/0024-compositional-physics-object-model.md`
