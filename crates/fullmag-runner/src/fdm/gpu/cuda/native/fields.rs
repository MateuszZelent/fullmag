use super::math::{flatten_vectors_f32, flatten_vectors_f64, unpack_flat_f32, unpack_flat_f64};
use super::{ffi, NativeFdmBackend};
use crate::derived_fields::compute_torque_field;
use crate::types::RunError;

impl NativeFdmBackend {
    /// Copy a field observable from device to host as [f64; 3] AoS.
    pub fn copy_field(
        &self,
        observable: ffi::fullmag_fdm_observable,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        let len = cell_count * 3;
        let mut flat = vec![0.0f64; len];

        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_field_f64(
                self.handle as *mut _,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("copy_field failed"));
        }

        Ok(unpack_flat_f64(&flat))
    }

    /// Copy a field observable from device to host as [f32; 3] AoS.
    pub fn copy_field_f32(
        &self,
        observable: ffi::fullmag_fdm_observable,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        let len = cell_count * 3;
        let mut flat = vec![0.0f32; len];

        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_field_f32(
                self.handle as *mut _,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("copy_field_f32 failed"));
        }

        Ok(unpack_flat_f32(&flat))
    }

    pub fn copy_layer_field(
        &self,
        layer_index: u32,
        observable: ffi::fullmag_fdm_observable,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        let len = cell_count * 3;
        let mut flat = vec![0.0f64; len];

        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_layer_field_f64(
                self.handle as *mut _,
                layer_index,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("copy_layer_field failed"));
        }

        Ok(unpack_flat_f64(&flat))
    }

    pub fn copy_layer_field_f32(
        &self,
        layer_index: u32,
        observable: ffi::fullmag_fdm_observable,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        let len = cell_count * 3;
        let mut flat = vec![0.0f32; len];

        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_layer_field_f32(
                self.handle as *mut _,
                layer_index,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("copy_layer_field_f32 failed"));
        }

        Ok(unpack_flat_f32(&flat))
    }

    pub fn copy_m(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_M,
            cell_count,
        )
    }

    pub fn copy_h_ex(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EX,
            cell_count,
        )
    }

    pub fn copy_h_demag(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
            cell_count,
        )
    }

    pub fn copy_h_ext(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_oe(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_OE,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_ani(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
            cell_count,
        )
    }

    pub fn copy_h_eff(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
            cell_count,
        )
    }

    pub fn copy_torque(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        let magnetization = self.copy_m(cell_count)?;
        let effective_field = self.copy_h_eff(cell_count)?;
        Ok(compute_torque_field(
            &magnetization,
            &effective_field,
            self.damping,
            self.precession_enabled,
        ))
    }

    #[allow(dead_code)]
    pub fn copy_m_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_M,
            cell_count,
        )
    }

    pub fn copy_h_ex_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EX,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_demag_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
            cell_count,
        )
    }

    pub fn copy_layer_h_demag(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
            cell_count,
        )
    }

    pub fn copy_layer_h_demag_f32(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_layer_field_f32(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_dmi(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DMI,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_dmi_f32(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_layer_field_f32(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DMI,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_ext(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_ext_f32(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_layer_field_f32(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_ani(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_ani_f32(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_layer_field_f32(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_eff(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_eff_f32(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_layer_field_f32(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_ext_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_ani_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_eff_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
            cell_count,
        )
    }

    pub fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        let flat = flatten_vectors_f64(magnetization);
        let rc = unsafe {
            ffi::fullmag_fdm_backend_upload_magnetization_f64(
                self.handle as *mut _,
                flat.as_ptr(),
                flat.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("upload_magnetization failed"));
        }
        Ok(())
    }

    pub fn upload_magnetization_f32(&mut self, magnetization: &[[f32; 3]]) -> Result<(), RunError> {
        let flat = flatten_vectors_f32(magnetization);
        let rc = unsafe {
            ffi::fullmag_fdm_backend_upload_magnetization_f32(
                self.handle as *mut _,
                flat.as_ptr(),
                flat.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("upload_magnetization_f32 failed"));
        }
        Ok(())
    }

    pub fn upload_layer_magnetization(
        &mut self,
        layer_index: u32,
        magnetization: &[[f64; 3]],
    ) -> Result<(), RunError> {
        let flat = flatten_vectors_f64(magnetization);
        let rc = unsafe {
            ffi::fullmag_fdm_backend_upload_layer_magnetization_f64(
                self.handle as *mut _,
                layer_index,
                flat.as_ptr(),
                flat.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("upload_layer_magnetization failed"));
        }
        Ok(())
    }

    pub fn upload_layer_magnetization_f32(
        &mut self,
        layer_index: u32,
        magnetization: &[[f32; 3]],
    ) -> Result<(), RunError> {
        let flat = flatten_vectors_f32(magnetization);
        let rc = unsafe {
            ffi::fullmag_fdm_backend_upload_layer_magnetization_f32(
                self.handle as *mut _,
                layer_index,
                flat.as_ptr(),
                flat.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("upload_layer_magnetization_f32 failed"));
        }
        Ok(())
    }
}
