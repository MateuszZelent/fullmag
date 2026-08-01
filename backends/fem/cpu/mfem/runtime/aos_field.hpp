#pragma once

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Split an AoS-3 vector field into component arrays.
 *
 * The input layout is `[x0,y0,z0,x1,y1,z1,...]`. Component buffers are resized
 * to the node count inferred from the input.
 */
void unpack_aos_to_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z);

/*
 * Update existing component buffers from an AoS-3 vector field.
 *
 * When buffer sizes do not match the inferred node count, the function falls
 * back to the resizing unpack path. This preserves reusable MFEM host buffers
 * while keeping shape changes correct.
 */
void unpack_aos_to_existing_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z);

/*
 * Pack component arrays into an AoS-3 vector field.
 */
void pack_components_to_aos(
    const std::vector<double> &x,
    const std::vector<double> &y,
    const std::vector<double> &z,
    std::vector<double> &aos);

/*
 * Normalize active magnetic nodes in an AoS-3 reduced-magnetization field.
 *
 * Active nodes must be finite and have a normal (non-zero, non-subnormal)
 * vector norm. Empty masks are treated as fully magnetic. Nonmagnetic nodes
 * are checked for finite values but otherwise left unchanged.
 */
bool normalize_active_magnetization_aos(
    const Context &ctx,
    std::vector<double> &m_xyz,
    std::string &error);

/*
 * Project an AoS-3 field onto static periodic node classes.
 *
 * Each node receives the vector value of its class representative. Empty
 * periodic maps leave the field unchanged. The helper is used for local fields
 * and magnetization staging, not for solving the Poisson system itself.
 */
void project_static_periodic_aos(
    const Context &ctx,
    std::vector<double> &field_xyz);

} // namespace fullmag::fem
