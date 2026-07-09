Status: complete

Commit(s): current Task 1 HEAD commit (`Fix Poisson-airbox modal doc contracts`)

One-line test result: `python3 -m pytest scripts/test_frequency_domain_math_contract_docs.py` passed (`6 passed`); `git diff --check` passed.

Concerns: Existing uncommitted foundational docs remain untouched (`docs/physics/0830-fem-poisson-airbox-modal-eigen.md`, `docs/superpowers/specs/2026-07-09-real-fem-poisson-airbox-modal-design.md`, `docs/superpowers/plans/2026-07-09-real-fem-poisson-airbox-modal.md`). Task 1 intentionally changes only the requested documentation and Python doc-contract tests.

Report path: `/home/kkingstoun/git/fullmag/fullmag/.superpowers/sdd/task-1-report.md`

---

Reviewer follow-up: 2026-07-09 `0828` phasor convention regression

Status: complete

Commands and output:

1. RED assertion added to `scripts/test_frequency_domain_math_contract_docs.py`

2. RED run:

```text
$ python3 -m pytest scripts/test_frequency_domain_math_contract_docs.py -k floquet_tangent_frame_transport_and_identity_rejection_are_documented
============================= test session starts ==============================
collected 6 items / 5 deselected / 1 selected

scripts/test_frequency_domain_math_contract_docs.py F

E       AssertionError: assert 'exp(+i omega t)' in '# FEM frequency-domain Floquet demag ...'

======================= 1 failed, 5 deselected in 0.08s ========================
```

3. GREEN doc fix applied to `docs/physics/0828-fem-frequency-domain-floquet-demag.md`:

```text
m(r,t) = m0(r) + Re[delta_m(r) exp(+i omega t)]
```

4. GREEN rerun:

```text
$ python3 -m pytest scripts/test_frequency_domain_math_contract_docs.py -k floquet_tangent_frame_transport_and_identity_rejection_are_documented
============================= test session starts ==============================
collected 6 items / 5 deselected / 1 selected

scripts/test_frequency_domain_math_contract_docs.py .

======================= 1 passed, 5 deselected in 0.03s ========================
```
