#pragma once

#include "transfer_audit.hpp"

#include <algorithm>
#include <cstdint>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
inline uint64_t mfem_vector_bytes(const mfem::Vector &vector)
{
    return static_cast<uint64_t>(std::max(vector.Size(), 0)) * sizeof(double);
}

inline const double *audited_host_read(const mfem::Vector &vector)
{
    record_mfem_host_read(mfem_vector_bytes(vector));
    return vector.HostRead();
}

inline double *audited_host_write(mfem::Vector &vector)
{
    record_mfem_host_write(mfem_vector_bytes(vector));
    return vector.HostWrite();
}

inline double *audited_host_read_write(mfem::Vector &vector)
{
    record_mfem_host_read_write(mfem_vector_bytes(vector));
    return vector.HostReadWrite();
}
#endif

} // namespace fullmag::fem
