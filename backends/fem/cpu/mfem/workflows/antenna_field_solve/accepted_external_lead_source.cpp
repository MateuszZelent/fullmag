#include "cpu/mfem/workflows/antenna_field_solve/accepted_external_lead_source.hpp"
#include "frequency_domain/canonical_digest.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <cmath>
#include <initializer_list>
#include <map>
#include <numeric>
#include <set>
#include <stdexcept>
#include <string_view>
#include <utility>

namespace fullmag::fem::antenna_field_solve {
namespace {

using FaceKey = std::array<std::uint64_t, 3>;
using Role = ExternalLeadSourceBoundaryRole;

void require(bool condition, const char *message)
{
    if (!condition) throw std::invalid_argument(message);
}

double finite_value(long double value)
{
    const double result = static_cast<double>(value);
    require(std::isfinite(value) && std::isfinite(result), "external lead measurement is not finite");
    return result == 0.0 ? 0.0 : result;
}

void current_gate(long double measured, long double requested)
{
    const long double residual = measured - requested;
    const long double tolerance = 1.0e-18L + 1.0e-8L * std::abs(requested);
    require(std::isfinite(measured) && std::isfinite(requested) &&
            std::isfinite(residual) && std::isfinite(tolerance) && std::abs(residual) <= tolerance,
        "external lead source failed its signed requested current gate");
}

struct BalancedSum {
    long double sum = 0.0L;
    long double scale = 0.0L;
    void add(double value) { sum += value; scale += std::abs(static_cast<long double>(value)); }
    void validate() const
    {
        const long double tolerance = 1.0e-18L + 1.0e-10L * scale;
        require(std::isfinite(sum) && std::isfinite(scale) && std::isfinite(tolerance) &&
                std::abs(sum) <= tolerance,
            "external lead source failed its per-component current balance");
    }
};

class BoundedRecord {
public:
    explicit BoundedRecord(std::string_view schema) : builder_(schema)
    {
        used_ = 17u + std::string_view("schema").size() + schema.size();
    }
    void text(std::string_view name, const std::string &value)
    {
        reserve(name, value.size());
        builder_.add_string(name, value);
    }
    void integer(std::string_view name, std::uint64_t value)
    {
        reserve(name, 8);
        builder_.add_u64(name, value);
    }
    void bytes(std::string_view name, const std::string &value)
    {
        reserve(name, value.size());
        builder_.add_bytes(name, reinterpret_cast<const std::uint8_t *>(value.data()), value.size());
    }
    void real(std::string_view name, double value)
    {
        require(std::isfinite(value), "external lead record contains a nonfinite scalar");
        reserve(name, 8);
        builder_.add_double(name, value);
    }
    std::pair<std::string, std::string> finish()
    {
        auto digest = builder_.sha256_hex();
        return {std::move(digest), std::move(builder_).release_payload()};
    }
    void preflight_repeated_fields(std::uint64_t count, std::uint64_t stride, std::uint64_t trailer) const
    {
        constexpr auto maximum = AcceptedTerminalChargeSource::maximum_digest_preimage_bytes;
        require(used_ <= maximum && trailer <= maximum - used_ && stride > 0 &&
                count <= (maximum - used_ - trailer) / stride,
            "external lead field record exceeds its preflight 128 MiB budget");
    }
    void preflight_fields(std::initializer_list<std::pair<std::string_view, std::uint64_t>> fields) const
    {
        constexpr auto maximum = AcceptedTerminalChargeSource::maximum_digest_preimage_bytes;
        auto total = used_;
        for (const auto &[name, size] : fields) {
            const std::uint64_t overhead = 17u + name.size();
            require(total <= maximum && overhead <= maximum - total && size <= maximum - total - overhead,
                "external lead bundle exceeds its aggregate 128 MiB preimage budget");
            total += overhead + size;
        }
    }
private:
    void reserve(std::string_view name, std::uint64_t size)
    {
        constexpr auto maximum = AcceptedTerminalChargeSource::maximum_digest_preimage_bytes;
        const std::uint64_t overhead = 17u + name.size();
        require(used_ <= maximum && overhead <= maximum - used_ &&
                size <= maximum - used_ - overhead,
            "external lead record exceeds its 128 MiB preimage budget");
        used_ += overhead + size;
    }
    frequency_domain::CanonicalDigestBuilder builder_;
    std::uint64_t used_ = 0;
};

FaceKey face_key(const mfem::Mesh &mesh, const transport::StableMeshVertexIdentities &ids, int face)
{
    mfem::Array<int> vertices;
    mesh.GetFaceVertices(face, vertices);
    require(vertices.Size() == 3, "external lead source requires triangular faces");
    FaceKey key{};
    for (int i = 0; i < 3; ++i) key[static_cast<std::size_t>(i)] = ids.local_to_stable.at(vertices[i]);
    std::sort(key.begin(), key.end());
    return key;
}

struct Component {
    std::uint64_t id = 0;
    std::size_t device_elements = 0;
    std::size_t lead_elements = 0;
    std::size_t interfaces = 0;
    std::size_t terminals = 0;
    BalancedSum requested;
    BalancedSum h1;
    BalancedSum rt0;
};

void validate_field_inputs(const std::vector<std::array<double, 3>> &target_points,
    const oersted::DirectTetraQuadratureOptions &options)
{
    require(options.base_quadrature_order >= 2 && options.base_quadrature_order <= 16 &&
            options.maximum_subdivision_depth >= 0 && options.maximum_subdivision_depth <= 6 &&
            std::isfinite(options.absolute_tolerance_apm) && options.absolute_tolerance_apm >= 0.0 &&
            std::isfinite(options.relative_tolerance) && options.relative_tolerance >= 0.0 &&
            options.maximum_source_target_pairs > 0 && options.maximum_source_target_pairs <= 1'000'000,
        "external lead field quadrature policy is outside its bounded private contract");
    for (const auto &point : target_points) {
        for (const auto value : point) require(std::isfinite(value), "external lead field target must be finite");
    }
}

} // namespace

class AcceptedExternalLeadCurrentSource::Impl {
public:
    AcceptedTerminalChargeSource::Ptr charge;
    transport::TerminalRt0PhysicalMeasurements physical;
    std::vector<ExternalLeadBranchCurrentMeasurement> branches;
    std::vector<ExternalLeadComponentCurrentMeasurement> components;
    std::string digest;
    std::string bytes;
};

AcceptedExternalLeadCurrentSource::AcceptedExternalLeadCurrentSource(std::unique_ptr<Impl> impl)
    : impl_(std::move(impl)) {}
AcceptedExternalLeadCurrentSource::~AcceptedExternalLeadCurrentSource() = default;
const AcceptedTerminalChargeSource &AcceptedExternalLeadCurrentSource::charge_source() const { return *impl_->charge; }
const transport::TerminalRt0PhysicalMeasurements &AcceptedExternalLeadCurrentSource::physical_measurements() const { return impl_->physical; }
const std::vector<ExternalLeadBranchCurrentMeasurement> &AcceptedExternalLeadCurrentSource::branch_measurements() const { return impl_->branches; }
const std::vector<ExternalLeadComponentCurrentMeasurement> &AcceptedExternalLeadCurrentSource::component_measurements() const { return impl_->components; }
const std::string &AcceptedExternalLeadCurrentSource::content_digest() const { return impl_->digest; }
const std::string &AcceptedExternalLeadCurrentSource::canonical_content_bytes() const { return impl_->bytes; }

AcceptedExternalLeadCurrentSource::Ptr AcceptedExternalLeadCurrentSource::Finalize(
    const AcceptedExternalLeadSourceRequest &request)
{
    require(request.accepted_source != nullptr, "external lead finalization requires an accepted charge owner");
    const auto &charge = *request.accepted_source;
    require(request.required_charge_content_digest == charge.content_digest(),
        "external lead finalization has a stale charge content pin");
    transport::validate_terminal_current_identifier(request.closure_revision);
    const auto &projection = charge.rt0_projection();
    const auto &field = projection.field();
    const auto &mesh = *field.FESpace()->GetMesh();
    require(charge.potential().FESpace()->GetMesh() == &mesh,
        "external lead charge potential and RT0 do not share the exact owned mesh");
    const auto &ids = projection.stable_vertex_identities();
    const auto &terminals = charge.terminal_solution();
    const auto &h1 = *terminals.accepted_solution;
    const auto &interfaces = charge.interface_pairs();
    require(!interfaces.empty() && !request.branch_observations.empty() &&
            request.branch_observations.size() <= interfaces.size(),
        "external lead source needs explicit interfaces and device branch observations");
    const auto vertex_count = ids.local_to_stable.size();
    require(!request.device_vertex_ids.empty() && !request.lead_vertex_ids.empty() &&
            request.device_vertex_ids.size() <= vertex_count &&
            request.lead_vertex_ids.size() == vertex_count - request.device_vertex_ids.size(),
        "external lead vertex partition does not cover its owned mesh");
    std::map<std::uint64_t, std::size_t> vertex_indices;
    for (std::size_t i = 0; i < vertex_count; ++i) vertex_indices.emplace(ids.local_to_stable[i], i);
    std::set<std::uint64_t> device, lead;
    for (const auto id : request.device_vertex_ids) {
        require(vertex_indices.count(id) == 1 && device.insert(id).second,
            "external lead device partition contains a foreign or repeated vertex");
    }
    for (const auto id : request.lead_vertex_ids) {
        require(vertex_indices.count(id) == 1 && device.count(id) == 0 && lead.insert(id).second,
            "external lead partition contains a foreign, repeated or shared vertex");
    }
    std::vector<bool> element_is_device(static_cast<std::size_t>(mesh.GetNE()));
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        const bool is_device = device.count(ids.local_to_stable.at(vertices[0])) != 0;
        for (const auto vertex : vertices) {
            require((device.count(ids.local_to_stable.at(vertex)) != 0) == is_device,
                "external lead vertex partition splits a physical tetrahedron");
        }
        element_is_device[static_cast<std::size_t>(element)] = is_device;
    }

    std::vector<int> parents(static_cast<std::size_t>(mesh.GetNE()));
    std::iota(parents.begin(), parents.end(), 0);
    const auto root = [&](int element) {
        int current = element;
        while (parents[static_cast<std::size_t>(current)] != current) current = parents[static_cast<std::size_t>(current)];
        while (parents[static_cast<std::size_t>(element)] != element) {
            const int next = parents[static_cast<std::size_t>(element)];
            parents[static_cast<std::size_t>(element)] = current;
            element = next;
        }
        return current;
    };
    const auto join = [&](int first, int second) {
        first = root(first);
        second = root(second);
        if (first != second) parents[static_cast<std::size_t>(std::max(first, second))] = std::min(first, second);
    };
    std::map<FaceKey, int> boundary_elements;
    std::vector<FaceKey> actual_boundary_keys;
    for (int face = 0; face < mesh.GetNumFaces(); ++face) {
        int first = -1, second = -1;
        mesh.GetFaceElements(face, &first, &second);
        require(first >= 0, "external lead face has no adjacent volume");
        if (second >= 0) join(first, second);
        else {
            const auto key = face_key(mesh, ids, face);
            require(boundary_elements.emplace(key, first).second,
                "external lead boundary contains a duplicate physical face");
            actual_boundary_keys.push_back(key);
        }
    }
    require(request.boundary_faces.size() == boundary_elements.size(),
        "external lead source must classify every actual exterior face exactly once");
    std::map<FaceKey, std::pair<Role, std::string>> expected;
    for (const auto &key : actual_boundary_keys) expected.emplace(key, std::make_pair(Role::Insulating, std::string{}));
    std::map<std::string, std::size_t> interface_indices;
    for (std::size_t i = 0; i < interfaces.size(); ++i) {
        const auto &pair = interfaces[i];
        const int first = boundary_elements.at(pair.first_face_vertex_ids);
        const int second = boundary_elements.at(pair.second_face_vertex_ids);
        require(element_is_device[static_cast<std::size_t>(first)] &&
                !element_is_device[static_cast<std::size_t>(second)],
            "external lead interface must have first=device and second=lead");
        require(interface_indices.emplace(pair.id, i).second, "external lead interface IDs are repeated");
        expected.at(pair.first_face_vertex_ids) = {Role::DeviceLeadInterface, pair.id};
        expected.at(pair.second_face_vertex_ids) = {Role::DeviceLeadInterface, pair.id};
        join(first, second);
    }
    require(projection.terminal_constraints().size() == terminals.terminal_ids.size() &&
            projection.interface_pairs().size() == interfaces.size(),
        "external lead projection descriptors differ from its charge owner");
    for (std::size_t i = 0; i < terminals.terminal_ids.size(); ++i) {
        const auto &constraint = projection.terminal_constraints()[i];
        require(constraint.id == terminals.terminal_ids[i] &&
                constraint.boundary_face_vertex_ids == terminals.terminal_boundary_face_vertex_ids[i] &&
                constraint.measured_outward_current_a == terminals.measured_outward_currents_a[i],
            "external lead terminal projection is not bound to the accepted H1 reaction");
        for (const auto &key : constraint.boundary_face_vertex_ids) {
            require(!element_is_device[static_cast<std::size_t>(boundary_elements.at(key))] &&
                    expected.at(key).first == Role::Insulating,
                "external lead outer electrode is on device or reuses an interface");
            expected.at(key) = {Role::OuterElectrode, constraint.id};
        }
    }
    std::set<FaceKey> classified;
    for (const auto &boundary : request.boundary_faces) {
        const auto found = expected.find(boundary.vertex_ids);
        require(found != expected.end() && classified.insert(boundary.vertex_ids).second &&
                found->second == std::make_pair(boundary.role, boundary.circuit_id),
            "external lead boundary role or circuit ID differs from its accepted physical face");
    }

    auto impl = std::make_unique<Impl>();
    impl->physical = transport::measure_terminal_current_projection(projection);
    std::map<int, Component> components;
    std::map<int, std::uint64_t> h1_component_by_root;
    std::map<std::uint64_t, int> root_by_h1_component;
    for (int element = 0; element < mesh.GetNE(); ++element) {
        const int component_root = root(element);
        auto &component = components[component_root];
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        for (const auto vertex : vertices) {
            const auto id = ids.local_to_stable.at(vertex);
            component.id = component.id == 0 ? id : std::min(component.id, id);
            const auto h1_component = h1.vertex_component_ids.at(vertex);
            const auto first = h1_component_by_root.emplace(component_root, h1_component);
            const auto second = root_by_h1_component.emplace(h1_component, component_root);
            require(first.first->second == h1_component && second.first->second == component_root,
                "external lead actual topology differs from the accepted electrical H1 components");
        }
        if (element_is_device[static_cast<std::size_t>(element)]) ++component.device_elements;
        else ++component.lead_elements;
    }
    for (const auto &pair : interfaces) ++components.at(root(boundary_elements.at(pair.first_face_vertex_ids))).interfaces;
    for (std::size_t i = 0; i < terminals.terminal_ids.size(); ++i) {
        const int component_root = root(boundary_elements.at(terminals.terminal_boundary_face_vertex_ids[i][0]));
        auto &component = components.at(component_root);
        for (const auto &key : terminals.terminal_boundary_face_vertex_ids[i]) {
            require(root(boundary_elements.at(key)) == component_root,
                "external lead outer terminal spans electrical components");
        }
        const double requested = terminals.requested_outward_currents_a[i];
        const double h1_current = terminals.measured_outward_currents_a[i];
        const double rt0_current = impl->physical.terminal_outward_currents_a.at(i);
        current_gate(h1_current, requested);
        current_gate(rt0_current, requested);
        ++component.terminals;
        component.requested.add(requested);
        component.h1.add(h1_current);
        component.rt0.add(rt0_current);
    }
    for (const auto &[key, component] : components) {
        (void)key;
        require(component.device_elements > 0 && component.lead_elements > 0 &&
                component.interfaces > 0 && component.terminals >= 2,
            "external lead component requires device, lead, interfaces and two outer electrodes");
        component.requested.validate();
        component.h1.validate();
        component.rt0.validate();
        impl->components.push_back({component.id, finite_value(component.requested.sum),
            finite_value(component.h1.sum), finite_value(component.rt0.sum)});
    }
    std::sort(impl->components.begin(), impl->components.end(), [](const auto &a, const auto &b) {
        return a.component_vertex_id < b.component_vertex_id;
    });

    std::set<std::string> branch_ids, observed_interfaces;
    std::set<std::uint64_t> observed_device_vertices;
    for (const auto &branch : request.branch_observations) {
        transport::validate_terminal_current_identifier(branch.id);
        require(branch_ids.insert(branch.id).second && !branch.interface_pair_ids.empty() &&
                branch.interface_pair_ids.size() <= interfaces.size() - observed_interfaces.size() &&
                std::isfinite(branch.requested_device_outward_current_a),
            "external lead branch observation has invalid ID, interface count or requested current");
        std::set<std::uint64_t> branch_vertices;
        long double rt0_current = 0.0L, h1_current = 0.0L;
        int component_root = -1;
        auto sorted_pair_ids = branch.interface_pair_ids;
        std::sort(sorted_pair_ids.begin(), sorted_pair_ids.end());
        for (const auto &pair_id : sorted_pair_ids) {
            const auto found = interface_indices.find(pair_id);
            require(found != interface_indices.end() && observed_interfaces.insert(pair_id).second,
                "external lead branch observation reuses or invents an interface");
            const auto &pair = interfaces[found->second];
            const int pair_root = root(boundary_elements.at(pair.first_face_vertex_ids));
            if (component_root < 0) component_root = pair_root;
            require(component_root == pair_root, "external lead branch observation spans electrical components");
            const auto &measurement = impl->physical.interfaces.at(found->second);
            require(measurement.id == pair_id, "external lead interface measurement order is inconsistent");
            rt0_current += measurement.first_outward_current_a;
            branch_vertices.insert(pair.first_face_vertex_ids.begin(), pair.first_face_vertex_ids.end());
        }
        for (const auto id : branch_vertices) {
            require(observed_device_vertices.insert(id).second,
                "external lead branch observations share device P1 reactions");
            h1_current -= h1.reaction_vertex_values_a.at(vertex_indices.at(id));
        }
        current_gate(h1_current, branch.requested_device_outward_current_a);
        current_gate(rt0_current, branch.requested_device_outward_current_a);
        impl->branches.push_back({branch.id, branch.requested_device_outward_current_a,
            finite_value(h1_current), finite_value(rt0_current)});
    }
    require(observed_interfaces.size() == interfaces.size(),
        "external lead source has unobserved device interface currents");

    BoundedRecord record(digest_schema);
    record.text("operator_version", operator_version);
    record.text("field_scope", field_scope);
    record.text("charge_content_digest", charge.content_digest());
    record.text("closure_revision", request.closure_revision);
    record.real("absolute_current_gate_a", 1.0e-18);
    record.real("local_relative_gate", 1.0e-10);
    record.real("requested_current_relative_gate", 1.0e-8);
    record.integer("device_vertex_count", device.size());
    for (const auto id : device) record.integer("device_vertex_id", id);
    record.integer("lead_vertex_count", lead.size());
    for (const auto id : lead) record.integer("lead_vertex_id", id);
    record.integer("boundary_count", expected.size());
    for (const auto &[key, boundary] : expected) {
        for (const auto id : key) record.integer("boundary_vertex_id", id);
        record.integer("boundary_role", static_cast<std::uint8_t>(boundary.first));
        record.text("boundary_circuit_id", boundary.second);
    }
    record.integer("branch_count", request.branch_observations.size());
    for (std::size_t i = 0; i < request.branch_observations.size(); ++i) {
        const auto &branch = request.branch_observations[i];
        const auto &measured = impl->branches[i];
        record.text("branch_id", branch.id);
        auto pair_ids = branch.interface_pair_ids;
        std::sort(pair_ids.begin(), pair_ids.end());
        record.integer("branch_pair_count", pair_ids.size());
        for (const auto &id : pair_ids) record.text("branch_pair_id", id);
        record.real("branch_requested_a", measured.requested_outward_current_a);
        record.real("branch_h1_a", measured.h1_outward_current_a);
        record.real("branch_rt0_a", measured.rt0_outward_current_a);
    }
    record.integer("component_count", impl->components.size());
    for (const auto &component : impl->components) {
        record.integer("component_id", component.component_vertex_id);
        record.real("component_requested_sum_a", component.requested_outward_current_sum_a);
        record.real("component_h1_sum_a", component.h1_outward_current_sum_a);
        record.real("component_rt0_sum_a", component.rt0_outward_current_sum_a);
    }
    record.integer("element_count", impl->physical.elements.size());
    for (const auto &element : impl->physical.elements) {
        for (const auto id : element.vertex_ids) record.integer("element_vertex_id", id);
        record.real("element_flux_sum_a", element.outward_flux_sum_a);
        record.real("element_absolute_flux_sum_a", element.absolute_flux_sum_a);
    }
    record.integer("face_count", impl->physical.faces.size());
    for (const auto &face : impl->physical.faces) {
        for (const auto id : face.vertex_ids) record.integer("face_vertex_id", id);
        record.integer("face_side_count", face.side_count);
        record.real("face_rt0_to_canonical_weight", face.rt0_dof_to_canonical_flux_weight);
        record.real("face_canonical_flux_a", face.canonical_flux_a);
        record.real("face_first_outward_a", face.first_outward_flux_a);
        record.real("face_second_outward_a", face.second_outward_flux_a);
        record.real("face_canonical_jump_a", face.canonical_jump_a);
    }
    record.integer("terminal_count", terminals.terminal_ids.size());
    for (std::size_t i = 0; i < terminals.terminal_ids.size(); ++i) {
        record.text("terminal_id", terminals.terminal_ids[i]);
        record.real("terminal_requested_a", terminals.requested_outward_currents_a[i]);
        record.real("terminal_h1_a", terminals.measured_outward_currents_a[i]);
        record.real("terminal_rt0_a", impl->physical.terminal_outward_currents_a[i]);
    }
    record.integer("interface_count", impl->physical.interfaces.size());
    for (const auto &pair : impl->physical.interfaces) {
        record.text("interface_id", pair.id);
        record.real("interface_first_outward_a", pair.first_outward_current_a);
        record.real("interface_second_outward_a", pair.second_outward_current_a);
        record.real("interface_mismatch_a", pair.mismatch_a);
    }
    // The accepted charge digest retains the complete terminal RHS/rank/omission ledger.
    record.integer("constraint_rows", projection.constraint_rank_certificate().rows_before);
    record.integer("constraint_rank", projection.constraint_rank_certificate().rank);
    record.real("scaled_kkt_residual", projection.scaled_kkt_residual());
    record.real("correction_norm_mw", projection.correction_norm_mw());
    auto payload = record.finish();
    impl->digest = std::move(payload.first);
    impl->bytes = std::move(payload.second);
    impl->charge = request.accepted_source;
    return Ptr(new AcceptedExternalLeadCurrentSource(std::move(impl)));
}

AcceptedExternalLeadFieldResult evaluate_accepted_external_lead_field(
    const AcceptedExternalLeadCurrentSource &source,
    const std::vector<std::array<double, 3>> &target_points,
    const oersted::DirectTetraQuadratureOptions &options)
{
    validate_field_inputs(target_points, options);
    const auto &charge = source.charge_source();
    const auto &field = charge.rt0_projection().field();
    const auto &mesh = *field.FESpace()->GetMesh();
    require(charge.potential().FESpace()->GetMesh() == &mesh,
        "external lead field source no longer shares its owned charge mesh");
    constexpr const char *field_operator = "fem_accepted_external_lead_field.v2";
    BoundedRecord record("accepted_external_lead_field.ordered.v2");
    record.text("operator_version", field_operator);
    record.text("quadrature_operator_version", oersted::DirectTetraQuadrature::operator_version);
    record.text("field_scope", AcceptedExternalLeadCurrentSource::field_scope);
    record.text("accepted_external_source_digest", source.content_digest());
    record.text("charge_content_digest", charge.content_digest());
    record.integer("base_quadrature_order", options.base_quadrature_order);
    record.integer("maximum_subdivision_depth", options.maximum_subdivision_depth);
    record.real("absolute_tolerance_apm", options.absolute_tolerance_apm);
    record.real("relative_tolerance", options.relative_tolerance);
    record.real("relative_scale_floor_apm", 0.0);
    record.integer("maximum_source_target_pairs", options.maximum_source_target_pairs);
    record.text("quadrature_scope", "global_target");
    record.text("estimated_error_policy", "sum_final_leaf_l2_difference.v1");
    record.text("roundoff_indicator_policy", "weighted_terms_binary64_epsilon.v1");
    record.integer("maximum_final_leaves_per_target", oersted::DirectTetraQuadrature::maximum_final_leaves_per_target);
    record.integer("maximum_kernel_evaluations", oersted::DirectTetraQuadrature::maximum_kernel_evaluations);
    record.integer("maximum_ledger_leaf_visits", oersted::DirectTetraQuadrature::maximum_ledger_leaf_visits);
    record.integer("target_count", target_points.size());
    constexpr auto scalar_bytes = [](std::string_view name) { return std::uint64_t{25} + name.size(); };
    constexpr auto target_stride = 3 * (scalar_bytes("target_coordinate_m") + scalar_bytes("h_component_apm")) +
        scalar_bytes("target_estimated_error_apm") + scalar_bytes("target_tolerance_apm") +
        scalar_bytes("target_roundoff_indicator_apm") + scalar_bytes("target_final_leaf_count") +
        scalar_bytes("target_kernel_evaluations") + scalar_bytes("target_ledger_leaf_visits");
    constexpr auto diagnostics_bytes = scalar_bytes("source_target_pairs") + scalar_bytes("refined_pairs") +
        scalar_bytes("unconverged_pair_count") + scalar_bytes("maximum_pair_error_apm") +
        scalar_bytes("kernel_evaluations") + scalar_bytes("ledger_leaf_visits");
    record.preflight_repeated_fields(target_points.size(), target_stride, diagnostics_bytes);
    auto quadrature = oersted::DirectTetraQuadrature::EvaluateField(mesh, field, target_points, options);
    require(quadrature.diagnostics.unconverged_pair_count == 0,
        "external lead field quadrature did not meet its global target tolerance policy");
    require(quadrature.target_diagnostics.size() == target_points.size(),
        "external lead field target diagnostics have an invalid cardinality");
    require(quadrature.source_view_identity_digest.empty(),
        "external lead contribution must not impersonate a legacy conservative view");
    for (std::size_t target = 0; target < target_points.size(); ++target) {
        for (const auto value : target_points[target]) record.real("target_coordinate_m", value);
        for (int component = 0; component < 3; ++component) {
            record.real("h_component_apm", quadrature.h_xyz_apm.at(3u * target + component));
        }
        const auto &diagnostics = quadrature.target_diagnostics.at(target);
        const double larger = std::max(diagnostics.estimated_error_apm, diagnostics.roundoff_indicator_apm);
        const double smaller = std::min(diagnostics.estimated_error_apm, diagnostics.roundoff_indicator_apm);
        const double sum = larger + smaller;
        const double residual = smaller - (sum - larger);
        require(sum < diagnostics.tolerance_apm || (sum == diagnostics.tolerance_apm && residual <= 0.0),
            "external lead field target did not meet its retained estimator gate");
        record.real("target_estimated_error_apm", diagnostics.estimated_error_apm);
        record.real("target_tolerance_apm", diagnostics.tolerance_apm);
        record.real("target_roundoff_indicator_apm", diagnostics.roundoff_indicator_apm);
        record.integer("target_final_leaf_count", diagnostics.final_leaf_count);
        record.integer("target_kernel_evaluations", diagnostics.kernel_evaluations);
        record.integer("target_ledger_leaf_visits", diagnostics.ledger_leaf_visits);
    }
    record.integer("source_target_pairs", quadrature.diagnostics.source_target_pairs);
    record.integer("refined_pairs", quadrature.diagnostics.refined_pairs);
    record.integer("unconverged_pair_count", quadrature.diagnostics.unconverged_pair_count);
    record.real("maximum_pair_error_apm", quadrature.diagnostics.maximum_pair_error_apm);
    record.integer("kernel_evaluations", quadrature.diagnostics.kernel_evaluations);
    record.integer("ledger_leaf_visits", quadrature.diagnostics.ledger_leaf_visits);
    auto payload = record.finish();
    return {std::move(quadrature), source.content_digest(), AcceptedExternalLeadCurrentSource::field_scope,
        charge.content_digest(), field_operator, std::move(payload.first), std::move(payload.second)};
}

AcceptedExternalLeadBundle solve_accepted_external_lead_bundle(
    const AcceptedTerminalChargeRequest &charge_request,
    AcceptedExternalLeadSourceRequest closure_request,
    const std::vector<std::array<double, 3>> &target_points,
    const oersted::DirectTetraQuadratureOptions &options)
{
    require(!closure_request.accepted_source && closure_request.required_charge_content_digest.empty(),
        "external lead bundle must resolve its own accepted charge owner and content pin");
    validate_field_inputs(target_points, options);
    require(charge_request.mesh != nullptr && charge_request.mesh->GetNE() > 0,
        "external lead bundle requires a nonempty charge mesh");
    require(target_points.empty() || static_cast<std::uint64_t>(charge_request.mesh->GetNE()) <=
            options.maximum_source_target_pairs / target_points.size(),
        "external lead bundle exceeds its source-target pair budget");
    const auto charge = solve_accepted_terminal_charge_source(charge_request);
    closure_request.accepted_source = charge;
    closure_request.required_charge_content_digest = charge->content_digest();
    const auto source = AcceptedExternalLeadCurrentSource::Finalize(closure_request);
    const auto field = evaluate_accepted_external_lead_field(*source, target_points, options);

    BoundedRecord record(AcceptedExternalLeadBundle::digest_schema);
    record.text("operator_version", AcceptedExternalLeadBundle::operator_version);
    record.text("field_scope", AcceptedExternalLeadCurrentSource::field_scope);
    record.preflight_fields({
        {"charge_content_sha256", charge->content_digest().size()},
        {"charge_record", charge->canonical_content_bytes().size()},
        {"source_content_sha256", source->content_digest().size()},
        {"source_record", source->canonical_content_bytes().size()},
        {"field_content_sha256", field.evaluation_content_digest.size()},
        {"field_record", field.canonical_evaluation_bytes.size()},
    });
    record.text("charge_content_sha256", charge->content_digest());
    record.bytes("charge_record", charge->canonical_content_bytes());
    record.text("source_content_sha256", source->content_digest());
    record.bytes("source_record", source->canonical_content_bytes());
    record.text("field_content_sha256", field.evaluation_content_digest);
    record.bytes("field_record", field.canonical_evaluation_bytes);
    auto payload = record.finish();
    return {std::move(payload.first), std::move(payload.second)};
}

} // namespace fullmag::fem::antenna_field_solve
