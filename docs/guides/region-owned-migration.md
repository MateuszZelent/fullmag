# Region-owned migration note

This note summarizes how older region-shaped payloads map to the region-owned
authoring model.

## Legacy Concepts

Older scenes may contain:

- `RegionIR { name, geometry }`,
- `SceneObject.region_name`,
- `SceneObject.region_overrides`,
- legacy `model/regions` views.

These remain compatibility inputs. They are not the canonical authored-region
model for new scenes.

## Current Model

New authored intent should use:

- object-owned `SceneObject.regions`,
- stable object-region `region_id` values,
- material parameter fields for `Ms(x)`, `Aex(x)`, `alpha(x)`, and similar
  coefficient variation,
- explicit couplings for object-object or surface-surface interface physics,
- separate authored and realized region resources in the Control Room API.

## Migration Rules

When reading old scenes:

- `SceneObject.region_name` becomes a compatibility body-region label,
- no authored child region is created unless the old payload carries real
  region authoring intent such as a shape,
- `region_overrides` that only carry magnetization references remain
  compatibility overrides until the scene is saved through the new model,
- first save as scene v2 should write explicit authored object regions only for
  real region authoring,
- exported Python should prefer `object.add_region(...)`, `set_material_field`,
  and `study.couplings` over legacy region payloads.

## Removal Criteria

Compatibility paths can be removed only after:

- examples export authored regions through `object.add_region(...)`,
- the Control Room no longer depends on legacy `region_overrides`,
- planner tests distinguish legacy body regions from authored object regions,
- OpenAPI docs name authored and realized region resources separately,
- the migration test suite covers scene v1 inputs.

