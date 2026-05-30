use plotters::prelude::*;
use serde::Deserialize;

use crate::error::ApiError;
use crate::fem_cross_section::CrossSectionQualityMetric;
use crate::fem_slice_overlay::{FemSliceOverlay, SliceOverlayBounds};

const DEFAULT_BACKGROUND: RGBColor = RGBColor(248, 249, 252);
const DEFAULT_FOREGROUND: RGBColor = RGBColor(28, 31, 38);
const DEFAULT_GRID: RGBColor = RGBColor(207, 214, 224);
const DEFAULT_WIREFRAME: RGBColor = RGBColor(31, 35, 44);
const MIN_SHRINK_FACTOR: f64 = 0.5;
const MAX_SHRINK_FACTOR: f64 = 1.0;
const PLOT_MARGIN_LEFT: i32 = 62;
const PLOT_MARGIN_RIGHT: i32 = 20;
const PLOT_MARGIN_TOP: i32 = 54;
const PLOT_MARGIN_BOTTOM: i32 = 58;

#[derive(Debug, Clone, Copy, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CrossSectionImageColorScale {
    Jet,
    Viridis,
    Hot,
    Coolwarm,
}

impl CrossSectionImageColorScale {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Jet => "jet",
            Self::Viridis => "viridis",
            Self::Hot => "hot",
            Self::Coolwarm => "coolwarm",
        }
    }
}

impl Default for CrossSectionImageColorScale {
    fn default() -> Self {
        Self::Viridis
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CrossSectionImageRenderOptions {
    pub color_scale: CrossSectionImageColorScale,
    pub legend: bool,
    pub metric: CrossSectionQualityMetric,
    pub resolution: u32,
    pub rotation_degrees: f64,
    pub shrink_factor: f64,
    pub wireframe: bool,
}

#[derive(Debug, Clone)]
struct ImageLabel {
    text: String,
    x: i32,
    y: i32,
    scale: u32,
    color: [u8; 3],
}

#[derive(Debug, Clone, Copy)]
struct PlotTransform {
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    u_min: f64,
    v_max: f64,
    scale: f64,
}

#[derive(Debug, Clone)]
struct RenderPolygon {
    vertices: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, Copy)]
struct RenderSegment {
    a: [f64; 2],
    b: [f64; 2],
}

#[derive(Debug, Clone)]
struct RenderGeometry {
    bounds: SliceOverlayBounds,
    polygons: Vec<RenderPolygon>,
    segments: Vec<RenderSegment>,
}

impl RenderGeometry {
    fn from_overlay(overlay: &FemSliceOverlay, rotation_degrees: f64) -> Self {
        if rotation_degrees.abs() < f64::EPSILON {
            return Self {
                bounds: overlay.bounds,
                polygons: overlay
                    .polygons
                    .iter()
                    .map(|polygon| RenderPolygon {
                        vertices: polygon.vertices.clone(),
                    })
                    .collect(),
                segments: overlay
                    .segments
                    .iter()
                    .map(|segment| RenderSegment {
                        a: segment.a,
                        b: segment.b,
                    })
                    .collect(),
            };
        }

        let center = [
            (overlay.bounds.u_min + overlay.bounds.u_max) * 0.5,
            (overlay.bounds.v_min + overlay.bounds.v_max) * 0.5,
        ];
        let angle = rotation_degrees.to_radians();
        let (sin, cos) = angle.sin_cos();
        let rotate = |point: [f64; 2]| -> [f64; 2] {
            let du = point[0] - center[0];
            let dv = point[1] - center[1];
            [
                center[0] + du * cos - dv * sin,
                center[1] + du * sin + dv * cos,
            ]
        };

        let polygons = overlay
            .polygons
            .iter()
            .map(|polygon| RenderPolygon {
                vertices: polygon.vertices.iter().copied().map(rotate).collect(),
            })
            .collect::<Vec<_>>();
        let segments = overlay
            .segments
            .iter()
            .map(|segment| RenderSegment {
                a: rotate(segment.a),
                b: rotate(segment.b),
            })
            .collect::<Vec<_>>();
        let bounds = bounds_for_geometry(&polygons, &segments).unwrap_or(overlay.bounds);
        Self {
            bounds,
            polygons,
            segments,
        }
    }
}

impl PlotTransform {
    fn new(bounds: SliceOverlayBounds, plot_width: u32, image_height: u32) -> Self {
        let available_width = (plot_width as i32 - PLOT_MARGIN_LEFT - PLOT_MARGIN_RIGHT).max(1);
        let available_height = (image_height as i32 - PLOT_MARGIN_TOP - PLOT_MARGIN_BOTTOM).max(1);
        let u_span = (bounds.u_max - bounds.u_min).abs().max(f64::EPSILON);
        let v_span = (bounds.v_max - bounds.v_min).abs().max(f64::EPSILON);
        let scale = (available_width as f64 / u_span).min(available_height as f64 / v_span);
        let width = (u_span * scale).round().max(1.0) as i32;
        let height = (v_span * scale).round().max(1.0) as i32;
        let left = PLOT_MARGIN_LEFT + (available_width - width) / 2;
        let top = PLOT_MARGIN_TOP + (available_height - height) / 2;
        Self {
            left,
            top,
            width,
            height,
            u_min: bounds.u_min,
            v_max: bounds.v_max,
            scale,
        }
    }

    fn right(self) -> i32 {
        self.left + self.width
    }

    fn bottom(self) -> i32 {
        self.top + self.height
    }

    fn point(self, point: (f64, f64)) -> (i32, i32) {
        let x = self.left as f64 + (point.0 - self.u_min) * self.scale;
        let y = self.top as f64 + (self.v_max - point.1) * self.scale;
        (x.round() as i32, y.round() as i32)
    }
}

pub(crate) fn validate_cross_section_image_query(
    position_percent: f64,
    resolution: u32,
    rotation_degrees: f64,
    shrink_factor: f64,
) -> Result<(), ApiError> {
    if !position_percent.is_finite() || !(0.0..=100.0).contains(&position_percent) {
        return Err(ApiError::bad_request(
            "invalid_query: position_percent must be finite and in [0, 100]",
        ));
    }
    if !matches!(resolution, 512 | 1024 | 2048) {
        return Err(ApiError::bad_request(
            "invalid_query: resolution must be one of 512, 1024, 2048",
        ));
    }
    if !rotation_degrees.is_finite() || !(-180.0..=180.0).contains(&rotation_degrees) {
        return Err(ApiError::bad_request(
            "invalid_query: rotation_degrees must be finite and in [-180, 180]",
        ));
    }
    if !shrink_factor.is_finite()
        || !(MIN_SHRINK_FACTOR..=MAX_SHRINK_FACTOR).contains(&shrink_factor)
    {
        return Err(ApiError::bad_request(
            "invalid_query: shrink_factor must be finite and in [0.5, 1.0]",
        ));
    }
    Ok(())
}

pub(crate) fn render_cross_section_png(
    overlay: &FemSliceOverlay,
    quality_values: &[f32],
    options: CrossSectionImageRenderOptions,
    filter_expression: Option<&str>,
) -> Result<Vec<u8>, ApiError> {
    if quality_values.len() != overlay.polygons.len() {
        return Err(ApiError::internal(
            "cross-section image quality value count must match polygon count",
        ));
    }

    let filter = parse_filter_expression(filter_expression)?;
    let filtered_values = quality_values
        .iter()
        .copied()
        .filter(|value| value.is_finite() && filter.matches(*value as f64))
        .collect::<Vec<_>>();
    let (min, max) = quality_range(&filtered_values).unwrap_or((0.0, 1.0));

    let width = options.resolution;
    let height = options.resolution;
    let mut rgb = vec![255u8; width as usize * height as usize * 3];
    let mut labels = Vec::new();
    {
        let root = BitMapBackend::with_buffer(&mut rgb, (width, height)).into_drawing_area();
        root.fill(&DEFAULT_BACKGROUND)
            .map_err(plotters_error("fill background"))?;

        let legend_width = if options.legend { width.min(170) } else { 0 };
        let plot_width = width.saturating_sub(legend_width).max(1);
        let geometry = RenderGeometry::from_overlay(overlay, options.rotation_degrees);
        let bounds = padded_bounds(geometry.bounds);
        let transform = PlotTransform::new(bounds, plot_width, height);
        root.draw(&Rectangle::new(
            [
                (transform.left, transform.top),
                (transform.right(), transform.bottom()),
            ],
            ShapeStyle::from(&RGBColor(255, 255, 255)).filled(),
        ))
        .map_err(plotters_error("draw plot background"))?;
        draw_plot_grid(&root, &transform)?;

        labels.push(ImageLabel {
            text: format!(
                "{} cross-section at {:.3}%",
                overlay.plane.as_str().to_uppercase(),
                overlay.cut_norm * 100.0
            ),
            x: transform.left,
            y: 18,
            scale: 2,
            color: rgb_bytes(DEFAULT_FOREGROUND),
        });
        labels.push(ImageLabel {
            text: axis_label(overlay.u_axis),
            x: transform.left + transform.width / 2 - 32,
            y: transform.bottom() + 34,
            scale: 1,
            color: rgb_bytes(DEFAULT_FOREGROUND),
        });
        labels.push(ImageLabel {
            text: axis_label(overlay.v_axis),
            x: 12,
            y: transform.top,
            scale: 1,
            color: rgb_bytes(DEFAULT_FOREGROUND),
        });

        let span = (max - min).abs().max(f32::EPSILON);
        for (polygon, value) in geometry
            .polygons
            .iter()
            .zip(quality_values.iter().copied())
            .filter(|(_, value)| value.is_finite() && filter.matches(*value as f64))
        {
            let local = ((value - min) / span).clamp(0.0, 1.0);
            let color = color_for_scale(local as f64, options.color_scale);
            root.draw(&Polygon::new(
                shrink_vertices(&polygon.vertices, options.shrink_factor)
                    .into_iter()
                    .map(|point| transform.point(point))
                    .collect::<Vec<_>>(),
                ShapeStyle::from(&color).filled(),
            ))
            .map_err(plotters_error("draw polygons"))?;
        }

        if options.wireframe {
            for segment in &geometry.segments {
                root.draw(&PathElement::new(
                    vec![
                        transform.point((segment.a[0], segment.a[1])),
                        transform.point((segment.b[0], segment.b[1])),
                    ],
                    ShapeStyle::from(&DEFAULT_WIREFRAME.mix(0.62)).stroke_width(1),
                ))
                .map_err(plotters_error("draw wireframe"))?;
            }
        }
        root.draw(&Rectangle::new(
            [
                (transform.left, transform.top),
                (transform.right(), transform.bottom()),
            ],
            ShapeStyle::from(&DEFAULT_FOREGROUND).stroke_width(1),
        ))
        .map_err(plotters_error("draw plot frame"))?;

        if options.legend {
            draw_legend_shapes(
                &root,
                plot_width as i32,
                height as i32,
                options.metric,
                options.color_scale,
                min,
                max,
                overlay.polygons.len(),
                filtered_values.len(),
                &mut labels,
            )?;
        }

        root.present().map_err(plotters_error("present"))?;
    }
    for label in labels {
        draw_text_5x7(
            &mut rgb,
            width,
            height,
            label.x,
            label.y,
            &label.text,
            label.scale,
            label.color,
        );
    }

    encode_rgb_png(width, height, &rgb)
}

fn padded_bounds(bounds: SliceOverlayBounds) -> SliceOverlayBounds {
    let u_span = (bounds.u_max - bounds.u_min).abs().max(f64::EPSILON);
    let v_span = (bounds.v_max - bounds.v_min).abs().max(f64::EPSILON);
    SliceOverlayBounds {
        u_min: bounds.u_min - u_span * 0.02,
        u_max: bounds.u_max + u_span * 0.02,
        v_min: bounds.v_min - v_span * 0.02,
        v_max: bounds.v_max + v_span * 0.02,
    }
}

fn bounds_for_geometry(
    polygons: &[RenderPolygon],
    segments: &[RenderSegment],
) -> Option<SliceOverlayBounds> {
    let mut u_min = f64::INFINITY;
    let mut u_max = f64::NEG_INFINITY;
    let mut v_min = f64::INFINITY;
    let mut v_max = f64::NEG_INFINITY;
    let mut seen = false;

    for point in polygons
        .iter()
        .flat_map(|polygon| polygon.vertices.iter().copied())
        .chain(segments.iter().flat_map(|segment| [segment.a, segment.b]))
    {
        if !point[0].is_finite() || !point[1].is_finite() {
            continue;
        }
        seen = true;
        u_min = u_min.min(point[0]);
        u_max = u_max.max(point[0]);
        v_min = v_min.min(point[1]);
        v_max = v_max.max(point[1]);
    }

    seen.then_some(SliceOverlayBounds {
        u_min,
        u_max,
        v_min,
        v_max,
    })
}

fn axis_label(axis: &str) -> String {
    format!("{axis} (m)")
}

fn draw_plot_grid(
    root: &DrawingArea<BitMapBackend<'_>, plotters::coord::Shift>,
    transform: &PlotTransform,
) -> Result<(), ApiError> {
    for index in 0..=4 {
        let opacity = if index == 0 || index == 4 { 0.85 } else { 0.45 };
        let x = transform.left + transform.width * index / 4;
        root.draw(&PathElement::new(
            vec![(x, transform.top), (x, transform.bottom())],
            ShapeStyle::from(&DEFAULT_GRID.mix(opacity)).stroke_width(1),
        ))
        .map_err(plotters_error("draw grid"))?;
        let y = transform.top + transform.height * index / 4;
        root.draw(&PathElement::new(
            vec![(transform.left, y), (transform.right(), y)],
            ShapeStyle::from(&DEFAULT_GRID.mix(opacity)).stroke_width(1),
        ))
        .map_err(plotters_error("draw grid"))?;
    }
    Ok(())
}

fn shrink_vertices(vertices: &[[f64; 2]], shrink_factor: f64) -> Vec<(f64, f64)> {
    if vertices.is_empty() || shrink_factor >= 1.0 {
        return vertices
            .iter()
            .map(|vertex| (vertex[0], vertex[1]))
            .collect();
    }
    let center = vertices.iter().fold([0.0, 0.0], |acc, vertex| {
        [acc[0] + vertex[0], acc[1] + vertex[1]]
    });
    let center = [
        center[0] / vertices.len() as f64,
        center[1] / vertices.len() as f64,
    ];
    vertices
        .iter()
        .map(|vertex| {
            (
                center[0] + (vertex[0] - center[0]) * shrink_factor,
                center[1] + (vertex[1] - center[1]) * shrink_factor,
            )
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn draw_legend_shapes(
    root: &DrawingArea<BitMapBackend<'_>, plotters::coord::Shift>,
    legend_left: i32,
    image_height: i32,
    metric: CrossSectionQualityMetric,
    color_scale: CrossSectionImageColorScale,
    min: f32,
    max: f32,
    total_count: usize,
    visible_count: usize,
    labels: &mut Vec<ImageLabel>,
) -> Result<(), ApiError> {
    root.draw(&Rectangle::new(
        [(legend_left, 0), (legend_left + 170, image_height)],
        ShapeStyle::from(&RGBColor(239, 242, 247)).filled(),
    ))
    .map_err(plotters_error("fill legend"))?;
    root.draw(&PathElement::new(
        vec![(legend_left, 0), (legend_left, image_height)],
        ShapeStyle::from(&DEFAULT_GRID).stroke_width(1),
    ))
    .map_err(plotters_error("draw legend divider"))?;

    labels.push(ImageLabel {
        text: "Quality".to_string(),
        x: legend_left + 16,
        y: 24,
        scale: 1,
        color: rgb_bytes(DEFAULT_FOREGROUND),
    });
    labels.push(ImageLabel {
        text: metric.as_str().to_string(),
        x: legend_left + 16,
        y: 46,
        scale: 1,
        color: rgb_bytes(DEFAULT_FOREGROUND),
    });

    let bar_left = legend_left + 24;
    let bar_right = legend_left + 64;
    let bar_top = 84;
    let bar_bottom = image_height.saturating_sub(188).clamp(220, 520);
    let steps = (bar_bottom - bar_top).max(1);
    for step in 0..steps {
        let t = 1.0 - step as f64 / (steps - 1).max(1) as f64;
        let color = color_for_scale(t, color_scale);
        root.draw(&Rectangle::new(
            [(bar_left, bar_top + step), (bar_right, bar_top + step + 1)],
            ShapeStyle::from(&color).filled(),
        ))
        .map_err(plotters_error("draw legend bar"))?;
    }
    root.draw(&Rectangle::new(
        [(bar_left, bar_top), (bar_right, bar_bottom)],
        ShapeStyle::from(&DEFAULT_FOREGROUND).stroke_width(1),
    ))
    .map_err(plotters_error("draw legend border"))?;

    let mid = min + (max - min) * 0.5;
    for (text, y) in [
        (format_number(max), bar_top),
        (format_number(mid), (bar_top + bar_bottom) / 2),
        (format_number(min), bar_bottom),
    ] {
        labels.push(ImageLabel {
            text,
            x: legend_left + 76,
            y: y + 2,
            scale: 1,
            color: rgb_bytes(DEFAULT_FOREGROUND),
        });
    }
    labels.push(ImageLabel {
        text: format!("scale: {}", color_scale.as_str()),
        x: legend_left + 16,
        y: bar_bottom + 36,
        scale: 1,
        color: rgb_bytes(DEFAULT_FOREGROUND),
    });
    labels.push(ImageLabel {
        text: format!("polygons: {visible_count}/{total_count}"),
        x: legend_left + 16,
        y: bar_bottom + 56,
        scale: 1,
        color: rgb_bytes(DEFAULT_FOREGROUND),
    });
    Ok(())
}

fn format_number(value: f32) -> String {
    if value.abs() >= 1.0e3 || (value != 0.0 && value.abs() < 1.0e-2) {
        format!("{value:.3e}")
    } else {
        format!("{value:.4}")
    }
}

fn quality_range(values: &[f32]) -> Option<(f32, f32)> {
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    for value in values.iter().copied().filter(|value| value.is_finite()) {
        min = min.min(value);
        max = max.max(value);
    }
    (min.is_finite() && max.is_finite()).then_some(if (max - min).abs() <= f32::EPSILON {
        let pad = min.abs().max(1.0) * 0.5;
        (min - pad, max + pad)
    } else {
        (min, max)
    })
}

#[derive(Debug, Clone, Copy)]
enum NumericFilter {
    All,
    LessThan(f64),
    LessThanOrEqual(f64),
    GreaterThan(f64),
    GreaterThanOrEqual(f64),
}

impl NumericFilter {
    fn matches(self, value: f64) -> bool {
        match self {
            Self::All => true,
            Self::LessThan(threshold) => value < threshold,
            Self::LessThanOrEqual(threshold) => value <= threshold,
            Self::GreaterThan(threshold) => value > threshold,
            Self::GreaterThanOrEqual(threshold) => value >= threshold,
        }
    }
}

fn parse_filter_expression(raw: Option<&str>) -> Result<NumericFilter, ApiError> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(NumericFilter::All);
    };
    let (operator, rest) = if let Some(rest) = raw.strip_prefix("<=") {
        ("<=", rest)
    } else if let Some(rest) = raw.strip_prefix(">=") {
        (">=", rest)
    } else if let Some(rest) = raw.strip_prefix('<') {
        ("<", rest)
    } else if let Some(rest) = raw.strip_prefix('>') {
        (">", rest)
    } else {
        return Err(ApiError::bad_request(
            "invalid_query: filter_expression must start with <, <=, >, or >=",
        ));
    };
    let threshold = rest.trim().parse::<f64>().map_err(|_| {
        ApiError::bad_request("invalid_query: filter_expression threshold must be numeric")
    })?;
    if !threshold.is_finite() {
        return Err(ApiError::bad_request(
            "invalid_query: filter_expression threshold must be finite",
        ));
    }
    Ok(match operator {
        "<" => NumericFilter::LessThan(threshold),
        "<=" => NumericFilter::LessThanOrEqual(threshold),
        ">" => NumericFilter::GreaterThan(threshold),
        ">=" => NumericFilter::GreaterThanOrEqual(threshold),
        _ => NumericFilter::All,
    })
}

fn color_for_scale(t: f64, scale: CrossSectionImageColorScale) -> RGBColor {
    let t = t.clamp(0.0, 1.0);
    match scale {
        CrossSectionImageColorScale::Jet => interpolate_stops(
            t,
            &[
                (0.0, [0.0, 0.0, 128.0]),
                (0.35, [0.0, 180.0, 255.0]),
                (0.5, [75.0, 255.0, 75.0]),
                (0.75, [255.0, 220.0, 0.0]),
                (1.0, [180.0, 0.0, 0.0]),
            ],
        ),
        CrossSectionImageColorScale::Viridis => interpolate_stops(
            t,
            &[
                (0.0, [68.0, 1.0, 84.0]),
                (0.25, [59.0, 82.0, 139.0]),
                (0.5, [33.0, 145.0, 140.0]),
                (0.75, [94.0, 201.0, 98.0]),
                (1.0, [253.0, 231.0, 37.0]),
            ],
        ),
        CrossSectionImageColorScale::Hot => interpolate_stops(
            t,
            &[
                (0.0, [0.0, 0.0, 0.0]),
                (0.35, [230.0, 0.0, 0.0]),
                (0.7, [255.0, 180.0, 0.0]),
                (1.0, [255.0, 255.0, 230.0]),
            ],
        ),
        CrossSectionImageColorScale::Coolwarm => interpolate_stops(
            t,
            &[
                (0.0, [59.0, 76.0, 192.0]),
                (0.5, [238.0, 238.0, 238.0]),
                (1.0, [180.0, 4.0, 38.0]),
            ],
        ),
    }
}

fn interpolate_stops(t: f64, stops: &[(f64, [f64; 3])]) -> RGBColor {
    for pair in stops.windows(2) {
        let (left_t, left_rgb) = pair[0];
        let (right_t, right_rgb) = pair[1];
        if t <= right_t {
            let local = ((t - left_t) / (right_t - left_t)).clamp(0.0, 1.0);
            return RGBColor(
                lerp_u8(left_rgb[0], right_rgb[0], local),
                lerp_u8(left_rgb[1], right_rgb[1], local),
                lerp_u8(left_rgb[2], right_rgb[2], local),
            );
        }
    }
    let last = stops.last().map(|(_, rgb)| *rgb).unwrap_or([0.0, 0.0, 0.0]);
    RGBColor(last[0] as u8, last[1] as u8, last[2] as u8)
}

fn lerp_u8(a: f64, b: f64, t: f64) -> u8 {
    (a + (b - a) * t).round().clamp(0.0, 255.0) as u8
}

fn rgb_bytes(color: RGBColor) -> [u8; 3] {
    [color.0, color.1, color.2]
}

fn draw_text_5x7(
    rgb: &mut [u8],
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    text: &str,
    scale: u32,
    color: [u8; 3],
) {
    let scale = scale.max(1) as i32;
    let mut cursor_x = x;
    for ch in text.to_ascii_uppercase().chars() {
        if ch == '\n' {
            cursor_x = x;
            continue;
        }
        if ch == ' ' {
            cursor_x += 4 * scale;
            continue;
        }
        let glyph = glyph_5x7(ch);
        for (row, bits) in glyph.iter().copied().enumerate() {
            for col in 0..5 {
                if bits & (1 << (4 - col)) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        set_rgb_pixel(
                            rgb,
                            width,
                            height,
                            cursor_x + col * scale + dx,
                            y + row as i32 * scale + dy,
                            color,
                        );
                    }
                }
            }
        }
        cursor_x += 6 * scale;
    }
}

fn set_rgb_pixel(rgb: &mut [u8], width: u32, height: u32, x: i32, y: i32, color: [u8; 3]) {
    if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
        return;
    }
    let offset = (y as usize * width as usize + x as usize) * 3;
    rgb[offset] = color[0];
    rgb[offset + 1] = color[1];
    rgb[offset + 2] = color[2];
}

fn glyph_5x7(ch: char) -> [u8; 7] {
    match ch {
        'A' => [
            0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'B' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110,
        ],
        'C' => [
            0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110,
        ],
        'D' => [
            0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110,
        ],
        'E' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
        ],
        'F' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'G' => [
            0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110,
        ],
        'H' => [
            0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'I' => [
            0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111,
        ],
        'J' => [
            0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100,
        ],
        'K' => [
            0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001,
        ],
        'L' => [
            0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111,
        ],
        'M' => [
            0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001,
        ],
        'N' => [
            0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001,
        ],
        'O' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'P' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'Q' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101,
        ],
        'R' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
        ],
        'S' => [
            0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        'T' => [
            0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'U' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'V' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100,
        ],
        'W' => [
            0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010,
        ],
        'X' => [
            0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001,
        ],
        'Y' => [
            0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'Z' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111,
        ],
        '0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        '1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        '2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        '3' => [
            0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        '4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        '5' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110,
        ],
        '6' => [
            0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        '7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        '8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        '9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110,
        ],
        '-' => [
            0b00000, 0b00000, 0b00000, 0b11110, 0b00000, 0b00000, 0b00000,
        ],
        '_' => [
            0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b11111,
        ],
        '.' => [
            0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100,
        ],
        ':' => [
            0b00000, 0b01100, 0b01100, 0b00000, 0b01100, 0b01100, 0b00000,
        ],
        '/' => [
            0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000,
        ],
        '%' => [
            0b11001, 0b11010, 0b00100, 0b01000, 0b10110, 0b00110, 0b00000,
        ],
        '(' => [
            0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010,
        ],
        ')' => [
            0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000,
        ],
        '<' => [
            0b00010, 0b00100, 0b01000, 0b10000, 0b01000, 0b00100, 0b00010,
        ],
        '>' => [
            0b01000, 0b00100, 0b00010, 0b00001, 0b00010, 0b00100, 0b01000,
        ],
        '=' => [
            0b00000, 0b00000, 0b11111, 0b00000, 0b11111, 0b00000, 0b00000,
        ],
        '+' => [
            0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000,
        ],
        _ => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b00100, 0b00000, 0b00100,
        ],
    }
}

fn encode_rgb_png(width: u32, height: u32, rgb: &[u8]) -> Result<Vec<u8>, ApiError> {
    if rgb.len() != width as usize * height as usize * 3 {
        return Err(ApiError::internal(
            "cross-section image RGB buffer length does not match image size",
        ));
    }
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| ApiError::internal(format!("cross-section image png: {error}")))?;
    writer
        .write_image_data(rgb)
        .map_err(|error| ApiError::internal(format!("cross-section image png: {error}")))?;
    drop(writer);
    Ok(bytes)
}

fn plotters_error<E: std::fmt::Debug>(context: &'static str) -> impl Fn(E) -> ApiError {
    move |error| ApiError::internal(format!("cross-section image {context}: {error:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fem_slice_overlay::{
        FemSliceOverlay, SliceOverlayBounds, SliceOverlayPoint, SliceOverlayPointKind,
        SliceOverlayPolygon, SliceOverlaySegment,
    };
    use crate::field_slice::SlicePlane;

    #[test]
    fn renders_png_magic_for_simple_overlay() {
        let overlay = FemSliceOverlay {
            bounds: SliceOverlayBounds {
                u_min: 0.0,
                u_max: 1.0,
                v_min: 0.0,
                v_max: 1.0,
            },
            cut_norm: 0.5,
            cut_world: 0.0,
            normal_axis: "z",
            plane: SlicePlane::Xy,
            polygons: vec![SliceOverlayPolygon {
                parent_element_id: 0,
                points: vec![point([0.1, 0.1]), point([0.9, 0.1]), point([0.5, 0.9])],
                vertices: vec![[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]],
            }],
            segments: vec![SliceOverlaySegment {
                a: [0.1, 0.1],
                b: [0.9, 0.1],
            }],
            u_axis: "x",
            v_axis: "y",
        };

        let png = render_cross_section_png(
            &overlay,
            &[0.5],
            CrossSectionImageRenderOptions {
                color_scale: CrossSectionImageColorScale::Viridis,
                legend: true,
                metric: CrossSectionQualityMetric::Volume,
                resolution: 512,
                rotation_degrees: 0.0,
                shrink_factor: 1.0,
                wireframe: true,
            },
            None,
        )
        .unwrap();

        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    fn point(uv: [f64; 2]) -> SliceOverlayPoint {
        SliceOverlayPoint {
            edge_node_ids: [0, 1],
            edge_t: 0.5,
            kind: SliceOverlayPointKind::EdgeIntersection,
            uv,
            world: [uv[0], uv[1], 0.0],
        }
    }
}
