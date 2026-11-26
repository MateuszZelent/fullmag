#include "cpu/mfem/transport/steady_transport.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
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

fullmag::fem::multiphysics::SparseSolveConfig make_sparse_config(
    const SteadyTransportParameters &parameters,
    fullmag::fem::multiphysics::SparseMatrixKind kind,
    int by_nodes_component_count = 1)
{
    fullmag::fem::multiphysics::SparseSolveConfig config;
    config.kind = kind;
    config.execution_target = parameters.execution_target;
    config.cpu_backend = parameters.cpu_backend;
    config.relative_tolerance = parameters.relative_tolerance;
    config.absolute_tolerance = 0.0;
    config.maximum_iterations = parameters.maximum_iterations;
    config.gmres_kdim = std::min(100, std::max(1, parameters.maximum_iterations));
    config.by_nodes_component_count = by_nodes_component_count;
    config.max_refinement_sweeps = 2;
    return config;
}

int marker_sum(const mfem::Array<int> &marker)
{
    int sum = 0;
    for (int i = 0; i < marker.Size(); ++i) {
        sum += marker[i];
    }
    return sum;
}

std::vector<int> vertex_component_roots(mfem::Mesh &mesh)
{
    std::vector<int> parent(static_cast<std::size_t>(mesh.GetNV()));
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        parent[static_cast<std::size_t>(vertex)] = vertex;
    }
    const auto root = [&parent](int vertex) {
        while (parent[static_cast<std::size_t>(vertex)] != vertex) {
            parent[static_cast<std::size_t>(vertex)] =
                parent[static_cast<std::size_t>(parent[static_cast<std::size_t>(vertex)])];
            vertex = parent[static_cast<std::size_t>(vertex)];
        }
        return vertex;
    };
    std::vector<bool> used(parent.size(), false);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        if (vertices.Size() == 0) {
            throw std::invalid_argument("charge element has no vertices");
        }
        for (int local = 0; local < vertices.Size(); ++local) {
            used[static_cast<std::size_t>(vertices[local])] = true;
            parent[static_cast<std::size_t>(root(vertices[local]))] = root(vertices[0]);
        }
    }
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        parent[static_cast<std::size_t>(vertex)] =
            used[static_cast<std::size_t>(vertex)] ? root(vertex) : -1;
    }
    return parent;
}

void add_unreferenced_component_gauges(
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &space,
    const mfem::Array<int> &boundary_marker,
    mfem::Array<int> &essential_true_dofs)
{
    const auto components = vertex_component_roots(mesh);
    std::vector<bool> referenced(components.size(), false);
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        const int attribute = mesh.GetBdrAttribute(boundary);
        if (boundary_marker[attribute - 1] == 0) {
            continue;
        }
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        if (vertices.Size() == 0) {
            throw std::invalid_argument("charge terminal boundary has no vertices");
        }
        referenced[static_cast<std::size_t>(components[static_cast<std::size_t>(vertices[0])])] = true;
    }
    std::vector<int> essential;
    essential.reserve(static_cast<std::size_t>(essential_true_dofs.Size()) + components.size());
    for (int index = 0; index < essential_true_dofs.Size(); ++index) {
        essential.push_back(essential_true_dofs[index]);
    }
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        if (components[static_cast<std::size_t>(vertex)] != vertex ||
            referenced[static_cast<std::size_t>(vertex)]) {
            continue;
        }
        if (space.GetConformingRestriction() != nullptr) {
            throw std::invalid_argument(
                "unreferenced charge component gauge requires a conforming H1 mesh");
        }
        mfem::Array<int> vertex_dofs;
        space.GetVertexDofs(vertex, vertex_dofs);
        if (vertex_dofs.Size() != 1 || vertex_dofs[0] < 0) {
            throw std::invalid_argument(
                "unreferenced charge component has no unique H1 gauge dof");
        }
        essential.push_back(vertex_dofs[0]);
    }
    std::sort(essential.begin(), essential.end());
    essential.erase(std::unique(essential.begin(), essential.end()), essential.end());
    essential_true_dofs.SetSize(static_cast<int>(essential.size()));
    for (int index = 0; index < essential_true_dofs.Size(); ++index) {
        essential_true_dofs[index] = essential[static_cast<std::size_t>(index)];
    }
}

class TerminalBoundaryPotential final : public mfem::Coefficient {
public:
    explicit TerminalBoundaryPotential(const std::vector<double> &values)
        : values_(values)
    {
    }

    double Eval(
        mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &) override
    {
        return values_.at(static_cast<std::size_t>(transformation.Attribute - 1));
    }

private:
    const std::vector<double> &values_;
};

std::vector<double> solve_terminal_response_block(
    const std::vector<std::vector<double>> &response,
    const std::vector<double> &requested,
    const std::vector<int> &non_gauge)
{
    const std::size_t count = non_gauge.size();
    std::vector<std::vector<double>> matrix(count, std::vector<double>(count));
    std::vector<double> rhs(count);
    double matrix_scale = 0.0;
    for (std::size_t row = 0; row < count; ++row) {
        rhs[row] = requested[static_cast<std::size_t>(non_gauge[row])];
        for (std::size_t column = 0; column < count; ++column) {
            const double value = response[static_cast<std::size_t>(non_gauge[row])]
                [static_cast<std::size_t>(non_gauge[column])];
            if (!std::isfinite(value)) {
                throw std::runtime_error("terminal response matrix is non-finite");
            }
            matrix[row][column] = value;
            matrix_scale = std::max(matrix_scale, std::abs(value));
        }
    }
    if (count > 0 && matrix_scale == 0.0) {
        throw std::invalid_argument("terminal response matrix is rank deficient");
    }
    const double pivot_threshold = 1.0e-10 * matrix_scale;
    for (std::size_t column = 0; column < count; ++column) {
        std::size_t pivot = column;
        for (std::size_t row = column + 1; row < count; ++row) {
            if (std::abs(matrix[row][column]) > std::abs(matrix[pivot][column])) {
                pivot = row;
            }
        }
        if (std::abs(matrix[pivot][column]) <= pivot_threshold) {
            throw std::invalid_argument("terminal response matrix is rank deficient");
        }
        std::swap(matrix[column], matrix[pivot]);
        std::swap(rhs[column], rhs[pivot]);
        for (std::size_t row = column + 1; row < count; ++row) {
            const double factor = matrix[row][column] / matrix[column][column];
            for (std::size_t entry = column + 1; entry < count; ++entry) {
                matrix[row][entry] -= factor * matrix[column][entry];
            }
            rhs[row] -= factor * rhs[column];
            matrix[row][column] = 0.0;
        }
    }
    std::vector<double> voltage(count, 0.0);
    for (std::size_t index = count; index-- > 0;) {
        double value = rhs[index];
        for (std::size_t column = index + 1; column < count; ++column) {
            value -= matrix[index][column] * voltage[column];
        }
        voltage[index] = value / matrix[index][index];
        if (!std::isfinite(voltage[index])) {
            throw std::runtime_error("terminal response voltage is non-finite");
        }
    }
    return voltage;
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
        last_charge_weak_residual.SetSize(0);
        last_charge_marker.SetSize(0);
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
        // FormLinearSystem eliminates Dirichlet dofs and mutates rhs in place;
        // the terminal reaction must use the original uneliminated load.
        const mfem::Vector original_rhs(rhs);

        mfem::Array<int> essential_true_dofs;
        if (marked_boundaries > 0) {
            scalar_space.GetEssentialTrueDofs(marker, essential_true_dofs);
        }
        add_unreferenced_component_gauges(
            mesh, scalar_space, marker, essential_true_dofs);
        mfem::OperatorPtr system_operator;
        mfem::Vector solution, system_rhs;
        form.FormLinearSystem(
            essential_true_dofs, potential, rhs, system_operator, solution, system_rhs);
        auto &matrix = dynamic_cast<mfem::SparseMatrix &>(*system_operator.Ptr());
        const auto solver_config = make_sparse_config(
            parameters, fullmag::fem::multiphysics::SparseMatrixKind::Spd);
        fullmag::fem::multiphysics::SparseLinearSolver solver(matrix, solver_config);
        const auto stats = solver.solve(system_rhs, solution, 0.0);
        const double residual = stats.independent_relative_residual;
        form.RecoverFEMSolution(solution, rhs, potential);
        if (stats.converged && marked_boundaries > 0) {
            // FullMult restores the eliminated stiffness contribution. Work
            // in true-dof coordinates when the H1 space is nonconforming.
            mfem::Vector true_potential, true_rhs;
            if (const auto *restriction = scalar_space.GetConformingRestriction()) {
                true_potential.SetSize(restriction->Height());
                restriction->Mult(potential, true_potential);
                true_rhs.SetSize(restriction->Height());
                scalar_space.GetConformingProlongation()->MultTranspose(original_rhs, true_rhs);
            } else {
                true_potential = potential;
                true_rhs = original_rhs;
            }
            last_charge_weak_residual.SetSize(true_potential.Size());
            form.FullMult(true_potential, last_charge_weak_residual);
            last_charge_weak_residual -= true_rhs;
            last_charge_marker = marker;
        }
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
        diagnostics.converged = stats.converged;
        diagnostics.iterations = stats.iterations;
        diagnostics.relative_residual = residual;
        diagnostics.resolved_solver = stats.resolved_solver;
        accumulate_charge_diagnostics(diagnostics);
        return diagnostics;
    }

    ChargeTerminalCurrentSolution solve_charge_terminal_currents(
        const std::vector<std::vector<int>> &terminal_boundary_attributes,
        const std::vector<double> &requested_outward_current_a)
    {
        last_charge_weak_residual.SetSize(0);
        last_charge_marker.SetSize(0);
        if (parameters.constitutive_model != TransportConstitutiveModel::OneWay) {
            throw std::invalid_argument(
                "reciprocal transport requires the monolithic solve_reciprocal entry point");
        }
        const std::size_t count = terminal_boundary_attributes.size();
        if (count == 0 || count != requested_outward_current_a.size()) {
            throw std::invalid_argument(
                "terminal current solve requires matching nonempty terminal and current lists");
        }
        const auto components = vertex_component_roots(mesh);
        const int max_attribute = mesh.bdr_attributes.Max();
        std::vector<int> attribute_component(static_cast<std::size_t>(max_attribute + 1), -1);
        for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
            mfem::Array<int> vertices;
            mesh.GetBdrElementVertices(boundary, vertices);
            if (vertices.Size() == 0) {
                throw std::invalid_argument("terminal boundary has no vertices");
            }
            const int attribute = mesh.GetBdrAttribute(boundary);
            const int component = components[static_cast<std::size_t>(vertices[0])];
            int &assigned = attribute_component[static_cast<std::size_t>(attribute)];
            if (assigned >= 0 && assigned != component) {
                assigned = -2;
            } else if (assigned == -1) {
                assigned = component;
            }
        }
        mfem::Array<int> all_terminals(max_attribute);
        all_terminals = 0;
        std::vector<int> attribute_owner(static_cast<std::size_t>(max_attribute + 1), -1);
        std::vector<int> terminal_component(count, -1);
        std::map<int, std::vector<int>> component_terminals;
        std::map<int, int> dof_owner;
        std::map<int, std::vector<int>> attribute_true_dofs;
        for (std::size_t terminal = 0; terminal < count; ++terminal) {
            if (terminal_boundary_attributes[terminal].empty() ||
                !std::isfinite(requested_outward_current_a[terminal])) {
                throw std::invalid_argument("terminal current or boundary set is invalid");
            }
            mfem::Array<int> marker(max_attribute);
            marker = 0;
            for (int attribute : terminal_boundary_attributes[terminal]) {
                if (attribute <= 0 || attribute > max_attribute ||
                    attribute_component[static_cast<std::size_t>(attribute)] < 0 ||
                    attribute_owner[static_cast<std::size_t>(attribute)] >= 0) {
                    throw std::invalid_argument(
                        "terminal attributes are absent, shared or span disconnected conductors");
                }
                const int component = attribute_component[static_cast<std::size_t>(attribute)];
                if (terminal_component[terminal] >= 0 &&
                    terminal_component[terminal] != component) {
                    throw std::invalid_argument(
                        "one terminal spans disconnected conductor components");
                }
                terminal_component[terminal] = component;
                attribute_owner[static_cast<std::size_t>(attribute)] =
                    static_cast<int>(terminal);
                marker[attribute - 1] = 1;
                all_terminals[attribute - 1] = 1;

                mfem::Array<int> attr_marker(max_attribute);
                attr_marker = 0;
                attr_marker[attribute - 1] = 1;
                mfem::Array<int> attr_dofs;
                scalar_space.GetEssentialTrueDofs(attr_marker, attr_dofs);
                std::vector<int> stored_dofs;
                stored_dofs.reserve(static_cast<std::size_t>(attr_dofs.Size()));
                for (int i = 0; i < attr_dofs.Size(); ++i) {
                    stored_dofs.push_back(attr_dofs[i]);
                }
                attribute_true_dofs.emplace(attribute, std::move(stored_dofs));
            }
            mfem::Array<int> terminal_dofs;
            scalar_space.GetEssentialTrueDofs(marker, terminal_dofs);
            if (terminal_dofs.Size() == 0) {
                throw std::invalid_argument("terminal has no H1 essential dofs");
            }
            for (int index = 0; index < terminal_dofs.Size(); ++index) {
                if (!dof_owner.emplace(terminal_dofs[index], static_cast<int>(terminal)).second) {
                    throw std::invalid_argument("terminal boundaries share an H1 essential dof");
                }
            }
            component_terminals[terminal_component[terminal]].push_back(
                static_cast<int>(terminal));
        }
        for (const auto &[component, terminals] : component_terminals) {
            (void)component;
            double balance = 0.0;
            double magnitude = 0.0;
            for (int terminal : terminals) {
                const double current = requested_outward_current_a[
                    static_cast<std::size_t>(terminal)];
                balance += current;
                magnitude += std::abs(current);
            }
            if (std::abs(balance) > 1.0e-10 * magnitude + 1.0e-18) {
                throw std::invalid_argument(
                    "requested terminal currents do not balance on a conductor component");
            }
        }

        // Factor-once multi-RHS assembly: assemble and factor K_elim once for
        // this call only (so external Coefficient mutations between calls never
        // observe a stale factor).
        mfem::BilinearForm diffusion_form(&scalar_space);
        diffusion_form.AddDomainIntegrator(new mfem::DiffusionIntegrator(conductivity));
        diffusion_form.Assemble();
        mfem::Array<int> essential_true_dofs;
        scalar_space.GetEssentialTrueDofs(all_terminals, essential_true_dofs);
        add_unreferenced_component_gauges(
            mesh, scalar_space, all_terminals, essential_true_dofs);

        mfem::GridFunction zero_potential(&scalar_space);
        zero_potential = 0.0;
        mfem::LinearForm zero_rhs(&scalar_space);
        zero_rhs = 0.0;
        zero_rhs.Assemble();
        mfem::OperatorPtr system_operator;
        mfem::Vector dummy_solution, dummy_rhs;
        diffusion_form.FormLinearSystem(
            essential_true_dofs, zero_potential, zero_rhs,
            system_operator, dummy_solution, dummy_rhs);
        auto &eliminated_matrix = dynamic_cast<mfem::SparseMatrix &>(*system_operator.Ptr());
        const int true_size = scalar_space.GetTrueVSize();
        std::vector<bool> is_essential_true_dof(static_cast<std::size_t>(true_size), false);
        for (int index = 0; index < essential_true_dofs.Size(); ++index) {
            is_essential_true_dof[static_cast<std::size_t>(essential_true_dofs[index])] = true;
        }
        mfem::Vector eliminated_diag(true_size);
        eliminated_matrix.GetDiag(eliminated_diag);

        const auto solver_config = make_sparse_config(
            parameters, fullmag::fem::multiphysics::SparseMatrixKind::Spd);
        fullmag::fem::multiphysics::SparseLinearSolver charge_solver(
            eliminated_matrix, solver_config);

        const auto *restriction = scalar_space.GetConformingRestriction();
        const auto *prolongation = scalar_space.GetConformingProlongation();

        std::vector<double> attribute_voltage(static_cast<std::size_t>(max_attribute), 0.0);
        TerminalBoundaryPotential boundary_potential(attribute_voltage);
        mfem::GridFunction bdr_potential(&scalar_space);
        mfem::Vector true_bdr(true_size);
        mfem::Vector rhs_full(true_size);
        mfem::Vector system_rhs(true_size);
        mfem::Vector solution(true_size);
        mfem::Vector weak_residual(true_size);

        const auto solve_for_current_voltages = [&]() {
            bdr_potential = 0.0;
            bdr_potential.ProjectBdrCoefficient(boundary_potential, all_terminals);
            if (restriction != nullptr) {
                restriction->Mult(bdr_potential, true_bdr);
            } else {
                true_bdr = bdr_potential;
            }
            for (int i = 0; i < true_size; ++i) {
                if (!is_essential_true_dof[static_cast<std::size_t>(i)]) {
                    true_bdr[i] = 0.0;
                }
            }
            diffusion_form.FullMult(true_bdr, rhs_full);
            for (int i = 0; i < true_size; ++i) {
                if (is_essential_true_dof[static_cast<std::size_t>(i)]) {
                    system_rhs[i] = eliminated_diag[i] * true_bdr[i];
                } else {
                    system_rhs[i] = -rhs_full[i];
                }
            }
            return charge_solver.solve(system_rhs, solution, 0.0);
        };

        std::vector<std::vector<double>> response(count, std::vector<double>(count, 0.0));
        ChargeTerminalCurrentSolution result;
        result.terminal_voltage_v.assign(count, 0.0);
        for (const auto &[component, terminals] : component_terminals) {
            (void)component;
            result.gauge_terminal_indices.push_back(terminals.front());
            for (std::size_t index = 1; index < terminals.size(); ++index) {
                const int source = terminals[index];
                for (int attribute : terminal_boundary_attributes[
                        static_cast<std::size_t>(source)]) {
                    attribute_voltage[static_cast<std::size_t>(attribute - 1)] = 1.0;
                }
                const auto stats = solve_for_current_voltages();
                if (!stats.converged ||
                    stats.independent_relative_residual > parameters.relative_tolerance) {
                    throw std::runtime_error("unit-terminal H1 response solve did not converge");
                }
                diffusion_form.FullMult(solution, weak_residual);
                for (std::size_t terminal = 0; terminal < count; ++terminal) {
                    for (int attribute : terminal_boundary_attributes[terminal]) {
                        double outward = 0.0;
                        for (int dof : attribute_true_dofs.at(attribute)) {
                            outward -= weak_residual[dof];
                        }
                        response[terminal][static_cast<std::size_t>(source)] += outward;
                    }
                }
                for (int attribute : terminal_boundary_attributes[
                        static_cast<std::size_t>(source)]) {
                    attribute_voltage[static_cast<std::size_t>(attribute - 1)] = 0.0;
                }
            }
            std::vector<int> non_gauge(terminals.begin() + 1, terminals.end());
            const auto voltage = solve_terminal_response_block(
                response, requested_outward_current_a, non_gauge);
            for (std::size_t index = 0; index < non_gauge.size(); ++index) {
                result.terminal_voltage_v[static_cast<std::size_t>(non_gauge[index])] =
                    voltage[index];
            }
        }
        for (std::size_t terminal = 0; terminal < count; ++terminal) {
            for (int attribute : terminal_boundary_attributes[terminal]) {
                attribute_voltage[static_cast<std::size_t>(attribute - 1)] =
                    result.terminal_voltage_v[terminal];
            }
        }
        const auto final_stats = solve_for_current_voltages();
        if (!final_stats.converged ||
            final_stats.independent_relative_residual > parameters.relative_tolerance) {
            throw std::runtime_error("prescribed terminal-current H1 solve did not converge");
        }
        if (prolongation != nullptr) {
            prolongation->Mult(solution, potential);
        } else {
            potential = solution;
        }
        last_charge_weak_residual.SetSize(true_size);
        diffusion_form.FullMult(solution, last_charge_weak_residual);
        last_charge_marker = all_terminals;
        project_charge_current();

        result.diagnostics.converged = final_stats.converged;
        result.diagnostics.iterations = final_stats.iterations;
        result.diagnostics.relative_residual = final_stats.independent_relative_residual;
        result.diagnostics.resolved_solver = final_stats.resolved_solver;
        accumulate_charge_diagnostics(result.diagnostics);

        result.measured_outward_current_a.assign(count, 0.0);
        for (std::size_t terminal = 0; terminal < count; ++terminal) {
            for (int attribute : terminal_boundary_attributes[terminal]) {
                result.measured_outward_current_a[terminal] +=
                    boundary_weak_current_a(attribute);
            }
        }
        for (std::size_t terminal = 0; terminal < count; ++terminal) {
            if (!std::isfinite(result.measured_outward_current_a[terminal]) ||
                std::abs(result.measured_outward_current_a[terminal] -
                    requested_outward_current_a[terminal]) >
                    1.0e-8 * std::abs(requested_outward_current_a[terminal]) + 1.0e-18) {
                throw std::runtime_error("prescribed signed terminal current residual exceeds tolerance");
            }
        }
        return result;
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
        auto &matrix = dynamic_cast<mfem::SparseMatrix &>(*system_operator.Ptr());
        const auto solver_config = make_sparse_config(
            parameters,
            fullmag::fem::multiphysics::SparseMatrixKind::GeneralNonsymmetric,
            3);
        fullmag::fem::multiphysics::SparseLinearSolver solver(matrix, solver_config);
        const auto stats = solver.solve(system_rhs, solution, 0.0);
        const double residual = stats.independent_relative_residual;
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
        diagnostics.converged = stats.converged;
        diagnostics.iterations = stats.iterations;
        diagnostics.relative_residual = residual;
        diagnostics.resolved_solver = stats.resolved_solver;
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
        last_charge_weak_residual.SetSize(0);
        last_charge_marker.SetSize(0);
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
        auto &matrix = dynamic_cast<mfem::SparseMatrix &>(*system_operator.Ptr());
        const auto solver_config = make_sparse_config(
            parameters,
            fullmag::fem::multiphysics::SparseMatrixKind::GeneralNonsymmetric,
            4);
        fullmag::fem::multiphysics::SparseLinearSolver solver(matrix, solver_config);
        const auto stats = solver.solve(system_rhs, solution, 0.0);

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
        diagnostics.charge.converged = stats.converged;
        diagnostics.charge.iterations = stats.iterations;
        diagnostics.charge.relative_residual = relative_residual;
        diagnostics.charge.resolved_solver = stats.resolved_solver;
        diagnostics.spin.converged = stats.converged;
        diagnostics.spin.iterations = stats.iterations;
        diagnostics.spin.relative_residual = relative_residual;
        diagnostics.spin.resolved_solver = stats.resolved_solver;
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

    void charge_response(
        mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &point,
        mfem::Vector &value)
    {
        if (parameters.constitutive_model == TransportConstitutiveModel::OneWay) {
            potential.GetGradient(transformation, value);
            value *= -conductivity.Eval(transformation, point);
            return;
        }
        mfem::DenseMatrix spin_current;
        constitutive_response(transformation, point, value, spin_current);
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
                owner_.charge_response(transformation, point, value);
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
                charge_response(*transformation, point, charge);
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
                charge_response(*face->Elem1, element_point, charge);
                mfem::Vector normal(3);
                face->Face->SetIntPoint(&face_point);
                mfem::CalcOrtho(face->Face->Jacobian(), normal);
                boundary_current += (charge * normal) * face_point.weight;
            }
        }
        diagnostics.net_boundary_current_a = boundary_current;
    }

    double boundary_current_a(int boundary_attribute)
    {
        double boundary_current = 0.0;
        for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
            if (mesh.GetBdrAttribute(boundary) != boundary_attribute) {
                continue;
            }
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
                charge_response(*face->Elem1, element_point, charge);
                mfem::Vector normal(3);
                face->Face->SetIntPoint(&face_point);
                mfem::CalcOrtho(face->Face->Jacobian(), normal);
                boundary_current += (charge * normal) * face_point.weight;
            }
        }
        return boundary_current;
    }

    double boundary_weak_current_a(int boundary_attribute) const
    {
        if (boundary_attribute <= 0 || boundary_attribute > mesh.bdr_attributes.Max() ||
            last_charge_marker.Size() == 0 ||
            last_charge_marker[boundary_attribute - 1] == 0) {
            throw std::invalid_argument(
                "weak terminal current requires a solved Dirichlet boundary attribute");
        }
        mfem::Array<int> terminal_marker(mesh.bdr_attributes.Max());
        terminal_marker = 0;
        terminal_marker[boundary_attribute - 1] = 1;
        mfem::Array<int> terminal_dofs;
        scalar_space.GetEssentialTrueDofs(terminal_marker, terminal_dofs);
        double outward_current = 0.0;
        for (int i = 0; i < terminal_dofs.Size(); ++i) {
            outward_current -= last_charge_weak_residual[terminal_dofs[i]];
        }
        return outward_current;
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
        mfem::BilinearForm scalar_mass_form(&scalar_space);
        scalar_mass_form.AddDomainIntegrator(new mfem::MassIntegrator(one));
        scalar_mass_form.Assemble();
        mfem::LinearForm torque_load(&vector_space);
        torque_load.AddDomainIntegrator(new mfem::VectorDomainLFIntegrator(torque_coefficient));
        torque_load.Assemble();

        mfem::Array<int> no_essential_dofs;
        mfem::GridFunction dummy_scalar(&scalar_space);
        dummy_scalar = 0.0;
        mfem::LinearForm dummy_load(&scalar_space);
        dummy_load = 0.0;
        dummy_load.Assemble();
        mfem::OperatorPtr mass_operator;
        mfem::Vector dummy_projected, dummy_rhs;
        scalar_mass_form.FormLinearSystem(
            no_essential_dofs, dummy_scalar, dummy_load,
            mass_operator, dummy_projected, dummy_rhs);
        auto &scalar_mass_matrix = dynamic_cast<mfem::SparseMatrix &>(*mass_operator.Ptr());
        const auto mass_config = make_sparse_config(
            parameters, fullmag::fem::multiphysics::SparseMatrixKind::Spd);
        fullmag::fem::multiphysics::SparseLinearSolver mass_solver(
            scalar_mass_matrix, mass_config);

        const int scalar_vsize = scalar_space.GetVSize();
        const int scalar_true_size = scalar_space.GetTrueVSize();
        const auto *prolongation = scalar_space.GetConformingProlongation();
        mfem::Vector comp_load_full(scalar_vsize);
        mfem::Vector comp_rhs(scalar_true_size);
        mfem::Vector comp_sol(scalar_true_size);
        mfem::Vector comp_full(scalar_vsize);
        torque = 0.0;
        for (int component = 0; component < 3; ++component) {
            for (int dof = 0; dof < scalar_vsize; ++dof) {
                comp_load_full[dof] = torque_load[vector_space.DofToVDof(dof, component)];
            }
            if (prolongation != nullptr) {
                prolongation->MultTranspose(comp_load_full, comp_rhs);
            } else {
                comp_rhs = comp_load_full;
            }
            const auto stats = mass_solver.solve(comp_rhs, comp_sol, 0.0);
            if (!stats.converged) {
                throw std::runtime_error("consistent L2 transport-torque projection did not converge");
            }
            if (prolongation != nullptr) {
                prolongation->Mult(comp_sol, comp_full);
            } else {
                comp_full = comp_sol;
            }
            for (int dof = 0; dof < scalar_vsize; ++dof) {
                torque[vector_space.DofToVDof(dof, component)] = comp_full[dof];
            }
        }
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
    mfem::Vector last_charge_weak_residual;
    mfem::Array<int> last_charge_marker;
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

ChargeTerminalCurrentSolution SteadyTransportOracle::solve_charge_terminal_currents(
    const std::vector<std::vector<int>> &terminal_boundary_attributes,
    const std::vector<double> &requested_outward_current_a)
{
    return impl_->solve_charge_terminal_currents(
        terminal_boundary_attributes, requested_outward_current_a);
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

double SteadyTransportOracle::boundary_current_a(int boundary_attribute)
{
    return impl_->boundary_current_a(boundary_attribute);
}

double SteadyTransportOracle::boundary_weak_current_a(int boundary_attribute) const
{
    return impl_->boundary_weak_current_a(boundary_attribute);
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
