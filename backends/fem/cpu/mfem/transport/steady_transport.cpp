#include "cpu/mfem/transport/steady_transport.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <vector>

namespace fullmag::fem::transport {
namespace {

constexpr double kHbarJs = 1.054571817e-34;
constexpr double kElementaryChargeC = 1.602176634e-19;

bool active_length(double value)
{
    return std::isfinite(value);
}

void validate_parameters(const SteadyTransportParameters &p)
{
    if (!(std::isfinite(p.sigma_s_spm) && p.sigma_s_spm > 0.0)) {
        throw std::invalid_argument("sigma_s_spm must be finite and positive");
    }
    if (!(std::isfinite(p.polarization_p) && std::abs(p.polarization_p) <= 1.0)) {
        throw std::invalid_argument("polarization_p must be finite and in [-1,1]");
    }
    if (!std::isfinite(p.theta_sh)) {
        throw std::invalid_argument("theta_sh must be finite");
    }
    const auto valid_length = [](double value) {
        return (std::isfinite(value) && value > 0.0) ||
            (std::isinf(value) && value > 0.0);
    };
    if (!valid_length(p.lambda_sf_m) ||
        !valid_length(p.lambda_j_m) ||
        !valid_length(p.lambda_phi_m)) {
        throw std::invalid_argument("active spin-reaction lengths must be positive; disabled is +infinity");
    }
    if (!(std::isfinite(p.gamma_e_per_ts) && p.gamma_e_per_ts > 0.0) ||
        !(std::isfinite(p.saturation_magnetization_apm) &&
            p.saturation_magnetization_apm > 0.0)) {
        throw std::invalid_argument("gamma_e and saturation magnetization must be finite and positive");
    }
    if (!(std::isfinite(p.relative_tolerance) && p.relative_tolerance > 0.0) ||
        p.maximum_iterations <= 0) {
        throw std::invalid_argument("linear solver policy is invalid");
    }
    if (p.interface_model != SpinInterfaceModel::TransparentConformingH1) {
        throw std::invalid_argument(
            "mixing/SML transport requires the unimplemented broken-H1 mortar realization");
    }
    if (p.constitutive_model == TransportConstitutiveModel::Reciprocal) {
        if (!(std::isfinite(p.sigma_parallel_spm) && p.sigma_parallel_spm > 0.0) ||
            !(std::isfinite(p.sigma_perpendicular_spm) && p.sigma_perpendicular_spm > 0.0) ||
            !std::isfinite(p.sigma_ahe_spm)) {
            throw std::invalid_argument(
                "reciprocal charge conductivities must be finite; symmetric terms must be positive");
        }
    }
}

double independent_relative_residual(
    const mfem::Operator &op,
    const mfem::Vector &x,
    const mfem::Vector &rhs)
{
    mfem::Vector residual(rhs.Size());
    op.Mult(x, residual);
    residual -= rhs;
    return residual.Norml2() / std::max(rhs.Norml2(), 1.0);
}

int marker_sum(const mfem::Array<int> &marker)
{
    int sum = 0;
    for (int i = 0; i < marker.Size(); ++i) {
        sum += marker[i];
    }
    return sum;
}

class ReactionMatrixCoefficient final : public mfem::MatrixCoefficient {
public:
    ReactionMatrixCoefficient(
        mfem::VectorCoefficient &magnetization,
        const SteadyTransportParameters &parameters)
        : mfem::MatrixCoefficient(3), magnetization_(magnetization), parameters_(parameters)
    {
    }

    void Eval(
        mfem::DenseMatrix &matrix,
        mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &point) override
    {
        mfem::Vector m(3);
        magnetization_.Eval(m, transformation, point);
        const double norm = m.Norml2();
        if (!(std::isfinite(norm) && norm > 0.0)) {
            mfem::mfem_error("spin transport magnetization is non-finite or zero");
        }
        m /= norm;
        const double sf = parameters_.sigma_s_spm /
            (2.0 * parameters_.lambda_sf_m * parameters_.lambda_sf_m);
        const double exchange = active_length(parameters_.lambda_j_m)
            ? parameters_.sigma_s_spm /
                (2.0 * parameters_.lambda_j_m * parameters_.lambda_j_m)
            : 0.0;
        const double dephasing = active_length(parameters_.lambda_phi_m)
            ? parameters_.sigma_s_spm /
                (2.0 * parameters_.lambda_phi_m * parameters_.lambda_phi_m)
            : 0.0;

        matrix.SetSize(3);
        matrix = 0.0;
        for (int a = 0; a < 3; ++a) {
            for (int b = 0; b < 3; ++b) {
                matrix(a, b) = (a == b ? sf + dephasing : 0.0) -
                    dephasing * m[a] * m[b];
            }
        }
        // R_J = c_J (mu x m) = -c_J [m]_x mu.
        matrix(0, 1) += exchange * m[2];
        matrix(0, 2) -= exchange * m[1];
        matrix(1, 0) -= exchange * m[2];
        matrix(1, 2) += exchange * m[0];
        matrix(2, 0) += exchange * m[1];
        matrix(2, 1) -= exchange * m[0];
    }

private:
    mfem::VectorCoefficient &magnetization_;
    const SteadyTransportParameters &parameters_;
};

class SpinSourceColumnCoefficient final : public mfem::VectorCoefficient {
public:
    SpinSourceColumnCoefficient(
        int spin_component,
        mfem::GridFunction &potential,
        mfem::Coefficient &conductivity,
        mfem::VectorCoefficient &magnetization,
        const SteadyTransportParameters &parameters)
        : mfem::VectorCoefficient(3), spin_component_(spin_component),
          potential_(potential), conductivity_(conductivity),
          magnetization_(magnetization), parameters_(parameters)
    {
    }

    void Eval(
        mfem::Vector &value,
        mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &point) override
    {
        mfem::Vector gradient(3);
        potential_.GetGradient(transformation, gradient);
        mfem::Vector electric_field(gradient);
        electric_field *= -1.0;
        mfem::Vector m(3);
        magnetization_.Eval(m, transformation, point);
        const double m_norm = m.Norml2();
        if (m_norm > 0.0) {
            m /= m_norm;
        }
        const double sigma = conductivity_.Eval(transformation, point);
        value.SetSize(3);
        for (int flow = 0; flow < 3; ++flow) {
            const int k0 = (flow + 1) % 3;
            const int k1 = (flow + 2) % 3;
            double levi_civita_contraction = 0.0;
            if (spin_component_ == k1) {
                levi_civita_contraction += electric_field[k0];
            }
            if (spin_component_ == k0) {
                levi_civita_contraction -= electric_field[k1];
            }
            value[flow] = parameters_.polarization_p * sigma *
                    electric_field[flow] * m[spin_component_] +
                parameters_.theta_sh * sigma * levi_civita_contraction;
        }
    }

private:
    int spin_component_;
    mfem::GridFunction &potential_;
    mfem::Coefficient &conductivity_;
    mfem::VectorCoefficient &magnetization_;
    const SteadyTransportParameters &parameters_;
};

double levi_civita(int i, int j, int k)
{
    if ((i == 0 && j == 1 && k == 2) ||
        (i == 1 && j == 2 && k == 0) ||
        (i == 2 && j == 0 && k == 1)) {
        return 1.0;
    }
    if ((i == 0 && j == 2 && k == 1) ||
        (i == 2 && j == 1 && k == 0) ||
        (i == 1 && j == 0 && k == 2)) {
        return -1.0;
    }
    return 0.0;
}

class CoupledTransportGradientIntegrator final : public mfem::BilinearFormIntegrator {
public:
    CoupledTransportGradientIntegrator(
        mfem::Coefficient &conductivity,
        mfem::VectorCoefficient &magnetization,
        const SteadyTransportParameters &parameters)
        : conductivity_(conductivity), magnetization_(magnetization), parameters_(parameters)
    {
    }

    void AssembleElementMatrix(
        const mfem::FiniteElement &element,
        mfem::ElementTransformation &transformation,
        mfem::DenseMatrix &element_matrix) override
    {
        const int dofs = element.GetDof();
        const int dimension = element.GetDim();
        if (dimension != 3) {
            throw std::invalid_argument("reciprocal FEM transport requires a 3-D element");
        }
        constexpr int components = 4; // V, mu_x, mu_y, mu_z
        element_matrix.SetSize(components * dofs);
        element_matrix = 0.0;

        const int order = std::max(2, 2 * element.GetOrder());
        const mfem::IntegrationRule &rule = mfem::IntRules.Get(
            element.GetGeomType(), order);
        mfem::DenseMatrix physical_gradient(dofs, dimension);
        mfem::Vector m(3);
        double coefficient[4][4][3][3]{};

        for (int q = 0; q < rule.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &point = rule.IntPoint(q);
            transformation.SetIntPoint(&point);
            element.CalcPhysDShape(transformation, physical_gradient);
            magnetization_.Eval(m, transformation, point);
            const double norm = m.Norml2();
            if (!(std::isfinite(norm) && norm > 0.0)) {
                throw std::invalid_argument(
                    "reciprocal FEM transport magnetization is non-finite or zero");
            }
            m /= norm;
            const double sigma = conductivity_.Eval(transformation, point);
            const double weight = point.weight * transformation.Weight();
            if (!(std::isfinite(sigma) && sigma > 0.0 && std::isfinite(weight))) {
                throw std::invalid_argument(
                    "reciprocal FEM transport conductivity or quadrature weight is invalid");
            }
            for (int row = 0; row < components; ++row) {
                for (int column = 0; column < components; ++column) {
                    for (int i = 0; i < dimension; ++i) {
                        for (int j = 0; j < dimension; ++j) {
                            coefficient[row][column][i][j] = 0.0;
                        }
                    }
                }
            }

            for (int i = 0; i < dimension; ++i) {
                for (int j = 0; j < dimension; ++j) {
                    coefficient[0][0][i][j] =
                        parameters_.sigma_perpendicular_spm * (i == j ? 1.0 : 0.0) +
                        (parameters_.sigma_parallel_spm -
                            parameters_.sigma_perpendicular_spm) * m[i] * m[j];
                    for (int k = 0; k < dimension; ++k) {
                        coefficient[0][0][i][j] += parameters_.sigma_ahe_spm *
                            levi_civita(i, k, j) * m[k];
                    }
                }
            }
            for (int spin_component = 0; spin_component < 3; ++spin_component) {
                for (int i = 0; i < dimension; ++i) {
                    for (int j = 0; j < dimension; ++j) {
                        coefficient[0][spin_component + 1][i][j] =
                            0.5 * parameters_.polarization_p * sigma *
                                m[spin_component] * (i == j ? 1.0 : 0.0) +
                            0.5 * parameters_.theta_sh * sigma *
                                levi_civita(i, j, spin_component);
                        coefficient[spin_component + 1][0][i][j] =
                            parameters_.polarization_p * sigma *
                                m[spin_component] * (i == j ? 1.0 : 0.0) +
                            parameters_.theta_sh * sigma *
                                levi_civita(i, j, spin_component);
                        coefficient[spin_component + 1][spin_component + 1][i][j] =
                            0.5 * parameters_.sigma_s_spm * (i == j ? 1.0 : 0.0);
                    }
                }
            }

            for (int test_dof = 0; test_dof < dofs; ++test_dof) {
                for (int trial_dof = 0; trial_dof < dofs; ++trial_dof) {
                    for (int row = 0; row < components; ++row) {
                        for (int column = 0; column < components; ++column) {
                            double value = 0.0;
                            for (int i = 0; i < dimension; ++i) {
                                for (int j = 0; j < dimension; ++j) {
                                    value += physical_gradient(test_dof, i) *
                                        coefficient[row][column][i][j] *
                                        physical_gradient(trial_dof, j);
                                }
                            }
                            element_matrix(
                                row * dofs + test_dof,
                                column * dofs + trial_dof) += weight * value;
                        }
                    }
                }
            }
        }
    }

private:
    mfem::Coefficient &conductivity_;
    mfem::VectorCoefficient &magnetization_;
    const SteadyTransportParameters &parameters_;
};

class CoupledReactionMatrixCoefficient final : public mfem::MatrixCoefficient {
public:
    CoupledReactionMatrixCoefficient(
        mfem::VectorCoefficient &magnetization,
        const SteadyTransportParameters &parameters)
        : mfem::MatrixCoefficient(4), magnetization_(magnetization), parameters_(parameters)
    {
    }

    void Eval(
        mfem::DenseMatrix &matrix,
        mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &point) override
    {
        ReactionMatrixCoefficient reaction(magnetization_, parameters_);
        mfem::DenseMatrix spin_reaction;
        reaction.Eval(spin_reaction, transformation, point);
        matrix.SetSize(4);
        matrix = 0.0;
        for (int row = 0; row < 3; ++row) {
            for (int column = 0; column < 3; ++column) {
                matrix(row + 1, column + 1) = spin_reaction(row, column);
            }
        }
    }

private:
    mfem::VectorCoefficient &magnetization_;
    const SteadyTransportParameters &parameters_;
};

class CoupledBoundaryCoefficient final : public mfem::VectorCoefficient {
public:
    CoupledBoundaryCoefficient(
        const mfem::Array<int> &charge_marker,
        mfem::Coefficient &boundary_potential,
        const mfem::Array<int> &spin_marker,
        mfem::VectorCoefficient *boundary_spin_potential)
        : mfem::VectorCoefficient(4), charge_marker_(charge_marker),
          boundary_potential_(boundary_potential), spin_marker_(spin_marker),
          boundary_spin_potential_(boundary_spin_potential)
    {
    }

    void Eval(
        mfem::Vector &value,
        mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &point) override
    {
        value.SetSize(4);
        value = 0.0;
        const int attribute = transformation.Attribute;
        if (attribute <= 0 || attribute > charge_marker_.Size()) {
            return;
        }
        const int index = attribute - 1;
        if (charge_marker_[index] != 0) {
            value[0] = boundary_potential_.Eval(transformation, point);
        }
        if (spin_marker_[index] != 0 && boundary_spin_potential_ != nullptr) {
            mfem::Vector spin(3);
            boundary_spin_potential_->Eval(spin, transformation, point);
            for (int component = 0; component < 3; ++component) {
                value[component + 1] = spin[component];
            }
        }
    }

private:
    const mfem::Array<int> &charge_marker_;
    mfem::Coefficient &boundary_potential_;
    const mfem::Array<int> &spin_marker_;
    mfem::VectorCoefficient *boundary_spin_potential_;
};

} // namespace

class SteadyTransportOracle::Impl {
public:
    Impl(
        mfem::Mesh &mesh,
        mfem::Coefficient &charge_conductivity,
        mfem::VectorCoefficient &magnetization,
        const SteadyTransportParameters &parameters)
        : mesh(mesh), conductivity(charge_conductivity), magnetization(magnetization),
          parameters(parameters), collection(1, mesh.Dimension()),
          scalar_space(&mesh, &collection), vector_space(&mesh, &collection, 3, mfem::Ordering::byNODES),
          tensor_space(&mesh, &collection, 9, mfem::Ordering::byNODES),
          coupled_space(&mesh, &collection, 4, mfem::Ordering::byNODES),
          potential(&scalar_space), current(&vector_space), spin(&vector_space),
          spin_current(&tensor_space), torque(&vector_space), coupled_state(&coupled_space)
    {
        validate_parameters(parameters);
        if (mesh.Dimension() != 3) {
            throw std::invalid_argument("the M1.3 FEM oracle currently requires a three-dimensional mesh");
        }
        potential = 0.0;
        current = 0.0;
        spin = 0.0;
        spin_current = 0.0;
        torque = 0.0;
        coupled_state = 0.0;
        validate_material_coefficients();
    }

    void validate_material_coefficients()
    {
        for (int element = 0; element < mesh.GetNE(); ++element) {
            auto *transformation = mesh.GetElementTransformation(element);
            const auto &rule = mfem::IntRules.Get(mesh.GetElementBaseGeometry(element), 2);
            for (int q = 0; q < rule.GetNPoints(); ++q) {
                const auto &point = rule.IntPoint(q);
                transformation->SetIntPoint(&point);
                const double sigma = conductivity.Eval(*transformation, point);
                if (!(std::isfinite(sigma) && sigma > 0.0)) {
                    throw std::invalid_argument("charge conductivity must be finite and positive");
                }
                if (parameters.constitutive_model == TransportConstitutiveModel::Reciprocal) {
                    const double minimum_charge_conductivity = std::min(
                        parameters.sigma_parallel_spm, parameters.sigma_perpendicular_spm);
                    if (!(minimum_charge_conductivity * parameters.sigma_s_spm -
                            parameters.polarization_p * parameters.polarization_p * sigma * sigma > 0.0)) {
                        throw std::invalid_argument(
                            "reciprocal spin material violates the positive Schur complement");
                    }
                } else if (!(parameters.sigma_s_spm -
                        parameters.polarization_p * parameters.polarization_p * sigma > 0.0)) {
                    throw std::invalid_argument("spin material violates sigma_s-P^2 sigma>0");
                }
            }
        }
    }

    ChargeSolveDiagnostics solve_charge(
        const mfem::Array<int> &marker,
        mfem::Coefficient &boundary_potential,
        ChargeGauge gauge)
    {
        if (parameters.constitutive_model != TransportConstitutiveModel::OneWay) {
            throw std::invalid_argument(
                "reciprocal transport requires the monolithic solve_reciprocal entry point");
        }
        if (marker.Size() != mesh.bdr_attributes.Max()) {
            throw std::invalid_argument("charge boundary marker size does not match mesh attributes");
        }
        const int marked_boundaries = marker_sum(marker);
        if (gauge == ChargeGauge::Missing ||
            (gauge == ChargeGauge::BoundaryReference && marked_boundaries == 0)) {
            throw std::invalid_argument("charge transport requires a boundary reference or zero-mean gauge");
        }
        if (gauge == ChargeGauge::ZeroMeanPotential && marked_boundaries > 0) {
            throw std::invalid_argument(
                "zero-mean charge gauge conflicts with fixed-potential boundaries");
        }

        potential = 0.0;
        if (marked_boundaries > 0) {
            potential.ProjectBdrCoefficient(boundary_potential, marker);
        }
        mfem::BilinearForm form(&scalar_space);
        form.AddDomainIntegrator(new mfem::DiffusionIntegrator(conductivity));
        form.Assemble();
        mfem::LinearForm rhs(&scalar_space);
        rhs = 0.0;
        rhs.Assemble();

        mfem::Array<int> essential_true_dofs;
        if (marked_boundaries > 0) {
            scalar_space.GetEssentialTrueDofs(marker, essential_true_dofs);
        } else {
            essential_true_dofs.SetSize(1);
            essential_true_dofs[0] = 0;
        }
        mfem::OperatorPtr system_operator;
        mfem::Vector solution, system_rhs;
        form.FormLinearSystem(
            essential_true_dofs, potential, rhs, system_operator, solution, system_rhs);
        auto &matrix = dynamic_cast<mfem::SparseMatrix &>(*system_operator.Ptr());
        mfem::GSSmoother preconditioner(matrix);
        mfem::CGSolver solver;
        solver.SetOperator(matrix);
        solver.SetPreconditioner(preconditioner);
        solver.SetRelTol(parameters.relative_tolerance);
        solver.SetAbsTol(0.0);
        solver.SetMaxIter(parameters.maximum_iterations);
        solver.SetPrintLevel(0);
        solver.Mult(system_rhs, solution);
        const double residual = independent_relative_residual(matrix, solution, system_rhs);
        form.RecoverFEMSolution(solution, rhs, potential);
        project_charge_current();

        if (gauge == ChargeGauge::ZeroMeanPotential) {
            mfem::LinearForm mass_weights(&scalar_space);
            mfem::ConstantCoefficient one(1.0);
            mass_weights.AddDomainIntegrator(new mfem::DomainLFIntegrator(one));
            mass_weights.Assemble();
            const double volume = mass_weights.Sum();
            const double mean = (mass_weights * potential) / volume;
            potential -= mean;
        }

        ChargeSolveDiagnostics diagnostics;
        diagnostics.converged = solver.GetConverged();
        diagnostics.iterations = solver.GetNumIterations();
        diagnostics.relative_residual = residual;
        accumulate_charge_diagnostics(diagnostics);
        return diagnostics;
    }

    SpinSolveDiagnostics solve_spin(
        const mfem::Array<int> &marker,
        mfem::VectorCoefficient *boundary_spin_potential)
    {
        if (parameters.constitutive_model != TransportConstitutiveModel::OneWay) {
            throw std::invalid_argument(
                "reciprocal transport requires the monolithic solve_reciprocal entry point");
        }
        if (marker.Size() != mesh.bdr_attributes.Max()) {
            throw std::invalid_argument("spin boundary marker size does not match mesh attributes");
        }
        const int marked_boundaries = marker_sum(marker);
        if (marked_boundaries > 0 && boundary_spin_potential == nullptr) {
            throw std::invalid_argument("specified spin-potential boundaries require a value");
        }
        if (!active_length(parameters.lambda_sf_m) && !active_length(parameters.lambda_j_m) &&
            !active_length(parameters.lambda_phi_m) && marked_boundaries == 0) {
            throw std::invalid_argument("spin operator has an unremoved constant nullspace");
        }

        spin = 0.0;
        if (marked_boundaries > 0) {
            spin.ProjectBdrCoefficient(*boundary_spin_potential, marker);
        }
        mfem::ConstantCoefficient diffusion(0.5 * parameters.sigma_s_spm);
        ReactionMatrixCoefficient reaction(magnetization, parameters);
        mfem::BilinearForm form(&vector_space);
        form.AddDomainIntegrator(new mfem::VectorDiffusionIntegrator(diffusion));
        form.AddDomainIntegrator(new mfem::VectorMassIntegrator(reaction));
        form.Assemble();

        mfem::LinearForm rhs(&vector_space);
        rhs = 0.0;
        for (int component = 0; component < 3; ++component) {
            auto *source = new SpinSourceColumnCoefficient(
                component, potential, conductivity, magnetization, parameters);
            source_coefficients.emplace_back(source);
            mfem::LinearForm component_rhs(&scalar_space);
            component_rhs.AddDomainIntegrator(new mfem::DomainLFGradIntegrator(*source));
            component_rhs.Assemble();
            for (int dof = 0; dof < scalar_space.GetVSize(); ++dof) {
                rhs[component * scalar_space.GetVSize() + dof] = component_rhs[dof];
            }
        }

        mfem::Array<int> essential_true_dofs;
        if (marked_boundaries > 0) {
            vector_space.GetEssentialTrueDofs(marker, essential_true_dofs);
        }
        mfem::OperatorPtr system_operator;
        mfem::Vector solution, system_rhs;
        form.FormLinearSystem(
            essential_true_dofs, spin, rhs, system_operator, solution, system_rhs);
        mfem::GMRESSolver solver;
        solver.SetOperator(*system_operator.Ptr());
        solver.SetRelTol(parameters.relative_tolerance);
        solver.SetAbsTol(0.0);
        solver.SetMaxIter(parameters.maximum_iterations);
        solver.SetKDim(100);
        solver.SetPrintLevel(0);
        solver.Mult(system_rhs, solution);
        const double residual = independent_relative_residual(
            *system_operator.Ptr(), solution, system_rhs);
        form.RecoverFEMSolution(solution, rhs, spin);
        project_spin_current();
        mfem::Vector full_weak_residual(rhs.Size());
        form.Mult(spin, full_weak_residual);
        full_weak_residual -= rhs;
        last_spin_weak_balance = {0.0, 0.0, 0.0};
        for (int component = 0; component < 3; ++component) {
            for (int dof = 0; dof < scalar_space.GetVSize(); ++dof) {
                last_spin_weak_balance[component] +=
                    full_weak_residual[component * scalar_space.GetVSize() + dof];
            }
        }
        source_coefficients.clear();

        SpinSolveDiagnostics diagnostics;
        diagnostics.converged = solver.GetConverged();
        diagnostics.iterations = solver.GetNumIterations();
        diagnostics.relative_residual = residual;
        accumulate_spin_diagnostics(diagnostics);
        project_torque(diagnostics);
        return diagnostics;
    }

    ReciprocalSolveDiagnostics solve_reciprocal(
        const mfem::Array<int> &charge_marker,
        mfem::Coefficient &boundary_potential,
        const mfem::Array<int> &spin_marker,
        mfem::VectorCoefficient *boundary_spin_potential,
        ChargeGauge gauge)
    {
        if (parameters.constitutive_model != TransportConstitutiveModel::Reciprocal) {
            throw std::invalid_argument(
                "solve_reciprocal requires reciprocal constitutive parameters");
        }
        if (charge_marker.Size() != mesh.bdr_attributes.Max() ||
            spin_marker.Size() != mesh.bdr_attributes.Max()) {
            throw std::invalid_argument(
                "reciprocal charge and spin boundary marker sizes must match mesh attributes");
        }
        if (gauge == ChargeGauge::Missing ||
            (gauge == ChargeGauge::BoundaryReference && marker_sum(charge_marker) == 0)) {
            throw std::invalid_argument(
                "reciprocal charge transport requires a boundary reference or zero-mean gauge");
        }
        if (gauge == ChargeGauge::ZeroMeanPotential) {
            throw std::invalid_argument(
                "reciprocal FEM reference lane currently requires a Dirichlet charge reference");
        }
        if (marker_sum(spin_marker) > 0 && boundary_spin_potential == nullptr) {
            throw std::invalid_argument(
                "reciprocal spin Dirichlet boundaries require a value coefficient");
        }
        if (marker_sum(spin_marker) == 0 &&
            !active_length(parameters.lambda_sf_m) &&
            !active_length(parameters.lambda_j_m) &&
            !active_length(parameters.lambda_phi_m)) {
            throw std::invalid_argument(
                "reciprocal spin operator has an unremoved constant nullspace");
        }

        mfem::Array<int> combined_marker(mesh.bdr_attributes.Max());
        combined_marker = 0;
        for (int boundary = 0; boundary < combined_marker.Size(); ++boundary) {
            combined_marker[boundary] =
                (charge_marker[boundary] != 0 || spin_marker[boundary] != 0) ? 1 : 0;
        }
        CoupledBoundaryCoefficient boundary_values(
            charge_marker, boundary_potential, spin_marker, boundary_spin_potential);
        coupled_state = 0.0;
        coupled_state.ProjectBdrCoefficient(boundary_values, combined_marker);

        mfem::BilinearForm form(&coupled_space);
        form.AddDomainIntegrator(new CoupledTransportGradientIntegrator(
            conductivity, magnetization, parameters));
        CoupledReactionMatrixCoefficient reaction(magnetization, parameters);
        form.AddDomainIntegrator(new mfem::VectorMassIntegrator(reaction));
        form.Assemble();

        mfem::LinearForm rhs(&coupled_space);
        rhs = 0.0;
        rhs.Assemble();
        mfem::Array<int> essential_true_dofs;
        // Charge and spin Dirichlet data are component-wise.  Passing the
        // union marker without a component would constrain all four fields
        // and silently impose zero on the field that was not prescribed on a
        // given boundary.
        mfem::Array<int> essential_true_dof_marker(coupled_space.GetTrueVSize());
        essential_true_dof_marker = 0;
        mfem::Array<int> component_true_dofs;
        const auto mark_component_dofs = [&](const mfem::Array<int> &marker, int component) {
            coupled_space.GetEssentialTrueDofs(marker, component_true_dofs, component);
            for (int index = 0; index < component_true_dofs.Size(); ++index) {
                essential_true_dof_marker[component_true_dofs[index]] = 1;
            }
        };
        mark_component_dofs(charge_marker, 0);
        for (int component = 1; component < 4; ++component) {
            mark_component_dofs(spin_marker, component);
        }
        int essential_count = 0;
        for (int index = 0; index < essential_true_dof_marker.Size(); ++index) {
            essential_count += essential_true_dof_marker[index] != 0 ? 1 : 0;
        }
        essential_true_dofs.SetSize(essential_count);
        int essential_index = 0;
        for (int index = 0; index < essential_true_dof_marker.Size(); ++index) {
            if (essential_true_dof_marker[index] != 0) {
                essential_true_dofs[essential_index++] = index;
            }
        }
        mfem::OperatorPtr system_operator;
        mfem::Vector solution, system_rhs;
        form.FormLinearSystem(
            essential_true_dofs, coupled_state, rhs, system_operator, solution, system_rhs);
        mfem::GMRESSolver solver;
        solver.SetOperator(*system_operator.Ptr());
        solver.SetRelTol(parameters.relative_tolerance);
        solver.SetAbsTol(0.0);
        solver.SetMaxIter(parameters.maximum_iterations);
        solver.SetKDim(std::min(100, std::max(1, parameters.maximum_iterations)));
        solver.SetPrintLevel(0);
        solver.Mult(system_rhs, solution);

        double relative_residual = std::numeric_limits<double>::infinity();
        if (system_rhs.Size() == 0) {
            relative_residual = 0.0;
        } else {
            mfem::Vector residual(system_rhs.Size());
            system_operator->Mult(solution, residual);
            residual -= system_rhs;
            const double scale = system_rhs.Norml2();
            relative_residual = residual.Norml2() /
                (scale > 0.0 ? scale : std::numeric_limits<double>::min());
        }
        form.RecoverFEMSolution(solution, rhs, coupled_state);
        for (int dof = 0; dof < scalar_space.GetVSize(); ++dof) {
            potential[dof] = coupled_state[coupled_space.DofToVDof(dof, 0)];
            for (int component = 0; component < 3; ++component) {
                spin[spin.FESpace()->DofToVDof(dof, component)] =
                    coupled_state[coupled_space.DofToVDof(dof, component + 1)];
            }
        }

        mfem::Vector weak_residual(coupled_state.Size());
        form.Mult(coupled_state, weak_residual);
        weak_residual -= rhs;
        last_spin_weak_balance = {0.0, 0.0, 0.0};
        for (int dof = 0; dof < scalar_space.GetVSize(); ++dof) {
            for (int component = 0; component < 3; ++component) {
                last_spin_weak_balance[component] +=
                    weak_residual[coupled_space.DofToVDof(dof, component + 1)];
            }
        }

        project_charge_current();
        project_spin_current();
        ReciprocalSolveDiagnostics diagnostics;
        diagnostics.charge.converged = solver.GetConverged();
        diagnostics.charge.iterations = solver.GetNumIterations();
        diagnostics.charge.relative_residual = relative_residual;
        diagnostics.spin.converged = solver.GetConverged();
        diagnostics.spin.iterations = solver.GetNumIterations();
        diagnostics.spin.relative_residual = relative_residual;
        accumulate_charge_diagnostics(diagnostics.charge);
        accumulate_spin_diagnostics(diagnostics.spin);
        project_torque(diagnostics.spin);
        return diagnostics;
    }

    void constitutive_response(
        mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &point,
        mfem::Vector &charge,
        mfem::DenseMatrix &spin_current_value)
    {
        mfem::Vector grad_v(3);
        potential.GetGradient(transformation, grad_v);
        mfem::Vector electric_field(grad_v);
        electric_field *= -1.0;
        mfem::DenseMatrix grad_mu;
        spin.GetVectorGradient(transformation, grad_mu);
        mfem::Vector m(3);
        magnetization.Eval(m, transformation, point);
        const double norm = m.Norml2();
        if (!(std::isfinite(norm) && norm > 0.0)) {
            throw std::invalid_argument("transport magnetization is non-finite or zero");
        }
        m /= norm;
        const double sigma = conductivity.Eval(transformation, point);
        charge.SetSize(3);
        spin_current_value.SetSize(3);
        charge = 0.0;
        spin_current_value = 0.0;
        if (parameters.constitutive_model == TransportConstitutiveModel::OneWay) {
            for (int flow = 0; flow < 3; ++flow) {
                charge[flow] = sigma * electric_field[flow];
                for (int component = 0; component < 3; ++component) {
                    double she = 0.0;
                    for (int k = 0; k < 3; ++k) {
                        she += parameters.theta_sh * sigma *
                            levi_civita(flow, k, component) * electric_field[k];
                    }
                    spin_current_value(flow, component) =
                        -0.5 * parameters.sigma_s_spm * grad_mu(component, flow) +
                        parameters.polarization_p * sigma * electric_field[flow] *
                            m[component] + she;
                }
            }
            return;
        }

        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                const double sigma_mr =
                    parameters.sigma_perpendicular_spm * (i == j ? 1.0 : 0.0) +
                    (parameters.sigma_parallel_spm - parameters.sigma_perpendicular_spm) *
                        m[i] * m[j];
                charge[i] += sigma_mr * electric_field[j];
                for (int k = 0; k < 3; ++k) {
                    charge[i] += parameters.sigma_ahe_spm *
                        levi_civita(i, k, j) * m[k] * electric_field[j];
                }
            }
            for (int component = 0; component < 3; ++component) {
                const double g = -0.5 * grad_mu(component, i);
                charge[i] += parameters.polarization_p * sigma * m[component] * g;
                for (int j = 0; j < 3; ++j) {
                    charge[i] += parameters.theta_sh * sigma *
                        levi_civita(i, j, component) *
                        (-0.5 * grad_mu(component, j));
                }
            }
        }
        for (int i = 0; i < 3; ++i) {
            for (int component = 0; component < 3; ++component) {
                spin_current_value(i, component) =
                    parameters.sigma_s_spm * (-0.5 * grad_mu(component, i)) +
                    parameters.polarization_p * sigma * electric_field[i] *
                        m[component];
                for (int k = 0; k < 3; ++k) {
                    spin_current_value(i, component) += parameters.theta_sh * sigma *
                        levi_civita(i, k, component) * electric_field[k];
                }
            }
        }
    }

    void source_matrix(
        mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &point,
        mfem::DenseMatrix &source)
    {
        source.SetSize(3);
        for (int a = 0; a < 3; ++a) {
            SpinSourceColumnCoefficient column(
                a, potential, conductivity, magnetization, parameters);
            mfem::Vector values(3);
            column.Eval(values, transformation, point);
            for (int i = 0; i < 3; ++i) {
                source(i, a) = values[i];
            }
        }
    }

    void project_charge_current()
    {
        class ChargeCurrentCoefficient final : public mfem::VectorCoefficient {
        public:
            explicit ChargeCurrentCoefficient(Impl &owner)
                : mfem::VectorCoefficient(3), owner_(owner)
            {
            }

            void Eval(
                mfem::Vector &value,
                mfem::ElementTransformation &transformation,
                const mfem::IntegrationPoint &point) override
            {
                mfem::DenseMatrix spin_current;
                owner_.constitutive_response(transformation, point, value, spin_current);
            }

        private:
            Impl &owner_;
        } coefficient(*this);

        current.ProjectCoefficient(coefficient);
    }

    void project_spin_current()
    {
        class SpinCurrentCoefficient final : public mfem::VectorCoefficient {
        public:
            explicit SpinCurrentCoefficient(Impl &owner)
                : mfem::VectorCoefficient(9), owner_(owner)
            {
            }

            void Eval(
                mfem::Vector &value,
                mfem::ElementTransformation &transformation,
                const mfem::IntegrationPoint &point) override
            {
                mfem::DenseMatrix gradient;
                mfem::Vector charge;
                owner_.constitutive_response(transformation, point, charge, gradient);
                value.SetSize(9);
                for (int flow = 0; flow < 3; ++flow) {
                    for (int component = 0; component < 3; ++component) {
                        value[flow * 3 + component] = gradient(flow, component);
                    }
                }
            }

        private:
            Impl &owner_;
        } coefficient(*this);

        spin_current.ProjectCoefficient(coefficient);
    }

    void accumulate_charge_diagnostics(ChargeSolveDiagnostics &diagnostics)
    {
        mfem::Vector volume_current(3);
        volume_current = 0.0;
        double volume = 0.0;
        for (int element = 0; element < mesh.GetNE(); ++element) {
            auto *transformation = mesh.GetElementTransformation(element);
            const auto &rule = mfem::IntRules.Get(
                mesh.GetElementBaseGeometry(element), 4);
            for (int q = 0; q < rule.GetNPoints(); ++q) {
                const auto &point = rule.IntPoint(q);
                transformation->SetIntPoint(&point);
                mfem::Vector charge(3);
                mfem::DenseMatrix spin_current;
                constitutive_response(*transformation, point, charge, spin_current);
                const double weight = point.weight * transformation->Weight();
                volume_current.Add(weight, charge);
                volume += weight;
            }
        }
        for (int i = 0; i < 3; ++i) {
            diagnostics.current_density_volume_average_apm2[i] = volume_current[i] / volume;
        }

        double boundary_current = 0.0;
        for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
            auto *face = mesh.GetBdrFaceTransformations(boundary);
            if (face == nullptr || face->Elem1 == nullptr) {
                continue;
            }
            const auto &rule = mfem::IntRules.Get(
                mesh.GetBdrElementBaseGeometry(boundary), 4);
            for (int q = 0; q < rule.GetNPoints(); ++q) {
                const auto &face_point = rule.IntPoint(q);
                mfem::IntegrationPoint element_point;
                face->Loc1.Transform(face_point, element_point);
                face->Elem1->SetIntPoint(&element_point);
                mfem::Vector charge(3);
                mfem::DenseMatrix spin_current;
                constitutive_response(*face->Elem1, element_point, charge, spin_current);
                mfem::Vector normal(3);
                face->Face->SetIntPoint(&face_point);
                mfem::CalcOrtho(face->Face->Jacobian(), normal);
                boundary_current += (charge * normal) * face_point.weight;
            }
        }
        diagnostics.net_boundary_current_a = boundary_current;
    }

    void accumulate_spin_diagnostics(SpinSolveDiagnostics &diagnostics)
    {
        double top_y = 0.0;
        double bottom_y = 0.0;
        double top_area = 0.0;
        double bottom_area = 0.0;
        for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
            auto *face = mesh.GetBdrFaceTransformations(boundary);
            if (face == nullptr || face->Elem1 == nullptr) {
                continue;
            }
            const auto &rule = mfem::IntRules.Get(
                mesh.GetBdrElementBaseGeometry(boundary), 4);
            for (int q = 0; q < rule.GetNPoints(); ++q) {
                const auto &face_point = rule.IntPoint(q);
                mfem::IntegrationPoint element_point;
                face->Loc1.Transform(face_point, element_point);
                face->Elem1->SetIntPoint(&element_point);
                mfem::Vector charge;
                mfem::DenseMatrix spin_current_value;
                constitutive_response(*face->Elem1, element_point, charge, spin_current_value);
                mfem::Vector normal(3);
                face->Face->SetIntPoint(&face_point);
                mfem::CalcOrtho(face->Face->Jacobian(), normal);
                for (int a = 0; a < 3; ++a) {
                    double flux = 0.0;
                    for (int i = 0; i < 3; ++i) {
                        flux += normal[i] * spin_current_value(i, a);
                    }
                    diagnostics.boundary_spin_flux_a[a] += face_point.weight * flux;
                }
                mfem::Vector mu(3);
                spin.GetVectorValue(*face->Elem1, element_point, mu);
                const double area_weight = face_point.weight * normal.Norml2();
                if (normal[2] < 0.0 &&
                    std::abs(normal[2]) >= std::max(std::abs(normal[0]), std::abs(normal[1]))) {
                    bottom_y += area_weight * mu[1];
                    bottom_area += area_weight;
                } else if (normal[2] > 0.0 &&
                    std::abs(normal[2]) >= std::max(std::abs(normal[0]), std::abs(normal[1]))) {
                    top_y += area_weight * mu[1];
                    top_area += area_weight;
                }
            }
        }
        if (top_area > 0.0 && bottom_area > 0.0) {
            diagnostics.spin_potential_top_minus_bottom_v[1] =
                top_y / top_area - bottom_y / bottom_area;
        }

        ReactionMatrixCoefficient reaction(magnetization, parameters);
        for (int element = 0; element < mesh.GetNE(); ++element) {
            auto *transformation = mesh.GetElementTransformation(element);
            const auto &rule = mfem::IntRules.Get(
                mesh.GetElementBaseGeometry(element), 4);
            for (int q = 0; q < rule.GetNPoints(); ++q) {
                const auto &point = rule.IntPoint(q);
                transformation->SetIntPoint(&point);
                mfem::Vector mu(3);
                spin.GetVectorValue(*transformation, point, mu);
                mfem::DenseMatrix matrix;
                reaction.Eval(matrix, *transformation, point);
                mfem::Vector sink(3);
                matrix.Mult(mu, sink);
                const double weight = point.weight * transformation->Weight();
                for (int a = 0; a < 3; ++a) {
                    diagnostics.reaction_integral_a[a] += weight * sink[a];
                }
            }
        }
        for (int a = 0; a < 3; ++a) {
            // Summing the independently reassembled weak residual against the
            // partition-of-unity test gives the conservative global balance.
            // Raw P1 element gradients are not an equilibrated boundary flux;
            // the contact flux is therefore recovered from this weak balance.
            diagnostics.angular_momentum_balance_apm2[a] = last_spin_weak_balance[a];
            diagnostics.boundary_spin_flux_a[a] =
                last_spin_weak_balance[a] - diagnostics.reaction_integral_a[a];
        }
    }

    void project_torque(SpinSolveDiagnostics &diagnostics)
    {
        class TorqueCoefficient final : public mfem::VectorCoefficient {
        public:
            TorqueCoefficient(
                mfem::GridFunction &spin,
                mfem::VectorCoefficient &magnetization,
                const SteadyTransportParameters &parameters)
                : mfem::VectorCoefficient(3), spin_(spin), magnetization_(magnetization),
                  parameters_(parameters)
            {
            }

            void Eval(
                mfem::Vector &value,
                mfem::ElementTransformation &transformation,
                const mfem::IntegrationPoint &point) override
            {
                mfem::Vector mu(3), m(3);
                spin_.GetVectorValue(transformation, point, mu);
                magnetization_.Eval(m, transformation, point);
                const double norm = m.Norml2();
                if (norm > 0.0) {
                    m /= norm;
                }
                mfem::Vector exchange(3), dephasing(3);
                exchange = 0.0;
                dephasing = 0.0;
                if (active_length(parameters_.lambda_j_m)) {
                    mfem::Vector cross(3);
                    cross[0] = mu[1] * m[2] - mu[2] * m[1];
                    cross[1] = mu[2] * m[0] - mu[0] * m[2];
                    cross[2] = mu[0] * m[1] - mu[1] * m[0];
                    exchange.Set(
                        parameters_.sigma_s_spm /
                            (2.0 * parameters_.lambda_j_m * parameters_.lambda_j_m),
                        cross);
                }
                if (active_length(parameters_.lambda_phi_m)) {
                    dephasing = mu;
                    dephasing.Add(-(mu * m), m);
                    dephasing *= parameters_.sigma_s_spm /
                        (2.0 * parameters_.lambda_phi_m * parameters_.lambda_phi_m);
                }
                value = exchange;
                value += dephasing;
                value *= -parameters_.gamma_e_per_ts /
                    parameters_.saturation_magnetization_apm *
                    (kHbarJs / (2.0 * kElementaryChargeC));
            }

        private:
            mfem::GridFunction &spin_;
            mfem::VectorCoefficient &magnetization_;
            const SteadyTransportParameters &parameters_;
        } torque_coefficient(spin, magnetization, parameters);

        mfem::ConstantCoefficient one(1.0);
        mfem::BilinearForm mass_form(&vector_space);
        mass_form.AddDomainIntegrator(new mfem::VectorMassIntegrator(one));
        mass_form.Assemble();
        mfem::LinearForm torque_load(&vector_space);
        torque_load.AddDomainIntegrator(new mfem::VectorDomainLFIntegrator(torque_coefficient));
        torque_load.Assemble();
        mfem::Array<int> no_essential_dofs;
        mfem::OperatorPtr mass_operator;
        mfem::Vector projected, load;
        torque = 0.0;
        mass_form.FormLinearSystem(
            no_essential_dofs, torque, torque_load, mass_operator, projected, load);
        auto &mass_matrix = dynamic_cast<mfem::SparseMatrix &>(*mass_operator.Ptr());
        mfem::GSSmoother mass_preconditioner(mass_matrix);
        mfem::CGSolver projection_solver;
        projection_solver.SetOperator(mass_matrix);
        projection_solver.SetPreconditioner(mass_preconditioner);
        projection_solver.SetRelTol(parameters.relative_tolerance);
        projection_solver.SetAbsTol(0.0);
        projection_solver.SetMaxIter(parameters.maximum_iterations);
        projection_solver.SetPrintLevel(0);
        projection_solver.Mult(load, projected);
        if (!projection_solver.GetConverged()) {
            throw std::runtime_error("consistent L2 transport-torque projection did not converge");
        }
        mass_form.RecoverFEMSolution(projected, torque_load, torque);
        mfem::Vector integral(3);
        integral = 0.0;
        double squared_norm = 0.0;
        double volume = 0.0;
        for (int element = 0; element < mesh.GetNE(); ++element) {
            auto *transformation = mesh.GetElementTransformation(element);
            const auto &rule = mfem::IntRules.Get(
                mesh.GetElementBaseGeometry(element), 4);
            for (int q = 0; q < rule.GetNPoints(); ++q) {
                const auto &point = rule.IntPoint(q);
                transformation->SetIntPoint(&point);
                mfem::Vector value(3);
                torque.GetVectorValue(*transformation, point, value);
                const double weight = point.weight * transformation->Weight();
                integral.Add(weight, value);
                squared_norm += weight * (value * value);
                volume += weight;
            }
        }
        for (int i = 0; i < 3; ++i) {
            diagnostics.torque_volume_average_per_s[i] = integral[i] / volume;
        }
        diagnostics.torque_l2_per_s = std::sqrt(squared_norm / volume);
    }

    mfem::Mesh &mesh;
    mfem::Coefficient &conductivity;
    mfem::VectorCoefficient &magnetization;
    SteadyTransportParameters parameters;
    mfem::H1_FECollection collection;
    mfem::FiniteElementSpace scalar_space;
    mfem::FiniteElementSpace vector_space;
    mfem::FiniteElementSpace tensor_space;
    mfem::FiniteElementSpace coupled_space;
    mfem::GridFunction potential;
    mfem::GridFunction current;
    mfem::GridFunction spin;
    mfem::GridFunction spin_current;
    mfem::GridFunction torque;
    mfem::GridFunction coupled_state;
    std::vector<std::unique_ptr<SpinSourceColumnCoefficient>> source_coefficients;
    std::array<double, 3> last_spin_weak_balance{};
};

SteadyTransportOracle::SteadyTransportOracle(
    mfem::Mesh &mesh,
    mfem::Coefficient &charge_conductivity,
    mfem::VectorCoefficient &magnetization,
    const SteadyTransportParameters &parameters)
    : impl_(std::make_unique<Impl>(mesh, charge_conductivity, magnetization, parameters))
{
}

SteadyTransportOracle::~SteadyTransportOracle() = default;

ChargeSolveDiagnostics SteadyTransportOracle::solve_charge(
    const mfem::Array<int> &dirichlet_boundary_marker,
    mfem::Coefficient &boundary_potential,
    ChargeGauge gauge)
{
    return impl_->solve_charge(dirichlet_boundary_marker, boundary_potential, gauge);
}

SpinSolveDiagnostics SteadyTransportOracle::solve_spin(
    const mfem::Array<int> &dirichlet_boundary_marker,
    mfem::VectorCoefficient *boundary_spin_potential)
{
    return impl_->solve_spin(dirichlet_boundary_marker, boundary_spin_potential);
}

ReciprocalSolveDiagnostics SteadyTransportOracle::solve_reciprocal(
    const mfem::Array<int> &charge_dirichlet_boundary_marker,
    mfem::Coefficient &boundary_potential,
    const mfem::Array<int> &spin_dirichlet_boundary_marker,
    mfem::VectorCoefficient *boundary_spin_potential,
    ChargeGauge gauge)
{
    return impl_->solve_reciprocal(
        charge_dirichlet_boundary_marker, boundary_potential,
        spin_dirichlet_boundary_marker, boundary_spin_potential, gauge);
}

const mfem::GridFunction &SteadyTransportOracle::electric_potential() const
{
    return impl_->potential;
}

const mfem::GridFunction &SteadyTransportOracle::spin_potential() const
{
    return impl_->spin;
}

const mfem::GridFunction &SteadyTransportOracle::charge_current_density() const
{
    return impl_->current;
}

const mfem::GridFunction &SteadyTransportOracle::spin_current_tensor() const
{
    return impl_->spin_current;
}

const mfem::GridFunction &SteadyTransportOracle::transport_torque() const
{
    return impl_->torque;
}

} // namespace fullmag::fem::transport
