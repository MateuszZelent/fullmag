//! Geometric summaries for legacy publications without stored mesh statistics.
//! The canonical tetrahedral decomposition matches physics note 0105 and the
//! Python mixed-mesh summary. It is not a Gmsh quality metric or Jacobian proof.

use fullmag_ir::FemCellTypeIR;
use fullmag_runner::FemMeshPayload;

pub(super) struct CellGeometry {
    pub volume: f64,
    pub edges: [f64; 12],
    pub edge_count: usize,
}

pub(super) fn cell_geometry(mesh: &FemMeshPayload, ordinal: usize) -> Option<CellGeometry> {
    let kind = *mesh.cells.types.get(ordinal)?;
    let indices = mesh.cells.item_nodes(ordinal)?;
    if indices.len() != kind.arity() {
        return None;
    }
    let mut points = [[0.0; 3]; 8];
    for (slot, index) in indices.iter().enumerate() {
        points[slot] = *mesh.nodes.get(*index as usize)?;
        if points[slot].iter().any(|value| !value.is_finite()) {
            return None;
        }
    }
    geometry(kind, &points)
}

fn geometry(kind: FemCellTypeIR, points: &[[f64; 3]; 8]) -> Option<CellGeometry> {
    let (tets, edge_pairs): (&[[usize; 4]], &[[usize; 2]]) = match kind {
        FemCellTypeIR::Tet4 => (
            &[[0, 1, 2, 3]],
            &[[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
        ),
        FemCellTypeIR::Prism6 => (
            &[[0, 1, 2, 3], [1, 2, 3, 4], [2, 3, 4, 5]],
            &[
                [0, 1],
                [1, 2],
                [2, 0],
                [3, 4],
                [4, 5],
                [5, 3],
                [0, 3],
                [1, 4],
                [2, 5],
            ],
        ),
        FemCellTypeIR::Pyramid5 => (
            &[[0, 1, 2, 4], [0, 2, 3, 4]],
            &[
                [0, 1],
                [1, 2],
                [2, 3],
                [3, 0],
                [0, 4],
                [1, 4],
                [2, 4],
                [3, 4],
            ],
        ),
        FemCellTypeIR::Hex8 => (
            &[
                [0, 1, 3, 4],
                [1, 2, 3, 6],
                [1, 3, 4, 6],
                [1, 4, 5, 6],
                [3, 4, 6, 7],
            ],
            &[
                [0, 1],
                [1, 2],
                [2, 3],
                [3, 0],
                [4, 5],
                [5, 6],
                [6, 7],
                [7, 4],
                [0, 4],
                [1, 5],
                [2, 6],
                [3, 7],
            ],
        ),
    };
    let volume = tets
        .iter()
        .map(|tet| super::mesh::tet_volume(tet.map(|index| points[index])).abs())
        .sum::<f64>();
    let mut edges = [0.0; 12];
    for (slot, [a, b]) in edge_pairs.iter().enumerate() {
        edges[slot] = super::mesh::distance(points[*a], points[*b]);
    }
    if !volume.is_finite()
        || edges[..edge_pairs.len()]
            .iter()
            .any(|value| !value.is_finite())
    {
        return None;
    }
    Some(CellGeometry {
        volume,
        edges,
        edge_count: edge_pairs.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_cells_preserve_volume_and_real_edges() {
        let cube = [
            [0., 0., 0.],
            [1., 0., 0.],
            [1., 1., 0.],
            [0., 1., 0.],
            [0., 0., 1.],
            [1., 0., 1.],
            [1., 1., 1.],
            [0., 1., 1.],
        ];
        let hex = geometry(FemCellTypeIR::Hex8, &cube).unwrap();
        assert!((hex.volume - 1.0).abs() < 1e-14);
        assert_eq!(hex.edge_count, 12);
        assert!(hex.edges.iter().all(|edge| *edge == 1.0));
        let mut prism = [[0.; 3]; 8];
        for (slot, index) in [0, 1, 3, 4, 5, 7].into_iter().enumerate() {
            prism[slot] = cube[index];
        }
        let prism = geometry(FemCellTypeIR::Prism6, &prism).unwrap();
        assert!((prism.volume - 0.5).abs() < 1e-14);
        assert_eq!(prism.edge_count, 9);
        let mut pyramid = cube;
        pyramid[4] = [0.5, 0.5, 1.0];
        let pyramid = geometry(FemCellTypeIR::Pyramid5, &pyramid).unwrap();
        assert!((pyramid.volume - 1.0 / 3.0).abs() < 1e-14);
        assert_eq!(pyramid.edge_count, 8);
    }
}
