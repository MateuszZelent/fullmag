#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

static void check(bool condition, const char *msg)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

static std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

static std::filesystem::path fem_source_root()
{
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

int main()
{
    const std::filesystem::path root = fem_source_root();
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string transfer_header =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "transfer_audit.hpp");
    const std::string transfer_impl =
        read_text_file(root / "gpu" / "cuda" / "transfer" / "transfer_audit.cpp");
    const std::string exchange_upload = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "exchange_legacy_gpu_upload.cpp");
    const std::string exchange_hot_path = read_text_file(
        root / "gpu" / "cuda" / "integrators" / "rk" / "rk_exchange_dispatch.cu");
    check(
        api.find("env_flag(\"FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC\")") ==
            std::string::npos,
        "C ABI API must not parse transfer-audit host-sync env gate");
    check(
        api.find("env_flag(\"FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC\")") ==
            std::string::npos,
        "C ABI API must not parse transfer-audit compute-sync env gate");
    check(
        api.find("*out_audit = handle->context.transfer_audit.audit.counters;") ==
            std::string::npos,
        "C ABI API must not read transfer-audit counters directly");
    check(
        api.find("fullmag::fem::transfer_audit_snapshot(") != std::string::npos,
        "C ABI API must use transfer-audit snapshot helper");
    check(
        transfer_header.find("Configure transfer-audit assertion gates from environment") !=
            std::string::npos,
        "transfer audit header must document env gate ownership");
    check(
        transfer_header.find("void configure_transfer_audit_from_env(TransferAudit &audit);") !=
            std::string::npos,
        "transfer audit header must declare env gate import");
    check(
        transfer_header.find("void record_device_control_scalar_to_host(") !=
                std::string::npos &&
            transfer_impl.find("record_device_control_scalar_to_host(") !=
                std::string::npos,
        "transfer audit must expose a separate control-scalar D2H accounting path");
    check(
        transfer_impl.find("hot_loop_control_scalar_d2h_bytes") !=
                std::string::npos &&
            transfer_impl.find("hot_loop_control_scalar_host_sync_count") !=
                std::string::npos,
        "transfer audit must publish hot-loop control-scalar readback counters");
    check(
        transfer_impl.find("void configure_transfer_audit_from_env(TransferAudit &audit)") !=
            std::string::npos,
        "transfer audit implementation must own env gate import");
    check(
        cmake.find("gpu/cuda/transfer/transfer_audit.cpp") != std::string::npos,
        "FEM CMake source list must build transfer audit from gpu/cuda/transfer");
    check(
        cmake.find("src/transfer_audit.cpp") == std::string::npos &&
            !std::filesystem::exists(root / "src" / "transfer_audit.cpp"),
        "legacy transfer-audit placeholder source must be removed");
    check(
        !std::filesystem::exists(root / "include" / "transfer_audit.hpp"),
        "transfer audit header must not remain in root include");
    check(
        transfer_header.find("GPU CUDA transfer-audit module header") !=
            std::string::npos,
        "transfer audit header must document its module ownership");
    check(
        transfer_impl.find("#include \"gpu/cuda/transfer/transfer_audit.hpp\"") !=
            std::string::npos,
        "transfer audit implementation must include its module-owned header");
    check(
        transfer_impl.find("GPU CUDA transfer-audit source contract") != std::string::npos,
        "GPU CUDA transfer-audit module must document its source contract");
    check(
        transfer_header.find("Return the current transfer-audit public counters") !=
            std::string::npos,
        "transfer audit header must document snapshot ownership");
    check(
        transfer_header.find("fullmag_fem_transfer_audit transfer_audit_snapshot(") !=
            std::string::npos,
        "transfer audit header must declare snapshot helper");
    check(
        transfer_header.find("struct TransferAuditRuntimeState") != std::string::npos,
        "transfer audit header must declare the runtime audit-state owner");
    check(
        transfer_header.find("TransferAudit audit") != std::string::npos,
        "transfer audit runtime state must own the TransferAudit payload");
    check(
        context_header.find("TransferAuditRuntimeState transfer_audit{}") !=
            std::string::npos,
        "Context must store transfer audit through the runtime owner");
    check(
        context_header.find("TransferAudit transfer_audit") == std::string::npos,
        "Context must not own a flat TransferAudit field");
    check(
        exchange_upload.find("gpu_state_upload_exchange_legacy_sparse(") !=
                std::string::npos &&
            exchange_upload.find("TransferAuditScopeKind::HotLoop") ==
                std::string::npos,
        "MFEM CSR exchange upload must remain an initialization transfer, not a hot-loop scope");
    check(
        exchange_hot_path.find("mesh_geometry") == std::string::npos &&
            exchange_hot_path.find("cell_nodes") == std::string::npos &&
            exchange_hot_path.find("n_elements") == std::string::npos,
        "GPU exchange hot path must consume sparse state without element-wise geometry loops");

    unsetenv("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC");
    unsetenv("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC");
    fullmag::fem::TransferAudit env_audit;
    fullmag::fem::configure_transfer_audit_from_env(env_audit);
    check(
        !env_audit.assert_no_hot_loop_host_sync,
        "unset host-sync transfer-audit env gate stays disabled");
    check(
        !env_audit.assert_no_hot_loop_compute_sync,
        "unset compute-sync transfer-audit env gate stays disabled");
    setenv("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC", "yes", 1);
    setenv("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC", "1", 1);
    fullmag::fem::configure_transfer_audit_from_env(env_audit);
    check(
        env_audit.assert_no_hot_loop_host_sync,
        "host-sync transfer-audit env gate imports truthy value");
    check(
        env_audit.assert_no_hot_loop_compute_sync,
        "compute-sync transfer-audit env gate imports truthy value");
    unsetenv("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC");
    unsetenv("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC");

    fullmag::fem::TransferAudit audit;

    {
        fullmag::fem::TransferAuditScope hot_loop(
            audit,
            fullmag::fem::TransferAuditScopeKind::HotLoop);
        fullmag::fem::record_mfem_host_read(16);

        {
            fullmag::fem::TransferAuditScope exchange(
                audit,
                fullmag::fem::TransferAuditScopeKind::ExchangeInterop);
            fullmag::fem::record_mfem_host_write(24);
            fullmag::fem::record_mfem_host_read_write(32);
        }

        fullmag::fem::record_mfem_host_write(8);
    }

    check(audit.counters.hot_loop_host_sync_count == 4, "total hot-loop sync count mismatch");
    check(audit.counters.hot_loop_compute_host_sync_count == 2, "compute sync count mismatch");
    check(audit.counters.hot_loop_exchange_host_sync_count == 2, "exchange sync count mismatch");
    check(audit.counters.hot_loop_compute_d2h_bytes == 16, "compute D2H byte count mismatch");
    check(audit.counters.hot_loop_compute_h2d_bytes == 8, "compute H2D byte count mismatch");
    check(audit.counters.hot_loop_exchange_d2h_bytes == 32, "exchange D2H byte count mismatch");
    check(audit.counters.hot_loop_exchange_h2d_bytes == 56, "exchange H2D byte count mismatch");

    fullmag::fem::TransferAudit control_scalar_audit;
    control_scalar_audit.assert_no_hot_loop_compute_sync = true;
    {
        fullmag::fem::TransferAuditScope hot_loop(
            control_scalar_audit,
            fullmag::fem::TransferAuditScopeKind::HotLoop);
        fullmag::fem::record_device_control_scalar_to_host(control_scalar_audit, 40);
    }
    check(
        control_scalar_audit.counters.d2h_bytes == 40,
        "control-scalar readback must count total D2H bytes");
    check(
        control_scalar_audit.counters.hot_loop_d2h_bytes == 40,
        "control-scalar readback must count total hot-loop D2H bytes");
    check(
        control_scalar_audit.counters.hot_loop_host_sync_count == 1,
        "control-scalar readback must count total hot-loop sync");
    check(
        control_scalar_audit.counters.hot_loop_control_scalar_d2h_bytes == 40,
        "control-scalar D2H byte counter mismatch");
    check(
        control_scalar_audit.counters.hot_loop_control_scalar_host_sync_count == 1,
        "control-scalar sync counter mismatch");
    check(
        control_scalar_audit.counters.hot_loop_compute_d2h_bytes == 0,
        "control-scalar readback must not count as compute D2H");
    check(
        control_scalar_audit.counters.hot_loop_compute_host_sync_count == 0,
        "control-scalar readback must not count as compute sync");
    check(
        !control_scalar_audit.hot_loop_violation,
        "control-scalar readback must not violate compute hot-loop gate");

    fullmag::fem::record_mfem_host_read(64);
    check(audit.counters.hot_loop_host_sync_count == 4, "host access outside scope counted as hot-loop");
    const fullmag_fem_transfer_audit snapshot =
        fullmag::fem::transfer_audit_snapshot(audit);
    check(snapshot.d2h_bytes == audit.counters.d2h_bytes, "snapshot d2h bytes");
    check(snapshot.h2d_bytes == audit.counters.h2d_bytes, "snapshot h2d bytes");
    check(
        snapshot.hot_loop_host_sync_count == audit.counters.hot_loop_host_sync_count,
        "snapshot hot-loop sync count");

    fullmag::fem::TransferAudit compute_gate_audit;
    compute_gate_audit.assert_no_hot_loop_compute_sync = true;
    {
        fullmag::fem::TransferAuditScope hot_loop(
            compute_gate_audit,
            fullmag::fem::TransferAuditScopeKind::HotLoop);
        {
            fullmag::fem::TransferAuditScope exchange(
                compute_gate_audit,
                fullmag::fem::TransferAuditScopeKind::ExchangeInterop);
            fullmag::fem::record_mfem_host_write(24);
        }
        check(
            !compute_gate_audit.hot_loop_violation,
            "exchange interop should not violate compute hot-loop gate");

        fullmag::fem::record_mfem_host_read(16);
        check(
            compute_gate_audit.hot_loop_violation,
            "compute host sync should violate compute hot-loop gate");
        check(
            compute_gate_audit.hot_loop_violation_message.find(
                "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1") != std::string::npos,
            "compute hot-loop gate violation message mismatch");
    }

    std::printf("FEM transfer_audit smoke PASS\n");
    return 0;
}
