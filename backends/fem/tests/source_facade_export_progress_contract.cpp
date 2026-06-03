/*
 * source_facade_export_progress_contract.cpp - native FEM source-facade ownership docs.
 *
 * Split from source_facade_contract.cpp so each native FEM source-layout
 * contract has a narrow ownership surface and stays below the monolith limit.
 */

#include "source_facade_contract_utils.hpp"

namespace {

using fullmag::fem::tests::check;
using fullmag::fem::tests::fem_source_root;
using fullmag::fem::tests::read_text_file;
using fullmag::fem::tests::repo_root;

void managed_runtime_export_keeps_mfem_headers_linkable() {
    const std::string export_script =
        read_text_file(repo_root() / "scripts" / "export_fem_gpu_runtime.sh");
    const std::string justfile = read_text_file(repo_root() / "justfile");

    check(
        export_script.find("${RUNTIME_ROOT}/include") != std::string::npos ||
            export_script.find(".fullmag/runtimes/fem-gpu-host/include") !=
                std::string::npos,
        "FEM runtime export must create a managed include directory");
    check(
        export_script.find("/opt/fullmag-deps/include") != std::string::npos,
        "FEM runtime export must copy MFEM/libCEED/Hypre headers from the container deps prefix");
    check(
        export_script.find("relocating MFEM CMake package metadata") !=
            std::string::npos,
        "FEM runtime export must rewrite MFEM CMake package metadata for host relocation");
    check(
        export_script.find("MFEMConfig.cmake") != std::string::npos &&
            export_script.find("MFEMTargets.cmake") != std::string::npos,
        "FEM runtime export must relocate both MFEMConfig and MFEMTargets metadata");
    check(
        export_script.find(R"(\\\${PACKAGE_PREFIX_DIR}/include)") !=
            std::string::npos &&
            export_script.find(R"(\\\${_IMPORT_PREFIX}/lib)") !=
                std::string::npos,
        "FEM runtime export must preserve CMake package variables through shell and Perl escaping");
    check(
        export_script.find("/usr/lib/x86_64-linux-gnu/openmpi/include") !=
            std::string::npos,
        "FEM runtime export must bundle OpenMPI headers referenced by MFEM package metadata");
    check(
        export_script.find(".fullmag/runtimes/fem-gpu-host/openmpi/share/openmpi/help-mpi-runtime.txt") !=
                std::string::npos &&
            export_script.find(".fullmag/runtimes/fem-gpu-host/openmpi/lib/openmpi3/mca_ess_singleton.so") !=
                std::string::npos &&
            export_script.find(".fullmag/runtimes/fem-gpu-host/openmpi/lib/openmpi3/mca_plm_isolated.so") !=
                std::string::npos &&
            export_script.find(".fullmag/runtimes/fem-gpu-host/openmpi/lib/openmpi3/mca_pmix_isolated.so") !=
                std::string::npos,
        "FEM runtime export must validate OpenMPI help files and singleton/isolated runtime components");
    check(
        export_script.find(".fullmag/runtimes/fem-gpu-host/lib/pmix2/lib/pmix/mca_pcompress_zlib.so") !=
                std::string::npos &&
            export_script.find(".fullmag/runtimes/fem-gpu-host/lib/pmix2/share/pmix/help-pmix-runtime.txt") !=
                std::string::npos,
        "FEM runtime export must validate PMIx components and help files");
    check(
        export_script.find("managed FEM runtime is missing OpenMPI runtime component") !=
                std::string::npos &&
            export_script.find("managed FEM runtime is missing PMIx runtime component") !=
                std::string::npos,
        "managed FEM launcher must fail fast when exported MPI runtime components are missing");
    check(
        export_script.find("copy_native_library_group()") != std::string::npos &&
            export_script.find("copy_native_library_group \"$FEM_LIB\" libfullmag_fem") !=
                std::string::npos &&
            export_script.find("copy_native_library_group \"$FDM_LIB\" libfullmag_fdm") !=
                std::string::npos,
        "FEM runtime export must copy native library real files before symlinks");
    check(
        export_script.find("OMPI_MCA_btl=\"${OMPI_MCA_btl:-self}\"") != std::string::npos &&
            export_script.find("OMPI_MCA_ess=\"${OMPI_MCA_ess:-singleton}\"") != std::string::npos &&
            export_script.find("OMPI_MCA_plm=\"${OMPI_MCA_plm:-isolated}\"") != std::string::npos &&
            export_script.find("OMPI_MCA_pmix=\"${OMPI_MCA_pmix:-isolated}\"") != std::string::npos &&
            export_script.find("OMPI_MCA_ras=\"${OMPI_MCA_ras:-simulator}\"") != std::string::npos &&
            export_script.find("OMPI_MCA_oob=\"${OMPI_MCA_oob:-tcp}\"") != std::string::npos &&
            export_script.find("OMPI_MCA_oob_tcp_if_include=lo") != std::string::npos,
        "managed FEM launcher must force singleton OpenMPI onto isolated local launch with local TCP OOB fallback");
    check(
        export_script.find("PMIX_DATADIR=\"${RUNTIME_ROOT}/lib/pmix2/share\"") !=
                std::string::npos &&
            export_script.find("PMIX_PKGDATADIR=\"${RUNTIME_ROOT}/lib/pmix2/share/pmix\"") !=
                std::string::npos &&
            export_script.find(
                "PMIX_MCA_mca_base_component_path=\"${RUNTIME_ROOT}/lib/pmix2/lib/pmix\"") !=
                std::string::npos,
        "managed FEM launcher must point PMIx at bundled data and component directories");
    check(
        export_script.find("/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcurand.so") !=
            std::string::npos &&
            export_script.find("/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcublas.so") !=
                std::string::npos &&
            export_script.find("/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcusparse.so") !=
                std::string::npos,
        "FEM runtime export must bundle CUDA shared libraries referenced by MFEMTargets metadata");
    check(
        export_script.find("/usr/local/cuda-12.4/targets/x86_64-linux/include") !=
            std::string::npos,
        "FEM runtime export must bundle CUDA headers included by MFEM headers");
    check(
        export_script.find("performing full cargo clean") == std::string::npos,
        "FEM runtime export must not claim to run cargo clean when using the cached cargo target");
    check(
        export_script.find("manifest.json") != std::string::npos &&
            export_script.find("docker_image_id") != std::string::npos &&
            export_script.find("created_at") != std::string::npos,
        "FEM runtime export must write a manifest that identifies the exported runtime bundle");

    const std::string ensure_marker = "ensure-managed-fem-runtime:\n";
    const std::size_t ensure_start = justfile.find(ensure_marker);
    check(
        ensure_start != std::string::npos,
        "justfile must define ensure-managed-fem-runtime");
    const std::size_t ensure_end =
        justfile.find("\n\nrun-stno-interactive-managed", ensure_start);
    check(
        ensure_end != std::string::npos,
        "justfile managed FEM runtime freshness recipe must remain bounded");
    const std::string ensure_recipe =
        justfile.substr(ensure_start, ensure_end - ensure_start);
    check(
        ensure_recipe.find("packages/fullmag-py/src") == std::string::npos,
        "Python DSL-only source changes must not force a managed FEM runtime rebuild");
    check(
        ensure_recipe.find("docker/fem-gpu/Dockerfile") != std::string::npos &&
            ensure_recipe.find("compose.yaml") != std::string::npos,
        "managed FEM runtime freshness must include Docker image inputs");
    check(
        ensure_recipe.find("gpu_runtime_manifest") != std::string::npos,
        "managed FEM runtime freshness must require the exported runtime manifest");
}


void progress_report_marks_device_runtime_split_contract_covered() {
    const std::string progress = read_text_file(
        repo_root() / "docs" / "reports" / "16.05.2026" /
        "fullmag_fem_cpu_refactor_progress_2026-05-16.md");

    check(
        progress.find("| Wydzielic device/runtime z `mfem_bridge.cpp` | zrobione kontraktowo |") != std::string::npos,
        "progress report must mark the device/runtime split as contractually covered");
    check(
        progress.find("`fem_source_facade_contract`") != std::string::npos &&
            progress.find("`fem_mfem_context_contract`") != std::string::npos &&
            progress.find("`fem_mfem_device_contract`") != std::string::npos &&
            progress.find("`fem_gpu_state_runtime_contract`") != std::string::npos &&
            progress.find("`fem_state_io_contract`") != std::string::npos &&
            progress.find("`fem_cpu_threads_contract`") != std::string::npos,
        "progress report must cite the runtime split contract gates");
    check(
        progress.find("backend_lifecycle") != std::string::npos &&
            progress.find("backend_step") != std::string::npos &&
            progress.find("eigen_dense") != std::string::npos &&
            progress.find("interrupt") != std::string::npos &&
            progress.find("availability") != std::string::npos,
        "progress report must mention the runtime facade modules");
    check(
        progress.find("nie zamyka aktywnej kwalifikacji runtime MFEM/libCEED") !=
            std::string::npos,
        "progress report must keep active MFEM/libCEED runtime qualification open");
}


void progress_report_marks_context_split_contract_covered() {
    const std::string progress = read_text_file(
        repo_root() / "docs" / "reports" / "16.05.2026" /
        "fullmag_fem_cpu_refactor_progress_2026-05-16.md");

    check(
        progress.find("| Rozbic `Context` na `FemMesh`, `FemState`, `FemFieldBuffers`, `FemWorkspace` itd. | zrobione kontraktowo |") != std::string::npos,
        "progress report must mark the Context split as contract-covered");
    check(
        progress.find("`fem_source_facade_contract`") != std::string::npos &&
            progress.find("`fem_plan_fields_contract`") != std::string::npos &&
            progress.find("`fem_mesh_contract`") != std::string::npos &&
            progress.find("`fem_state_contract`") != std::string::npos &&
            progress.find("`fem_material_fields_contract`") != std::string::npos &&
            progress.find("`fem_field_buffers_contract`") != std::string::npos,
        "progress report must cite core Context split contract gates");
    check(
        progress.find("`fem_rk_explicit_contract`") != std::string::npos &&
            progress.find("`fem_mfem_context_contract`") != std::string::npos &&
            progress.find("`fem_gpu_state_runtime_contract`") != std::string::npos &&
            progress.find("`fem_demag_contract`") != std::string::npos &&
            progress.find("`fem_demag_poisson_contract`") != std::string::npos &&
            progress.find("`fem_demag_fem_bem_contract`") != std::string::npos,
        "progress report must cite workspace/runtime owner contract gates");
    check(
        progress.find("Context pozostaje compatibility facade") != std::string::npos &&
            progress.find("nie jest juz wlascicielem plaskich pol core/runtime/interaction/workspace") !=
                std::string::npos,
        "progress report must describe Context as a facade rather than a flat owner");
}


} // namespace

int main() {
    managed_runtime_export_keeps_mfem_headers_linkable();
    progress_report_marks_device_runtime_split_contract_covered();
    progress_report_marks_context_split_contract_covered();
    return 0;
}
