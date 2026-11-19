---
title: Set up and inspect absorbing boundaries
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/absorbing-boundary-layer.md
---

(public-docs-frontend-absorbing-boundaries)=
# Set up and inspect absorbing boundaries

A spin wave reaching the end of a finite magnetic strip can reflect back into the measurement region. An absorbing boundary layer (ABL) raises the dimensionless Gilbert damping $\alpha$ over a chosen part of the magnet. You can taper the two ends independently, place a band inside the film, or restrict a curved absorber to a material region.

## Create a layer in Control Room

1. Click the magnetic film in the **3D Viewport** in object-selection mode, or select the magnetic object in **Model Explorer**. If clicking the film inspects a cell or node, switch off **Inspect values** in the viewport toolbar and select the film again. Open the **Physics** ribbon and choose **Add ABL**. On an object without an absorber this creates a layer and opens its **Absorbing Boundary** inspector. On an already configured object the same button opens the existing absorber. Use **Add layer** in the inspector to create another. You can also enable **Absorbing Boundary** under the object's **Magnetic Parameters** and choose **Apply**.
2. Give the layer a name. Select **Object faces** as its **Geometry** and choose a single face, for example **x+**. Set **Frame** to **Object coordinates** to follow the magnet when it moves.
3. Set **Total width** to `4e-8` m (40 nm), **Ramp width** to `2e-8` m (20 nm), **Maximum damping** to `0.5` and **Profile** to `logarithmic`. Choose **Apply**. With material damping 0.01, the plateau reaches 0.51.
4. For different settings at the other end, choose **Duplicate layer**, give the copy a distinct name, change its face to **x−**, choose `tanh`, and apply. Selecting two faces on the same layer gives both faces that layer's settings. **Layer enabled** lets you compare an individual layer with its contribution switched off.

```{figure} /_static/images/ui/abl-ribbon.png
:alt: Physics ribbon and the newly created Absorbing Boundary child and inspector for the selected FDM film
:width: 100%

After **Add ABL**, the object owns a new layer. Its name, enabled state and target can be edited in the inspector.
```

## Display the effective damping

1. For FDM, choose **Mesh → Build Grid** and confirm **Build Grid & Materialize Masks**. For FEM, use **Mesh → Build All** to build the shared solver mesh. The **Geometry → Build Mesh** action targets the selected object. Wait for the grid or solver mesh to finish. The material field needs a built discretization.
2. Open the object's **Visualization** entry. Select **Shaded** to activate the surface controls, then open **Quantity source** and select **Material α** (Gilbert damping). You can inspect it before pressing **Compute**. After applying a layer edit, inspect the updated band on the same mesh.

```{figure} /_static/images/ui/abl-quantity.png
:alt: Object Visualization inspector with Shaded mode active and material alpha as the quantity source
:width: 100%

The Visualization inspector selects the plotted material field. Its value includes the local base damping and the enabled absorbers.
```

```{figure} /_static/images/ui/abl-baseline.png
:alt: FDM strip with a uniform single-colour surface before enabling any absorbing layer
:width: 70%

Uniform baseline on the FDM grid. One colour covers the magnetic cells.
```

```{figure} /_static/images/ui/abl-two-planes.png
:alt: The same FDM strip now has two spatially separated damping bands with different intensities
:width: 70%

Two free planes on the same strip. The band near the end and the band inside the strip have independent amplitudes. The colours show the spatial distribution in each view. Use numeric field values when comparing amplitudes across views.
```

## Choose a width and a profile

Measure the inward distance $d$ from the chosen face or surface, in metres. Let $W$ be **Total width**, $L$ be **Ramp width**, and $A$ be **Maximum damping**. Set $0<L\le W$ and $A\ge0$. Inside the band ($0\le d\le W$), the ramp coordinate is $u=\min(1,(W-d)/L)$. The first $W-L$ metres next to the boundary form a plateau at $A$. Setting $W=L$ gives a pure ramp. Outside the band the contribution is zero.

| Profile in Python | Weight $p(u)$ | Shape |
|---|---|---|
| `linear` | $u$ | Constant slope |
| `quadratic` | $u^2$ | Gentle start at the interior edge |
| `smootherstep` (default) | $6u^5-15u^4+10u^3$ | Zero first and second derivatives at both ends |
| `logarithmic` | $\ln(1+9u)/\ln(10)$ | Faster initial rise |
| `tanh` | $(1+\tanh(4u-2)/\tanh(2))/2$ | Sigmoidal transition |
| `custom` | For example $u^3$ | Enter `u**3` in **Expression** |

At a point shared by multiple enabled layers, the effective value is the **local material damping plus the largest layer contribution**, $\alpha_{\mathrm{eff}}=\alpha_{\mathrm{base}}+\max_i A_i p_i(u_i)$. A face shared at a corner follows the same maximum rule. A region with its own base damping keeps that local base.

A custom profile uses dimensionless `u` and returns a dimensionless weight. The supported operators are `+`, `-`, `*`, `/` and `**`. Functions include `sqrt`, `exp`, `log`, `log1p`, `abs`, `sin`, `cos` and `tanh`. The expression must be finite, stay in $[0,1]$, and satisfy $p(0)=0$, $p(1)=1$ within $10^{-12}$. Validation checks 257 evenly spaced points and the planner checks each evaluated sample. Choose a smooth, monotonic formula when that is the intended taper.

## Run a strip example in Python

This complete study has two end absorbers. Set `distribution = "uniform"` to load the same strip with constant damping and the same grid. Set it to `"plane"` for a cubic taper ending on a free plane *inside* the strip. Each choice leaves a stage ready for inspection before solving.

```python
# %% Strip and magnetic material
import fullmag as fm

nm = 1e-9
distribution = "ends"  # "uniform", "ends" or "plane"
study = fm.study("strip_damping")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.cell(2 * nm, 2 * nm, 4 * nm)
film = study.geometry(fm.Box(200 * nm, 100 * nm, 8 * nm), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.m = fm.texture.uniform(1, 0, 0)

# %% Independent distances, widths and peak contributions
if distribution == "ends":
    film.alpha.absorbing_boundary(layers=[
        fm.SpatialAbsorbingLayer(
            layer_id="left", name="Left end",
            geometry=fm.AbsorbingGeometry.faces(("x-",)),
            total_width_m=25 * nm, ramp_width_m=20 * nm,
            max_damping=0.3, profile="tanh",
        ),
        fm.SpatialAbsorbingLayer(
            layer_id="right", name="Right end",
            geometry=fm.AbsorbingGeometry.faces(("x+",)),
            total_width_m=40 * nm, ramp_width_m=24 * nm,
            max_damping=0.6, profile="logarithmic",
        ),
    ])
elif distribution == "plane":
    film.alpha.absorbing_boundary(layers=[
        fm.SpatialAbsorbingLayer(
            layer_id="interior", name="Interior plane",
            geometry=fm.AbsorbingGeometry.plane(
                origin=(40 * nm, 0, 0), normal=(1, 0, 0),
            ),
            total_width_m=30 * nm, ramp_width_m=20 * nm,
            max_damping=0.4, profile="custom", expression="u**3",
        ),
    ])
elif distribution != "uniform":
    raise ValueError(f"Unknown distribution: {distribution}")

# %% Inspect before Compute
study.exchange()
study.demag(enabled=False)
study.stages.add_run(stage_id="run", until=1e-12)
study.wait_for_solve(True)
```

For `ends` the left plateau is 5 nm wide at $\alpha=0.31$ and the right plateau is 16 nm wide at $\alpha=0.61$. For `plane` the normal points toward increasing $x$. The damped band lies between $x=10$ and $40$ nm in the object frame, with a 10 nm plateau adjacent to the plane. **Reverse normal** puts the band on the other side.

## Restrict a curved layer to a region

In the FEM example below, the cylinder's axis runs through the film thickness. Its radius sets the *outer* edge of the band. Its **Target material** is the upper-half region. To reproduce the field in Control Room, load the complete example below and select **Upper semicircle** in the **Layer** list. To author the ring from scratch, start with just the film, its **Upper half** region and the two strip terminations from the example (omit the layer named `Upper semicircle` when loading it), then follow these steps.

1. Select the film, choose **Physics → Add ABL**, then **Add layer**. Set **Layer name** to `Upper semicircle` and **Target material** to **Upper half**.
2. Choose **Geometry → Cylinder** and set **Frame → Object coordinates**. Set the **Center** components to `(8e-9, 0, 0)` m, **Axis** to `(0, 0, 1)`, and **Boundary radius** to `35e-9` m. Choose **Damping increases → Outward toward the radius**.
3. Set **Total width** to `15e-9` m, **Ramp width** to `12e-9` m and **Maximum damping** to `0.45`. Choose `custom` under **Profile**, enter `u**3` in **Expression**, and choose **Apply**.
4. In **Material α**, inspect the upper half near the outer rim. With the 0.01 base, the analytic plateau there is 0.46. The other half of the same circle retains 0.01 away from the end layers. Mesh samples show the values at their actual positions.

The resulting half-ring extends from radius 20 to 35 nm, measured from $(8,0,0)$ nm, with a 3 nm plateau. Two face layers terminate the strip separately.

```{figure} /_static/images/ui/abl-semicircle.png
:alt: FEM field showing two end absorbers and a semicircular band with Upper semicircle selected and Upper half as its target
:width: 100%

The centre of the film retains its base damping. The region clips the circular band at the midline.
```

```{literalinclude} ../../../../examples/fem_spatial_absorbing_layers.py
:language: python
```

To follow the actual surface of the region, change the ring's `geometry` to `fm.AbsorbingGeometry.region_boundary(upper_half.region_id)`. This measures distance inward from the whole metric boundary of the region. On a thin box the top and bottom also contribute, so a cylindrical band is the appropriate choice for a rim in the film plane. Keep the layer's separate `region_id` when its contribution must be clipped to that region. For the same semicircle with your own coordinate formula, select **Geometry → Distance expression** on **Upper semicircle** and enter `35e-9 - sqrt((x-8e-9)**2 + y**2)` in **Distance d(x,y,z)**. Keep **Target material → Upper half**, the widths and the cubic profile, then choose **Apply**. At $(43,0,0)$ nm the expression gives zero (the rim). At $(28,0,0)$ nm it gives 15 nm (the interior edge). Outside the circle it is negative.

To run this variant in Python, replace the cylinder assignment in the full example above with the following geometry and keep the other layer arguments:

```text
geometry=fm.AbsorbingGeometry.expression("35e-9 - sqrt((x-8e-9)**2 + y**2)"),
```

The distance expression uses spatial coordinates `x`, `y` and `z` in metres and returns a signed distance in metres. The separate profile `expression="u**3"` uses dimensionless `u` and sets the shape of the ramp. A general implicit function gives a geometrical band of the stated width only where its values measure physical distance.

## Frames, export and reflection checks

**Object coordinates** (`frame="object"`) is the default. Positions use axis-aligned object coordinates with its translation removed. Face bounds come from the active magnetic cell centres in FDM and the magnetic nodes of the entire object in FEM. Holes and padding have no magnetic damping contribution. **World coordinates** (`frame="universe"`) uses the explicit study box for face bounds and world coordinates for placement. With an automatic universe, face bounds fall back to the sampled object bounds. A region used as a mask is evaluated in its own frame.

In Python, `film.alpha` sets the base and `film.alpha.absorbing_boundary(layers=[...])` records layer settings. **Apply** commits inspector edits to the scene. Synchronizing the model to Python exports the editable layer collection with layer IDs, region references, geometry, widths in metres and profile parameters. A single faces configuration may use the shorter `film.alpha.absorbing_boundary(total_width=..., ramp_width=..., ...)` form. Reload the exported script and compare the selected object, layer targets and **Material α** field. See the {doc}`/python-api/magnets-and-textures/ferromagnet` reference for the owning magnet record.

The rendered field checks placement and amplitude. To measure wave absorption, launch a wave packet and compare incident and reflected probe windows against the same geometry with uniform damping. Check the mesh resolution across the ramp and repeat for the required solver and device. The images above show FDM and FEM material fields. They establish no reflection coefficient or FEM CPU/GPU parity. See the [reflection benchmark](https://github.com/MateuszZelent/fullmag/tree/71974540caabd305716d6e86ccc668b97cd8281b/tests/standard_problems/absorbing_boundary) and the [physics and implementation reference](https://github.com/MateuszZelent/fullmag/blob/71974540caabd305716d6e86ccc668b97cd8281b/docs/physics/absorbing-boundary-layer.md).
