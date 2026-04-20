---
name: resource-first-api-check
description: "Use when changing the Fullmag live API, OpenAPI contract, browser data flow, binary codecs, or FDM/FEM control-room unification."
---

# Resource-first API check

## When to trigger

- adding or changing `/v1/live/current/*` endpoints,
- changing status/domain/field/scalar/display/commands/artifact/session resource shapes,
- changing OpenAPI/utoipa schemas or shared frontend API types,
- changing frontend resource hooks, caches, codecs, or request/response middleware,
- changing the capability/adapters boundary that keeps the control room unified across FDM and FEM.

## Checklist

1. Is the change resource-first and revision-driven, not blob-first?
2. Does `status` remain thin and free of heavy arrays?
3. Does the control plane stay JSON while heavy numerical data stays binary by default?
4. Are Rust schemas, OpenAPI, and frontend shared types updated together?
5. Do React components still go through one typed API client instead of direct `fetch()` calls?
6. Do capability maps and domain adapters keep FDM/FEM differences out of the top-level UI tree?
7. Are `x-request-id`, `x-api-contract-version`, and revision/generation headers preserved where relevant?
8. Does the change avoid creating a long-lived old/new API dual stack?
9. Are contract, codec, cache, adapter, and integration tests updated?

## Required outputs

- Update `docs/specs/resource-first-control-room-api-v1.md`
- Update `docs/adr/0011-resource-first-api.md` if the architecture decision changed
- Update `.agents/` and `.github/` guidance when the contract materially changed
- Make legacy bootstrap/poll/preview dependencies explicit if they still exist temporarily

## Anti-regression rules

- Do not reintroduce monolithic bootstrap state as the canonical browser model.
- Do not put heavy field or topology payloads back into `status`.
- Do not fork the viewport/product tree into FDM and FEM applications.
- Do not bypass shared API-client, codec, and resource-hook layers.
