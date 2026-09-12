#include "source_facade_contract_utils.hpp"

namespace {

using fullmag::fem::tests::check;
using fullmag::fem::tests::read_text_file;
using fullmag::fem::tests::repo_root;

void managed_fem_dependency_stack_uses_qualified_versions() {
    const std::string dockerfile =
        read_text_file(repo_root() / "docker" / "fem-gpu" / "Dockerfile");
    const std::string guide = read_text_file(
        repo_root() / "docs" / "guides" / "mfem-host-parity-setup-ubuntu22.md");

    check(
        dockerfile.find("ENV MFEM_REF=v4.9") != std::string::npos,
        "managed FEM GPU image must pin MFEM v4.9");
    check(
        dockerfile.find("ENV HYPRE_REF=v3.1.0") != std::string::npos,
        "managed FEM GPU image must pin hypre v3.1.0");
    check(
        dockerfile.find("ENV PETSC_REF=v3.24.6") != std::string::npos,
        "managed FEM GPU image must pin PETSc v3.24.6");
    check(
        dockerfile.find("ENV SLEPC_REF=v3.24.3") != std::string::npos,
        "managed FEM GPU image must pin SLEPc v3.24.3");
    check(
        dockerfile.find("--with-cuda=1") != std::string::npos &&
            dockerfile.find("--with-scalar-type=real") != std::string::npos &&
            dockerfile.find("--with-precision=double") != std::string::npos,
        "managed FEM GPU image must build real/double PETSc with CUDA");
    check(
        dockerfile.find("--with-cuda-arch=80,89,90") != std::string::npos,
        "managed FEM GPU PETSc must retain the qualified sm_80/sm_89/sm_90 device range");
    const std::string petsc_patch = read_text_file(
        repo_root() / "docker" / "fem-gpu" / "patches" /
        "petsc-3.24.6-multiarch-nvcc.diff");
    check(
        dockerfile.find("git apply /tmp/build/petsc-3.24.6-multiarch-nvcc.diff") !=
                std::string::npos &&
            petsc_patch.find("-gencode arch=compute_{0},code=sm_{0}") !=
                std::string::npos &&
            petsc_patch.find("-gencode arch=compute_{0},code=compute_{0}") !=
                std::string::npos,
        "managed FEM GPU PETSc must patch nvcc multiarch flags to SASS plus highest-arch PTX");
    check(
            dockerfile.find("COPTFLAGS=-O3") != std::string::npos &&
            dockerfile.find("CXXOPTFLAGS=-O3") != std::string::npos &&
            dockerfile.find("FOPTFLAGS=-O3") != std::string::npos &&
            dockerfile.find("CUDAOPTFLAGS=\"-O3 -lineinfo\"") != std::string::npos,
        "managed FEM GPU PETSc must use explicit optimized release flags");
    check(
        dockerfile.find("--with-hypre-dir=${INSTALL_PREFIX}") != std::string::npos,
        "managed FEM GPU PETSc must bind the qualified hypre stack");
    check(
        dockerfile.find("libpetsc-real-dev") == std::string::npos &&
            dockerfile.find("libslepc-real-dev") == std::string::npos,
        "managed FEM GPU image must not install the CPU-only distro PETSc/SLEPc stack");
    check(
        dockerfile.find("libhdf5-dev") != std::string::npos,
        "managed FEM GPU build image must provide HDF5 headers for stage autosave");
    const std::size_t runtime_stage = dockerfile.find(" AS fem-gpu-dev");
    check(
        runtime_stage != std::string::npos &&
            dockerfile.find("libblas3", runtime_stage) != std::string::npos &&
            dockerfile.find("liblapack3", runtime_stage) != std::string::npos,
        "managed FEM GPU runtime image must provide PETSc BLAS/LAPACK dependencies");
    check(
        guide.find("MFEM v4.9") != std::string::npos,
        "host-parity guide must document MFEM v4.9");
    check(
        guide.find("hypre v3.1.0") != std::string::npos,
        "host-parity guide must document hypre v3.1.0");
}

} // namespace

int main() {
    managed_fem_dependency_stack_uses_qualified_versions();
    return 0;
}
