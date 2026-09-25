#include "cpu/frequency_domain/floquet_bloch_scalar.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

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
    double k[3] = {};
    for (int axis = 0; axis < 3; ++axis) {
        k[axis] = request.k_rad_per_m[static_cast<std::size_t>(axis)];
        if (!std::isfinite(k[axis])) { return FrequencyDomainStatus::validation_error; }
    }
    for (int dof = 0; dof < dof_count; ++dof) {
        for (int component = 0; component < 3; ++component) {
            if (!std::isfinite(request.tangent_frames[dof].e1[component]) ||
                !std::isfinite(request.tangent_frames[dof].e2[component])) {
                return FrequencyDomainStatus::validation_error;
            }
        }
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
        const bool shifted_envelope =
            request.representation == FloquetBlochScalarRepresentation::shifted_envelope;
        const std::uint32_t inactive = std::numeric_limits<std::uint32_t>::max();
        mfem::Mesh *mesh = request.scalar_space->GetMesh();
        // Assemble the element-local bilinear action directly.  The previous
        // implementation assembled one global LinearForm per tangent column;
        // that made O(N_tangent) global passes over the mesh and hid the
        // actual source stencil.  These entries are exactly the two MFEM
        // forms used by the old path, with the tangent basis and Ms factor
        // expanded in the trial shape function.
        for (int element = 0; element < element_count; ++element) {
            if (request.magnetic_element_mask != nullptr &&
                request.magnetic_element_mask[static_cast<std::size_t>(element)] == 0u) {
                continue;
            }
            mfem::Array<int> dofs;
            request.scalar_space->GetElementDofs(element, dofs);
            const mfem::FiniteElement *finite_element =
                request.scalar_space->GetFE(element);
            mfem::ElementTransformation *transformation =
                mesh->GetElementTransformation(element);
            const mfem::IntegrationRule &rule = mfem::IntRules.Get(
                finite_element->GetGeomType(), 2 * finite_element->GetOrder());
            mfem::Vector shape(dofs.Size());
            mfem::DenseMatrix physical_dshape(dofs.Size(), 3);
            for (int point_index = 0; point_index < rule.GetNPoints(); ++point_index) {
                const mfem::IntegrationPoint &point = rule.IntPoint(point_index);
                transformation->SetIntPoint(&point);
                finite_element->CalcShape(point, shape);
                finite_element->CalcPhysDShape(*transformation, physical_dshape);
                const double weight = transformation->Weight() * point.weight;
                if (!std::isfinite(weight)) {
                    return FrequencyDomainStatus::operator_error;
                }
                for (int local_test = 0; local_test < dofs.Size(); ++local_test) {
                    const int test_node = dofs[local_test] >= 0
                        ? dofs[local_test] : -1 - dofs[local_test];
                    const double test_sign = dofs[local_test] >= 0 ? 1.0 : -1.0;
                    if (test_node < 0 || test_node >= dof_count) {
                        return FrequencyDomainStatus::operator_error;
                    }
                    for (int local_trial = 0; local_trial < dofs.Size(); ++local_trial) {
                        const int trial_node = dofs[local_trial] >= 0
                            ? dofs[local_trial] : -1 - dofs[local_trial];
                        const double trial_sign = dofs[local_trial] >= 0 ? 1.0 : -1.0;
                        if (trial_node < 0 || trial_node >= dof_count) {
                            return FrequencyDomainStatus::operator_error;
                        }
                        const std::uint32_t output_node =
                            request.magnetic_reduced_node == nullptr
                                ? static_cast<std::uint32_t>(trial_node)
                                : request.magnetic_reduced_node[
                                      static_cast<std::size_t>(trial_node)];
                        if (output_node == inactive) {
                            continue;
                        }
                        if (output_node >= output_node_count) {
                            return FrequencyDomainStatus::operator_error;
                        }
                        const double saturation_magnetization =
                            request.saturation_magnetization_field != nullptr
                                ? request.saturation_magnetization_field[
                                      static_cast<std::size_t>(trial_node)]
                                : request.saturation_magnetization_a_per_m;
                        if (!std::isfinite(saturation_magnetization) ||
                            !std::isfinite(shape[local_test]) ||
                            !std::isfinite(shape[local_trial])) {
                            return FrequencyDomainStatus::operator_error;
                        }
                        for (std::uint32_t component = 0; component < 2u; ++component) {
                            const double *frame = component == 0u
                                ? request.tangent_frames[trial_node].e1
                                : request.tangent_frames[trial_node].e2;
                            double gradient_dot_frame = 0.0;
                            double wavevector_dot_frame = 0.0;
                            for (int axis = 0; axis < 3; ++axis) {
                                gradient_dot_frame +=
                                    physical_dshape(local_test, axis) * frame[axis];
                                wavevector_dot_frame += k[axis] * frame[axis];
                            }
                            const double prefactor = weight * test_sign * trial_sign *
                                saturation_magnetization * shape[local_trial];
                            const int column = static_cast<int>(2u * output_node + component);
                            real->Add(
                                test_node,
                                column,
                                prefactor * gradient_dot_frame);
                            if (shifted_envelope) {
                                imaginary->Add(
                                    test_node,
                                    column,
                                    prefactor * shape[local_test] * wavevector_dot_frame);
                            }
                        }
                    }
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
