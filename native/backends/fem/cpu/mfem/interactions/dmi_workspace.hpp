#pragma once

#include <vector>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

struct Context;

#if FULLMAG_HAS_MFEM_STACK
/*
 * Element-loop scratch for native FEM DMI interactions.
 *
 * Interfacial and bulk DMI share the same per-element MFEM work buffers:
 * signed scalar component values, shape gradients, basis values, residual
 * accumulation, and an optional periodic-projected magnetization input. This
 * module owns scratch lifetime on `Context::mfem_dmi_workspace`.
 *
 * It does not assemble DMI residual terms, choose interfacial versus bulk
 * energy density, project residuals to H_DMI, or define DMI units.
 */
struct DmiElementWorkspace {
    void reset_vector(std::vector<double> &vector, size_t size);
    void prepare_residual(size_t field_len);
    void prepare_local(int local_ndof);

    mfem::Array<int> dofs;
    mfem::Vector mx_elem;
    mfem::Vector my_elem;
    mfem::Vector mz_elem;
    mfem::DenseMatrix dshape;
    mfem::Vector shape;
    std::vector<double> residual_xyz;
    std::vector<double> projected_m_xyz;
};

DmiElementWorkspace *dmi_element_workspace(Context &ctx);
#endif

void destroy_dmi_workspace(Context &ctx);

} // namespace fullmag::fem
