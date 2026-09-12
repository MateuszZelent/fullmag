/* High-precision host oracle for rotated interfacial DMI cancellation bounds. */

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

using Vec3 = std::array<long double, 3>;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream input(path);
    check(input.good(), "rotated DMI kernel must be readable");
    std::ostringstream contents;
    contents << input.rdbuf();
    return contents.str();
}

std::filesystem::path fem_source_root()
{
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() /
        this_file.parent_path().parent_path();
}

void source_contract_uses_all_rotated_operand_magnitudes()
{
    const std::string source = read_text_file(
        fem_source_root() /
        "gpu/cuda/interactions/dmi/dmi_kernels.cu");
    for (const char *term : {
             "abs_s[2] * abs_gq[0][0]",
             "abs_q[2] * abs_gs[0][0]",
             "abs_s[0] * abs_gq[2][0]",
             "abs_q[0] * abs_gs[2][0]",
             "abs_s[0] * abs_gq[1][1]",
             "abs_q[0] * abs_gs[1][1]",
             "abs_s[1] * abs_gq[0][1]",
             "abs_q[1] * abs_gs[0][1]",
         }) {
        check(
            source.find(term) != std::string::npos,
            "rotated DMI source must retain every operand-level absolute product");
    }
    check(
        source.find("const double rotated_arithmetic_scale") !=
                std::string::npos &&
            source.find("rotated_arithmetic_scale + rotated_absolute") !=
                std::string::npos,
        "rotated DMI source must add the operand scale before publishing the cancellation bound");
}

void high_precision_oracle_preserves_cancelled_operands()
{
    // These are the four P1 shape-function gradients of the unit tetrahedron.
    const std::array<Vec3, 4> gradients = {{
        Vec3{-1.0L, -1.0L, -1.0L},
        Vec3{1.0L, 0.0L, 0.0L},
        Vec3{0.0L, 1.0L, 0.0L},
        Vec3{0.0L, 0.0L, 1.0L},
    }};
    // The nodal sums vanish in every component, while all eight rotated
    // scalar products have non-zero operand magnitudes.
    const std::array<Vec3, 4> operands = {{
        Vec3{1.0L, 1.0L, 1.0L},
        Vec3{-1.0L, -1.0L, -1.0L},
        Vec3{-1.0L, -1.0L, 1.0L},
        Vec3{1.0L, 1.0L, -1.0L},
    }};

    Vec3 s{};
    Vec3 q{};
    Vec3 abs_s{};
    Vec3 abs_q{};
    std::array<std::array<long double, 3>, 3> gs{};
    std::array<std::array<long double, 3>, 3> gq{};
    std::array<std::array<long double, 3>, 3> abs_gs{};
    std::array<std::array<long double, 3>, 3> abs_gq{};
    for (std::size_t local = 0; local < operands.size(); ++local) {
        const Vec3 &a = operands[local];
        const Vec3 &b = operands[local];
        for (std::size_t component = 0; component < 3; ++component) {
            s[component] += 0.25L * a[component];
            q[component] += 0.25L * b[component];
            abs_s[component] += 0.25L * std::abs(a[component]);
            abs_q[component] += 0.25L * std::abs(b[component]);
            for (std::size_t direction = 0; direction < 3; ++direction) {
                gs[component][direction] +=
                    a[component] * gradients[local][direction];
                gq[component][direction] +=
                    b[component] * gradients[local][direction];
                abs_gs[component][direction] +=
                    std::abs(a[component]) *
                    std::abs(gradients[local][direction]);
                abs_gq[component][direction] +=
                    std::abs(b[component]) *
                    std::abs(gradients[local][direction]);
            }
        }
    }

    const std::array<long double, 8> rotated_terms = {
        s[2] * gq[0][0],
        q[2] * gs[0][0],
        -s[0] * gq[2][0],
        -q[0] * gs[2][0],
        s[0] * gq[1][1],
        q[0] * gs[1][1],
        -s[1] * gq[0][1],
        -q[1] * gs[0][1],
    };
    long double collapsed_sum = 0.0L;
    long double collapsed_absolute = 0.0L;
    for (const long double term : rotated_terms) {
        collapsed_sum += term;
        collapsed_absolute += std::abs(term);
    }
    const long double operand_scale =
        abs_s[2] * abs_gq[0][0] +
        abs_q[2] * abs_gs[0][0] +
        abs_s[0] * abs_gq[2][0] +
        abs_q[0] * abs_gs[2][0] +
        abs_s[0] * abs_gq[1][1] +
        abs_q[0] * abs_gs[1][1] +
        abs_s[1] * abs_gq[0][1] +
        abs_q[1] * abs_gs[0][1];

    check(
        collapsed_sum == 0.0L && collapsed_absolute == 0.0L &&
            operand_scale == 16.0L && operand_scale > collapsed_absolute,
        "rotated DMI high-precision oracle must retain a non-zero bound when aggregate s/q products cancel");
}

} // namespace

int main()
{
    source_contract_uses_all_rotated_operand_magnitudes();
    high_precision_oracle_preserves_cancelled_operands();
    std::puts("FEM rotated DMI operand-scale cancellation contract: PASS");
    return 0;
}
