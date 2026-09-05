use std::sync::Arc;

use super::cut_geometry::CutGeometry;
use super::FemPlanarField;

#[derive(Debug, Clone)]
pub(crate) struct EvaluationPlan {
    pub cut_geometry: Arc<CutGeometry>,
    pub vertex_weights: Vec<[f64; 4]>,
    pub vertex_parents: Vec<u32>,
}

impl EvaluationPlan {
    pub fn new(cut_geometry: Arc<CutGeometry>) -> Self {
        let vertex_weights = cut_geometry
            .vertices
            .iter()
            .map(|v| v.barycentric_weights)
            .collect();
        let vertex_parents = cut_geometry
            .vertices
            .iter()
            .map(|v| v.parent_element_id)
            .collect();
        Self {
            cut_geometry,
            vertex_weights,
            vertex_parents,
        }
    }

    pub fn evaluate_vertex_values(&self, field: &FemPlanarField) -> Vec<f64> {
        let n_comp = field.n_comp();
        let mut result = Vec::with_capacity(self.cut_geometry.vertices.len() * n_comp);
        for vertex in &self.cut_geometry.vertices {
            let elem = &field.elements()[vertex.parent_element_id as usize];
            let weights = vertex.barycentric_weights;
            for c in 0..n_comp {
                let mut val = 0.0;
                for (local, &node) in elem.nodes().iter().take(4).enumerate() {
                    val += weights[local] * field.values()[node as usize * n_comp + c];
                }
                result.push(val);
            }
        }
        result
    }
}
