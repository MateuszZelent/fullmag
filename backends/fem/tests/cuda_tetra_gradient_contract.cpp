/*
 * cuda_tetra_gradient_contract.cpp - source contract for CUDA P1 tetra gradients.
 *
 * The CUDA helper is device-private, so this test pins the algebraic source
 * form that DMI and Zhang-Li use for non-axis-aligned tetrahedra.
 */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *msg)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path fem_source_root()
{
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

void cuda_tetra_gradients_use_inverse_edge_matrix_rows()
{
    const std::filesystem::path root = fem_source_root();
    const std::string dmi_kernels =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "dmi" / "dmi_kernels.cu");
    const std::string stt_kernels =
        read_text_file(root / "gpu" / "cuda" / "interactions" / "stt" / "stt_kernels.cu");

    for (const auto *kernels : {&dmi_kernels, &stt_kernels}) {
        check(
            kernels->find("grads[1][0] =  (d2y * d3z - d2z * d3y) * inv_det;") != std::string::npos &&
                kernels->find("grads[1][1] = -(d2x * d3z - d2z * d3x) * inv_det;") != std::string::npos &&
                kernels->find("grads[1][2] =  (d2x * d3y - d2y * d3x) * inv_det;") != std::string::npos &&
                kernels->find("grads[2][0] = -(d1y * d3z - d1z * d3y) * inv_det;") != std::string::npos &&
                kernels->find("grads[2][1] =  (d1x * d3z - d1z * d3x) * inv_det;") != std::string::npos &&
                kernels->find("grads[2][2] = -(d1x * d3y - d1y * d3x) * inv_det;") != std::string::npos &&
                kernels->find("grads[3][0] =  (d1y * d2z - d1z * d2y) * inv_det;") != std::string::npos &&
                kernels->find("grads[3][1] = -(d1x * d2z - d1z * d2x) * inv_det;") != std::string::npos &&
                kernels->find("grads[3][2] =  (d1x * d2y - d1y * d2x) * inv_det;") != std::string::npos,
            "CUDA DMI/STT tetra gradients must write inverse-edge-matrix rows for non-axis-aligned tetrahedra");
    }
}

} // namespace

int main()
{
    cuda_tetra_gradients_use_inverse_edge_matrix_rows();
    std::printf("FEM CUDA tetra gradient contract PASS\n");
    return 0;
}
