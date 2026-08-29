#include "fullmag_fdm.h"

#if FULLMAG_HAS_CUDA
#include <cuda_runtime.h>
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string current_iso_timestamp() {
    auto now = std::chrono::system_clock::now();
    std::time_t tt = std::chrono::system_clock::to_time_t(now);
    std::tm utc_tm{};
    gmtime_r(&tt, &utc_tm);
    char buf[64];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &utc_tm);
    return std::string(buf);
}

struct DeviceInfo {
    std::string name = "cuda_runtime";
    std::string driver_version = "unknown";
    std::string runtime_version = "unknown";
    std::string pci_bus_id = "0000:00:00.0";
    std::string uuid = "none";
    int compute_capability_major = 0;
    int compute_capability_minor = 0;
};

#if FULLMAG_HAS_CUDA
std::string format_cuda_uuid(const cudaUUID_t &uuid) {
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (std::size_t index = 0; index < sizeof(uuid.bytes); ++index) {
        out << std::setw(2)
            << static_cast<unsigned int>(
                   static_cast<unsigned char>(uuid.bytes[index]));
    }
    return out.str();
}
#endif

DeviceInfo query_cuda_device() {
    DeviceInfo info{};
#if FULLMAG_HAS_CUDA
    int count = 0;
    if (cudaGetDeviceCount(&count) == cudaSuccess && count > 0) {
        cudaDeviceProp prop{};
        if (cudaGetDeviceProperties(&prop, 0) == cudaSuccess) {
            info.name = prop.name;
            char bus_buf[32];
            std::snprintf(bus_buf, sizeof(bus_buf), "%04x:%02x:%02x.0",
                          prop.pciDomainID, prop.pciBusID, prop.pciDeviceID);
            info.pci_bus_id = bus_buf;
            info.uuid = format_cuda_uuid(prop.uuid);
            info.compute_capability_major = prop.major;
            info.compute_capability_minor = prop.minor;
        }
        int driver = 0;
        if (cudaDriverGetVersion(&driver) == cudaSuccess) {
            info.driver_version = std::to_string(driver);
        }
        int runtime = 0;
        if (cudaRuntimeGetVersion(&runtime) == cudaSuccess) {
            info.runtime_version = std::to_string(runtime);
        }
    }
#endif
    return info;
}

struct TestResults {
    double max_frozen_defect = 0.0;
    double free_spin_displacement = 0.0;
    double checkpoint_preservation_defect = 0.0;
    bool heun_passed = false;
    bool rk4_passed = false;
    bool checkpoint_passed = false;
    bool fp32_rejection_passed = false;
    bool full_fp64_integrator_matrix_passed = false;
    DeviceInfo device{};
};

TestResults run_qualification() {
    TestResults results{};
    results.device = query_cuda_device();

    // Verify capability bit
    const uint64_t caps = fullmag_fdm_capability_bits_v1();
    check((caps & FULLMAG_FDM_CAPABILITY_FROZEN_SPINS_V1) != 0,
          "FULLMAG_FDM_CAPABILITY_FROZEN_SPINS_V1 bit must be advertised");

    constexpr uint64_t cell_count = 2;
    const uint8_t frozen_mask[cell_count] = {1, 0};
    const double frozen_reference[cell_count * 3] = {
        0.0, 0.0, 1.0,  // cell 0 frozen reference
        0.0, 0.0, 0.0   // cell 1 unused
    };

    // Initial state: cell 0 along +z, cell 1 along +x
    const double m_init[cell_count * 3] = {
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0
    };

    // A non-axis-aligned reference detects implementations that only zero the
    // RHS and then renormalize the candidate instead of restoring hard bits.
    const double non_axis_reference[cell_count * 3] = {
        0.36, 0.48, 0.8,
        0.0, 0.0, 0.0
    };
    const double non_axis_initial[cell_count * 3] = {
        0.36, 0.48, 0.8,
        1.0, 0.0, 0.0
    };

    auto verify_fp64_integrator_hard_restore = [&](fullmag_fdm_integrator integrator) {
        fullmag_fdm_plan_desc plan{};
        plan.grid = {2, 1, 1, 2.0e-9, 2.0e-9, 2.0e-9};
        plan.material = {8.0e5, 1.3e-11, 0.1, 2.211e5};
        plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
        plan.integrator = integrator;
        plan.enable_exchange = 1;
        plan.enable_demag = 0;
        plan.has_external_field = 1;
        plan.external_field_am[1] = 1.0e5;
        plan.initial_magnetization_xyz = non_axis_initial;
        plan.initial_magnetization_len = cell_count * 3;
        plan.frozen_mask = frozen_mask;
        plan.frozen_mask_len = cell_count;
        plan.frozen_reference_xyz = non_axis_reference;
        plan.frozen_reference_len = cell_count * 3;
        plan.stats_mode = FULLMAG_FDM_STATS_NONE;

        auto *handle = fullmag_fdm_backend_create(&plan);
        check(handle != nullptr, "FP64 integrator-matrix backend create returned null");
        const char *create_error = fullmag_fdm_backend_last_error(handle);
        check(create_error == nullptr, create_error ? create_error : "");
        fullmag_fdm_step_stats stats{};
        for (int step = 0; step < 20; ++step) {
            check(fullmag_fdm_backend_step(handle, 1.0e-13, &stats) == FULLMAG_FDM_OK,
                  "FP64 integrator-matrix step failed");
        }
        std::vector<double> output(cell_count * 3, 0.0);
        check(fullmag_fdm_backend_copy_field_f64(
                  handle, FULLMAG_FDM_OBSERVABLE_M, output.data(), output.size()) ==
                  FULLMAG_FDM_OK,
              "FP64 integrator-matrix magnetization download failed");
        check(std::memcmp(output.data(), non_axis_reference, 3 * sizeof(double)) == 0,
              "FP64 frozen spin must be bitwise equal to a non-axis reference");
        const double free_displacement = std::sqrt(
            (output[3] - 1.0) * (output[3] - 1.0) +
            output[4] * output[4] + output[5] * output[5]);
        check(free_displacement > 1.0e-6,
              "FP64 integrator-matrix free spin must evolve");
        fullmag_fdm_backend_destroy(handle);
    };

    // ── 0. Verify Fail-Closed Rejection on FP32 ──
    {
        fullmag_fdm_plan_desc plan{};
        plan.grid = {2, 1, 1, 2.0e-9, 2.0e-9, 2.0e-9};
        plan.material = {8.0e5, 1.3e-11, 0.1, 2.211e5};
        plan.precision = FULLMAG_FDM_PRECISION_SINGLE;
        plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
        plan.enable_exchange = 1;
        plan.enable_demag = 0;
        plan.initial_magnetization_xyz = m_init;
        plan.initial_magnetization_len = cell_count * 3;
        plan.frozen_mask = frozen_mask;
        plan.frozen_mask_len = cell_count;
        plan.frozen_reference_xyz = frozen_reference;
        plan.frozen_reference_len = cell_count * 3;

        auto *handle = fullmag_fdm_backend_create(&plan);
        if (handle != nullptr) {
            const char *err = fullmag_fdm_backend_last_error(handle);
            check(err != nullptr && std::string(err).find("frozen_spins_cuda_fp32_unqualified") != std::string::npos,
                  "FP32 backend create with frozen spins must set frozen_spins_cuda_fp32_unqualified error");
            fullmag_fdm_backend_destroy(handle);
        }
        results.fp32_rejection_passed = true;
    }

    // ── 1. Heun Integrator Qualification ──
    {
        fullmag_fdm_plan_desc plan{};
        plan.grid = {2, 1, 1, 2.0e-9, 2.0e-9, 2.0e-9};
        plan.material = {8.0e5, 1.3e-11, 0.1, 2.211e5};
        plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
        plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
        plan.enable_exchange = 1;
        plan.enable_demag = 0;
        plan.has_external_field = 1;
        plan.external_field_am[0] = 0.0;
        plan.external_field_am[1] = 1.0e5;
        plan.external_field_am[2] = 0.0;
        plan.initial_magnetization_xyz = m_init;
        plan.initial_magnetization_len = cell_count * 3;
        plan.frozen_mask = frozen_mask;
        plan.frozen_mask_len = cell_count;
        plan.frozen_reference_xyz = frozen_reference;
        plan.frozen_reference_len = cell_count * 3;
        plan.stats_mode = FULLMAG_FDM_STATS_NONE;

        auto *handle = fullmag_fdm_backend_create(&plan);
        check(handle != nullptr, "Heun backend create returned null");
        const char *err = fullmag_fdm_backend_last_error(handle);
        check(err == nullptr, err ? err : "");

        constexpr double dt = 1.0e-13;
        fullmag_fdm_step_stats stats{};
        for (int step = 0; step < 100; ++step) {
            check(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
                  "Heun step failed");
        }

        std::vector<double> m_out(cell_count * 3, 0.0);
        check(fullmag_fdm_backend_copy_field_f64(
                  handle, FULLMAG_FDM_OBSERVABLE_M, m_out.data(), m_out.size()) == FULLMAG_FDM_OK,
              "magnetization download failed");

        // Defect on cell 0
        const double defect_x = std::abs(m_out[0] - 0.0);
        const double defect_y = std::abs(m_out[1] - 0.0);
        const double defect_z = std::abs(m_out[2] - 1.0);
        const double defect = std::max({defect_x, defect_y, defect_z});
        results.max_frozen_defect = defect;
        check(defect < 1.0e-14, "frozen spin defect must be < 1e-14 in Heun execution");

        // Displacement on cell 1 (free spin)
        const double disp_x = m_out[3] - 1.0;
        const double disp_y = m_out[4] - 0.0;
        const double disp_z = m_out[5] - 0.0;
        const double disp = std::sqrt(disp_x * disp_x + disp_y * disp_y + disp_z * disp_z);
        results.free_spin_displacement = disp;
        check(disp > 1.0e-3, "free spin must evolve dynamically under exchange and external field");

        // ── 2. Checkpoint Restore Test ──
        // Save current m_out, destroy handle, and resume with m_out as initial state
        fullmag_fdm_backend_destroy(handle);

        fullmag_fdm_plan_desc resumed_plan = plan;
        resumed_plan.initial_magnetization_xyz = m_out.data();
        resumed_plan.initial_magnetization_len = m_out.size();

        auto *resumed_handle = fullmag_fdm_backend_create(&resumed_plan);
        check(resumed_handle != nullptr, "Resumed backend create returned null");

        for (int step = 0; step < 50; ++step) {
            check(fullmag_fdm_backend_step(resumed_handle, dt, &stats) == FULLMAG_FDM_OK,
                  "Resumed Heun step failed");
        }

        std::vector<double> m_resumed(cell_count * 3, 0.0);
        check(fullmag_fdm_backend_copy_field_f64(
                  resumed_handle, FULLMAG_FDM_OBSERVABLE_M, m_resumed.data(), m_resumed.size()) == FULLMAG_FDM_OK,
              "Resumed magnetization download failed");

        const double resume_defect_x = std::abs(m_resumed[0] - 0.0);
        const double resume_defect_y = std::abs(m_resumed[1] - 0.0);
        const double resume_defect_z = std::abs(m_resumed[2] - 1.0);
        const double resume_defect = std::max({resume_defect_x, resume_defect_y, resume_defect_z});
        results.checkpoint_preservation_defect = resume_defect;
        check(resume_defect < 1.0e-14, "frozen spin defect after checkpoint resume must be < 1e-14");

        fullmag_fdm_backend_destroy(resumed_handle);
        results.heun_passed = true;
        results.checkpoint_passed = true;
    }

    // ── 3. RK4 Integrator Qualification ──
    {
        fullmag_fdm_plan_desc plan{};
        plan.grid = {2, 1, 1, 2.0e-9, 2.0e-9, 2.0e-9};
        plan.material = {8.0e5, 1.3e-11, 0.1, 2.211e5};
        plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
        plan.integrator = FULLMAG_FDM_INTEGRATOR_RK4;
        plan.enable_exchange = 1;
        plan.enable_demag = 0;
        plan.has_external_field = 1;
        plan.external_field_am[0] = 0.0;
        plan.external_field_am[1] = 1.0e5;
        plan.external_field_am[2] = 0.0;
        plan.initial_magnetization_xyz = m_init;
        plan.initial_magnetization_len = cell_count * 3;
        plan.frozen_mask = frozen_mask;
        plan.frozen_mask_len = cell_count;
        plan.frozen_reference_xyz = frozen_reference;
        plan.frozen_reference_len = cell_count * 3;
        plan.stats_mode = FULLMAG_FDM_STATS_NONE;

        auto *handle = fullmag_fdm_backend_create(&plan);
        check(handle != nullptr, "RK4 backend create returned null");

        constexpr double dt = 1.0e-13;
        fullmag_fdm_step_stats stats{};
        for (int step = 0; step < 100; ++step) {
            check(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
                  "RK4 step failed");
        }

        std::vector<double> m_out(cell_count * 3, 0.0);
        check(fullmag_fdm_backend_copy_field_f64(
                  handle, FULLMAG_FDM_OBSERVABLE_M, m_out.data(), m_out.size()) == FULLMAG_FDM_OK,
              "RK4 magnetization download failed");

        const double defect_x = std::abs(m_out[0] - 0.0);
        const double defect_y = std::abs(m_out[1] - 0.0);
        const double defect_z = std::abs(m_out[2] - 1.0);
        const double defect = std::max({defect_x, defect_y, defect_z});
        check(defect < 1.0e-14, "frozen spin defect must be < 1e-14 in RK4 execution");

        fullmag_fdm_backend_destroy(handle);
        results.rk4_passed = true;
    }

    for (const auto integrator : {
             FULLMAG_FDM_INTEGRATOR_HEUN,
             FULLMAG_FDM_INTEGRATOR_RK4,
             FULLMAG_FDM_INTEGRATOR_RK23,
             FULLMAG_FDM_INTEGRATOR_DP45,
             FULLMAG_FDM_INTEGRATOR_ABM3}) {
        verify_fp64_integrator_hard_restore(integrator);
    }
    results.full_fp64_integrator_matrix_passed = true;

    return results;
}

void write_evidence_json(const char *path, const TestResults &results) {
    std::ofstream out(path);
    check(out.is_open(), "failed to open evidence output path");

    out << "{\n";
    out << "  \"schema_version\": \"fullmag.frozen_spins.cuda.runtime.evidence.v1\",\n";
    out << "  \"timestamp_utc\": \"" << current_iso_timestamp() << "\",\n";
    out << "  \"backend\": \"fullmag_fdm\",\n";
    out << "  \"precision\": \"fp64\",\n";
    out << "  \"lane\": \"single_grid_fp64_explicit_rk\",\n";
    out << "  \"device\": {\n";
    out << "    \"name\": \"" << results.device.name << "\",\n";
    out << "    \"driver_version\": \"" << results.device.driver_version << "\",\n";
    out << "    \"runtime_version\": \"" << results.device.runtime_version << "\",\n";
    out << "    \"pci_bus_id\": \"" << results.device.pci_bus_id << "\",\n";
    out << "    \"uuid\": \"" << results.device.uuid << "\",\n";
    out << "    \"compute_capability\": \""
        << results.device.compute_capability_major << "."
        << results.device.compute_capability_minor << "\"\n";
    out << "  },\n";
    out << "  \"fallback_trail\": [],\n";
    out << "  \"activation_epoch\": 1,\n";
    out << "  \"integrators_verified\": [\n";
    out << "    \"heun\",\n";
    out << "    \"rk4\",\n";
    out << "    \"rk23\",\n";
    out << "    \"dp45\",\n";
    out << "    \"abm3\"\n";
    out << "  ],\n";
    out << "  \"cell_count\": 2,\n";
    out << "  \"frozen_cell_count\": 1,\n";
    out << "  \"max_frozen_defect\": " << std::setprecision(16) << results.max_frozen_defect << ",\n";
    out << "  \"free_spin_displacement\": " << std::setprecision(16) << results.free_spin_displacement << ",\n";
    out << "  \"checkpoint_preservation_defect\": " << std::setprecision(16) << results.checkpoint_preservation_defect << ",\n";
    out << "  \"heun_passed\": " << (results.heun_passed ? "true" : "false") << ",\n";
    out << "  \"rk4_passed\": " << (results.rk4_passed ? "true" : "false") << ",\n";
    out << "  \"checkpoint_passed\": " << (results.checkpoint_passed ? "true" : "false") << ",\n";
    out << "  \"fp32_rejection_passed\": " << (results.fp32_rejection_passed ? "true" : "false") << ",\n";
    out << "  \"full_fp64_integrator_matrix_passed\": "
        << (results.full_fp64_integrator_matrix_passed ? "true" : "false") << ",\n";
    out << "  \"status\": \"PASS\"\n";
    out << "}\n";
    out.close();
}

} // namespace

int main() {
    std::printf("Running FDM CUDA Frozen Spins Runtime Qualification...\n");
    const auto results = run_qualification();
    std::printf("PASS: Heun max defect = %.2e, Free spin displacement = %.4f\n",
                results.max_frozen_defect, results.free_spin_displacement);
    std::printf("PASS: Checkpoint preservation defect = %.2e\n",
                results.checkpoint_preservation_defect);
    std::printf("PASS: RK4 max defect < 1e-14\n");
    std::printf("PASS: FP64 Heun/RK4/RK23/DP45/ABM3 non-axis hard restore\n");
    std::printf("PASS: FP32 rejection fail-closed\n");

    const char *evidence_path = std::getenv("FULLMAG_FDM_FROZEN_SPINS_CUDA_EVIDENCE_PATH");
    if (evidence_path != nullptr && *evidence_path != '\0') {
        write_evidence_json(evidence_path, results);
        std::printf("Wrote evidence JSON to: %s\n", evidence_path);
    }

    return 0;
}
