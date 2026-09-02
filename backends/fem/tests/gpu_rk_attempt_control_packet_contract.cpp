#include "gpu/cuda/integrators/rk/rk_attempt_control_state.hpp"

#include <cstddef>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) std::abort();
}

std::string source(const char *relative)
{
    const auto path = std::filesystem::path(__FILE__).parent_path().parent_path() /
        relative;
    std::ifstream input(path);
    check(input.good(), "attempt-control contract source must be readable");
    std::ostringstream text;
    text << input.rdbuf();
    return text.str();
}

} // namespace

int main()
{
    using namespace fullmag::fem;
    static_assert(offsetof(GpuRkAttemptControlPacket, flags) == 0);
    static_assert(offsetof(GpuRkAttemptControlPacket, error_norm) == 8);
    static_assert(offsetof(GpuRkAttemptControlPacket, decision) == 40);
    check((GpuRkAttemptFlagInvalidNormalization &
           GpuRkAttemptFlagNonFiniteError) == 0,
          "attempt flags must remain independently representable");

    const auto kernels = source("gpu/cuda/integrators/rk/rk_attempt_control_kernels.cu");
    const auto readback = source("gpu/cuda/integrators/rk/rk_adaptive_decision_readback.cu");
    const auto memory = source("gpu/cuda/integrators/rk/rk_attempt_control_memory.cpp");
    check(kernels.find("atomicOr") != std::string::npos &&
              kernels.find("GpuRkAttemptFlagInvalidNormalization") != std::string::npos,
          "invalid normalization must be published through the typed packet");
    check(kernels.find("cudaMemcpy") == std::string::npos,
          "normalization kernels must not perform direct host readbacks");
    check(readback.find("gpu_rk_read_attempt_control_packet") != std::string::npos &&
              readback.find("cudaMemcpyAsync") != std::string::npos &&
              readback.find("cudaStreamSynchronize") != std::string::npos,
          "one packet owner must perform the control readback and fence");
    check(memory.find("cudaHostAlloc") != std::string::npos &&
              memory.find("control.device = nullptr") != std::string::npos,
          "attempt packet must be preallocated in pinned host/device storage");
    return 0;
}
