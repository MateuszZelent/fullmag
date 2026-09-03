/*
 * GPU sparse apply contract.
 *
 * This is a managed CUDA contract: every advertised sparse implementation is
 * executed against one device-resident CSR and compared with an FP64 host
 * oracle.  The test also protects the setup/apply boundary and source
 * ownership of the sparse plan.
 */

#include "gpu/cuda/sparse/sparse_apply_plan.hpp"

#include <cuda_runtime.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
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

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream input(path);
    check(static_cast<bool>(input), "unable to read sparse source contract input");
    std::ostringstream text;
    text << input.rdbuf();
    return text.str();
}

std::filesystem::path fem_source_root()
{
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

double vector_rms(const std::vector<double> &actual, const std::vector<double> &expected)
{
    check(actual.size() == expected.size(), "vector RMS dimensions differ");
    long double sum = 0.0L;
    for (size_t i = 0; i < actual.size(); ++i) {
        const long double delta = static_cast<long double>(actual[i]) - expected[i];
        sum += delta * delta;
    }
    return std::sqrt(static_cast<double>(sum / actual.size()));
}

} // namespace

int main()
{
    using fullmag::fem::SparseApplyCsrDeviceView;
    using fullmag::fem::SparseApplyPlan;
    using fullmag::fem::SparseApplyVariant;
    using fullmag::fem::SparseApplyXyzDeviceView;

    const std::vector<uint32_t> row_lengths{1u, 2u, 4u, 8u, 16u, 32u};
    const uint32_t columns = 64u;
    std::vector<uint32_t> row_offsets{0u};
    std::vector<uint32_t> col_indices;
    std::vector<double> values;
    for (size_t row = 0; row < row_lengths.size(); ++row) {
        for (uint32_t entry = 0; entry < row_lengths[row]; ++entry) {
            col_indices.push_back((13u * static_cast<uint32_t>(row) + entry) % columns);
            values.push_back(
                0.125 * static_cast<double>(static_cast<int>(entry % 9u) - 4) +
                0.01 * static_cast<double>(row + 1u));
        }
        row_offsets.push_back(static_cast<uint32_t>(col_indices.size()));
    }
    std::vector<double> x(columns);
    std::vector<double> y(columns);
    std::vector<double> z(columns);
    for (uint32_t column = 0; column < columns; ++column) {
        x[column] = 0.25 * static_cast<double>(static_cast<int>(column % 11u) - 5);
        y[column] = -0.125 * static_cast<double>(static_cast<int>(column % 7u) - 3);
        z[column] = 0.0625 * static_cast<double>(static_cast<int>(column % 13u) - 6);
    }

    std::vector<double> oracle_x(row_offsets.size() - 1u, 0.0);
    std::vector<double> oracle_y(oracle_x.size(), 0.0);
    std::vector<double> oracle_z(oracle_x.size(), 0.0);
    for (size_t row = 0; row < oracle_x.size(); ++row) {
        for (uint32_t p = row_offsets[row]; p < row_offsets[row + 1u]; ++p) {
            const uint32_t col = col_indices[p];
            oracle_x[row] += values[p] * x[col];
            oracle_y[row] += values[p] * y[col];
            oracle_z[row] += values[p] * z[col];
        }
    }

    uint32_t *d_row_offsets = nullptr;
    uint32_t *d_col_indices = nullptr;
    double *d_values = nullptr;
    double *d_x = nullptr;
    double *d_y = nullptr;
    double *d_z = nullptr;
    double *d_out_x = nullptr;
    double *d_out_y = nullptr;
    double *d_out_z = nullptr;
    cudaStream_t stream = nullptr;
    check_cuda(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking), "cudaStreamCreateWithFlags");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_row_offsets), row_offsets.size() * sizeof(uint32_t)), "cudaMalloc row offsets");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_col_indices), col_indices.size() * sizeof(uint32_t)), "cudaMalloc column indices");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_values), values.size() * sizeof(double)), "cudaMalloc values");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_x), x.size() * sizeof(double)), "cudaMalloc x");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_y), y.size() * sizeof(double)), "cudaMalloc y");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_z), z.size() * sizeof(double)), "cudaMalloc z");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_out_x), oracle_x.size() * sizeof(double)), "cudaMalloc output x");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_out_y), oracle_y.size() * sizeof(double)), "cudaMalloc output y");
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&d_out_z), oracle_z.size() * sizeof(double)), "cudaMalloc output z");
    check_cuda(cudaMemcpyAsync(d_row_offsets, row_offsets.data(), row_offsets.size() * sizeof(uint32_t), cudaMemcpyHostToDevice, stream), "upload row offsets");
    check_cuda(cudaMemcpyAsync(d_col_indices, col_indices.data(), col_indices.size() * sizeof(uint32_t), cudaMemcpyHostToDevice, stream), "upload column indices");
    check_cuda(cudaMemcpyAsync(d_values, values.data(), values.size() * sizeof(double), cudaMemcpyHostToDevice, stream), "upload values");
    check_cuda(cudaMemcpyAsync(d_x, x.data(), x.size() * sizeof(double), cudaMemcpyHostToDevice, stream), "upload x");
    check_cuda(cudaMemcpyAsync(d_y, y.data(), y.size() * sizeof(double), cudaMemcpyHostToDevice, stream), "upload y");
    check_cuda(cudaMemcpyAsync(d_z, z.data(), z.size() * sizeof(double), cudaMemcpyHostToDevice, stream), "upload z");
    check_cuda(cudaStreamSynchronize(stream), "synchronize sparse input upload");

    SparseApplyPlan plan;
    SparseApplyCsrDeviceView csr{};
    csr.row_offsets = d_row_offsets;
    csr.col_indices = d_col_indices;
    csr.values = d_values;
    csr.rows = static_cast<uint32_t>(oracle_x.size());
    csr.cols = static_cast<uint32_t>(x.size());
    std::string error;
    check(plan.setup(csr, stream, error), error.c_str());
    check(plan.setup_count() == 1u, "sparse plan setup must be performed once");

    SparseApplyXyzDeviceView xyz{};
    xyz.x = d_x;
    xyz.y = d_y;
    xyz.z = d_z;
    xyz.out_x = d_out_x;
    xyz.out_y = d_out_y;
    xyz.out_z = d_out_z;

    const std::vector<SparseApplyVariant> variants{
        SparseApplyVariant::ScalarRow,
        SparseApplyVariant::Subwarp,
        SparseApplyVariant::Warp,
        SparseApplyVariant::CusparseSpmv,
        SparseApplyVariant::CusparseSpmm3,
    };
    for (const SparseApplyVariant variant : variants) {
        check(plan.force_variant_for_test(variant, error), error.c_str());
        check(plan.apply_xyz(xyz, stream, error), error.c_str());
        check_cuda(cudaStreamSynchronize(stream), "synchronize sparse apply");
        std::vector<double> actual_x(oracle_x.size());
        std::vector<double> actual_y(oracle_y.size());
        std::vector<double> actual_z(oracle_z.size());
        check_cuda(cudaMemcpy(actual_x.data(), d_out_x, actual_x.size() * sizeof(double), cudaMemcpyDeviceToHost), "download x");
        check_cuda(cudaMemcpy(actual_y.data(), d_out_y, actual_y.size() * sizeof(double), cudaMemcpyDeviceToHost), "download y");
        check_cuda(cudaMemcpy(actual_z.data(), d_out_z, actual_z.size() * sizeof(double), cudaMemcpyDeviceToHost), "download z");
        check(vector_rms(actual_x, oracle_x) <= 1e-12, "sparse x apply differs from FP64 oracle");
        check(vector_rms(actual_y, oracle_y) <= 1e-12, "sparse y apply differs from FP64 oracle");
        check(vector_rms(actual_z, oracle_z) <= 1e-12, "sparse z apply differs from FP64 oracle");
    }
    check(plan.selected_variant_name()[0] != '\0', "selected sparse variant provenance is empty");
    check(plan.selected_variant_id() != 0u, "selected sparse variant ID is empty");
    check(
        std::string(plan.selection_provenance()).find("selected_id=") != std::string::npos,
        "sparse selection provenance does not persist the selected variant ID");
    check(plan.apply_count() == variants.size(), "sparse apply count does not match executed variants");
    check(plan.setup_count() == 1u, "sparse apply must not rebuild setup state");

    const auto root = fem_source_root();
    const std::string demag = read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "demag_kernels.cu");
    const std::string exchange = read_text_file(root / "gpu" / "cuda" / "exchange" / "exchange_kernels.cu");
    check(
        demag.find("sparse_apply_detail::launch_rhs_csr") != std::string::npos &&
            demag.find("sparse_apply_detail::launch_scalar_csr") != std::string::npos &&
            demag.find("sparse_apply_detail::launch_three_csr") != std::string::npos,
        "demag kernels do not use compiled sparse apply dispatch");
    check(
        exchange.find("SparseApplyVariant::ScalarRow") != std::string::npos &&
            exchange.find("compensated DD") != std::string::npos,
        "exchange kernels do not declare the guarded sparse accuracy policy");
    check(demag.find("cudaStreamSynchronize") == std::string::npos, "demag sparse apply contains a host fence");
    check(exchange.find("cudaStreamSynchronize") == std::string::npos, "exchange sparse apply contains a host fence");

    cudaFree(d_out_z);
    cudaFree(d_out_y);
    cudaFree(d_out_x);
    cudaFree(d_z);
    cudaFree(d_y);
    cudaFree(d_x);
    cudaFree(d_values);
    cudaFree(d_col_indices);
    cudaFree(d_row_offsets);
    cudaStreamDestroy(stream);
    return 0;
}
