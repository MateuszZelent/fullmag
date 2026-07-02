#[cfg(feature = "cuda")]
use fullmag_fdm_sys as ffi;

#[cfg(feature = "cuda")]
use crate::preview::{
    build_grid_preview_field_from_flat_plan, resample_grid_mask, GridPreviewPlan,
};
#[cfg(feature = "cuda")]
use crate::types::{LivePreviewField, LivePreviewRequest, RunError};

#[cfg(feature = "cuda")]
use std::io::Write;

#[cfg(feature = "cuda")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeFieldSnapshotScalarType {
    F32,
    F64,
}

#[cfg(feature = "cuda")]
#[derive(Debug, Clone, Copy)]
pub(crate) struct NativeFieldSnapshotInfo {
    pub cell_count: usize,
    pub component_count: usize,
    pub scalar_bytes: usize,
    pub scalar_type: NativeFieldSnapshotScalarType,
}

#[cfg(feature = "cuda")]
#[derive(Debug)]
struct NativeFieldSnapshotReady {
    /// Owned copy of the snapshot bytes, copied from the native buffer at the
    /// FFI boundary.  No raw pointer escapes after `ensure_ready` returns.
    data: Vec<u8>,
    info: NativeFieldSnapshotInfo,
}

#[cfg(feature = "cuda")]
#[derive(Debug)]
pub(crate) struct NativeFdmFieldSnapshot {
    handle: *mut ffi::fullmag_fdm_field_snapshot,
    pub name: String,
    pub step: u64,
    pub time: f64,
    pub solver_dt: f64,
    ready: Option<NativeFieldSnapshotReady>,
}

#[cfg(feature = "cuda")]
// SAFETY: `NativeFdmFieldSnapshot` is sent between threads only between its
// construction (on the runner thread) and its consumption (on the writer
// thread).  The native handle is valid for the object's lifetime and is only
// freed via `Drop`.  Snapshot data is copied into `ready.data: Vec<u8>` at the
// FFI boundary, so no aliased raw pointer to CUDA-managed memory is
// reachable from other threads.
unsafe impl Send for NativeFdmFieldSnapshot {}

#[cfg(feature = "cuda")]
#[derive(Debug)]
pub(crate) struct NativeFdmPreviewSnapshot {
    handle: *mut ffi::fullmag_fdm_preview_snapshot,
    request: LivePreviewRequest,
    plan: GridPreviewPlan,
    quantity: String,
    ready: Option<NativeFieldSnapshotReady>,
}

#[cfg(feature = "cuda")]
// SAFETY: same invariants as `NativeFdmFieldSnapshot` above.
unsafe impl Send for NativeFdmPreviewSnapshot {}

#[cfg(feature = "cuda")]
impl NativeFdmFieldSnapshot {
    pub(super) fn new(
        handle: *mut ffi::fullmag_fdm_field_snapshot,
        name: String,
        step: u64,
        time: f64,
        solver_dt: f64,
    ) -> Self {
        Self {
            handle,
            name,
            step,
            time,
            solver_dt,
            ready: None,
        }
    }

    fn ensure_ready(&mut self) -> Result<&NativeFieldSnapshotReady, RunError> {
        if self.ready.is_none() {
            let mut data = std::ptr::null();
            let mut len_bytes = 0u64;
            let mut desc = ffi::fullmag_fdm_snapshot_desc {
                cell_count: 0,
                component_count: 0,
                scalar_bytes: 0,
                scalar_type: ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F64,
            };
            let rc = unsafe {
                ffi::fullmag_fdm_field_snapshot_wait(
                    self.handle,
                    &mut data,
                    &mut len_bytes,
                    &mut desc,
                )
            };
            if rc != ffi::FULLMAG_FDM_OK {
                return Err(RunError {
                    message: format!("waiting for CUDA field snapshot '{}' failed", self.name),
                });
            }
            let scalar_type = match desc.scalar_type {
                ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F32 => {
                    NativeFieldSnapshotScalarType::F32
                }
                ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F64 => {
                    NativeFieldSnapshotScalarType::F64
                }
            };
            let len = len_bytes as usize;
            // SAFETY: `data` points to a CUDA-managed buffer valid until the
            // handle is destroyed.  We copy immediately into an owned Vec so
            // the raw pointer does not escape this block.
            let owned = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) }.to_vec();
            self.ready = Some(NativeFieldSnapshotReady {
                data: owned,
                info: NativeFieldSnapshotInfo {
                    cell_count: desc.cell_count as usize,
                    component_count: desc.component_count as usize,
                    scalar_bytes: desc.scalar_bytes as usize,
                    scalar_type,
                },
            });
        }
        Ok(self.ready.as_ref().expect("snapshot ready cached"))
    }

    pub(crate) fn info(&mut self) -> Result<NativeFieldSnapshotInfo, RunError> {
        Ok(self.ensure_ready()?.info)
    }

    pub(crate) fn write_payload_to(
        &mut self,
        writer: &mut impl Write,
    ) -> Result<NativeFieldSnapshotInfo, RunError> {
        let snapshot_name = self.name.clone();
        let ready = self.ensure_ready()?;
        writer.write_all(&ready.data).map_err(|error| RunError {
            message: format!(
                "failed to write CUDA field snapshot payload for '{}': {}",
                snapshot_name, error
            ),
        })?;
        Ok(ready.info)
    }

    pub(crate) fn write_payload(
        &mut self,
        writer: &mut impl Write,
    ) -> Result<NativeFieldSnapshotInfo, RunError> {
        self.write_payload_to(writer)
    }
}

#[cfg(feature = "cuda")]
impl NativeFdmPreviewSnapshot {
    pub(super) fn new(
        handle: *mut ffi::fullmag_fdm_preview_snapshot,
        request: LivePreviewRequest,
        plan: GridPreviewPlan,
        quantity: String,
    ) -> Self {
        Self {
            handle,
            request,
            plan,
            quantity,
            ready: None,
        }
    }

    fn ensure_ready(&mut self) -> Result<&NativeFieldSnapshotReady, RunError> {
        if self.ready.is_none() {
            let mut data = std::ptr::null();
            let mut len_bytes = 0u64;
            let mut desc = ffi::fullmag_fdm_snapshot_desc {
                cell_count: 0,
                component_count: 0,
                scalar_bytes: 0,
                scalar_type: ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F64,
            };
            let rc = unsafe {
                ffi::fullmag_fdm_preview_snapshot_wait(
                    self.handle,
                    &mut data,
                    &mut len_bytes,
                    &mut desc,
                )
            };
            if rc != ffi::FULLMAG_FDM_OK {
                return Err(RunError {
                    message: format!(
                        "waiting for CUDA preview snapshot '{}' failed",
                        self.quantity
                    ),
                });
            }
            let scalar_type = match desc.scalar_type {
                ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F32 => {
                    NativeFieldSnapshotScalarType::F32
                }
                ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F64 => {
                    NativeFieldSnapshotScalarType::F64
                }
            };
            self.ready = Some(NativeFieldSnapshotReady {
                // SAFETY: `data` is valid until the handle is destroyed.
                // We copy immediately so the raw pointer does not escape.
                data: unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len_bytes as usize) }
                    .to_vec(),
                info: NativeFieldSnapshotInfo {
                    cell_count: desc.cell_count as usize,
                    component_count: desc.component_count as usize,
                    scalar_bytes: desc.scalar_bytes as usize,
                    scalar_type,
                },
            });
        }
        Ok(self.ready.as_ref().expect("preview snapshot ready cached"))
    }

    pub fn into_live_preview_field(
        mut self,
        active_mask: Option<&[bool]>,
    ) -> Result<LivePreviewField, RunError> {
        let ready = self.ensure_ready()?;
        let expected_len = ready.info.cell_count * ready.info.component_count;
        let vector_field_values: Vec<f64> = match ready.info.scalar_type {
            NativeFieldSnapshotScalarType::F32 => ready
                .data
                .chunks_exact(std::mem::size_of::<f32>())
                .map(|b| f64::from(f32::from_ne_bytes(b.try_into().unwrap())))
                .collect(),
            NativeFieldSnapshotScalarType::F64 => ready
                .data
                .chunks_exact(std::mem::size_of::<f64>())
                .map(|b| f64::from_ne_bytes(b.try_into().unwrap()))
                .collect(),
        };
        debug_assert_eq!(vector_field_values.len(), expected_len);
        Ok(build_grid_preview_field_from_flat_plan(
            &self.request,
            &self.plan,
            vector_field_values,
            &self.quantity,
            active_mask.map(|mask| resample_grid_mask(mask, &self.plan)),
        ))
    }
}

#[cfg(feature = "cuda")]
impl Drop for NativeFdmFieldSnapshot {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { ffi::fullmag_fdm_field_snapshot_destroy(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

#[cfg(feature = "cuda")]
impl Drop for NativeFdmPreviewSnapshot {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { ffi::fullmag_fdm_preview_snapshot_destroy(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}
