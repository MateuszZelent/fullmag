#include "fullmag_fdm.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string_view>
#include <vector>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

template <std::size_t N>
void version(char (&target)[N], std::string_view value) {
    check(value.size() + 1 <= N, "version string must fit ABI field");
    std::memset(target, 0, N);
    std::memcpy(target, value.data(), value.size());
}

void abi_headers_and_enums_are_versioned() {
    static_assert(offsetof(fullmag_fdm_cpu_charge_request_v1, abi_version) == 0);
    static_assert(offsetof(fullmag_fdm_cpu_charge_result_v1, abi_version) == 0);
    static_assert(offsetof(fullmag_fdm_cpu_steady_spin_request_v1, abi_version) == 0);
    static_assert(offsetof(fullmag_fdm_cpu_steady_spin_result_v1, abi_version) == 0);
    static_assert(FULLMAG_FDM_CPU_TRANSPORT_ABI_V1 == 1);
    static_assert(FULLMAG_FDM_CPU_CHARGE_BC_SPECIFIED_OUTWARD_CURRENT_DENSITY == 4);
    static_assert(FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2 == 1);
    check(fullmag_fdm_cpu_transport_is_available_v1() == 1,
          "CPU transport availability must be independent of CUDA availability");
    check(fullmag_fdm_cpu_transport_abi_layout_manifest_get_v1() != nullptr,
          "CPU transport ABI must export a canonical layout manifest");
}

template <typename Result>
struct GuardedResult {
    alignas(Result) std::array<std::uint8_t, sizeof(Result) + 32> bytes{};

    Result *get() noexcept {
        return reinterpret_cast<Result *>(bytes.data());
    }
};

template <typename Result>
void initialize_undersized_result(GuardedResult<Result> &guard,
                                  std::uint32_t declared_size) {
    guard.bytes.fill(0xa5);
    Result *result = guard.get();
    result->abi_version = FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
    result->struct_size = declared_size;
    result->reserved_flags = 0;
}

template <typename Result>
void check_tail_unchanged(const GuardedResult<Result> &guard,
                          const GuardedResult<Result> &before,
                          std::size_t declared_size,
                          const char *message) {
    check(std::equal(guard.bytes.begin() + static_cast<std::ptrdiff_t>(declared_size),
                     guard.bytes.end(),
                     before.bytes.begin() + static_cast<std::ptrdiff_t>(declared_size)),
          message);
}

void undersized_results_never_write_beyond_declared_size() {
    constexpr std::array<std::uint32_t, 6> charge_declared_sizes{
        0,
        4,
        8,
        16,
        static_cast<std::uint32_t>(offsetof(fullmag_fdm_cpu_charge_result_v1, status)),
        static_cast<std::uint32_t>(
            offsetof(fullmag_fdm_cpu_charge_result_v1, error_message)),
    };
    for (const auto declared : charge_declared_sizes) {
        GuardedResult<fullmag_fdm_cpu_charge_result_v1> guard;
        initialize_undersized_result(guard, declared);
        const auto before = guard;
        check(fullmag_fdm_cpu_charge_solve_v1(nullptr, guard.get()) ==
                  FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
              "every undersized charge result must fail at the ABI boundary");
        check_tail_unchanged(guard, before, declared,
                             "charge failure wrote beyond result.struct_size");
        if (declared >= offsetof(fullmag_fdm_cpu_charge_result_v1, status) +
                            sizeof(std::int32_t)) {
            check(guard.get()->status == FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
                  "available undersized charge status field must carry ERR_ABI");
        }
    }

    constexpr std::array<std::uint32_t, 6> spin_declared_sizes{
        0,
        4,
        8,
        16,
        static_cast<std::uint32_t>(
            offsetof(fullmag_fdm_cpu_steady_spin_result_v1, status)),
        static_cast<std::uint32_t>(
            offsetof(fullmag_fdm_cpu_steady_spin_result_v1, error_message)),
    };
    for (const auto declared : spin_declared_sizes) {
        GuardedResult<fullmag_fdm_cpu_steady_spin_result_v1> guard;
        initialize_undersized_result(guard, declared);
        const auto before = guard;
        check(fullmag_fdm_cpu_steady_spin_solve_v1(nullptr, nullptr, guard.get()) ==
                  FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
              "every undersized spin result must fail at the ABI boundary");
        check_tail_unchanged(guard, before, declared,
                             "spin failure wrote beyond result.struct_size");
        if (declared >= offsetof(fullmag_fdm_cpu_steady_spin_result_v1, status) +
                            sizeof(std::int32_t)) {
            check(guard.get()->status == FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
                  "available undersized spin status field must carry ERR_ABI");
        }
    }

    {
        GuardedResult<fullmag_fdm_cpu_charge_result_v1> guard;
        const auto declared = static_cast<std::uint32_t>(
            offsetof(fullmag_fdm_cpu_charge_result_v1, status) + sizeof(std::int32_t));
        initialize_undersized_result(guard, declared);
        const auto before = guard;
        check(fullmag_fdm_cpu_charge_solve_v1(nullptr, guard.get()) ==
                  FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
              "undersized charge result must fail at the ABI boundary");
        check(guard.get()->status == FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
              "available undersized charge status field must carry ERR_ABI");
        check_tail_unchanged(guard, before, declared,
                             "charge failure wrote beyond result.struct_size");
    }
    {
        GuardedResult<fullmag_fdm_cpu_steady_spin_result_v1> guard;
        const auto declared = static_cast<std::uint32_t>(
            offsetof(fullmag_fdm_cpu_steady_spin_result_v1, status) + sizeof(std::int32_t));
        initialize_undersized_result(guard, declared);
        const auto before = guard;
        check(fullmag_fdm_cpu_steady_spin_solve_v1(nullptr, nullptr, guard.get()) ==
                  FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
              "undersized spin result must fail at the ABI boundary");
        check(guard.get()->status == FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
              "available undersized spin status field must carry ERR_ABI");
        check_tail_unchanged(guard, before, declared,
                             "spin failure wrote beyond result.struct_size");
    }
    {
        GuardedResult<fullmag_fdm_cpu_charge_result_v1> guard;
        constexpr std::uint32_t declared =
            offsetof(fullmag_fdm_cpu_charge_result_v1, status);
        guard.bytes.fill(0);
        initialize_undersized_result(guard, declared);
        guard.get()->accepted_snapshot = nullptr;
        guard.get()->accepted_snapshot_identity = 0x1234;
        const auto before = guard;
        fullmag_fdm_cpu_charge_result_destroy_v1(guard.get());
        check_tail_unchanged(guard, before, declared,
                             "charge destroy wrote beyond result.struct_size");
    }
}

void undersized_charge_destroy_never_writes_beyond_declared_size() {
    constexpr std::array<std::uint32_t, 6> declared_sizes{
        0,
        4,
        8,
        16,
        static_cast<std::uint32_t>(offsetof(fullmag_fdm_cpu_charge_result_v1, status)),
        static_cast<std::uint32_t>(
            offsetof(fullmag_fdm_cpu_charge_result_v1, error_message)),
    };
    for (const auto declared : declared_sizes) {
        GuardedResult<fullmag_fdm_cpu_charge_result_v1> guard;
        initialize_undersized_result(guard, declared);
        guard.get()->accepted_snapshot = nullptr;
        guard.get()->accepted_snapshot_identity = 0x1234;
        const auto before = guard;
        fullmag_fdm_cpu_charge_result_destroy_v1(guard.get());
        check_tail_unchanged(guard, before, declared,
                             "charge destroy wrote beyond result.struct_size");
        const bool owner_available =
            declared >= offsetof(fullmag_fdm_cpu_charge_result_v1, accepted_snapshot) +
                            sizeof(guard.get()->accepted_snapshot);
        if (owner_available) {
            check(guard.get()->accepted_snapshot == nullptr &&
                      guard.get()->accepted_snapshot_identity == 0,
                  "available charge owner fields must be cleared by destroy");
        } else {
            check(guard.bytes == before.bytes,
                  "charge destroy must not mutate a result without its owner field");
        }
    }
}

fullmag_fdm_cpu_charge_request_v1 charge_request(
    std::array<double, 2> &conductivity,
    std::array<std::uint8_t, 2> &active,
    std::array<fullmag_fdm_cpu_specified_current_face_v1, 2> &density_faces) {
    fullmag_fdm_cpu_charge_request_v1 request{};
    request.abi_version = FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
    request.struct_size = sizeof(request);
    request.grid = {2, 1, 1, 2.0, 3.0, 5.0};
    request.device = FULLMAG_FDM_CPU_TRANSPORT_DEVICE_CPU;
    request.precision = FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F64;
    request.conductivity_s_per_m = conductivity.data();
    request.conductivity_len = conductivity.size();
    request.active_cells = active.data();
    request.active_cells_len = active.size();
    for (auto &boundary : request.boundaries) {
        boundary.kind = FULLMAG_FDM_CPU_CHARGE_BC_INSULATING;
    }
    request.boundaries[0].kind =
        FULLMAG_FDM_CPU_CHARGE_BC_SPECIFIED_OUTWARD_CURRENT_DENSITY;
    request.boundaries[1].kind =
        FULLMAG_FDM_CPU_CHARGE_BC_SPECIFIED_OUTWARD_CURRENT_DENSITY;
    density_faces = {{{0, -1, 0, 0, 15.0, -2.0},
                      {0, +1, 2, 1, 15.0, +2.0}}};
    request.specified_current_faces = density_faces.data();
    request.specified_current_face_count = density_faces.size();
    request.gauge = FULLMAG_FDM_CPU_CHARGE_GAUGE_ZERO_MEAN;
    request.relative_tolerance = 1.0e-12;
    request.absolute_tolerance_a_per_m3 = 1.0e-14;
    request.max_iterations = 1000;
    version(request.api_version, "fullmag.fdm.cpu.charge.v1");
    version(request.operator_version, "fv_charge_harmonic_v1");
    version(request.solver_version, "fdm_charge_cg_matrix_free_v1");
    version(request.residual_version, "charge_balance_integrated_l2.v1");
    return request;
}

void charge_and_spin_cross_the_real_owned_boundary() {
    std::array<double, 3> conductivity{2.0, 8.0, 4.0};
    std::array<std::uint8_t, 3> active{1, 1, 1};
    std::array<fullmag_fdm_cpu_specified_current_face_v1, 2> density_faces{};
    std::array<double, 2> initial_conductivity{};
    std::array<std::uint8_t, 2> initial_active{};
    auto request = charge_request(initial_conductivity, initial_active, density_faces);
    request.grid.nx = 3;
    request.conductivity_s_per_m = conductivity.data();
    request.conductivity_len = conductivity.size();
    request.active_cells = active.data();
    request.active_cells_len = active.size();
    density_faces[1].face_index = 3;
    density_faces[1].adjacent_cell = 2;
    std::array<fullmag_fdm_cpu_transport_interface_v1, 2> interfaces{};
    interfaces[0] = {101,
                     0,
                     FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2,
                     0,
                     1,
                     0,
                     1,
                     2.0,
                     3.0,
                     4.0,
                     0.5,
                     {0.0, 0.0, 1.0}};
    interfaces[1] = {202,
                     0,
                     FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2,
                     1,
                     2,
                     2,
                     1,
                     5.0,
                     6.0,
                     7.0,
                     -0.25,
                     {0.0, 0.0, 1.0}};
    request.interfaces = interfaces.data();
    request.interface_count = interfaces.size();

    std::vector<double> potential(3);
    std::vector<double> jc_x(4);
    std::vector<double> jc_y(6);
    std::vector<double> jc_z(6);
    std::vector<double> jc_cell(9);
    std::array<fullmag_fdm_cpu_charge_interface_observation_v1, 2>
        charge_interface_observations{};
    fullmag_fdm_cpu_charge_result_v1 charge{};
    charge.abi_version = FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
    charge.struct_size = sizeof(charge);
    charge.potential_v = {potential.data(), potential.size(), 0};
    charge.jc_x_a_per_m2 = {jc_x.data(), jc_x.size(), 0};
    charge.jc_y_a_per_m2 = {jc_y.data(), jc_y.size(), 0};
    charge.jc_z_a_per_m2 = {jc_z.data(), jc_z.size(), 0};
    charge.jc_cell_xyz_a_per_m2 = {jc_cell.data(), jc_cell.size(), 0};
    charge.interface_observations = {charge_interface_observations.data(),
                                     charge_interface_observations.size(),
                                     0};

    auto unsupported_charge = request;
    unsupported_charge.device = FULLMAG_FDM_CPU_TRANSPORT_DEVICE_GPU;
    check(fullmag_fdm_cpu_charge_solve_v1(&unsupported_charge, &charge) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED,
          "native M1 ABI must reject GPU without fallback");
    unsupported_charge = request;
    unsupported_charge.precision = FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F32;
    check(fullmag_fdm_cpu_charge_solve_v1(&unsupported_charge, &charge) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED,
          "native M1 ABI must reject single precision without fallback");

    auto excessive_charge = request;
    excessive_charge.specified_current_faces =
        reinterpret_cast<const fullmag_fdm_cpu_specified_current_face_v1 *>(1);
    excessive_charge.specified_current_face_count =
        std::numeric_limits<std::uint64_t>::max();
    check(fullmag_fdm_cpu_charge_solve_v1(&excessive_charge, &charge) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
          "charge must reject an excessive specified-face extent before dereference");
    excessive_charge = request;
    excessive_charge.interfaces =
        reinterpret_cast<const fullmag_fdm_cpu_transport_interface_v1 *>(1);
    excessive_charge.interface_count = std::numeric_limits<std::uint64_t>::max();
    check(fullmag_fdm_cpu_charge_solve_v1(&excessive_charge, &charge) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
          "charge must reject an excessive interface extent before dereference");

    check(fullmag_fdm_cpu_charge_solve_v1(&request, &charge) ==
              FULLMAG_FDM_CPU_TRANSPORT_OK,
          charge.error_message);
    check(charge.status == FULLMAG_FDM_CPU_TRANSPORT_OK,
          "charge result status must match return status");
    check(charge.accepted_snapshot != nullptr,
          "successful charge solve must own an accepted snapshot for spin");
    check(charge.potential_v.length == 3 && charge.jc_x_a_per_m2.length == 4 &&
              charge.jc_cell_xyz_a_per_m2.length == 9 &&
              charge.interface_observations.length == 2,
          "charge output lengths must be exact");
    check(jc_x[0] == 2.0 && jc_x[3] == 2.0,
          "ABI must preserve outward-density signs on exact x faces");
    check(jc_cell[0] == 2.0 && jc_cell[3] == 2.0 && jc_cell[6] == 2.0,
          "cell-current reconstruction must be native and exact for the bar");
    check(charge.boundary_outward_current_a[0] == -30.0 &&
              charge.boundary_outward_current_a[1] == 30.0,
          "area may enter diagnostics but not change local density");
    check(std::string_view(charge.operator_version) == "fv_charge_harmonic_v1",
          "charge provenance must cross ABI exactly");

    std::array<double, 3> sigma_spin{4.0, 4.0, 4.0};
    std::array<double, 3> polarization{0.2, 0.2, 0.2};
    std::array<double, 3> theta_sh{0.1, 0.1, 0.1};
    std::array<double, 9> magnetization{
        0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0};
    std::array<fullmag_fdm_cpu_spin_reaction_lengths_v1, 3> reactions{
        {{1.0, 0.0, 0.0}, {1.0, 0.0, 0.0}, {1.0, 0.0, 0.0}}};
    std::array<std::uint32_t, 3> regions{1, 1, 1};
    std::array<std::uint8_t, 3> torque_targets{1, 1, 1};
    std::array<double, 3> ms{8.0e5, 8.0e5, 8.0e5};
    fullmag_fdm_cpu_steady_spin_request_v1 spin_request{};
    spin_request.abi_version = FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
    spin_request.struct_size = sizeof(spin_request);
    spin_request.grid = request.grid;
    spin_request.device = FULLMAG_FDM_CPU_TRANSPORT_DEVICE_CPU;
    spin_request.precision = FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F64;
    spin_request.spin_conductivity_s_per_m = sigma_spin.data();
    spin_request.spin_conductivity_len = sigma_spin.size();
    spin_request.polarization = polarization.data();
    spin_request.polarization_len = polarization.size();
    spin_request.spin_hall_angle = theta_sh.data();
    spin_request.spin_hall_angle_len = theta_sh.size();
    spin_request.magnetization_xyz = magnetization.data();
    spin_request.magnetization_xyz_len = magnetization.size();
    spin_request.reactions = reactions.data();
    spin_request.reaction_count = reactions.size();
    spin_request.active_cells = active.data();
    spin_request.active_cells_len = active.size();
    spin_request.region_ids = regions.data();
    spin_request.region_id_count = regions.size();
    spin_request.interfaces = interfaces.data();
    spin_request.interface_count = interfaces.size();
    for (auto &boundary : spin_request.boundaries) {
        boundary.kind = FULLMAG_FDM_CPU_SPIN_BC_SINK;
    }
    spin_request.torque_target_cells = torque_targets.data();
    spin_request.torque_target_cells_len = torque_targets.size();
    spin_request.saturation_magnetization_a_per_m = ms.data();
    spin_request.saturation_magnetization_len = ms.size();
    spin_request.gamma_e_rad_per_s_t = 1.760859e11;
    spin_request.relative_tolerance = 1.0e-10;
    spin_request.absolute_tolerance_a = 1.0e-18;
    spin_request.local_relative_tolerance = 1.0e-10;
    spin_request.local_absolute_tolerance_a_per_m3 = 1.0e-6;
    spin_request.max_iterations = 1000;
    spin_request.gmres_restart = 20;
    version(spin_request.api_version, "fullmag.fdm.cpu.steady_spin.v1");
    version(spin_request.formula_version,
            "transport_constitutive.one_way.fullmag.v1");
    version(spin_request.operator_version, "fv_spin_upwind_v1");
    version(spin_request.electric_reconstruction_version,
            "fdm_exact_face_current_electric_reconstruction.v1");
    version(spin_request.solver_version,
            "fdm_spin_block_gmres_matrix_free_reference_v1");
    version(spin_request.residual_version, "transport_balance_integrated_l2.v1");
    version(spin_request.local_residual_version, "transport_balance_local_fv.v1");
    version(spin_request.interface_version, "magnetoelectronic.fullmag.v2");
    version(spin_request.torque_operator_version,
            "fdm_transport_torque_cell_surface_balance.v1");

    std::vector<double> mu(9);
    std::vector<double> qx(12);
    std::vector<double> qy(18);
    std::vector<double> qz(18);
    std::vector<double> qcell(27);
    std::vector<double> reaction_sf(9), reaction_exchange(9), reaction_dephasing(9),
        reaction_total(9), torque(9);
    std::array<fullmag_fdm_cpu_spin_interface_observation_v1, 2>
        spin_interface_observations{};
    fullmag_fdm_cpu_steady_spin_result_v1 spin{};
    spin.abi_version = FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
    spin.struct_size = sizeof(spin);
    spin.spin_potential_xyz_v = {mu.data(), mu.size(), 0};
    spin.q_x_xyz_a_per_m2 = {qx.data(), qx.size(), 0};
    spin.q_y_xyz_a_per_m2 = {qy.data(), qy.size(), 0};
    spin.q_z_xyz_a_per_m2 = {qz.data(), qz.size(), 0};
    spin.q_cell_ia_a_per_m2 = {qcell.data(), qcell.size(), 0};
    spin.reaction_spin_flip_xyz_a_per_m3 = {reaction_sf.data(), reaction_sf.size(), 0};
    spin.reaction_exchange_xyz_a_per_m3 = {
        reaction_exchange.data(), reaction_exchange.size(), 0};
    spin.reaction_dephasing_xyz_a_per_m3 = {
        reaction_dephasing.data(), reaction_dephasing.size(), 0};
    spin.reaction_total_xyz_a_per_m3 = {reaction_total.data(), reaction_total.size(), 0};
    spin.transport_torque_xyz_per_s = {torque.data(), torque.size(), 0};
    spin.interface_observations = {spin_interface_observations.data(),
                                   spin_interface_observations.size(),
                                   0};

    auto unsupported_spin = spin_request;
    unsupported_spin.boundaries[0].kind = FULLMAG_FDM_CPU_SPIN_BC_PERIODIC;
    check(fullmag_fdm_cpu_steady_spin_solve_v1(&unsupported_spin, &charge, &spin) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED,
          "native M1 ABI must reject periodic spin boundaries without fallback");

    fullmag_fdm_cpu_transport_interface_v1 sml_interface{};
    sml_interface.kind = FULLMAG_FDM_CPU_SPIN_INTERFACE_SML_RESERVOIR_V2;
    unsupported_spin = spin_request;
    unsupported_spin.interfaces = &sml_interface;
    unsupported_spin.interface_count = 1;
    check(fullmag_fdm_cpu_steady_spin_solve_v1(&unsupported_spin, &charge, &spin) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED,
          "native M1 ABI must reject SML without degrading the interface law");

    auto excessive_spin = spin_request;
    excessive_spin.reactions =
        reinterpret_cast<const fullmag_fdm_cpu_spin_reaction_lengths_v1 *>(1);
    excessive_spin.reaction_count = std::numeric_limits<std::uint64_t>::max();
    check(fullmag_fdm_cpu_steady_spin_solve_v1(&excessive_spin, &charge, &spin) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
          "spin must reject an excessive reaction extent before dereference");
    excessive_spin = spin_request;
    excessive_spin.interfaces =
        reinterpret_cast<const fullmag_fdm_cpu_transport_interface_v1 *>(1);
    excessive_spin.interface_count = std::numeric_limits<std::uint64_t>::max();
    check(fullmag_fdm_cpu_steady_spin_solve_v1(&excessive_spin, &charge, &spin) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
          "spin must reject an excessive interface extent before dereference");

    const auto expect_identity_rejection = [&](const auto &mutated_interfaces,
                                               std::size_t count,
                                               const char *message) {
        auto mutated = spin_request;
        mutated.interfaces = mutated_interfaces.data();
        mutated.interface_count = count;
        check(fullmag_fdm_cpu_steady_spin_solve_v1(&mutated, &charge, &spin) ==
                  FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
              message);
    };
    const auto accepted_identity = charge.accepted_snapshot_identity;
    charge.accepted_snapshot_identity ^= 1;
    check(fullmag_fdm_cpu_steady_spin_solve_v1(&spin_request, &charge, &spin) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
          "spin must reject a mutated public accepted snapshot identity");
    charge.accepted_snapshot_identity = accepted_identity;

    auto mutated = interfaces;
    mutated[0].interface_id += 1;
    expect_identity_rejection(mutated, mutated.size(), "spin must reject mutated interface id");
    mutated = interfaces;
    mutated[0].axis = 1;
    expect_identity_rejection(mutated, mutated.size(), "spin must reject mutated face axis");
    mutated = interfaces;
    mutated[0].negative_cell = 2;
    expect_identity_rejection(mutated, mutated.size(), "spin must reject mutated negative cell");
    mutated = interfaces;
    mutated[0].positive_cell = 2;
    expect_identity_rejection(mutated, mutated.size(), "spin must reject mutated positive cell");
    mutated = interfaces;
    mutated[0].from_cell = 1;
    expect_identity_rejection(mutated, mutated.size(), "spin must reject mutated from cell");
    mutated = interfaces;
    mutated[0].to_cell = 2;
    expect_identity_rejection(mutated, mutated.size(), "spin must reject mutated to cell");
    mutated = interfaces;
    mutated[0].g_up_s_per_m2 += 1.0;
    expect_identity_rejection(mutated, mutated.size(), "spin must reject mutated G_up");
    mutated = interfaces;
    mutated[0].g_down_s_per_m2 += 1.0;
    expect_identity_rejection(mutated, mutated.size(), "spin must reject mutated G_down");
    mutated = interfaces;
    std::swap(mutated[0], mutated[1]);
    auto reordered_request = spin_request;
    reordered_request.interfaces = mutated.data();
    check(fullmag_fdm_cpu_steady_spin_solve_v1(&reordered_request, &charge, &spin) ==
              FULLMAG_FDM_CPU_TRANSPORT_OK,
          "spin must match accepted interfaces independently of request order");
    check(spin_interface_observations[0].interface_id == mutated[0].interface_id &&
              spin_interface_observations[0].from_cell == mutated[0].from_cell &&
              spin_interface_observations[0].to_cell == mutated[0].to_cell &&
              spin_interface_observations[1].interface_id == mutated[1].interface_id &&
              spin_interface_observations[1].from_cell == mutated[1].from_cell &&
              spin_interface_observations[1].to_cell == mutated[1].to_cell,
          "spin observations must be published in request order with exact topology");
    mutated = interfaces;
    mutated[1] = mutated[0];
    expect_identity_rejection(mutated, mutated.size(), "spin must reject duplicate interfaces");
    expect_identity_rejection(interfaces, 1, "spin must reject a missing accepted interface");
    std::array<fullmag_fdm_cpu_transport_interface_v1, 3> extra{
        interfaces[0], interfaces[1], interfaces[1]};
    extra[2].interface_id = 303;
    expect_identity_rejection(extra, extra.size(), "spin must reject an extra mixing interface");

    check(fullmag_fdm_cpu_steady_spin_solve_v1(&spin_request, &charge, &spin) ==
              FULLMAG_FDM_CPU_TRANSPORT_OK,
          spin.error_message);
    check(spin.spin_potential_xyz_v.length == 9 && spin.q_cell_ia_a_per_m2.length == 27 &&
              spin.interface_observations.length == 2,
          "spin ABI output lengths must be exact");
    check(std::string_view(spin.formula_version) ==
              "transport_constitutive.one_way.fullmag.v1",
          "spin provenance must cross ABI exactly");
    for (double value : mu) {
        check(std::isfinite(value), "spin ABI must reject rather than publish non-finite output");
    }
    fullmag_fdm_cpu_charge_result_destroy_v1(&charge);
    check(charge.accepted_snapshot == nullptr,
          "owned charge snapshot destroy must clear the handle");
    fullmag_fdm_cpu_charge_result_destroy_v1(&charge);
    check(charge.accepted_snapshot == nullptr && charge.accepted_snapshot_identity == 0,
          "repeated charge snapshot destroy must be idempotent");
}

void charge_result_destroy_accepts_an_empty_result() {
    fullmag_fdm_cpu_charge_result_v1 result{};
    result.abi_version = FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
    result.struct_size = sizeof(result);
    fullmag_fdm_cpu_charge_result_destroy_v1(&result);
    check(result.accepted_snapshot == nullptr && result.accepted_snapshot_identity == 0,
          "empty charge result destroy must leave the owner empty");
}

void boundary_errors_are_stable_and_do_not_throw() {
    fullmag_fdm_cpu_charge_result_v1 result{};
    result.abi_version = FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
    result.struct_size = sizeof(result);
    check(fullmag_fdm_cpu_charge_solve_v1(nullptr, &result) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_NULL,
          "null request must return a stable ABI status");
    check(result.error_message[0] != '\0', "ABI failure must publish a bounded message");

    fullmag_fdm_cpu_charge_request_v1 request{};
    request.abi_version = 99;
    request.struct_size = sizeof(request);
    check(fullmag_fdm_cpu_charge_solve_v1(&request, &result) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI,
          "unknown ABI version must fail before data dereference");
}

void oversized_component_counts_fail_before_input_pointer_access() {
    fullmag_fdm_cpu_charge_request_v1 request{};
    request.abi_version = FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
    request.struct_size = sizeof(request);
    const auto oversized =
        static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max() / 3 + 1);
    request.grid = {oversized, 1, 1, 1.0, 1.0, 1.0};
    request.device = FULLMAG_FDM_CPU_TRANSPORT_DEVICE_CPU;
    request.precision = FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F64;
    request.conductivity_s_per_m = reinterpret_cast<const double *>(1);
    request.conductivity_len = oversized;
    request.active_cells = reinterpret_cast<const std::uint8_t *>(1);
    request.active_cells_len = oversized;
    request.gauge = FULLMAG_FDM_CPU_CHARGE_GAUGE_ZERO_MEAN;
    request.max_iterations = 1;
    version(request.api_version, "fullmag.fdm.cpu.charge.v1");
    version(request.operator_version, "fv_charge_harmonic_v1");
    version(request.solver_version, "fdm_charge_cg_matrix_free_v1");
    version(request.residual_version, "charge_balance_integrated_l2.v1");

    fullmag_fdm_cpu_charge_result_v1 result{};
    result.abi_version = FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
    result.struct_size = sizeof(result);
    check(fullmag_fdm_cpu_charge_solve_v1(&request, &result) ==
              FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID,
          "component-count overflow must fail before input pointer access or allocation");
}

} // namespace

int main() {
    abi_headers_and_enums_are_versioned();
    undersized_results_never_write_beyond_declared_size();
    undersized_charge_destroy_never_writes_beyond_declared_size();
    boundary_errors_are_stable_and_do_not_throw();
    oversized_component_counts_fail_before_input_pointer_access();
    charge_result_destroy_accepts_an_empty_result();
    charge_and_spin_cross_the_real_owned_boundary();
    std::puts("FDM CPU M1 transport C ABI v1 contract: PASS");
    return 0;
}
