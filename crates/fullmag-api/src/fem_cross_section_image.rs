use serde::Deserialize;

use crate::error::ApiError;
use crate::fem_cross_section::CrossSectionQualityMetric;
use crate::fem_slice_overlay::{FemSliceOverlay, SliceOverlayBounds};

const MIN_SHRINK_FACTOR: f64 = 0.5;
const MAX_SHRINK_FACTOR: f64 = 1.0;
const MIN_EDGE_WIDTH: f64 = 0.5;
const MAX_EDGE_WIDTH: f64 = 4.0;
const MIN_DPR: f64 = 1.0;
const MAX_DPR: f64 = 2.0;
const MARGIN_LEFT: f64 = 72.0;
const MARGIN_RIGHT: f64 = 24.0;
const MARGIN_TOP: f64 = 48.0;
const MARGIN_BOTTOM: f64 = 64.0;
const LEGEND_WIDTH: f64 = 160.0;

const FONT_SIZE_TITLE: f32 = 16.0;
const FONT_SIZE_LABEL: f32 = 12.0;
const FONT_SIZE_TICK: f32 = 11.0;
const FONT_SIZE_LEGEND: f32 = 11.0;
const FONT_SIZE_LEGEND_TITLE: f32 = 13.0;

const BG_COLOR: [u8; 4] = [248, 249, 252, 255];
const PLOT_BG_COLOR: [u8; 4] = [255, 255, 255, 255];
const FRAME_COLOR: [u8; 4] = [28, 31, 38, 255];
const GRID_COLOR: [u8; 4] = [207, 214, 224, 128];
const WIREFRAME_COLOR: [u8; 4] = [20, 24, 32, 255];
const LEGEND_BG_COLOR: [u8; 4] = [239, 242, 247, 255];
const TEXT_COLOR: [u8; 4] = [28, 31, 38, 255];

static FONT_DATA: &[u8] = include_bytes!("../resources/DejaVuSans.ttf");

#[derive(Debug, Clone, Copy, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CrossSectionImageColorScale {
    Jet,
    Viridis,
    Hot,
    Coolwarm,
    Plasma,
    Inferno,
}

impl CrossSectionImageColorScale {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Jet => "jet",
            Self::Viridis => "viridis",
            Self::Hot => "hot",
            Self::Coolwarm => "coolwarm",
            Self::Plasma => "plasma",
            Self::Inferno => "inferno",
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
    pub edge_width: f64,
    pub dpr: f64,
}

pub(crate) struct RenderedImage {
    pub png_bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy)]
struct PlotTransform {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    u_min: f64,
    v_max: f64,
    scale: f64,
}

#[derive(Debug, Clone)]
struct RenderPolygon {
    vertices: Vec<[f64; 2]>,
}



#[derive(Debug, Clone)]
struct RenderGeometry {
    bounds: SliceOverlayBounds,
    polygons: Vec<RenderPolygon>,
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
        let bounds = bounds_for_polygons(&polygons).unwrap_or(overlay.bounds);
        Self {
            bounds,
            polygons,
        }
    }
}

impl PlotTransform {
    fn new(bounds: SliceOverlayBounds, available_width: f64, available_height: f64) -> Self {
        let u_span = (bounds.u_max - bounds.u_min).abs().max(f64::EPSILON);
        let v_span = (bounds.v_max - bounds.v_min).abs().max(f64::EPSILON);
        let scale = (available_width / u_span).min(available_height / v_span);
        let width = (u_span * scale).max(1.0);
        let height = (v_span * scale).max(1.0);
        let left = MARGIN_LEFT + (available_width - width) * 0.5;
        let top = MARGIN_TOP + (available_height - height) * 0.5;
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

    fn right(self) -> f64 {
        self.left + self.width
    }

    fn bottom(self) -> f64 {
        self.top + self.height
    }

    fn point(self, u: f64, v: f64) -> (f32, f32) {
        let x = self.left + (u - self.u_min) * self.scale;
        let y = self.top + (self.v_max - v) * self.scale;
        (x as f32, y as f32)
    }
}

pub(crate) fn validate_cross_section_image_query(
    position_percent: f64,
    resolution: u32,
    rotation_degrees: f64,
    shrink_factor: f64,
    edge_width: f64,
    dpr: f64,
) -> Result<(), ApiError> {
    if !position_percent.is_finite() || !(0.0..=100.0).contains(&position_percent) {
        return Err(ApiError::bad_request(
            "invalid_query: position_percent must be finite and in [0, 100]",
        ));
    }
    if resolution < 256 || resolution > 8192 {
        return Err(ApiError::bad_request(
            "invalid_query: resolution must be in [256, 8192]",
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
    if !edge_width.is_finite() || !(MIN_EDGE_WIDTH..=MAX_EDGE_WIDTH).contains(&edge_width) {
        return Err(ApiError::bad_request(
            "invalid_query: edge_width must be finite and in [0.5, 4.0]",
        ));
    }
    if !dpr.is_finite() || !(MIN_DPR..=MAX_DPR).contains(&dpr) {
        return Err(ApiError::bad_request(
            "invalid_query: dpr must be finite and in [1.0, 2.0]",
        ));
    }
    Ok(())
}

pub(crate) fn render_cross_section_png(
    overlay: &FemSliceOverlay,
    quality_values: &[f32],
    options: CrossSectionImageRenderOptions,
    filter_expression: Option<&str>,
) -> Result<RenderedImage, ApiError> {
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
    let lut = build_color_lut(options.color_scale);

    let geometry = RenderGeometry::from_overlay(overlay, options.rotation_degrees);
    let bounds = padded_bounds(geometry.bounds);

    // Compute physical aspect ratio for non-square images.
    let u_span = (bounds.u_max - bounds.u_min).abs().max(f64::EPSILON);
    let v_span = (bounds.v_max - bounds.v_min).abs().max(f64::EPSILON);
    let aspect = (u_span / v_span).clamp(0.25, 4.0);

    let legend_w = if options.legend { LEGEND_WIDTH } else { 0.0 };
    let base_res = options.resolution as f64;
    let dpr = options.dpr.clamp(MIN_DPR, MAX_DPR);

    // Compute logical image size, then scale by DPR for actual pixel size.
    let (logical_w, logical_h) = if aspect >= 1.0 {
        (base_res, (base_res - legend_w - MARGIN_LEFT - MARGIN_RIGHT) / aspect + MARGIN_TOP + MARGIN_BOTTOM)
    } else {
        ((base_res - MARGIN_TOP - MARGIN_BOTTOM) * aspect + MARGIN_LEFT + MARGIN_RIGHT + legend_w, base_res)
    };
    let logical_w = logical_w.max(256.0);
    let logical_h = logical_h.max(256.0);

    let pixel_w = (logical_w * dpr).round() as u32;
    let pixel_h = (logical_h * dpr).round() as u32;
    let scale_factor = dpr as f32;

    let mut pixmap = tiny_skia::Pixmap::new(pixel_w, pixel_h)
        .ok_or_else(|| ApiError::internal("failed to create cross-section image pixmap"))?;

    // Fill background
    pixmap.fill(tiny_skia::Color::from_rgba8(BG_COLOR[0], BG_COLOR[1], BG_COLOR[2], BG_COLOR[3]));

    let font = fontdue::Font::from_bytes(FONT_DATA, fontdue::FontSettings::default())
        .map_err(|err| ApiError::internal(format!("failed to load font: {err}")))?;

    let plot_available_w = logical_w - MARGIN_LEFT - MARGIN_RIGHT - legend_w;
    let plot_available_h = logical_h - MARGIN_TOP - MARGIN_BOTTOM;
    let transform = PlotTransform::new(bounds, plot_available_w, plot_available_h);

    // Draw plot background
    fill_rect(
        &mut pixmap,
        transform.left as f32 * scale_factor,
        transform.top as f32 * scale_factor,
        transform.width as f32 * scale_factor,
        transform.height as f32 * scale_factor,
        PLOT_BG_COLOR,
    );

    // Draw grid lines
    draw_grid(&mut pixmap, &transform, scale_factor, &bounds, &font);

    // Draw filled polygons with per-polygon stroke
    let span = (max - min).abs().max(f32::EPSILON);
    let user_edge_width_px = (options.edge_width * dpr) as f32;

    // Adaptive wireframe: compute average polygon pixel area and auto-scale
    // edge width and opacity. Dense meshes get thinner, more transparent edges
    // so color fills remain visible (the COMSOL approach).
    let plot_area_px = (transform.width * dpr) * (transform.height * dpr);
    let polygon_count = geometry.polygons.len() as f64;
    let avg_polygon_area_px = if polygon_count > 0.0 {
        plot_area_px / polygon_count
    } else {
        plot_area_px
    };

    // avg_polygon_area_px is the average polygon size in pixels².
    // A triangle with area ~25px² has edges ~7px long → 1.5px stroke is fine.
    // A triangle with area ~4px² has edges ~3px long → 1.5px stroke covers half.
    // We threshold at 25px² as "comfortable" and scale down below that.
    let density_scale = (avg_polygon_area_px / 25.0).sqrt().clamp(0.0, 1.0) as f32;
    let effective_edge_width = (user_edge_width_px * density_scale).max(0.3 * dpr as f32);
    let effective_edge_alpha = if density_scale < 1.0 {
        // For dense meshes, also reduce opacity to let color show through
        (density_scale * 0.8 + 0.2).clamp(0.15, 1.0)
    } else {
        1.0
    };

    // Pre-compute wireframe color with effective alpha
    let wf_alpha = (WIREFRAME_COLOR[3] as f32 * effective_edge_alpha).round() as u8;

    for (polygon, value) in geometry
        .polygons
        .iter()
        .zip(quality_values.iter().copied())
        .filter(|(_, value)| value.is_finite() && filter.matches(*value as f64))
    {
        let local = ((value - min) / span).clamp(0.0, 1.0);
        let fill_color = color_from_lut(&lut, local as f64);

        let shrunk = shrink_vertices(&polygon.vertices, options.shrink_factor);
        if shrunk.len() < 3 {
            continue;
        }

        let mut pb = tiny_skia::PathBuilder::new();
        let (x0, y0) = transform.point(shrunk[0].0, shrunk[0].1);
        pb.move_to(x0 * scale_factor, y0 * scale_factor);
        for &(u, v) in &shrunk[1..] {
            let (x, y) = transform.point(u, v);
            pb.line_to(x * scale_factor, y * scale_factor);
        }
        pb.close();

        if let Some(path) = pb.finish() {
            // Fill
            let mut fill_paint = tiny_skia::Paint::default();
            fill_paint.set_color(tiny_skia::Color::from_rgba8(
                fill_color[0], fill_color[1], fill_color[2], fill_color[3],
            ));
            fill_paint.anti_alias = true;
            pixmap.fill_path(
                &path,
                &fill_paint,
                tiny_skia::FillRule::Winding,
                tiny_skia::Transform::identity(),
                None,
            );

            // Stroke (per-polygon outline)
            if options.wireframe {
                let mut stroke_paint = tiny_skia::Paint::default();
                stroke_paint.set_color(tiny_skia::Color::from_rgba8(
                    WIREFRAME_COLOR[0],
                    WIREFRAME_COLOR[1],
                    WIREFRAME_COLOR[2],
                    wf_alpha,
                ));
                stroke_paint.anti_alias = true;
                let stroke = tiny_skia::Stroke {
                    width: effective_edge_width,
                    line_cap: tiny_skia::LineCap::Round,
                    line_join: tiny_skia::LineJoin::Round,
                    ..Default::default()
                };
                pixmap.stroke_path(
                    &path,
                    &stroke_paint,
                    &stroke,
                    tiny_skia::Transform::identity(),
                    None,
                );
            }
        }
    }

    // Draw plot frame border
    draw_rect_stroke(
        &mut pixmap,
        transform.left as f32 * scale_factor,
        transform.top as f32 * scale_factor,
        transform.width as f32 * scale_factor,
        transform.height as f32 * scale_factor,
        FRAME_COLOR,
        1.5 * scale_factor,
    );

    // Draw title
    let title = format!(
        "{} Cross-Section at {:.3}%",
        overlay.plane.as_str().to_uppercase(),
        overlay.cut_norm * 100.0,
    );
    draw_text(
        &mut pixmap,
        &font,
        &title,
        transform.left as f32 * scale_factor,
        24.0 * scale_factor,
        FONT_SIZE_TITLE * scale_factor,
        TEXT_COLOR,
    );

    // Draw axis labels
    let x_label = format!("{} (m)", overlay.u_axis);
    let x_label_width = measure_text(&font, &x_label, FONT_SIZE_LABEL * scale_factor);
    let x_label_x = (transform.left + transform.width * 0.5) as f32 * scale_factor - x_label_width * 0.5;
    draw_text(
        &mut pixmap,
        &font,
        &x_label,
        x_label_x,
        (transform.bottom() + 42.0) as f32 * scale_factor,
        FONT_SIZE_LABEL * scale_factor,
        TEXT_COLOR,
    );

    let y_label = format!("{} (m)", overlay.v_axis);
    draw_text_vertical(
        &mut pixmap,
        &font,
        &y_label,
        16.0 * scale_factor,
        (transform.top + transform.height * 0.5) as f32 * scale_factor,
        FONT_SIZE_LABEL * scale_factor,
        TEXT_COLOR,
    );

    // Draw legend
    if options.legend {
        draw_legend(
            &mut pixmap,
            &font,
            (logical_w - LEGEND_WIDTH) as f32 * scale_factor,
            logical_h as f32 * scale_factor,
            scale_factor,
            options.metric,
            options.color_scale,
            &lut,
            min,
            max,
            overlay.polygons.len(),
            filtered_values.len(),
        );
    }

    let png_bytes = encode_pixmap_png(&pixmap)?;
    Ok(RenderedImage {
        png_bytes,
        width: pixel_w,
        height: pixel_h,
    })
}

// --- Drawing helpers ---

fn fill_rect(pixmap: &mut tiny_skia::Pixmap, x: f32, y: f32, w: f32, h: f32, color: [u8; 4]) {
    let rect = match tiny_skia::Rect::from_xywh(x, y, w, h) {
        Some(r) => r,
        None => return,
    };
    let mut paint = tiny_skia::Paint::default();
    paint.set_color(tiny_skia::Color::from_rgba8(color[0], color[1], color[2], color[3]));
    pixmap.fill_rect(rect, &paint, tiny_skia::Transform::identity(), None);
}

fn draw_rect_stroke(
    pixmap: &mut tiny_skia::Pixmap,
    x: f32, y: f32, w: f32, h: f32,
    color: [u8; 4],
    width: f32,
) {
    let mut pb = tiny_skia::PathBuilder::new();
    pb.move_to(x, y);
    pb.line_to(x + w, y);
    pb.line_to(x + w, y + h);
    pb.line_to(x, y + h);
    pb.close();
    if let Some(path) = pb.finish() {
        let mut paint = tiny_skia::Paint::default();
        paint.set_color(tiny_skia::Color::from_rgba8(color[0], color[1], color[2], color[3]));
        paint.anti_alias = true;
        let stroke = tiny_skia::Stroke {
            width,
            ..Default::default()
        };
        pixmap.stroke_path(&path, &paint, &stroke, tiny_skia::Transform::identity(), None);
    }
}

fn draw_line(
    pixmap: &mut tiny_skia::Pixmap,
    x1: f32, y1: f32, x2: f32, y2: f32,
    color: [u8; 4],
    width: f32,
) {
    let mut pb = tiny_skia::PathBuilder::new();
    pb.move_to(x1, y1);
    pb.line_to(x2, y2);
    if let Some(path) = pb.finish() {
        let mut paint = tiny_skia::Paint::default();
        paint.set_color(tiny_skia::Color::from_rgba8(color[0], color[1], color[2], color[3]));
        paint.anti_alias = true;
        let stroke = tiny_skia::Stroke {
            width,
            ..Default::default()
        };
        pixmap.stroke_path(&path, &paint, &stroke, tiny_skia::Transform::identity(), None);
    }
}

fn draw_grid(
    pixmap: &mut tiny_skia::Pixmap,
    transform: &PlotTransform,
    scale_factor: f32,
    bounds: &SliceOverlayBounds,
    font: &fontdue::Font,
) {
    let u_span = bounds.u_max - bounds.u_min;
    let v_span = bounds.v_max - bounds.v_min;

    for i in 0..=4 {
        let frac = i as f64 / 4.0;

        // Vertical grid line
        let x = (transform.left + transform.width * frac) as f32 * scale_factor;
        draw_line(
            pixmap,
            x, transform.top as f32 * scale_factor,
            x, transform.bottom() as f32 * scale_factor,
            GRID_COLOR,
            1.0 * scale_factor,
        );
        // Tick label at bottom
        let u_val = bounds.u_min + u_span * frac;
        let tick_text = format_si_value(u_val);
        let tw = measure_text(font, &tick_text, FONT_SIZE_TICK * scale_factor);
        draw_text(
            pixmap,
            font,
            &tick_text,
            x - tw * 0.5,
            (transform.bottom() + 14.0) as f32 * scale_factor,
            FONT_SIZE_TICK * scale_factor,
            TEXT_COLOR,
        );

        // Horizontal grid line
        let y = (transform.top + transform.height * frac) as f32 * scale_factor;
        draw_line(
            pixmap,
            transform.left as f32 * scale_factor, y,
            transform.right() as f32 * scale_factor, y,
            GRID_COLOR,
            1.0 * scale_factor,
        );
        // Tick label at left
        let v_val = bounds.v_max - v_span * frac;
        let tick_text = format_si_value(v_val);
        let tw = measure_text(font, &tick_text, FONT_SIZE_TICK * scale_factor);
        draw_text(
            pixmap,
            font,
            &tick_text,
            (transform.left - 8.0) as f32 * scale_factor - tw,
            y - FONT_SIZE_TICK * scale_factor * 0.35,
            FONT_SIZE_TICK * scale_factor,
            TEXT_COLOR,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_legend(
    pixmap: &mut tiny_skia::Pixmap,
    font: &fontdue::Font,
    legend_left: f32,
    image_height: f32,
    scale_factor: f32,
    metric: CrossSectionQualityMetric,
    color_scale: CrossSectionImageColorScale,
    lut: &[[u8; 4]; 256],
    min: f32,
    max: f32,
    total_count: usize,
    visible_count: usize,
) {
    // Legend background
    fill_rect(pixmap, legend_left, 0.0, LEGEND_WIDTH as f32 * scale_factor, image_height, LEGEND_BG_COLOR);
    // Divider line
    draw_line(pixmap, legend_left, 0.0, legend_left, image_height, [207, 214, 224, 255], 1.0 * scale_factor);

    // Title
    draw_text(pixmap, font, "Quality", legend_left + 16.0 * scale_factor, 28.0 * scale_factor, FONT_SIZE_LEGEND_TITLE * scale_factor, TEXT_COLOR);
    draw_text(pixmap, font, metric.as_str(), legend_left + 16.0 * scale_factor, 48.0 * scale_factor, FONT_SIZE_LEGEND * scale_factor, TEXT_COLOR);

    // Color bar
    let bar_left = legend_left + 20.0 * scale_factor;
    let bar_right = legend_left + 52.0 * scale_factor;
    let bar_width = bar_right - bar_left;
    let bar_top = 80.0 * scale_factor;
    let bar_bottom = (image_height - 160.0 * scale_factor).clamp(bar_top + 100.0 * scale_factor, bar_top + 500.0 * scale_factor);
    let bar_height = bar_bottom - bar_top;
    let steps = (bar_height as usize).max(1);

    for step in 0..steps {
        let t = 1.0 - step as f64 / (steps.max(1) - 1).max(1) as f64;
        let color = color_from_lut(lut, t);
        let y = bar_top + step as f32;
        fill_rect(pixmap, bar_left, y, bar_width, 1.5, color);
    }

    // Color bar border
    draw_rect_stroke(pixmap, bar_left, bar_top, bar_width, bar_height, FRAME_COLOR, 1.0 * scale_factor);

    // Tick labels on colorbar
    let mid = min + (max - min) * 0.5;
    for (text, y) in [
        (format_number(max), bar_top),
        (format_number(mid), bar_top + bar_height * 0.5),
        (format_number(min), bar_bottom),
    ] {
        draw_text(
            pixmap,
            font,
            &text,
            bar_right + 8.0 * scale_factor,
            y - FONT_SIZE_LEGEND * scale_factor * 0.3,
            FONT_SIZE_LEGEND * scale_factor,
            TEXT_COLOR,
        );
    }

    // Stats
    let stats_y = bar_bottom + 30.0 * scale_factor;
    draw_text(pixmap, font, &format!("scale: {}", color_scale.as_str()), legend_left + 16.0 * scale_factor, stats_y, FONT_SIZE_LEGEND * scale_factor, TEXT_COLOR);
    draw_text(pixmap, font, &format!("polygons: {}/{}", visible_count, total_count), legend_left + 16.0 * scale_factor, stats_y + 20.0 * scale_factor, FONT_SIZE_LEGEND * scale_factor, TEXT_COLOR);
}

// --- Text rendering with fontdue ---

fn draw_text(
    pixmap: &mut tiny_skia::Pixmap,
    font: &fontdue::Font,
    text: &str,
    x: f32, y: f32,
    size: f32,
    color: [u8; 4],
) {
    let mut cursor_x = x;
    for ch in text.chars() {
        if ch == ' ' {
            cursor_x += size * 0.35;
            continue;
        }
        let (metrics, bitmap) = font.rasterize(ch, size);
        if metrics.width == 0 || metrics.height == 0 {
            cursor_x += metrics.advance_width;
            continue;
        }
        let gx = cursor_x + metrics.xmin as f32;
        let gy = y - metrics.ymin as f32 - metrics.height as f32 + size * 0.85;
        composite_glyph(pixmap, &bitmap, metrics.width, metrics.height, gx, gy, color);
        cursor_x += metrics.advance_width;
    }
}

fn draw_text_vertical(
    pixmap: &mut tiny_skia::Pixmap,
    font: &fontdue::Font,
    text: &str,
    x: f32, center_y: f32,
    size: f32,
    color: [u8; 4],
) {
    // Render text horizontally into a temporary pixmap, then blit rotated
    let total_width = measure_text(font, text, size);
    let total_height = size * 1.4;
    let tw = total_width.ceil() as u32 + 4;
    let th = total_height.ceil() as u32 + 4;
    if tw == 0 || th == 0 || tw > 2048 || th > 2048 {
        return;
    }
    let mut temp = match tiny_skia::Pixmap::new(tw, th) {
        Some(p) => p,
        None => return,
    };
    draw_text(&mut temp, font, text, 2.0, size * 0.9, size, color);

    // Rotate 90° CCW and blit to main pixmap
    let dest_x = x;
    let dest_y_start = center_y - total_width * 0.5;
    let pw = pixmap.width() as i32;
    let ph = pixmap.height() as i32;
    let pixels = pixmap.pixels_mut();
    let temp_pixels = temp.pixels();

    for ty in 0..th as i32 {
        for tx in 0..tw as i32 {
            let src_idx = (ty * tw as i32 + tx) as usize;
            if src_idx >= temp_pixels.len() {
                continue;
            }
            let src = temp_pixels[src_idx];
            let alpha = src.alpha();
            if alpha == 0 {
                continue;
            }
            // Rotate 90° CCW: (tx, ty) -> (ty, tw-1-tx)
            let dx = dest_x as i32 + ty;
            let dy = dest_y_start as i32 + (tw as i32 - 1 - tx);
            if dx < 0 || dy < 0 || dx >= pw || dy >= ph {
                continue;
            }
            let dst_idx = (dy * pw + dx) as usize;
            if dst_idx >= pixels.len() {
                continue;
            }
            let dst = pixels[dst_idx];
            let a = alpha as u16;
            let ia = 255 - a;
            let r = ((src.red() as u16 * a + dst.red() as u16 * ia) / 255) as u8;
            let g = ((src.green() as u16 * a + dst.green() as u16 * ia) / 255) as u8;
            let b = ((src.blue() as u16 * a + dst.blue() as u16 * ia) / 255) as u8;
            let out_a = (a + (dst.alpha() as u16 * ia / 255)).min(255) as u8;
            pixels[dst_idx] = tiny_skia::PremultipliedColorU8::from_rgba(r, g, b, out_a).unwrap_or(dst);
        }
    }
}

fn measure_text(font: &fontdue::Font, text: &str, size: f32) -> f32 {
    let mut width = 0.0f32;
    for ch in text.chars() {
        if ch == ' ' {
            width += size * 0.35;
            continue;
        }
        let metrics = font.metrics(ch, size);
        width += metrics.advance_width;
    }
    width
}

fn composite_glyph(
    pixmap: &mut tiny_skia::Pixmap,
    bitmap: &[u8],
    gw: usize, gh: usize,
    x: f32, y: f32,
    color: [u8; 4],
) {
    let pw = pixmap.width() as i32;
    let ph = pixmap.height() as i32;
    let pixels = pixmap.pixels_mut();

    for row in 0..gh {
        for col in 0..gw {
            let alpha = bitmap[row * gw + col] as u16;
            if alpha == 0 {
                continue;
            }
            let alpha = (alpha * color[3] as u16) / 255;
            let px = x as i32 + col as i32;
            let py = y as i32 + row as i32;
            if px < 0 || py < 0 || px >= pw || py >= ph {
                continue;
            }
            let idx = (py * pw + px) as usize;
            let dst = pixels[idx];
            let ia = 255 - alpha;
            let r = ((color[0] as u16 * alpha + dst.red() as u16 * ia) / 255) as u8;
            let g = ((color[1] as u16 * alpha + dst.green() as u16 * ia) / 255) as u8;
            let b = ((color[2] as u16 * alpha + dst.blue() as u16 * ia) / 255) as u8;
            let a = (alpha + (dst.alpha() as u16 * ia / 255)).min(255) as u8;
            if let Some(c) = tiny_skia::PremultipliedColorU8::from_rgba(r, g, b, a) {
                pixels[idx] = c;
            }
        }
    }
}

// --- Geometry helpers ---

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

fn bounds_for_polygons(
    polygons: &[RenderPolygon],
) -> Option<SliceOverlayBounds> {
    let mut u_min = f64::INFINITY;
    let mut u_max = f64::NEG_INFINITY;
    let mut v_min = f64::INFINITY;
    let mut v_max = f64::NEG_INFINITY;
    let mut seen = false;

    for point in polygons
        .iter()
        .flat_map(|polygon| polygon.vertices.iter().copied())
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

// --- Color scales with 256-entry LUTs ---

fn build_color_lut(scale: CrossSectionImageColorScale) -> [[u8; 4]; 256] {
    let stops: &[(f64, [f64; 3])] = match scale {
        CrossSectionImageColorScale::Jet => &[
            (0.0, [0.0, 0.0, 128.0]),
            (0.11, [0.0, 0.0, 255.0]),
            (0.35, [0.0, 180.0, 255.0]),
            (0.5, [75.0, 255.0, 75.0]),
            (0.65, [255.0, 255.0, 0.0]),
            (0.75, [255.0, 220.0, 0.0]),
            (0.89, [255.0, 0.0, 0.0]),
            (1.0, [128.0, 0.0, 0.0]),
        ],
        CrossSectionImageColorScale::Viridis => &[
            (0.0, [68.0, 1.0, 84.0]),
            (0.13, [72.0, 35.0, 116.0]),
            (0.25, [59.0, 82.0, 139.0]),
            (0.38, [44.0, 114.0, 142.0]),
            (0.5, [33.0, 145.0, 140.0]),
            (0.63, [39.0, 173.0, 129.0]),
            (0.75, [94.0, 201.0, 98.0]),
            (0.88, [170.0, 220.0, 50.0]),
            (1.0, [253.0, 231.0, 37.0]),
        ],
        CrossSectionImageColorScale::Hot => &[
            (0.0, [0.0, 0.0, 0.0]),
            (0.33, [230.0, 0.0, 0.0]),
            (0.66, [255.0, 200.0, 0.0]),
            (1.0, [255.0, 255.0, 230.0]),
        ],
        CrossSectionImageColorScale::Coolwarm => &[
            (0.0, [59.0, 76.0, 192.0]),
            (0.25, [120.0, 154.0, 227.0]),
            (0.5, [238.0, 238.0, 238.0]),
            (0.75, [220.0, 132.0, 107.0]),
            (1.0, [180.0, 4.0, 38.0]),
        ],
        CrossSectionImageColorScale::Plasma => &[
            (0.0, [13.0, 8.0, 135.0]),
            (0.13, [75.0, 3.0, 161.0]),
            (0.25, [125.0, 3.0, 168.0]),
            (0.38, [168.0, 34.0, 150.0]),
            (0.5, [203.0, 70.0, 121.0]),
            (0.63, [229.0, 107.0, 93.0]),
            (0.75, [248.0, 148.0, 65.0]),
            (0.88, [253.0, 195.0, 40.0]),
            (1.0, [240.0, 249.0, 33.0]),
        ],
        CrossSectionImageColorScale::Inferno => &[
            (0.0, [0.0, 0.0, 4.0]),
            (0.13, [22.0, 11.0, 57.0]),
            (0.25, [66.0, 10.0, 104.0]),
            (0.38, [112.0, 25.0, 110.0]),
            (0.5, [159.0, 48.0, 97.0]),
            (0.63, [205.0, 75.0, 69.0]),
            (0.75, [237.0, 121.0, 36.0]),
            (0.88, [251.0, 185.0, 23.0]),
            (1.0, [252.0, 255.0, 164.0]),
        ],
    };

    let mut lut = [[0u8; 4]; 256];
    for (i, entry) in lut.iter_mut().enumerate() {
        let t = i as f64 / 255.0;
        let c = interpolate_stops(t, stops);
        *entry = c;
    }
    lut
}

fn color_from_lut(lut: &[[u8; 4]; 256], t: f64) -> [u8; 4] {
    let idx = (t.clamp(0.0, 1.0) * 255.0).round() as usize;
    lut[idx.min(255)]
}

fn interpolate_stops(t: f64, stops: &[(f64, [f64; 3])]) -> [u8; 4] {
    let t = t.clamp(0.0, 1.0);
    for pair in stops.windows(2) {
        let (left_t, left_rgb) = pair[0];
        let (right_t, right_rgb) = pair[1];
        if t <= right_t {
            let local = ((t - left_t) / (right_t - left_t)).clamp(0.0, 1.0);
            return [
                lerp_u8(left_rgb[0], right_rgb[0], local),
                lerp_u8(left_rgb[1], right_rgb[1], local),
                lerp_u8(left_rgb[2], right_rgb[2], local),
                255,
            ];
        }
    }
    let last = stops.last().map(|(_, rgb)| *rgb).unwrap_or([0.0, 0.0, 0.0]);
    [last[0] as u8, last[1] as u8, last[2] as u8, 255]
}

fn lerp_u8(a: f64, b: f64, t: f64) -> u8 {
    (a + (b - a) * t).round().clamp(0.0, 255.0) as u8
}

// --- Number formatting ---

fn format_number(value: f32) -> String {
    if value.abs() >= 1.0e3 || (value != 0.0 && value.abs() < 1.0e-2) {
        format!("{value:.3e}")
    } else {
        format!("{value:.4}")
    }
}

fn format_si_value(value: f64) -> String {
    let abs = value.abs();
    if abs < 1.0e-15 {
        return "0".to_string();
    }
    if abs >= 1.0 {
        format!("{value:.2}")
    } else if abs >= 1.0e-3 {
        format!("{:.2}m", value * 1.0e3)
    } else if abs >= 1.0e-6 {
        format!("{:.2}μ", value * 1.0e6)
    } else if abs >= 1.0e-9 {
        format!("{:.2}n", value * 1.0e9)
    } else {
        format!("{value:.2e}")
    }
}

// --- Quality filtering ---

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

// --- PNG encoding ---

fn encode_pixmap_png(pixmap: &tiny_skia::Pixmap) -> Result<Vec<u8>, ApiError> {
    let width = pixmap.width();
    let height = pixmap.height();
    // Convert RGBA premultiplied to straight RGBA, then to RGB for PNG.
    let pixels = pixmap.pixels();
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for pixel in pixels {
        let a = pixel.alpha() as u16;
        if a == 0 {
            rgb.push(255);
            rgb.push(255);
            rgb.push(255);
        } else if a == 255 {
            rgb.push(pixel.red());
            rgb.push(pixel.green());
            rgb.push(pixel.blue());
        } else {
            rgb.push(((pixel.red() as u16 * 255) / a).min(255) as u8);
            rgb.push(((pixel.green() as u16 * 255) / a).min(255) as u8);
            rgb.push(((pixel.blue() as u16 * 255) / a).min(255) as u8);
        }
    }
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| ApiError::internal(format!("cross-section image png: {error}")))?;
    writer
        .write_image_data(&rgb)
        .map_err(|error| ApiError::internal(format!("cross-section image png: {error}")))?;
    drop(writer);
    Ok(bytes)
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

        let rendered = render_cross_section_png(
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
                edge_width: 1.5,
                dpr: 1.0,
            },
            None,
        )
        .unwrap();

        assert_eq!(&rendered.png_bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert!(rendered.width > 0);
        assert!(rendered.height > 0);
    }

    #[test]
    fn validate_rejects_invalid_edge_width() {
        assert!(validate_cross_section_image_query(50.0, 1024, 0.0, 1.0, 0.3, 1.0).is_err());
        assert!(validate_cross_section_image_query(50.0, 1024, 0.0, 1.0, 5.0, 1.0).is_err());
        assert!(validate_cross_section_image_query(50.0, 1024, 0.0, 1.0, 1.5, 1.0).is_ok());
    }

    #[test]
    fn validate_rejects_invalid_dpr() {
        assert!(validate_cross_section_image_query(50.0, 1024, 0.0, 1.0, 1.5, 0.5).is_err());
        assert!(validate_cross_section_image_query(50.0, 1024, 0.0, 1.0, 1.5, 3.0).is_err());
        assert!(validate_cross_section_image_query(50.0, 1024, 0.0, 1.0, 1.5, 2.0).is_ok());
    }

    #[test]
    fn non_square_image_for_wide_mesh() {
        let overlay = FemSliceOverlay {
            bounds: SliceOverlayBounds {
                u_min: 0.0,
                u_max: 4.0,
                v_min: 0.0,
                v_max: 1.0,
            },
            cut_norm: 0.5,
            cut_world: 0.0,
            normal_axis: "z",
            plane: SlicePlane::Xy,
            polygons: vec![SliceOverlayPolygon {
                parent_element_id: 0,
                points: vec![point([0.1, 0.1]), point([3.9, 0.1]), point([2.0, 0.9])],
                vertices: vec![[0.1, 0.1], [3.9, 0.1], [2.0, 0.9]],
            }],
            segments: vec![],
            u_axis: "x",
            v_axis: "y",
        };

        let rendered = render_cross_section_png(
            &overlay,
            &[0.7],
            CrossSectionImageRenderOptions {
                color_scale: CrossSectionImageColorScale::Jet,
                legend: false,
                metric: CrossSectionQualityMetric::Skewness,
                resolution: 1024,
                rotation_degrees: 0.0,
                shrink_factor: 1.0,
                wireframe: true,
                edge_width: 1.5,
                dpr: 1.0,
            },
            None,
        )
        .unwrap();

        // Wide mesh should produce a wider-than-tall image
        assert!(rendered.width > rendered.height, "expected w>h, got {}x{}", rendered.width, rendered.height);
    }

    #[test]
    fn format_si_value_uses_correct_prefixes() {
        assert_eq!(format_si_value(0.0), "0");
        assert_eq!(format_si_value(1.5), "1.50");
        assert!(format_si_value(0.001).contains("m"));
        assert!(format_si_value(0.000001).contains("μ"));
        assert!(format_si_value(0.000000001).contains("n"));
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
