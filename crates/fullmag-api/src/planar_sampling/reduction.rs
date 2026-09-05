use fullmag_ir::PlanarReductionIR;

#[derive(Debug, Clone, Copy)]
pub(super) enum AccumulatorReduction {
    MeanOccupied,
    ThicknessIntegral,
    Rms,
    Min,
    Max,
    AbsMax,
    WeightedSum,
    SampleSum { normal_step: f64 },
    Stddev,
}

impl From<PlanarReductionIR> for AccumulatorReduction {
    fn from(value: PlanarReductionIR) -> Self {
        match value {
            PlanarReductionIR::MeanOccupied => Self::MeanOccupied,
            PlanarReductionIR::ThicknessIntegral => Self::ThicknessIntegral,
            PlanarReductionIR::Rms => Self::Rms,
            PlanarReductionIR::Min => Self::Min,
            PlanarReductionIR::Max => Self::Max,
            PlanarReductionIR::AbsMax => Self::AbsMax,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct WeightedAccumulator {
    weighted: Vec<f64>,
    weighted_square: Vec<f64>,
    min: Vec<f64>,
    max: Vec<f64>,
    weight: f64,
}

impl WeightedAccumulator {
    pub fn new(n_comp: usize) -> Self {
        Self {
            weighted: vec![0.0; n_comp],
            weighted_square: vec![0.0; n_comp],
            min: vec![f64::INFINITY; n_comp],
            max: vec![f64::NEG_INFINITY; n_comp],
            weight: 0.0,
        }
    }

    pub fn add_constant(&mut self, values: &[f64], weight: f64) {
        if !weight.is_finite() || weight <= 0.0 {
            return;
        }
        self.weight += weight;
        for (component, value) in values.iter().enumerate() {
            self.weighted[component] += value * weight;
            self.weighted_square[component] += value * value * weight;
            self.min[component] = self.min[component].min(*value);
            self.max[component] = self.max[component].max(*value);
        }
    }

    pub fn add(&mut self, values: &[f64], weight: f64) {
        self.add_constant(values, weight);
    }

    pub fn merge_moments(&mut self, moments: &[crate::planar_sampling::moments::ScalarMoments]) {
        if moments.is_empty() || moments[0].measure <= 0.0 || !moments[0].measure.is_finite() {
            return;
        }
        self.weight += moments[0].measure;
        for (component, moment) in moments.iter().enumerate() {
            if component < self.weighted.len() {
                self.weighted[component] += moment.first;
                self.weighted_square[component] += moment.second;
                self.min[component] = f64::min(self.min[component], moment.min);
                self.max[component] = f64::max(self.max[component], moment.max);
            }
        }
    }

    pub fn weight(&self) -> f64 {
        self.weight
    }

    pub fn finish(&self, reduction: AccumulatorReduction, pixel_area: f64) -> Option<Vec<f64>> {
        if self.weight <= 0.0 {
            return None;
        }
        Some(
            (0..self.weighted.len())
                .map(|component| {
                    let mean = self.weighted[component] / self.weight;
                    match reduction {
                        AccumulatorReduction::MeanOccupied => mean,
                        AccumulatorReduction::ThicknessIntegral => {
                            self.weighted[component] / pixel_area
                        }
                        AccumulatorReduction::Rms => {
                            (self.weighted_square[component] / self.weight).sqrt()
                        }
                        AccumulatorReduction::Min => self.min[component],
                        AccumulatorReduction::Max => self.max[component],
                        AccumulatorReduction::AbsMax => {
                            if self.min[component].abs() >= self.max[component].abs() {
                                self.min[component]
                            } else {
                                self.max[component]
                            }
                        }
                        AccumulatorReduction::WeightedSum => self.weighted[component],
                        AccumulatorReduction::SampleSum { normal_step } => {
                            self.weighted[component] / (pixel_area * normal_step)
                        }
                        AccumulatorReduction::Stddev => {
                            (self.weighted_square[component] / self.weight - mean * mean)
                                .max(0.0)
                                .sqrt()
                        }
                    }
                })
                .collect(),
        )
    }
}
