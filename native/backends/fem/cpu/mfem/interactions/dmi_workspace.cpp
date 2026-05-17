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

DmiElementWorkspace *dmi_element_workspace(Context &ctx) {
    auto *workspace = static_cast<DmiElementWorkspace *>(ctx.mfem_dmi_workspace);
    if (workspace == nullptr) {
        workspace = new DmiElementWorkspace();
        ctx.mfem_dmi_workspace = workspace;
    }
    return workspace;
}
#endif

void destroy_dmi_workspace(Context &ctx)
{
#if FULLMAG_HAS_MFEM_STACK
    delete static_cast<DmiElementWorkspace *>(ctx.mfem_dmi_workspace);
    ctx.mfem_dmi_workspace = nullptr;
#else
    (void) ctx;
#endif
}

} // namespace fullmag::fem
