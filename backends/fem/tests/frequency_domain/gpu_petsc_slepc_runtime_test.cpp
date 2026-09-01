#include <petscconf.h>

#if !defined(PETSC_HAVE_CUDA)
#error "The production FEM GPU eigensolve runtime requires PETSc CUDA support"
#endif

#if !defined(PETSC_HAVE_HYPRE)
#error "The production FEM GPU eigensolve runtime requires PETSc hypre support"
#endif

#include <petscdevice.h>
#include <petscksp.h>
#include <petscmat.h>
#include <petscvec.h>
#include <slepceps.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

namespace {

int fail(const char* message, PetscErrorCode code = PETSC_SUCCESS)
{
    if (code == PETSC_SUCCESS) {
        std::fprintf(stderr, "gpu_petsc_slepc_runtime_test: %s\n", message);
    } else {
        std::fprintf(
            stderr,
            "gpu_petsc_slepc_runtime_test: %s (PETSc error %d)\n",
            message,
            static_cast<int>(code));
    }
    return 1;
}

}  // namespace

int main(int argc, char** argv)
{
    char gpu_aware_mpi_option[] = "-use_gpu_aware_mpi";
    char gpu_aware_mpi_value[] = "0";
    std::vector<char*> petsc_arguments(argv, argv + argc);
    petsc_arguments.push_back(gpu_aware_mpi_option);
    petsc_arguments.push_back(gpu_aware_mpi_value);
    int petsc_argc = static_cast<int>(petsc_arguments.size());
    char** petsc_argv = petsc_arguments.data();
    PetscErrorCode ierr = SlepcInitialize(&petsc_argc, &petsc_argv, nullptr, nullptr);
    if (ierr != PETSC_SUCCESS) {
        return fail("SlepcInitialize failed", ierr);
    }

    int status = 0;
    Vec x = nullptr;
    Mat a = nullptr;
    KSP ksp = nullptr;
    EPS eps = nullptr;

    do {
        ierr = PetscDeviceInitialize(PETSC_DEVICE_CUDA);
        if (ierr != PETSC_SUCCESS) {
            status = fail("CUDA device initialization failed", ierr);
            break;
        }

        ierr = VecCreate(PETSC_COMM_SELF, &x);
        if (ierr != PETSC_SUCCESS ||
            (ierr = VecSetSizes(x, PETSC_DECIDE, 3)) != PETSC_SUCCESS ||
            (ierr = VecSetType(x, VECCUDA)) != PETSC_SUCCESS ||
            (ierr = VecSet(x, 1.0)) != PETSC_SUCCESS) {
            status = fail("VECCUDA creation or device operation failed", ierr);
            break;
        }
        const char* vec_type = nullptr;
        ierr = VecGetType(x, &vec_type);
        if (ierr != PETSC_SUCCESS || vec_type == nullptr ||
            std::strcmp(vec_type, VECSEQCUDA) != 0) {
            status = fail("PETSc did not materialize a VECSEQCUDA vector", ierr);
            break;
        }
        PetscReal norm = 0.0;
        ierr = VecNorm(x, NORM_2, &norm);
        if (ierr != PETSC_SUCCESS || std::abs(norm - std::sqrt(3.0)) > 1.0e-12) {
            status = fail("VECCUDA norm produced an invalid result", ierr);
            break;
        }
        const PetscScalar* device_values = nullptr;
        ierr = VecCUDAGetArrayRead(x, &device_values);
        if (ierr != PETSC_SUCCESS || device_values == nullptr) {
            status = fail("VECSEQCUDA did not expose a device-resident array", ierr);
            break;
        }
        ierr = VecCUDARestoreArrayRead(x, &device_values);
        if (ierr != PETSC_SUCCESS) {
            status = fail("VECSEQCUDA device-array restore failed", ierr);
            break;
        }

        ierr = MatCreate(PETSC_COMM_SELF, &a);
        if (ierr != PETSC_SUCCESS ||
            (ierr = MatSetSizes(a, PETSC_DECIDE, PETSC_DECIDE, 3, 3)) != PETSC_SUCCESS ||
            (ierr = MatSetType(a, MATAIJCUSPARSE)) != PETSC_SUCCESS ||
            (ierr = MatSeqAIJSetPreallocation(a, 1, nullptr)) != PETSC_SUCCESS) {
            status = fail("MATAIJCUSPARSE creation failed", ierr);
            break;
        }
        for (PetscInt row = 0; row < 3; ++row) {
            const PetscScalar value = static_cast<PetscScalar>(row + 1);
            ierr = MatSetValue(a, row, row, value, INSERT_VALUES);
            if (ierr != PETSC_SUCCESS) {
                status = fail("MATAIJCUSPARSE value insertion failed", ierr);
                break;
            }
        }
        if (status != 0) {
            break;
        }
        ierr = MatAssemblyBegin(a, MAT_FINAL_ASSEMBLY);
        if (ierr != PETSC_SUCCESS ||
            (ierr = MatAssemblyEnd(a, MAT_FINAL_ASSEMBLY)) != PETSC_SUCCESS) {
            status = fail("MATAIJCUSPARSE assembly failed", ierr);
            break;
        }
        const char* mat_type = nullptr;
        ierr = MatGetType(a, &mat_type);
        if (ierr != PETSC_SUCCESS || mat_type == nullptr ||
            std::strcmp(mat_type, MATSEQAIJCUSPARSE) != 0) {
            status = fail("PETSc did not materialize a MATSEQAIJCUSPARSE matrix", ierr);
            break;
        }

        ierr = KSPCreate(PETSC_COMM_SELF, &ksp);
        if (ierr != PETSC_SUCCESS ||
            (ierr = KSPSetOperators(ksp, a, a)) != PETSC_SUCCESS) {
            status = fail("KSP creation for the CUDA matrix failed", ierr);
            break;
        }
        PC pc = nullptr;
        ierr = KSPGetPC(ksp, &pc);
        if (ierr != PETSC_SUCCESS ||
            (ierr = PCSetType(pc, PCHYPRE)) != PETSC_SUCCESS ||
            (ierr = PCHYPRESetType(pc, "boomeramg")) != PETSC_SUCCESS ||
            (ierr = KSPSetUp(ksp)) != PETSC_SUCCESS) {
            status = fail("PCHYPRE setup against the CUDA matrix failed", ierr);
            break;
        }
        const char* pc_type = nullptr;
        ierr = PCGetType(pc, &pc_type);
        if (ierr != PETSC_SUCCESS || pc_type == nullptr ||
            std::strcmp(pc_type, PCHYPRE) != 0) {
            status = fail("PETSc did not retain the PCHYPRE preconditioner", ierr);
            break;
        }

        ierr = EPSCreate(PETSC_COMM_SELF, &eps);
        if (ierr != PETSC_SUCCESS ||
            (ierr = EPSSetOperators(eps, a, nullptr)) != PETSC_SUCCESS ||
            (ierr = EPSSetProblemType(eps, EPS_HEP)) != PETSC_SUCCESS ||
            (ierr = EPSSetDimensions(eps, 1, PETSC_DEFAULT, PETSC_DEFAULT)) != PETSC_SUCCESS ||
            (ierr = EPSSolve(eps)) != PETSC_SUCCESS) {
            status = fail("SLEPc eigensolve on MATAIJCUSPARSE failed", ierr);
            break;
        }
        PetscInt converged = 0;
        ierr = EPSGetConverged(eps, &converged);
        if (ierr != PETSC_SUCCESS || converged < 1) {
            status = fail("SLEPc did not converge an eigenpair on the CUDA matrix", ierr);
            break;
        }
        BV basis = nullptr;
        Vec basis_column = nullptr;
        ierr = EPSGetBV(eps, &basis);
        if (ierr != PETSC_SUCCESS ||
            (ierr = BVGetColumn(basis, 0, &basis_column)) != PETSC_SUCCESS) {
            status = fail("SLEPc basis-vector inspection failed", ierr);
            break;
        }
        const char* basis_vec_type = nullptr;
        ierr = VecGetType(basis_column, &basis_vec_type);
        const bool basis_is_cuda = ierr == PETSC_SUCCESS && basis_vec_type != nullptr &&
                                   std::strcmp(basis_vec_type, VECSEQCUDA) == 0;
        const PetscErrorCode restore_error = BVRestoreColumn(basis, 0, &basis_column);
        if (!basis_is_cuda || restore_error != PETSC_SUCCESS) {
            status = fail(
                "SLEPc did not retain CUDA-resident basis vectors",
                ierr != PETSC_SUCCESS ? ierr : restore_error);
            break;
        }

        std::printf(
            "PETSc CUDA/SLEPc/hypre runtime proof passed: vec=%s mat=%s pc=%s basis=%s converged=%d\n",
            vec_type,
            mat_type,
            pc_type,
            basis_vec_type,
            static_cast<int>(converged));
    } while (false);

    if (eps != nullptr) {
        EPSDestroy(&eps);
    }
    if (ksp != nullptr) {
        KSPDestroy(&ksp);
    }
    if (a != nullptr) {
        MatDestroy(&a);
    }
    if (x != nullptr) {
        VecDestroy(&x);
    }
    const PetscErrorCode finalize_error = SlepcFinalize();
    if (status == 0 && finalize_error != PETSC_SUCCESS) {
        return fail("SlepcFinalize failed", finalize_error);
    }
    return status;
}
