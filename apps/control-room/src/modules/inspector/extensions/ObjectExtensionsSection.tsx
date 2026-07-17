import type { ChangeEvent } from "react";

import type { Selection } from "@/kernel/selection/selectionTypes";
import { FieldRow } from "@/modules/inspector/primitives/FieldRow";
import { InspectorGroup } from "@/modules/inspector/primitives/InspectorGroup";

import {
  resolveObjectExtensionsSectionModel,
  setObjectExtensionEnabled,
} from "@/kernel/object-extensions/ObjectExtensionsSectionModel";
import type {
  ObjectExtensionActivationState,
  ObjectExtensionId,
} from "@/kernel/object-extensions/objectExtensionTypes";
import { useObjectExtensionActivation } from "@/kernel/object-extensions/useObjectExtensionActivation";

interface ObjectExtensionsSectionProps {
  activation?: ObjectExtensionActivationState;
  objectId: string;
  onActivationChange?: (activation: ObjectExtensionActivationState) => void;
  selection: Selection;
}

export function ObjectExtensionsSection({
  activation,
  objectId,
  onActivationChange,
  selection,
}: ObjectExtensionsSectionProps) {
  const localActivation = useObjectExtensionActivation();
  const effectiveActivation = activation ?? localActivation.activation;
  const model = resolveObjectExtensionsSectionModel(selection, effectiveActivation);

  if (!model.visible) return null;

  function updateExtension(extensionId: ObjectExtensionId, enabled: boolean): void {
    if (activation && onActivationChange) {
      onActivationChange(
        setObjectExtensionEnabled(activation, objectId, extensionId, enabled),
      );
      return;
    }
    localActivation.setEnabled(objectId, extensionId, enabled);
  }

  return (
    <InspectorGroup
      badge={model.badge}
      collapsible
      defaultOpen={model.activeCount > 0}
      title="Extensions"
    >
      <div className="fm-object-extensions">
        {model.extensions.map((extension) => (
          <label className="fm-object-extensions__row" key={extension.id}>
            <input
              checked={extension.enabled}
              type="checkbox"
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                updateExtension(extension.id, event.currentTarget.checked)
              }
            />
            <span className="fm-object-extensions__name">{extension.label}</span>
            <span className="fm-object-extensions__status">
              {extension.status}
            </span>
          </label>
        ))}
      </div>
      <FieldRow
        label="Active modules"
        value={model.activeCount === 0 ? "none" : String(model.activeCount)}
      />
    </InspectorGroup>
  );
}
