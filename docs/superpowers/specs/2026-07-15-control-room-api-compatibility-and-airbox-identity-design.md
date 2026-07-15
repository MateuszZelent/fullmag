# Control Room API Compatibility and Airbox Identity Design

## Goal

Prevent a current Control Room frontend from attaching to an incompatible API process, keep Airbox represented by one semantic target, and avoid request storms when optional runtime resources are not available yet.

## Design

The launcher will distinguish basic process health from Control Room compatibility. Reuse requires the internal snapshot bridge and the v2 OpenAPI document with contract version `1.0.0` and the mandatory `model/scene` route. A process that only answers `/healthz` is not reusable.

Airbox classification will have one shared frontend predicate. `role=air` and `role=airbox` are authoritative; `__air__` and `__airbox__` remain accepted legacy aliases. Data-plane carrier `part:__air__` remains intact and maps to the canonical `airbox` visualization target.

GET transport retries remain bounded to three total attempts for network failures, 408, 429, and 502-504. A 404 is never retried. Optional mesh memberships and object metrics are enabled only when their owning runtime state indicates that the resource can exist; a missing optional resource resolves to unavailable rather than triggering repeated loads.

## Verification

Focused Rust launcher tests, Control Room API/resource/catalog tests, complete Control Room typecheck/lint/test gates, resource-first gates, and an active browser viewport smoke.
