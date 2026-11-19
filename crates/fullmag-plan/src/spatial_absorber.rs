use super::universe_bounds;
use crate::selection::geometry::{AffineTransform3, BoundaryMembership, GeometryPredicate};
use fullmag_ir::{
    AbsorbingBoundaryCoordinate, AbsorbingBoundaryDirectionIR, AbsorbingBoundaryFaceIR,
    AbsorbingBoundaryFrameIR, AbsorbingBoundaryIR, GeometryEntryIR, ObjectRegionIR, ProblemIR,
    RegionFrameIR, RegionShapeIR, ResolvedAbsorbingBoundaryProfile, SpatialAbsorbingGeometryIR,
    SpatialAbsorbingLayerIR,
};

fn subtract(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| a[i] - b[i])
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(p: [f64; 3]) -> f64 {
    p[0].hypot(p[1]).hypot(p[2])
}

fn normalize(p: [f64; 3]) -> Result<[f64; 3], String> {
    let max = p.iter().map(|x| x.abs()).fold(0.0, f64::max);
    if max == 0. || !p.iter().all(|x| x.is_finite()) {
        return Err("expected a finite nonzero axis".into());
    }
    let scaled = p.map(|x| x / max);
    let length = norm(scaled);
    Ok(scaled.map(|x| x / length))
}

fn face_distance(face: AbsorbingBoundaryFaceIR, point: [f64; 3], bounds: [f64; 6]) -> f64 {
    use AbsorbingBoundaryFaceIR::*;
    match face {
        XPlus => bounds[3] - point[0],
        XMinus => point[0] - bounds[0],
        YPlus => bounds[4] - point[1],
        YMinus => point[1] - bounds[1],
        ZPlus => bounds[5] - point[2],
        ZMinus => point[2] - bounds[2],
    }
}

fn region_point(frame: RegionFrameIR, world: [f64; 3], translation: [f64; 3]) -> [f64; 3] {
    match frame {
        RegionFrameIR::World => world,
        RegionFrameIR::Object => subtract(world, translation),
    }
}

/// Conservative binary64 uncertainty of the coordinates, in metres. Keeping
/// each component separate makes an axial offset immaterial to an axial cylinder.
#[derive(Clone, Copy)]
struct MetricPoint {
    value: [f64; 3],
    error: [f64; 3],
}

fn near_zero(value: f64, error: f64) -> f64 {
    if value.is_finite() && error.is_finite() && value.abs() <= error {
        0.
    } else {
        value
    }
}

impl MetricPoint {
    fn world(value: [f64; 3]) -> Self {
        Self {
            value,
            error: value.map(|v| f64::EPSILON * v.abs()),
        }
    }

    fn relative(self, origin: [f64; 3]) -> Self {
        let value = subtract(self.value, origin);
        let error = std::array::from_fn(|i| {
            self.error[i] + f64::EPSILON * origin[i].abs() + f64::EPSILON * value[i].abs()
        });
        Self { value, error }
    }

    fn product_error(&self, i: usize, unit: f64) -> f64 {
        // Normalization, multiplication and the sum/difference of products.
        self.error[i] * unit.abs() + (8. * f64::EPSILON) * (self.value[i] * unit).abs()
    }

    fn projection(&self, axis: [f64; 3]) -> (f64, f64) {
        let error = (0..3).map(|i| self.product_error(i, axis[i])).sum();
        (dot(self.value, axis), error)
    }

    fn cross(&self, axis: [f64; 3]) -> Self {
        // |r x n| measures distance to an axis; unused axial coordinates
        // have exactly zero coefficient in both the result and its error.
        let value = std::array::from_fn(|i| {
            let (j, k) = ((i + 1) % 3, (i + 2) % 3);
            self.value[j] * axis[k] - self.value[k] * axis[j]
        });
        let error = std::array::from_fn(|i| {
            let (j, k) = ((i + 1) % 3, (i + 2) % 3);
            self.product_error(j, axis[k]) + self.product_error(k, axis[j])
        });
        Self { value, error }
    }

    /// Conventional positive-outside radius residual. An interval for the norm
    /// avoids treating a large uncertainty perpendicular to the radius as radial.
    fn radius_residual(&self, radius: f64) -> f64 {
        let rho = norm(self.value);
        let residual = rho - radius;
        let roundoff = (4. * f64::EPSILON) * rho.max(radius);
        if !residual.is_finite() || residual.abs() > roundoff + self.error.iter().sum::<f64>() {
            return residual;
        }
        let lo = norm(std::array::from_fn(|i| {
            (self.value[i].abs() - self.error[i]).max(0.)
        }));
        let hi = norm(std::array::from_fn(|i| self.value[i].abs() + self.error[i]));
        if lo - radius <= roundoff && radius - hi <= roundoff {
            0.
        } else {
            residual
        }
    }
}

fn oriented_radial(residual: f64, direction: AbsorbingBoundaryDirectionIR) -> f64 {
    match direction {
        AbsorbingBoundaryDirectionIR::Outward => -residual,
        AbsorbingBoundaryDirectionIR::Inward => residual,
    }
}

enum DistanceGeometry<'a> {
    Faces(&'a [AbsorbingBoundaryFaceIR], [f64; 6]),
    Plane {
        origin: [f64; 3],
        normal: [f64; 3],
    },
    Cylinder {
        center: [f64; 3],
        axis: [f64; 3],
        radius: f64,
        direction: AbsorbingBoundaryDirectionIR,
    },
    Sphere {
        center: [f64; 3],
        radius: f64,
        direction: AbsorbingBoundaryDirectionIR,
    },
    Boundary {
        shape: MetricShape,
        frame: RegionFrameIR,
    },
    Expression(AbsorbingBoundaryCoordinate),
}

// A CSG formula can have the right sign without yielding a metric distance.
// Compile only operations exact on the requested side. Inside an intersection,
// the distance to its complement is the minimum of the two exit distances.
// Outside a union, the distance to the union is the minimum entry distance.
enum MetricShape {
    Primitive(RegionShapeIR),
    Intersection(Box<Self>, Box<Self>),
    Union(Box<Self>, Box<Self>),
    Difference(Box<Self>, Box<Self>),
    Translated(Box<Self>, [f64; 3]),
}

impl MetricShape {
    fn compile(shape: &RegionShapeIR) -> Result<Self, String> {
        match shape {
            RegionShapeIR::Csg { expression } => Self::from_entry(expression, true),
            RegionShapeIR::Cylinder {
                center,
                radius,
                axis,
                height,
            } => {
                let shape = RegionShapeIR::Cylinder {
                    center: *center,
                    radius: *radius,
                    height: *height,
                    axis: normalize(*axis)?,
                };
                Ok(Self::Primitive(shape))
            }
            shape => Ok(Self::Primitive(shape.clone())),
        }
    }

    fn from_entry(shape: &GeometryEntryIR, interior: bool) -> Result<Self, String> {
        let center = [0.; 3];
        Ok(match shape {
            GeometryEntryIR::Box { size, .. } => Self::Primitive(RegionShapeIR::Box {
                size: *size,
                center,
            }),
            GeometryEntryIR::Ellipsoid { radii, .. }
                if radii[0] == radii[1] && radii[1] == radii[2] =>
            {
                Self::Primitive(RegionShapeIR::Sphere {
                    radius: radii[0],
                    center,
                })
            }
            GeometryEntryIR::Sphere { radius, .. } => Self::Primitive(RegionShapeIR::Sphere {
                radius: *radius,
                center,
            }),
            GeometryEntryIR::Cylinder {
                radius,
                height,
                axis,
                ..
            } => Self::Primitive(RegionShapeIR::Cylinder {
                radius: *radius,
                height: *height,
                axis: normalize(*axis)?,
                center,
            }),
            GeometryEntryIR::Translate { by, base, .. } => {
                Self::Translated(Box::new(Self::from_entry(base, interior)?), *by)
            }
            GeometryEntryIR::Intersection { a, b, .. } if interior => Self::Intersection(
                Box::new(Self::from_entry(a, true)?),
                Box::new(Self::from_entry(b, true)?),
            ),
            GeometryEntryIR::Difference { base, tool, .. } if interior => Self::Difference(
                Box::new(Self::from_entry(base, true)?),
                Box::new(Self::from_entry(tool, false)?),
            ),
            GeometryEntryIR::Union { a, b, .. } if !interior || separated(a, b)? => Self::Union(
                Box::new(Self::from_entry(a, interior)?),
                Box::new(Self::from_entry(b, interior)?),
            ),
            other => {
                return Err(format!(
                    "region_boundary has no exact distance evaluator for geometry '{}'; use a distance expression or an analytic layer with a region mask",
                    other.name()
                ));
            }
        })
    }

    /// Conventional negative-inside sign. Magnitude is exact on the compiled side.
    fn distance(&self, p: MetricPoint) -> Result<f64, String> {
        Ok(match self {
            Self::Primitive(RegionShapeIR::Sphere { center, radius }) => {
                p.relative(*center).radius_residual(*radius)
            }
            Self::Primitive(RegionShapeIR::Box { center, size }) => {
                let p = p.relative(*center);
                let q: [f64; 3] = std::array::from_fn(|i| {
                    let half = 0.5 * size[i];
                    near_zero(p.value[i].abs() - half, p.error[i] + f64::EPSILON * half)
                });
                norm(q.map(|d| d.max(0.))) + q.into_iter().fold(f64::NEG_INFINITY, f64::max).min(0.)
            }
            Self::Primitive(RegionShapeIR::Cylinder {
                center,
                axis,
                radius,
                height,
            }) => {
                let p = p.relative(*center);
                let radial = p.cross(*axis).radius_residual(*radius);
                let (z, err) = p.projection(*axis);
                let half = 0.5 * height;
                let axial = near_zero(z.abs() - half, err + f64::EPSILON * half);
                radial.max(0.).hypot(axial.max(0.)) + radial.max(axial).min(0.)
            }
            Self::Primitive(RegionShapeIR::Csg { .. }) => {
                unreachable!("CSG compiled into metric operations")
            }
            Self::Translated(base, by) => base.distance(p.relative(*by))?,
            Self::Intersection(a, b) => a.distance(p)?.max(b.distance(p)?),
            Self::Difference(a, b) => a.distance(p)?.max(-b.distance(p)?),
            Self::Union(a, b) => a.distance(p)?.min(b.distance(p)?),
        })
    }
}

/// Check whether the planner can follow this region with a metric-width band.
pub fn validate_absorbing_region_boundary(shape: &RegionShapeIR) -> Result<(), String> {
    MetricShape::compile(shape).map(|_| ())
}

// Disjoint bounds prove that neither component can cover the other's surface.
// Boundary distances themselves always come from the original geometry.
fn separated(a: &GeometryEntryIR, b: &GeometryEntryIR) -> Result<bool, String> {
    use crate::selection::geometry::geometry_entry_bounds;
    let (lo_a, hi_a) = geometry_entry_bounds(a).map_err(|e| e.to_string())?;
    let (lo_b, hi_b) = geometry_entry_bounds(b).map_err(|e| e.to_string())?;
    Ok((0..3).any(|i| hi_a[i] < lo_b[i] || hi_b[i] < lo_a[i]))
}

enum RegionMask {
    Analytic(GeometryPredicate),
    Csg {
        shape: crate::geometry::CompiledGeometryShape,
        frame: RegionFrameIR,
    },
}

impl RegionMask {
    fn compile(region: &ObjectRegionIR, translation: [f64; 3]) -> Result<Self, String> {
        if let RegionShapeIR::Csg { expression } = &region.shape {
            let shape = crate::geometry::ir_to_shape(expression)?
                .compile()
                .map_err(|e| e.to_string())?;
            return Ok(Self::Csg {
                shape,
                frame: region.frame,
            });
        }
        GeometryPredicate::from_object_region(
            region,
            AffineTransform3 {
                translation_m: translation,
                ..Default::default()
            },
            BoundaryMembership::inclusive(),
        )
        .map(Self::Analytic)
        .map_err(|e| e.to_string())
    }

    fn contains(&self, world: [f64; 3], translation: [f64; 3]) -> Result<bool, String> {
        match self {
            Self::Analytic(predicate) => predicate.contains(world),
            Self::Csg { shape, frame } => shape.contains(region_point(*frame, world, translation)),
        }
        .map_err(|e| e.to_string())
    }
}

struct Layer<'a> {
    geometry: DistanceGeometry<'a>,
    mask: Option<RegionMask>,
    profile: ResolvedAbsorbingBoundaryProfile,
    total: f64,
    ramp: f64,
    amplitude: f64,
    frame: AbsorbingBoundaryFrameIR,
}

impl Layer<'_> {
    fn contribution(&self, world: [f64; 3], translation: [f64; 3]) -> Result<f64, String> {
        if let Some(mask) = &self.mask {
            if !mask.contains(world, translation)? {
                return Ok(0.);
            }
        }
        let metric_world = MetricPoint::world(world);
        let point = match self.frame {
            AbsorbingBoundaryFrameIR::Object => metric_world.relative(translation),
            AbsorbingBoundaryFrameIR::Universe => metric_world,
        };
        let weight = |distance: f64| -> Result<f64, String> {
            if !distance.is_finite() {
                return Err("non-finite absorbing boundary distance".into());
            }
            if distance < 0. || distance > self.total {
                return Ok(0.);
            }
            if distance <= self.total - self.ramp {
                return Ok(1.);
            }
            self.profile.evaluate((self.total - distance) / self.ramp)
        };
        // Custom profiles need not be monotonic, so sample each face separately.
        let w = match &self.geometry {
            DistanceGeometry::Faces(faces, bounds) => {
                let mut max_weight: f64 = 0.;
                for face in *faces {
                    max_weight =
                        max_weight.max(weight(face_distance(*face, point.value, *bounds))?);
                }
                max_weight
            }
            DistanceGeometry::Plane { origin, normal } => {
                let (projection, error) = point.relative(*origin).projection(*normal);
                weight(near_zero(-projection, error))?
            }
            DistanceGeometry::Cylinder {
                center,
                axis,
                radius,
                direction,
            } => {
                let residual = point
                    .relative(*center)
                    .cross(*axis)
                    .radius_residual(*radius);
                weight(oriented_radial(residual, *direction))?
            }
            DistanceGeometry::Sphere {
                center,
                radius,
                direction,
            } => {
                let residual = point.relative(*center).radius_residual(*radius);
                weight(oriented_radial(residual, *direction))?
            }
            DistanceGeometry::Boundary { shape, frame } => {
                let point = match frame {
                    RegionFrameIR::World => metric_world,
                    RegionFrameIR::Object => metric_world.relative(translation),
                };
                weight(-shape.distance(point)?)?
            }
            DistanceGeometry::Expression(expression) => weight(expression.evaluate(point.value)?)?,
        };
        Ok(w * self.amplitude)
    }
}

pub(super) fn apply_absorbing_boundary_layer(
    problem: &ProblemIR,
    owner: &str,
    values: &mut [f64],
    points: &[[f64; 3]],
    active_mask: Option<&[bool]>,
    translation: [f64; 3],
) -> Result<(), String> {
    let Some(config) = problem
        .magnets
        .iter()
        .find(|m| m.object_id.as_deref().unwrap_or(&m.name) == owner)
        .and_then(|m| m.absorbing_boundary.as_ref())
    else {
        return Ok(());
    };
    if values.len() != points.len() || active_mask.is_some_and(|mask| mask.len() != points.len()) {
        return Err(
            "absorbing boundary alpha field and active mask lengths must match points".into(),
        );
    }
    let active = |i: usize| active_mask.is_none_or(|mask| mask[i]);
    let legacy;
    let layers = match config {
        AbsorbingBoundaryIR::Legacy(old) => {
            legacy = SpatialAbsorbingLayerIR {
                layer_id: "legacy".into(),
                name: "Absorbing Boundary".into(),
                enabled: true,
                region_id: None,
                total_width_m: old.total_width_m,
                ramp_width_m: old.ramp_width_m,
                max_damping: old.max_damping,
                frame: old.frame,
                profile: old.profile,
                expression: old.expression.clone(),
                geometry: SpatialAbsorbingGeometryIR::Faces {
                    faces: old.faces.clone(),
                },
            };
            std::slice::from_ref(&legacy)
        }
        AbsorbingBoundaryIR::Layers(config) => config.layers.as_slice(),
    };
    let mut compiled = Vec::new();
    let magnetic_bounds = std::cell::OnceCell::new();
    let sampled_bounds = || {
        let points = points.iter().enumerate().filter(|(i, _)| active(*i));
        crate::mesh::bounds_from_points(points.map(|(_, point)| point))
    };
    let lookup = |id: &str| {
        problem
            .object_regions
            .iter()
            .find(|r| r.owner_object == owner && r.region_id == id)
            .ok_or_else(|| {
                format!("absorbing boundary references missing region '{id}' on '{owner}'")
            })
    };
    for layer in layers.iter().filter(|l| l.enabled) {
        let mask_region = layer.region_id.as_deref().map(&lookup).transpose()?;
        if mask_region.is_some_and(|r| !r.enabled) {
            continue;
        }
        let geometry = match &layer.geometry {
            SpatialAbsorbingGeometryIR::Faces { faces } => {
                let explicit = if layer.frame == AbsorbingBoundaryFrameIR::Universe {
                    universe_bounds(problem)
                } else {
                    None
                };
                let bounds = if let Some(bounds) = explicit {
                    bounds
                } else {
                    let (min, max) = magnetic_bounds.get_or_init(sampled_bounds).as_ref()
                        .ok_or_else(|| format!("absorbing boundary for '{owner}' requires at least one magnetic point"))?;
                    let offset = if layer.frame == AbsorbingBoundaryFrameIR::Object {
                        translation
                    } else {
                        [0.; 3]
                    };
                    let [x0, y0, z0] = subtract(*min, offset);
                    let [x1, y1, z1] = subtract(*max, offset);
                    [x0, y0, z0, x1, y1, z1]
                };
                DistanceGeometry::Faces(faces, bounds)
            }
            SpatialAbsorbingGeometryIR::Plane { origin, normal } => DistanceGeometry::Plane {
                origin: *origin,
                normal: normalize(*normal)?,
            },
            SpatialAbsorbingGeometryIR::Cylinder {
                center,
                radius_m,
                axis,
                direction,
            } => DistanceGeometry::Cylinder {
                center: *center,
                radius: *radius_m,
                axis: normalize(*axis)?,
                direction: *direction,
            },
            SpatialAbsorbingGeometryIR::Sphere {
                center,
                radius_m,
                direction,
            } => DistanceGeometry::Sphere {
                center: *center,
                radius: *radius_m,
                direction: *direction,
            },
            SpatialAbsorbingGeometryIR::Expression { expression } => {
                DistanceGeometry::Expression(AbsorbingBoundaryCoordinate::compile(expression)?)
            }
            SpatialAbsorbingGeometryIR::RegionBoundary { region_id } => {
                let region = lookup(region_id)?;
                if !region.enabled {
                    continue;
                }
                DistanceGeometry::Boundary {
                    shape: MetricShape::compile(&region.shape)?,
                    frame: region.frame,
                }
            }
        };
        let mask = mask_region
            .map(|region| RegionMask::compile(region, translation))
            .transpose()?;
        compiled.push((
            &layer.layer_id,
            Layer {
                geometry,
                mask,
                profile: ResolvedAbsorbingBoundaryProfile::compile(
                    layer.profile,
                    layer.expression.as_deref(),
                )?,
                total: layer.total_width_m,
                ramp: layer.ramp_width_m,
                amplitude: layer.max_damping,
                frame: layer.frame,
            },
        ));
    }
    if compiled.is_empty() {
        return Ok(());
    }
    for (i, point) in points.iter().enumerate().filter(|(i, _)| active(*i)) {
        let mut added: f64 = 0.;
        for (id, layer) in &compiled {
            added = added.max(
                layer
                    .contribution(*point, translation)
                    .map_err(|e| format!("absorbing boundary '{id}' on '{owner}': {e}"))?,
            );
        }
        values[i] += added;
        if !values[i].is_finite() || values[i] < 0. {
            return Err(format!(
                "resolved absorbing boundary alpha for '{owner}' is invalid"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn spatial_layers_use_independent_walls_and_maximum_overlaps() {
        let mut problem = ProblemIR::bootstrap_example();
        let layer = |id: &str, face: &str, width: f64, amplitude: f64| {
            serde_json::json!({
                "layer_id":id, "name":id, "enabled":true, "frame":"object",
                "total_width_m":width, "ramp_width_m":width, "max_damping":amplitude,
                "profile":"linear", "geometry":{"kind":"faces","faces":[face]}
            })
        };
        let left = layer("left", "x-", 2.0, 0.5);
        let right = layer("right", "x+", 4.0, 0.75);
        let points = [
            [0., 0., 0.],
            [1., 0., 0.],
            [2., 0., 0.],
            [4., 0., 0.],
            [7., 0., 0.],
        ];
        let mask = [true, true, true, true, false];
        for layers in [[&left, &right], [&right, &left]] {
            problem.magnets[0].absorbing_boundary =
                Some(serde_json::from_value(serde_json::json!({"layers":layers})).unwrap());
            let mut values = [0.125; 5];
            apply_absorbing_boundary_layer(
                &problem,
                "strip",
                &mut values,
                &points,
                Some(&mask),
                [0.; 3],
            )
            .unwrap();
            assert_eq!(values, [0.625, 0.375, 0.5, 0.875, 0.125]);
        }
    }

    fn set_layer(problem: &mut ProblemIR, geometry: Value, frame: &str, mask: Option<&str>) {
        problem.magnets[0].absorbing_boundary = Some(
            serde_json::from_value(json!({"layers":[{
                "layer_id":"a","name":"test","enabled":true,"frame":frame,"region_id":mask,
                "total_width_m":2.0,"ramp_width_m":1.0,"max_damping":0.5,
                "profile":"linear","geometry":geometry
            }]}))
            .unwrap(),
        );
    }

    fn set_nanometre_layer(problem: &mut ProblemIR, geometry: Value) {
        set_layer(problem, geometry, "universe", None);
        let Some(AbsorbingBoundaryIR::Layers(config)) = &mut problem.magnets[0].absorbing_boundary
        else {
            unreachable!()
        };
        config.layers[0].total_width_m = 10e-9;
        config.layers[0].ramp_width_m = 5e-9;
        problem.validate().unwrap();
    }

    #[test]
    fn metric_boundary_roundoff_preserves_opposite_nanometre_edges_and_resolved_gaps() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.object_regions.push(serde_json::from_value(json!({
            "region_id":"s","owner_object":"strip","name":"Translated sphere","frame":"world",
            "shape":{"kind":"csg","expression":{"kind":"translate","name":"moved","by":[30e-9,0.,0.],
              "base":{"kind":"sphere","name":"sphere","radius":50e-9}}}
        })).unwrap());
        for geometry in [
            json!({"kind":"cylinder","center":[30e-9,0.,0.],"axis":[0.,0.,1.],"radius_m":50e-9,"direction":"outward"}),
            json!({"kind":"sphere","center":[30e-9,0.,0.],"radius_m":50e-9,"direction":"outward"}),
            json!({"kind":"region_boundary","region_id":"s"}),
        ] {
            set_nanometre_layer(&mut problem, geometry);
            let points = [
                [80e-9, 0., 0.],
                [-20e-9, 0., 0.],
                [80e-9 + 1e-18, 0., 0.],
                [-20e-9 - 1e-18, 0., 0.],
                [80e-9 - 1e-18, 0., 0.],
                [-20e-9 + 1e-18, 0., 0.],
            ];
            let mut values = [0.125; 6];
            apply_absorbing_boundary_layer(&problem, "strip", &mut values, &points, None, [0.; 3])
                .unwrap();
            assert_eq!(values, [0.625, 0.625, 0.125, 0.125, 0.625, 0.625]);
        }
    }

    #[test]
    fn metric_roundoff_uses_relevant_operands_and_preserves_signed_expressions() {
        let mut problem = ProblemIR::bootstrap_example();
        let p = [80e-9, -50e-9, 1e10];
        let mut sample = |geometry: Value, world: [f64; 3]| {
            set_nanometre_layer(&mut problem, geometry);
            let mut value = [0.125];
            apply_absorbing_boundary_layer(&problem, "strip", &mut value, &[world], None, [0.; 3])
                .unwrap();
            value[0]
        };
        let plane = json!({"kind":"plane","origin":[30e-9,0.,0.],"normal":[1.,1.,0.]});
        assert_eq!(sample(plane.clone(), p), 0.625);
        assert_eq!(sample(plane.clone(), [p[0] + 1e-18, p[1], p[2]]), 0.125);
        assert_eq!(sample(plane, [p[0] - 1e-18, p[1], p[2]]), 0.625);
        let cylinder = json!({"kind":"cylinder","center":[30e-9,0.,0.],"axis":[0.,0.,1.],"radius_m":50e-9,"direction":"outward"});
        assert_eq!(sample(cylinder.clone(), [80e-9, 0., p[2]]), 0.625);
        assert_eq!(sample(cylinder, [80e-9 + 1e-18, 0., p[2]]), 0.125);
        assert_eq!(
            sample(json!({"kind":"expression","expression":"-1e-32"}), p),
            0.125
        );
    }

    #[test]
    fn magnet_translation_resolves_solver_names_even_when_another_owner_has_the_same_id() {
        let mut problem = ProblemIR::bootstrap_example();
        let mut first = problem.magnets[0].clone();
        first.name = "First".into();
        first.object_id = Some("strip".into());
        first.region = "first-region".into();
        problem.magnets[0].object_id = Some("M2".into());
        problem.magnets.insert(0, first);
        problem.regions.push(fullmag_ir::RegionIR {
            name: "first-region".into(),
            geometry: "first".into(),
        });
        problem.geometry.entries.push(GeometryEntryIR::Translate {
            name: "first".into(),
            by: [1., 2., 3.],
            base: Box::new(GeometryEntryIR::Box {
                name: "body".into(),
                size: [2.; 3],
            }),
        });
        assert_eq!(super::super::object_translation(&problem, "strip"), [0.; 3]);
        assert_eq!(
            super::super::object_translation(&problem, "First"),
            [1., 2., 3.]
        );
    }

    #[test]
    fn spatial_tilted_translated_cylinder_is_axially_invariant() {
        let mut problem = ProblemIR::bootstrap_example();
        let translation = [10., -1., 20.];
        let points = [
            [12., 3.5, 21.], // rho=2.5
            [19., 3.5, 28.], // same radial displacement, shifted along the tilted axis
            [12., 4., 21.],  // plateau
            [12., 5.5, 21.], // outside shell
            [12., 2., 21.],  // inside core
        ];
        for (frame, center) in [("object", [2., 2., 1.]), ("universe", [12., 1., 21.])] {
            set_layer(
                &mut problem,
                json!({"kind":"cylinder","center":center,"axis":[3.,0.,3.],
                "radius_m":4.,"direction":"outward"}),
                frame,
                None,
            );
            let mut alpha = [0.125; 5];
            apply_absorbing_boundary_layer(
                &problem,
                "strip",
                &mut alpha,
                &points,
                None,
                translation,
            )
            .unwrap();
            for (actual, expected) in alpha.into_iter().zip([0.375, 0.375, 0.625, 0.125, 0.125]) {
                assert!((actual - expected).abs() < 1e-12, "{frame}: {actual}");
            }
        }
    }

    #[test]
    fn spatial_region_cutout_masks_material_and_tracks_its_real_boundary() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.magnets[0].object_id = Some("object-1".into());
        let id = "region-1";
        problem.object_regions.push(
            serde_json::from_value(json!({
                "region_id":id, "owner_object":"object-1", "name":"renamable",
                "material_overrides":[{"parameter":"alpha","value":{"kind":"constant","value":0.25,"unit":"1"}}],
                "shape":{"kind":"csg","expression":{"kind":"difference","name":"shell",
                    "base":{"kind":"ellipsoid","name":"outer","radii":[8.0,8.0,8.0]},
                    "tool":{"kind":"ellipsoid","name":"inner","radii":[3.0,3.0,3.0]}}}
            }))
            .unwrap(),
        );
        let points = [
            [2., 0., 0.],
            [4.5, 0., 0.],
            [5.5, 0., 0.],
            [8., 0., 0.],
            [9., 0., 0.],
        ];
        let resolve = |problem: &ProblemIR| {
            super::super::resolve_spatial_parameter(
                problem,
                "strip",
                fullmag_ir::MaterialParameterNameIR::Alpha,
                0.125,
                &points,
                super::super::MaterialSampling::Nodes { spacings: &[1.; 5] },
                [0.; 3],
            )
            .unwrap()
        };
        set_layer(
            &mut problem,
            json!({"kind":"expression","expression":"min(z,max(x,y))"}),
            "universe",
            Some(id),
        );
        assert_eq!(resolve(&problem), [0.125, 0.75, 0.75, 0.75, 0.125]);
        set_layer(
            &mut problem,
            json!({"kind":"region_boundary","region_id":id}),
            "universe",
            None,
        );
        let expected = [0.125, 0.5, 0.25, 0.75, 0.125];
        assert_eq!(resolve(&problem), expected);
        problem.object_regions[0].name = "renamed".into();
        assert_eq!(resolve(&problem), expected);
        problem.object_regions[0].enabled = false;
        assert_eq!(resolve(&problem), [0.125; 5]);
    }

    #[test]
    fn spatial_disconnected_boundaries_are_metric_and_overlapping_union_is_explicit() {
        let sphere = |name| GeometryEntryIR::Sphere {
            name: String::from(name),
            radius: 3.0,
        };
        let islands = |shift| GeometryEntryIR::Union {
            name: "islands".into(),
            a: Box::new(sphere("one")),
            b: Box::new(GeometryEntryIR::Translate {
                name: "shifted".into(),
                base: Box::new(sphere("two")),
                by: [shift, 0., 0.],
            }),
        };
        let ellipsoid = GeometryEntryIR::Ellipsoid {
            name: "aspherical".into(),
            radii: [3., 3., 4.],
        };
        let region = RegionShapeIR::Csg {
            expression: Box::new(ellipsoid),
        };
        assert!(validate_absorbing_region_boundary(&region).is_err());
        let metric = MetricShape::from_entry(&islands(10.), true).unwrap();
        assert_eq!(
            metric.distance(MetricPoint::world([2., 0., 0.])).unwrap(),
            -1.
        );
        assert_eq!(
            metric.distance(MetricPoint::world([5., 0., 0.])).unwrap(),
            2.
        );
        assert_eq!(
            metric.distance(MetricPoint::world([12., 0., 0.])).unwrap(),
            -1.
        );
        assert!(
            matches!(MetricShape::from_entry(&islands(2.),true), Err(message) if message.contains("exact distance"))
        );
    }

    #[test]
    fn spatial_wave_coordinate_tracks_the_contour_only_on_the_selected_branch() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.object_regions.push(
            serde_json::from_value(json!({
                "region_id":"branch", "owner_object":"strip", "name":"One outlet", "frame":"world",
                "shape":{"kind":"box","size":[8.,6.,2.],"center":[0.,1.,0.]}
            }))
            .unwrap(),
        );
        set_layer(
            &mut problem,
            json!({"kind":"expression","expression":"sin(x)-y"}),
            "universe",
            Some("branch"),
        );
        let quarter = std::f64::consts::FRAC_PI_2;
        let points = [
            [quarter, 1., 0.],
            [-quarter, -1., 0.],
            [quarter, -0.5, 0.],
            [quarter, 1.25, 0.],
            [quarter, 1., 2.],
        ];
        let mut alpha = [0.125; 5];
        apply_absorbing_boundary_layer(&problem, "strip", &mut alpha, &points, None, [0.; 3])
            .unwrap();
        assert_eq!(alpha, [0.625, 0.625, 0.375, 0.125, 0.125]);
    }

    #[test]
    fn spatial_inward_shell_and_arbitrary_plane_have_one_sided_support() {
        let mut problem = ProblemIR::bootstrap_example();
        let points = [[0., 2., 0.], [0., 3., 0.], [0., 4.5, 0.], [0., 5.5, 0.]];
        for geometry in [
            json!({"kind":"sphere","center":[0.,0.,0.],"radius_m":3.,"direction":"inward"}),
            json!({"kind":"plane","origin":[0.,3.,0.],"normal":[0.,-10.,0.]}),
            json!({"kind":"expression","expression":"y-3"}),
        ] {
            set_layer(&mut problem, geometry, "object", None);
            let mut values = [0.125; 4];
            apply_absorbing_boundary_layer(&problem, "strip", &mut values, &points, None, [0.; 3])
                .unwrap();
            assert_eq!(values, [0.125, 0.625, 0.375, 0.125]);
        }
        set_layer(
            &mut problem,
            json!({"kind":"expression","expression":"1/(y-3)"}),
            "object",
            None,
        );
        let mut values = [0.; 4];
        assert!(
            apply_absorbing_boundary_layer(&problem, "strip", &mut values, &points, None, [0.; 3])
                .unwrap_err()
                .contains("undefined")
        );
    }
}
