#pragma once

#include <fullmag/fdm/cpu/oersted_fft_open_v1.hpp>

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace fullmag::fdm::cpu::oersted::v1::detail {

class CanonicalBytes {
  public:
    void tag(std::string_view value);
    void u8(std::uint8_t value);
    void u64(std::uint64_t value);
    void f64(double value);
    void boolean(bool value);
    void text(std::string_view value);
    void bytes(const std::vector<std::uint8_t> &value);
    void f64_vector(const std::vector<double> &value);
    void u64_vector(const std::vector<std::uint64_t> &value);
    void i8_vector(const std::vector<std::int8_t> &value);

    const std::vector<std::uint8_t> &data() const noexcept { return data_; }

  private:
    std::vector<std::uint8_t> data_;
};

std::string sha256_digest(const std::vector<std::uint8_t> &bytes);
std::string sha256_text(std::string_view text);

std::size_t checked_cell_count(const Grid &grid, bool &ok) noexcept;
std::array<std::size_t, 3> padded_shape(const Grid &grid) noexcept;
std::size_t cell_index(const Grid &grid,
                       std::size_t x,
                       std::size_t y,
                       std::size_t z) noexcept;
std::size_t x_face_index(const Grid &grid,
                         std::size_t x,
                         std::size_t y,
                         std::size_t z) noexcept;
std::size_t y_face_index(const Grid &grid,
                         std::size_t x,
                         std::size_t y,
                         std::size_t z) noexcept;
std::size_t z_face_index(const Grid &grid,
                         std::size_t x,
                         std::size_t y,
                         std::size_t z) noexcept;

DifferentialDiagnostics compute_differential_diagnostics(
    const Grid &grid,
    const std::vector<Vector3> &cell_current_density_a_per_m2,
    const std::vector<Vector3> &field_a_per_m);

} // namespace fullmag::fdm::cpu::oersted::v1::detail
