//! Diagnostic PNG renderer for 2D field matrices.

use crate::error::ApiError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AutoScaleMode {
    Slice,
    SymmetricZero,
    Manual,
}

impl AutoScaleMode {
    pub(crate) fn parse(input: Option<&str>) -> Result<Self, ApiError> {
        match input.unwrap_or("slice") {
            "slice" | "global" => Ok(Self::Slice),
            "symmetric_zero" => Ok(Self::SymmetricZero),
            "manual" => Ok(Self::Manual),
            other => Err(ApiError::bad_request(format!(
                "invalid_query: unsupported auto_scale '{other}'"
            ))),
        }
    }
}

pub(crate) fn encode_scalar_png(
    width: u32,
    height: u32,
    values: &[f64],
    mask: &[u8],
    colormap: &str,
    auto_scale: AutoScaleMode,
    vmin: Option<f64>,
    vmax: Option<f64>,
    alpha_mask: bool,
) -> Result<Vec<u8>, ApiError> {
    let expected = width as usize * height as usize;
    if values.len() != expected || mask.len() != expected {
        return Err(ApiError::internal(
            "render_png: scalar values and mask length must match image size",
        ));
    }
    let (min, max) = scalar_range(values, mask, auto_scale, vmin, vmax);
    let span = (max - min).abs().max(f64::EPSILON);
    let mut rgba = Vec::with_capacity(expected * 4);
    for (index, value) in values.iter().copied().enumerate() {
        let empty = mask[index] != 0 || !value.is_finite();
        if empty {
            rgba.extend_from_slice(&[0, 0, 0, if alpha_mask { 0 } else { 255 }]);
            continue;
        }
        let t = ((value - min) / span).clamp(0.0, 1.0);
        let [r, g, b] = map_colormap(t, colormap);
        rgba.extend_from_slice(&[r, g, b, 255]);
    }
    encode_rgba_png(width, height, &rgba)
}

pub(crate) fn encode_rgba_matrix_png(
    width: u32,
    height: u32,
    rgba_pixels: &[[u8; 4]],
    mask: &[u8],
    alpha_mask: bool,
) -> Result<Vec<u8>, ApiError> {
    let expected = width as usize * height as usize;
    if rgba_pixels.len() != expected || mask.len() != expected {
        return Err(ApiError::internal(
            "render_png: rgba values and mask length must match image size",
        ));
    }
    let mut rgba = Vec::with_capacity(expected * 4);
    for (index, pixel) in rgba_pixels.iter().copied().enumerate() {
        if alpha_mask && mask[index] != 0 {
            rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 0]);
        } else {
            rgba.extend_from_slice(&pixel);
        }
    }
    encode_rgba_png(width, height, &rgba)
}

pub(crate) fn encode_scalar_png_with_lines(
    width: u32,
    height: u32,
    values: &[f64],
    mask: &[u8],
    colormap: &str,
    auto_scale: AutoScaleMode,
    vmin: Option<f64>,
    vmax: Option<f64>,
    alpha_mask: bool,
    lines: &[[f64; 4]],
) -> Result<Vec<u8>, ApiError> {
    let expected = width as usize * height as usize;
    if values.len() != expected || mask.len() != expected {
        return Err(ApiError::internal(
            "render_png: scalar values and mask length must match image size",
        ));
    }
    let (min, max) = scalar_range(values, mask, auto_scale, vmin, vmax);
    let span = (max - min).abs().max(f64::EPSILON);
    let mut rgba = Vec::with_capacity(expected * 4);
    for (index, value) in values.iter().copied().enumerate() {
        let empty = mask[index] != 0 || !value.is_finite();
        if empty {
            rgba.extend_from_slice(&[0, 0, 0, if alpha_mask { 0 } else { 255 }]);
            continue;
        }
        let t = ((value - min) / span).clamp(0.0, 1.0);
        let [r, g, b] = map_colormap(t, colormap);
        rgba.extend_from_slice(&[r, g, b, 255]);
    }
    overlay_lines(width, height, &mut rgba, lines);
    encode_rgba_png(width, height, &rgba)
}

pub(crate) fn encode_rgba_matrix_png_with_lines(
    width: u32,
    height: u32,
    rgba_pixels: &[[u8; 4]],
    mask: &[u8],
    alpha_mask: bool,
    lines: &[[f64; 4]],
) -> Result<Vec<u8>, ApiError> {
    let expected = width as usize * height as usize;
    if rgba_pixels.len() != expected || mask.len() != expected {
        return Err(ApiError::internal(
            "render_png: rgba values and mask length must match image size",
        ));
    }
    let mut rgba = Vec::with_capacity(expected * 4);
    for (index, pixel) in rgba_pixels.iter().copied().enumerate() {
        if alpha_mask && mask[index] != 0 {
            rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 0]);
        } else {
            rgba.extend_from_slice(&pixel);
        }
    }
    overlay_lines(width, height, &mut rgba, lines);
    encode_rgba_png(width, height, &rgba)
}

fn overlay_lines(width: u32, height: u32, rgba: &mut [u8], lines: &[[f64; 4]]) {
    for [x0, y0, x1, y1] in lines.iter().copied() {
        draw_line(width, height, rgba, x0, y0, x1, y1);
    }
}

fn draw_line(width: u32, height: u32, rgba: &mut [u8], x0: f64, y0: f64, x1: f64, y1: f64) {
    if width == 0 || height == 0 {
        return;
    }
    let mut x = x0.round() as i32;
    let mut y = y0.round() as i32;
    let x_end = x1.round() as i32;
    let y_end = y1.round() as i32;
    let dx = (x_end - x).abs();
    let dy = -(y_end - y).abs();
    let sx = if x < x_end { 1 } else { -1 };
    let sy = if y < y_end { 1 } else { -1 };
    let mut err = dx + dy;
    loop {
        draw_pixel(width, height, rgba, x, y);
        if x == x_end && y == y_end {
            break;
        }
        let e2 = err * 2;
        if e2 >= dy {
            err += dy;
            x += sx;
        }
        if e2 <= dx {
            err += dx;
            y += sy;
        }
    }
}

fn draw_pixel(width: u32, height: u32, rgba: &mut [u8], x: i32, y: i32) {
    if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
        return;
    }
    let idx = ((y as u32 * width + x as u32) * 4) as usize;
    if idx + 3 >= rgba.len() {
        return;
    }
    rgba[idx] = 24;
    rgba[idx + 1] = 24;
    rgba[idx + 2] = 24;
    rgba[idx + 3] = 255;
}

fn scalar_range(
    values: &[f64],
    mask: &[u8],
    auto_scale: AutoScaleMode,
    vmin: Option<f64>,
    vmax: Option<f64>,
) -> (f64, f64) {
    if auto_scale == AutoScaleMode::Manual {
        return (vmin.unwrap_or(0.0), vmax.unwrap_or(1.0));
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for (index, value) in values.iter().copied().enumerate() {
        if mask.get(index).copied().unwrap_or(1) == 0 && value.is_finite() {
            min = min.min(value);
            max = max.max(value);
        }
    }
    if !min.is_finite() || !max.is_finite() {
        min = 0.0;
        max = 1.0;
    }
    if auto_scale == AutoScaleMode::SymmetricZero {
        let abs = min.abs().max(max.abs());
        return (-abs, abs);
    }
    if (max - min).abs() <= f64::EPSILON {
        let pad = min.abs().max(1.0) * 0.5;
        (min - pad, max + pad)
    } else {
        (min, max)
    }
}

fn map_colormap(t: f64, colormap: &str) -> [u8; 3] {
    match colormap {
        "gray" | "grey" => {
            let v = (t * 255.0).round() as u8;
            [v, v, v]
        }
        "coolwarm" => {
            let r = (255.0 * t).round() as u8;
            let g = (255.0 * (1.0 - (2.0 * t - 1.0).abs()) * 0.75).round() as u8;
            let b = (255.0 * (1.0 - t)).round() as u8;
            [r, g, b]
        }
        "positive" => [(255.0 * t).round() as u8, (180.0 * t).round() as u8, 0],
        "negative" => [0, (160.0 * t).round() as u8, (255.0 * t).round() as u8],
        _ => viridis_like(t),
    }
}

fn viridis_like(t: f64) -> [u8; 3] {
    let stops = [
        (0.0, [68.0, 1.0, 84.0]),
        (0.25, [59.0, 82.0, 139.0]),
        (0.5, [33.0, 145.0, 140.0]),
        (0.75, [94.0, 201.0, 98.0]),
        (1.0, [253.0, 231.0, 37.0]),
    ];
    for pair in stops.windows(2) {
        let (left_t, left_rgb) = pair[0];
        let (right_t, right_rgb) = pair[1];
        if t <= right_t {
            let local = ((t - left_t) / (right_t - left_t)).clamp(0.0, 1.0);
            return [
                lerp_u8(left_rgb[0], right_rgb[0], local),
                lerp_u8(left_rgb[1], right_rgb[1], local),
                lerp_u8(left_rgb[2], right_rgb[2], local),
            ];
        }
    }
    [253, 231, 37]
}

fn lerp_u8(a: f64, b: f64, t: f64) -> u8 {
    (a + (b - a) * t).round().clamp(0.0, 255.0) as u8
}

fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, ApiError> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| ApiError::internal(format!("render_png: {error}")))?;
    writer
        .write_image_data(rgba)
        .map_err(|error| ApiError::internal(format!("render_png: {error}")))?;
    drop(writer);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_encoder_returns_png_magic() {
        let png = encode_scalar_png(
            1,
            1,
            &[0.5],
            &[0],
            "gray",
            AutoScaleMode::Manual,
            Some(0.0),
            Some(1.0),
            true,
        )
        .unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
