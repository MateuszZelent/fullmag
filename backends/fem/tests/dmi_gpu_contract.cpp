#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"
#include "gpu/cuda/interactions/dmi/dmi_geometry_cache.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/reductions/reduction_workspace_memory.hpp"
#include "gpu/cuda/reductions/reduction_workspace_state.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <climits>
#include <cstddef>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>

namespace {
using fullmag::fem::DmiApplyRequest;
using fullmag::fem::DmiDiagnostics;
using fullmag::fem::FemGpuReductionWorkspaceDeviceState;

static_assert(
    offsetof(FemGpuReductionWorkspaceDeviceState, dmi_diagnostics) !=
    offsetof(FemGpuReductionWorkspaceDeviceState, scalar_result));

void require(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void cuda_require(cudaError_t status, const char *operation)
{
    if (status != cudaSuccess) {
        std::fprintf(stderr, "FAIL: %s: %s\n", operation, cudaGetErrorString(status));
        std::exit(1);
    }
}

template <typename T> class DeviceBuffer {
public:
    explicit DeviceBuffer(std::size_t size) : size_(size)
    {
        cuda_require(cudaMalloc(reinterpret_cast<void **>(&data_), size * sizeof(T)), "cudaMalloc");
    }
    explicit DeviceBuffer(const std::vector<T> &values) : DeviceBuffer(values.size()) { upload(values); }
    ~DeviceBuffer() { cudaFree(data_); }
    DeviceBuffer(const DeviceBuffer &) = delete;
    DeviceBuffer &operator=(const DeviceBuffer &) = delete;
    T *get() { return data_; }
    const T *get() const { return data_; }
    void upload(const std::vector<T> &values)
    {
        require(values.size() == size_, "upload size mismatch");
        cuda_require(cudaMemcpy(data_, values.data(), size_ * sizeof(T), cudaMemcpyHostToDevice), "upload");
    }
    std::vector<T> download() const
    {
        std::vector<T> values(size_);
        cuda_require(cudaMemcpy(values.data(), data_, size_ * sizeof(T), cudaMemcpyDeviceToHost), "download");
        return values;
    }
private:
    T *data_ = nullptr;
    std::size_t size_ = 0;
};

struct Oracle {
    double field[4][3] = {};
    double energy = 0.0;
};

Oracle reference_dmi(const std::array<std::array<double, 4>, 3> &m, bool bulk)
{
    constexpr double mu0 = 1.2566370614359172953850573533118e-6;
    constexpr double ms = 8.0e5, d = 2.5e-3, volume = 1.0 / 6.0, mass = 1.0 / 24.0;
    constexpr double grad[4][3] = {
        {-1.0, -1.0, -1.0}, {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0}, {0.0, 0.0, 1.0}};
    double average[3] = {}, gradient[3][3] = {};
    for (int a = 0; a < 4; ++a) for (int c = 0; c < 3; ++c) {
        average[c] += 0.25 * m[c][a];
        for (int j = 0; j < 3; ++j) gradient[c][j] += m[c][a] * grad[a][j];
    }
    const double divergence = gradient[0][0] + gradient[1][1] + gradient[2][2];
    const double curl[3] = {
        gradient[2][1] - gradient[1][2], gradient[0][2] - gradient[2][0],
        gradient[1][0] - gradient[0][1]};
    const double grad_dot_n[3] = {gradient[2][0], gradient[2][1], gradient[2][2]};
    Oracle result;
    for (int a = 0; a < 4; ++a) {
        double residual[3] = {};
        for (int c = 0; c < 3; ++c) {
            if (bulk) {
                residual[c] = c == 0
                    ? d * volume * (0.25 * curl[0] + average[1] * grad[a][2] - average[2] * grad[a][1])
                    : c == 1
                    ? d * volume * (0.25 * curl[1] - average[0] * grad[a][2] + average[2] * grad[a][0])
                    : d * volume * (0.25 * curl[2] + average[0] * grad[a][1] - average[1] * grad[a][0]);
            } else {
                const double nc = c == 2 ? 1.0 : 0.0;
                double gradient_action = 0.0;
                for (int j = 0; j < 3; ++j) {
                    gradient_action += d * (average[2] * (c == j ? 1.0 : 0.0) - nc * average[j]) * grad[a][j];
                }
                residual[c] = volume * (0.25 * d * (nc * divergence - grad_dot_n[c]) + gradient_action);
            }
            result.field[a][c] = -residual[c] / (mu0 * ms * mass);
        }
    }
    if (bulk) {
        result.energy = d * volume *
            (average[0] * curl[0] + average[1] * curl[1] + average[2] * curl[2]);
    } else {
        result.energy = d * volume * (average[2] * divergence -
            (average[0] * grad_dot_n[0] + average[1] * grad_dot_n[1] + average[2] * grad_dot_n[2]));
    }
    return result;
}

bool close(double actual, double expected)
{
    return std::fabs(actual - expected) <= 2.0e-12 * std::max({1.0, std::fabs(actual), std::fabs(expected)});
}

std::array<uint64_t, 2> download_diagnostics(const DmiDiagnostics *diagnostics)
{
    std::array<uint64_t, 2> counts{};
    cuda_require(cudaMemcpy(counts.data(), diagnostics, sizeof(DmiDiagnostics), cudaMemcpyDeviceToHost), "diagnostics download");
    return counts;
}

void regular_case(bool bulk, FemGpuReductionWorkspaceDeviceState &workspace)
{
    auto *diagnostics = reinterpret_cast<DmiDiagnostics *>(workspace.dmi_diagnostics);
    const std::array<std::array<double, 4>, 3> m = {{
        {{0.2, 0.8, -0.1, 0.4}}, {{-0.3, 0.1, 0.7, -0.2}}, {{0.9, -0.4, 0.2, 0.5}}}};
    DeviceBuffer<double> nodes(std::vector<double>{0,0,0, 1,0,0, 0,1,0, 0,0,1});
    DeviceBuffer<uint32_t> elements(std::vector<uint32_t>{0,1,2,3});
    DeviceBuffer<uint8_t> element_mask(std::vector<uint8_t>{1}), node_mask(std::vector<uint8_t>(4,1));
    DeviceBuffer<double> mx(std::vector<double>(m[0].begin(),m[0].end()));
    DeviceBuffer<double> my(std::vector<double>(m[1].begin(),m[1].end()));
    DeviceBuffer<double> mz(std::vector<double>(m[2].begin(),m[2].end()));
    DeviceBuffer<double> ms(std::vector<double>(4,8.0e5)), mass(std::vector<double>(4,1.0/24.0));
    DeviceBuffer<double> rx(4),ry(4),rz(4),hx(4),hy(4),hz(4);
    constexpr double sentinel = 9.87654321e123;
    cuda_require(cudaMemcpy(workspace.scalar_workspace,&sentinel,sizeof(double),cudaMemcpyHostToDevice),"energy sentinel upload");
    cuda_require(fullmag::fem::fullmag_cuda_dmi_field_energy(
        nodes.get(),elements.get(),element_mask.get(),mx.get(),my.get(),mz.get(),ms.get(),nullptr,
        mass.get(),node_mask.get(),rx.get(),ry.get(),rz.get(),hx.get(),hy.get(),hz.get(),workspace.scalar_workspace,
        diagnostics,DmiApplyRequest{true,false},8.0e5,2.5e-3,0,0,1,false,bulk,1,4), "DMI field-only");
    cuda_require(cudaDeviceSynchronize(), "field-only synchronize");
    double untouched=0.0; cuda_require(cudaMemcpy(&untouched,workspace.scalar_workspace,sizeof(double),cudaMemcpyDeviceToHost),"energy sentinel download");
    require(untouched == sentinel, "field-only touched energy storage");
    const auto counts = download_diagnostics(diagnostics);
    require(counts[0] == 0 && counts[1] == 0, "regular tetrahedron diagnostics nonzero");
    const Oracle expected = reference_dmi(m,bulk);
    const auto x=hx.download(), y=hy.download(), z=hz.download();
    for(int a=0;a<4;++a){require(close(x[a],expected.field[a][0]),"Hx oracle mismatch");require(close(y[a],expected.field[a][1]),"Hy oracle mismatch");require(close(z[a],expected.field[a][2]),"Hz oracle mismatch");}
    cuda_require(fullmag::fem::fullmag_cuda_dmi_field_energy(
        nodes.get(),elements.get(),element_mask.get(),mx.get(),my.get(),mz.get(),ms.get(),nullptr,
        mass.get(),node_mask.get(),rx.get(),ry.get(),rz.get(),hx.get(),hy.get(),hz.get(),workspace.scalar_workspace,
        diagnostics,DmiApplyRequest{false,true},8.0e5,2.5e-3,0,0,1,false,bulk,1,4), "DMI energy-only");
    size_t bytes=static_cast<size_t>(workspace.temp_storage_bytes);
    cuda_require(fullmag::fem::fullmag_cuda_device_sum(workspace.scalar_workspace,1,workspace.scalar_result,workspace.temp_storage,bytes), "DMI scalar sum");
    cuda_require(cudaDeviceSynchronize(), "energy synchronize");
    double energy=0.0; cuda_require(cudaMemcpy(&energy,workspace.scalar_result,sizeof(double),cudaMemcpyDeviceToHost),"energy download");
    require(close(energy,expected.energy),"energy oracle mismatch");
}

void colored_energy_repeated_case()
{
    constexpr int element_count = 257;
    constexpr int node_count = 4 * element_count;
    constexpr double sentinel = 9.87654321e123;
    const std::array<std::array<double, 4>, 3> m = {{
        {{0.2, 0.8, -0.1, 0.4}},
        {{-0.3, 0.1, 0.7, -0.2}},
        {{0.9, -0.4, 0.2, 0.5}},
    }};
    std::vector<double> host_nodes(static_cast<std::size_t>(node_count) * 3u);
    std::vector<uint32_t> host_elements(static_cast<std::size_t>(element_count) * 4u);
    std::vector<double> host_mx(node_count), host_my(node_count), host_mz(node_count);
    for (int element = 0; element < element_count; ++element) {
        const double base = 2.0 * static_cast<double>(element);
        const int node = 4 * element;
        const double coordinates[4][3] = {
            {base, 0.0, 0.0},
            {base + 1.0, 0.0, 0.0},
            {base, 1.0, 0.0},
            {base, 0.0, 1.0},
        };
        for (int local = 0; local < 4; ++local) {
            host_elements[static_cast<std::size_t>(node + local)] =
                static_cast<uint32_t>(node + local);
            for (int component = 0; component < 3; ++component) {
                host_nodes[static_cast<std::size_t>(3 * (node + local) + component)] =
                    coordinates[local][component];
            }
            host_mx[node + local] = m[0][local];
            host_my[node + local] = m[1][local];
            host_mz[node + local] = m[2][local];
        }
    }
    DeviceBuffer<double> nodes(host_nodes), mx(host_mx), my(host_my), mz(host_mz);
    DeviceBuffer<uint32_t> elements(host_elements);
    DeviceBuffer<uint8_t> element_mask(std::vector<uint8_t>(element_count, 1));
    DeviceBuffer<uint8_t> node_mask(std::vector<uint8_t>(node_count, 1));
    DeviceBuffer<double> ms(std::vector<double>(node_count, 8.0e5));
    DeviceBuffer<double> mass(std::vector<double>(node_count, 1.0 / 24.0));
    DeviceBuffer<double> rx(node_count), ry(node_count), rz(node_count);
    DeviceBuffer<double> hx(node_count), hy(node_count), hz(node_count);

    fullmag::fem::DmiGeometryCache cache;
    std::string error;
    require(
        cache.build(
            nodes.get(), elements.get(), element_mask.get(), element_count,
            node_count, nullptr, error),
        "colored DMI cache build failed");
    require(cache.num_colors() == 1, "disjoint tetrahedra must use one color");
    cache.set_accumulation_mode(fullmag::fem::DmiAccumulationMode::Coloring);

    FemGpuReductionWorkspaceDeviceState workspace{};
    uint64_t device_bytes = 0, workspace_bytes = 0;
    require(
        fullmag::fem::gpu_reduction_workspace_allocate(
            workspace, node_count, device_bytes, workspace_bytes, error),
        "colored DMI reduction workspace allocation failed");
    const int partial_count = fullmag::fem::dmi_energy_partial_count(node_count);
    const std::vector<double> sentinels(partial_count, sentinel);
    const double expected_energy =
        reference_dmi(m, false).energy * static_cast<double>(element_count);
    auto *diagnostics = reinterpret_cast<DmiDiagnostics *>(workspace.dmi_diagnostics);

    for (int repetition = 0; repetition < 2; ++repetition) {
        cuda_require(
            cudaMemcpy(
                workspace.scalar_workspace, sentinels.data(),
                static_cast<std::size_t>(partial_count) * sizeof(double),
                cudaMemcpyHostToDevice),
            "colored DMI energy sentinel upload");
        cuda_require(
            fullmag::fem::fullmag_cuda_dmi_field_energy_cached(
                cache.device_view(), elements.get(), element_mask.get(), mx.get(), my.get(),
                mz.get(), ms.get(), nullptr, mass.get(), node_mask.get(), rx.get(), ry.get(),
                rz.get(), hx.get(), hy.get(), hz.get(), workspace.scalar_workspace,
                diagnostics, DmiApplyRequest{true, true}, 8.0e5, 2.5e-3, 0.0, 0.0,
                1.0, false, false, element_count, node_count, nullptr,
                cache.accumulation_mode()),
            "colored DMI field and energy");
        size_t reduce_bytes = static_cast<std::size_t>(workspace.temp_storage_bytes);
        cuda_require(
            fullmag::fem::fullmag_cuda_device_sum(
                workspace.scalar_workspace, partial_count, workspace.scalar_result,
                workspace.temp_storage, reduce_bytes),
            "colored DMI energy sum");
        cuda_require(cudaDeviceSynchronize(), "colored DMI energy synchronize");
        double energy = 0.0;
        cuda_require(
            cudaMemcpy(
                &energy, workspace.scalar_result, sizeof(double), cudaMemcpyDeviceToHost),
            "colored DMI energy download");
        require(close(energy, expected_energy), "colored DMI energy accumulated stale partials");
    }

    cuda_require(
        cudaMemcpy(
            workspace.scalar_workspace, sentinels.data(),
            static_cast<std::size_t>(partial_count) * sizeof(double),
            cudaMemcpyHostToDevice),
        "colored DMI field-only sentinel upload");
    cuda_require(
        fullmag::fem::fullmag_cuda_dmi_field_energy_cached(
            cache.device_view(), elements.get(), element_mask.get(), mx.get(), my.get(), mz.get(),
            ms.get(), nullptr, mass.get(), node_mask.get(), rx.get(), ry.get(), rz.get(), hx.get(),
            hy.get(), hz.get(), workspace.scalar_workspace, diagnostics,
            DmiApplyRequest{true, false}, 8.0e5, 2.5e-3, 0.0, 0.0, 1.0, false, false,
            element_count, node_count, nullptr, cache.accumulation_mode()),
        "colored DMI field-only");
    cuda_require(cudaDeviceSynchronize(), "colored DMI field-only synchronize");
    std::vector<double> untouched(partial_count);
    cuda_require(
        cudaMemcpy(
            untouched.data(), workspace.scalar_workspace,
            static_cast<std::size_t>(partial_count) * sizeof(double),
            cudaMemcpyDeviceToHost),
        "colored DMI field-only sentinel download");
    require(untouched == sentinels, "colored DMI field-only touched energy storage");
    const auto counts = download_diagnostics(diagnostics);
    require(counts[0] == 0 && counts[1] == 0, "colored DMI diagnostics nonzero");
    fullmag::fem::gpu_reduction_workspace_free(workspace);
}

void invalid_case(bool nonfinite, DmiDiagnostics *diagnostics)
{
    std::vector<double> host_nodes={0,0,0,1,0,0,0,1,0,0,0,nonfinite?1.0:0.0};
    std::vector<double> host_mx={0.2,0.8,-0.1,0.4}; if(nonfinite) host_mx[0]=std::numeric_limits<double>::quiet_NaN();
    DeviceBuffer<double> nodes(host_nodes),mx(host_mx),my(std::vector<double>{-.3,.1,.7,-.2}),mz(std::vector<double>{.9,-.4,.2,.5});
    DeviceBuffer<uint32_t> elements(std::vector<uint32_t>{0,1,2,3}); DeviceBuffer<uint8_t> em(std::vector<uint8_t>{1}),nm(std::vector<uint8_t>(4,1));
    DeviceBuffer<double> ms(std::vector<double>(4,8e5)),mass(std::vector<double>(4,1.0/24.0)),rx(4),ry(4),rz(4),hx(4),hy(4),hz(4);
    cuda_require(fullmag::fem::fullmag_cuda_dmi_field_energy(nodes.get(),elements.get(),em.get(),mx.get(),my.get(),mz.get(),ms.get(),nullptr,mass.get(),nm.get(),rx.get(),ry.get(),rz.get(),hx.get(),hy.get(),hz.get(),nullptr,diagnostics,DmiApplyRequest{true,false},8e5,2.5e-3,0,0,1,false,false,1,4),"invalid DMI");
    cuda_require(cudaDeviceSynchronize(),"invalid synchronize"); const auto counts=download_diagnostics(diagnostics); require(nonfinite?counts[1]==1:counts[0]==1,"diagnostic count mismatch");
    const auto field=hx.download(); require(std::all_of(field.begin(),field.end(),[](double v){return std::isnan(v);}),"invalid DMI did not fail closed");
}
}

int main()
{
    FemGpuReductionWorkspaceDeviceState workspace{};
    require(workspace.dmi_diagnostics == nullptr,"named DMI diagnostics must initialize null");
    uint64_t device_bytes=0,workspace_bytes=0; std::string error;
    require(fullmag::fem::gpu_reduction_workspace_allocate(workspace,4,device_bytes,workspace_bytes,error),"workspace allocation failed");
    require(workspace.dmi_diagnostics != nullptr,"named DMI diagnostics were not allocated");
    require(reinterpret_cast<void*>(workspace.dmi_diagnostics)!=reinterpret_cast<void*>(workspace.scalar_result),"DMI diagnostics alias scalar results");
    require(workspace_bytes>=3*sizeof(double)+fullmag::fem::FEM_GPU_SCALAR_RESULT_SLOTS*sizeof(double)+sizeof(DmiDiagnostics),"DMI diagnostics bytes not accounted");
    require(device_bytes==workspace_bytes,"reduction workspace device-byte accounting mismatch");
    auto *diagnostics=reinterpret_cast<DmiDiagnostics*>(workspace.dmi_diagnostics);
    require(fullmag::fem::dmi_energy_partial_count(INT_MAX)==INT_MAX/256+(INT_MAX%256!=0),"partial count overflow");
    regular_case(false,workspace); regular_case(true,workspace); colored_energy_repeated_case(); invalid_case(false,diagnostics); invalid_case(true,diagnostics);
    DeviceBuffer<double> values(std::vector<double>{1,2,3,4,5}),scratch(5),result(1);
    cuda_require(fullmag::fem::fullmag_cuda_dmi_pairwise_sum(values.get(),scratch.get(),5,result.get()),"pairwise reduction");
    cuda_require(cudaDeviceSynchronize(),"pairwise synchronize"); require(result.download()[0]==15.0,"pairwise mismatch");
    fullmag::fem::gpu_reduction_workspace_free(workspace);
    require(workspace.dmi_diagnostics==nullptr,"named DMI diagnostics were not freed");
    return 0;
}
