---
title: Frequency-driven solver - full read inventory and resolution
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Full read inventory and resolution

The following uploaded files were read from start to end. This inventory records line counts and hashes so Codex can see which sources this v5 package consolidates.

## Source inventory

```json
[
  {
    "file": "fd_solver_plan_00_index(2).md",
    "lines": 213,
    "chars": 7065,
    "sha256": "548506fb4218ec53751198ef2205a17c0d215bb53833fe25923994c6637d2e32",
    "heading_count": 14
  },
  {
    "file": "fd_solver_plan_01_comsol_physics_contract(2).md",
    "lines": 421,
    "chars": 9205,
    "sha256": "72cfaf53b12d1f643dd9a5f60bab0f073ad409695fea51273dd4b18c0b7b4cdb",
    "heading_count": 24
  },
  {
    "file": "fd_solver_plan_02_algebra_representations(1).md",
    "lines": 300,
    "chars": 5686,
    "sha256": "86f0a2c09b0f06f414b787e1a1d2b0e8568a256f79c87b629549e3b39eb68915",
    "heading_count": 17
  },
  {
    "file": "fd_solver_plan_03_solver_tree_architecture(2).md",
    "lines": 253,
    "chars": 6739,
    "sha256": "88564843306337049828d791437b5147f45ea96a04503409b5114a27ceaa8787",
    "heading_count": 10
  },
  {
    "file": "fd_solver_plan_04_implementation_roadmap(1).md",
    "lines": 357,
    "chars": 7556,
    "sha256": "e980fc077831d917b9147f4bced4333b0b32db60fb38dc9bb2a644d3a7d06afc",
    "heading_count": 12
  },
  {
    "file": "fd_solver_plan_05_api_code_skeletons(2).md",
    "lines": 444,
    "chars": 11456,
    "sha256": "d3104a68d5bda059d0b7e9bbc163e6d04268201a87cb129ce6b36359b572429f",
    "heading_count": 13
  },
  {
    "file": "fd_solver_plan_06_backend_algorithms(1).md",
    "lines": 398,
    "chars": 6170,
    "sha256": "18d5387a5e03860e292fa6503a897d6dfafd7ffb3f2f6d33dfd9ee8ff08ec840",
    "heading_count": 47
  },
  {
    "file": "fd_solver_plan_07_validation_benchmarks(2).md",
    "lines": 349,
    "chars": 6820,
    "sha256": "68571b97eefa24e580f5894fa3e92e34c88515169c323a4ca175f44d0771c8df",
    "heading_count": 32
  },
  {
    "file": "fd_solver_plan_08_patch_queue(1).md",
    "lines": 609,
    "chars": 24563,
    "sha256": "715bde20f99bb553539ceaca3880c67c71980efc97fafe6983b2a0b569a1979b",
    "heading_count": 13
  },
  {
    "file": "fd_solver_plan_09_sources_and_traceability(1).md",
    "lines": 238,
    "chars": 5652,
    "sha256": "cb1235ab15b0f9d2bca44e41f239b585801c1ec710d7bfc39d896e8f3996ef2c",
    "heading_count": 17
  },
  {
    "file": "fd_solver_plan_10_relaxed_texture_handoff(1).md",
    "lines": 738,
    "chars": 21540,
    "sha256": "ba9470680758fbc50238c28fb6ad5313a1deab962b011f041c467091a71d62df",
    "heading_count": 46
  },
  {
    "file": "fd_solver_plan_11_decision_closures_adr(1).md",
    "lines": 336,
    "chars": 7586,
    "sha256": "109e4913a570c2dcfac9b9303679bfd259b27116462cd9e509ad948cbdf55741",
    "heading_count": 14
  },
  {
    "file": "fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md",
    "lines": 3207,
    "chars": 67762,
    "sha256": "730569745a9b11d0730543a6857a23f5953e61efc10b02922c4dbce39767783c",
    "heading_count": 196
  },
  {
    "file": "fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3(2).md",
    "lines": 4321,
    "chars": 96910,
    "sha256": "ac1446f3bae78bb4f7646d68b777ec40a5e0215c2feaa61444b02afd5841f25f",
    "heading_count": 260
  },
  {
    "file": "MicromagneticsModuleUsersGuideV2.13(1).pdf",
    "pages": 71,
    "bytes": 14582495,
    "sha256": "6c212ed2ee9580f2917118c58ed1caafec18488076a3e7bcb3eb15a64b5e49e1",
    "extracted_text_lines": 1944,
    "extracted_text_chars": 97886
  }
]
```

## Resolution of conflicting generations

| Conflict | Resolution in v5 |
|---|---|
| `fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md` says v3 but contains a `masterplan v2` heading | v5 uses one title and one version only. |
| relaxed texture handoff was separate v3 addendum | v5 promotes it to core P0 document: `03_relaxed_texture_linearization.md`. |
| ADR decisions were separate addendum | v5 promotes them to canonical `12_adr_decisions.md`. |
| patch queue contains newer implementation evidence than old main plan | v5 separates design goal from implementation status in `10_patch_queue_current_status.md`. |
| old documents call sparse/direct and field-split future work | v5 records that MVP/prototype slices are reported as implemented in the patch queue, but not final production backends. |
| old docs emit `micromagnetics_frequency_domain_v2` in JSON examples | v5 emits `micromagnetics_frequency_domain_v5`. |
| old docs have ambiguous drive sign text | v5 uses `b = -gamma T^T(m0 x delta_h)` with mandatory sign gate. |
| old docs alternate `exp_i_omega_t` and `exp_plus_i_omega_t` | v5 canonical emission token is `exp_plus_i_omega_t`; aliases may be accepted on input. |

## What is design and what is implementation

v5 distinguishes:

```text
contract/design: what final solver must support
current implemented gate: what patch queue says is already tested
runtime production backend: what can be selected safely by planner today
```

In particular:

```text
GpuDeviceKrylovBackend: design exists; API/probe exists; production runtime loop does not.
FullCoupledFieldSplitBackend: prototype exists; production large FEM field-split still needs integration.
CpuSparseDirectBackend: MVP exists; production scaling and reuse policies still need work.
ModalReducedBackend: helper/gates exist; full production sweep engine still needs integration.
SchurReducedBackend: certificate gates exist; production fast path still requires actual certificate and quality data per problem.
```
