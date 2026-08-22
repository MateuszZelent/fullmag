---
title: Periodic and Floquet Airbox
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-airbox-periodic-airbox)=
# Periodic and Floquet Airbox

Periodic/Floquet airbox construction requires compatible source/destination faces, one-to-one
topology, translations, orientation, and phase-loop closure.

`periodic_airbox_k0` and nonzero-wave-vector Floquet response are different operators. A periodic
static mesh does not automatically provide a qualified dynamic-demagnetization operator at nonzero
wave vector.

The mesh digest includes periodic pair maps and translations; the response/eigen operator adds the
phase convention.
