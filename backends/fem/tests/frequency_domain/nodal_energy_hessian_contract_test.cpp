/*
 * Independent algebraic energy-Hessian oracle for a nodal Tet4 retraction.
 *
 * This test intentionally uses only the C++ standard library. Its mean-zero
 * Poisson solve is a tiny Tet4 algebra surrogate, not the production shared
 * domain, airbox, or MFEM demagnetizing provider.
 */
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>

namespace {

constexpr int kNodes = 4;
constexpr int kComponents = 3;
constexpr int kDofs = kNodes * kComponents;
constexpr int kReducedPotentialDofs = kNodes - 1;
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kMu0 = 4.0e-7 * kPi;
constexpr double kMachineEpsilon = std::numeric_limits<double>::epsilon();

using Vec3 = std::array<double, 3>;
using Magnetization = std::array<Vec3, kNodes>;

struct Tet4
{
    double edge_length_m = 0.0;
    double volume_m3 = 0.0;
    Vec3 gradient[kNodes]{};
    double stiffness[kNodes][kNodes]{};
    double mass[kNodes][kNodes]{};
};

struct Model
{
    double saturation_a_per_m = 0.0;
    double exchange_j_per_m = 0.0;
    double anisotropy_j_per_m3 = 0.0;
    Vec3 anisotropy_axis{};
    Magnetization applied_field_a_per_m{};
};

struct EnergyEvaluation
{
    double exchange_j = 0.0;
    double zeeman_j = 0.0;
    double anisotropy_j = 0.0;
    double demag_j = 0.0;
    double demag_solve_error_estimate_j = 0.0;
    double roundoff_scale_estimate_j = 0.0;
    double total_j = 0.0;
};

struct EnergyJet
{
    EnergyEvaluation energy{};
    double gradient_j[kDofs]{};
    double hessian_j[kDofs][kDofs]{};
    double demag_hessian_j[kDofs][kDofs]{};
};

struct DifferenceEstimate
{
    double value_j = 0.0;
    double uncertainty_estimate_j = 0.0;
};

struct RichardsonEstimate
{
    double value_j = 0.0;
    double uncertainty_estimate_j = 0.0;
};

void check(bool condition, const char *message)
{
    if (!condition)
    {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(EXIT_FAILURE);
    }
}

Vec3 make_vec3(double x, double y, double z)
{
    return Vec3{{x, y, z}};
}

double dot(const Vec3 &left, const Vec3 &right)
{
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

double norm(const Vec3 &value)
{
    return std::sqrt(dot(value, value));
}

Vec3 add(const Vec3 &left, const Vec3 &right)
{
    return make_vec3(left[0] + right[0], left[1] + right[1], left[2] + right[2]);
}

Vec3 scale(double coefficient, const Vec3 &value)
{
    return make_vec3(
        coefficient * value[0],
        coefficient * value[1],
        coefficient * value[2]);
}

Vec3 normalized(const Vec3 &value)
{
    const double magnitude = norm(value);
    check(std::isfinite(magnitude) && magnitude > 0.0, "vector normalization must be finite and nonzero");
    return scale(1.0 / magnitude, value);
}

int dof(int node, int component)
{
    return node * kComponents + component;
}

Tet4 make_tet4(double edge_length_m)
{
    Tet4 tet{};
    tet.edge_length_m = edge_length_m;
    tet.volume_m3 = edge_length_m * edge_length_m * edge_length_m / 6.0;
    const double inverse_edge = 1.0 / edge_length_m;
    tet.gradient[0] = make_vec3(-inverse_edge, -inverse_edge, -inverse_edge);
    tet.gradient[1] = make_vec3(inverse_edge, 0.0, 0.0);
    tet.gradient[2] = make_vec3(0.0, inverse_edge, 0.0);
    tet.gradient[3] = make_vec3(0.0, 0.0, inverse_edge);

    for (int i = 0; i < kNodes; ++i)
    {
        for (int j = 0; j < kNodes; ++j)
        {
            tet.stiffness[i][j] = tet.volume_m3 * dot(tet.gradient[i], tet.gradient[j]);
            tet.mass[i][j] = tet.volume_m3 * (i == j ? 2.0 : 1.0) / 20.0;
        }
    }
    return tet;
}

Model make_model()
{
    Model model{};
    model.saturation_a_per_m = 8.0e5;
    model.exchange_j_per_m = 1.0e-11;
    model.anisotropy_j_per_m3 = 1.0e4;
    model.anisotropy_axis = normalized(make_vec3(1.0, 2.0, 3.0));
    model.applied_field_a_per_m[0] = make_vec3(1.2e4, -0.3e4, 2.0e4);
    model.applied_field_a_per_m[1] = make_vec3(-0.4e4, 1.7e4, 0.8e4);
    model.applied_field_a_per_m[2] = make_vec3(0.6e4, 0.2e4, -1.1e4);
    model.applied_field_a_per_m[3] = make_vec3(1.5e4, -0.9e4, 0.4e4);
    return model;
}

void mean_zero_basis(double basis[kNodes][kReducedPotentialDofs])
{
    const double inverse_sqrt_two = 1.0 / std::sqrt(2.0);
    const double inverse_sqrt_six = 1.0 / std::sqrt(6.0);
    const double inverse_sqrt_twelve = 1.0 / std::sqrt(12.0);
    basis[0][0] = inverse_sqrt_two;
    basis[1][0] = -inverse_sqrt_two;
    basis[2][0] = 0.0;
    basis[3][0] = 0.0;

    basis[0][1] = inverse_sqrt_six;
    basis[1][1] = inverse_sqrt_six;
    basis[2][1] = -2.0 * inverse_sqrt_six;
    basis[3][1] = 0.0;

    basis[0][2] = inverse_sqrt_twelve;
    basis[1][2] = inverse_sqrt_twelve;
    basis[2][2] = inverse_sqrt_twelve;
    basis[3][2] = -3.0 * inverse_sqrt_twelve;
}

void reduced_poisson_matrix(
    const Tet4 &tet,
    const double basis[kNodes][kReducedPotentialDofs],
    double reduced[kReducedPotentialDofs][kReducedPotentialDofs])
{
    for (int a = 0; a < kReducedPotentialDofs; ++a)
    {
        for (int b = 0; b < kReducedPotentialDofs; ++b)
        {
            reduced[a][b] = 0.0;
            for (int i = 0; i < kNodes; ++i)
            {
                for (int j = 0; j < kNodes; ++j)
                {
                    reduced[a][b] += basis[i][a] * tet.stiffness[i][j] * basis[j][b];
                }
            }
        }
    }
}

bool solve_three_by_three(
    const double matrix[kReducedPotentialDofs][kReducedPotentialDofs],
    const double right_hand_side[kReducedPotentialDofs],
    double solution[kReducedPotentialDofs])
{
    double augmented[kReducedPotentialDofs][kReducedPotentialDofs + 1]{};
    for (int row = 0; row < kReducedPotentialDofs; ++row)
    {
        for (int column = 0; column < kReducedPotentialDofs; ++column)
        {
            augmented[row][column] = matrix[row][column];
        }
        augmented[row][kReducedPotentialDofs] = right_hand_side[row];
    }

    for (int pivot = 0; pivot < kReducedPotentialDofs; ++pivot)
    {
        int selected = pivot;
        for (int row = pivot + 1; row < kReducedPotentialDofs; ++row)
        {
            if (std::fabs(augmented[row][pivot]) > std::fabs(augmented[selected][pivot]))
            {
                selected = row;
            }
        }
        if (!std::isfinite(augmented[selected][pivot]) ||
            std::fabs(augmented[selected][pivot]) <= std::numeric_limits<double>::min())
        {
            return false;
        }
        if (selected != pivot)
        {
            for (int column = pivot; column <= kReducedPotentialDofs; ++column)
            {
                const double temporary = augmented[pivot][column];
                augmented[pivot][column] = augmented[selected][column];
                augmented[selected][column] = temporary;
            }
        }

        const double diagonal = augmented[pivot][pivot];
        for (int column = pivot; column <= kReducedPotentialDofs; ++column)
        {
            augmented[pivot][column] /= diagonal;
        }
        for (int row = 0; row < kReducedPotentialDofs; ++row)
        {
            if (row == pivot)
            {
                continue;
            }
            const double factor = augmented[row][pivot];
            for (int column = pivot; column <= kReducedPotentialDofs; ++column)
            {
                augmented[row][column] -= factor * augmented[pivot][column];
            }
        }
    }

    for (int row = 0; row < kReducedPotentialDofs; ++row)
    {
        solution[row] = augmented[row][kReducedPotentialDofs];
        if (!std::isfinite(solution[row]))
        {
            return false;
        }
    }
    return true;
}

void source_map(
    const Tet4 &tet,
    const Model &model,
    const Magnetization &magnetization,
    double map[kNodes][kDofs],
    double source[kNodes])
{
    Vec3 sum_m = make_vec3(0.0, 0.0, 0.0);
    for (int i = 0; i < kNodes; ++i)
    {
        sum_m = add(sum_m, magnetization[i]);
    }
    const double scale_factor = -model.saturation_a_per_m * tet.volume_m3 / 4.0;
    for (int j = 0; j < kNodes; ++j)
    {
        source[j] = scale_factor * dot(tet.gradient[j], sum_m);
        for (int i = 0; i < kNodes; ++i)
        {
            for (int component = 0; component < kComponents; ++component)
            {
                map[j][dof(i, component)] = scale_factor * tet.gradient[j][component];
            }
        }
    }
}

EnergyEvaluation evaluate_energy(
    const Tet4 &tet,
    const Model &model,
    const Magnetization &magnetization)
{
    EnergyEvaluation result{};
    const double exchange = model.exchange_j_per_m;
    const double anisotropy = model.anisotropy_j_per_m3;
    const Vec3 &axis = model.anisotropy_axis;
    double projection[kNodes]{};
    for (int i = 0; i < kNodes; ++i)
    {
        projection[i] = dot(magnetization[i], axis);
    }

    for (int i = 0; i < kNodes; ++i)
    {
        for (int j = 0; j < kNodes; ++j)
        {
            result.exchange_j += exchange * tet.stiffness[i][j] *
                                 dot(magnetization[i], magnetization[j]);
            result.zeeman_j -= kMu0 * model.saturation_a_per_m * tet.mass[i][j] *
                               dot(magnetization[i], model.applied_field_a_per_m[j]);
            result.anisotropy_j -= anisotropy * tet.mass[i][j] * projection[i] * projection[j];
        }
    }

    double basis[kNodes][kReducedPotentialDofs]{};
    double reduced[kReducedPotentialDofs][kReducedPotentialDofs]{};
    double map[kNodes][kDofs]{};
    double source[kNodes]{};
    double reduced_source[kReducedPotentialDofs]{};
    double reduced_potential[kReducedPotentialDofs]{};
    mean_zero_basis(basis);
    reduced_poisson_matrix(tet, basis, reduced);
    source_map(tet, model, magnetization, map, source);

    for (int a = 0; a < kReducedPotentialDofs; ++a)
    {
        for (int j = 0; j < kNodes; ++j)
        {
            reduced_source[a] += basis[j][a] * source[j];
        }
    }
    check(
        solve_three_by_three(reduced, reduced_source, reduced_potential),
        "mean-zero Tet4 Poisson solve must be finite and nonsingular");

    double residual[kReducedPotentialDofs]{};
    for (int a = 0; a < kReducedPotentialDofs; ++a)
    {
        for (int b = 0; b < kReducedPotentialDofs; ++b)
        {
            residual[a] += reduced[a][b] * reduced_potential[b];
        }
        residual[a] = reduced_source[a] - residual[a];
    }
    double correction[kReducedPotentialDofs]{};
    check(
        solve_three_by_three(reduced, residual, correction),
        "Poisson residual correction solve must be finite");
    double source_norm_squared = 0.0;
    double correction_norm_squared = 0.0;
    for (int a = 0; a < kReducedPotentialDofs; ++a)
    {
        source_norm_squared += reduced_source[a] * reduced_source[a];
        correction_norm_squared += correction[a] * correction[a];
    }
    result.demag_solve_error_estimate_j =
        0.5 * kMu0 * std::sqrt(source_norm_squared) * std::sqrt(correction_norm_squared);


    for (int a = 0; a < kReducedPotentialDofs; ++a)
    {
        result.demag_j += 0.5 * kMu0 * reduced_source[a] * reduced_potential[a];
    }

    result.total_j = result.exchange_j + result.zeeman_j +
                     result.anisotropy_j + result.demag_j;
    const double absolute_term_sum =
        std::fabs(result.exchange_j) + std::fabs(result.zeeman_j) +
        std::fabs(result.anisotropy_j) + std::fabs(result.demag_j);
    result.roundoff_scale_estimate_j =
        128.0 * kMachineEpsilon * absolute_term_sum;
    check(std::isfinite(result.total_j), "every sampled total energy must be finite");
    check(
        result.demag_j >= -result.demag_solve_error_estimate_j -
                              result.roundoff_scale_estimate_j,
        "the mean-zero Poisson demagnetizing energy must be nonnegative within residual and roundoff scale estimates");
    return result;
}

EnergyJet analyze_energy(
    const Tet4 &tet,
    const Model &model,
    const Magnetization &magnetization)
{
    EnergyJet jet{};
    jet.energy = evaluate_energy(tet, model, magnetization);
    const Vec3 &axis = model.anisotropy_axis;

    double basis[kNodes][kReducedPotentialDofs]{};
    double reduced[kReducedPotentialDofs][kReducedPotentialDofs]{};
    double map[kNodes][kDofs]{};
    double source[kNodes]{};
    mean_zero_basis(basis);
    reduced_poisson_matrix(tet, basis, reduced);
    source_map(tet, model, magnetization, map, source);

    double reduced_source[kReducedPotentialDofs]{};
    double reduced_potential[kReducedPotentialDofs]{};
    double full_potential[kNodes]{};
    for (int a = 0; a < kReducedPotentialDofs; ++a)
    {
        for (int j = 0; j < kNodes; ++j)
        {
            reduced_source[a] += basis[j][a] * source[j];
        }
    }
    check(
        solve_three_by_three(reduced, reduced_source, reduced_potential),
        "analytic Poisson gradient solve must be finite");
    for (int j = 0; j < kNodes; ++j)
    {
        for (int a = 0; a < kReducedPotentialDofs; ++a)
        {
            full_potential[j] += basis[j][a] * reduced_potential[a];
        }
    }

    double projection[kNodes]{};
    for (int i = 0; i < kNodes; ++i)
    {
        projection[i] = dot(magnetization[i], axis);
    }

    for (int i = 0; i < kNodes; ++i)
    {
        for (int component = 0; component < kComponents; ++component)
        {
            const int row = dof(i, component);
            for (int j = 0; j < kNodes; ++j)
            {
                jet.gradient_j[row] +=
                    2.0 * model.exchange_j_per_m * tet.stiffness[i][j] *
                    magnetization[j][component];
                jet.gradient_j[row] -=
                    kMu0 * model.saturation_a_per_m * tet.mass[i][j] *
                    model.applied_field_a_per_m[j][component];
                jet.gradient_j[row] -=
                    2.0 * model.anisotropy_j_per_m3 * tet.mass[i][j] *
                    projection[j] * axis[component];
                for (int other_component = 0;
                     other_component < kComponents;
                     ++other_component)
                {
                    const int column = dof(j, other_component);
                    if (component == other_component)
                    {
                        jet.hessian_j[row][column] +=
                            2.0 * model.exchange_j_per_m * tet.stiffness[i][j];
                    }
                    jet.hessian_j[row][column] -=
                        2.0 * model.anisotropy_j_per_m3 * tet.mass[i][j] *
                        axis[component] * axis[other_component];
                }
            }
            for (int j = 0; j < kNodes; ++j)
            {
                jet.gradient_j[row] += kMu0 * map[j][row] * full_potential[j];
            }
        }
    }

    for (int column = 0; column < kDofs; ++column)
    {
        double directional_source[kNodes]{};
        double reduced_directional_source[kReducedPotentialDofs]{};
        double reduced_directional_potential[kReducedPotentialDofs]{};
        double full_directional_potential[kNodes]{};
        for (int j = 0; j < kNodes; ++j)
        {
            directional_source[j] = map[j][column];
            for (int a = 0; a < kReducedPotentialDofs; ++a)
            {
                reduced_directional_source[a] +=
                    basis[j][a] * directional_source[j];
            }
        }
        check(
            solve_three_by_three(
                reduced,
                reduced_directional_source,
                reduced_directional_potential),
            "analytic demagnetizing Hessian solve must be finite");
        for (int j = 0; j < kNodes; ++j)
        {
            for (int a = 0; a < kReducedPotentialDofs; ++a)
            {
                full_directional_potential[j] +=
                    basis[j][a] * reduced_directional_potential[a];
            }
        }
        for (int row = 0; row < kDofs; ++row)
        {
            for (int j = 0; j < kNodes; ++j)
            {
                jet.demag_hessian_j[row][column] +=
                    kMu0 * map[j][row] * full_directional_potential[j];
            }
            jet.hessian_j[row][column] += jet.demag_hessian_j[row][column];
        }
    }
    return jet;
}

Magnetization retract(
    const Magnetization &base,
    const Magnetization &direction,
    double step)
{
    Magnetization result{};
    for (int i = 0; i < kNodes; ++i)
    {
        result[i] = normalized(add(base[i], scale(step, direction[i])));
    }
    return result;
}

DifferenceEstimate second_difference(
    const Tet4 &tet,
    const Model &model,
    const Magnetization &base,
    const Magnetization &direction,
    const EnergyEvaluation &base_energy,
    double step)
{
    const EnergyEvaluation plus =
        evaluate_energy(tet, model, retract(base, direction, step));
    const EnergyEvaluation minus =
        evaluate_energy(tet, model, retract(base, direction, -step));
    DifferenceEstimate estimate{};
    estimate.value_j =
        (plus.total_j - 2.0 * base_energy.total_j + minus.total_j) / (step * step);
    estimate.uncertainty_estimate_j =
        (plus.demag_solve_error_estimate_j +
         2.0 * base_energy.demag_solve_error_estimate_j +
         minus.demag_solve_error_estimate_j +
         plus.roundoff_scale_estimate_j +
         2.0 * base_energy.roundoff_scale_estimate_j +
         minus.roundoff_scale_estimate_j) /
        (step * step);
    check(
        std::isfinite(estimate.value_j) &&
            std::isfinite(estimate.uncertainty_estimate_j),
        "finite-difference estimate and uncertainty estimate must be finite");
    return estimate;
}

double quadratic_form(const double matrix[kDofs][kDofs], const double vector[kDofs])
{
    double value = 0.0;
    for (int row = 0; row < kDofs; ++row)
    {
        for (int column = 0; column < kDofs; ++column)
        {
            value += vector[row] * matrix[row][column] * vector[column];
        }
    }
    return value;
}

void run_case(
    const char *name,
    const Tet4 &tet,
    const Model &model,
    const Magnetization &magnetization,
    const Magnetization &direction,
    bool expect_nonzero_interior_normal)
{
    double flattened_direction[kDofs]{};
    double curvature_correction = 0.0;
    Vec3 average_m = make_vec3(0.0, 0.0, 0.0);
    Vec3 average_xi = make_vec3(0.0, 0.0, 0.0);

    for (int i = 0; i < kNodes; ++i)
    {
        check(
            std::fabs(norm(magnetization[i]) - 1.0) <= 1.0e-14,
            "each base nodal magnetization must have unit length");
        check(
            std::fabs(dot(magnetization[i], direction[i])) <= 1.0e-14,
            "each perturbation must be exactly tangent at its node");
        average_m = add(average_m, scale(0.25, magnetization[i]));
        average_xi = add(average_xi, scale(0.25, direction[i]));
        for (int component = 0; component < kComponents; ++component)
        {
            flattened_direction[dof(i, component)] = direction[i][component];
        }
    }

    const double interior_normal_component =
        dot(normalized(average_m), average_xi);
    if (expect_nonzero_interior_normal)
    {
        check(
            std::fabs(interior_normal_component) > 0.1,
            "textured P1 lift must report its expected nonzero interior normal component");
    }
    else
    {
        check(
            std::fabs(interior_normal_component) <= 1.0e-14,
            "uniform P1 lift must remain tangent in the element interior");
    }

    const EnergyJet jet = analyze_energy(tet, model, magnetization);
    const double ambient_curvature =
        quadratic_form(jet.hessian_j, flattened_direction);
    for (int i = 0; i < kNodes; ++i)
    {
        curvature_correction -=
            dot(magnetization[i], make_vec3(
                jet.gradient_j[dof(i, 0)],
                jet.gradient_j[dof(i, 1)],
                jet.gradient_j[dof(i, 2)])) *
            dot(direction[i], direction[i]);
    }
    const double analytic_second_variation =
        ambient_curvature + curvature_correction;

    double constraint_hessian[kDofs][kDofs]{};
    for (int i = 0; i < kNodes; ++i)
    {
        const Vec3 local_gradient = make_vec3(
            jet.gradient_j[dof(i, 0)],
            jet.gradient_j[dof(i, 1)],
            jet.gradient_j[dof(i, 2)]);
        const double diagonal = -dot(magnetization[i], local_gradient);
        for (int component = 0; component < kComponents; ++component)
        {
            constraint_hessian[dof(i, component)][dof(i, component)] = diagonal;
        }
    }
    const double explicit_constraint_curvature =
        quadratic_form(constraint_hessian, flattened_direction);
    check(
        std::fabs(explicit_constraint_curvature - curvature_correction) <=
            1.0e-12 * std::fabs(curvature_correction) + 1.0e-300,
        "nodal retraction correction must equal its diagonal ambient constraint Hessian");

    double demag_scale = 0.0;
    for (int row = 0; row < kDofs; ++row)
    {
        for (int column = 0; column < kDofs; ++column)
        {
            const double value = std::fabs(jet.demag_hessian_j[row][column]);
            if (value > demag_scale)
            {
                demag_scale = value;
            }
        }
    }
    const double psd_roundoff =
        256.0 * kMachineEpsilon * (demag_scale > 0.0 ? demag_scale : 1.0e-300);
    for (int coordinate = 0; coordinate < kDofs; ++coordinate)
    {
        double basis_vector[kDofs]{};
        basis_vector[coordinate] = 1.0;
        check(
            quadratic_form(jet.demag_hessian_j, basis_vector) >= -psd_roundoff,
            "demagnetizing ambient Hessian coordinate-axis sample must be nonnegative");
    }
    check(
        quadratic_form(jet.demag_hessian_j, flattened_direction) >= -psd_roundoff,
        "demagnetizing Hessian sample must be nonnegative along the nodal tangent direction");

    const double steps[] = {4.0e-2, 2.0e-2, 1.0e-2, 5.0e-3, 2.5e-3};
    DifferenceEstimate differences[5]{};
    for (int i = 0; i < 5; ++i)
    {
        differences[i] = second_difference(
            tet, model, magnetization, direction, jet.energy, steps[i]);
    }

    RichardsonEstimate richardson[4]{};
    for (int i = 0; i < 4; ++i)
    {
        richardson[i].value_j =
            (4.0 * differences[i + 1].value_j - differences[i].value_j) / 3.0;
        richardson[i].uncertainty_estimate_j =
            (4.0 * differences[i + 1].uncertainty_estimate_j +
             differences[i].uncertainty_estimate_j) /
            3.0;
    }

    const double previous_change =
        std::fabs(richardson[2].value_j - richardson[1].value_j);
    const double finest_change =
        std::fabs(richardson[3].value_j - richardson[2].value_j);
    check(
        finest_change <=
            0.5 * previous_change +
                richardson[3].uncertainty_estimate_j +
                richardson[2].uncertainty_estimate_j +
                richardson[1].uncertainty_estimate_j,
        "Richardson differences must contract at the finest measured steps");

    const double comparison_uncertainty_estimate_j =
        4.0 * finest_change / 15.0 +
        2.0 * richardson[3].uncertainty_estimate_j;
    check(
        std::fabs(richardson[3].value_j - analytic_second_variation) <=
            comparison_uncertainty_estimate_j,
        "energy finite difference must match the independent nodal-retraction Hessian within reported estimates");

    std::printf(
        "case=%s analytic_second_variation_J=%.17g richardson_J=%.17g "
        "uncertainty_estimate_J=%.17g previous_change_J=%.17g finest_change_J=%.17g "
        "interior_normal_component=%.17g\n",
        name,
        analytic_second_variation,
        richardson[3].value_j,
        comparison_uncertainty_estimate_j,
        previous_change,
        finest_change,
        interior_normal_component);
}

void run_uniform_anisotropy_sanity(const Tet4 &tet, const Model &base_model)
{
    Model model = base_model;
    model.saturation_a_per_m = 0.0;
    model.exchange_j_per_m = 0.0;
    for (int i = 0; i < kNodes; ++i)
    {
        model.applied_field_a_per_m[i] = make_vec3(0.0, 0.0, 0.0);
    }

    Magnetization magnetization{};
    Magnetization direction{};
    const Vec3 uniform_magnetization = make_vec3(0.0, 0.0, 1.0);
    const Vec3 uniform_direction = make_vec3(1.0, 0.0, 0.0);
    for (int i = 0; i < kNodes; ++i)
    {
        magnetization[i] = uniform_magnetization;
        direction[i] = uniform_direction;
    }

    const EnergyJet jet = analyze_energy(tet, model, magnetization);
    const double m_dot_axis = dot(uniform_magnetization, model.anisotropy_axis);
    const double xi_dot_axis = dot(uniform_direction, model.anisotropy_axis);
    const double expected_energy_j =
        -model.anisotropy_j_per_m3 * tet.volume_m3 * m_dot_axis * m_dot_axis;
    double directional_gradient_j = 0.0;
    for (int i = 0; i < kNodes; ++i)
    {
        for (int component = 0; component < kComponents; ++component)
        {
            directional_gradient_j +=
                jet.gradient_j[dof(i, component)] * uniform_direction[component];
        }
    }
    const double expected_directional_gradient_j =
        -2.0 * model.anisotropy_j_per_m3 * tet.volume_m3 *
        m_dot_axis * xi_dot_axis;
    const double energy_tolerance_j =
        128.0 * kMachineEpsilon * std::fabs(expected_energy_j) + 1.0e-300;
    const double gradient_tolerance_j =
        256.0 * kMachineEpsilon * std::fabs(expected_directional_gradient_j) + 1.0e-300;

    check(
        std::fabs(jet.energy.anisotropy_j - expected_energy_j) <= energy_tolerance_j,
        "uniform nodal anisotropy energy must match -Ku V (m dot u)^2");
    check(
        std::fabs(directional_gradient_j - expected_directional_gradient_j) <=
            gradient_tolerance_j,
        "uniform nodal anisotropy directional gradient must match its analytic derivative");
    std::puts("PASS: uniform_nodal_anisotropy_energy_gradient_sanity");
}

void run_uniform_case(const Tet4 &tet, const Model &model)
{
    Magnetization magnetization{};
    Magnetization direction{};
    for (int i = 0; i < kNodes; ++i)
    {
        magnetization[i] = make_vec3(0.0, 0.0, 1.0);
    }
    direction[0] = make_vec3(0.35, 0.0, 0.0);
    direction[1] = make_vec3(0.0, 0.4, 0.0);
    direction[2] = make_vec3(-0.25, 0.2, 0.0);
    direction[3] = make_vec3(0.1, -0.3, 0.0);
    run_case("uniform", tet, model, magnetization, direction, false);
}

void run_textured_case(const Tet4 &tet, const Model &model)
{
    const double inverse_sqrt_two = 1.0 / std::sqrt(2.0);
    Magnetization magnetization{};
    magnetization[0] = make_vec3(0.0, 0.0, 1.0);
    magnetization[1] = make_vec3(1.0, 0.0, 0.0);
    magnetization[2] = make_vec3(0.0, 1.0, 0.0);
    magnetization[3] = make_vec3(inverse_sqrt_two, 0.0, inverse_sqrt_two);

    Magnetization direction{};
    direction[0] = make_vec3(1.0, 0.0, 0.0);
    direction[1] = make_vec3(0.0, 1.0, 0.0);
    direction[2] = make_vec3(0.0, 0.0, 1.0);
    direction[3] = make_vec3(0.0, 1.0, 0.0);
    run_case("textured_nonstationary", tet, model, magnetization, direction, true);
}

}  // namespace

int main()
{
    const Tet4 tet = make_tet4(1.0e-8);
    const Model model = make_model();
    run_uniform_anisotropy_sanity(tet, model);
    run_uniform_case(tet, model);
    run_textured_case(tet, model);
    std::puts("PASS: nodal_retraction_energy_hessian_algebra_oracle");
    return EXIT_SUCCESS;
}