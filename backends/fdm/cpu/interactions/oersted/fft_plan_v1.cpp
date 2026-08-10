#include "fft_plan_v1.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>

namespace fullmag::fdm::cpu::oersted::v1::detail {
namespace {

constexpr double pi = 3.141592653589793238462643383279502884;

bool is_power_of_two(std::size_t value) noexcept {
    return value != 0 && (value & (value - 1U)) == 0;
}

std::size_t next_power_of_two(std::size_t value) {
    std::size_t result = 1;
    while (result < value) {
        if (result > std::numeric_limits<std::size_t>::max() / 2U) {
            throw std::overflow_error("FFT Bluestein convolution size overflow");
        }
        result *= 2U;
    }
    return result;
}

Complex unit_phasor(double angle) {
    return {std::cos(angle), std::sin(angle)};
}

} // namespace

Fft1dPlan::Fft1dPlan(std::size_t size) : size_(size), radix2_(is_power_of_two(size)) {
    if (size_ == 0) {
        throw std::invalid_argument("FFT axis length must be positive");
    }
    if (radix2_) {
        bit_reverse_.resize(size_);
        std::size_t bits = 0;
        while ((std::size_t{1} << bits) < size_) {
            ++bits;
        }
        for (std::size_t value = 0; value < size_; ++value) {
            std::size_t reversed = 0;
            for (std::size_t bit = 0; bit < bits; ++bit) {
                reversed = (reversed << 1U) | ((value >> bit) & 1U);
            }
            bit_reverse_[value] = reversed;
        }
        roots_.resize(size_ / 2U);
        for (std::size_t k = 0; k < roots_.size(); ++k) {
            roots_[k] = unit_phasor(-2.0 * pi * static_cast<double>(k) /
                                    static_cast<double>(size_));
        }
        return;
    }

    convolution_size_ = next_power_of_two(2U * size_ - 1U);
    convolution_plan_ = std::make_unique<Fft1dPlan>(convolution_size_);
    chirp_.resize(size_);
    convolution_kernel_spectrum_.assign(convolution_size_, Complex{});
    scratch_.assign(convolution_size_, Complex{});
    const std::uint64_t modulus = static_cast<std::uint64_t>(2U * size_);
    for (std::size_t index = 0; index < size_; ++index) {
        const std::uint64_t value = static_cast<std::uint64_t>(index);
        const std::uint64_t square_mod = (value * value) % modulus;
        const double angle = pi * static_cast<double>(square_mod) /
                             static_cast<double>(size_);
        chirp_[index] = unit_phasor(-angle);
        const Complex kernel = unit_phasor(angle);
        convolution_kernel_spectrum_[index] = kernel;
        if (index != 0) {
            convolution_kernel_spectrum_[convolution_size_ - index] = kernel;
        }
    }
    convolution_plan_->transform(convolution_kernel_spectrum_.data(), false);
}

void Fft1dPlan::radix2_forward(Complex *data) const {
    for (std::size_t index = 0; index < size_; ++index) {
        const std::size_t reversed = bit_reverse_[index];
        if (reversed > index) {
            std::swap(data[index], data[reversed]);
        }
    }
    for (std::size_t length = 2; length <= size_; length *= 2U) {
        const std::size_t half = length / 2U;
        const std::size_t root_step = size_ / length;
        for (std::size_t base = 0; base < size_; base += length) {
            for (std::size_t offset = 0; offset < half; ++offset) {
                const Complex even = data[base + offset];
                const Complex odd = data[base + offset + half] *
                                    roots_[offset * root_step];
                data[base + offset] = even + odd;
                data[base + offset + half] = even - odd;
            }
        }
        if (length == size_) {
            break;
        }
    }
}

void Fft1dPlan::bluestein_forward(Complex *data) {
    std::fill(scratch_.begin(), scratch_.end(), Complex{});
    for (std::size_t index = 0; index < size_; ++index) {
        scratch_[index] = data[index] * chirp_[index];
    }
    convolution_plan_->transform(scratch_.data(), false);
    for (std::size_t index = 0; index < convolution_size_; ++index) {
        scratch_[index] *= convolution_kernel_spectrum_[index];
    }
    convolution_plan_->transform(scratch_.data(), true);
    const double inverse_convolution_size = 1.0 / static_cast<double>(convolution_size_);
    for (std::size_t index = 0; index < size_; ++index) {
        data[index] = scratch_[index] * inverse_convolution_size * chirp_[index];
    }
}

void Fft1dPlan::forward(Complex *data) {
    if (radix2_) {
        radix2_forward(data);
    } else {
        bluestein_forward(data);
    }
}

void Fft1dPlan::transform(Complex *data, bool inverse) {
    if (data == nullptr) {
        throw std::invalid_argument("FFT data pointer must be non-null");
    }
    if (!inverse) {
        forward(data);
        return;
    }
    for (std::size_t index = 0; index < size_; ++index) {
        data[index] = std::conj(data[index]);
    }
    forward(data);
    for (std::size_t index = 0; index < size_; ++index) {
        data[index] = std::conj(data[index]);
    }
}

Fft3dPlan::Fft3dPlan(std::size_t nx, std::size_t ny, std::size_t nz)
    : nx_(nx), ny_(ny), nz_(nz), x_plan_(nx), y_plan_(ny), z_plan_(nz),
      line_(std::max({nx, ny, nz})) {}

std::size_t Fft3dPlan::index(std::size_t x,
                             std::size_t y,
                             std::size_t z) const noexcept {
    return (z * ny_ + y) * nx_ + x;
}

void Fft3dPlan::transform(std::vector<Complex> &data, bool inverse) {
    if (data.size() != nx_ * ny_ * nz_) {
        throw std::invalid_argument("3-D FFT buffer size mismatch");
    }
    for (std::size_t z = 0; z < nz_; ++z) {
        for (std::size_t y = 0; y < ny_; ++y) {
            x_plan_.transform(data.data() + index(0, y, z), inverse);
        }
    }
    for (std::size_t z = 0; z < nz_; ++z) {
        for (std::size_t x = 0; x < nx_; ++x) {
            for (std::size_t y = 0; y < ny_; ++y) {
                line_[y] = data[index(x, y, z)];
            }
            y_plan_.transform(line_.data(), inverse);
            for (std::size_t y = 0; y < ny_; ++y) {
                data[index(x, y, z)] = line_[y];
            }
        }
    }
    for (std::size_t y = 0; y < ny_; ++y) {
        for (std::size_t x = 0; x < nx_; ++x) {
            for (std::size_t z = 0; z < nz_; ++z) {
                line_[z] = data[index(x, y, z)];
            }
            z_plan_.transform(line_.data(), inverse);
            for (std::size_t z = 0; z < nz_; ++z) {
                data[index(x, y, z)] = line_[z];
            }
        }
    }
}

} // namespace fullmag::fdm::cpu::oersted::v1::detail
