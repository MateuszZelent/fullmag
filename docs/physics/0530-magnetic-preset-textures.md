# 0530 — Magnetic Preset Textures (Authoring -> FEM/FDM Sampling)

## Scope
- Defines `InitialMagnetizationIR::PresetTexture` as an analytic volumetric vector field.
- Covers deterministic sampling to solver points for both FEM nodes and FDM cell centers.

## Coordinate Pipeline
For each sample point:
1. Select source space:
   - `mapping.space = "object"` -> use object-local coordinates,
   - otherwise use world coordinates.
2. Apply projection (`planar_xy`, `planar_xz`, `planar_yz`, otherwise identity).
3. Apply inverse texture transform:
   - `p' = inv(translate ∘ rotate ∘ scale around pivot)(p)`.
4. Apply clamp mode:
   - `clamp`, `repeat|wrap`, `mirror`.
5. Evaluate preset function `m = f(p', params)`.
6. Normalize output vector.

## Presets (v1)
- `uniform`
- `random_seeded`
- `vortex`
- `antivortex`
- `bloch_skyrmion`
- `neel_skyrmion`
- `domain_wall`
- `two_domain`
- `helical`
- `conical`

## Skyrmion Preset Equations
For `bloch_skyrmion` and `neel_skyrmion`, evaluate in the selected plane-local
basis `(e_u, e_v, e_n)`. Let

- `u, v` be the in-plane coordinates,
- `rho = sqrt(u^2 + v^2)`,
- `phi = atan2(v, u)`,
- `theta(rho) = 2 atan(exp((radius - rho) / wall_width))`.

The magnetization is:

```text
m = sin(theta) * (cos(psi) e_u + sin(psi) e_v)
  + core_polarity * cos(theta) e_n
```

The existing public `core_polarity` convention is retained: with this profile,
the far field tends to `core_polarity * e_n` and the center tends to
`-core_polarity * e_n`.

Chirality changes the helicity of the in-plane component. It must not multiply
`phi`, because multiplying `phi` changes the winding number and turns the
texture into a mirrored or antiskyrmion-like field.

For `chirality >= 0`:

```text
neel_skyrmion:  psi = phi
bloch_skyrmion: psi = phi + pi/2
```

For `chirality < 0`:

```text
neel_skyrmion:  psi = phi + pi
bloch_skyrmion: psi = phi - pi/2
```

In the `xy` plane this means, at `rho = radius`:

- Bloch `chirality=+1`: `x+ -> y+`, `y+ -> x-`;
- Bloch `chirality=-1`: `x+ -> y-`, `y+ -> x+`;
- Neel `chirality=+1`: radially outward;
- Neel `chirality=-1`: radially inward.

## FEM/FDM Contract
- Planner performs sampling during lowering (`preset_texture` is executable directly).
- Runtime receives explicit vectors (`Vec<[f64; 3]>`) as initial state.
- No UV mapping is required; this is volumetric sampling on physical coordinates.

## Safety / Validation
- All outputs must be finite and normalized.
- Missing required preset params fail planning.
- Inactive points (FDM mask) are forced to `[0,0,0]`.
- Skyrmion regression tests must cover cardinal in-plane wall directions for
  both Bloch and Neel chirality, and must prove that chirality flips helicity
  without flipping the azimuthal winding.
