#include "cpu/frequency_domain/floquet_bloch_scalar.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include <cmath>
#include <cstdint>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

class TangentSourceCoefficient final : public mfem::VectorCoefficient {
public:
    TangentSourceCoefficient(
        mfem::FiniteElementSpace &space,
        const TangentFrameNode *frames,
        double saturation_magnetization)
        : mfem::VectorCoefficient(3)
        , space_(space)
        , frames_(frames)
        , saturation_magnetization_(saturation_magnetization)
    {
    }

    void SetTangent(const mfem::Vector *tangent) { tangent_ = tangent; }

    void Eval(mfem::Vector &value, mfem::ElementTransformation &transform,
              const mfem::IntegrationPoint &integration_point) override
    {
        value.SetSize(3);
        value = 0.0;
        mfem::Array<int> dofs;
        space_.GetElementDofs(transform.ElementNo, dofs);
        mfem::Vector shape(dofs.Size());
        space_.GetFE(transform.ElementNo)->CalcShape(integration_point, shape);
        for (int local = 0; local < dofs.Size(); ++local) {
            const int dof = dofs[local] >= 0 ? dofs[local] : -1 - dofs[local];
            const double sign = dofs[local] >= 0 ? 1.0 : -1.0;
            const double q1 = (*tangent_)[2 * dof];
            const double q2 = (*tangent_)[2 * dof + 1];
            for (int axis = 0; axis < 3; ++axis) {
                value[axis] += sign * shape[local] * saturation_magnetization_ *
                    (q1 * frames_[dof].e1[axis] + q2 * frames_[dof].e2[axis]);
            }
        }
    }

private:
    mfem::FiniteElementSpace &space_;
    const TangentFrameNode *frames_;
    double saturation_magnetization_;
    const mfem::Vector *tangent_ = nullptr;
};

class TangentSourceWavevectorCoefficient final : public mfem::Coefficient {
public:
    TangentSourceWavevectorCoefficient(TangentSourceCoefficient &source, const mfem::Vector &k)
        : source_(source), k_(k) {}

    double Eval(mfem::ElementTransformation &transform,
                const mfem::IntegrationPoint &integration_point) override
    {
        mfem::Vector source_value;
        source_.Eval(source_value, transform, integration_point);
        return k_ * source_value;
    }

private:
    TangentSourceCoefficient &source_;
    const mfem::Vector &k_;
};

} // namespace

FrequencyDomainStatus assemble_floquet_bloch_scalar_operator(
    const FloquetBlochScalarAssemblyRequest &request,
    FloquetBlochScalarAssemblyResult *out_result) noexcept
{
    if (out_result == nullptr || request.scalar_space == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = FloquetBlochScalarAssemblyResult{};

    const int dimension = request.scalar_space->GetMesh()->Dimension();
    if (dimension < 1 || dimension > 3 ||
        !std::isfinite(request.robin_beta) || request.robin_beta < 0.0 ||
        (request.robin_beta > 0.0 && request.robin_boundary_marker == nullptr)) {
        return FrequencyDomainStatus::validation_error;
    }

    mfem::Vector k_vector(dimension);
    double k_squared = 0.0;
    for (int index = 0; index < 3; ++index) {
        const double component = request.k_rad_per_m[static_cast<std::size_t>(index)];
        if (!std::isfinite(component) || (index >= dimension && component != 0.0)) {
            return FrequencyDomainStatus::validation_error;
        }
        if (index < dimension) {
            k_vector[index] = component;
            k_squared += component * component;
        }
    }

    try {
        mfem::ConstantCoefficient k_squared_coefficient(k_squared);
        mfem::VectorConstantCoefficient k_coefficient(k_vector);
        mfem::ConstantCoefficient robin_coefficient(request.robin_beta);
        out_result->form = std::make_unique<mfem::SesquilinearForm>(
            request.scalar_space,
            mfem::ComplexOperator::HERMITIAN);
        out_result->form->AddDomainIntegrator(new mfem::DiffusionIntegrator(), nullptr);
        if (k_squared > 0.0) {
            out_result->form->AddDomainIntegrator(
                new mfem::MassIntegrator(k_squared_coefficient),
                nullptr);
            out_result->form->AddDomainIntegrator(
                nullptr,
                new mfem::ConvectionIntegrator(k_coefficient));
            out_result->form->AddDomainIntegrator(
                nullptr,
                new mfem::ConservativeConvectionIntegrator(k_coefficient));
        }
        if (request.robin_beta > 0.0) {
            out_result->form->AddBoundaryIntegrator(
                new mfem::BoundaryMassIntegrator(robin_coefficient),
                nullptr,
                *request.robin_boundary_marker);
        }
        out_result->form->Assemble();
        out_result->form->Finalize();
        out_result->operator_matrix.reset(
            out_result->form->AssembleComplexSparseMatrix());
    } catch (...) {
        *out_result = FloquetBlochScalarAssemblyResult{};
        return FrequencyDomainStatus::operator_error;
    }

    return out_result->operator_matrix != nullptr
        ? FrequencyDomainStatus::ok
        : FrequencyDomainStatus::operator_error;
}

FrequencyDomainStatus assemble_floquet_bloch_scalar_constraint(
    const FloquetBlochScalarConstraintRequest &request,
    FloquetBlochScalarConstraintResult *out_result) noexcept
{
    if (out_result == nullptr || request.scalar_space == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = FloquetBlochScalarConstraintResult{};

    const int full_dof_count = request.scalar_space->GetVSize();
    if (full_dof_count <= 0 || request.entries == nullptr ||
        request.entry_count != static_cast<std::uint64_t>(full_dof_count) ||
        request.reduced_dof_count == 0 ||
        request.reduced_dof_count > request.entry_count) {
        return FrequencyDomainStatus::validation_error;
    }

    std::vector<bool> full_dof_seen(static_cast<std::size_t>(full_dof_count), false);
    std::vector<bool> reduced_dof_seen(
        static_cast<std::size_t>(request.reduced_dof_count),
        false);
    for (std::uint64_t entry_index = 0; entry_index < request.entry_count; ++entry_index) {
        const FloquetBlochScalarConstraintEntry &entry = request.entries[entry_index];
        if (entry.full_dof >= request.entry_count ||
            entry.reduced_dof >= request.reduced_dof_count ||
            full_dof_seen[static_cast<std::size_t>(entry.full_dof)]) {
            return FrequencyDomainStatus::validation_error;
        }
        full_dof_seen[static_cast<std::size_t>(entry.full_dof)] = true;
        reduced_dof_seen[static_cast<std::size_t>(entry.reduced_dof)] = true;
        for (int component = 0; component < 3; ++component) {
            if (!std::isfinite(entry.translation_m[static_cast<std::size_t>(component)])) {
                return FrequencyDomainStatus::validation_error;
            }
        }
    }
    for (int component = 0; component < 3; ++component) {
        if (!std::isfinite(request.k_rad_per_m[static_cast<std::size_t>(component)])) {
            return FrequencyDomainStatus::validation_error;
        }
    }
    for (bool seen : full_dof_seen) {
        if (!seen) {
            return FrequencyDomainStatus::validation_error;
        }
    }
    for (bool seen : reduced_dof_seen) {
        if (!seen) {
            return FrequencyDomainStatus::validation_error;
        }
    }

    try {
        auto real = std::make_unique<mfem::SparseMatrix>(
            full_dof_count,
            static_cast<int>(request.reduced_dof_count));
        auto imaginary = std::make_unique<mfem::SparseMatrix>(
            full_dof_count,
            static_cast<int>(request.reduced_dof_count));
        for (std::uint64_t entry_index = 0; entry_index < request.entry_count; ++entry_index) {
            const FloquetBlochScalarConstraintEntry &entry = request.entries[entry_index];
            double phase_argument = 0.0;
            for (int component = 0; component < 3; ++component) {
                phase_argument += request.k_rad_per_m[static_cast<std::size_t>(component)] *
                    entry.translation_m[static_cast<std::size_t>(component)];
            }
            real->Add(
                static_cast<int>(entry.full_dof),
                static_cast<int>(entry.reduced_dof),
                std::cos(phase_argument));
            imaginary->Add(
                static_cast<int>(entry.full_dof),
                static_cast<int>(entry.reduced_dof),
                -std::sin(phase_argument));
        }
        real->Finalize();
        imaginary->Finalize();
        out_result->constraint_matrix = std::make_unique<mfem::ComplexSparseMatrix>(
            real.release(),
            imaginary.release(),
            true,
            true,
            mfem::ComplexOperator::HERMITIAN);
    } catch (...) {
        *out_result = FloquetBlochScalarConstraintResult{};
        return FrequencyDomainStatus::operator_error;
    }

    return out_result->constraint_matrix != nullptr
        ? FrequencyDomainStatus::ok
        : FrequencyDomainStatus::operator_error;
}

FrequencyDomainStatus assemble_floquet_bloch_scalar_reduced_operator(
    const FloquetBlochScalarReducedOperatorRequest &request,
    FloquetBlochScalarReducedOperatorResult *out_result) noexcept
{
    if (out_result == nullptr || request.full_operator == nullptr ||
        request.constraint == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = FloquetBlochScalarReducedOperatorResult{};

    const int full_dof_count = request.full_operator->Height();
    const int reduced_dof_count = request.constraint->Width();
    if (full_dof_count <= 0 || request.full_operator->Width() != full_dof_count ||
        request.constraint->Height() != full_dof_count || reduced_dof_count <= 0 ||
        request.full_operator->GetConvention() != mfem::ComplexOperator::HERMITIAN ||
        request.constraint->GetConvention() != mfem::ComplexOperator::HERMITIAN) {
        return FrequencyDomainStatus::validation_error;
    }

    try {
        auto matrix = std::make_unique<mfem::DenseMatrix>(
            reduced_dof_count,
            reduced_dof_count);
        mfem::Vector reduced_input(reduced_dof_count);
        mfem::Vector full_input(full_dof_count);
        mfem::Vector full_output(full_dof_count);
        mfem::Vector reduced_output(reduced_dof_count);
        for (int column = 0; column < reduced_dof_count; ++column) {
            reduced_input = 0.0;
            reduced_input[column] = 1.0;
            request.constraint->Mult(reduced_input, full_input);
            request.full_operator->Mult(full_input, full_output);
            request.constraint->MultTranspose(full_output, reduced_output);
            for (int row = 0; row < reduced_dof_count; ++row) {
                (*matrix)(row, column) = reduced_output[row];
            }
        }
        out_result->matrix = std::move(matrix);
    } catch (...) {
        *out_result = FloquetBlochScalarReducedOperatorResult{};
        return FrequencyDomainStatus::operator_error;
    }

    return out_result->matrix != nullptr
        ? FrequencyDomainStatus::ok
        : FrequencyDomainStatus::operator_error;
}

FrequencyDomainStatus assemble_floquet_bloch_scalar_tangent_source(
    const FloquetBlochScalarTangentSourceRequest &request,
    FloquetBlochScalarTangentSourceResult *out_result) noexcept
{
    if (out_result == nullptr || request.scalar_space == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = FloquetBlochScalarTangentSourceResult{};
    const int dof_count = request.scalar_space->GetVSize();
    if (request.scalar_space->GetMesh()->Dimension() != 3 || dof_count <= 0 ||
        request.tangent_frames == nullptr ||
        request.tangent_frame_count != static_cast<std::uint64_t>(dof_count) ||
        !std::isfinite(request.saturation_magnetization_a_per_m) ||
        request.saturation_magnetization_a_per_m <= 0.0) {
        return FrequencyDomainStatus::validation_error;
    }
    mfem::Vector k(3);
    for (int axis = 0; axis < 3; ++axis) {
        k[axis] = request.k_rad_per_m[static_cast<std::size_t>(axis)];
        if (!std::isfinite(k[axis])) { return FrequencyDomainStatus::validation_error; }
    }
    try {
        auto real = std::make_unique<mfem::SparseMatrix>(dof_count, 2 * dof_count);
        auto imaginary = std::make_unique<mfem::SparseMatrix>(dof_count, 2 * dof_count);
        mfem::Vector tangent(2 * dof_count);
        TangentSourceCoefficient source(*request.scalar_space, request.tangent_frames,
                                        request.saturation_magnetization_a_per_m);
        TangentSourceWavevectorCoefficient k_source(source, k);
        for (int column = 0; column < tangent.Size(); ++column) {
            tangent = 0.0;
            tangent[column] = 1.0;
            source.SetTangent(&tangent);
            mfem::LinearForm real_form(request.scalar_space);
            mfem::LinearForm imaginary_form(request.scalar_space);
            real_form.AddDomainIntegrator(new mfem::DomainLFGradIntegrator(source));
            imaginary_form.AddDomainIntegrator(new mfem::DomainLFIntegrator(k_source));
            real_form.Assemble();
            imaginary_form.Assemble();
            for (int row = 0; row < dof_count; ++row) {
                real->Add(row, column, real_form[row]);
                imaginary->Add(row, column, imaginary_form[row]);
            }
        }
        real->Finalize();
        imaginary->Finalize();
        out_result->source_matrix = std::make_unique<mfem::ComplexSparseMatrix>(
            real.release(), imaginary.release(), true, true, mfem::ComplexOperator::HERMITIAN);
    } catch (...) {
        *out_result = FloquetBlochScalarTangentSourceResult{};
        return FrequencyDomainStatus::operator_error;
    }
    return out_result->source_matrix != nullptr
        ? FrequencyDomainStatus::ok : FrequencyDomainStatus::operator_error;
}

} // namespace fullmag::fem::frequency_domain

#endif
