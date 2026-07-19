# Relaxation Convergence Controller Design

## Decision

Fullmag keeps `max |m x H_eff|` in A/m as the mandatory equilibrium criterion.
Energy is used to protect and steer the numerical solve, not as an independent
proof of equilibrium.

## Public contract

`RelaxStop` and `RelaxStopIR` continue to carry physical stopping intent:

- `torque_tolerance_apm`;
- `energy_tolerance_j` as an optional plateau/controller threshold;
- existing accepted-step and relaxation-time budgets.

The consecutive-sample count, accepted-energy-increase budget, tightening
factor, and controller floor form a versioned backend-neutral runtime policy.
They are exposed in resolved provenance and diagnostics, not as ordinary
physical `RelaxStop` fields. This prevents backend stepper mechanics from
becoming common physics semantics.

Resolved controller floors remain part of the LLG time-step policy: adaptive
LLG tightens `max_error` toward its configured floor; fixed-step LLG tightens
`dt` toward `dt_min`. Direct minimizers keep their existing Armijo rejection
and use the shared consecutive-torque completion rule.

## State machine

After every trial, the backend computes fresh energy and torque from the trial
state. A nonfinite value fails the stage. An excessive energy increase rejects
and rolls back the trial, reduces the controller, and does not advance accepted
steps, plateau samples, or torque confirmations.

An accepted state advances the plateau window and torque confirmation count.
Three consecutive passing torque states, plus the optional energy plateau when
configured, converge with reason `torque`. A failing torque resets the count.
Plateau above torque tightens the controller. Plateau above torque at the
controller floor ends with `numerical_stagnation` and `converged=false`.

## Compatibility

Historical `reason=energy` artifacts remain readable. New runs never emit that
reason. Requested physical criteria and the versioned resolved controller
policy are recorded in provenance.

## Calibration and qualification

The torque default is selected only after a deterministic matrix covering FEM
CPU/GPU, exchange-only and each production demag realization, at least two mesh
resolutions, and fixed/adaptive RK. The selected value must be above the
repeatable numerical floor of every qualified lane and below the SP4
preparation requirement. Results, rejected trials, floor hits, and final torque
are stored in CSV with convergence plots in PNG. Executability is not physical
qualification; NIST SP4 remains a separate trajectory and convergence gate.
