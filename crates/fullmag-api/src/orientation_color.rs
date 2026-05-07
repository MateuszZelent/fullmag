//! Shared orientation color mapping for magnetization-like vectors.
//!
//! This mirrors `apps/web/components/preview/magnetizationColor.ts`.

fn positive_modulo(value: f64, modulus: f64) -> f64 {
    let mut result = value % modulus;
    if result < 0.0 {
        result += modulus;
    }
    result
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn hsv_to_rgb(h_radians: f64, saturation: f64, value: f64) -> [f64; 3] {
    let saturation = clamp01(saturation);
    let value = clamp01(value);
    let h = positive_modulo(h_radians.to_degrees() / 60.0, 6.0);

    let c = value * saturation;
    let x = c * (1.0 - (positive_modulo(h, 2.0) - 1.0).abs());
    let m = value - c;

    let (r, g, b) = if h < 1.0 {
        (c, x, 0.0)
    } else if h < 2.0 {
        (x, c, 0.0)
    } else if h < 3.0 {
        (0.0, c, x)
    } else if h < 4.0 {
        (0.0, x, c)
    } else if h < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };

    [r + m, g + m, b + m]
}

fn to_u8(value: f64) -> u8 {
    (clamp01(value) * 255.0).round() as u8
}

pub(crate) fn apply_magnetization_hsl_rgb(mx: f64, my: f64, mz: f64) -> [u8; 3] {
    let magnitude = (mx * mx + my * my + mz * mz).sqrt();
    if magnitude <= 1.0e-30 {
        return [153, 153, 153];
    }

    let nx = mx / magnitude;
    let ny = my / magnitude;
    let nz = mz / magnitude;
    let hue_radians = ny.atan2(nx);
    let saturation = (nx * nx + ny * ny).sqrt().clamp(0.0, 1.0);
    let value = (nz * 0.5 + 0.5).clamp(0.0, 1.0);
    let rgb = hsv_to_rgb(hue_radians, saturation, value);
    [to_u8(rgb[0]), to_u8(rgb[1]), to_u8(rgb[2])]
}

pub(crate) fn apply_magnetization_hsl_rgba(mx: f64, my: f64, mz: f64, alpha: u8) -> [u8; 4] {
    let [r, g, b] = apply_magnetization_hsl_rgb(mx, my, mz);
    [r, g, b, alpha]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orientation_canonical_axes_match_frontend_semantics() {
        let plus_x = apply_magnetization_hsl_rgb(1.0, 0.0, 0.0);
        assert!(plus_x[0] > 0 && plus_x[1] == 0 && plus_x[2] == 0);
        assert_eq!(apply_magnetization_hsl_rgb(0.0, 0.0, 1.0), [255, 255, 255]);
        assert_eq!(apply_magnetization_hsl_rgb(0.0, 0.0, -1.0), [0, 0, 0]);
    }
}
