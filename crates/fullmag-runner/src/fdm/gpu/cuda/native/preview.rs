use super::{ffi, snapshot_observable, NativeFdmBackend, NativeFdmPreviewSnapshot};
use crate::derived_fields::compute_torque_field;
use crate::preview::{
    build_grid_preview_field_from_flat_plan, plan_grid_preview, resample_grid_mask,
};
use crate::quantities::normalized_quantity_name;
use crate::types::{LivePreviewField, LivePreviewRequest, RunError};

impl NativeFdmBackend {
    pub fn begin_live_preview_snapshot(
        &self,
        request: &LivePreviewRequest,
        original_grid: [u32; 3],
    ) -> Result<NativeFdmPreviewSnapshot, RunError> {
        let plan = plan_grid_preview(request, original_grid);
        let quantity = normalized_quantity_name(&request.quantity)?.to_string();
        let observable = snapshot_observable(&quantity).ok_or_else(|| RunError {
            message: format!("unsupported CUDA preview snapshot '{}'", request.quantity),
        })?;
        let handle = unsafe {
            ffi::fullmag_fdm_backend_begin_preview_snapshot(
                self.handle,
                observable,
                plan.preview_grid[0],
                plan.preview_grid[1],
                plan.preview_grid[2],
                plan.z_origin,
                plan.applied_layer_stride,
            )
        };
        if handle.is_null() {
            return Err(self.last_error_or("begin_live_preview_snapshot failed"));
        }
        Ok(NativeFdmPreviewSnapshot::new(
            handle,
            request.clone(),
            plan,
            quantity,
        ))
    }

    pub fn copy_live_preview_field(
        &self,
        request: &LivePreviewRequest,
        original_grid: [u32; 3],
        active_mask: Option<&[bool]>,
    ) -> Result<LivePreviewField, RunError> {
        let plan = plan_grid_preview(request, original_grid);
        let quantity = normalized_quantity_name(&request.quantity)?;
        let preview_count = (plan.preview_grid[0] as usize)
            * (plan.preview_grid[1] as usize)
            * (plan.preview_grid[2] as usize);
        if preview_count == 0 {
            return Err(RunError {
                message: "copy_field_preview planned an empty preview grid".to_string(),
            });
        }

        let flat = if quantity == "torque" {
            let cell_count = (original_grid[0] as usize)
                * (original_grid[1] as usize)
                * (original_grid[2] as usize);
            let magnetization = self.copy_m(cell_count)?;
            let effective_field = self.copy_h_eff(cell_count)?;
            let torque = compute_torque_field(
                &magnetization,
                &effective_field,
                self.damping,
                self.precession_enabled,
            );
            let sampled = crate::preview::resample_grid_vectors(&torque, &plan);
            crate::preview::flatten_vectors(&sampled)
        } else {
            let observable = match quantity {
                "H_ex" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EX,
                "H_demag" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
                "H_ext" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
                "H_oe" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_OE,
                "H_ani" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
                "H_eff" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
                _ => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_M,
            };
            let len = preview_count * 3;
            if self.precision == fullmag_ir::ExecutionPrecision::Single {
                let mut flat = vec![0.0f32; len];
                let rc = unsafe {
                    ffi::fullmag_fdm_backend_copy_field_preview_f32(
                        self.handle as *mut _,
                        observable,
                        plan.preview_grid[0],
                        plan.preview_grid[1],
                        plan.preview_grid[2],
                        plan.z_origin,
                        plan.applied_layer_stride,
                        flat.as_mut_ptr(),
                        len as u64,
                    )
                };
                if rc != ffi::FULLMAG_FDM_OK {
                    return Err(self.last_error_or("copy_field_preview_f32 failed"));
                }
                flat.into_iter().map(f64::from).collect()
            } else {
                let mut flat = vec![0.0f64; len];
                let rc = unsafe {
                    ffi::fullmag_fdm_backend_copy_field_preview_f64(
                        self.handle as *mut _,
                        observable,
                        plan.preview_grid[0],
                        plan.preview_grid[1],
                        plan.preview_grid[2],
                        plan.z_origin,
                        plan.applied_layer_stride,
                        flat.as_mut_ptr(),
                        len as u64,
                    )
                };
                if rc != ffi::FULLMAG_FDM_OK {
                    return Err(self.last_error_or("copy_field_preview failed"));
                }
                flat
            }
        };
        Ok(build_grid_preview_field_from_flat_plan(
            request,
            &plan,
            flat,
            quantity,
            active_mask.map(|mask| resample_grid_mask(mask, &plan)),
        ))
    }
}
