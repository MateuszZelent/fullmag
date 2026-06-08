# Region-owned authoring

This guide describes how to choose between object regions, separate magnetic
objects, material parameter fields, mesh policies, and explicit couplings.

The canonical physics contract is
`docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`.
The examples in `examples/` are executable authoring references.

## Core rule

An authored object region is a subobject owned by one magnetic object. It does
not create a second magnetization field and it does not create inter-object
exchange by itself.

Use an object region when the thing you want to scope belongs to one continuous
magnetic object:

- local mesh refinement,
- local initial texture,
- a local material override inside the same object,
- the support of a material parameter field such as `Ms(x)` or `Aex(x)`.

Use a separate object when the thing is physically a separate magnetic body:

- a distinct layer,
- a body that may have free-surface exchange relative to another body,
- an object that needs explicit object-object or surface-surface coupling.

Use a coupling when two independently authored endpoints should exchange across
an interface. Two objects do not get exchange coupling by default.

## Mesh Refinement

A region mesh policy changes local discretization without changing material
identity. The parent object still owns the magnetization field.

See `examples/skyrmion_core_mesh_refinement.py`:

- the film is one physical object,
- `skyrmion_core` is a cylindrical authored region,
- the parent film keeps its bulk mesh policy,
- the core region requests a smaller local element size.

Airbox mesh controls remain separate from magnetic object regions. The airbox is
a demag/mesh domain, not a magnetic material region, and cannot own `m`, `Ms`,
`Aex`, anisotropy, DMI, or texture.

## Material Fields

Smooth or sampled parameter variation should be authored as a material parameter
field, not as many artificial regions.

See `examples/region_owned_gradient_ms.py`:

- the track is one physical object,
- the authored region scopes the support of an `Ms` field,
- no second magnetic object is created,
- no coupling is needed.

Sharp jumps are allowed as authored intent, but realization depends on backend
capabilities. FEM strict mode requires a conformal boundary/domain marker for a
sharp material jump. Extended projection mode is an approximation and must be
reported in provenance and diagnostics.

Material overrides and fields must keep active magnetic `Ms` positive. Use
geometry or active masks for voids, not `Ms = 0`.

When region material fields or overrides overlap, priority decides which local
authoring rule wins. Equal priority for the same material parameter is an error,
not an implicit merge.

## Couplings

Use explicit couplings for physics between distinct objects or surfaces.

See `examples/two_object_couplings.py`:

- `free_layer` and `reference_layer` are two physical objects,
- object-object exchange is declared explicitly,
- surface-surface RKKY intent is declared explicitly.

Important defaults:

- intra-object region-region exchange uses the same continuous object field and
  the harmonic mean of `Aex` unless explicitly overridden,
- inter-object exchange is absent unless declared,
- `scale=0` or disabled exchange means free-surface exchange across that
  authored interface,
- unsupported RKKY blocks planning/runtime start instead of degrading into
  volumetric exchange.

## Control Room

In the Control Room, authored regions and realized mesh/material regions are
different resources:

- authored regions are user intent under the owning object,
- realized regions are mesh/materialization output,
- diagnostics explain when authored intent is blocked, projected, or pending,
- script export should preserve stable `region_id` values.

Do not use region list order as a persistent identifier. Use `region_id`.
