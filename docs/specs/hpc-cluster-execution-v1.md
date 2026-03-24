# HPC Cluster Execution v1

- Status: draft stable cluster/runtime contract
- Last updated: 2026-03-24
- Parent architecture: `docs/specs/fullmag-application-architecture-v2.md`

## 1. Purpose

This document defines how Fullmag is expected to operate on HPC systems.

It exists because cluster execution is not a minor deployment detail.
It affects:

- launcher behavior,
- session semantics,
- runtime packaging,
- artifact movement,
- provenance,
- browser/control-room expectations,
- backend runtime orchestration.

Fullmag must support HPC execution without creating a second product model.

The most important architectural assumption is:

- **Fullmag is not required to be the cluster orchestrator**
- Fullmag may be launched by an external dispatch system such as **Microlab**
- one allocated node may receive one task that simply runs:
  - `fullmag task1.py`

---

## 2. Core rule

HPC execution is **the same application model** as local execution.

The user still thinks in terms of:

- one Python script,
- one `fullmag` launcher,
- one session,
- one run,
- one control room,
- one artifact/provenance model.

What changes is the execution target and dispatch path.

The canonical HPC path is now **external-dispatch-first**:

- an external scheduler / workflow system places the job,
- Fullmag runs as the node-local simulation executable,
- Fullmag still owns the problem loading, execution, artifacts, and provenance for that task.

---

## 3. Canonical execution surfaces

An HPC execution typically spans four environments:

1. **user workstation**
   - where the user writes the Python script
   - may also host the browser control room
2. **dispatch / control system**
   - e.g. Microlab or a site scheduler wrapper
   - decides which task goes to which node
   - may run outside Fullmag entirely
3. **scheduler / site allocation layer**
   - Slurm first when scheduler details matter
   - PBS / LSF / Flux / site-specific adapters later
4. **compute nodes**
   - where the heavy backend runtime actually executes

This separation must be reflected in runtime design and provenance.

---

## 4. Canonical user experience

The intended HPC UX is now:

```bash
fullmag task1.py
```

or more realistically on a compute node:

```bash
fullmag task1.py --headless
```

where `task1.py` is dispatched to one allocated node by an external system such as Microlab.

Expected behavior on the node:

1. the launcher resolves the Python-authored `ProblemIR`
2. the launcher validates and plans locally on that node/runtime
3. the launcher resolves the appropriate local runtime pack
4. the launcher executes the task
5. the launcher writes canonical artifacts and provenance
6. the task exits cleanly for the surrounding HPC system to collect results

Optional control-plane features may later add richer remote monitoring, but they are not required
for the basic HPC contract.

The user should not need to manually manage solver ABI details or backend library details.
The external dispatcher may still manage placement, queueing, stage-in, and stage-out.

---

## 5. Scheduler / dispatch model

## 5.1 External-dispatch-first rule

The canonical HPC assumption is:

- job dispatch belongs to the external system,
- Fullmag is the simulation executable inside the allocated task.

This means Fullmag does **not** require:

- a built-in orchestrator,
- a mandatory scheduler adapter,
- a mandatory `submit` command,
- ownership of cluster queue lifecycle.

These may be added later as convenience features, but they are not required for architectural
correctness.

## 5.2 Initial scheduler target when scheduler metadata matters

The first-class scheduler target should be:

- **Slurm**

Later adapters may include:

- PBS Pro / Torque
- LSF
- Flux
- site-specific wrapper systems

When scheduler-aware metadata is available, it must stay behind the control plane/runtime layer.

## 5.3 Scheduler-owned concepts

Remote execution must track at least:

- scheduler name
- cluster target
- queue / partition
- account / project when relevant
- job id
- array task id when relevant
- node allocation summary
- walltime request
- GPU allocation

These must become provenance fields, not hidden log trivia.

---

## 6. Session model on HPC

Local and remote execution must share the same session-first model.

However, HPC may require more detailed lifecycle states.

### 6.1 Additional canonical remote states

Remote-capable session states may extend the existing model with:

- `staging_input`
- `submitting`
- `queued`
- `allocating`
- `staging_runtime`
- `running_remote`
- `staging_output`
- `completed`
- `failed`
- `cancelled`

Not every deployment must expose all of these.

In the external-dispatch-first model, a node-local Fullmag task may begin directly at:

- `starting`
- `loading_script`
- `validating`
- `planning`
- `running`

without Fullmag ever owning `queued` or `submitting`.

### 6.2 Remote identity fields

Remote sessions should additionally track:

- `target_id`
- `scheduler`
- `scheduler_job_id`
- `remote_workdir`
- `runtime_image_id`
- `staging_location`

---

## 7. Artifact and data movement model

HPC execution must not assume that compute nodes can serve the browser directly.

Therefore the canonical model is:

- control plane and browser talk to session/run APIs
- heavy solver writes artifacts to a cluster-visible working area
- outputs are staged into a canonical artifact store/index
- the browser reads the control-plane artifact view, not raw cluster paths

### 7.1 Stage-in

Stage-in may include:

- normalized `ProblemIR`
- script source snapshot
- mesh/geometry assets
- runtime manifest
- dispatcher wrapper script
- chosen runtime image reference

### 7.2 Stage-out

Stage-out must include:

- canonical metadata
- scalar traces
- field snapshots
- logs
- provenance bundle
- failure diagnostics when the run aborts

---

## 8. Runtime packaging on HPC

HPC is the strongest justification for managed runtimes.

The canonical runtime packaging split on clusters is:

- launcher/control plane outside or above the compute runtime
- backend runtime inside a managed pack suitable for the site

### 8.1 Preferred runtime forms

For HPC, preferred managed runtime forms are:

- **Apptainer / Singularity images** for sites that require HPC-native container flows
- OCI/container images where the site supports them
- site-managed runtime modules only as a compatibility path, not the primary product contract

### 8.2 Runtime family mapping

- `fdm-cuda`
  - OCI image or Apptainer image with CUDA user-space stack
- `fem-gpu`
  - OCI image or Apptainer image with:
    - CUDA
    - MFEM
    - libCEED
    - hypre
    - required native Fullmag backend binaries/libraries

### 8.3 Cluster portability rule

The launcher may translate one canonical runtime family into different site realizations:

- local OCI image
- Apptainer image on cluster A
- site-installed module pack on cluster B

But the session and provenance model must still describe the resolved runtime honestly.

---

## 9. Browser / control-room model on HPC

The browser should usually run on:

- the user workstation, or
- the external control system side when such a system exists,

not on the compute node.

This implies:

- compute nodes do not own browser lifecycle,
- control room state is fed through control-plane APIs,
- live updates may be polling- or event-driven depending on site constraints,
- field payload streaming may be less direct than on localhost.

### 9.1 Live update expectations

On HPC, “live” may mean:

- scheduler-state updates while queued,
- periodic scalar/log refresh while running,
- field snapshot availability notices when outputs are written,
- resumable monitoring after reconnect.

The architecture must not assume localhost-grade, always-open streaming from compute nodes.

---

## 10. Provenance requirements specific to HPC

Every HPC run must record, at minimum:

- target cluster id
- scheduler type
- scheduler job id
- queue / partition
- requested vs actual GPU allocation
- node type / accelerator type if available
- runtime image or module identity
- container digest or image tag
- CUDA driver/runtime versions if applicable
- MFEM/libCEED/hypre runtime identifiers if applicable
- stage-in and stage-out paths or object-store ids

This information must be queryable through run metadata.

---

## 11. Failure and cancellation model

Cluster execution introduces more failure modes than local runs.

The runtime model must distinguish, at minimum:

- dispatch failure
- scheduler rejection
- queue timeout
- runtime image resolution failure
- node/preemption failure
- backend runtime crash
- stage-out failure

Cancellation must support:

- user-requested cancel before scheduling
- user-requested cancel while queued
- scheduler job cancellation while running

The session contract must map these cases onto honest terminal states and diagnostics.

---

## 12. Architecture consequences

HPC execution implies the following architecture rules:

1. Fullmag must run correctly as a node-local task launched by an external system
2. runtime management is not optional product polish; it is core backend behavior
3. heavy backends must be representable as managed runtimes
4. session/run APIs must tolerate remote and delayed execution
5. provenance must include scheduler/runtime resolution details when available
6. browser/control-room design must not assume direct compute-node connectivity

---

## 13. Relationship to local mode

Local mode and HPC mode must share:

- Python authoring
- `ProblemIR`
- capability checks
- planner semantics
- session/run model
- artifact naming
- quantity model
- provenance surface

They may differ in:

- execution latency
- scheduler lifecycle
- runtime pack resolution
- transport for live updates
- stage-in/stage-out mechanics

---

## 14. Immediate design implications

The following should now be considered required future work, not optional ideas:

- node-local headless robustness for external-dispatch use
- runtime registry with cluster-aware resolution
- optional external-system metadata ingestion
- optional scheduler adapter layer, only as a convenience feature
- remote artifact staging model
- remote-aware session lifecycle
- control-room support for queued / remote runs

---

## 15. Acceptance criteria for this contract

This contract is satisfied when:

- Fullmag docs describe HPC as part of the primary application model
- remote runs reuse the same session/run contract as local runs
- Fullmag can be launched directly as `fullmag task.py` inside an externally scheduled node task
- heavy runtimes are managed and reproducible
- provenance records enough information to explain remote execution unambiguously
