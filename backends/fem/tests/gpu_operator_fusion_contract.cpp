/*
 * GPU operator fusion contract test.
 *
 * Verifies:
 * 1. DmiGeometryCache persistent setup and exact field/energy parity with unfused reference.
 * 2. EffectiveFieldApplyMask fused H_eff accumulation vs component-by-component baseline.
 * 3. Batched ACA far-block apply vs standard far apply.
 */

#include "gpu/cuda/interactions/dmi/dmi_geometry_cache.hpp"
#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"
#include "gpu/cuda/integrators/rk/rk_effective_field.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp"

#include <cuda_runtime.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <vector>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_cuda(cudaError_t status, const char *operation)
{
    if (status != cudaSuccess) {
        std::fprintf(stderr, "FAIL: %s: %s\n", operation, cudaGetErrorString(status));
        std::exit(1);
    }
}

double vector_rms(const std::vector<double> &a, const std::vector<double> &b)
{
    check(a.size() == b.size(), "vector sizes must match for RMS");
    if (a.empty()) return 0.0;
    double sum = 0.0;
    for (std::size_t i = 0; i < a.size(); ++i) {
        const double diff = a[i] - b[i];
        sum += diff * diff;
    }
    return std::sqrt(sum / static_cast<double>(a.size()));
}

void test_dmi_geometry_cache()
{
    std::printf("--- test_dmi_geometry_cache ---\n");
    cudaStream_t stream = nullptr;
    check_cuda(cudaStreamCreate(&stream), "cudaStreamCreate");

    // Mesh: 2 linear tetrahedra sharing a face, plus 1 degenerate tetrahedron.
    // 6 nodes:
    // node 0: (0, 0, 0)
    // node 1: (1, 0, 0)
    // node 2: (0, 1, 0)
    // node 3: (0, 0, 1)
    // node 4: (1, 1, 1)
    // node 5: (0, 0, 0) -- duplicate for degenerate tet
    const int node_count = 6;
    const std::vector<double> h_nodes_xyz = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        1.0, 1.0, 1.0,
        0.0, 0.0, 0.0,
    };
    const int element_count = 3;
    const std::vector<std::uint32_t> h_elements = {
        0, 1, 2, 3, // Tet 0: standard unit tet
        1, 2, 3, 4, // Tet 1: second tet
        0, 1, 2, 5, // Tet 2: degenerate (node 0 and node 5 at same position)
    };
    const std::vector<std::uint8_t> h_mag_mask = {1, 1, 1};

    double *d_nodes_xyz = nullptr;
    std::uint32_t *d_elements = nullptr;
    std::uint8_t *d_mag_mask = nullptr;
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_nodes_xyz), h_nodes_xyz.size() * sizeof(double)), "alloc nodes");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_elements), h_elements.size() * sizeof(std::uint32_t)), "alloc elements");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_mag_mask), h_mag_mask.size() * sizeof(std::uint8_t)), "alloc mask");

    check_cuda(cudaMemcpyAsync(d_nodes_xyz, h_nodes_xyz.data(), h_nodes_xyz.size() * sizeof(double), cudaMemcpyHostToDevice, stream), "copy nodes");
    check_cuda(cudaMemcpyAsync(d_elements, h_elements.data(), h_elements.size() * sizeof(std::uint32_t), cudaMemcpyHostToDevice, stream), "copy elements");
    check_cuda(cudaMemcpyAsync(d_mag_mask, h_mag_mask.data(), h_mag_mask.size() * sizeof(std::uint8_t), cudaMemcpyHostToDevice, stream), "copy mask");

    // Magnetization, lumped mass, etc.
    std::vector<double> h_mx(node_count, 0.6);
    std::vector<double> h_my(node_count, 0.8);
    std::vector<double> h_mz(node_count, 0.0);
    std::vector<double> h_ms(node_count, 8.0e5);
    std::vector<double> h_mass(node_count, 1.0 / 24.0);
    std::vector<std::uint8_t> h_node_mask(node_count, 1);

    double *d_mx = nullptr;
    double *d_my = nullptr;
    double *d_mz = nullptr;
    double *d_ms = nullptr;
    double *d_mass = nullptr;
    std::uint8_t *d_node_mask = nullptr;
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_mx), node_count * sizeof(double)), "alloc mx");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_my), node_count * sizeof(double)), "alloc my");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_mz), node_count * sizeof(double)), "alloc mz");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_ms), node_count * sizeof(double)), "alloc ms");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_mass), node_count * sizeof(double)), "alloc mass");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_node_mask), node_count * sizeof(std::uint8_t)), "alloc node_mask");

    check_cuda(cudaMemcpyAsync(d_mx, h_mx.data(), node_count * sizeof(double), cudaMemcpyHostToDevice, stream), "copy mx");
    check_cuda(cudaMemcpyAsync(d_my, h_my.data(), node_count * sizeof(double), cudaMemcpyHostToDevice, stream), "copy my");
    check_cuda(cudaMemcpyAsync(d_mz, h_mz.data(), node_count * sizeof(double), cudaMemcpyHostToDevice, stream), "copy mz");
    check_cuda(cudaMemcpyAsync(d_ms, h_ms.data(), node_count * sizeof(double), cudaMemcpyHostToDevice, stream), "copy ms");
    check_cuda(cudaMemcpyAsync(d_mass, h_mass.data(), node_count * sizeof(double), cudaMemcpyHostToDevice, stream), "copy mass");
    check_cuda(cudaMemcpyAsync(d_node_mask, h_node_mask.data(), node_count * sizeof(std::uint8_t), cudaMemcpyHostToDevice, stream), "copy node_mask");

    const int partial_count = fullmag::fem::dmi_energy_partial_count(node_count);
    double *d_res_x = nullptr;
    double *d_res_y = nullptr;
    double *d_res_z = nullptr;
    double *d_hdmi_x = nullptr;
    double *d_hdmi_y = nullptr;
    double *d_hdmi_z = nullptr;
    double *d_partials = nullptr;
    fullmag::fem::DmiDiagnostics *d_diag = nullptr;
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_res_x), node_count * sizeof(double)), "alloc res_x");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_res_y), node_count * sizeof(double)), "alloc res_y");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_res_z), node_count * sizeof(double)), "alloc res_z");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_hdmi_x), node_count * sizeof(double)), "alloc hdmi_x");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_hdmi_y), node_count * sizeof(double)), "alloc hdmi_y");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_hdmi_z), node_count * sizeof(double)), "alloc hdmi_z");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_partials), partial_count * sizeof(double)), "alloc partials");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_diag), sizeof(fullmag::fem::DmiDiagnostics)), "alloc diag");
    check_cuda(cudaMemsetAsync(d_diag, 0, sizeof(fullmag::fem::DmiDiagnostics), stream), "zero diag");

    fullmag::fem::DmiApplyRequest request;
    request.field = true;
    request.energy = true;
    const double uniform_d = 2.5e-3;

    // 1. Build cache for valid elements (element_count = 2)
    const int valid_element_count = 2;
    fullmag::fem::DmiGeometryCache cache;
    std::string error;
    check(cache.build(d_nodes_xyz, d_elements, d_mag_mask, valid_element_count, node_count, stream, error), error.c_str());
    check(cache.is_built(), "cache must be built");
    check(cache.build_count() == 1u, "build count must be 1");
    check(cache.degenerate_tet_count() == 0u, "expected 0 degenerate tetrahedra for valid mesh");
    check(cache.accumulation_mode() == fullmag::fem::DmiAccumulationMode::AtomicAdd, "default accumulation mode must be AtomicAdd");

    // 1. Run unfused reference on valid elements
    check_cuda(fullmag::fem::fullmag_cuda_dmi_field_energy(
        d_nodes_xyz, d_elements, d_mag_mask,
        d_mx, d_my, d_mz, d_ms, nullptr, d_mass, d_node_mask,
        d_res_x, d_res_y, d_res_z, d_hdmi_x, d_hdmi_y, d_hdmi_z,
        d_partials, d_diag, request,
        8.0e5, uniform_d, 0.0, 0.0, 1.0, false, false,
        valid_element_count, node_count, stream), "unfused dmi");
    check_cuda(cudaStreamSynchronize(stream), "sync unfused");

    std::vector<double> ref_hdmi_x(node_count);
    std::vector<double> ref_hdmi_y(node_count);
    std::vector<double> ref_hdmi_z(node_count);
    std::vector<double> ref_partials(partial_count);
    check_cuda(cudaMemcpy(ref_hdmi_x.data(), d_hdmi_x, node_count * sizeof(double), cudaMemcpyDeviceToHost), "dl ref x");
    check_cuda(cudaMemcpy(ref_hdmi_y.data(), d_hdmi_y, node_count * sizeof(double), cudaMemcpyDeviceToHost), "dl ref y");
    check_cuda(cudaMemcpy(ref_hdmi_z.data(), d_hdmi_z, node_count * sizeof(double), cudaMemcpyDeviceToHost), "dl ref z");
    check_cuda(cudaMemcpy(ref_partials.data(), d_partials, partial_count * sizeof(double), cudaMemcpyDeviceToHost), "dl ref partials");

    // 2. Run cached DMI twice on valid elements
    for (int rep = 0; rep < 2; ++rep) {
        check_cuda(fullmag::fem::fullmag_cuda_dmi_field_energy_cached(
            cache.device_view(), d_elements, d_mag_mask,
            d_mx, d_my, d_mz, d_ms, nullptr, d_mass, d_node_mask,
            d_res_x, d_res_y, d_res_z, d_hdmi_x, d_hdmi_y, d_hdmi_z,
            d_partials, d_diag, request,
            8.0e5, uniform_d, 0.0, 0.0, 1.0, false, false,
            valid_element_count, node_count, stream), "cached dmi");
        cache.record_apply();
    }
    check_cuda(cudaStreamSynchronize(stream), "sync cached");

    check(cache.build_count() == 1u, "build count must remain 1 after apply");
    check(cache.apply_count() == 2u, "apply count must be 2");

    std::vector<double> cached_hdmi_x(node_count);
    std::vector<double> cached_hdmi_y(node_count);
    std::vector<double> cached_hdmi_z(node_count);
    std::vector<double> cached_partials(partial_count);
    check_cuda(cudaMemcpy(cached_hdmi_x.data(), d_hdmi_x, node_count * sizeof(double), cudaMemcpyDeviceToHost), "dl cached x");
    check_cuda(cudaMemcpy(cached_hdmi_y.data(), d_hdmi_y, node_count * sizeof(double), cudaMemcpyDeviceToHost), "dl cached y");
    check_cuda(cudaMemcpy(cached_hdmi_z.data(), d_hdmi_z, node_count * sizeof(double), cudaMemcpyDeviceToHost), "dl cached z");
    check_cuda(cudaMemcpy(cached_partials.data(), d_partials, partial_count * sizeof(double), cudaMemcpyDeviceToHost), "dl cached partials");

    check(vector_rms(ref_hdmi_x, cached_hdmi_x) <= 1e-12, "cached DMI H_x differs from reference");
    check(vector_rms(ref_hdmi_y, cached_hdmi_y) <= 1e-12, "cached DMI H_y differs from reference");
    check(vector_rms(ref_hdmi_z, cached_hdmi_z) <= 1e-12, "cached DMI H_z differs from reference");
    check(vector_rms(ref_partials, cached_partials) <= 1e-12, "cached DMI energy partials differ from reference");

    // Test mesh_version gating: build with same version must be no-op, different version must rebuild
    fullmag::fem::DmiGeometryCache version_cache;
    check(version_cache.build(d_nodes_xyz, d_elements, d_mag_mask, 2, node_count, stream, error, 100ull), "build version 100");
    check(version_cache.build_count() == 1ull, "first build must have count 1");
    check(version_cache.build(d_nodes_xyz, d_elements, d_mag_mask, 2, node_count, stream, error, 100ull), "rebuild same version");
    check(version_cache.build_count() == 1ull, "same version must not increment build_count");
    check(version_cache.build(d_nodes_xyz, d_elements, d_mag_mask, 2, node_count, stream, error, 101ull), "rebuild new version");
    check(version_cache.build_count() == 2ull, "different version must trigger rebuild");

    // Test element coloring accumulation mode parity
    cache.set_accumulation_mode(fullmag::fem::DmiAccumulationMode::Coloring);
    check_cuda(fullmag::fem::fullmag_cuda_dmi_field_energy_cached(
        cache.device_view(), d_elements, d_mag_mask,
        d_mx, d_my, d_mz, d_ms, nullptr, d_mass, d_node_mask,
        d_res_x, d_res_y, d_res_z, d_hdmi_x, d_hdmi_y, d_hdmi_z,
        d_partials, d_diag, request,
        8.0e5, uniform_d, 0.0, 0.0, 1.0, false, false,
        2, node_count, stream,
        cache.accumulation_mode()), "cached colored dmi");
    check_cuda(cudaStreamSynchronize(stream), "sync colored cached");
    std::vector<double> colored_hdmi_x(node_count);
    check_cuda(cudaMemcpy(colored_hdmi_x.data(), d_hdmi_x, node_count * sizeof(double), cudaMemcpyDeviceToHost), "dl colored x");
    check(vector_rms(ref_hdmi_x, colored_hdmi_x) <= 1e-12, "colored DMI H_x differs from reference");

    // 3. Test degenerate element detection (element_count = 3, includes degenerate Tet 2)
    fullmag::fem::DmiGeometryCache degen_cache;
    check(degen_cache.build(d_nodes_xyz, d_elements, d_mag_mask, 3, node_count, stream, error), "degen build");
    check(degen_cache.degenerate_tet_count() == 1u, "expected 1 degenerate tetrahedron");
    check_cuda(fullmag::fem::fullmag_cuda_dmi_field_energy_cached(
        degen_cache.device_view(), d_elements, d_mag_mask,
        d_mx, d_my, d_mz, d_ms, nullptr, d_mass, d_node_mask,
        d_res_x, d_res_y, d_res_z, d_hdmi_x, d_hdmi_y, d_hdmi_z,
        d_partials, d_diag, request,
        8.0e5, uniform_d, 0.0, 0.0, 1.0, false, false,
        3, node_count, stream), "degen cached dmi");
    check_cuda(cudaStreamSynchronize(stream), "sync degen cached");
    check_cuda(cudaMemcpy(cached_hdmi_x.data(), d_hdmi_x, node_count * sizeof(double), cudaMemcpyDeviceToHost), "dl degen x");
    check(std::isnan(cached_hdmi_x[0]), "degenerate tet must fail-closed to NaN");

    cudaFree(d_diag);
    cudaFree(d_partials);
    cudaFree(d_hdmi_z);
    cudaFree(d_hdmi_y);
    cudaFree(d_hdmi_x);
    cudaFree(d_res_z);
    cudaFree(d_res_y);
    cudaFree(d_res_x);
    cudaFree(d_node_mask);
    cudaFree(d_mass);
    cudaFree(d_ms);
    cudaFree(d_mz);
    cudaFree(d_my);
    cudaFree(d_mx);
    cudaFree(d_mag_mask);
    cudaFree(d_elements);
    cudaFree(d_nodes_xyz);
    cudaStreamDestroy(stream);
    std::printf("PASS: DmiGeometryCache precomputation and parity\n");
}

void test_effective_field_fusion()
{
    std::printf("--- test_effective_field_fusion ---\n");
    cudaStream_t stream = nullptr;
    check_cuda(cudaStreamCreate(&stream), "cudaStreamCreate");

    const int n = 512;
    std::vector<double> h_hex(n), h_hdemag(n), h_hext(n), h_hani(n), h_hcub(n), h_hdmi(n), h_hbdmi(n), h_hmel(n), h_htherm(n);
    for (int i = 0; i < n; ++i) {
        h_hex[i] = 100.0 * std::sin(0.1 * i);
        h_hdemag[i] = -50.0 * std::cos(0.05 * i);
        h_hext[i] = 10.0;
        h_hani[i] = 5.0 * std::sin(0.2 * i);
        h_hcub[i] = 2.0 * std::cos(0.3 * i);
        h_hdmi[i] = 3.0 * std::sin(0.15 * i);
        h_hbdmi[i] = 1.5 * std::cos(0.25 * i);
        h_hmel[i] = 0.5 * std::sin(0.08 * i);
        h_htherm[i] = 0.2 * std::cos(0.4 * i);
    }

    auto upload = [stream](const std::vector<double> &v) {
        double *d = nullptr;
        check_cuda(cudaMalloc(reinterpret_cast<void **>(&d), v.size() * sizeof(double)), "cudaMalloc");
        check_cuda(cudaMemcpyAsync(d, v.data(), v.size() * sizeof(double), cudaMemcpyHostToDevice, stream), "upload");
        return d;
    };

    double *d_hex = upload(h_hex);
    double *d_hdemag = upload(h_hdemag);
    double *d_hext = upload(h_hext);
    double *d_hani = upload(h_hani);
    double *d_hcub = upload(h_hcub);
    double *d_hdmi = upload(h_hdmi);
    double *d_hbdmi = upload(h_hbdmi);
    double *d_hmel = upload(h_hmel);
    double *d_htherm = upload(h_htherm);

    double *d_heff_unfused_x = nullptr;
    double *d_heff_unfused_y = nullptr;
    double *d_heff_unfused_z = nullptr;
    double *d_heff_fused_x = nullptr;
    double *d_heff_fused_y = nullptr;
    double *d_heff_fused_z = nullptr;
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_heff_unfused_x), n * sizeof(double)), "alloc heff unfused x");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_heff_unfused_y), n * sizeof(double)), "alloc heff unfused y");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_heff_unfused_z), n * sizeof(double)), "alloc heff unfused z");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_heff_fused_x), n * sizeof(double)), "alloc heff fused x");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_heff_fused_y), n * sizeof(double)), "alloc heff fused y");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_heff_fused_z), n * sizeof(double)), "alloc heff fused z");

    // Mask with all fields enabled
    fullmag::fem::EffectiveFieldApplyMask mask;
    mask.has_external = true;
    mask.uniaxial_anisotropy = true;
    mask.cubic_anisotropy = true;
    mask.interfacial_dmi = true;
    mask.bulk_dmi = true;
    mask.magnetoelastic = true;
    mask.thermal = true;

    // 1. Unfused reference: accumulate_heff + sequence of add_field_inplace for X, Y, Z
    fullmag::fem::fullmag_cuda_accumulate_heff(d_hex, d_hdemag, d_hext, d_heff_unfused_x, n, true, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hani, d_heff_unfused_x, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hcub, d_heff_unfused_x, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hdmi, d_heff_unfused_x, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hbdmi, d_heff_unfused_x, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hmel, d_heff_unfused_x, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_htherm, d_heff_unfused_x, n, stream);

    fullmag::fem::fullmag_cuda_accumulate_heff(d_hex, d_hdemag, d_hext, d_heff_unfused_y, n, true, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hani, d_heff_unfused_y, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hcub, d_heff_unfused_y, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hdmi, d_heff_unfused_y, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hbdmi, d_heff_unfused_y, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hmel, d_heff_unfused_y, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_htherm, d_heff_unfused_y, n, stream);

    fullmag::fem::fullmag_cuda_accumulate_heff(d_hex, d_hdemag, d_hext, d_heff_unfused_z, n, true, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hani, d_heff_unfused_z, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hcub, d_heff_unfused_z, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hdmi, d_heff_unfused_z, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hbdmi, d_heff_unfused_z, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_hmel, d_heff_unfused_z, n, stream);
    fullmag::fem::fullmag_cuda_add_field_inplace(d_htherm, d_heff_unfused_z, n, stream);

    // 2. Fused kernel
    fullmag::fem::EffectiveFieldInputs inputs;
    inputs.n = n;
    inputs.mask = mask;
    inputs.out_h_eff_x = d_heff_fused_x;
    inputs.out_h_eff_y = d_heff_fused_y;
    inputs.out_h_eff_z = d_heff_fused_z;

    inputs.x.h_ex = d_hex;
    inputs.x.h_demag = d_hdemag;
    inputs.x.h_ext = d_hext;
    inputs.x.h_ani = d_hani;
    inputs.x.h_cubic_ani = d_hcub;
    inputs.x.h_dmi = d_hdmi;
    inputs.x.h_bulk_dmi = d_hbdmi;
    inputs.x.h_mel = d_hmel;
    inputs.x.h_therm = d_htherm;

    inputs.y = inputs.x;
    inputs.z = inputs.x;

    std::string reason;
    check(fullmag::fem::gpu_rk_accumulate_effective_field_fused(inputs, stream, reason), reason.c_str());
    check_cuda(cudaStreamSynchronize(stream), "sync fused heff");

    std::vector<double> actual_unfused_x(n), actual_fused_x(n);
    std::vector<double> actual_unfused_y(n), actual_fused_y(n);
    std::vector<double> actual_unfused_z(n), actual_fused_z(n);
    check_cuda(cudaMemcpy(actual_unfused_x.data(), d_heff_unfused_x, n * sizeof(double), cudaMemcpyDeviceToHost), "dl unfused x");
    check_cuda(cudaMemcpy(actual_fused_x.data(), d_heff_fused_x, n * sizeof(double), cudaMemcpyDeviceToHost), "dl fused x");
    check_cuda(cudaMemcpy(actual_unfused_y.data(), d_heff_unfused_y, n * sizeof(double), cudaMemcpyDeviceToHost), "dl unfused y");
    check_cuda(cudaMemcpy(actual_fused_y.data(), d_heff_fused_y, n * sizeof(double), cudaMemcpyDeviceToHost), "dl fused y");
    check_cuda(cudaMemcpy(actual_unfused_z.data(), d_heff_unfused_z, n * sizeof(double), cudaMemcpyDeviceToHost), "dl unfused z");
    check_cuda(cudaMemcpy(actual_fused_z.data(), d_heff_fused_z, n * sizeof(double), cudaMemcpyDeviceToHost), "dl fused z");

    check(vector_rms(actual_unfused_x, actual_fused_x) <= 1e-15, "fused H_eff_x differs from sequential accumulation");
    check(vector_rms(actual_unfused_y, actual_fused_y) <= 1e-15, "fused H_eff_y differs from sequential accumulation");
    check(vector_rms(actual_unfused_z, actual_fused_z) <= 1e-15, "fused H_eff_z differs from sequential accumulation");

    cudaFree(d_heff_fused_z);
    cudaFree(d_heff_fused_y);
    cudaFree(d_heff_fused_x);
    cudaFree(d_heff_unfused_z);
    cudaFree(d_heff_unfused_y);
    cudaFree(d_heff_unfused_x);
    cudaFree(d_htherm);
    cudaFree(d_hmel);
    cudaFree(d_hbdmi);
    cudaFree(d_hdmi);
    cudaFree(d_hcub);
    cudaFree(d_hani);
    cudaFree(d_hext);
    cudaFree(d_hdemag);
    cudaFree(d_hex);
    cudaStreamDestroy(stream);
    std::printf("PASS: EffectiveFieldApplyMask fused accumulation\n");
}

void test_aca_batching()
{
    std::printf("--- test_aca_batching ---\n");
    cudaStream_t stream = nullptr;
    check_cuda(cudaStreamCreate(&stream), "cudaStreamCreate");

    // Synthetic ACA setup: 4 far blocks with ranks 2 and 3
    const int far_block_count = 4;
    const int boundary_rows = 64;
    std::vector<fullmag::fem::AcaHMatrixDemagBemFarBlock> h_blocks(far_block_count);
    uint64_t u_cursor = 0;
    uint64_t v_cursor = 0;
    for (int i = 0; i < far_block_count; ++i) {
        h_blocks[i].source_begin = 0;
        h_blocks[i].source_end = 16;
        h_blocks[i].target_begin = i * 16;
        h_blocks[i].target_end = (i + 1) * 16;
        h_blocks[i].rank = 2;
        h_blocks[i].u_offset = u_cursor;
        h_blocks[i].v_offset = v_cursor;
        u_cursor += static_cast<uint64_t>(h_blocks[i].rank) * 16u;
        v_cursor += static_cast<uint64_t>(h_blocks[i].rank) * 16u;
    }

    std::vector<double> h_far_u(u_cursor, 0.5);
    std::vector<double> h_far_v(v_cursor, 0.25);
    std::vector<std::uint32_t> h_perm(boundary_rows);
    std::vector<std::uint32_t> h_tdofs(boundary_rows);
    std::vector<double> h_u1(boundary_rows, 1.0);
    for (int i = 0; i < boundary_rows; ++i) {
        h_perm[i] = i;
        h_tdofs[i] = i;
    }

    fullmag::fem::AcaHMatrixDemagBemFarBlock *d_blocks = nullptr;
    double *d_far_u = nullptr;
    double *d_far_v = nullptr;
    std::uint32_t *d_perm = nullptr;
    std::uint32_t *d_tdofs = nullptr;
    double *d_u1 = nullptr;
    double *d_u2_unbatched = nullptr;
    double *d_u2_batched = nullptr;

    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_blocks), far_block_count * sizeof(fullmag::fem::AcaHMatrixDemagBemFarBlock)), "alloc blocks");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_far_u), h_far_u.size() * sizeof(double)), "alloc far_u");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_far_v), h_far_v.size() * sizeof(double)), "alloc far_v");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_perm), h_perm.size() * sizeof(std::uint32_t)), "alloc perm");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_tdofs), h_tdofs.size() * sizeof(std::uint32_t)), "alloc tdofs");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_u1), h_u1.size() * sizeof(double)), "alloc u1");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_u2_unbatched), boundary_rows * sizeof(double)), "alloc u2 unbatched");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_u2_batched), boundary_rows * sizeof(double)), "alloc u2 batched");

    check_cuda(cudaMemcpyAsync(d_blocks, h_blocks.data(), far_block_count * sizeof(fullmag::fem::AcaHMatrixDemagBemFarBlock), cudaMemcpyHostToDevice, stream), "copy blocks");
    check_cuda(cudaMemcpyAsync(d_far_u, h_far_u.data(), h_far_u.size() * sizeof(double), cudaMemcpyHostToDevice, stream), "copy far_u");
    check_cuda(cudaMemcpyAsync(d_far_v, h_far_v.data(), h_far_v.size() * sizeof(double), cudaMemcpyHostToDevice, stream), "copy far_v");
    check_cuda(cudaMemcpyAsync(d_perm, h_perm.data(), h_perm.size() * sizeof(std::uint32_t), cudaMemcpyHostToDevice, stream), "copy perm");
    check_cuda(cudaMemcpyAsync(d_tdofs, h_tdofs.data(), h_tdofs.size() * sizeof(std::uint32_t), cudaMemcpyHostToDevice, stream), "copy tdofs");
    check_cuda(cudaMemcpyAsync(d_u1, h_u1.data(), h_u1.size() * sizeof(double), cudaMemcpyHostToDevice, stream), "copy u1");
    check_cuda(cudaMemsetAsync(d_u2_unbatched, 0, boundary_rows * sizeof(double), stream), "zero u2 unbatched");
    check_cuda(cudaMemsetAsync(d_u2_batched, 0, boundary_rows * sizeof(double), stream), "zero u2 batched");

    // Near CSR setup (diagonal 0.1)
    std::vector<std::uint32_t> h_near_row_offsets(boundary_rows + 1);
    std::vector<std::uint32_t> h_near_cols(boundary_rows);
    std::vector<double> h_near_vals(boundary_rows, 0.1);
    for (int i = 0; i < boundary_rows; ++i) {
        h_near_row_offsets[i] = static_cast<std::uint32_t>(i);
        h_near_cols[i] = static_cast<std::uint32_t>(i);
    }
    h_near_row_offsets[boundary_rows] = static_cast<std::uint32_t>(boundary_rows);

    std::uint32_t *d_near_row_offsets = nullptr;
    std::uint32_t *d_near_cols = nullptr;
    double *d_near_vals = nullptr;
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_near_row_offsets), (boundary_rows + 1) * sizeof(std::uint32_t)), "alloc near_rows");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_near_cols), boundary_rows * sizeof(std::uint32_t)), "alloc near_cols");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_near_vals), boundary_rows * sizeof(double)), "alloc near_vals");
    check_cuda(cudaMemcpyAsync(d_near_row_offsets, h_near_row_offsets.data(), (boundary_rows + 1) * sizeof(std::uint32_t), cudaMemcpyHostToDevice, stream), "copy near_rows");
    check_cuda(cudaMemcpyAsync(d_near_cols, h_near_cols.data(), boundary_rows * sizeof(std::uint32_t), cudaMemcpyHostToDevice, stream), "copy near_cols");
    check_cuda(cudaMemcpyAsync(d_near_vals, h_near_vals.data(), boundary_rows * sizeof(double), cudaMemcpyHostToDevice, stream), "copy near_vals");

    // 1. Unbatched run
    fullmag::fem::fullmag_cuda_fem_bem_apply(
        d_near_row_offsets, d_near_cols, d_near_vals,
        d_blocks, d_far_u, d_far_v, d_perm, d_tdofs, d_u1, d_u2_unbatched,
        boundary_rows, far_block_count, 2, stream, nullptr, 0);

    // 2. Batched run: 2 batches (blocks 0..2 in batch 0, blocks 2..4 in batch 1)
    const std::vector<std::uint32_t> h_batch_offsets = {0, 2, 4};
    const int batch_count = 2;
    std::uint32_t *d_batch_offsets = nullptr;
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_batch_offsets), h_batch_offsets.size() * sizeof(std::uint32_t)), "alloc batch offsets");
    check_cuda(cudaMemcpyAsync(d_batch_offsets, h_batch_offsets.data(), h_batch_offsets.size() * sizeof(std::uint32_t), cudaMemcpyHostToDevice, stream), "copy batch offsets");

    fullmag::fem::fullmag_cuda_fem_bem_apply(
        d_near_row_offsets, d_near_cols, d_near_vals,
        d_blocks, d_far_u, d_far_v, d_perm, d_tdofs, d_u1, d_u2_batched,
        boundary_rows, far_block_count, 2, stream, d_batch_offsets, batch_count);

    check_cuda(cudaStreamSynchronize(stream), "sync aca");

    std::vector<double> res_unbatched(boundary_rows);
    std::vector<double> res_batched(boundary_rows);
    check_cuda(cudaMemcpy(res_unbatched.data(), d_u2_unbatched, boundary_rows * sizeof(double), cudaMemcpyDeviceToHost), "dl unbatched");
    check_cuda(cudaMemcpy(res_batched.data(), d_u2_batched, boundary_rows * sizeof(double), cudaMemcpyDeviceToHost), "dl batched");

    check(vector_rms(res_unbatched, res_batched) <= 1e-12, "batched ACA apply differs from unbatched baseline");

    cudaFree(d_near_vals);
    cudaFree(d_near_cols);
    cudaFree(d_near_row_offsets);
    cudaFree(d_batch_offsets);
    cudaFree(d_u2_batched);
    cudaFree(d_u2_unbatched);
    cudaFree(d_u1);
    cudaFree(d_tdofs);
    cudaFree(d_perm);
    cudaFree(d_far_v);
    cudaFree(d_far_u);
    cudaFree(d_blocks);
    cudaStreamDestroy(stream);
    std::printf("PASS: ACA far apply batching parity\n");
}

void test_dmi_geometry_cache_invalidation_and_coloring_qualification()
{
    std::printf("--- test_dmi_geometry_cache_invalidation_and_coloring_qualification ---\n");
    // Verify source assertions on geometry fingerprint and coloring qualification
    std::ifstream upload_file("/workspace/backends/fem/gpu/cuda/mesh/mesh_geometry_upload.cpp");
    if (!upload_file.is_open()) {
        upload_file.open("backends/fem/gpu/cuda/mesh/mesh_geometry_upload.cpp");
    }
    if (!upload_file.is_open()) {
        upload_file.open("../backends/fem/gpu/cuda/mesh/mesh_geometry_upload.cpp");
    }
    check(upload_file.is_open(), "unable to open mesh_geometry_upload.cpp");
    std::string upload_src((std::istreambuf_iterator<char>(upload_file)), std::istreambuf_iterator<char>());
    check(upload_src.find("compute_geometry_fingerprint") != std::string::npos,
          "mesh_geometry_upload must use compute_geometry_fingerprint for mesh_version");
    check(upload_src.find("static_cast<uint64_t>(element_count) ^ (static_cast<uint64_t>(lifecycle.node_count) << 32)") == std::string::npos,
          "mesh_geometry_upload must not use naive node/element count XOR for mesh_version");

    std::ifstream cache_file("/workspace/backends/fem/gpu/cuda/interactions/dmi/dmi_geometry_cache.cu");
    if (!cache_file.is_open()) {
        cache_file.open("backends/fem/gpu/cuda/interactions/dmi/dmi_geometry_cache.cu");
    }
    if (!cache_file.is_open()) {
        cache_file.open("../backends/fem/gpu/cuda/interactions/dmi/dmi_geometry_cache.cu");
    }
    check(cache_file.is_open(), "unable to open dmi_geometry_cache.cu");
    std::string cache_src((std::istreambuf_iterator<char>(cache_file)), std::istreambuf_iterator<char>());
    check(cache_src.find("num_colors <= 32") != std::string::npos,
          "dmi_geometry_cache must qualify coloring with num_colors threshold");
    check(cache_src.find("cudaMemcpyAsync") != std::string::npos &&
          cache_src.find("cpy_off == cudaSuccess && cpy_elem == cudaSuccess") != std::string::npos,
          "dmi_geometry_cache must check cudaMemcpyAsync error codes");
    std::printf("PASS: DMI geometry cache invalidation and coloring qualification verified\n");
}

} // namespace

int main()
{
    test_dmi_geometry_cache();
    test_effective_field_fusion();
    test_aca_batching();
    test_dmi_geometry_cache_invalidation_and_coloring_qualification();
    std::printf("ALL GPU OPERATOR FUSION CONTRACT TESTS PASSED\n");
    return 0;
}
