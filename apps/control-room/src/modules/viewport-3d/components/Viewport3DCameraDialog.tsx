"use client";

import { X } from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import {
  buildViewport3DCameraPoseFromOrientation,
  resolveViewport3DCameraOrientation,
  toCameraTuple,
} from "../viewport3dCameraModel";
import type {
  Viewport3DCameraProjection,
  Viewport3DCameraState,
} from "../viewport3dStore";
import { VIEWPORT_3D_WORLD_UP } from "../layers/CameraControls";

type CameraPatch = NonNullable<VisualizationStatePatch["camera"]>;
type CameraResource = VisualizationStateResource["camera"];
type CameraProjection = CameraResource["projection"];
type CameraTuple = [number, number, number];

interface CameraDialogPosition {
  x: number;
  y: number;
}

interface CameraDraft {
  distance: string;
  fovDegrees: string;
  orthographicScale: string;
  pitchDegrees: string;
  position: [string, string, string];
  projection: CameraProjection;
  rollDegrees: string;
  target: [string, string, string];
  yawDegrees: string;
}

interface CameraDialogSnapshot {
  fovDegrees: number;
  orthographicScale: number | null;
  position: CameraTuple;
  projection: CameraProjection;
  target: CameraTuple;
  up: CameraTuple;
}

const DEFAULT_FOV_DEGREES = 42;

export function Viewport3DCameraDialog({
  cameraResource,
  cameraOrthographicScale,
  cameraProjection,
  cameraState,
  onCameraPatch,
  onOpenChange,
  open,
}: {
  cameraResource: CameraResource | null;
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  onCameraPatch: (patch: CameraPatch) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [dialogPosition, setDialogPosition] = useState<CameraDialogPosition>(
    () => initialDialogPosition(),
  );
  const dragRef = useRef<{
    origin: CameraDialogPosition;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const snapshot = useMemo(
    () =>
      buildCameraDialogSnapshot(
        cameraState,
        cameraProjection,
        cameraResource,
        cameraOrthographicScale,
      ),
    [cameraOrthographicScale, cameraProjection, cameraResource, cameraState],
  );
  const liveOrientation = useMemo(
    () =>
      resolveViewport3DCameraOrientation({
        position: snapshot.position,
        target: snapshot.target,
        up: snapshot.up,
      }),
    [snapshot],
  );
  const baseDraft = useMemo(
    () => draftFromCameraSnapshot(snapshot),
    [snapshot],
  );
  const [draftOverride, setDraftOverride] = useState<CameraDraft | null>(null);
  const orientationDirtyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const draft = draftOverride ?? baseDraft;

  function resetDraft(): void {
    setDraftOverride(null);
    orientationDirtyRef.current = false;
    setError(null);
  }

  function applyDraft(): void {
    const parsed = parseCameraDraft(draft);
    if (!parsed) {
      setError("Camera fields must contain finite numbers.");
      return;
    }

    const patch = cameraPatchFromDraft(parsed, orientationDirtyRef.current, snapshot.up);
    onCameraPatch(patch);
    setDraftOverride(null);
    orientationDirtyRef.current = false;
    setError(null);
  }

  function updateVectorDraft(
    field: "position" | "target",
    index: number,
    value: string,
  ): void {
    setDraftOverride((current) => ({
      ...(current ?? baseDraft),
      [field]: (current ?? baseDraft)[field].map((entry, entryIndex) =>
        entryIndex === index ? value : entry,
      ) as [string, string, string],
    }));
  }

  function updateScalarDraft(field: keyof CameraDraft, value: string): void {
    setDraftOverride((current) => ({
      ...(current ?? baseDraft),
      [field]: value,
    }));
    if (
      field === "distance" ||
      field === "pitchDegrees" ||
      field === "rollDegrees" ||
      field === "yawDegrees"
    ) {
      orientationDirtyRef.current = true;
    }
  }

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      origin: dialogPosition,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDialogPosition(
      clampDialogPosition({
        x: drag.origin.x + event.clientX - drag.startX,
        y: drag.origin.y + event.clientY - drag.startY,
      }),
    );
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const dialogStyle = {
    left: dialogPosition.x,
    top: dialogPosition.y,
  } satisfies CSSProperties;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby="fm-viewport-camera-dialog-description"
        aria-label="3D camera parameters"
        className="fm-viewport-camera-dialog"
        style={dialogStyle}
      >
        <DialogHeader
          className="fm-viewport-camera-dialog__header"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <DialogTitle>Camera Parameters</DialogTitle>
          <DialogDescription
            className="fm-visually-hidden"
            id="fm-viewport-camera-dialog-description"
          >
            Inspect and edit the 3D viewport camera position, target, projection,
            and orientation.
          </DialogDescription>
          <DialogClose asChild>
            <Button
              aria-label="Close camera parameters"
              className="fm-viewport-camera-dialog__close"
              onPointerDown={(event) => event.stopPropagation()}
              size="icon"
              variant="ghost"
            >
              <X aria-hidden="true" size={16} />
            </Button>
          </DialogClose>
        </DialogHeader>

        <div className="fm-viewport-camera-dialog__body">
          <div className="fm-viewport-camera-dialog__live">
            <CameraLiveValue label="Projection" value={snapshot.projection} />
            <CameraLiveValue
              label="Distance"
              value={formatCameraNumber(liveOrientation.distance)}
            />
            <CameraLiveValue
              label="Yaw"
              value={`${formatCameraNumber(liveOrientation.yawDegrees)} deg`}
            />
            <CameraLiveValue
              label="Pitch"
              value={`${formatCameraNumber(liveOrientation.pitchDegrees)} deg`}
            />
            <CameraLiveValue
              label="Roll"
              value={`${formatCameraNumber(liveOrientation.rollDegrees)} deg`}
            />
          </div>

          <div className="fm-viewport-camera-dialog__form">
            <CameraVectorInputs
              label="Position"
              values={draft.position}
              onChange={(index, value) =>
                updateVectorDraft("position", index, value)
              }
            />
            <CameraVectorInputs
              label="Target"
              values={draft.target}
              onChange={(index, value) =>
                updateVectorDraft("target", index, value)
              }
            />
            <CameraScalarInput
              label="Yaw"
              value={draft.yawDegrees}
              unit="deg"
              onChange={(value) => updateScalarDraft("yawDegrees", value)}
            />
            <CameraScalarInput
              label="Pitch"
              value={draft.pitchDegrees}
              unit="deg"
              onChange={(value) => updateScalarDraft("pitchDegrees", value)}
            />
            <CameraScalarInput
              label="Roll"
              value={draft.rollDegrees}
              unit="deg"
              onChange={(value) => updateScalarDraft("rollDegrees", value)}
            />
            <CameraScalarInput
              label="Distance"
              value={draft.distance}
              onChange={(value) => updateScalarDraft("distance", value)}
            />
            <label className="fm-viewport-camera-dialog__field">
              <span>Projection</span>
              <select
                value={draft.projection}
                onChange={(event) =>
                  updateScalarDraft(
                    "projection",
                    event.target.value as CameraProjection,
                  )
                }
              >
                <option value="perspective">Perspective</option>
                <option value="orthographic">Orthographic</option>
              </select>
            </label>
            <CameraScalarInput
              label="FOV"
              value={draft.fovDegrees}
              unit="deg"
              onChange={(value) => updateScalarDraft("fovDegrees", value)}
            />
            <CameraScalarInput
              label="Ortho scale"
              value={draft.orthographicScale}
              onChange={(value) => updateScalarDraft("orthographicScale", value)}
            />
          </div>

          {error ? (
            <div className="fm-viewport-camera-dialog__error">{error}</div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={resetDraft}>
            Reset
          </Button>
          <Button type="button" variant="primary" onClick={applyDraft}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CameraLiveValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="fm-viewport-camera-dialog__live-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CameraVectorInputs({
  label,
  onChange,
  values,
}: {
  label: string;
  onChange: (index: number, value: string) => void;
  values: [string, string, string];
}) {
  return (
    <fieldset className="fm-viewport-camera-dialog__vector">
      <legend>{label}</legend>
      {(["X", "Y", "Z"] as const).map((axis, index) => (
        <label key={axis} className="fm-viewport-camera-dialog__axis-field">
          <span>{axis}</span>
          <input
            inputMode="decimal"
            type="number"
            value={values[index]}
            onChange={(event) => onChange(index, event.target.value)}
          />
        </label>
      ))}
    </fieldset>
  );
}

function CameraScalarInput({
  label,
  onChange,
  unit,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  unit?: string;
  value: string;
}) {
  return (
    <label className="fm-viewport-camera-dialog__field">
      <span>{label}</span>
      <span className="fm-viewport-camera-dialog__input-with-unit">
        <input
          inputMode="decimal"
          type="number"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {unit ? <small>{unit}</small> : null}
      </span>
    </label>
  );
}

function buildCameraDialogSnapshot(
  cameraState: Viewport3DCameraState,
  cameraProjection: Viewport3DCameraProjection,
  cameraResource: CameraResource | null,
  cameraOrthographicScale: number | null,
): CameraDialogSnapshot {
  return {
    fovDegrees: cameraResource?.fov_degrees ?? DEFAULT_FOV_DEGREES,
    orthographicScale: cameraOrthographicScale ?? cameraResource?.orthographic_scale ?? null,
    position: cameraState.position,
    projection: cameraProjection,
    target: cameraState.target,
    up: cameraState.up ?? toCameraTuple(cameraResource?.up ?? VIEWPORT_3D_WORLD_UP),
  };
}

function draftFromCameraSnapshot(snapshot: CameraDialogSnapshot): CameraDraft {
  const orientation = resolveViewport3DCameraOrientation(snapshot);
  return {
    distance: formatCameraInput(orientation.distance),
    fovDegrees: formatCameraInput(snapshot.fovDegrees),
    orthographicScale:
      snapshot.orthographicScale === null
        ? ""
        : formatCameraInput(snapshot.orthographicScale),
    pitchDegrees: formatCameraInput(orientation.pitchDegrees),
    position: snapshot.position.map(formatCameraInput) as [
      string,
      string,
      string,
    ],
    projection: snapshot.projection,
    rollDegrees: formatCameraInput(orientation.rollDegrees),
    target: snapshot.target.map(formatCameraInput) as [string, string, string],
    yawDegrees: formatCameraInput(orientation.yawDegrees),
  };
}

function parseCameraDraft(draft: CameraDraft): {
  distance: number;
  fovDegrees: number;
  orthographicScale: number | null;
  pitchDegrees: number;
  position: CameraTuple;
  projection: CameraProjection;
  rollDegrees: number;
  target: CameraTuple;
  yawDegrees: number;
} | null {
  const position = parseTupleDraft(draft.position);
  const target = parseTupleDraft(draft.target);
  const yawDegrees = parseFiniteDraftNumber(draft.yawDegrees);
  const pitchDegrees = parseFiniteDraftNumber(draft.pitchDegrees);
  const rollDegrees = parseFiniteDraftNumber(draft.rollDegrees);
  const distance = parseFiniteDraftNumber(draft.distance);
  const fovDegrees = parseFiniteDraftNumber(draft.fovDegrees);
  const orthographicScale =
    draft.orthographicScale.trim() === ""
      ? null
      : parseFiniteDraftNumber(draft.orthographicScale);

  if (
    !position ||
    !target ||
    yawDegrees === null ||
    pitchDegrees === null ||
    rollDegrees === null ||
    distance === null ||
    fovDegrees === null ||
    orthographicScale === null && draft.orthographicScale.trim() !== ""
  ) {
    return null;
  }

  return {
    distance,
    fovDegrees,
    orthographicScale,
    pitchDegrees,
    position,
    projection: draft.projection,
    rollDegrees,
    target,
    yawDegrees,
  };
}

function cameraPatchFromDraft(
  parsed: NonNullable<ReturnType<typeof parseCameraDraft>>,
  orientationDirty: boolean,
  currentUp: CameraTuple,
): CameraPatch {
  const oriented = orientationDirty
      ? buildViewport3DCameraPoseFromOrientation(parsed)
      : {
          position: parsed.position,
          target: parsed.target,
          up: currentUp,
        };

  return {
    fov_degrees: parsed.fovDegrees,
    orthographic_scale: parsed.orthographicScale,
    position: oriented.position,
    projection: parsed.projection,
    target: oriented.target,
    up: oriented.up,
  };
}

function parseTupleDraft(values: [string, string, string]): CameraTuple | null {
  const parsed = values.map(parseFiniteDraftNumber);
  if (parsed.some((value) => value === null)) return null;
  return parsed as CameraTuple;
}

function parseFiniteDraftNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCameraInput(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value !== 0 && Math.abs(value) < 1e-3) return value.toExponential(6);
  return Number(value.toPrecision(8)).toString();
}

function formatCameraNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value !== 0 && Math.abs(value) < 1e-3) return value.toExponential(3);
  return Number(value.toPrecision(5)).toString();
}

function initialDialogPosition(): CameraDialogPosition {
  if (typeof window === "undefined") return { x: 96, y: 96 };
  return clampDialogPosition({
    x: Math.max(24, window.innerWidth - 520),
    y: 96,
  });
}

function clampDialogPosition(
  position: CameraDialogPosition,
): CameraDialogPosition {
  if (typeof window === "undefined") return position;
  return {
    x: Math.min(Math.max(12, position.x), Math.max(12, window.innerWidth - 360)),
    y: Math.min(Math.max(12, position.y), Math.max(12, window.innerHeight - 120)),
  };
}
