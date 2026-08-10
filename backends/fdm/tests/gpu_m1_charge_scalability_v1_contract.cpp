#include "fullmag/fdm/transport/gpu_abi_v1.h"

#include <cuda_runtime_api.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef FULLMAG_SOURCE_ROOT
#error "FULLMAG_SOURCE_ROOT must point at the repository root"
#endif
#ifndef FULLMAG_CXX_COMPILER
#define FULLMAG_CXX_COMPILER "unknown"
#endif
#ifndef FULLMAG_CUDA_COMPILER
#define FULLMAG_CUDA_COMPILER "unknown"
#endif
#ifndef FULLMAG_FMA_POLICY
#define FULLMAG_FMA_POLICY "unknown"
#endif

extern "C" uint32_t fullmag_fdm_gpu_transport_test_charge_audit_v1(
    fullmag_fdm_gpu_transport_context_handle_v1, uint64_t *, uint64_t *,
    uint64_t *, uint64_t *, uint64_t *, uint64_t *, uint32_t *, uint8_t[32]);

namespace {

constexpr uint64_t kCharge = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE;
constexpr uint64_t kReadback = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
constexpr double kH = 1.0e-9;
constexpr double kLeftVoltage = 1.0e-3;
constexpr double kBalanceTolerance = 1.0e-10;

struct Shape { uint64_t nx, ny, nz; };
struct Sample {
    std::string series;
    Shape shape{};
    uint64_t cells = 0, active_cells = 0, materials = 0, inactive_cells = 0;
    uint64_t finite_g_interfaces = 0, cold_iterations = 0, warm_iterations = 0;
    bool empty_interior_aggregate = false;
    uint64_t hierarchy_builds = 0, hierarchy_hits = 0, amg_applies = 0;
    uint64_t fine_unknowns = 0, coarse_unknowns = 0, host_fallbacks = 0;
    uint32_t hierarchy_levels = 0;
    double upload_seconds = 0.0, cold_seconds = 0.0, warm_seconds = 0.0;
    double algebraic_residual = 0.0, physical_residual = 0.0;
    double component_balance = 0.0, electrode_balance = 0.0;
    double readback_boundary_balance = 0.0, max_abs_v = 0.0, max_abs_j = 0.0;
    uint64_t required_peak_bytes = 0, cuda_free_bytes = 0, cuda_total_bytes = 0;
    uint64_t safety_reserve_bytes = 0, resolved_usable_bytes = 0;
    std::array<uint8_t, 32> hierarchy_digest{}, snapshot_digest{}, build_digest{};
};

template <typename T> void init(T &record, uint64_t features = 0) {
    std::memset(&record, 0, sizeof(record));
    record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    record.struct_version = 1;
    record.struct_size = sizeof(record);
    record.required_features = features;
}

void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

std::string hex(const uint8_t *bytes, size_t count) {
    constexpr char digits[] = "0123456789abcdef";
    std::string result;
    result.reserve(2 * count);
    for (size_t i = 0; i < count; ++i) {
        result.push_back(digits[bytes[i] >> 4]);
        result.push_back(digits[bytes[i] & 15]);
    }
    return result;
}

std::string json_string(const std::string &text) {
    std::ostringstream out;
    out << '"';
    for (const unsigned char c : text) {
        if (c == '"' || c == '\\') out << '\\' << static_cast<char>(c);
        else if (c == '\n') out << "\\n";
        else if (c >= 0x20) out << static_cast<char>(c);
    }
    out << '"';
    return out.str();
}

std::string git_commit() {
    const std::string command = "git -C \"" + std::string(FULLMAG_SOURCE_ROOT) +
                                "\" rev-parse HEAD 2>/dev/null";
    FILE *pipe = popen(command.c_str(), "r");
    require(pipe != nullptr, "git commit query failed");
    std::array<char, 128> buffer{};
    const char *line = std::fgets(buffer.data(), static_cast<int>(buffer.size()), pipe);
    const int status = pclose(pipe);
    require(line != nullptr && status == 0, "git commit identity is required");
    std::string commit(buffer.data());
    while (!commit.empty() && (commit.back() == '\n' || commit.back() == '\r'))
        commit.pop_back();
    require(commit.size() == 40, "git commit identity must be a full SHA-1");
    return commit;
}

std::string source_digest() {
    const std::string root = FULLMAG_SOURCE_ROOT;
    const std::string command =
        "sha256sum \"" + root + "/backends/fdm/gpu/cuda/transport/context.cu\" \"" +
        root + "/backends/fdm/gpu/cuda/transport/charge/device_solver.cu\" \"" +
        root + "/backends/fdm/gpu/cuda/transport/charge/device_solver.hpp\" \"" +
        root + "/backends/fdm/include/fullmag/fdm/transport/gpu_abi_v1.h\" \"" +
        root + "/backends/fdm/tests/gpu_m1_charge_scalability_v1_contract.cpp\""
        " | sha256sum 2>/dev/null";
    FILE *pipe = popen(command.c_str(), "r");
    require(pipe != nullptr, "source digest query failed");
    std::array<char, 128> buffer{};
    const char *line = std::fgets(buffer.data(), static_cast<int>(buffer.size()), pipe);
    const int status = pclose(pipe);
    require(line != nullptr && status == 0, "source digest identity is required");
    const std::string digest(buffer.data(), 64);
    require(digest.size() == 64 &&
                std::all_of(digest.begin(), digest.end(), [](unsigned char c) {
                    return std::isxdigit(c) != 0;
                }),
            "source digest must be SHA-256 hex");
    return digest;
}

double elapsed(std::chrono::steady_clock::time_point begin) {
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - begin).count();
}

uint64_t index(const Shape &s, uint64_t x, uint64_t y, uint64_t z) {
    return x + s.nx * (y + s.ny * z);
}

uint64_t x_face(const Shape &s, uint64_t plane, uint64_t y, uint64_t z) {
    return plane + (s.nx + 1) * (y + s.ny * z);
}

fullmag_fdm_gpu_transport_buffer_view_v1 view(
    const void *data, uint64_t count, uint64_t stride,
    uint32_t element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES,
    uint32_t component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR) {
    fullmag_fdm_gpu_transport_buffer_view_v1 result{};
    init(result);
    result.address = reinterpret_cast<uint64_t>(data);
    result.element_count = count;
    result.byte_stride = stride;
    result.byte_length = count * stride;
    result.element_type = element_type;
    result.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY;
    result.component_order = component_order;
    return result;
}

std::vector<fullmag_fdm_gpu_transport_charge_face_v1> boundaries(const Shape &s) {
    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> faces;
    faces.reserve(2 * (s.ny * s.nz + s.nx * s.nz + s.nx * s.ny));
    uint64_t source = 1;
    auto add = [&](uint32_t kind, uint32_t axis, int32_t side, uint64_t cell,
                   uint64_t canonical, double value) {
        fullmag_fdm_gpu_transport_charge_face_v1 face{};
        init(face, kCharge);
        face.kind = kind; face.axis = axis; face.side = side; face.outward_sign = side;
        face.adjacent_cell = cell; face.canonical_face_index = canonical;
        face.area = kH * kH; face.value = value; face.source_id = source++;
        faces.push_back(face);
    };
    for (uint64_t z = 0; z < s.nz; ++z) for (uint64_t y = 0; y < s.ny; ++y) {
        add(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE, 0, -1,
            index(s, 0, y, z), x_face(s, 0, y, z), kLeftVoltage);
        add(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE, 0, +1,
            index(s, s.nx - 1, y, z), x_face(s, s.nx, y, z), 0.0);
    }
    for (uint64_t z = 0; z < s.nz; ++z) for (uint64_t x = 0; x < s.nx; ++x) {
        add(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING, 1, -1,
            index(s, x, 0, z), x + s.nx * ((s.ny + 1) * z), 0.0);
        add(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING, 1, +1,
            index(s, x, s.ny - 1, z), x + s.nx * (s.ny + (s.ny + 1) * z), 0.0);
    }
    for (uint64_t y = 0; y < s.ny; ++y) for (uint64_t x = 0; x < s.nx; ++x) {
        add(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING, 2, -1,
            index(s, x, y, 0), x + s.nx * y, 0.0);
        add(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING, 2, +1,
            index(s, x, y, s.nz - 1), x + s.nx * (y + s.ny * s.nz), 0.0);
    }
    return faces;
}

void readback(fullmag_fdm_gpu_transport_context_handle_v1 context,
              const fullmag_fdm_gpu_charge_snapshot_info_v1 &snapshot,
              uint32_t field, std::vector<double> &destination) {
    auto destination_view = view(
        destination.data(), destination.size(), sizeof(double),
        FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64,
        field == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C
            ? FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ
            : FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR);
    destination_view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
    fullmag_fdm_gpu_transport_artifact_request_v1 request{};
    init(request, kCharge | kReadback);
    request.context_handle = context;
    request.snapshot_handle = snapshot.snapshot_handle;
    request.field_id = field;
    request.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
    request.range_count = destination.size();
    request.destination_view_ptr = reinterpret_cast<uint64_t>(&destination_view);
    request.expected_bytes = destination.size() * sizeof(double);
    request.accepted_sequence = snapshot.accepted_sequence;
    require(fullmag_fdm_gpu_transport_readback_artifact_v1(&request) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "scalability artifact readback failed");
}

void verify_rap_oracle(
    fullmag_fdm_gpu_transport_context_handle_v1 context, const Shape &shape,
    const std::vector<fullmag_fdm_gpu_transport_spin_cell_v1> &cells,
    const std::array<fullmag_fdm_gpu_transport_spin_material_v1, 2> &materials,
    uint64_t material_count,
    const std::vector<fullmag_fdm_gpu_transport_spin_interface_v1> &interfaces,
    const std::vector<fullmag_fdm_gpu_transport_charge_face_v1> &faces,
    uint64_t coarse_count) {
    const uint64_t cnx = (shape.nx + 1) / 2, cny = (shape.ny + 1) / 2;
    const uint64_t cnz = (shape.nz + 1) / 2;
    const uint64_t x_edges = (cnx - 1) * cny * cnz;
    const uint64_t y_edges = cnx * (cny - 1) * cnz;
    const uint64_t edge_count = x_edges + y_edges + cnx * cny * (cnz - 1);
    std::vector<uint64_t> aggregate(cells.size());
    std::vector<double> device_diag(coarse_count), device_edges(edge_count);
    require(fullmag_fdm_gpu_transport_test_charge_hierarchy_readback_v1(
                context, aggregate.data(), aggregate.size(), device_diag.data(),
                device_diag.size(), device_edges.data(), device_edges.size()) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "hierarchy readback failed");
    std::vector<double> dense(coarse_count * coarse_count, 0.0);
    auto sigma = [&](uint64_t i) {
        for (uint64_t m = 0; m < material_count; ++m)
            if (materials[m].material_index == cells[i].material_index)
                return materials[m].conductivity;
        throw std::runtime_error("material missing in RAP oracle");
    };
    auto add_edge = [&](uint64_t a, uint64_t b, double g) {
        const uint64_t ca = aggregate[a], cb = aggregate[b];
        dense[ca * coarse_count + ca] += g;
        dense[cb * coarse_count + cb] += g;
        dense[ca * coarse_count + cb] -= g;
        dense[cb * coarse_count + ca] -= g;
    };
    for (uint64_t z = 0; z < shape.nz; ++z)
        for (uint64_t y = 0; y < shape.ny; ++y)
            for (uint64_t x = 0; x < shape.nx; ++x) {
                const uint64_t a = index(shape, x, y, z);
                require(aggregate[a] == x / 2 + cnx * (y / 2 + cny * (z / 2)),
                        "geometric aggregate map mismatch");
                if (!cells[a].active) continue;
                const std::array<uint64_t, 3> step{{1, shape.nx, shape.nx * shape.ny}};
                const std::array<bool, 3> has{{x + 1 < shape.nx, y + 1 < shape.ny,
                                               z + 1 < shape.nz}};
                for (uint32_t axis = 0; axis < 3; ++axis) if (has[axis]) {
                    const uint64_t b = a + step[axis];
                    if (!cells[b].active) continue;
                    double resistance = kH / (2.0 * sigma(a)) + kH / (2.0 * sigma(b));
                    for (const auto &interface : interfaces)
                        if (interface.axis == axis && interface.negative_cell == a &&
                            interface.positive_cell == b)
                            resistance += 1.0 / (interface.G_up + interface.G_down);
                    add_edge(a, b, kH * kH / resistance);
                }
            }
    for (const auto &face : faces)
        if (face.kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE &&
            cells[face.adjacent_cell].active)
            dense[aggregate[face.adjacent_cell] * coarse_count +
                  aggregate[face.adjacent_cell]] +=
                2.0 * sigma(face.adjacent_cell) * face.area / kH;
    auto close = [](double a, double b) {
        return std::abs(a - b) <= 2.0e-12 * std::max({1.0, std::abs(a), std::abs(b)});
    };
    for (uint64_t i = 0; i < coarse_count; ++i)
        require(close(device_diag[i], dense[i * coarse_count + i]),
                "P^T A P coarse diagonal mismatch");
    std::vector<double> action_dense(coarse_count, 0.0), action_structured(coarse_count, 0.0);
    std::vector<double> x(coarse_count);
    for (uint64_t i = 0; i < coarse_count; ++i) x[i] = 0.25 + static_cast<double>(i % 17) / 19.0;
    for (uint64_t i = 0; i < coarse_count; ++i) {
        for (uint64_t j = 0; j < coarse_count; ++j)
            action_dense[i] += dense[i * coarse_count + j] * x[j];
        action_structured[i] = device_diag[i] * x[i];
    }
    uint64_t edge = 0;
    auto check_edge = [&](uint64_t a, uint64_t b) {
        const double expected = -dense[a * coarse_count + b];
        require(close(device_edges[edge], expected), "P^T A P structured edge mismatch");
        action_structured[a] -= device_edges[edge] * x[b];
        action_structured[b] -= device_edges[edge] * x[a];
        ++edge;
    };
    for (uint64_t z = 0; z < cnz; ++z) for (uint64_t y = 0; y < cny; ++y)
        for (uint64_t x0 = 0; x0 + 1 < cnx; ++x0) {
            const uint64_t a = x0 + cnx * (y + cny * z); check_edge(a, a + 1);
        }
    for (uint64_t z = 0; z < cnz; ++z) for (uint64_t y = 0; y + 1 < cny; ++y)
        for (uint64_t x0 = 0; x0 < cnx; ++x0) {
            const uint64_t a = x0 + cnx * (y + cny * z); check_edge(a, a + cnx);
        }
    for (uint64_t z = 0; z + 1 < cnz; ++z) for (uint64_t y = 0; y < cny; ++y)
        for (uint64_t x0 = 0; x0 < cnx; ++x0) {
            const uint64_t a = x0 + cnx * (y + cny * z); check_edge(a, a + cnx * cny);
        }
    for (uint64_t i = 0; i < coarse_count; ++i)
        require(close(action_dense[i], action_structured[i]),
                "independent coarse action oracle mismatch");
}

Sample run_sample(const std::string &series, Shape shape, int device,
                  const std::array<uint8_t, 16> &expected_uuid) {
    Sample sample{};
    sample.series = series; sample.shape = shape;
    sample.cells = shape.nx * shape.ny * shape.nz;

    fullmag_fdm_gpu_transport_context_create_request_v1 create{};
    init(create, kCharge | kReadback);
    std::copy(expected_uuid.begin(), expected_uuid.end(), create.device_uuid);
    create.device_ordinal = device;
    create.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    create.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.stream_policy = FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    create.allocator_limit = UINT64_C(2147483648);
    create.workspace_limit = UINT64_C(2147483648);
    create.requested_device_features = kCharge | kReadback;
    fullmag_fdm_gpu_transport_context_create_result_v1 created{};
    init(created, kCharge | kReadback);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &created) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "scalability context creation failed");
    std::copy(std::begin(created.build_digest), std::end(created.build_digest),
              sample.build_digest.begin());

    std::vector<fullmag_fdm_gpu_transport_spin_cell_v1> cells(sample.cells);
    for (uint64_t i = 0; i < sample.cells; ++i) {
        init(cells[i], kCharge);
        cells[i].active = cells[i].conductor = 1;
        cells[i].material_index = 1;
        cells[i].region_id = 1;
    }
    if (series == "M") {
        for (uint64_t z = 0; z < shape.nz; ++z) for (uint64_t y = 0; y < shape.ny; ++y)
            for (uint64_t x = shape.nx / 2; x < shape.nx; ++x)
                cells[index(shape, x, y, z)].material_index = 2;
    } else if (series == "I") {
        // Explicit legal empty geometric aggregate. This interior 2x2x2 block
        // maps to one coarse cell while all authored external endpoints stay
        // active, exposing the pre-guard V-cycle 0/0 path.
        for (uint64_t z = 2; z < 4; ++z)
            for (uint64_t y = 2; y < 4; ++y)
                for (uint64_t x = 2; x < 4; ++x) {
                    auto &cell = cells[index(shape, x, y, z)];
                    cell.active = cell.conductor = 0;
                }
        sample.empty_interior_aggregate = true;
        for (uint64_t z = 1; z + 1 < shape.nz; z += 2)
            for (uint64_t y = 1; y + 1 < shape.ny; y += 3) {
                    auto &cell = cells[index(shape, shape.nx / 2, y, z)];
                    cell.active = cell.conductor = 0;
            }
    }
    for (const auto &cell : cells) {
        sample.active_cells += cell.active != 0;
        sample.inactive_cells += cell.active == 0;
    }
    require(series != "I" || sample.inactive_cells >= 8,
            "I series must contain an empty interior 2x2x2 aggregate");

    std::array<fullmag_fdm_gpu_transport_spin_material_v1, 2> materials{};
    sample.materials = series == "M" ? 2 : 1;
    for (uint64_t i = 0; i < sample.materials; ++i) {
        init(materials[i], kCharge);
        materials[i].material_index = static_cast<uint32_t>(i + 1);
        materials[i].conductivity = i == 0 ? 5.0e6 : 2.5e6;
        materials[i].material_revision = 1;
    }

    std::vector<fullmag_fdm_gpu_transport_spin_interface_v1> interfaces;
    if (series == "F") {
        const uint64_t plane = shape.nx / 2;
        interfaces.reserve(shape.ny * shape.nz);
        for (uint64_t z = 0; z < shape.nz; ++z) for (uint64_t y = 0; y < shape.ny; ++y) {
            fullmag_fdm_gpu_transport_spin_interface_v1 interface{};
            init(interface, kCharge);
            interface.kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2;
            interface.axis = 0; interface.orientation = 1;
            interface.negative_cell = index(shape, plane - 1, y, z);
            interface.positive_cell = index(shape, plane, y, z);
            interface.from_cell = interface.negative_cell;
            interface.to_cell = interface.positive_cell;
            interface.canonical_face_index = x_face(shape, plane, y, z);
            interface.area = kH * kH;
            interface.G_up = 1.0e15; interface.G_down = 2.0e15;
            interface.magnetization_xyz[2] = 1.0;
            interface.source_id = 1000 + interfaces.size();
            interface.topology_id = 2000 + interfaces.size();
            interface.charge_edge_enabled = 1;
            interfaces.push_back(interface);
        }
    }
    sample.finite_g_interfaces = interfaces.size();
    auto faces = boundaries(shape);
    fullmag_fdm_gpu_transport_charge_formula_ids_v1 formula{};
    init(formula, kCharge);
    formula.formula_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1;
    formula.operator_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1;
    formula.engine_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1;
    formula.residual_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1;
    formula.operator_revision = 1;
    std::array<uint8_t, 1> empty{{0}};
    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> views{{
        view(cells.data(), cells.size(), sizeof(cells[0])),
        view(materials.data(), sample.materials, sizeof(materials[0])),
        view(interfaces.empty() ? static_cast<const void *>(empty.data())
                                : static_cast<const void *>(interfaces.data()), interfaces.size(),
             sizeof(fullmag_fdm_gpu_transport_spin_interface_v1)),
        view(faces.data(), faces.size(), sizeof(faces[0])),
        view(empty.data(), 0, sizeof(fullmag_fdm_gpu_transport_spin_boundary_face_v1)),
        view(&formula, 1, sizeof(formula)),
    }};
    fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{};
    init(descriptor, kCharge);
    descriptor.grid[0] = shape.nx; descriptor.grid[1] = shape.ny; descriptor.grid[2] = shape.nz;
    descriptor.cell_size[0] = descriptor.cell_size[1] = descriptor.cell_size[2] = kH;
    descriptor.descriptor_revision = descriptor.source_revision = 1;
    const uint8_t digest_byte = static_cast<uint8_t>(series[0] + shape.nx);
    std::fill(std::begin(descriptor.descriptor_digest),
              std::end(descriptor.descriptor_digest), digest_byte);
    descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&views[0]);
    descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&views[1]);
    descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&views[2]);
    descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&views[3]);
    descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&views[4]);
    descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&views[5]);
    const auto upload_begin = std::chrono::steady_clock::now();
    require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                created.context_handle, &descriptor) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "scalability descriptor upload failed");
    sample.upload_seconds = elapsed(upload_begin);

    auto solve_once = [&](uint64_t attempt, fullmag_fdm_gpu_charge_solve_result_v1 *result) {
        fullmag_fdm_gpu_charge_solve_request_v1 request{};
        init(request, kCharge);
        request.context_handle = created.context_handle;
        request.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
        request.gauge_policy = FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
        request.attempt_id = attempt; request.stage_id = 1;
        request.source_revision = request.static_revision = 1;
        request.relative_tolerance = 1.0e-13; request.max_iterations = 1000;
        init(*result, kCharge);
        require(fullmag_fdm_gpu_transport_solve_charge_v1(&request, result) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                    result->reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
                "scalability charge solve failed");
    };
    fullmag_fdm_gpu_charge_solve_result_v1 cold{}, warm{};
    size_t free_bytes = 0, total_bytes = 0;
    require(cudaMemGetInfo(&free_bytes, &total_bytes) == cudaSuccess,
            "CUDA memory identity query failed");
    sample.cuda_free_bytes = free_bytes;
    sample.cuda_total_bytes = total_bytes;
    sample.safety_reserve_bytes = std::max<uint64_t>(UINT64_C(256) << 20,
                                                     sample.cuda_total_bytes / 20);
    sample.resolved_usable_bytes = sample.cuda_free_bytes > sample.safety_reserve_bytes
        ? sample.cuda_free_bytes - sample.safety_reserve_bytes : 0;
    auto begin = std::chrono::steady_clock::now(); solve_once(1, &cold);
    sample.cold_seconds = elapsed(begin);
    sample.cold_iterations = cold.iterations;
    sample.algebraic_residual = cold.algebraic_residual;
    sample.physical_residual = cold.physical_residual;
    sample.component_balance = cold.component_balance;
    sample.electrode_balance = cold.electrode_balance;
    require(std::isfinite(cold.algebraic_residual) && std::isfinite(cold.physical_residual) &&
                cold.physical_residual <= kBalanceTolerance &&
                cold.component_balance <= kBalanceTolerance &&
                cold.electrode_balance <= kBalanceTolerance,
            "scalability physical balance oracle failed");

    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot{};
    init(snapshot, kCharge);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, cold.provisional_generation, &snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "scalability snapshot accept failed");
    std::copy(std::begin(snapshot.snapshot_content_digest),
              std::end(snapshot.snapshot_content_digest), sample.snapshot_digest.begin());
    std::vector<double> potential(sample.cells);
    const uint64_t jx_count = (shape.nx + 1) * shape.ny * shape.nz;
    const uint64_t jy_count = shape.nx * (shape.ny + 1) * shape.nz;
    const uint64_t jz_count = shape.nx * shape.ny * (shape.nz + 1);
    std::vector<double> current(jx_count + jy_count + jz_count);
    readback(created.context_handle, snapshot, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V,
             potential);
    readback(created.context_handle, snapshot, FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C,
             current);
    for (double value : potential) {
        require(std::isfinite(value), "non-finite V readback");
        sample.max_abs_v = std::max(sample.max_abs_v, std::abs(value));
    }
    for (double value : current) {
        require(std::isfinite(value), "non-finite J readback");
        sample.max_abs_j = std::max(sample.max_abs_j, std::abs(value));
    }
    double left = 0.0, right = 0.0;
    for (uint64_t z = 0; z < shape.nz; ++z) for (uint64_t y = 0; y < shape.ny; ++y) {
        left += current[x_face(shape, 0, y, z)] * kH * kH;
        right += current[x_face(shape, shape.nx, y, z)] * kH * kH;
    }
    sample.readback_boundary_balance = std::abs(left - right) /
        std::max({std::abs(left), std::abs(right), std::numeric_limits<double>::min()});
    require(sample.max_abs_v > 0.0 && (series == "I" || sample.max_abs_j > 0.0) &&
                sample.readback_boundary_balance <= kBalanceTolerance,
            "V/J readback conservation oracle failed");

    begin = std::chrono::steady_clock::now(); solve_once(2, &warm);
    sample.warm_seconds = elapsed(begin);
    sample.warm_iterations = warm.iterations;
    sample.required_peak_bytes = std::max(cold.peak_bytes, warm.peak_bytes);

    require(fullmag_fdm_gpu_transport_test_charge_audit_v1(
                created.context_handle, &sample.hierarchy_builds, &sample.hierarchy_hits,
                &sample.amg_applies, &sample.host_fallbacks, &sample.fine_unknowns,
                &sample.coarse_unknowns, &sample.hierarchy_levels,
                sample.hierarchy_digest.data()) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "scalability hierarchy audit failed");
    require(sample.hierarchy_builds == 1 && sample.hierarchy_hits == 1 &&
                sample.amg_applies == cold.iterations + warm.iterations &&
                sample.host_fallbacks == 0 && sample.fine_unknowns == sample.active_cells &&
                sample.coarse_unknowns > 0 && sample.coarse_unknowns < sample.fine_unknowns &&
                sample.hierarchy_levels >= 2 &&
                std::any_of(sample.hierarchy_digest.begin(), sample.hierarchy_digest.end(),
                            [](uint8_t byte) { return byte != 0; }),
            "exact hierarchy build/hit/warm counters failed");
    verify_rap_oracle(created.context_handle, shape, cells, materials,
                      sample.materials, interfaces, faces,
                      sample.coarse_unknowns);
    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "scalability resource teardown failed");
    return sample;
}

double log_slope(const Sample &small, const Sample &large, double Sample::*metric) {
    const double x = static_cast<double>(large.active_cells) /
                     static_cast<double>(small.active_cells);
    const double y = large.*metric / std::max(small.*metric, std::numeric_limits<double>::min());
    return std::log(y) / std::log(x);
}

} // namespace

int main() try {
    int device = -1;
    require(cudaGetDevice(&device) == cudaSuccess, "actual CUDA device is required");
    cudaDeviceProp properties{};
    require(cudaGetDeviceProperties(&properties, device) == cudaSuccess,
            "CUDA device properties are required");
    int runtime = 0, driver = 0;
    require(cudaRuntimeGetVersion(&runtime) == cudaSuccess &&
                cudaDriverGetVersion(&driver) == cudaSuccess,
            "CUDA runtime/driver identity is required");
    std::array<uint8_t, 16> uuid{};
    std::copy(std::begin(properties.uuid.bytes), std::end(properties.uuid.bytes), uuid.begin());

    const std::array<std::pair<const char *, std::array<Shape, 2>>, 3> matrix{{
        {"M", {{{33, 9, 5}, {65, 13, 7}}}},
        {"I", {{{35, 9, 5}, {67, 13, 7}}}},
        {"F", {{{37, 9, 5}, {69, 13, 7}}}},
    }};
    std::vector<Sample> samples;
    samples.reserve(6);
    for (const auto &series : matrix)
        for (const Shape shape : series.second)
            samples.push_back(run_sample(series.first, shape, device, uuid));
    require(std::all_of(samples.begin(), samples.end(), [&](const Sample &sample) {
                return sample.build_digest == samples.front().build_digest;
            }),
            "build identity changed within scalability matrix");

    const char *path = std::getenv("FULLMAG_FDM_GPU_M1_CHARGE_SCALABILITY_EVIDENCE_PATH");
    require(path != nullptr && path[0] != '\0', "scalability evidence path is required");
    std::ofstream out(path, std::ios::trunc);
    require(out.good(), "cannot create scalability evidence JSON");
    out << std::setprecision(17)
        << "{\n  \"schema\": \"fullmag.fdm.gpu.m1.charge.scalability.v1\",\n"
        << "  \"workload\": \"charge_scalability_v1\",\n"
        << "  \"device_ordinal\": " << device << ",\n"
        << "  \"device_name\": " << json_string(properties.name) << ",\n"
        << "  \"device_uuid\": \"" << hex(uuid.data(), uuid.size()) << "\",\n"
        << "  \"compute_major\": " << properties.major << ",\n"
        << "  \"compute_minor\": " << properties.minor << ",\n"
        << "  \"cuda_runtime\": " << runtime << ",\n"
        << "  \"cuda_driver\": " << driver << ",\n"
        << "  \"cxx_compiler\": " << json_string(FULLMAG_CXX_COMPILER) << ",\n"
        << "  \"cuda_compiler\": " << json_string(FULLMAG_CUDA_COMPILER) << ",\n"
        << "  \"fma_policy\": " << json_string(FULLMAG_FMA_POLICY) << ",\n"
        << "  \"git_commit\": \"" << git_commit() << "\",\n"
        << "  \"build_digest\": \"" << hex(samples.front().build_digest.data(), 32) << "\",\n"
        << "  \"source_digest_sha256\": \"" << source_digest() << "\",\n"
        << "  \"formula_id\": \"ohmic_fv_v1\",\n"
        << "  \"operator_id\": \"conservative_fv_v1\",\n"
        << "  \"engine_id\": \"cg_device_amg_v1\",\n"
        << "  \"residual_id\": \"fixed_tree_fp64_v1\",\n"
        << "  \"hierarchy_id\": \"geometric_2x2x2_exact_rap_v1\",\n"
        << "  \"series\": [\n";
    for (size_t i = 0; i < samples.size(); ++i) {
        const auto &s = samples[i];
        out << "    {\"series_id\": \"" << s.series << "\", \"size_index\": " << (i % 2)
            << ", \"grid\": [" << s.shape.nx << ", " << s.shape.ny << ", " << s.shape.nz
            << "], \"cells\": " << s.cells << ", \"active_cells\": " << s.active_cells
            << ", \"inactive_cells\": " << s.inactive_cells << ", \"material_count\": " << s.materials
            << ", \"finite_g_interface_count\": " << s.finite_g_interfaces
            << ", \"empty_interior_aggregate\": "
            << (s.empty_interior_aggregate ? "true" : "false")
            << ", \"memory_policy\": \"fixed_qualification\""
            << ", \"required_peak_bytes\": " << s.required_peak_bytes
            << ", \"cuda_free_bytes_before_solve\": " << s.cuda_free_bytes
            << ", \"cuda_total_bytes\": " << s.cuda_total_bytes
            << ", \"safety_reserve_bytes\": " << s.safety_reserve_bytes
            << ", \"resolved_usable_bytes\": " << s.resolved_usable_bytes
            << ", \"upload_seconds\": " << s.upload_seconds
            << ", \"cold_solve_seconds\": " << s.cold_seconds
            << ", \"warm_solve_seconds\": " << s.warm_seconds
            << ", \"cold_iterations\": " << s.cold_iterations
            << ", \"warm_iterations\": " << s.warm_iterations
            << ", \"algebraic_residual\": " << s.algebraic_residual
            << ", \"physical_residual\": " << s.physical_residual
            << ", \"component_balance\": " << s.component_balance
            << ", \"electrode_balance\": " << s.electrode_balance
            << ", \"readback_boundary_balance\": " << s.readback_boundary_balance
            << ", \"max_abs_v\": " << s.max_abs_v << ", \"max_abs_j\": " << s.max_abs_j
            << ", \"hierarchy_build_count\": " << s.hierarchy_builds
            << ", \"hierarchy_cache_hit_count\": " << s.hierarchy_hits
            << ", \"amg_apply_count\": " << s.amg_applies
            << ", \"host_fallback_count\": " << s.host_fallbacks
            << ", \"fine_unknown_count\": " << s.fine_unknowns
            << ", \"coarse_unknown_count\": " << s.coarse_unknowns
            << ", \"hierarchy_levels\": " << s.hierarchy_levels
            << ", \"hierarchy_digest_sha256\": \"" << hex(s.hierarchy_digest.data(), 32)
            << "\", \"snapshot_digest_sha256\": \"" << hex(s.snapshot_digest.data(), 32) << "\"}"
            << (i + 1 == samples.size() ? "\n" : ",\n");
    }
    out << "  ],\n  \"slopes\": [\n";
    for (size_t series = 0; series < 3; ++series) {
        const auto &small = samples[2 * series];
        const auto &large = samples[2 * series + 1];
        out << "    {\"series_id\": \"" << small.series
            << "\", \"upload_log_slope\": " << log_slope(small, large, &Sample::upload_seconds)
            << ", \"cold_solve_log_slope\": " << log_slope(small, large, &Sample::cold_seconds)
            << ", \"warm_solve_log_slope\": " << log_slope(small, large, &Sample::warm_seconds)
            << "}" << (series == 2 ? "\n" : ",\n");
    }
    out << "  ]\n}\n";
    require(out.good(), "failed to commit scalability evidence JSON");
    return 0;
} catch (const std::exception &error) {
    std::fprintf(stderr, "FAIL: %s\n", error.what());
    return 1;
}
