---
title: Airbox Build API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-airbox-build)=
# Airbox Build API

`study.build_domain_mesh()` explicitly materializes the current geometry and mesh policy before the
stage graph executes.

A geometry, object-mesh, region-mesh, or universe-policy change invalidates that realization. Build
success must be followed by report/quality inspection; the method does not return a scientific
qualification certificate by construction alone.
