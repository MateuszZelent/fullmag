# Legacy/Transitional Call Sites (2026-04-25 snapshot)

## Legacy viewport paths

- `apps/web/components/runs/control-room/UnifiedViewport3DVectorSurface.tsx` is the only transitional renderer adapter.
- `apps/web/components/preview/VectorFieldView3D.tsx` remains as the renderer module path, but no active code references the legacy component symbol.

## Capability synthesis from discretization

- Dedicated `synthesizeCapabilitiesFromDiscretization` fallback has been removed.
- Remaining `resolveFemDiscretization` call sites must pass canonical `status.capabilities` when available and may use the boolean fallback only for transitional null-capability paths.

## Direct fetch usage in React/app code

- `apps/web/src/api/client/LiveApiClient.ts` (allowed canonical fetch boundary)

## Legacy transport signals

- legacy bootstrap/poll/state frontend usage: no active findings in current scan (`2026-04-25`)
