# Plans Directory

This directory keeps **implementation plans** separate from **long-lived specs**.

## Directory policy

- `docs/specs/`
  - canonical, long-lived architecture and policy documents,
  - stable references that remain useful even after implementation lands.

- `docs/plans/active/`
  - implementation plans that are still driving current or near-term work,
  - audit-and-roadmap documents describing verified current state and next phases.

- `docs/plans/completed/`
  - archived plans whose deliverables have been implemented and whose remaining work is only
    maintenance or future extensions.

## Move rules

Move a plan from `active/` to `completed/` only when:

1. the main deliverables are implemented in code,
2. the public status described by the plan is honest,
3. the remaining gaps are no longer the plan's core purpose,
4. the plan is no longer needed as an active execution document.

Do **not** move:

- policy docs such as geometry/output/boundary-condition specs,
- core architecture blueprints,
- physics notes in `docs/physics/`.

## Physics documentation rule

Any plan that changes physics or numerics must be paired with a publication-style note in
`docs/physics/`.

Those notes should be written in a style closer to scientific software papers than to TODO lists.
The local reference examples for tone and structure are:

- `scientific_papers/s41524-025-01893-y.pdf`
- `scientific_papers/5_0024382 -- 4b879d2281db22323be109c1ac0ba334 -- Anna’s Archive.pdf`

The expected shape is:

1. problem statement and scope,
2. governing equations and SI units,
3. numerical method / discretization,
4. software-design implications,
5. verification and validation,
6. limitations and deferred work.
