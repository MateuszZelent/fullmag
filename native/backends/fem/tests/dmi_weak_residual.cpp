#include "dmi_weak_residual.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace {

constexpr double kPiTest = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPiTest;
constexpr double kVolume = 1.0 / 6.0;
constexpr double kShape = 0.25;
constexpr double kLumpedMass = kVolume * 0.25;
constexpr double kMs = 800000.0;

void check(bool condition, const char *msg)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

double dot3(const double a[3], const double b[3])
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

void normalize(double v[3])
{
    const double n = std::sqrt(dot3(v, v));
    check(n > 0.0, "normalization received zero vector");
    v[0] /= n;
    v[1] /= n;
    v[2] /= n;
}

void compute_grad(
    const double values[4][3],
    const double grad_phi[4][3],
    double out_grad[3][3])
{
    for (int comp = 0; comp < 3; ++comp) {
        for (int dir = 0; dir < 3; ++dir) {
            out_grad[comp][dir] = 0.0;
        }
    }
    for (int node = 0; node < 4; ++node) {
        for (int comp = 0; comp < 3; ++comp) {
            for (int dir = 0; dir < 3; ++dir) {
                out_grad[comp][dir] += values[node][comp] * grad_phi[node][dir];
            }
        }
    }
}

void compute_centroid(const double values[4][3], double out[3])
{
    for (int comp = 0; comp < 3; ++comp) {
        out[comp] = 0.25 * (
            values[0][comp] + values[1][comp] +
            values[2][comp] + values[3][comp]);
    }
}

double projected_action(
    const double h_xyz[12],
    const double perturbation[4][3])
{
    double action = 0.0;
    for (int node = 0; node < 4; ++node) {
        const int base = node * 3;
        action -= kMu0 * kMs * kLumpedMass *
            (h_xyz[base + 0] * perturbation[node][0] +
             h_xyz[base + 1] * perturbation[node][1] +
             h_xyz[base + 2] * perturbation[node][2]);
    }
    return action;
}

double interfacial_weak_action(
    const double magnetization[4][3],
    const double perturbation[4][3],
    const double grad_phi[4][3],
    double d)
{
    double grad_m[3][3];
    double grad_v[3][3];
    double m_q[3];
    double v_q[3];
    compute_grad(magnetization, grad_phi, grad_m);
    compute_grad(perturbation, grad_phi, grad_v);
    compute_centroid(magnetization, m_q);
    compute_centroid(perturbation, v_q);

    const double dw_dm[3] = {
        -d * grad_m[2][0],
        -d * grad_m[2][1],
        d * (grad_m[0][0] + grad_m[1][1]),
    };
    const double value_action = dot3(dw_dm, v_q);
    const double gradient_action =
        d * (m_q[2] * (grad_v[0][0] + grad_v[1][1]) -
             m_q[0] * grad_v[2][0] -
             m_q[1] * grad_v[2][1]);
    return kVolume * (value_action + gradient_action);
}

void add_scaled_field(
    const double field[4][3],
    const double direction[4][3],
    double scale,
    double out[4][3])
{
    for (int node = 0; node < 4; ++node) {
        for (int comp = 0; comp < 3; ++comp) {
            out[node][comp] = field[node][comp] + scale * direction[node][comp];
        }
    }
}

double interfacial_energy(
    const double magnetization[4][3],
    const double grad_phi[4][3],
    double d)
{
    double grad_m[3][3];
    double m_q[3];
    compute_grad(magnetization, grad_phi, grad_m);
    compute_centroid(magnetization, m_q);

    return d * kVolume *
        (m_q[2] * (grad_m[0][0] + grad_m[1][1]) -
         m_q[0] * grad_m[2][0] -
         m_q[1] * grad_m[2][1]);
}

double interfacial_energy_directional_derivative(
    const double magnetization[4][3],
    const double perturbation[4][3],
    const double grad_phi[4][3],
    double d)
{
    constexpr double eps = 1e-4;
    double plus[4][3];
    double minus[4][3];
    add_scaled_field(magnetization, perturbation, eps, plus);
    add_scaled_field(magnetization, perturbation, -eps, minus);

    return (interfacial_energy(plus, grad_phi, d) -
            interfacial_energy(minus, grad_phi, d)) / (2.0 * eps);
}

double bulk_weak_action(
    const double magnetization[4][3],
    const double perturbation[4][3],
    const double grad_phi[4][3],
    double d)
{
    double grad_m[3][3];
    double grad_v[3][3];
    double m_q[3];
    double v_q[3];
    compute_grad(magnetization, grad_phi, grad_m);
    compute_grad(perturbation, grad_phi, grad_v);
    compute_centroid(magnetization, m_q);
    compute_centroid(perturbation, v_q);

    const double curl_m[3] = {
        grad_m[2][1] - grad_m[1][2],
        grad_m[0][2] - grad_m[2][0],
        grad_m[1][0] - grad_m[0][1],
    };
    const double curl_v[3] = {
        grad_v[2][1] - grad_v[1][2],
        grad_v[0][2] - grad_v[2][0],
        grad_v[1][0] - grad_v[0][1],
    };
    return d * kVolume * (dot3(v_q, curl_m) + dot3(m_q, curl_v));
}

double bulk_energy(
    const double magnetization[4][3],
    const double grad_phi[4][3],
    double d)
{
    double grad_m[3][3];
    double m_q[3];
    compute_grad(magnetization, grad_phi, grad_m);
    compute_centroid(magnetization, m_q);

    const double curl_m[3] = {
        grad_m[2][1] - grad_m[1][2],
        grad_m[0][2] - grad_m[2][0],
        grad_m[1][0] - grad_m[0][1],
    };
    return d * kVolume * dot3(m_q, curl_m);
}

double bulk_energy_directional_derivative(
    const double magnetization[4][3],
    const double perturbation[4][3],
    const double grad_phi[4][3],
    double d)
{
    constexpr double eps = 1e-4;
    double plus[4][3];
    double minus[4][3];
    add_scaled_field(magnetization, perturbation, eps, plus);
    add_scaled_field(magnetization, perturbation, -eps, minus);

    return (bulk_energy(plus, grad_phi, d) -
            bulk_energy(minus, grad_phi, d)) / (2.0 * eps);
}

void run_interfacial_fixture()
{
    double magnetization[4][3] = {
        {1.0, 0.1, 0.2},
        {0.7, 0.4, 0.1},
        {0.2, 0.9, 0.3},
        {0.1, 0.3, 0.95},
    };
    for (auto &m : magnetization) {
        normalize(m);
    }
    const double perturbation[4][3] = {
        {0.10, -0.03, 0.02},
        {-0.04, 0.08, 0.03},
        {0.05, 0.02, -0.07},
        {-0.02, -0.06, 0.09},
    };
    const double grad_phi[4][3] = {
        {-1.0, -1.0, -1.0},
        {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0},
    };

    double grad_m[3][3];
    double m_q[3];
    compute_grad(magnetization, grad_phi, grad_m);
    compute_centroid(magnetization, m_q);

    const double d = 3.0e-3;
    const double n_hat[3] = {0.0, 0.0, 1.0};
    double residual[12] = {};
    for (int node = 0; node < 4; ++node) {
        fullmag::fem::DmiElementData data{};
        data.m_q[0] = m_q[0];
        data.m_q[1] = m_q[1];
        data.m_q[2] = m_q[2];
        data.shape = kShape;
        data.weight = kVolume;
        for (int comp = 0; comp < 3; ++comp) {
            for (int dir = 0; dir < 3; ++dir) {
                data.grad_m[comp][dir] = grad_m[comp][dir];
            }
        }
        for (int dir = 0; dir < 3; ++dir) {
            data.grad_shape[dir] = grad_phi[node][dir];
        }
        fullmag::fem::dmi_accumulate_interfacial_residual(
            data,
            n_hat,
            d,
            &residual[node * 3]);
    }

    double lumped[4] = {kLumpedMass, kLumpedMass, kLumpedMass, kLumpedMass};
    double h_xyz[12] = {};
    std::string error;
    check(
        fullmag::fem::dmi_project_lumped_field(
            residual,
            lumped,
            nullptr,
            4,
            kMs,
            h_xyz,
            error),
        "interfacial DMI lumped projection failed");

    const double projected = projected_action(h_xyz, perturbation);
    const double weak = interfacial_weak_action(magnetization, perturbation, grad_phi, d);
    const double denom = std::fmax(std::fmax(std::fabs(projected), std::fabs(weak)), 1e-30);
    const double rel = std::fabs(projected - weak) / denom;
    check(rel <= 1e-12, "interfacial DMI projected field action must match weak residual");
}

void run_interfacial_directional_derivative_fixture()
{
    double magnetization[4][3] = {
        {1.0, 0.1, 0.2},
        {0.7, 0.4, 0.1},
        {0.2, 0.9, 0.3},
        {0.1, 0.3, 0.95},
    };
    for (auto &m : magnetization) {
        normalize(m);
    }
    const double perturbation[4][3] = {
        {0.10, -0.03, 0.02},
        {-0.04, 0.08, 0.03},
        {0.05, 0.02, -0.07},
        {-0.02, -0.06, 0.09},
    };
    const double grad_phi[4][3] = {
        {-1.0, -1.0, -1.0},
        {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0},
    };
    const double d = 3.0e-3;

    double grad_m[3][3];
    double m_q[3];
    compute_grad(magnetization, grad_phi, grad_m);
    compute_centroid(magnetization, m_q);

    const double n_hat[3] = {0.0, 0.0, 1.0};
    double residual[12] = {};
    for (int node = 0; node < 4; ++node) {
        fullmag::fem::DmiElementData data{};
        data.m_q[0] = m_q[0];
        data.m_q[1] = m_q[1];
        data.m_q[2] = m_q[2];
        data.shape = kShape;
        data.weight = kVolume;
        for (int comp = 0; comp < 3; ++comp) {
            for (int dir = 0; dir < 3; ++dir) {
                data.grad_m[comp][dir] = grad_m[comp][dir];
            }
        }
        for (int dir = 0; dir < 3; ++dir) {
            data.grad_shape[dir] = grad_phi[node][dir];
        }
        fullmag::fem::dmi_accumulate_interfacial_residual(
            data,
            n_hat,
            d,
            &residual[node * 3]);
    }

    double lumped[4] = {kLumpedMass, kLumpedMass, kLumpedMass, kLumpedMass};
    double h_xyz[12] = {};
    std::string error;
    check(
        fullmag::fem::dmi_project_lumped_field(
            residual,
            lumped,
            nullptr,
            4,
            kMs,
            h_xyz,
            error),
        "interfacial DMI lumped projection failed for directional derivative");

    const double projected = projected_action(h_xyz, perturbation);
    const double derivative =
        interfacial_energy_directional_derivative(magnetization, perturbation, grad_phi, d);
    const double denom = std::fmax(std::fmax(std::fabs(projected), std::fabs(derivative)), 1e-30);
    const double rel = std::fabs(projected - derivative) / denom;
    check(rel <= 1e-9, "interfacial DMI field action must match dE/deps");
}

void run_bulk_fixture()
{
    double magnetization[4][3] = {
        {1.0, 0.2, -0.1},
        {0.6, 0.3, 0.4},
        {-0.2, 0.95, 0.2},
        {0.3, -0.1, 0.9},
    };
    for (auto &m : magnetization) {
        normalize(m);
    }
    const double perturbation[4][3] = {
        {0.03, 0.04, -0.02},
        {-0.08, 0.01, 0.05},
        {0.06, -0.07, 0.02},
        {-0.01, 0.05, 0.08},
    };
    const double grad_phi[4][3] = {
        {-1.0, -1.0, -1.0},
        {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0},
    };

    double grad_m[3][3];
    double m_q[3];
    compute_grad(magnetization, grad_phi, grad_m);
    compute_centroid(magnetization, m_q);

    const double d = 2.0e-3;
    double residual[12] = {};
    for (int node = 0; node < 4; ++node) {
        fullmag::fem::DmiElementData data{};
        data.m_q[0] = m_q[0];
        data.m_q[1] = m_q[1];
        data.m_q[2] = m_q[2];
        data.shape = kShape;
        data.weight = kVolume;
        for (int comp = 0; comp < 3; ++comp) {
            for (int dir = 0; dir < 3; ++dir) {
                data.grad_m[comp][dir] = grad_m[comp][dir];
            }
        }
        for (int dir = 0; dir < 3; ++dir) {
            data.grad_shape[dir] = grad_phi[node][dir];
        }
        fullmag::fem::dmi_accumulate_bulk_residual(data, d, &residual[node * 3]);
    }

    double lumped[4] = {kLumpedMass, kLumpedMass, kLumpedMass, kLumpedMass};
    double h_xyz[12] = {};
    std::string error;
    check(
        fullmag::fem::dmi_project_lumped_field(
            residual,
            lumped,
            nullptr,
            4,
            kMs,
            h_xyz,
            error),
        "bulk DMI lumped projection failed");

    const double projected = projected_action(h_xyz, perturbation);
    const double weak = bulk_weak_action(magnetization, perturbation, grad_phi, d);
    const double denom = std::fmax(std::fmax(std::fabs(projected), std::fabs(weak)), 1e-30);
    const double rel = std::fabs(projected - weak) / denom;
    check(rel <= 1e-12, "bulk DMI projected field action must match weak residual");
}

void run_bulk_directional_derivative_fixture()
{
    double magnetization[4][3] = {
        {1.0, 0.2, -0.1},
        {0.6, 0.3, 0.4},
        {-0.2, 0.95, 0.2},
        {0.3, -0.1, 0.9},
    };
    for (auto &m : magnetization) {
        normalize(m);
    }
    const double perturbation[4][3] = {
        {0.03, 0.04, -0.02},
        {-0.08, 0.01, 0.05},
        {0.06, -0.07, 0.02},
        {-0.01, 0.05, 0.08},
    };
    const double grad_phi[4][3] = {
        {-1.0, -1.0, -1.0},
        {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0},
    };
    const double d = 2.0e-3;

    double grad_m[3][3];
    double m_q[3];
    compute_grad(magnetization, grad_phi, grad_m);
    compute_centroid(magnetization, m_q);

    double residual[12] = {};
    for (int node = 0; node < 4; ++node) {
        fullmag::fem::DmiElementData data{};
        data.m_q[0] = m_q[0];
        data.m_q[1] = m_q[1];
        data.m_q[2] = m_q[2];
        data.shape = kShape;
        data.weight = kVolume;
        for (int comp = 0; comp < 3; ++comp) {
            for (int dir = 0; dir < 3; ++dir) {
                data.grad_m[comp][dir] = grad_m[comp][dir];
            }
        }
        for (int dir = 0; dir < 3; ++dir) {
            data.grad_shape[dir] = grad_phi[node][dir];
        }
        fullmag::fem::dmi_accumulate_bulk_residual(data, d, &residual[node * 3]);
    }

    double lumped[4] = {kLumpedMass, kLumpedMass, kLumpedMass, kLumpedMass};
    double h_xyz[12] = {};
    std::string error;
    check(
        fullmag::fem::dmi_project_lumped_field(
            residual,
            lumped,
            nullptr,
            4,
            kMs,
            h_xyz,
            error),
        "bulk DMI lumped projection failed for directional derivative");

    const double projected = projected_action(h_xyz, perturbation);
    const double derivative =
        bulk_energy_directional_derivative(magnetization, perturbation, grad_phi, d);
    const double denom = std::fmax(std::fmax(std::fabs(projected), std::fabs(derivative)), 1e-30);
    const double rel = std::fabs(projected - derivative) / denom;
    check(rel <= 1e-9, "bulk DMI field action must match dE/deps");
}

} // namespace

int main()
{
    run_interfacial_fixture();
    run_interfacial_directional_derivative_fixture();
    run_bulk_fixture();
    run_bulk_directional_derivative_fixture();
    std::printf("FEM dmi_weak_residual smoke PASS\n");
    return 0;
}
