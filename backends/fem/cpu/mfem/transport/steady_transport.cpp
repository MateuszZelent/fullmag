#include "cpu/mfem/transport/steady_transport.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

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
    if (!(std::isfinite(p.lambda_sf_m) && p.lambda_sf_m > 0.0) ||
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
          potential(&scalar_space), current(&vector_space), spin(&vector_space),
          spin_current(&tensor_space), torque(&vector_space)
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
                if (!(parameters.sigma_s_spm -
                        parameters.polarization_p * parameters.polarization_p * sigma > 0.0)) {
                    throw std::invalid_argument(
                        "spin material violates sigma_s-P^2 sigma>0");
                }
            }
        }
    }

    ChargeSolveDiagnostics solve_charge(
        const mfem::Array<int> &marker,
        mfem::Coefficient &boundary_potential,
        ChargeGauge gauge)
    {
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
            ChargeCurrentCoefficient(
                mfem::GridFunction &potential,
                mfem::Coefficient &conductivity)
                : mfem::VectorCoefficient(3), potential_(potential), conductivity_(conductivity)
            {
            }

            void Eval(
                mfem::Vector &value,
                mfem::ElementTransformation &transformation,
                const mfem::IntegrationPoint &point) override
            {
                potential_.GetGradient(transformation, value);
                value *= -conductivity_.Eval(transformation, point);
            }

        private:
            mfem::GridFunction &potential_;
            mfem::Coefficient &conductivity_;
        } coefficient(potential, conductivity);

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
                owner_.spin.GetVectorGradient(transformation, gradient);
                mfem::DenseMatrix source;
                owner_.source_matrix(transformation, point, source);
                value.SetSize(9);
                for (int flow = 0; flow < 3; ++flow) {
                    for (int component = 0; component < 3; ++component) {
                        value[flow * 3 + component] =
                            -0.5 * owner_.parameters.sigma_s_spm * gradient(component, flow) +
                            source(flow, component);
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
                mfem::Vector gradient(3);
                potential.GetGradient(*transformation, gradient);
                const double weight = point.weight * transformation->Weight();
                const double sigma = conductivity.Eval(*transformation, point);
                volume_current.Add(-sigma * weight, gradient);
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
                mfem::Vector gradient(3);
                potential.GetGradient(*face->Elem1, gradient);
                mfem::Vector normal(3);
                face->Face->SetIntPoint(&face_point);
                mfem::CalcOrtho(face->Face->Jacobian(), normal);
                const double sigma = conductivity.Eval(*face->Elem1, element_point);
                boundary_current += -sigma * (gradient * normal) * face_point.weight;
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
                mfem::DenseMatrix gradient;
                spin.GetVectorGradient(*face->Elem1, gradient);
                mfem::DenseMatrix source;
                source_matrix(*face->Elem1, element_point, source);
                mfem::Vector normal(3);
                face->Face->SetIntPoint(&face_point);
                mfem::CalcOrtho(face->Face->Jacobian(), normal);
                for (int a = 0; a < 3; ++a) {
                    double flux = 0.0;
                    for (int i = 0; i < 3; ++i) {
                        flux += normal[i] *
                            (-0.5 * parameters.sigma_s_spm * gradient(a, i) + source(i, a));
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
    mfem::GridFunction potential;
    mfem::GridFunction current;
    mfem::GridFunction spin;
    mfem::GridFunction spin_current;
    mfem::GridFunction torque;
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
