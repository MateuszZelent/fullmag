/*
 * DMI workspace source contract.
 *
 * This source owns lazy allocation, reset, local-buffer sizing, and teardown for
 * shared DMI element-loop scratch stored on DmiRuntimeState.
 * It does not choose DMI energy density, assemble residuals, project H_DMI, or
 * report energy.
 */
#include "cpu/mfem/interactions/dmi_workspace.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
void DmiElementWorkspace::reset_vector(std::vector<double> &vector, size_t size) {
    if (vector.size() != size) {
        vector.assign(size, 0.0);
    } else {
        std::fill(vector.begin(), vector.end(), 0.0);
    }
}

void DmiElementWorkspace::prepare_residual(size_t field_len) {
    reset_vector(residual_xyz, field_len);
}

void DmiElementWorkspace::prepare_local(int local_ndof) {
    mx_elem.SetSize(local_ndof);
    my_elem.SetSize(local_ndof);
    mz_elem.SetSize(local_ndof);
    dshape.SetSize(local_ndof, 3);
    shape.SetSize(local_ndof);
}

void DmiElementWorkspace::prepare_thread_residuals(int thread_count, size_t field_len) {
    const size_t count = static_cast<size_t>(std::max(1, thread_count));
    dofs_by_thread.resize(count);
    mx_elem_by_thread.resize(count);
    my_elem_by_thread.resize(count);
    mz_elem_by_thread.resize(count);
    dshape_by_thread.resize(count);
    shape_by_thread.resize(count);
    residual_xyz_by_thread.resize(count);
    for (auto &residual : residual_xyz_by_thread) {
        reset_vector(residual, field_len);
    }
}

void DmiElementWorkspace::prepare_thread_local(int thread_index, int local_ndof) {
    const size_t index = static_cast<size_t>(std::max(0, thread_index));
    mx_elem_by_thread[index].SetSize(local_ndof);
    my_elem_by_thread[index].SetSize(local_ndof);
    mz_elem_by_thread[index].SetSize(local_ndof);
    dshape_by_thread[index].SetSize(local_ndof, 3);
    shape_by_thread[index].SetSize(local_ndof);
}

void DmiElementWorkspace::reduce_thread_residuals(size_t field_len) {
    prepare_residual(field_len);
    for (const auto &thread_residual : residual_xyz_by_thread) {
        for (size_t i = 0; i < field_len; ++i) {
            residual_xyz[i] += thread_residual[i];
        }
    }
}

DmiElementWorkspace *dmi_element_workspace(Context &ctx) {
    auto *workspace = ctx.dmi.workspace;
    if (workspace == nullptr) {
        workspace = new DmiElementWorkspace();
        ctx.dmi.workspace = workspace;
    }
    return workspace;
}
#endif

void destroy_dmi_workspace(Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    delete ctx.dmi.workspace;
    ctx.dmi.workspace = nullptr;
#else
    (void) ctx;
#endif
}

} // namespace fullmag::fem
