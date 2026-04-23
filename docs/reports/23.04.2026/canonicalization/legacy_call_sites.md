# Legacy/Transitional Call Sites (2026-04-23 snapshot)

## Legacy viewport paths

- `apps/web/components/runs/control-room/ViewportPanels.tsx` (`VectorFieldView3D` call path)
- `apps/web/components/preview/VectorFieldView3D.tsx` (legacy renderer component)

## Capability synthesis from discretization

- `apps/web/components/runs/control-room/ControlRoomContext.tsx`
- `apps/web/components/runs/control-room/ViewportBar.tsx`
- `apps/web/features/session-runtime/hooks/useDataPlaneBridge.ts`

## Direct fetch usage in React/app code

- `apps/web/src/api/client/LiveApiClient.ts` (allowed canonical fetch boundary)

## Legacy transport signals

- legacy bootstrap/poll/state frontend usage: no active findings in current scan (`2026-04-23`)
