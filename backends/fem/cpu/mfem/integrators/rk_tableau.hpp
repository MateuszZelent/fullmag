#pragma once

namespace fullmag::fem {

// Max stages: 7 (DP54 uses 7 for FSAL).
static constexpr int MAX_RK_STAGES = 7;

/*
 * Explicit Runge-Kutta tableau contract.
 *
 * Tableaus are dimensionless coefficients for explicit RK sampling of the FEM
 * LLG RHS. Stage increments use dt in seconds and RHS values in 1/s, so the
 * resulting magnetization updates remain dimensionless. Embedded pairs populate
 * both b_hi and b_lo; fixed-order methods leave order_est at zero.
 *
 * It does not allocate workspace, evaluate stages, perform steps, or run
 * adaptive control.
 */
struct ExplicitTableau {
    int stages;                                     // s
    double c[MAX_RK_STAGES];                        // nodes
    double a[MAX_RK_STAGES][MAX_RK_STAGES];         // lower-triangular coupling
    double b_hi[MAX_RK_STAGES];                     // high-order weights
    double b_lo[MAX_RK_STAGES];                     // low-order weights (embedded error)
    int order_hi;                                  // order of b_hi
    int order_est;                                 // embedded error-estimator order q used by the adaptive controller (0 = none)
    bool fsal;                                     // first-same-as-last?
};

} // namespace fullmag::fem
