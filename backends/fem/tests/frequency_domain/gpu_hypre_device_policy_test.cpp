#include "gpu/cuda/runtime/hypre_device_policy.hpp"
#include "tests/source_facade_contract_utils.hpp"

#include <cstdio>
#include <cstdlib>
#include <string>

namespace {

using fullmag::fem::HypreDevicePolicyApi;
using fullmag::fem::HypreDevicePolicySnapshot;
using fullmag::fem::hypre_cuda_device_policy_is_available;
using fullmag::fem::tests::check;
using fullmag::fem::tests::fem_source_root;
using fullmag::fem::tests::read_text_file;

struct FakeSetters {
    static inline int memory_status = 0;
    static inline int execution_status = 0;
    static inline int sptrans_status = 0;
    static inline int spmv_status = 0;
    static inline int spgemm_status = 0;
    static inline int memory_calls = 0;
    static inline int execution_calls = 0;
    static inline int sptrans_calls = 0;
    static inline int spmv_calls = 0;
    static inline int spgemm_calls = 0;
    static inline int clear_calls = 0;

    static void reset()
    {
        memory_status = 0;
        execution_status = 0;
        sptrans_status = 0;
        spmv_status = 0;
        spgemm_status = 0;
        memory_calls = 0;
        execution_calls = 0;
        sptrans_calls = 0;
        spmv_calls = 0;
        spgemm_calls = 0;
        clear_calls = 0;
    }

    static int set_memory() noexcept { ++memory_calls; return memory_status; }
    static int set_execution() noexcept { ++execution_calls; return execution_status; }
    static int set_sptrans() noexcept { ++sptrans_calls; return sptrans_status; }
    static int set_spmv() noexcept { ++spmv_calls; return spmv_status; }
    static int set_spgemm() noexcept { ++spgemm_calls; return spgemm_status; }
    static void clear_errors() noexcept { ++clear_calls; }
};

HypreDevicePolicyApi fake_api()
{
    return HypreDevicePolicyApi{
        FakeSetters::set_memory,
        FakeSetters::set_execution,
        FakeSetters::set_sptrans,
        FakeSetters::set_spmv,
        FakeSetters::set_spgemm,
        FakeSetters::clear_errors};
}

void successful_configuration_publishes_complete_device_snapshot()
{
    FakeSetters::reset();
    const HypreDevicePolicySnapshot snapshot =
        fullmag::fem::detail::configure_hypre_cuda_device_policy_uncached(fake_api());

    check(snapshot.configured, "successful HYPRE policy must be configured");
    check(snapshot.memory_location_device,
          "successful HYPRE policy must attest device memory");
    check(snapshot.execution_policy_device,
          "successful HYPRE policy must attest device execution");
    check(snapshot.vendor_sptrans_enabled && snapshot.vendor_spmv_enabled &&
              snapshot.vendor_spgemm_enabled,
          "successful HYPRE policy must attest all required vendor sparse kernels");
    check(snapshot.first_error_code == 0 && snapshot.failure_reason.empty(),
          "successful HYPRE policy must not publish a failure");
    check(hypre_cuda_device_policy_is_available(snapshot),
          "complete device snapshot must pass strict validation");
    check(FakeSetters::memory_calls == 1 && FakeSetters::execution_calls == 1 &&
              FakeSetters::sptrans_calls == 1 && FakeSetters::spmv_calls == 1 &&
              FakeSetters::spgemm_calls == 1 && FakeSetters::clear_calls == 0,
          "successful HYPRE policy must invoke every setter exactly once");
}

void first_setter_failure_is_preserved_and_fails_closed()
{
    FakeSetters::reset();
    FakeSetters::execution_status = 73;
    const HypreDevicePolicySnapshot snapshot =
        fullmag::fem::detail::configure_hypre_cuda_device_policy_uncached(fake_api());

    check(!snapshot.configured && snapshot.memory_location_device &&
              !snapshot.execution_policy_device,
          "partial HYPRE device policy must not be promoted");
    check(snapshot.first_error_code == 73,
          "HYPRE policy must preserve the first setter error code");
    check(snapshot.failure_reason ==
              "k0_poisson_airbox_gpu_hypre_device_policy_unavailable",
          "HYPRE policy failure must use the stable production reason token");
    check(!hypre_cuda_device_policy_is_available(snapshot),
          "partial HYPRE device policy must fail strict validation");
    check(FakeSetters::memory_calls == 1 && FakeSetters::execution_calls == 1 &&
              FakeSetters::sptrans_calls == 0 && FakeSetters::spmv_calls == 0 &&
              FakeSetters::spgemm_calls == 0 && FakeSetters::clear_calls == 1,
          "HYPRE policy must stop after and clear the first setter failure");
}

void host_policy_snapshots_fail_strict_validation()
{
    HypreDevicePolicySnapshot host_memory{};
    host_memory.configured = true;
    host_memory.execution_policy_device = true;
    host_memory.vendor_sptrans_enabled = true;
    host_memory.vendor_spmv_enabled = true;
    host_memory.vendor_spgemm_enabled = true;
    check(!hypre_cuda_device_policy_is_available(host_memory),
          "host HYPRE memory location must fail strict validation");

    HypreDevicePolicySnapshot host_execution = host_memory;
    host_execution.memory_location_device = true;
    host_execution.execution_policy_device = false;
    check(!hypre_cuda_device_policy_is_available(host_execution),
          "host HYPRE execution policy must fail strict validation");
}

void both_gpu_consumers_call_the_shared_owner_before_hypre_setup()
{
    const auto root = fem_source_root();
    const std::string demag = read_text_file(
        root / "gpu" / "cuda" / "demag_poisson" / "hypre_device_solver.cpp");
    const std::string modal = read_text_file(
        root / "gpu" / "frequency_domain" / "modal_petsc_slepc.cpp");
    const std::string owner = read_text_file(
        root / "gpu" / "cuda" / "runtime" / "hypre_device_policy.cpp");
    const std::string modal_result = read_text_file(
        root / "include" / "frequency_domain" / "modal_eigen_result.hpp");
    const std::string modal_solver = read_text_file(
        root / "src" / "frequency_domain" / "modal_eigen_solver.cpp");
    const std::string api = read_text_file(root / "src" / "api.cpp");

    check(demag.find("configure_hypre_cuda_device_policy()") != std::string::npos,
          "time-domain demag must call the shared HYPRE policy owner");
    check(demag.find("HYPRE_SetMemoryLocation") == std::string::npos &&
              demag.find("HYPRE_SetExecutionPolicy") == std::string::npos,
          "time-domain demag must not retain a private HYPRE device policy");

    const std::size_t modal_policy =
        modal.find("configure_hypre_cuda_device_policy()");
    const std::size_t modal_pc = modal.find("PCSetType(pc, PCHYPRE)");
    const std::size_t modal_setup = modal.find("KSPSetUp(context->poisson_ksp)");
    check(modal_policy != std::string::npos && modal_pc != std::string::npos &&
              modal_setup != std::string::npos && modal_policy < modal_pc &&
              modal_policy < modal_setup,
          "modal Poisson must attest HYPRE policy before PCHYPRE and KSP setup");
    check(owner.find("HYPRE_SetMemoryLocation(HYPRE_MEMORY_DEVICE)") !=
              std::string::npos &&
              owner.find("HYPRE_SetExecutionPolicy(HYPRE_EXEC_DEVICE)") !=
              std::string::npos,
          "shared owner must configure HYPRE device memory and execution");
    check(modal_result.find("ModalGpuExecutionAttestation") != std::string::npos &&
              modal_solver.find("modal_gpu_attestation") != std::string::npos,
          "modal contract result must carry the exact executed-adapter HYPRE snapshot");
    check(api.find("caller_supports_v20") != std::string::npos &&
              api.find("FULLMAG_FEM_MODAL_HYPRE_MEMORY_DEVICE") !=
                  std::string::npos &&
              api.find("FULLMAG_FEM_MODAL_HYPRE_EXEC_DEVICE") !=
                  std::string::npos &&
              api.find("FULLMAG_FEM_MODAL_GPU_COVERAGE_SETUP") !=
                  std::string::npos,
          "result v20 must map the measured T3 snapshot without routing strict GPU through v18");
    check(api.find("FULLMAG_FEM_MODAL_GPU_MEASUREMENT_UNAVAILABLE") !=
              std::string::npos,
          "T3-only sidecar must remain globally unavailable until full T4 evidence exists");
}

} // namespace

int main()
{
    successful_configuration_publishes_complete_device_snapshot();
    first_setter_failure_is_preserved_and_fails_closed();
    host_policy_snapshots_fail_strict_validation();
    both_gpu_consumers_call_the_shared_owner_before_hypre_setup();
    std::puts("gpu_hypre_device_policy_test: ok");
    return 0;
}
