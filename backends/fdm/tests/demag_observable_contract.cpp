/* demag_observable_contract.cpp - full-domain demagnetization ownership. */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string read_text(const std::filesystem::path &path) {
    std::ifstream input(path);
    check(input.good(), "source file must be readable");
    std::ostringstream contents;
    contents << input.rdbuf();
    return contents.str();
}

std::filesystem::path source_root() {
    const std::filesystem::path this_file(__FILE__);
    return this_file.is_absolute()
        ? this_file.parent_path().parent_path()
        : std::filesystem::current_path() / this_file.parent_path().parent_path();
}

std::string function_body(const std::string &source, const std::string &signature) {
    const std::size_t start = source.find(signature);
    check(start != std::string::npos, "expected demag function signature");
    const std::size_t body_start = source.find('{', start);
    check(body_start != std::string::npos, "expected demag function body");
    std::size_t depth = 0;
    for (std::size_t index = body_start; index < source.size(); ++index) {
        if (source[index] == '{') {
            ++depth;
        } else if (source[index] == '}') {
            --depth;
            if (depth == 0) {
                return source.substr(body_start, index - body_start + 1);
            }
        }
    }
    check(false, "demag function body must be balanced");
    return {};
}

void visual_buffer_is_separate_from_solver_buffer() {
    const auto root = source_root();
    const auto context_header = read_text(root / "include" / "context.hpp");
    const auto context = read_text(root / "gpu" / "cuda" / "runtime" / "context.cu");
    check(context_header.find("DeviceVectorField h_demag;") != std::string::npos,
          "Context must retain the masked solver demag field");
    check(context_header.find("DeviceVectorField h_demag_visual;") != std::string::npos,
          "Context must own a separate full-domain demag visual field");
    check(context.find("alloc_vector_field(ctx, ctx.h_demag_visual)") != std::string::npos,
          "full-domain demag visual field must be allocated");
    check(context.find("free_vector_field(ctx.h_demag_visual)") != std::string::npos,
          "full-domain demag visual field must be released");
    check(context.find("field = &ctx.h_demag_visual") != std::string::npos,
          "full-domain field transfers must select the visual demag field");
}

void unpack_writes_visual_before_masking_solver() {
    const auto root = source_root();
    const auto fp64 = read_text(root / "gpu" / "cuda" / "interactions" / "demag_fp64.cu");
    const auto fp32 = read_text(root / "gpu" / "cuda" / "interactions" / "demag_fp32.cu");
    for (const auto *source : {&fp64, &fp32}) {
        const auto body = function_body(
            *source,
            source == &fp64 ? "unpack_demag_fft_fp64_kernel(" : "unpack_demag_fft_fp32_kernel(");
        const auto visual_write = body.find("hx_visual");
        const auto mask = body.find("if (has_active_mask");
        check(visual_write != std::string::npos && mask != std::string::npos,
              "unpack kernel must expose visual destination and active mask");
        check(visual_write < mask,
              "unpack kernel must write full-domain visual values before solver masking");
        check(body.find("hy_visual") != std::string::npos &&
                  body.find("hz_visual") != std::string::npos,
              "all visual demag components must be written");
    }
}

} // namespace

int main() {
    visual_buffer_is_separate_from_solver_buffer();
    unpack_writes_visual_before_masking_solver();
    return 0;
}
