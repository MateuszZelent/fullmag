#pragma once

#include <complex>
#include <cstddef>
#include <memory>
#include <vector>

namespace fullmag::fdm::cpu::oersted::v1::detail {

using Complex = std::complex<double>;

class Fft1dPlan {
  public:
    explicit Fft1dPlan(std::size_t size);
    Fft1dPlan(Fft1dPlan &&) noexcept = default;
    Fft1dPlan &operator=(Fft1dPlan &&) noexcept = default;
    Fft1dPlan(const Fft1dPlan &) = delete;
    Fft1dPlan &operator=(const Fft1dPlan &) = delete;

    std::size_t size() const noexcept { return size_; }
    void transform(Complex *data, bool inverse);

  private:
    void forward(Complex *data);
    void radix2_forward(Complex *data) const;
    void bluestein_forward(Complex *data);

    std::size_t size_ = 0;
    bool radix2_ = false;
    std::vector<std::size_t> bit_reverse_;
    std::vector<Complex> roots_;
    std::size_t convolution_size_ = 0;
    std::unique_ptr<Fft1dPlan> convolution_plan_;
    std::vector<Complex> chirp_;
    std::vector<Complex> convolution_kernel_spectrum_;
    std::vector<Complex> scratch_;
};

class Fft3dPlan {
  public:
    Fft3dPlan(std::size_t nx, std::size_t ny, std::size_t nz);
    Fft3dPlan(Fft3dPlan &&) noexcept = default;
    Fft3dPlan &operator=(Fft3dPlan &&) noexcept = default;
    Fft3dPlan(const Fft3dPlan &) = delete;
    Fft3dPlan &operator=(const Fft3dPlan &) = delete;

    void transform(std::vector<Complex> &data, bool inverse);

  private:
    std::size_t index(std::size_t x, std::size_t y, std::size_t z) const noexcept;

    std::size_t nx_ = 0;
    std::size_t ny_ = 0;
    std::size_t nz_ = 0;
    Fft1dPlan x_plan_;
    Fft1dPlan y_plan_;
    Fft1dPlan z_plan_;
    std::vector<Complex> line_;
};

} // namespace fullmag::fdm::cpu::oersted::v1::detail
