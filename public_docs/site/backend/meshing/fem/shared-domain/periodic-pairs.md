---
title: Periodic Pairing
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-shared-domain-periodic-pairs)=
# Periodic pairing

Periodic and Floquet operators require an algebraic map between compatible boundary faces. A visual
match is insufficient.

The pairing certificate contains:

- source and destination boundary attributes;
- translation vector and orientation convention;
- one-to-one node or degree-of-freedom correspondence;
- tolerance and unmatched-entity counters;
- representative classes for reduced periodic systems;
- closed-loop consistency;
- Bloch phase convention for nonzero wave vector;
- digest bound to the exact extracted mesh.

Changing mesh topology, geometry order, boundary marker, or periodic translation invalidates the
pairing. Static periodicity also does not automatically qualify a dynamic-demagnetization or Floquet
operator; that capability is documented by the consuming solver.
