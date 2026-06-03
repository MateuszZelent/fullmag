#pragma once

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace fullmag::fem::tests {

inline void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

inline std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

inline std::filesystem::path fem_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

inline std::filesystem::path repo_root() {
    auto path = fem_source_root();
    for (int depth = 0; depth < 8; ++depth) {
        if (std::filesystem::exists(path / "Cargo.toml") &&
            std::filesystem::exists(path / "justfile")) {
            return path;
        }
        if (!path.has_parent_path()) {
            break;
        }
        path = path.parent_path();
    }

    std::fprintf(
        stderr,
        "FAIL: unable to locate repository root from %s\n",
        fem_source_root().string().c_str());
    std::exit(1);
}

} // namespace fullmag::fem::tests
