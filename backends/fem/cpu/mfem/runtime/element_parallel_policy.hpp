#pragma once

namespace fullmag::fem {

// MFEM's normal H1 finite elements share mutable evaluation scratch when
// MFEM_THREAD_SAFE is off. Private output matrices do not isolate that state.
// Keep those provider calls serial; independent nodal reductions may remain
// parallel. Enabling this gate requires the provider and this client to agree.
// Defined in the native library so clients compiled without OpenMP do not
// accidentally report their own compiler flags as the backend's capability.
bool mfem_shared_element_evaluation_parallel_safe() noexcept;

} // namespace fullmag::fem
