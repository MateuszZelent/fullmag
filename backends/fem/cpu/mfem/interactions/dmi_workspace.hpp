#pragma once

#include <string>
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
 * module owns scratch lifetime for `DmiRuntimeState::workspace`.
 *
 * It does not own interfacial or bulk DMI physics, field projection, energy accumulation, or effective-field composition.
 */
struct DmiElementWorkspace {
    void reset_vector(std::vector<double> &vector, size_t size);
    void prepare_residual(size_t field_len);
    void prepare_local(int local_ndof);
    void prepare_thread_residuals(int thread_count, size_t field_len);
    void prepare_thread_local(int thread_index, int local_ndof);
    void reduce_thread_residuals(size_t field_len);

    mfem::Array<int> dofs;
    mfem::Vector mx_elem;
    mfem::Vector my_elem;
    mfem::Vector mz_elem;
    mfem::DenseMatrix dshape;
    mfem::Vector shape;
    std::vector<double> residual_xyz;
    std::vector<double> projected_m_xyz;

    std::vector<mfem::Array<int>> dofs_by_thread;
    std::vector<mfem::Vector> mx_elem_by_thread;
    std::vector<mfem::Vector> my_elem_by_thread;
    std::vector<mfem::Vector> mz_elem_by_thread;
    std::vector<mfem::DenseMatrix> dshape_by_thread;
    std::vector<mfem::Vector> shape_by_thread;
    std::vector<std::vector<double>> residual_xyz_by_thread;
};

DmiElementWorkspace *dmi_element_workspace(Context &ctx);

/*
 * Validate and project an AoS magnetization input once for both DMI owners.
 * Empty periodic metadata leaves the caller's input untouched; a non-empty
 * map writes the canonical representative values into `projected_m_xyz`.
 */
bool prepare_dmi_periodic_input(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &projected_m_xyz,
    std::string &error);

bool refresh_dmi_grid_functions_from_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::string &error);
#endif

void destroy_dmi_workspace(Context &ctx);

} // namespace fullmag::fem
