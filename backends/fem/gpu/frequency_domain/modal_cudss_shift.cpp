#include "gpu/frequency_domain/modal_cudss_shift.hpp"

#include "gpu/frequency_domain/modal_augmented_pencil.hpp"
#include "gpu/frequency_domain/modal_cudss_device_graph.hpp"

#include <cudss.h>

#include <algorithm>
#include <array>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain::gpu {

struct CudssModalShift::Impl {
    enum class WorkspacePhase { factorization, warm_solve, reused_solve };

    struct Workspace {
        void *pointer = nullptr;
        std::size_t bytes = 0;
        bool available = false;
    };

    cudaStream_t stream = nullptr;
    cudssHandle_t handle = nullptr;
    cudssConfig_t config = nullptr;
    cudssData_t data = nullptr;
    cudssMatrix_t matrix = nullptr;
    cudssMatrix_t rhs_descriptor = nullptr;
    cudssMatrix_t solution_descriptor = nullptr;
    std::uint32_t *row_offsets = nullptr;
    std::uint32_t *columns = nullptr;
    double2 *entries = nullptr;
    double2 *rhs = nullptr;
    double2 *solution = nullptr;
    WorkspacePhase phase = WorkspacePhase::factorization;
    std::vector<Workspace> solve_workspace;
    std::optional<int> negative_inertia;
    std::size_t block_elements = 0;
    std::unique_ptr<CudssDeviceGraph> device_replay;

    ~Impl() { (void)close(); }

    bool close() noexcept
    {
        if (stream == nullptr) {
            return true;
        }
        bool released = cudaStreamSynchronize(stream) == cudaSuccess;
        if (device_replay) {
            released = device_replay->close() && released;
            device_replay.reset();
        }
        phase = WorkspacePhase::factorization;
        if (data != nullptr) {
            released = (cudssDataDestroy(handle, data) == CUDSS_STATUS_SUCCESS) && released;
            data = nullptr;
        }
        for (auto descriptor : {solution_descriptor, rhs_descriptor, matrix}) {
            if (descriptor != nullptr) {
                released = (cudssMatrixDestroy(descriptor) == CUDSS_STATUS_SUCCESS) && released;
            }
        }
        solution_descriptor = rhs_descriptor = matrix = nullptr;
        if (config != nullptr) {
            released = (cudssConfigDestroy(config) == CUDSS_STATUS_SUCCESS) && released;
            config = nullptr;
        }
        if (handle != nullptr) {
            released = (cudssDestroy(handle) == CUDSS_STATUS_SUCCESS) && released;
            handle = nullptr;
        }
        for (const auto &slot : solve_workspace) {
            released = (cudaFreeAsync(slot.pointer, stream) == cudaSuccess) && released;
        }
        solve_workspace.clear();
        for (auto *buffer : {static_cast<void *>(solution), static_cast<void *>(rhs),
                             static_cast<void *>(entries), static_cast<void *>(columns),
                             static_cast<void *>(row_offsets)}) {
            if (buffer != nullptr) {
                released = (cudaFreeAsync(buffer, stream) == cudaSuccess) && released;
            }
        }
        solution = rhs = entries = nullptr;
        columns = row_offsets = nullptr;
        released = (cudaStreamSynchronize(stream) == cudaSuccess) && released;
        stream = nullptr;
        return released;
    }

    // During warm solve remember cuDSS's actual workspace requests. Subsequent
    // enqueues can only claim these existing allocations, including under
    // CUDA graph capture. Factorization storage follows cuDSS's own lifetime.
    static int allocate(void *context, void **output, std::size_t bytes, cudaStream_t on_stream) noexcept
    {
        auto &state = *static_cast<Impl *>(context);
        if (on_stream != state.stream) {
            return cudaErrorInvalidValue;
        }
        // cuDSS may request a zero-size temporary even when warm-up
        // leaves no reusable slots (e.g. one- and two-column tiny systems).
        if (bytes == 0) {
            *output = nullptr;
            return cudaSuccess;
        }
        if (state.phase == WorkspacePhase::reused_solve) {
            const auto slot = std::find_if(state.solve_workspace.begin(), state.solve_workspace.end(),
                [bytes](const Workspace &candidate) { return candidate.available && candidate.bytes >= bytes; });
            if (slot == state.solve_workspace.end()) {
                return cudaErrorMemoryAllocation;
            }
            slot->available = false;
            *output = slot->pointer;
            return cudaSuccess;
        }
        const auto status = cudaMallocAsync(output, bytes, on_stream);
        if (status == cudaSuccess && state.phase == WorkspacePhase::warm_solve && *output != nullptr) {
            try {
                state.solve_workspace.push_back({*output, bytes, false});
            } catch (...) {
                cudaFreeAsync(*output, on_stream);
                *output = nullptr;
                return cudaErrorMemoryAllocation;
            }
        }
        return status;
    }

    static int release(void *context, void *pointer, std::size_t bytes, cudaStream_t on_stream) noexcept
    {
        auto &state = *static_cast<Impl *>(context);
        if (on_stream != state.stream) {
            return cudaErrorInvalidValue;
        }
        if (pointer == nullptr && bytes == 0) {
            return cudaSuccess;
        }
        const auto slot = std::find_if(state.solve_workspace.begin(), state.solve_workspace.end(),
            [pointer](const Workspace &candidate) { return candidate.pointer == pointer; });
        if (slot == state.solve_workspace.end()) {
            // A hot solve may recycle its own warmed workspace only.
            return state.phase == WorkspacePhase::reused_solve
                ? cudaErrorInvalidValue : cudaFreeAsync(pointer, on_stream);
        }
        if (slot->available) {
            return cudaErrorInvalidValue;
        }
        slot->available = true;
        return cudaSuccess;
    }

    bool solve() noexcept
    {
        return cudssExecute(handle, CUDSS_PHASE_SOLVE, config, data, matrix, solution_descriptor, rhs_descriptor)
            == CUDSS_STATUS_SUCCESS;
    }

    template <class T>
    bool upload(T *&target, const void *input, std::size_t count)
    {
        const auto bytes = sizeof(T) * count;
        return cudaMallocAsync(reinterpret_cast<void **>(&target), bytes, stream) == cudaSuccess &&
            cudaMemcpyAsync(target, input, bytes, cudaMemcpyHostToDevice, stream) == cudaSuccess;
    }

    const char *initialize(const OpenAirboxAugmentedPencil &pencil, int block_columns)
    {
        static_assert(sizeof(std::complex<double>) == sizeof(double2));
        static_assert(sizeof(std::uint32_t) == sizeof(std::int32_t));
        const auto &csr = pencil.complex_csr;
        const auto dimension = static_cast<std::int64_t>(csr.row_count);
        block_elements = static_cast<std::size_t>(dimension) * block_columns;
        const auto block_bytes = block_elements * sizeof(double2);
        if (cudssCreate(&handle) != CUDSS_STATUS_SUCCESS ||
            cudssSetStream(handle, stream) != CUDSS_STATUS_SUCCESS ||
            cudssConfigCreate(&config) != CUDSS_STATUS_SUCCESS) {
            return "cudss_context_initialization_failed";
        }
        cudssDeviceMemHandler_t handler{};
        handler.ctx = this;
        handler.device_alloc = allocate;
        handler.device_free = release;
        std::strcpy(handler.name, "fullmag-modal-workspace");
        if (cudssSetDeviceMemHandler(handle, &handler) != CUDSS_STATUS_SUCCESS ||
            cudssDataCreate(handle, &data) != CUDSS_STATUS_SUCCESS) {
            return "cudss_workspace_initialization_failed";
        }
        const int disabled = 0;
        for (const auto property : {CUDSS_CONFIG_HYBRID_MEMORY_MODE, CUDSS_CONFIG_HYBRID_EXECUTE_MODE,
                                    CUDSS_CONFIG_IR_N_STEPS}) {
            if (cudssConfigSet(config, property, &disabled, sizeof(disabled)) != CUDSS_STATUS_SUCCESS) {
                return "cudss_device_policy_failed";
            }
        }
        if (!upload(row_offsets, csr.row_offsets.data(), csr.row_offsets.size()) ||
            !upload(columns, csr.column_indices.data(), csr.column_indices.size()) ||
            !upload(entries, csr.values.data(), csr.values.size()) ||
            cudaMallocAsync(reinterpret_cast<void **>(&rhs), block_bytes, stream) != cudaSuccess ||
            cudaMallocAsync(reinterpret_cast<void **>(&solution), block_bytes, stream) != cudaSuccess ||
            cudaMemsetAsync(rhs, 0, block_bytes, stream) != cudaSuccess) {
            return "cudss_device_buffers_failed";
        }
        if (cudssMatrixCreateCsr(&matrix, dimension, dimension, static_cast<std::int64_t>(csr.values.size()),
                row_offsets, nullptr, columns, entries, CUDSS_R_32I, CUDSS_R_32I, CUDSS_C_64F,
                CUDSS_MTYPE_HERMITIAN, CUDSS_MVIEW_LOWER, CUDSS_BASE_ZERO) != CUDSS_STATUS_SUCCESS ||
            cudssMatrixCreateDn(&rhs_descriptor, dimension, block_columns, dimension, rhs,
                CUDSS_C_64F, CUDSS_LAYOUT_COL_MAJOR) != CUDSS_STATUS_SUCCESS ||
            cudssMatrixCreateDn(&solution_descriptor, dimension, block_columns, dimension, solution,
                CUDSS_C_64F, CUDSS_LAYOUT_COL_MAJOR) != CUDSS_STATUS_SUCCESS) {
            return "cudss_matrix_descriptors_failed";
        }

        if (cudssExecute(handle, CUDSS_PHASE_ANALYSIS, config, data, matrix,
                         solution_descriptor, rhs_descriptor) != CUDSS_STATUS_SUCCESS) {
            return "cudss_symbolic_analysis_failed";
        }
        if (cudssExecute(handle, CUDSS_PHASE_FACTORIZATION, config, data, matrix,
                         solution_descriptor, rhs_descriptor) != CUDSS_STATUS_SUCCESS ||
            cudaStreamSynchronize(stream) != cudaSuccess) {
            return "cudss_cuda_factorization_failed";
        }
        int info = 0;
        std::size_t written = 0;
        if (cudssDataGet(handle, data, CUDSS_DATA_INFO, &info, sizeof(info), &written) != CUDSS_STATUS_SUCCESS ||
            written != sizeof(info) || info != 0) {
            return "cudss_factorization_info_failed";
        }
        std::int32_t perturbed_pivots = 0;
        std::array<std::int32_t, 2> inertia{};
        if (cudssDataGet(handle, data, CUDSS_DATA_NPIVOTS, &perturbed_pivots, sizeof(perturbed_pivots), &written)
                == CUDSS_STATUS_SUCCESS && written == sizeof(perturbed_pivots) && perturbed_pivots == 0 &&
            cudssDataGet(handle, data, CUDSS_DATA_INERTIA, inertia.data(), sizeof(inertia), &written)
                == CUDSS_STATUS_SUCCESS && written == sizeof(inertia) && inertia[0] >= 0 && inertia[1] >= 0 &&
            static_cast<std::int64_t>(inertia[0]) + inertia[1] == dimension) {
            negative_inertia = inertia[1];
        }
        phase = WorkspacePhase::warm_solve;
        if (!solve() || cudaStreamSynchronize(stream) != cudaSuccess) {
            return "cudss_workspace_warm_solve_failed";
        }
        phase = WorkspacePhase::reused_solve;
        return nullptr;
    }
};

CudssModalShift::CudssModalShift() : state_(std::make_unique<Impl>()) {}
CudssModalShift::~CudssModalShift() = default;

std::unique_ptr<CudssModalShift> CudssModalShift::create(
    const OpenAirboxAugmentedPencil &pencil, int block_columns, cudaStream_t stream, const char **failure)
{
    if (failure == nullptr) {
        return nullptr;
    }
    const auto count = pencil.complex_csr.row_count;
    if (stream == nullptr || block_columns < 1 || count == 0 ||
        count > std::numeric_limits<std::size_t>::max() / sizeof(double2) / static_cast<std::size_t>(block_columns) ||
        count != pencil.complex_csr.column_count || pencil.complex_csr.values.empty() ||
        pencil.complex_csr.row_offsets.size() != count + 1 ||
        pencil.complex_csr.values.size() != pencil.complex_csr.column_indices.size()) {
        *failure = "cudss_invalid_device_factor_input";
        return nullptr;
    }
    auto factor = std::unique_ptr<CudssModalShift>(new CudssModalShift);
    factor->state_->stream = stream;
    *failure = factor->state_->initialize(pencil, block_columns);
    if (*failure != nullptr) {
        return nullptr;
    }
    return factor;
}

double2 *CudssModalShift::rhs() noexcept { return state_->rhs; }
const double2 *CudssModalShift::solution() const noexcept { return state_->solution; }
std::optional<int> CudssModalShift::negative_inertia() const noexcept { return state_->negative_inertia; }
bool CudssModalShift::enqueue() noexcept { return state_->solve(); }

bool CudssModalShift::prepare_device_replay(const char **failure)
{
    if (!failure) {
        return false;
    }
    *failure = nullptr;
    if (state_->device_replay) {
        return true;
    }
    state_->device_replay = CudssDeviceGraph::prepare(
        state_->stream, state_->rhs, state_->solution, state_->block_elements,
        [this] { return state_->solve(); }, failure);
    return static_cast<bool>(state_->device_replay);
}

bool CudssModalShift::enqueue_device_replay() noexcept
{
    return state_->device_replay && state_->device_replay->launch(state_->stream);
}

std::size_t CudssModalShift::device_replay_nodes() const noexcept
{
    return state_->device_replay ? state_->device_replay->node_count() : 0;
}

bool CudssModalShift::close() noexcept { return state_->close(); }

} // namespace fullmag::fem::frequency_domain::gpu
