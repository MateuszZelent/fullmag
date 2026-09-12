pub(super) const FLOQUET_DYNAMIC_DEMAG_UNSUPPORTED: &str = "dynamic demag for Floquet periodic FEM requires the validated native CPU Poisson-airbox provider (full_2x2, nonzero-k, shared-domain airbox); unsupported combinations must disable demag or use a qualified reference lane.";
pub(super) const NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND: &str =
    "slepc_multi_shift_invert_production_cpu_dense";
pub(super) const NATIVE_GPU_MODAL_SHARED_DOMAIN_SOLVER_KIND: &str = "gpu_modal_device_krylov";
pub(super) const NATIVE_GPU_K0_KITTEL_SOLVER_KIND: &str = "gpu_dense_k0_macrospin_modal_eigen";
pub(super) const TANGENT_FRAME_IDENTITY_TOLERANCE: f64 = 1.0e-8;
pub(super) const MODAL_LINEARIZATION_TERM_EXCHANGE: u32 = 1 << 0;
pub(super) const MODAL_LINEARIZATION_TERM_FIELD: u32 = 1 << 1;
pub(super) const MODAL_LINEARIZATION_TERM_DEMAG: u32 = 1 << 4;
pub(crate) const SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON: &str =
    "k0_poisson_airbox_real_fem_assembly_unavailable";
pub(super) const SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_DETAIL: &str =
    "shared-domain A_qq must be assembled by the native MFEM magnetic operator and bound to a non-null certificate_binding_v6 producer; runner-owned assembly is forbidden";
