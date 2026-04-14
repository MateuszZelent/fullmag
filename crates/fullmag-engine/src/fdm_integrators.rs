//! Time integrator methods for ExchangeLlgProblem.
//!
//! All methods are `impl ExchangeLlgProblem` — Rust allows splitting impls
//! across multiple files within the same crate.

use crate::vector::{add, norm, normalized, scale};
use crate::{
    ExchangeLlgProblem, ExchangeLlgState, FftWorkspace, IntegratorBuffers, Result, StepReport,
    Vector3,
};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

impl ExchangeLlgProblem {
    // -----------------------------------------------------------------------
    // Legacy allocating Heun step
    // -----------------------------------------------------------------------
    pub(crate) fn heun_step(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        let initial = state.magnetization.clone();
        let k1 = self.llg_rhs_from_vectors_ws(&initial, ws);

        let predicted = {
            let compute = |i: usize| normalized(add(initial[i], scale(k1[i], dt)));
            #[cfg(feature = "parallel")]
            {
                (0..initial.len())
                    .into_par_iter()
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
            #[cfg(not(feature = "parallel"))]
            {
                (0..initial.len())
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
        };

        let k2 = self.llg_rhs_from_vectors_ws(&predicted, ws);
        let corrected = {
            let compute =
                |i: usize| normalized(add(initial[i], scale(add(k1[i], k2[i]), 0.5 * dt)));
            #[cfg(feature = "parallel")]
            {
                (0..initial.len())
                    .into_par_iter()
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
            #[cfg(not(feature = "parallel"))]
            {
                (0..initial.len())
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
        };

        state.magnetization = corrected;
        state.time_seconds += dt;

        let observables = self.observe_vectors_ws(state.magnetization(), ws);

        Ok(StepReport {
            time_seconds: state.time_seconds,
            dt_used: dt,
            step_rejected: false,
            suggested_next_dt: None,
            exchange_energy_joules: observables.exchange_energy_joules,
            demag_energy_joules: observables.demag_energy_joules,
            external_energy_joules: observables.external_energy_joules,
            total_energy_joules: observables.total_energy_joules,
            max_effective_field_amplitude: observables.max_effective_field_amplitude,
            max_demag_field_amplitude: observables.max_demag_field_amplitude,
            max_rhs_amplitude: observables.max_rhs_amplitude,
            max_torque_Apm: observables.max_torque_Apm,
        })
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing Heun step (zero-allocation hot path)
    // -----------------------------------------------------------------------
    pub(crate) fn heun_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        // k1 = f(t, m0)
        self.effective_field_into_ws(&bufs.m0[..n], ws, &mut bufs.h_eff[..n]);
        {
            let (k, m0, heff) = (&mut bufs.k[0][..n], &bufs.m0[..n], &bufs.h_eff[..n]);
            #[cfg(feature = "parallel")]
            k.par_iter_mut()
                .zip(m0.par_iter())
                .zip(heff.par_iter())
                .for_each(|((k, m), h)| {
                    *k = self.llg_rhs_from_field(*m, *h);
                });
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                k[i] = self.llg_rhs_from_field(m0[i], heff[i]);
            }
        }

        // predicted = normalize(m0 + dt * k1)
        {
            let (stage, m0, k0) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[0][..n]);
            #[cfg(feature = "parallel")]
            stage
                .par_iter_mut()
                .zip(m0.par_iter())
                .zip(k0.par_iter())
                .try_for_each(|((s, m), k)| -> Result<()> {
                    *s = normalized(add(*m, scale(*k, dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                stage[i] = normalized(add(m0[i], scale(k0[i], dt)))?;
            }
        }

        // k2 = f(t+dt, predicted)
        self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
        {
            let (k, ms, heff) = (&mut bufs.k[1][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
            #[cfg(feature = "parallel")]
            k.par_iter_mut()
                .zip(ms.par_iter())
                .zip(heff.par_iter())
                .for_each(|((k, m), h)| {
                    *k = self.llg_rhs_from_field(*m, *h);
                });
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                k[i] = self.llg_rhs_from_field(ms[i], heff[i]);
            }
        }

        // corrected = normalize(m0 + dt/2 * (k1 + k2))
        {
            let (mag, m0, k0, k1) = (
                &mut state.magnetization[..n],
                &bufs.m0[..n],
                &bufs.k[0][..n],
                &bufs.k[1][..n],
            );
            #[cfg(feature = "parallel")]
            mag.par_iter_mut()
                .zip(m0.par_iter())
                .zip(k0.par_iter())
                .zip(k1.par_iter())
                .try_for_each(|(((m, m0), k0), k1)| -> Result<()> {
                    *m = normalized(add(*m0, scale(add(*k0, *k1), 0.5 * dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                mag[i] = normalized(add(m0[i], scale(add(k0[i], k1[i]), 0.5 * dt)))?;
            }
        }
        state.time_seconds += dt;

        let eval = self.compute_step_observables_zero_alloc(
            &state.magnetization,
            ws,
            &mut bufs.h_eff,
            &mut bufs.h_scratch,
            &mut bufs.rhs,
        );
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing RK4 step (zero-allocation hot path)
    // -----------------------------------------------------------------------
    pub(crate) fn rk4_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        // k1 = f(t, m0)
        self.effective_field_into_ws(&bufs.m0[..n], ws, &mut bufs.h_eff[..n]);
        {
            let (k, m, heff) = (&mut bufs.k[0][..n], &bufs.m0[..n], &bufs.h_eff[..n]);
            #[cfg(feature = "parallel")]
            k.par_iter_mut()
                .zip(m.par_iter())
                .zip(heff.par_iter())
                .for_each(|((k, m), h)| {
                    *k = self.llg_rhs_from_field(*m, *h);
                });
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                k[i] = self.llg_rhs_from_field(m[i], heff[i]);
            }
        }

        // m1 = normalize(m0 + dt/2 * k1)
        {
            let (stage, m0, kj) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[0][..n]);
            #[cfg(feature = "parallel")]
            stage
                .par_iter_mut()
                .zip(m0.par_iter())
                .zip(kj.par_iter())
                .try_for_each(|((s, m), k)| -> Result<()> {
                    *s = normalized(add(*m, scale(*k, 0.5 * dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                stage[i] = normalized(add(m0[i], scale(kj[i], 0.5 * dt)))?;
            }
        }
        self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
        {
            let (k, m, heff) = (&mut bufs.k[1][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
            #[cfg(feature = "parallel")]
            k.par_iter_mut()
                .zip(m.par_iter())
                .zip(heff.par_iter())
                .for_each(|((k, m), h)| {
                    *k = self.llg_rhs_from_field(*m, *h);
                });
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                k[i] = self.llg_rhs_from_field(m[i], heff[i]);
            }
        }

        // m2 = normalize(m0 + dt/2 * k2)
        {
            let (stage, m0, kj) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[1][..n]);
            #[cfg(feature = "parallel")]
            stage
                .par_iter_mut()
                .zip(m0.par_iter())
                .zip(kj.par_iter())
                .try_for_each(|((s, m), k)| -> Result<()> {
                    *s = normalized(add(*m, scale(*k, 0.5 * dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                stage[i] = normalized(add(m0[i], scale(kj[i], 0.5 * dt)))?;
            }
        }
        self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
        {
            let (k, m, heff) = (&mut bufs.k[2][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
            #[cfg(feature = "parallel")]
            k.par_iter_mut()
                .zip(m.par_iter())
                .zip(heff.par_iter())
                .for_each(|((k, m), h)| {
                    *k = self.llg_rhs_from_field(*m, *h);
                });
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                k[i] = self.llg_rhs_from_field(m[i], heff[i]);
            }
        }

        // m3 = normalize(m0 + dt * k3)
        {
            let (stage, m0, kj) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[2][..n]);
            #[cfg(feature = "parallel")]
            stage
                .par_iter_mut()
                .zip(m0.par_iter())
                .zip(kj.par_iter())
                .try_for_each(|((s, m), k)| -> Result<()> {
                    *s = normalized(add(*m, scale(*k, dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                stage[i] = normalized(add(m0[i], scale(kj[i], dt)))?;
            }
        }
        self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
        {
            let (k, m, heff) = (&mut bufs.k[3][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
            #[cfg(feature = "parallel")]
            k.par_iter_mut()
                .zip(m.par_iter())
                .zip(heff.par_iter())
                .for_each(|((k, m), h)| {
                    *k = self.llg_rhs_from_field(*m, *h);
                });
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                k[i] = self.llg_rhs_from_field(m[i], heff[i]);
            }
        }

        // y = normalize(m0 + dt/6 * (k1 + 2*k2 + 2*k3 + k4))
        {
            let (mag, m0) = (&mut state.magnetization[..n], &bufs.m0[..n]);
            let (k0, k1, k2, k3) = (
                &bufs.k[0][..n],
                &bufs.k[1][..n],
                &bufs.k[2][..n],
                &bufs.k[3][..n],
            );
            let dt6 = dt / 6.0;
            #[cfg(feature = "parallel")]
            mag.par_iter_mut()
                .enumerate()
                .try_for_each(|(i, m)| -> Result<()> {
                    *m = normalized(add(
                        m0[i],
                        scale(
                            add(add(k0[i], scale(k1[i], 2.0)), add(scale(k2[i], 2.0), k3[i])),
                            dt6,
                        ),
                    ))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                mag[i] = normalized(add(
                    m0[i],
                    scale(
                        add(add(k0[i], scale(k1[i], 2.0)), add(scale(k2[i], 2.0), k3[i])),
                        dt6,
                    ),
                ))?;
            }
        }
        state.time_seconds += dt;

        let eval = self.compute_step_observables_zero_alloc(
            &state.magnetization,
            ws,
            &mut bufs.h_eff,
            &mut bufs.h_scratch,
            &mut bufs.rhs,
        );
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    // -----------------------------------------------------------------------
    // In-place RHS helpers
    // -----------------------------------------------------------------------
    #[allow(dead_code)]
    pub(crate) fn llg_rhs_into_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        out: &mut [Vector3],
    ) {
        let rhs = self.llg_rhs_from_vectors_ws(magnetization, ws);
        out[..rhs.len()].copy_from_slice(&rhs);
    }

    pub(crate) fn _llg_rhs_full_into_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
        h_scratch: &mut [Vector3],
        out: &mut [Vector3],
    ) -> crate::RhsEvaluation {
        self.compute_step_observables_zero_alloc(magnetization, ws, h_eff, h_scratch, out)
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing RK23 (Bogacki-Shampine 2(3), adaptive)
    // -----------------------------------------------------------------------
    pub(crate) fn rk23_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        loop {
            // k1 = f(t, m0)
            self.effective_field_into_ws(&bufs.m0[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[0][..n], &bufs.m0[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // m1 = normalize(m0 + dt/2 * k1)
            {
                let (stage, m0, kj) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[0][..n]);
                let f = 0.5 * dt;
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .zip(kj.par_iter())
                    .try_for_each(|((s, m), k)| -> Result<()> {
                        *s = normalized(add(*m, scale(*k, f)))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(m0[i], scale(kj[i], f)))?;
                }
            }
            self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[1][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // m2 = normalize(m0 + 3dt/4 * k2)
            {
                let (stage, m0, kj) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[1][..n]);
                let f = 0.75 * dt;
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .zip(kj.par_iter())
                    .try_for_each(|((s, m), k)| -> Result<()> {
                        *s = normalized(add(*m, scale(*k, f)))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(m0[i], scale(kj[i], f)))?;
                }
            }
            self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[2][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // y3 = normalize(m0 + dt*(2/9*k1 + 1/3*k2 + 4/9*k3))
            {
                let (delta, stage, m0) =
                    (&mut bufs.delta[..n], &mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k1, k2) = (&bufs.k[0][..n], &bufs.k[1][..n], &bufs.k[2][..n]);
                #[cfg(feature = "parallel")]
                delta
                    .par_iter_mut()
                    .zip(stage.par_iter_mut())
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, ((d, s), m))| -> Result<()> {
                        *d = scale(
                            add(
                                add(scale(k0[i], 2.0 / 9.0), scale(k1[i], 1.0 / 3.0)),
                                scale(k2[i], 4.0 / 9.0),
                            ),
                            dt,
                        );
                        *s = normalized(add(*m, *d))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    delta[i] = scale(
                        add(
                            add(scale(k0[i], 2.0 / 9.0), scale(k1[i], 1.0 / 3.0)),
                            scale(k2[i], 4.0 / 9.0),
                        ),
                        dt,
                    );
                    stage[i] = normalized(add(m0[i], delta[i]))?;
                }
            }

            // k4 for error estimate
            self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[3][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // Error
            let error = self.max_error_norm_buf(
                &[
                    (0, -5.0 / 72.0),
                    (1, 1.0 / 12.0),
                    (2, 1.0 / 9.0),
                    (3, -1.0 / 8.0),
                ],
                bufs,
                dt,
                n,
            );

            let thr = if cfg.rtol > 0.0 { 1.0 } else { cfg.max_error };

            if error <= thr || dt <= cfg.dt_min {
                state.magnetization[..n].copy_from_slice(&bufs.m_stage[..n]);
                state.time_seconds += dt;
                let ratio = (cfg.headroom * (thr / error.max(1e-30)).powf(1.0 / 3.0))
                    .min(cfg.growth_limit)
                    .max(cfg.shrink_limit);
                let dt_next = (dt * ratio).max(cfg.dt_min).min(cfg.dt_max);
                let eval = self.compute_step_observables_zero_alloc(
                    &state.magnetization,
                    ws,
                    &mut bufs.h_eff,
                    &mut bufs.h_scratch,
                    &mut bufs.rhs,
                );
                let mut report = eval.into_step_report(state.time_seconds, dt, false);
                report.suggested_next_dt = Some(dt_next);
                return Ok(report);
            }

            let ratio = (cfg.headroom * (thr / error).powf(1.0 / 3.0))
                .min(cfg.growth_limit)
                .max(cfg.shrink_limit);
            dt = (dt * ratio).max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing RK45 (Dormand-Prince 4(5), adaptive)
    // -----------------------------------------------------------------------
    pub(crate) fn rk45_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        // Dormand-Prince coefficients
        const A21: f64 = 1.0 / 5.0;
        const A31: f64 = 3.0 / 40.0;
        const A32: f64 = 9.0 / 40.0;
        const A41: f64 = 44.0 / 45.0;
        const A42: f64 = -56.0 / 15.0;
        const A43: f64 = 32.0 / 9.0;
        const A51: f64 = 19372.0 / 6561.0;
        const A52: f64 = -25360.0 / 2187.0;
        const A53: f64 = 64448.0 / 6561.0;
        const A54: f64 = -212.0 / 729.0;
        const A61: f64 = 9017.0 / 3168.0;
        const A62: f64 = -355.0 / 33.0;
        const A63: f64 = 46732.0 / 5247.0;
        const A64: f64 = 49.0 / 176.0;
        const A65: f64 = -5103.0 / 18656.0;
        const B1: f64 = 35.0 / 384.0;
        const B3: f64 = 500.0 / 1113.0;
        const B4: f64 = 125.0 / 192.0;
        const B5: f64 = -2187.0 / 6784.0;
        const B6: f64 = 11.0 / 84.0;
        const E1: f64 = 71.0 / 57600.0;
        const E3: f64 = -71.0 / 16695.0;
        const E4: f64 = 71.0 / 1920.0;
        const E5: f64 = -17253.0 / 339200.0;
        const E6: f64 = 22.0 / 525.0;
        const E7: f64 = -1.0 / 40.0;

        loop {
            // Stage 1 — FSAL: reuse k7 from previous accepted step
            if let Some(fsal) = state.k_fsal.take() {
                bufs.k[0][..n].copy_from_slice(&fsal);
            } else {
                self.effective_field_into_ws(&bufs.m0[..n], ws, &mut bufs.h_eff[..n]);
                let (k, m, heff) = (&mut bufs.k[0][..n], &bufs.m0[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // Stage 2
            {
                let (stage, m0, k0) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[0][..n]);
                let f = A21 * dt;
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .zip(k0.par_iter())
                    .try_for_each(|((s, m), k)| -> Result<()> {
                        *s = normalized(add(*m, scale(*k, f)))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(m0[i], scale(k0[i], f)))?;
                }
            }
            self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[1][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // Stage 3
            {
                let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k1) = (&bufs.k[0][..n], &bufs.k[1][..n]);
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, (s, m))| -> Result<()> {
                        *s = normalized(add(
                            *m,
                            scale(add(scale(k0[i], A31), scale(k1[i], A32)), dt),
                        ))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(
                        m0[i],
                        scale(add(scale(k0[i], A31), scale(k1[i], A32)), dt),
                    ))?;
                }
            }
            self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[2][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // Stage 4
            {
                let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k1, k2) = (&bufs.k[0][..n], &bufs.k[1][..n], &bufs.k[2][..n]);
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, (s, m))| -> Result<()> {
                        *s = normalized(add(
                            *m,
                            scale(
                                add(add(scale(k0[i], A41), scale(k1[i], A42)), scale(k2[i], A43)),
                                dt,
                            ),
                        ))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(
                        m0[i],
                        scale(
                            add(add(scale(k0[i], A41), scale(k1[i], A42)), scale(k2[i], A43)),
                            dt,
                        ),
                    ))?;
                }
            }
            self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[3][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // Stage 5
            {
                let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k1, k2, k3) = (
                    &bufs.k[0][..n],
                    &bufs.k[1][..n],
                    &bufs.k[2][..n],
                    &bufs.k[3][..n],
                );
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, (s, m))| -> Result<()> {
                        *s = normalized(add(
                            *m,
                            scale(
                                add(
                                    add(scale(k0[i], A51), scale(k1[i], A52)),
                                    add(scale(k2[i], A53), scale(k3[i], A54)),
                                ),
                                dt,
                            ),
                        ))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(
                        m0[i],
                        scale(
                            add(
                                add(scale(k0[i], A51), scale(k1[i], A52)),
                                add(scale(k2[i], A53), scale(k3[i], A54)),
                            ),
                            dt,
                        ),
                    ))?;
                }
            }
            self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[4][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // Stage 6
            {
                let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k1, k2, k3, k4) = (
                    &bufs.k[0][..n],
                    &bufs.k[1][..n],
                    &bufs.k[2][..n],
                    &bufs.k[3][..n],
                    &bufs.k[4][..n],
                );
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, (s, m))| -> Result<()> {
                        *s = normalized(add(
                            *m,
                            scale(
                                add(
                                    add(
                                        add(scale(k0[i], A61), scale(k1[i], A62)),
                                        scale(k2[i], A63),
                                    ),
                                    add(scale(k3[i], A64), scale(k4[i], A65)),
                                ),
                                dt,
                            ),
                        ))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(
                        m0[i],
                        scale(
                            add(
                                add(add(scale(k0[i], A61), scale(k1[i], A62)), scale(k2[i], A63)),
                                add(scale(k3[i], A64), scale(k4[i], A65)),
                            ),
                            dt,
                        ),
                    ))?;
                }
            }
            self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[5][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // 5th-order solution → m_stage
            {
                let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
                let (k0, k2, k3, k4, k5) = (
                    &bufs.k[0][..n],
                    &bufs.k[2][..n],
                    &bufs.k[3][..n],
                    &bufs.k[4][..n],
                    &bufs.k[5][..n],
                );
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .enumerate()
                    .try_for_each(|(i, (s, m))| -> Result<()> {
                        *s = normalized(add(
                            *m,
                            scale(
                                add(
                                    add(add(scale(k0[i], B1), scale(k2[i], B3)), scale(k3[i], B4)),
                                    add(scale(k4[i], B5), scale(k5[i], B6)),
                                ),
                                dt,
                            ),
                        ))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(
                        m0[i],
                        scale(
                            add(
                                add(add(scale(k0[i], B1), scale(k2[i], B3)), scale(k3[i], B4)),
                                add(scale(k4[i], B5), scale(k5[i], B6)),
                            ),
                            dt,
                        ),
                    ))?;
                }
            }

            // k7 for error estimate (FSAL) → k[6]
            self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[6][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // Error estimate
            let error = self.max_error_norm_buf(
                &[(0, E1), (2, E3), (3, E4), (4, E5), (5, E6), (6, E7)],
                bufs,
                dt,
                n,
            );

            let thr = if cfg.rtol > 0.0 { 1.0 } else { cfg.max_error };

            if error <= thr || dt <= cfg.dt_min {
                state.magnetization[..n].copy_from_slice(&bufs.m_stage[..n]);
                state.time_seconds += dt;
                state.k_fsal = Some(bufs.k[6][..n].to_vec());
                let ratio = (cfg.headroom * (thr / error.max(1e-30)).powf(0.2))
                    .min(cfg.growth_limit)
                    .max(cfg.shrink_limit);
                let dt_next = (dt * ratio).max(cfg.dt_min).min(cfg.dt_max);
                let eval = self.compute_step_observables_zero_alloc(
                    &state.magnetization,
                    ws,
                    &mut bufs.h_eff,
                    &mut bufs.h_scratch,
                    &mut bufs.rhs,
                );
                let mut report = eval.into_step_report(state.time_seconds, dt, false);
                report.suggested_next_dt = Some(dt_next);
                return Ok(report);
            }

            let ratio = (cfg.headroom * (thr / error).powf(0.2))
                .min(cfg.growth_limit)
                .max(cfg.shrink_limit);
            dt = (dt * ratio).max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing ABM3 (Adams–Bashforth–Moulton 3rd order)
    // -----------------------------------------------------------------------
    pub(crate) fn abm3_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();

        // During startup, fall back to Heun to build history
        if !state.abm_history.is_ready() {
            bufs.m0[..n].copy_from_slice(&state.magnetization);

            // k1 = f(t, m0)
            self.effective_field_into_ws(&bufs.m0[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[0][..n], &bufs.m0[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // predicted = normalize(m0 + dt * k1)
            {
                let (stage, m0, k0) = (&mut bufs.m_stage[..n], &bufs.m0[..n], &bufs.k[0][..n]);
                #[cfg(feature = "parallel")]
                stage
                    .par_iter_mut()
                    .zip(m0.par_iter())
                    .zip(k0.par_iter())
                    .try_for_each(|((s, m), k)| -> Result<()> {
                        *s = normalized(add(*m, scale(*k, dt)))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    stage[i] = normalized(add(m0[i], scale(k0[i], dt)))?;
                }
            }

            // k2 = f(t+dt, predicted)
            self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
            {
                let (k, m, heff) = (&mut bufs.k[1][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
                #[cfg(feature = "parallel")]
                k.par_iter_mut()
                    .zip(m.par_iter())
                    .zip(heff.par_iter())
                    .for_each(|((k, m), h)| {
                        *k = self.llg_rhs_from_field(*m, *h);
                    });
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    k[i] = self.llg_rhs_from_field(m[i], heff[i]);
                }
            }

            // corrected = normalize(m0 + dt/2 * (k1 + k2))
            {
                let (mag, m0, k0, k1) = (
                    &mut state.magnetization[..n],
                    &bufs.m0[..n],
                    &bufs.k[0][..n],
                    &bufs.k[1][..n],
                );
                #[cfg(feature = "parallel")]
                mag.par_iter_mut()
                    .zip(m0.par_iter())
                    .zip(k0.par_iter())
                    .zip(k1.par_iter())
                    .try_for_each(|(((m, m0), k0), k1)| -> Result<()> {
                        *m = normalized(add(*m0, scale(add(*k0, *k1), 0.5 * dt)))?;
                        Ok(())
                    })?;
                #[cfg(not(feature = "parallel"))]
                for i in 0..n {
                    mag[i] = normalized(add(m0[i], scale(add(k0[i], k1[i]), 0.5 * dt)))?;
                }
            }
            state.time_seconds += dt;

            // Store RHS at accepted point for history
            let f_accepted = self.llg_rhs_from_vectors_ws(state.magnetization(), ws);
            state.abm_history.push(f_accepted, dt);

            let eval = self.compute_step_observables_zero_alloc(
                &state.magnetization,
                ws,
                &mut bufs.h_eff,
                &mut bufs.h_scratch,
                &mut bufs.rhs,
            );
            return Ok(eval.into_step_report(state.time_seconds, dt, false));
        }

        // --- Full ABM3 step ---
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        let f_n = state.abm_history.f_n().unwrap();
        let f_n1 = state.abm_history.f_n_minus_1().unwrap();
        let f_n2 = state.abm_history.f_n_minus_2().unwrap();

        // Adams–Bashforth predictor → m_stage
        {
            let (stage, m0) = (&mut bufs.m_stage[..n], &bufs.m0[..n]);
            #[cfg(feature = "parallel")]
            stage
                .par_iter_mut()
                .zip(m0.par_iter())
                .enumerate()
                .try_for_each(|(i, (s, m))| -> Result<()> {
                    let pred = add(
                        add(scale(f_n[i], 23.0 / 12.0), scale(f_n1[i], -16.0 / 12.0)),
                        scale(f_n2[i], 5.0 / 12.0),
                    );
                    *s = normalized(add(*m, scale(pred, dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                let pred = add(
                    add(scale(f_n[i], 23.0 / 12.0), scale(f_n1[i], -16.0 / 12.0)),
                    scale(f_n2[i], 5.0 / 12.0),
                );
                stage[i] = normalized(add(m0[i], scale(pred, dt)))?;
            }
        }

        // Evaluate RHS at predicted point → k[0]
        self.effective_field_into_ws(&bufs.m_stage[..n], ws, &mut bufs.h_eff[..n]);
        {
            let (k, m, heff) = (&mut bufs.k[0][..n], &bufs.m_stage[..n], &bufs.h_eff[..n]);
            #[cfg(feature = "parallel")]
            k.par_iter_mut()
                .zip(m.par_iter())
                .zip(heff.par_iter())
                .for_each(|((k, m), h)| {
                    *k = self.llg_rhs_from_field(*m, *h);
                });
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                k[i] = self.llg_rhs_from_field(m[i], heff[i]);
            }
        }

        // Adams–Moulton corrector → state.magnetization
        {
            let (mag, m0, k0) = (
                &mut state.magnetization[..n],
                &bufs.m0[..n],
                &bufs.k[0][..n],
            );
            #[cfg(feature = "parallel")]
            mag.par_iter_mut()
                .zip(m0.par_iter())
                .enumerate()
                .try_for_each(|(i, (m, m0))| -> Result<()> {
                    let corr = add(
                        add(scale(k0[i], 5.0 / 12.0), scale(f_n[i], 8.0 / 12.0)),
                        scale(f_n1[i], -1.0 / 12.0),
                    );
                    *m = normalized(add(*m0, scale(corr, dt)))?;
                    Ok(())
                })?;
            #[cfg(not(feature = "parallel"))]
            for i in 0..n {
                let corr = add(
                    add(scale(k0[i], 5.0 / 12.0), scale(f_n[i], 8.0 / 12.0)),
                    scale(f_n1[i], -1.0 / 12.0),
                );
                mag[i] = normalized(add(m0[i], scale(corr, dt)))?;
            }
        }
        state.time_seconds += dt;

        // Push f_star (k[0]) into history
        state.abm_history.push(bufs.k[0][..n].to_vec(), dt);

        let eval = self.compute_step_observables_zero_alloc(
            &state.magnetization,
            ws,
            &mut bufs.h_eff,
            &mut bufs.h_scratch,
            &mut bufs.rhs,
        );
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    // -----------------------------------------------------------------------
    // Error norm from buffer-indexed k-stages
    // -----------------------------------------------------------------------
    pub(crate) fn max_error_norm_buf(
        &self,
        weighted_stages: &[(usize, f64)],
        bufs: &IntegratorBuffers,
        dt: f64,
        n: usize,
    ) -> f64 {
        let cfg = self.dynamics.adaptive;
        let use_rtol = cfg.rtol > 0.0;
        let atol = cfg.max_error;
        let rtol = cfg.rtol;

        let compute_err = |i: usize| -> f64 {
            let mut err = [0.0, 0.0, 0.0];
            for &(k_idx, w) in weighted_stages {
                err[0] += w * bufs.k[k_idx][i][0];
                err[1] += w * bufs.k[k_idx][i][1];
                err[2] += w * bufs.k[k_idx][i][2];
            }
            err[0] *= dt;
            err[1] *= dt;
            err[2] *= dt;
            if use_rtol {
                let y_norm = norm(bufs.m0[i]).max(1e-30);
                let sc = atol + rtol * y_norm;
                norm(err) / sc
            } else {
                norm(err)
            }
        };

        #[cfg(feature = "parallel")]
        {
            (0..n)
                .into_par_iter()
                .map(compute_err)
                .reduce(|| 0.0f64, f64::max)
        }
        #[cfg(not(feature = "parallel"))]
        {
            let mut max_err = 0.0f64;
            for i in 0..n {
                max_err = max_err.max(compute_err(i));
            }
            max_err
        }
    }

    // -----------------------------------------------------------------------
    // Helper: build StepReport from observables
    // -----------------------------------------------------------------------
    pub(crate) fn make_step_report(
        &self,
        state: &ExchangeLlgState,
        dt_used: f64,
        step_rejected: bool,
        ws: &mut FftWorkspace,
    ) -> StepReport {
        let observables = self.observe_vectors_ws(state.magnetization(), ws);
        StepReport {
            time_seconds: state.time_seconds,
            dt_used,
            step_rejected,
            suggested_next_dt: None,
            exchange_energy_joules: observables.exchange_energy_joules,
            demag_energy_joules: observables.demag_energy_joules,
            external_energy_joules: observables.external_energy_joules,
            total_energy_joules: observables.total_energy_joules,
            max_effective_field_amplitude: observables.max_effective_field_amplitude,
            max_demag_field_amplitude: observables.max_demag_field_amplitude,
            max_rhs_amplitude: observables.max_rhs_amplitude,
            max_torque_Apm: observables.max_torque_Apm,
        }
    }

    // -----------------------------------------------------------------------
    // Helper: parallel/sequential m_new[i] = normalize(m0[i] + delta[i])
    // -----------------------------------------------------------------------
    pub(crate) fn par_apply_normalized(
        &self,
        m0: &[Vector3],
        delta: &[Vector3],
    ) -> Result<Vec<Vector3>> {
        let compute = |i: usize| normalized(add(m0[i], delta[i]));
        #[cfg(feature = "parallel")]
        {
            (0..m0.len())
                .into_par_iter()
                .map(compute)
                .collect::<Result<Vec<_>>>()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..m0.len()).map(compute).collect::<Result<Vec<_>>>()
        }
    }

    // -----------------------------------------------------------------------
    // Legacy allocating RK4
    // -----------------------------------------------------------------------
    pub(crate) fn rk4_step(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        let m0 = state.magnetization.clone();

        let k1 = self.llg_rhs_from_vectors_ws(&m0, ws);
        let delta: Vec<Vector3> = (0..n).map(|i| scale(k1[i], 0.5 * dt)).collect();
        let m1 = self.par_apply_normalized(&m0, &delta)?;

        let k2 = self.llg_rhs_from_vectors_ws(&m1, ws);
        let delta: Vec<Vector3> = (0..n).map(|i| scale(k2[i], 0.5 * dt)).collect();
        let m2 = self.par_apply_normalized(&m0, &delta)?;

        let k3 = self.llg_rhs_from_vectors_ws(&m2, ws);
        let delta: Vec<Vector3> = (0..n).map(|i| scale(k3[i], dt)).collect();
        let m3 = self.par_apply_normalized(&m0, &delta)?;

        let k4 = self.llg_rhs_from_vectors_ws(&m3, ws);
        let delta: Vec<Vector3> = (0..n)
            .map(|i| {
                scale(
                    add(add(k1[i], scale(k2[i], 2.0)), add(scale(k3[i], 2.0), k4[i])),
                    dt / 6.0,
                )
            })
            .collect();
        state.magnetization = self.par_apply_normalized(&m0, &delta)?;
        state.time_seconds += dt;

        Ok(self.make_step_report(state, dt, false, ws))
    }

    // -----------------------------------------------------------------------
    // Legacy allocating RK23
    // -----------------------------------------------------------------------
    pub(crate) fn rk23_step(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        let m0 = state.magnetization.clone();

        loop {
            let k1 = self.llg_rhs_from_vectors_ws(&m0, ws);
            let delta: Vec<Vector3> = (0..n).map(|i| scale(k1[i], 0.5 * dt)).collect();
            let m1 = self.par_apply_normalized(&m0, &delta)?;
            let k2 = self.llg_rhs_from_vectors_ws(&m1, ws);

            let delta: Vec<Vector3> = (0..n).map(|i| scale(k2[i], 0.75 * dt)).collect();
            let m2 = self.par_apply_normalized(&m0, &delta)?;
            let k3 = self.llg_rhs_from_vectors_ws(&m2, ws);

            let delta3: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(scale(k1[i], 2.0 / 9.0), scale(k2[i], 1.0 / 3.0)),
                            scale(k3[i], 4.0 / 9.0),
                        ),
                        dt,
                    )
                })
                .collect();
            let y3 = self.par_apply_normalized(&m0, &delta3)?;

            let k4 = self.llg_rhs_from_vectors_ws(&y3, ws);

            let error = self.max_error_norm(
                &[
                    (&k1, -5.0 / 72.0),
                    (&k2, 1.0 / 12.0),
                    (&k3, 1.0 / 9.0),
                    (&k4, -1.0 / 8.0),
                ],
                dt,
                n,
            );

            if error <= cfg.max_error || dt <= cfg.dt_min {
                state.magnetization = y3;
                state.time_seconds += dt;
                return Ok(self.make_step_report(state, dt, false, ws));
            }

            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(1.0 / 3.0);
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -----------------------------------------------------------------------
    // Legacy allocating RK45
    // -----------------------------------------------------------------------
    pub(crate) fn rk45_step(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        let m0 = state.magnetization.clone();

        const A21: f64 = 1.0 / 5.0;
        const A31: f64 = 3.0 / 40.0;
        const A32: f64 = 9.0 / 40.0;
        const A41: f64 = 44.0 / 45.0;
        const A42: f64 = -56.0 / 15.0;
        const A43: f64 = 32.0 / 9.0;
        const A51: f64 = 19372.0 / 6561.0;
        const A52: f64 = -25360.0 / 2187.0;
        const A53: f64 = 64448.0 / 6561.0;
        const A54: f64 = -212.0 / 729.0;
        const A61: f64 = 9017.0 / 3168.0;
        const A62: f64 = -355.0 / 33.0;
        const A63: f64 = 46732.0 / 5247.0;
        const A64: f64 = 49.0 / 176.0;
        const A65: f64 = -5103.0 / 18656.0;

        const B1: f64 = 35.0 / 384.0;
        const B3: f64 = 500.0 / 1113.0;
        const B4: f64 = 125.0 / 192.0;
        const B5: f64 = -2187.0 / 6784.0;
        const B6: f64 = 11.0 / 84.0;

        const E1: f64 = 71.0 / 57600.0;
        const E3: f64 = -71.0 / 16695.0;
        const E4: f64 = 71.0 / 1920.0;
        const E5: f64 = -17253.0 / 339200.0;
        const E6: f64 = 22.0 / 525.0;
        const E7: f64 = -1.0 / 40.0;

        loop {
            let k1 = if let Some(fsal) = state.k_fsal.take() {
                fsal
            } else {
                self.llg_rhs_from_vectors_ws(&m0, ws)
            };

            let delta: Vec<Vector3> = (0..n).map(|i| scale(k1[i], A21 * dt)).collect();
            let ms = self.par_apply_normalized(&m0, &delta)?;
            let k2 = self.llg_rhs_from_vectors_ws(&ms, ws);

            let delta: Vec<Vector3> = (0..n)
                .map(|i| scale(add(scale(k1[i], A31), scale(k2[i], A32)), dt))
                .collect();
            let ms = self.par_apply_normalized(&m0, &delta)?;
            let k3 = self.llg_rhs_from_vectors_ws(&ms, ws);

            let delta: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(add(scale(k1[i], A41), scale(k2[i], A42)), scale(k3[i], A43)),
                        dt,
                    )
                })
                .collect();
            let ms = self.par_apply_normalized(&m0, &delta)?;
            let k4 = self.llg_rhs_from_vectors_ws(&ms, ws);

            let delta: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(scale(k1[i], A51), scale(k2[i], A52)),
                            add(scale(k3[i], A53), scale(k4[i], A54)),
                        ),
                        dt,
                    )
                })
                .collect();
            let ms = self.par_apply_normalized(&m0, &delta)?;
            let k5 = self.llg_rhs_from_vectors_ws(&ms, ws);

            let delta: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(add(scale(k1[i], A61), scale(k2[i], A62)), scale(k3[i], A63)),
                            add(scale(k4[i], A64), scale(k5[i], A65)),
                        ),
                        dt,
                    )
                })
                .collect();
            let ms = self.par_apply_normalized(&m0, &delta)?;
            let k6 = self.llg_rhs_from_vectors_ws(&ms, ws);

            let delta5: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(add(scale(k1[i], B1), scale(k3[i], B3)), scale(k4[i], B4)),
                            add(scale(k5[i], B5), scale(k6[i], B6)),
                        ),
                        dt,
                    )
                })
                .collect();
            let y5 = self.par_apply_normalized(&m0, &delta5)?;

            let k7 = self.llg_rhs_from_vectors_ws(&y5, ws);

            let error = self.max_error_norm(
                &[
                    (&k1, E1),
                    (&k3, E3),
                    (&k4, E4),
                    (&k5, E5),
                    (&k6, E6),
                    (&k7, E7),
                ],
                dt,
                n,
            );

            if error <= cfg.max_error || dt <= cfg.dt_min {
                state.magnetization = y5;
                state.time_seconds += dt;
                state.k_fsal = Some(k7);
                return Ok(self.make_step_report(state, dt, false, ws));
            }

            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(0.2);
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -----------------------------------------------------------------------
    // Legacy allocating ABM3
    // -----------------------------------------------------------------------
    pub(crate) fn abm3_step(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();

        if !state.abm_history.is_ready() {
            let m0 = state.magnetization.clone();
            let k1 = self.llg_rhs_from_vectors_ws(&m0, ws);

            let predicted = {
                let compute = |i: usize| normalized(add(m0[i], scale(k1[i], dt)));
                #[cfg(feature = "parallel")]
                {
                    (0..n)
                        .into_par_iter()
                        .map(compute)
                        .collect::<Result<Vec<_>>>()?
                }
                #[cfg(not(feature = "parallel"))]
                {
                    (0..n).map(compute).collect::<Result<Vec<_>>>()?
                }
            };

            let k2 = self.llg_rhs_from_vectors_ws(&predicted, ws);
            let corrected = {
                let compute = |i: usize| normalized(add(m0[i], scale(add(k1[i], k2[i]), 0.5 * dt)));
                #[cfg(feature = "parallel")]
                {
                    (0..n)
                        .into_par_iter()
                        .map(compute)
                        .collect::<Result<Vec<_>>>()?
                }
                #[cfg(not(feature = "parallel"))]
                {
                    (0..n).map(compute).collect::<Result<Vec<_>>>()?
                }
            };

            state.magnetization = corrected;
            state.time_seconds += dt;

            let f_accepted = self.llg_rhs_from_vectors_ws(state.magnetization(), ws);
            state.abm_history.push(f_accepted, dt);

            return Ok(self.make_step_report(state, dt, false, ws));
        }

        let m0 = state.magnetization.clone();

        let f_n = state.abm_history.f_n.as_ref().unwrap();
        let f_n1 = state.abm_history.f_n_minus_1.as_ref().unwrap();
        let f_n2 = state.abm_history.f_n_minus_2.as_ref().unwrap();

        let m_predicted = {
            let compute = |i: usize| {
                let pred = add(
                    add(scale(f_n[i], 23.0 / 12.0), scale(f_n1[i], -16.0 / 12.0)),
                    scale(f_n2[i], 5.0 / 12.0),
                );
                normalized(add(m0[i], scale(pred, dt)))
            };
            #[cfg(feature = "parallel")]
            {
                (0..n)
                    .into_par_iter()
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
            #[cfg(not(feature = "parallel"))]
            {
                (0..n).map(compute).collect::<Result<Vec<_>>>()?
            }
        };

        let f_star = self.llg_rhs_from_vectors_ws(&m_predicted, ws);

        let m_corrected = {
            let compute = |i: usize| {
                let corr = add(
                    add(scale(f_star[i], 5.0 / 12.0), scale(f_n[i], 8.0 / 12.0)),
                    scale(f_n1[i], -1.0 / 12.0),
                );
                normalized(add(m0[i], scale(corr, dt)))
            };
            #[cfg(feature = "parallel")]
            {
                (0..n)
                    .into_par_iter()
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
            #[cfg(not(feature = "parallel"))]
            {
                (0..n).map(compute).collect::<Result<Vec<_>>>()?
            }
        };

        state.magnetization = m_corrected;
        state.time_seconds += dt;

        state.abm_history.push(f_star, dt);

        Ok(self.make_step_report(state, dt, false, ws))
    }

    // -----------------------------------------------------------------------
    // Legacy error norm helper
    // -----------------------------------------------------------------------
    pub(crate) fn max_error_norm(
        &self,
        weighted_stages: &[(&Vec<Vector3>, f64)],
        dt: f64,
        n: usize,
    ) -> f64 {
        let compute = |i: usize| {
            let mut err = [0.0, 0.0, 0.0];
            for &(k, w) in weighted_stages {
                err[0] += w * k[i][0];
                err[1] += w * k[i][1];
                err[2] += w * k[i][2];
            }
            err[0] *= dt;
            err[1] *= dt;
            err[2] *= dt;
            norm(err)
        };
        #[cfg(feature = "parallel")]
        {
            (0..n)
                .into_par_iter()
                .map(compute)
                .reduce(|| 0.0_f64, f64::max)
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..n).map(compute).fold(0.0_f64, f64::max)
        }
    }
}
