//! Minimal FEM spatial index for axis-aligned slice and slab queries.

use std::collections::HashSet;

#[derive(Debug)]
pub(crate) struct FemNormalAxisIndex {
    normal_axis: usize,
    min: f64,
    bin_width: f64,
    bins: Vec<Vec<usize>>,
    element_bounds: Vec<(f64, f64)>,
}

impl FemNormalAxisIndex {
    pub(crate) fn build(
        nodes: &[[f64; 3]],
        elements: &[[u32; 4]],
        normal_axis: usize,
        target_bins: usize,
    ) -> Self {
        let mut element_bounds = Vec::with_capacity(elements.len());
        let mut global_min = f64::INFINITY;
        let mut global_max = f64::NEG_INFINITY;

        for element in elements {
            let mut min = f64::INFINITY;
            let mut max = f64::NEG_INFINITY;
            for node_index in element {
                if let Some(node) = nodes.get(*node_index as usize) {
                    let value = node[normal_axis];
                    min = min.min(value);
                    max = max.max(value);
                }
            }
            if !min.is_finite() || !max.is_finite() {
                min = 0.0;
                max = 0.0;
            }
            global_min = global_min.min(min);
            global_max = global_max.max(max);
            element_bounds.push((min, max));
        }

        if !global_min.is_finite() || !global_max.is_finite() {
            global_min = 0.0;
            global_max = 1.0;
        }
        if (global_max - global_min).abs() <= f64::EPSILON {
            global_min -= 0.5;
            global_max += 0.5;
        }

        let bin_count = target_bins.clamp(1, 2048);
        let bin_width = ((global_max - global_min) / bin_count as f64).max(f64::EPSILON);
        let mut bins = vec![Vec::new(); bin_count];

        for (element_index, (min, max)) in element_bounds.iter().copied().enumerate() {
            let start = bin_index(min, global_min, bin_width, bin_count);
            let end = bin_index(max, global_min, bin_width, bin_count);
            for bin in start..=end {
                bins[bin].push(element_index);
            }
        }

        Self {
            normal_axis,
            min: global_min,
            bin_width,
            bins,
            element_bounds,
        }
    }

    pub(crate) fn normal_axis(&self) -> usize {
        self.normal_axis
    }

    pub(crate) fn query_cut(&self, cut_world: f64, epsilon: f64) -> Vec<usize> {
        self.query_range(cut_world - epsilon, cut_world + epsilon)
    }

    pub(crate) fn query_range(&self, min_world: f64, max_world: f64) -> Vec<usize> {
        if self.bins.is_empty() || !min_world.is_finite() || !max_world.is_finite() {
            return (0..self.element_bounds.len()).collect();
        }
        let range_min = min_world.min(max_world);
        let range_max = min_world.max(max_world);
        let start = bin_index(range_min, self.min, self.bin_width, self.bins.len());
        let end = bin_index(range_max, self.min, self.bin_width, self.bins.len());
        let mut seen = HashSet::new();
        let mut candidates = Vec::new();
        for bin in start..=end {
            for element_index in &self.bins[bin] {
                if !seen.insert(*element_index) {
                    continue;
                }
                let (element_min, element_max) = self.element_bounds[*element_index];
                if element_max >= range_min && element_min <= range_max {
                    candidates.push(*element_index);
                }
            }
        }
        candidates
    }
}

fn bin_index(value: f64, min: f64, width: f64, len: usize) -> usize {
    if len <= 1 || !value.is_finite() || !width.is_finite() || width <= 0.0 {
        return 0;
    }
    (((value - min) / width).floor() as isize).clamp(0, len as isize - 1) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_axis_index_filters_disjoint_tetrahedra() {
        let nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 10.0],
            [1.0, 0.0, 10.0],
            [0.0, 1.0, 10.0],
            [0.0, 0.0, 11.0],
        ];
        let elements = vec![[0, 1, 2, 3], [4, 5, 6, 7]];
        let index = FemNormalAxisIndex::build(&nodes, &elements, 2, 8);
        assert_eq!(index.query_cut(0.5, 1.0e-12), vec![0]);
        assert_eq!(index.query_cut(10.5, 1.0e-12), vec![1]);
    }
}
