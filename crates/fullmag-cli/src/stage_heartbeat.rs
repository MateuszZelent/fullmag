use std::time::Instant;

#[derive(Clone)]
pub(crate) struct StageHeartbeatProgress {
    pub(crate) stats: fullmag_runner::StepStats,
    pub(crate) hysteresis_field_m_t: Option<f64>,
    pub(crate) finished: bool,
    pub(crate) last_step_at: Instant,
    pub(crate) stage_started_at: Instant,
}

impl StageHeartbeatProgress {
    pub(crate) fn new(update: &fullmag_runner::StepUpdate) -> Self {
        let stage_started_at = Instant::now();
        Self {
            stats: update.stats.clone(),
            hysteresis_field_m_t: update.hysteresis_field_m_t,
            finished: update.finished,
            last_step_at: stage_started_at,
            stage_started_at,
        }
    }

    pub(crate) fn record(&mut self, update: &fullmag_runner::StepUpdate) {
        let frequency_response_progress = self
            .stats
            .per_object_scalars
            .get("fem_frequency_response_progress")
            .cloned();
        self.stats = update.stats.clone();
        if let Some(progress) = frequency_response_progress {
            self.stats
                .per_object_scalars
                .entry("fem_frequency_response_progress".to_string())
                .or_insert(progress);
        }
        self.hysteresis_field_m_t = update.hysteresis_field_m_t;
        self.finished = update.finished;
        self.last_step_at = Instant::now();
    }

    pub(crate) fn apply_to_live_step(&self, step: &mut crate::types::LiveStepView) {
        step.step = self.stats.step;
        step.time = self.stats.time;
        step.dt = self.stats.dt;
        step.pseudo_time_s = self.stats.pseudo_time_s;
        step.e_ex = self.stats.e_ex;
        step.e_demag = self.stats.e_demag;
        step.e_ext = self.stats.e_ext;
        step.e_ani = self.stats.e_ani;
        step.e_dmi = self.stats.e_dmi;
        step.e_total = self.stats.e_total;
        step.max_dm_dt = self.stats.max_dm_dt;
        step.max_h_eff = self.stats.max_h_eff;
        step.max_h_demag = self.stats.max_h_demag;
        step.max_torque_Apm = self.stats.max_torque_Apm;
        step.max_torque_T = self.stats.max_torque_T;
        step.wall_time_ns = self.stats.wall_time_ns;
        step.per_object_scalars = self.stats.per_object_scalars.clone();
        step.finished = self.finished;
    }

    pub(crate) fn apply_to_run(&self, run: &mut crate::types::RunManifest) {
        run.status = if self.finished {
            "completed"
        } else {
            "running"
        }
        .to_string();
        run.total_steps = self.stats.step as usize;
        run.final_time = Some(self.stats.time);
        run.final_e_ex = Some(self.stats.e_ex);
        run.final_e_demag = Some(self.stats.e_demag);
        run.final_e_ext = Some(self.stats.e_ext);
        run.final_e_ani = Some(self.stats.e_ani);
        run.final_e_dmi = Some(self.stats.e_dmi);
        run.final_e_total = Some(self.stats.e_total);
    }
}
