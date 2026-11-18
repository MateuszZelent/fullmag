use std::collections::HashMap;

const MAX_STL_FILE_BYTES: usize = 128 * 1024 * 1024;
const MAX_STL_TRIANGLES: usize = 2_000_000;

#[derive(Clone, Debug, PartialEq)]
pub struct ImportedTriangleSurface {
    pub positions: Vec<[f64; 3]>,
    pub triangle_indices: Vec<[u32; 3]>,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
}

/// Decode a binary or ASCII STL file into a triangle surface.
pub fn parse_stl_surface(bytes: &[u8]) -> Result<ImportedTriangleSurface, String> {
    if bytes.is_empty() {
        return Err("STL file is empty".to_string());
    }
    if bytes.len() > MAX_STL_FILE_BYTES {
        return Err("STL input exceeds the 128 MiB maximum file size".to_string());
    }

    if let Some(triangle_count) = exact_binary_triangle_count(bytes) {
        return parse_binary_stl(bytes, triangle_count);
    }

    parse_ascii_stl(bytes)
}

fn exact_binary_triangle_count(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 84 {
        return None;
    }

    let count = u32::from_le_bytes(bytes[80..84].try_into().ok()?);
    let count = usize::try_from(count).ok()?;
    let expected_length = count.checked_mul(50)?.checked_add(84)?;
    (expected_length == bytes.len()).then_some(count)
}

fn parse_binary_stl(
    bytes: &[u8],
    triangle_count: usize,
) -> Result<ImportedTriangleSurface, String> {
    if triangle_count == 0 {
        return Err("STL must contain at least one triangle".to_string());
    }
    if triangle_count > MAX_STL_TRIANGLES {
        return Err("STL triangle count exceeds the maximum of 2000000 triangles".to_string());
    }

    let mut builder = SurfaceBuilder::default();
    let mut offset = 84;
    for _ in 0..triangle_count {
        // Binary STL stores a normal first. It is metadata, not geometry.
        offset += 12;
        let mut triangle = [[0.0; 3]; 3];
        for vertex in &mut triangle {
            for coordinate in vertex {
                let end = offset + 4;
                let raw: [u8; 4] = bytes
                    .get(offset..end)
                    .and_then(|slice| slice.try_into().ok())
                    .ok_or_else(|| "Binary STL ended inside a triangle".to_string())?;
                *coordinate = f32::from_le_bytes(raw) as f64;
                if !coordinate.is_finite() {
                    return Err("STL contains a non-finite vertex coordinate".to_string());
                }
                offset = end;
            }
        }
        // The final two bytes are the per-face attribute field and are ignored.
        offset += 2;
        builder.push_triangle(triangle)?;
    }

    builder.finish()
}

fn parse_ascii_stl(bytes: &[u8]) -> Result<ImportedTriangleSurface, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "ASCII STL is not valid UTF-8/ASCII text".to_string())?;
    if !text.is_ascii() {
        return Err("ASCII STL must contain only ASCII text".to_string());
    }

    let mut lines = text.lines().enumerate();
    let mut builder = SurfaceBuilder::default();
    let mut inside_solid = false;
    let mut completed_solid = false;
    loop {
        let Some((line_number, line)) = next_nonempty_ascii_line(&mut lines) else {
            if inside_solid {
                return Err("ASCII STL is missing its endsolid record".to_string());
            }
            if completed_solid {
                break;
            }
            return Err("ASCII STL is missing its solid header".to_string());
        };
        let mut fields = line.split_ascii_whitespace();
        match fields.next() {
            Some("solid") if !inside_solid => {
                inside_solid = true;
            }
            Some("facet") if inside_solid => {
                parse_ascii_facet(line_number, line, &mut lines, &mut builder)?;
            }
            Some("endsolid") if inside_solid => {
                inside_solid = false;
                completed_solid = true;
            }
            _ => {
                return Err(ascii_line_error(
                    line_number,
                    if inside_solid {
                        "expected a facet or endsolid record"
                    } else {
                        "expected a solid header between complete solids"
                    },
                ));
            }
        }
    }

    builder.finish()
}

fn parse_ascii_facet<'a>(
    facet_line_number: usize,
    facet_line: &str,
    lines: &mut std::iter::Enumerate<std::str::Lines<'a>>,
    builder: &mut SurfaceBuilder,
) -> Result<(), String> {
    let mut fields = facet_line.split_ascii_whitespace();
    if fields.next() != Some("facet") || fields.next() != Some("normal") {
        return Err(ascii_line_error(
            facet_line_number,
            "expected `facet normal` followed by three numbers",
        ));
    }
    for _ in 0..3 {
        let token = fields.next().ok_or_else(|| {
            ascii_line_error(facet_line_number, "facet normal needs three numbers")
        })?;
        token.parse::<f64>().map_err(|_| {
            ascii_line_error(facet_line_number, "facet normal contains an invalid number")
        })?;
    }
    if fields.next().is_some() {
        return Err(ascii_line_error(
            facet_line_number,
            "facet normal has extra fields",
        ));
    }

    expect_ascii_record(lines, "outer loop", "expected `outer loop`")?;
    let mut triangle = [[0.0; 3]; 3];
    for vertex in &mut triangle {
        let (line_number, line) = next_nonempty_ascii_line(lines)
            .ok_or_else(|| "ASCII STL ended before all facet vertices".to_string())?;
        let mut fields = line.split_ascii_whitespace();
        if fields.next() != Some("vertex") {
            return Err(ascii_line_error(line_number, "expected a vertex record"));
        }
        for coordinate in vertex {
            let token = fields
                .next()
                .ok_or_else(|| ascii_line_error(line_number, "vertex needs three coordinates"))?;
            *coordinate = token.parse::<f64>().map_err(|_| {
                ascii_line_error(line_number, "vertex contains an invalid coordinate")
            })?;
            if !coordinate.is_finite() {
                return Err(ascii_line_error(
                    line_number,
                    "vertex coordinates must be finite",
                ));
            }
        }
        if fields.next().is_some() {
            return Err(ascii_line_error(line_number, "vertex has extra fields"));
        }
    }
    expect_ascii_record(lines, "endloop", "expected `endloop`")?;
    expect_ascii_record(lines, "endfacet", "expected `endfacet`")?;
    builder.push_triangle(triangle)
}

fn expect_ascii_record<'a>(
    lines: &mut std::iter::Enumerate<std::str::Lines<'a>>,
    expected: &str,
    message: &str,
) -> Result<(), String> {
    let (line_number, line) = next_nonempty_ascii_line(lines)
        .ok_or_else(|| format!("ASCII STL ended before `{expected}`"))?;
    if !line
        .split_ascii_whitespace()
        .eq(expected.split_ascii_whitespace())
    {
        return Err(ascii_line_error(line_number, message));
    }
    Ok(())
}

fn next_nonempty_ascii_line<'a>(
    lines: &mut std::iter::Enumerate<std::str::Lines<'a>>,
) -> Option<(usize, &'a str)> {
    lines.find_map(|(line_number, line)| {
        let trimmed = line.trim_matches(|character: char| character.is_ascii_whitespace());
        (!trimmed.is_empty()).then_some((line_number, trimmed))
    })
}

fn ascii_line_error(line_number: usize, message: &str) -> String {
    format!("Malformed ASCII STL at line {}: {message}", line_number + 1)
}

#[derive(Default)]
struct SurfaceBuilder {
    positions: Vec<[f64; 3]>,
    triangle_indices: Vec<[u32; 3]>,
    vertex_indices: HashMap<[u64; 3], u32>,
    bounds_min: [f64; 3],
    bounds_max: [f64; 3],
    has_bounds: bool,
}

impl SurfaceBuilder {
    fn push_triangle(&mut self, triangle: [[f64; 3]; 3]) -> Result<(), String> {
        if self.triangle_indices.len() >= MAX_STL_TRIANGLES {
            return Err("STL triangle count exceeds the maximum of 2000000 triangles".to_string());
        }
        validate_triangle(&triangle)?;
        self.triangle_indices
            .try_reserve(1)
            .map_err(|_| "Unable to allocate STL triangle index storage".to_string())?;

        let mut indices = [0_u32; 3];
        for (corner, point) in triangle.into_iter().enumerate() {
            let point = point.map(canonicalize_zero);
            let key = point.map(f64::to_bits);
            if let Some(&index) = self.vertex_indices.get(&key) {
                indices[corner] = index;
                continue;
            }

            let index = u32::try_from(self.positions.len())
                .map_err(|_| "STL contains too many distinct vertices".to_string())?;
            self.positions
                .try_reserve(1)
                .map_err(|_| "Unable to allocate STL vertex storage".to_string())?;
            self.vertex_indices
                .try_reserve(1)
                .map_err(|_| "Unable to allocate STL vertex index storage".to_string())?;
            self.positions.push(point);
            self.vertex_indices.insert(key, index);
            self.update_bounds(point);
            indices[corner] = index;
        }
        self.triangle_indices.push(indices);
        Ok(())
    }

    fn update_bounds(&mut self, point: [f64; 3]) {
        if !self.has_bounds {
            self.bounds_min = point;
            self.bounds_max = point;
            self.has_bounds = true;
            return;
        }
        for axis in 0..3 {
            self.bounds_min[axis] = self.bounds_min[axis].min(point[axis]);
            self.bounds_max[axis] = self.bounds_max[axis].max(point[axis]);
        }
    }

    fn finish(self) -> Result<ImportedTriangleSurface, String> {
        if self.triangle_indices.is_empty() {
            return Err("STL must contain at least one triangle".to_string());
        }
        if !self.has_bounds {
            return Err("STL did not contain any vertices".to_string());
        }
        Ok(ImportedTriangleSurface {
            positions: self.positions,
            triangle_indices: self.triangle_indices,
            bounds_min: self.bounds_min,
            bounds_max: self.bounds_max,
        })
    }
}

fn canonicalize_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

fn validate_triangle(triangle: &[[f64; 3]; 3]) -> Result<(), String> {
    if triangle
        .iter()
        .flatten()
        .any(|coordinate| !coordinate.is_finite())
    {
        return Err("STL contains a non-finite vertex coordinate".to_string());
    }

    let points = (*triangle).map(|point| point.map(canonicalize_zero));
    if points[0] == points[1] || points[0] == points[2] || points[1] == points[2] {
        return Err("STL contains a degenerate triangle with repeated vertices".to_string());
    }

    let edge_a = normalized_edge(points[0], points[1]);
    let edge_b = normalized_edge(points[0], points[2]);
    let (Some(edge_a), Some(edge_b)) = (edge_a, edge_b) else {
        return Err("STL contains a degenerate triangle".to_string());
    };
    let cross = [
        edge_a[1] * edge_b[2] - edge_a[2] * edge_b[1],
        edge_a[2] * edge_b[0] - edge_a[0] * edge_b[2],
        edge_a[0] * edge_b[1] - edge_a[1] * edge_b[0],
    ];
    if cross.iter().all(|component| *component == 0.0) {
        return Err("STL contains a degenerate collinear triangle".to_string());
    }
    Ok(())
}

fn normalized_edge(start: [f64; 3], end: [f64; 3]) -> Option<[f64; 3]> {
    let mut edge: [f64; 3] = std::array::from_fn(|axis| end[axis] - start[axis]);
    if edge.iter().any(|component| !component.is_finite()) {
        // Scaling the endpoints first avoids overflow for finite, opposite-sign extremes.
        let scale = start
            .iter()
            .chain(end.iter())
            .map(|coordinate| coordinate.abs())
            .fold(0.0_f64, f64::max);
        if scale == 0.0 || !scale.is_finite() {
            return None;
        }
        edge = std::array::from_fn(|axis| end[axis] / scale - start[axis] / scale);
    }

    let scale = edge
        .iter()
        .map(|component| component.abs())
        .fold(0.0_f64, f64::max);
    if scale == 0.0 || !scale.is_finite() {
        return None;
    }
    Some(edge.map(|component| component / scale))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::fmt::Write as _;

    type Triangle3 = [[f64; 3]; 3];

    const MAX_FILE_BYTES: usize = 128 * 1024 * 1024;
    const MAX_TRIANGLES: usize = 2_000_000;

    fn ascii_stl(name: &str, triangles: &[Triangle3]) -> Vec<u8> {
        let mut text = format!("solid {name}\n");
        for triangle in triangles {
            writeln!(&mut text, "  facet normal 0 0 0").unwrap();
            writeln!(&mut text, "    outer loop").unwrap();
            for vertex in triangle {
                writeln!(
                    &mut text,
                    "      vertex {} {} {}",
                    vertex[0], vertex[1], vertex[2]
                )
                .unwrap();
            }
            writeln!(&mut text, "    endloop").unwrap();
            writeln!(&mut text, "  endfacet").unwrap();
        }
        writeln!(&mut text, "endsolid {name}").unwrap();
        text.into_bytes()
    }

    fn binary_header(header: &str, triangle_count: u32) -> Vec<u8> {
        assert!(header.len() <= 80);
        let mut bytes = vec![0_u8; 84];
        bytes[..header.len()].copy_from_slice(header.as_bytes());
        bytes[80..84].copy_from_slice(&triangle_count.to_le_bytes());
        bytes
    }

    fn binary_stl(header: &str, triangles: &[Triangle3], normal: [f32; 3]) -> Vec<u8> {
        let mut bytes = binary_header(header, u32::try_from(triangles.len()).unwrap());
        for triangle in triangles {
            for value in normal {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            for vertex in triangle {
                for value in vertex {
                    bytes.extend_from_slice(&(*value as f32).to_le_bytes());
                }
            }
            bytes.extend_from_slice(&0_u16.to_le_bytes());
        }
        bytes
    }

    fn tetrahedron() -> Vec<Triangle3> {
        let a = [0.0, 0.0, 0.0];
        let b = [1.0, 0.0, 0.0];
        let c = [0.0, 1.0, 0.0];
        let d = [0.0, 0.0, 1.0];
        vec![[a, c, b], [a, b, d], [a, d, c], [b, c, d]]
    }

    #[test]
    fn ascii_and_binary_tetrahedra_are_equivalent_and_binary_solid_header_is_detected() {
        let triangles = tetrahedron();
        let ascii = parse_stl_surface(&ascii_stl("tetra", &triangles)).unwrap();
        let binary = parse_stl_surface(&binary_stl(
            "solid binary tetrahedron",
            &triangles,
            [3.0, -7.0, 11.0],
        ))
        .unwrap();

        assert_eq!(ascii, binary);
        assert_eq!(
            ascii.positions,
            vec![
                [0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0],
            ]
        );
        assert_eq!(
            ascii.triangle_indices,
            vec![[0, 1, 2], [0, 2, 3], [0, 3, 1], [2, 1, 3]]
        );
        assert_eq!(ascii.bounds_min, [0.0, 0.0, 0.0]);
        assert_eq!(ascii.bounds_max, [1.0, 1.0, 1.0]);
        assert!(ascii
            .triangle_indices
            .iter()
            .flatten()
            .all(|&index| (index as usize) < ascii.positions.len()));
    }

    #[test]
    fn ascii_outer_loop_accepts_repeated_spaces_and_tabs() {
        let triangles = vec![tetrahedron()[0]];
        let ordinary = ascii_stl("spacing", &triangles);
        let spaced = String::from_utf8(ordinary.clone())
            .unwrap()
            .replace("outer loop", "outer\t  loop")
            .into_bytes();

        assert_eq!(
            parse_stl_surface(&spaced).unwrap(),
            parse_stl_surface(&ordinary).unwrap()
        );
    }

    #[test]
    fn consecutive_ascii_solids_match_their_concatenated_binary_facets() {
        let triangles = tetrahedron();
        let mut multi_solid = ascii_stl("first body", &triangles[..2]);
        multi_solid.extend(ascii_stl("second body", &triangles[2..]));
        let binary = binary_stl("multi-body binary", &triangles, [0.0; 3]);

        assert_eq!(
            parse_stl_surface(&multi_solid).unwrap(),
            parse_stl_surface(&binary).unwrap()
        );

        let endsolid = b"endsolid second body\n";
        let mut missing_endsolid = multi_solid.clone();
        missing_endsolid.truncate(missing_endsolid.len() - endsolid.len());
        assert!(parse_stl_surface(&missing_endsolid).is_err());

        let mut trailing_garbage = multi_solid;
        trailing_garbage.extend_from_slice(b"unexpected trailing data\n");
        assert!(parse_stl_surface(&trailing_garbage).is_err());
    }

    const CUBE_FACES: [[usize; 3]; 12] = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [3, 7, 6],
        [3, 6, 2],
        [0, 4, 7],
        [0, 7, 3],
        [1, 2, 6],
        [1, 6, 5],
    ];

    fn cube_corners(min: [f64; 3], max: [f64; 3]) -> [[f64; 3]; 8] {
        [
            [min[0], min[1], min[2]],
            [max[0], min[1], min[2]],
            [max[0], max[1], min[2]],
            [min[0], max[1], min[2]],
            [min[0], min[1], max[2]],
            [max[0], min[1], max[2]],
            [max[0], max[1], max[2]],
            [min[0], max[1], max[2]],
        ]
    }

    fn cube_triangles(min: [f64; 3], max: [f64; 3], reverse: bool) -> Vec<Triangle3> {
        let corners = cube_corners(min, max);
        CUBE_FACES
            .iter()
            .map(|face| {
                let order = if reverse {
                    [face[0], face[2], face[1]]
                } else {
                    *face
                };
                [corners[order[0]], corners[order[1]], corners[order[2]]]
            })
            .collect()
    }

    #[test]
    fn nested_oriented_cubes_keep_both_disconnected_shells_and_every_face() {
        let outer = cube_triangles([0.0; 3], [2.0; 3], false);
        let inner = cube_triangles([0.5; 3], [1.5; 3], true);
        let mut input_triangles = outer.clone();
        input_triangles.extend(inner.clone());
        let decoded = parse_stl_surface(&ascii_stl("nested shells", &input_triangles)).unwrap();

        assert_eq!(decoded.triangle_indices.len(), 24);
        assert_eq!(decoded.positions.len(), 16);
        assert_eq!(decoded.bounds_min, [0.0; 3]);
        assert_eq!(decoded.bounds_max, [2.0; 3]);
        for (expected, indices) in input_triangles.iter().zip(&decoded.triangle_indices) {
            let reconstructed = (*indices).map(|index| decoded.positions[index as usize]);
            assert_eq!(
                &reconstructed, expected,
                "facet coordinates and winding changed"
            );
        }

        let outer_vertices: BTreeSet<u32> = decoded.triangle_indices[..12]
            .iter()
            .flatten()
            .copied()
            .collect();
        let inner_vertices: BTreeSet<u32> = decoded.triangle_indices[12..]
            .iter()
            .flatten()
            .copied()
            .collect();
        assert_eq!(outer_vertices.len(), 8);
        assert_eq!(inner_vertices.len(), 8);
        assert!(outer_vertices.is_disjoint(&inner_vertices));
        assert_eq!(outer.len(), 12);
        assert_eq!(inner.len(), 12);
    }

    #[test]
    fn exact_dedup_preserves_first_appearance_canonicalizes_negative_zero_and_keeps_nearby_points()
    {
        let near_one = 1.0000000000000002_f64;
        let triangles = vec![
            [[0.0, -0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[-0.0, 0.0, -0.0], [near_one, 0.0, 0.0], [0.0, 0.0, 1.0]],
        ];
        let decoded = parse_stl_surface(&ascii_stl("dedup", &triangles)).unwrap();

        assert_eq!(
            decoded.positions,
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [near_one, 0.0, 0.0],
                [0.0, 0.0, 1.0],
            ]
        );
        assert_eq!(decoded.triangle_indices, vec![[0, 1, 2], [0, 3, 4]]);
        assert!(decoded.positions[0]
            .iter()
            .all(|coordinate| coordinate.to_bits() == 0));
        assert_eq!(decoded.bounds_min, [0.0; 3]);
        assert_eq!(decoded.bounds_max, [near_one, 1.0, 1.0]);
    }

    #[test]
    fn extremely_small_non_degenerate_ascii_triangle_is_preserved() {
        let scale = 1e-200;
        let triangles = vec![[[0.0; 3], [scale, 0.0, 0.0], [0.0, scale, 0.0]]];
        let decoded = parse_stl_surface(&ascii_stl("tiny", &triangles)).unwrap();

        assert_eq!(decoded.triangle_indices, vec![[0, 1, 2]]);
        assert_eq!(decoded.positions[1], [scale, 0.0, 0.0]);
        assert_eq!(decoded.positions[2], [0.0, scale, 0.0]);
        assert_eq!(decoded.bounds_max, [scale, scale, 0.0]);
    }

    #[test]
    fn rejects_malformed_ascii_facets_and_trailing_or_non_stl_text() {
        let malformed = [
            "solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nendloop\nendfacet\nendsolid x\n",
            "solid x\nfacet normal 0 0 1\nouterloop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n",
            "solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nvertex 2 2 2\nendloop\nendfacet\nendsolid x\n",
            "solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\ntrailing garbage\n",
            "solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n",
            "this is UTF-8 text, not an STL: μmesh\n",
        ];
        for sample in malformed {
            assert!(
                parse_stl_surface(sample.as_bytes()).is_err(),
                "accepted malformed ASCII STL: {sample:?}"
            );
        }
        assert!(parse_stl_surface(&[0xff, 0xfe, 0x80]).is_err());
    }

    #[test]
    fn rejects_truncated_binary_even_when_header_starts_with_solid() {
        let mut bytes = binary_header("solid truncated binary", 1);
        bytes.resize(84 + 49, 0);
        assert!(parse_stl_surface(&bytes).is_err());
    }

    #[test]
    fn rejects_zero_triangle_ascii_and_binary_files() {
        assert!(parse_stl_surface(b"solid empty\nendsolid empty\n").is_err());
        assert!(parse_stl_surface(&binary_header("solid empty binary", 0)).is_err());
    }

    #[test]
    fn rejects_non_finite_positions_in_ascii_and_binary_stl() {
        for coordinate in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let triangle = [[coordinate, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
            assert!(parse_stl_surface(&ascii_stl("non-finite", &[triangle])).is_err());
            assert!(
                parse_stl_surface(&binary_stl("binary non-finite", &[triangle], [0.0; 3])).is_err()
            );
        }
    }

    #[test]
    fn rejects_collinear_and_repeated_corner_triangles() {
        let invalid = [
            [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [2.0, 2.0, 2.0]],
            [[0.0, 0.0, 0.0], [-0.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        ];
        for triangle in invalid {
            assert!(parse_stl_surface(&ascii_stl("degenerate", &[triangle])).is_err());
            assert!(
                parse_stl_surface(&binary_stl("binary degenerate", &[triangle], [0.0; 3])).is_err()
            );
        }
    }

    #[test]
    fn rejects_excessive_binary_triangle_count_and_file_size_with_clear_errors() {
        let too_many_triangles = MAX_TRIANGLES + 1;
        let expected_binary_len = 84 + 50 * too_many_triangles;
        let mut bytes = binary_header("solid excessive triangle count", too_many_triangles as u32);
        bytes.resize(expected_binary_len, 0);
        let count_error = parse_stl_surface(&bytes).unwrap_err().to_ascii_lowercase();
        assert!(
            count_error.contains("triangle")
                && (count_error.contains("maximum") || count_error.contains("limit")),
            "{count_error}"
        );
        drop(bytes);

        let too_large = vec![0_u8; MAX_FILE_BYTES + 1];
        let size_error = parse_stl_surface(&too_large).unwrap_err();
        assert!(size_error.contains("128 MiB"), "{size_error}");
    }
}
