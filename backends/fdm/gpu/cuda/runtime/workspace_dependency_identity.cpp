#include "context.hpp"

#include <cstdint>
#include <cstring>
#include <new>
#include <vector>

extern "C" void fullmag_fdm_gpu_transport_checkpoint_sha256_internal_v1(
    const void *payload, uint64_t payload_size, uint8_t digest[32]);

namespace fullmag::fdm {
namespace {

void append_u32(std::vector<uint8_t> &bytes, uint32_t value) {
    for (unsigned shift = 0; shift < 32; shift += 8) {
        bytes.push_back(static_cast<uint8_t>(value >> shift));
    }
}

void append_u64(std::vector<uint8_t> &bytes, uint64_t value) {
    for (unsigned shift = 0; shift < 64; shift += 8) {
        bytes.push_back(static_cast<uint8_t>(value >> shift));
    }
}

void append_double(std::vector<uint8_t> &bytes, double value) {
    uint64_t bits = 0;
    static_assert(sizeof(bits) == sizeof(value));
    std::memcpy(&bits, &value, sizeof(bits));
    append_u64(bytes, bits);
}

void append_raw(
    std::vector<uint8_t> &bytes, const uint8_t *values, uint64_t count)
{
    append_u64(bytes, count);
    if (count != 0) {
        bytes.insert(bytes.end(), values, values + count);
    }
}

void append_u32_array(
    std::vector<uint8_t> &bytes, const uint32_t *values, uint64_t count)
{
    append_u64(bytes, count);
    for (uint64_t index = 0; index < count; ++index) {
        append_u32(bytes, values[index]);
    }
}

void append_double_array(
    std::vector<uint8_t> &bytes, const double *values, uint64_t count)
{
    append_u64(bytes, count);
    for (uint64_t index = 0; index < count; ++index) {
        append_double(bytes, values[index]);
    }
}

void append_optional_double_field(
    std::vector<uint8_t> &bytes, const double *values, uint64_t count)
{
    append_u32(bytes, values != nullptr ? 1U : 0U);
    append_double_array(bytes, values, values != nullptr ? count : 0);
}

void digest(const std::vector<uint8_t> &bytes, uint8_t out[32]) {
    fullmag_fdm_gpu_transport_checkpoint_sha256_internal_v1(
        bytes.empty() ? nullptr : bytes.data(),
        static_cast<uint64_t>(bytes.size()), out);
}

void append_domain(std::vector<uint8_t> &bytes, const char *domain) {
    const auto length = static_cast<uint64_t>(std::strlen(domain));
    append_u64(bytes, length);
    bytes.insert(bytes.end(), domain, domain + length);
}

}  // namespace

bool context_build_workspace_dependency_identity_v1(
    Context &ctx, const fullmag_fdm_plan_desc &plan)
{
    try {
        std::vector<uint8_t> topology;
        append_domain(topology, "fullmag.fdm.workspace.mask-topology.v1");
        append_raw(topology, plan.active_mask, plan.active_mask_len);
        append_raw(topology, plan.frozen_mask, plan.frozen_mask_len);
        append_raw(
            topology, plan.slonczewski_active_mask,
            plan.slonczewski_active_mask_len);
        append_raw(topology, plan.sot_active_mask, plan.sot_active_mask_len);

        std::vector<uint8_t> material;
        append_domain(material, "fullmag.fdm.workspace.material-layout.v1");
        append_double(material, ctx.Ms);
        append_double(material, ctx.A);
        append_double(material, ctx.alpha);
        append_double(material, ctx.gamma);
        append_u32_array(
            material, plan.region_mask, plan.region_mask_len);
        append_double_array(
            material, ctx.exchange_lut_host.data(),
            static_cast<uint64_t>(ctx.exchange_lut_host.size()));
        append_u32(material, ctx.has_uniaxial_anisotropy ? 1U : 0U);
        append_double(material, ctx.Ku1);
        append_double(material, ctx.Ku2);
        for (double value : ctx.anisU) append_double(material, value);
        append_optional_double_field(material, plan.ku1_field, ctx.cell_count);
        append_optional_double_field(material, plan.ku2_field, ctx.cell_count);
        append_u32(material, ctx.has_cubic_anisotropy ? 1U : 0U);
        append_double(material, ctx.Kc1);
        append_double(material, ctx.Kc2);
        append_double(material, ctx.Kc3);
        for (double value : ctx.cubic_axis1) append_double(material, value);
        for (double value : ctx.cubic_axis2) append_double(material, value);
        append_optional_double_field(material, plan.kc1_field, ctx.cell_count);
        append_optional_double_field(material, plan.kc2_field, ctx.cell_count);
        append_optional_double_field(material, plan.kc3_field, ctx.cell_count);

        std::vector<uint8_t> spectra;
        append_domain(spectra, "fullmag.fdm.workspace.spectra.v1");
        append_u32(spectra, ctx.fft_nx);
        append_u32(spectra, ctx.fft_ny);
        append_u32(spectra, ctx.fft_nz);
        append_double_array(
            spectra, plan.demag_kernel_xx_spectrum,
            plan.demag_kernel_spectrum_len);
        append_double_array(
            spectra, plan.demag_kernel_yy_spectrum,
            plan.demag_kernel_spectrum_len);
        append_double_array(
            spectra, plan.demag_kernel_zz_spectrum,
            plan.demag_kernel_spectrum_len);
        append_double_array(
            spectra, plan.demag_kernel_xy_spectrum,
            plan.demag_kernel_spectrum_len);
        append_double_array(
            spectra, plan.demag_kernel_xz_spectrum,
            plan.demag_kernel_spectrum_len);
        append_double_array(
            spectra, plan.demag_kernel_yz_spectrum,
            plan.demag_kernel_spectrum_len);

        fullmag_fdm_workspace_dependency_identity_v1 identity{};
        identity.abi_version =
            FULLMAG_FDM_WORKSPACE_DEPENDENCY_IDENTITY_ABI_V1;
        identity.struct_size = sizeof(identity);
        identity.grid_nx = ctx.nx;
        identity.grid_ny = ctx.ny;
        identity.grid_nz = ctx.nz;
        identity.fft_nx = ctx.fft_nx;
        identity.fft_ny = ctx.fft_ny;
        identity.fft_nz = ctx.fft_nz;
        identity.precision = static_cast<uint32_t>(ctx.precision);
        identity.integrator = static_cast<uint32_t>(ctx.integrator);
        identity.periodic_axis_mask =
            (ctx.periodic_x ? UINT32_C(1) : UINT32_C(0)) |
            (ctx.periodic_y ? UINT32_C(2) : UINT32_C(0)) |
            (ctx.periodic_z ? UINT32_C(4) : UINT32_C(0));
        identity.grid_dx = ctx.dx;
        identity.grid_dy = ctx.dy;
        identity.grid_dz = ctx.dz;
        digest(topology, identity.mask_topology_sha256);
        digest(material, identity.material_layout_sha256);
        digest(spectra, identity.spectra_sha256);

        std::vector<uint8_t> dependency;
        append_domain(dependency, "fullmag.fdm.workspace.dependency.v1");
        append_u32(dependency, identity.grid_nx);
        append_u32(dependency, identity.grid_ny);
        append_u32(dependency, identity.grid_nz);
        append_double(dependency, identity.grid_dx);
        append_double(dependency, identity.grid_dy);
        append_double(dependency, identity.grid_dz);
        append_u32(dependency, identity.fft_nx);
        append_u32(dependency, identity.fft_ny);
        append_u32(dependency, identity.fft_nz);
        append_u32(dependency, identity.precision);
        append_u32(dependency, identity.integrator);
        append_u32(dependency, identity.periodic_axis_mask);
        dependency.insert(
            dependency.end(), identity.mask_topology_sha256,
            identity.mask_topology_sha256 + 32);
        dependency.insert(
            dependency.end(), identity.material_layout_sha256,
            identity.material_layout_sha256 + 32);
        dependency.insert(
            dependency.end(), identity.spectra_sha256,
            identity.spectra_sha256 + 32);
        digest(dependency, identity.dependency_sha256);

        ctx.workspace_dependency_identity_v1 = identity;
        ctx.workspace_dependency_identity_v1_valid = true;
        return true;
    } catch (const std::bad_alloc &) {
        ctx.last_error =
            "workspace dependency identity construction exhausted host memory";
        ctx.workspace_dependency_identity_v1_valid = false;
        return false;
    }
}

}  // namespace fullmag::fdm
