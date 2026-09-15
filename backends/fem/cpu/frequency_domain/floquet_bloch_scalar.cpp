#include "cpu/frequency_domain/floquet_bloch_scalar.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

class TangentSourceCoefficient final : public mfem::VectorCoefficient {
public:
    TangentSourceCoefficient(
        mfem::FiniteElementSpace &space,
        const TangentFrameNode *frames,
        double saturation_magnetization,
        const double *saturation_magnetization_field,
        std::uint64_t saturation_magnetization_field_count,
        const std::uint8_t *magnetic_element_mask,
        std::uint64_t magnetic_element_mask_count)
        : mfem::VectorCoefficient(3)
        , space_(space)
        , frames_(frames)
        , saturation_magnetization_(saturation_magnetization)
        , saturation_magnetization_field_(saturation_magnetization_field)
        , saturation_magnetization_field_count_(saturation_magnetization_field_count)
        , magnetic_element_mask_(magnetic_element_mask)
        , magnetic_element_mask_count_(magnetic_element_mask_count)
    {
    }

    void SetTangent(const mfem::Vector *tangent) { tangent_ = tangent; }

    void Eval(mfem::Vector &value, mfem::ElementTransformation &transform,
              const mfem::IntegrationPoint &integration_point) override
    {
        value.SetSize(3);
        value = 0.0;
        if (magnetic_element_mask_ != nullptr) {
            const int element = transform.ElementNo;
            if (element < 0 ||
                static_cast<std::uint64_t>(element) >= magnetic_element_mask_count_ ||
                magnetic_element_mask_[static_cast<std::size_t>(element)] == 0u) {
                return;
            }
        }
        mfem::Array<int> dofs;
        space_.GetElementDofs(transform.ElementNo, dofs);
        mfem::Vector shape(dofs.Size());
        space_.GetFE(transform.ElementNo)->CalcShape(integration_point, shape);
        for (int local = 0; local < dofs.Size(); ++local) {
            const int dof = dofs[local] >= 0 ? dofs[local] : -1 - dofs[local];
            const double sign = dofs[local] >= 0 ? 1.0 : -1.0;
            if (saturation_magnetization_field_ != nullptr &&
                (dof < 0 || static_cast<std::uint64_t>(dof) >=
                    saturation_magnetization_field_count_)) {
                value = 0.0;
                return;
            }
            const double q1 = (*tangent_)[2 * dof];
            const double q2 = (*tangent_)[2 * dof + 1];
            const double saturation_magnetization = saturation_magnetization_field_ != nullptr
                ? saturation_magnetization_field_[static_cast<std::size_t>(dof)]
                : saturation_magnetization_;
            for (int axis = 0; axis < 3; ++axis) {
                value[axis] += sign * shape[local] * saturation_magnetization *
                    (q1 * frames_[dof].e1[axis] + q2 * frames_[dof].e2[axis]);
            }
        }
    }

private:
    mfem::FiniteElementSpace &space_;
    const TangentFrameNode *frames_;
    double saturation_magnetization_;
    const double *saturation_magnetization_field_;
    std::uint64_t saturation_magnetization_field_count_;
    const std::uint8_t *magnetic_element_mask_;
    std::uint64_t magnetic_element_mask_count_;
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
    if (request.representation !=
            FloquetBlochScalarRepresentation::shifted_envelope &&
        request.representation !=
            FloquetBlochScalarRepresentation::full_field_phase_constrained) {
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
        const bool shifted_envelope =
            request.representation == FloquetBlochScalarRepresentation::shifted_envelope;
        out_result->k_squared_coefficient =
            std::make_unique<mfem::ConstantCoefficient>(k_squared);
        out_result->k_coefficient =
            std::make_unique<mfem::VectorConstantCoefficient>(k_vector);
        if (request.robin_beta > 0.0) {
            out_result->robin_coefficient =
                std::make_unique<mfem::ConstantCoefficient>(request.robin_beta);
        }
        out_result->form = std::make_unique<mfem::SesquilinearForm>(
            request.scalar_space,
            mfem::ComplexOperator::HERMITIAN);
        out_result->form->AddDomainIntegrator(new mfem::DiffusionIntegrator(), nullptr);
        if (shifted_envelope && k_squared > 0.0) {
            out_result->form->AddDomainIntegrator(
                new mfem::MassIntegrator(*out_result->k_squared_coefficient),
                nullptr);
            out_result->form->AddDomainIntegrator(
                nullptr,
                new mfem::ConvectionIntegrator(*out_result->k_coefficient));
            out_result->form->AddDomainIntegrator(
                nullptr,
                new mfem::ConservativeConvectionIntegrator(*out_result->k_coefficient));
        }
        if (request.robin_beta > 0.0) {
            out_result->form->AddBoundaryIntegrator(
                new mfem::BoundaryMassIntegrator(*out_result->robin_coefficient),
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
        request.tangent_frame_count != static_cast<std::uint64_t>(dof_count)) {
        return FrequencyDomainStatus::validation_error;
    }
    const bool has_saturation_field = request.saturation_magnetization_field != nullptr;
    if ((has_saturation_field != (request.saturation_magnetization_field_count != 0u)) ||
        (has_saturation_field &&
         request.saturation_magnetization_field_count != static_cast<std::uint64_t>(dof_count))) {
        return FrequencyDomainStatus::validation_error;
    }
    if (!has_saturation_field &&
        (!std::isfinite(request.saturation_magnetization_a_per_m) ||
         request.saturation_magnetization_a_per_m <= 0.0)) {
        return FrequencyDomainStatus::validation_error;
    }
    if (has_saturation_field) {
        for (int dof = 0; dof < dof_count; ++dof) {
            const double value = request.saturation_magnetization_field[
                static_cast<std::size_t>(dof)];
            // Nodal Ms fields may carry zero on air nodes.  Magnetic-element
            // masking removes those nodes from the source; negative and
            // non-finite material values remain invalid.
            if (!std::isfinite(value) || value < 0.0) {
                return FrequencyDomainStatus::validation_error;
            }
        }
    }
    if (request.representation !=
            FloquetBlochScalarRepresentation::shifted_envelope &&
        request.representation !=
            FloquetBlochScalarRepresentation::full_field_phase_constrained) {
        return FrequencyDomainStatus::validation_error;
    }
    const int element_count = request.scalar_space->GetMesh()->GetNE();
    if ((request.magnetic_element_mask == nullptr) !=
            (request.magnetic_element_mask_count == 0u) ||
        (request.magnetic_element_mask != nullptr &&
         request.magnetic_element_mask_count != static_cast<std::uint64_t>(element_count))) {
        return FrequencyDomainStatus::validation_error;
    }
    if (request.magnetic_element_mask != nullptr) {
        for (int element = 0; element < element_count; ++element) {
            if (request.magnetic_element_mask[static_cast<std::size_t>(element)] > 1u) {
                return FrequencyDomainStatus::validation_error;
            }
        }
    }
    if ((request.magnetic_reduced_node == nullptr) !=
            (request.magnetic_reduced_node_count == 0u) ||
        (request.magnetic_reduced_node != nullptr &&
         (request.magnetic_reduced_node_count == 0u ||
          request.magnetic_reduced_node_count > static_cast<std::uint64_t>(dof_count)))) {
        return FrequencyDomainStatus::validation_error;
    }
    if (request.magnetic_reduced_node != nullptr) {
        std::vector<bool> reduced_node_seen(
            static_cast<std::size_t>(request.magnetic_reduced_node_count), false);
        const std::uint32_t inactive = std::numeric_limits<std::uint32_t>::max();
        for (int dof = 0; dof < dof_count; ++dof) {
            const std::uint32_t reduced =
                request.magnetic_reduced_node[static_cast<std::size_t>(dof)];
            if (reduced != inactive) {
                if (reduced >= request.magnetic_reduced_node_count) {
                    return FrequencyDomainStatus::validation_error;
                }
                reduced_node_seen[static_cast<std::size_t>(reduced)] = true;
            }
        }
        for (bool seen : reduced_node_seen) {
            if (!seen) {
                return FrequencyDomainStatus::validation_error;
            }
        }
    }
    mfem::Vector k(3);
    for (int axis = 0; axis < 3; ++axis) {
        k[axis] = request.k_rad_per_m[static_cast<std::size_t>(axis)];
        if (!std::isfinite(k[axis])) { return FrequencyDomainStatus::validation_error; }
    }
    try {
        const std::uint64_t output_node_count = request.magnetic_reduced_node != nullptr
            ? request.magnetic_reduced_node_count
            : static_cast<std::uint64_t>(dof_count);
        if (output_node_count >
            static_cast<std::uint64_t>(std::numeric_limits<int>::max() / 2)) {
            return FrequencyDomainStatus::validation_error;
        }
        const int output_width = static_cast<int>(2u * output_node_count);
        auto real = std::make_unique<mfem::SparseMatrix>(dof_count, output_width);
        auto imaginary = std::make_unique<mfem::SparseMatrix>(dof_count, output_width);
        mfem::Vector tangent(2 * dof_count);
        TangentSourceCoefficient source(*request.scalar_space, request.tangent_frames,
                                        request.saturation_magnetization_a_per_m,
                                        request.saturation_magnetization_field,
                                        request.saturation_magnetization_field_count,
                                        request.magnetic_element_mask,
                                        request.magnetic_element_mask_count);
        TangentSourceWavevectorCoefficient k_source(source, k);
        const bool shifted_envelope =
            request.representation == FloquetBlochScalarRepresentation::shifted_envelope;
        for (int column = 0; column < output_width; ++column) {
            tangent = 0.0;
            const int tangent_component = column & 1;
            if (request.magnetic_reduced_node == nullptr) {
                const int dof = column / 2;
                tangent[2 * dof + tangent_component] = 1.0;
            } else {
                const std::uint32_t reduced = static_cast<std::uint32_t>(column / 2);
                const std::uint32_t inactive = std::numeric_limits<std::uint32_t>::max();
                for (int dof = 0; dof < dof_count; ++dof) {
                    if (request.magnetic_reduced_node[static_cast<std::size_t>(dof)] ==
                        reduced) {
                        tangent[2 * dof + tangent_component] = 1.0;
                    } else if (request.magnetic_reduced_node[
                                   static_cast<std::size_t>(dof)] == inactive) {
                        tangent[2 * dof + tangent_component] = 0.0;
                    }
                }
            }
            source.SetTangent(&tangent);
            mfem::LinearForm real_form(request.scalar_space);
            real_form.AddDomainIntegrator(new mfem::DomainLFGradIntegrator(source));
            real_form.Assemble();
            mfem::LinearForm imaginary_form(request.scalar_space);
            if (shifted_envelope) {
                imaginary_form.AddDomainIntegrator(new mfem::DomainLFIntegrator(k_source));
                imaginary_form.Assemble();
            }
            for (int row = 0; row < dof_count; ++row) {
                real->Add(row, column, real_form[row]);
                if (shifted_envelope) {
                    imaginary->Add(row, column, imaginary_form[row]);
                }
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
