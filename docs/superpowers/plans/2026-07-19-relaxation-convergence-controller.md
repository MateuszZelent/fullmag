# Relaxation Convergence Controller Implementation Plan

1. Add RED unit tests proving that energy-only completion is impossible, torque
   needs three fresh accepted confirmations, failed torque resets the sequence,
   plateau requests tightening, excessive energy increases reject, and a floor
   plateau becomes numerical stagnation.
2. Extend Python and ProblemIR with the controller policy, compatibility
   defaults, finite validation, canonical export, and planner propagation.
3. Implement one backend-neutral controller state machine and completion
   mapping; preserve historical `energy` decode compatibility.
4. Connect FEM CPU and GPU LLG trial transactions to fresh energy evaluation,
   rollback, controller tightening, accepted-state telemetry, and provenance.
   Keep direct minimizer Armijo ownership unchanged.
5. Add equivalent FDM wiring or explicitly fail capability validation until a
   lane implements the same accepted-state contract; no hidden semantic drift.
6. Run the managed FEM CPU/GPU calibration matrix, store CSV/PNG evidence, set
   the default torque tolerance from the measured numerical floors, then update
   SP4 preparation scripts without weakening the NIST acceptance threshold.
7. Verify focused Rust/Python/source contracts, container-backed native FEM
   runtime gates, CPU/GPU consistency, and full NIST SP4 qualification.

Completion requires all seven steps. A passing unit test or executable runtime
alone is not production qualification.
