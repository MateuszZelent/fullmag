/**
 * Materials tab ribbon contributions.
 */

import {
  Binary,
  FlaskConical,
  Magnet,
  Maximize2,
  Move,
  RefreshCw,
  Sparkles,
  Target,
} from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonAction, RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

function selectionAction(
  objectId: string | null,
  action: RibbonAction,
): RibbonAction {
  return {
    ...action,
    disabled: !objectId || action.disabled,
    tooltip:
      objectId != null
        ? action.tooltip
        : "Select ferromagnetic object in the tree first",
  };
}

function buildMaterialsGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const objectId = ctx.selectedObjectId;

  return [
    {
      id: "materials-selection",
      title: "Ferromagnet",
      subtitle: objectId ? `Selected: ${objectId}` : "Select body first",
      tone: "selection",
      actions: [
        selectionAction(objectId, {
          id: "materials-open-material",
          icon: <FlaskConical size={20} />,
          label: "Material",
          tooltip: "Open material constants for the selected ferromagnet",
          action: () => {
            if (!objectId) return;
            ctx.run({ id: "navigation.select-node", nodeId: `mat-${objectId}` });
          },
          iconColor: "text-amber-400",
        }),
        selectionAction(objectId, {
          id: "materials-open-physics",
          icon: <Magnet size={20} />,
          label: "Physics",
          tooltip: "Open the magnetic interactions stack for the selected ferromagnet",
          action: () => {
            if (!objectId) return;
            ctx.run({ id: "navigation.select-node", nodeId: `physobj-${objectId}` });
          },
          iconColor: "text-violet-400",
        }),
        selectionAction(objectId, {
          id: "materials-add-dmi",
          icon: <Sparkles size={20} />,
          label: "Add DMI",
          tooltip: "Add interfacial DMI to the selected ferromagnet",
          disabled:
            !objectId ||
            !ctx.can({
              id: "object.add-interaction",
              objectId,
              kind: "interfacial_dmi",
            }),
          action: () => {
            if (!objectId) return;
            ctx.run({
              id: "object.add-interaction",
              objectId,
              kind: "interfacial_dmi",
            });
          },
          iconColor: "text-cyan-400",
        }),
        selectionAction(objectId, {
          id: "materials-add-ku",
          icon: <Binary size={20} />,
          label: "Add Ku",
          tooltip: "Add uniaxial anisotropy to the selected ferromagnet",
          disabled:
            !objectId ||
            !ctx.can({
              id: "object.add-interaction",
              objectId,
              kind: "uniaxial_anisotropy",
            }),
          action: () => {
            if (!objectId) return;
            ctx.run({
              id: "object.add-interaction",
              objectId,
              kind: "uniaxial_anisotropy",
            });
          },
          iconColor: "text-rose-400",
        }),
      ],
    },
    {
      id: "materials-magnetization",
      title: "Magnetization",
      subtitle: "Texture presets",
      tone: "authoring",
      actions: [
        selectionAction(objectId, {
          id: "materials-open-magnetization",
          icon: <Magnet size={20} />,
          label: "Inspector",
          tooltip: "Open magnetization authoring for the selected ferromagnet",
          action: () => {
            if (!objectId) return;
            ctx.run({ id: "navigation.select-node", nodeId: `mag-${objectId}` });
          },
          iconColor: "text-sky-400",
        }),
        selectionAction(objectId, {
          id: "materials-mag-uniform",
          icon: <Magnet size={20} />,
          label: "Uniform",
          tooltip: "Assign uniform magnetization texture",
          action: () => {
            if (!objectId) return;
            ctx.run({
              id: "object.assign-magnetization-preset",
              objectId,
              kind: "uniform",
            });
            ctx.run({ id: "navigation.select-node", nodeId: `mag-${objectId}` });
          },
          iconColor: "text-sky-400",
        }),
        selectionAction(objectId, {
          id: "materials-mag-vortex",
          icon: <Sparkles size={20} />,
          label: "Vortex",
          tooltip: "Assign vortex magnetization texture",
          action: () => {
            if (!objectId) return;
            ctx.run({
              id: "object.assign-magnetization-preset",
              objectId,
              kind: "vortex",
            });
            ctx.run({ id: "navigation.select-node", nodeId: `mag-${objectId}` });
          },
          iconColor: "text-violet-400",
        }),
        selectionAction(objectId, {
          id: "materials-mag-bloch",
          icon: <Target size={20} />,
          label: "Bloch Sky",
          tooltip: "Assign Bloch skyrmion magnetization texture",
          action: () => {
            if (!objectId) return;
            ctx.run({
              id: "object.assign-magnetization-preset",
              objectId,
              kind: "bloch_skyrmion",
            });
            ctx.run({ id: "navigation.select-node", nodeId: `mag-${objectId}` });
          },
          iconColor: "text-cyan-400",
        }),
        selectionAction(objectId, {
          id: "materials-mag-neel",
          icon: <Target size={20} />,
          label: "Neel Sky",
          tooltip: "Assign Neel skyrmion magnetization texture",
          action: () => {
            if (!objectId) return;
            ctx.run({
              id: "object.assign-magnetization-preset",
              objectId,
              kind: "neel_skyrmion",
            });
            ctx.run({ id: "navigation.select-node", nodeId: `mag-${objectId}` });
          },
          iconColor: "text-emerald-400",
        }),
      ],
    },
    {
      id: "materials-transform",
      title: "Texture Transform",
      subtitle: "Camera vs object vs texture",
      tone: "neutral",
      actions: [
        {
          id: "materials-transform-camera",
          icon: <Target size={20} />,
          label: "Camera",
          tooltip: "Return viewport controls to camera navigation",
          active: ctx.activeTransformScope == null,
          disabled: !ctx.can({
            id: "viewport.set-transform-scope",
            scope: "camera",
          }),
          action: () => {
            ctx.run({
              id: "viewport.set-transform-scope",
              scope: "camera",
            });
          },
          iconColor: "text-slate-300",
        },
        selectionAction(objectId, {
          id: "materials-transform-object-scope",
          icon: <Move size={20} />,
          label: "Object",
          tooltip: "Switch viewport controls to object editing scope",
          active: ctx.activeTransformScope === "object",
          disabled:
            !objectId ||
            !ctx.can({
              id: "viewport.set-transform-scope",
              scope: "object",
            }),
          action: () => {
            ctx.run({
              id: "viewport.set-transform-scope",
              scope: "object",
            });
          },
          iconColor: "text-amber-300",
        }),
        selectionAction(objectId, {
          id: "materials-transform-texture-scope",
          icon: <Magnet size={20} />,
          label: "Texture",
          tooltip: "Switch viewport controls to texture editing scope",
          active: ctx.activeTransformScope === "texture",
          disabled:
            !objectId ||
            !ctx.can({
              id: "viewport.set-transform-scope",
              scope: "texture",
            }),
          action: () => {
            ctx.run({
              id: "viewport.set-transform-scope",
              scope: "texture",
            });
          },
          iconColor: "text-sky-300",
        }),
        selectionAction(objectId, {
          id: "materials-transform-move",
          icon: <Move size={20} />,
          label: "Move",
          tooltip: "Translate the selected magnetization texture",
          action: () => {
            if (!objectId) return;
            ctx.run({
              id: "object.set-texture-transform-mode",
              objectId,
              mode: "translate",
            });
          },
          iconColor: "text-amber-400",
        }),
        selectionAction(objectId, {
          id: "materials-transform-rotate",
          icon: <RefreshCw size={20} />,
          label: "Rotate",
          tooltip: "Rotate the selected magnetization texture",
          action: () => {
            if (!objectId) return;
            ctx.run({
              id: "object.set-texture-transform-mode",
              objectId,
              mode: "rotate",
            });
          },
          iconColor: "text-fuchsia-400",
        }),
        selectionAction(objectId, {
          id: "materials-transform-scale",
          icon: <Maximize2 size={20} />,
          label: "Scale",
          tooltip: "Scale the selected magnetization texture",
          action: () => {
            if (!objectId) return;
            ctx.run({
              id: "object.set-texture-transform-mode",
              objectId,
              mode: "scale",
            });
          },
          iconColor: "text-indigo-400",
        }),
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "materials",
  priority: 0,
  buildGroups: buildMaterialsGroups,
});
