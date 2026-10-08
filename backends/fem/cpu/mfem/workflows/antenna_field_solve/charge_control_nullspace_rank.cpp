#include "cpu/mfem/workflows/antenna_field_solve/charge_control_nullspace_rank.hpp"

#include <boost/multiprecision/cpp_int.hpp>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <numeric>
#include <stdexcept>
#include <utility>

namespace fullmag::fem::antenna_field_solve {
namespace {

using Integer = boost::multiprecision::cpp_int;
using Row = std::vector<Integer>;
constexpr std::size_t maximum_edges = 65536;
constexpr std::size_t maximum_nodes = 131073;
constexpr std::size_t maximum_cells = 262144;
constexpr std::size_t maximum_bits = 4096;
constexpr std::size_t maximum_storage_bytes = 128u * 1024u * 1024u;
// Conservative allowance for cpp_int limb-capacity growth, not only used bits.
constexpr std::size_t bytes_per_integer = sizeof(Integer) + 4 * (maximum_bits / 8) + 32;
constexpr std::uint64_t maximum_work = 100000000;

[[noreturn]] void resource_error()
{
    throw std::runtime_error("charge authored-control exact rank resource exceeded");
}

std::size_t bits(const Integer &value)
{
    if (value == 0) return 0;
    const Integer magnitude = value < 0 ? -value : value;
    return static_cast<std::size_t>(boost::multiprecision::msb(magnitude)) + 1;
}

class Budget {
public:
    void work(std::uint64_t amount)
    {
        if (amount > maximum_work - used_) resource_error();
        used_ += amount;
    }
    void allocation(std::size_t nodes, std::size_t controls) const
    {
        // Includes offset cells, all echelon rows, working vectors, arithmetic
        // temporaries, node maps and union-find metadata, at maximum bit length.
        if (nodes > maximum_nodes || controls > 64) resource_error();
        const std::size_t cells = (nodes + controls + 16) * controls;
        if (cells > maximum_cells ||
            cells > maximum_storage_bytes / bytes_per_integer) resource_error();
        const std::size_t bytes = cells * bytes_per_integer;
        if (nodes > (maximum_storage_bytes - bytes) / 128) resource_error();
    }
    Integer add(const Integer &left, const Integer &right, bool subtract = false)
    {
        const std::size_t size = std::max(bits(left), bits(right));
        if (size >= maximum_bits) resource_error();
        work(1 + size / 64);
        Integer result;
        if (subtract) result = left - right;
        else result = left + right;
        return result;
    }
    Integer multiply(const Integer &left, const Integer &right)
    {
        const auto left_bits = bits(left), right_bits = bits(right);
        if (left_bits + right_bits > maximum_bits) resource_error();
        work((1 + left_bits / 64) * (1 + right_bits / 64));
        return Integer(left * right);
    }
    Integer gcd(Integer left, Integer right)
    {
        if (left < 0) left = -left;
        if (right < 0) right = -right;
        while (right != 0) {
            work((1 + bits(left) / 64) * (1 + bits(right) / 64));
            Integer remainder = left % right;
            left = std::move(right);
            right = std::move(remainder);
        }
        return left;
    }
    void normalize(Row &row)
    {
        Integer divisor = 0;
        for (const auto &value : row) {
            divisor = gcd(std::move(divisor), value);
            if (divisor == 1) break;
        }
        if (divisor > 1) {
            for (auto &value : row) {
                work((1 + bits(value) / 64) * (1 + bits(divisor) / 64));
                value /= divisor;
            }
        }
    }
private:
    std::uint64_t used_ = 0;
};

Integer exact_binary64(double value, Budget &budget)
{
    static_assert(sizeof(double) == sizeof(std::uint64_t) && std::numeric_limits<double>::is_iec559);
    if (!std::isfinite(value)) throw std::invalid_argument("nonfinite authored charge control coefficient");
    std::uint64_t encoded = 0;
    std::memcpy(&encoded, &value, sizeof(encoded));
    const auto exponent = static_cast<unsigned>((encoded >> 52) & 0x7ffu);
    const std::uint64_t fraction = encoded & ((std::uint64_t{1} << 52) - 1);
    Integer integer = fraction;
    if (exponent != 0) {
        integer += std::uint64_t{1} << 52;
        integer <<= exponent - 1;
    }
    budget.work(1 + bits(integer) / 64);
    if ((encoded >> 63) != 0) integer = -integer;
    return integer;
}

class ExactForest {
public:
    ExactForest(std::size_t nodes, std::size_t controls, Budget &budget)
        : parents_(nodes), sizes_(nodes, 1), offsets_(nodes), controls_(controls), budget_(budget)
    {
        std::iota(parents_.begin(), parents_.end(), 0);
        for (auto &row : offsets_) row.resize(controls);
    }
    // Returns the cycle residual, or an empty row for a forest edge.
    Row edge(std::size_t minus, std::size_t plus, const Row &values)
    {
        auto [minus_root, minus_offset] = find(minus);
        auto [plus_root, plus_offset] = find(plus);
        Row row(controls_);
        for (std::size_t control = 0; control < controls_; ++control) {
            row[control] = budget_.add(budget_.add(plus_offset[control], minus_offset[control], true),
                values[control], true);
        }
        if (minus_root == plus_root) return row;
        if (sizes_[minus_root] < sizes_[plus_root]) {
            parents_[minus_root] = plus_root;
            offsets_[minus_root] = std::move(row);
            sizes_[plus_root] += sizes_[minus_root];
        } else {
            for (auto &value : row) value = -value;
            parents_[plus_root] = minus_root;
            offsets_[plus_root] = std::move(row);
            sizes_[minus_root] += sizes_[plus_root];
        }
        return {};
    }
private:
    std::pair<std::size_t, Row> find(std::size_t node)
    {
        Row offset(controls_);
        while (parents_[node] != node) {
            for (std::size_t control = 0; control < controls_; ++control) {
                offset[control] = budget_.add(offset[control], offsets_[node][control]);
            }
            node = parents_[node];
        }
        return {node, std::move(offset)};
    }
    std::vector<std::size_t> parents_, sizes_;
    std::vector<Row> offsets_;
    std::size_t controls_;
    Budget &budget_;
};

class ExactEchelon {
public:
    ExactEchelon(std::size_t controls, Budget &budget) : rows_(controls), budget_(budget) {}
    void insert(Row row)
    {
        budget_.normalize(row);
        for (std::size_t pivot = 0; pivot < rows_.size(); ++pivot) {
            if (row[pivot] == 0) continue;
            if (rows_[pivot].empty()) {
                rows_[pivot] = std::move(row);
                ++rank_;
                return;
            }
            const auto &basis = rows_[pivot];
            const Integer divisor = budget_.gcd(row[pivot], basis[pivot]);
            budget_.work(2 * (1 + maximum_bits / 64) * (1 + maximum_bits / 64));
            const Integer left = basis[pivot] / divisor;
            const Integer right = row[pivot] / divisor;
            for (std::size_t column = pivot; column < row.size(); ++column) {
                row[column] = budget_.add(budget_.multiply(left, row[column]),
                    budget_.multiply(right, basis[column]), true);
            }
            budget_.normalize(row);
        }
    }
    std::size_t rank() const { return rank_; }
private:
    std::vector<Row> rows_;
    Budget &budget_;
    std::size_t rank_ = 0;
};

void check_graph(const ChargeCurrentResponseRequest &request,
    const ChargeTraceWorkspace &workspace, bool original_volumes, Budget &budget)
{
    const auto &base = request.zero_baseline;
    const auto key = [&](int dof) {
        if (dof < 0) throw std::invalid_argument("invalid authored charge control DOF");
        const int component = workspace.original_volume_component_for_full_dof(dof);
        if (component < 0) throw std::invalid_argument("invalid original charge volume component");
        return original_volumes ? component : dof;
    };
    std::map<int, std::size_t> nodes;
    nodes.emplace(-1, 0); // Algebraic ground, never a physical conductor.
    const auto add_node = [&](int node) {
        if (nodes.find(node) != nodes.end()) return;
        if (nodes.size() >= maximum_nodes) resource_error();
        nodes.emplace(node, nodes.size());
    };
    for (const auto &relation : base.trace_relations) {
        add_node(key(relation.minus_dof));
        add_node(key(relation.plus_dof));
    }
    for (const auto &anchor : base.potential_anchors) add_node(key(anchor.full_dof));
    const auto controls = request.columns.size();
    budget.allocation(nodes.size(), controls);
    ExactForest forest(nodes.size(), controls, budget);
    ExactEchelon echelon(controls, budget);
    const auto visit = [&](std::size_t minus, std::size_t plus, std::size_t index, bool anchor) {
        Row coefficients;
        coefficients.reserve(controls);
        for (const auto &column : request.columns) {
            coefficients.push_back(exact_binary64(anchor ? column.anchor_potential_coefficients[index] :
                column.trace_jump_coefficients[index], budget));
        }
        Row cycle = forest.edge(minus, plus, coefficients);
        if (original_volumes) {
            if (!cycle.empty()) echelon.insert(std::move(cycle));
        } else if (std::any_of(cycle.begin(), cycle.end(), [](const Integer &value) { return value != 0; })) {
            throw std::invalid_argument("authored charge controls are infeasible in full DOF space");
        }
    };
    for (std::size_t index = 0; index < base.trace_relations.size(); ++index) {
        const auto &relation = base.trace_relations[index];
        visit(nodes.at(key(relation.minus_dof)), nodes.at(key(relation.plus_dof)), index, false);
    }
    for (std::size_t index = 0; index < base.potential_anchors.size(); ++index) {
        visit(nodes.at(-1), nodes.at(key(base.potential_anchors[index].full_dof)), index, true);
    }
    if (original_volumes && echelon.rank() != controls) {
        throw std::invalid_argument("authored charge controls are dependent modulo original charge nullspace");
    }
}

} // namespace

void validate_charge_control_rank(const ChargeCurrentResponseRequest &request,
    const ChargeTraceWorkspace &workspace)
{
    const auto controls = request.columns.size();
    const auto &base = request.zero_baseline;
    if (controls == 0 || controls > 64) throw std::invalid_argument("invalid authored charge control count");
    if (base.trace_relations.size() > maximum_edges ||
        base.potential_anchors.size() > maximum_edges - base.trace_relations.size()) resource_error();
    for (const auto &column : request.columns) {
        if (column.trace_jump_coefficients.size() != base.trace_relations.size() ||
            column.anchor_potential_coefficients.size() != base.potential_anchors.size()) {
            throw std::invalid_argument("invalid authored charge control dimensions");
        }
    }
    Budget budget;
    check_graph(request, workspace, false, budget);
    check_graph(request, workspace, true, budget);
}

} // namespace fullmag::fem::antenna_field_solve
