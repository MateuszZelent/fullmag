import type { RibbonMenuItem } from "./ribbonRegistry";
import type { RibbonMenuNode } from "./ribbonMenuTypes";

export function legacyMenuItemsToNodes(items: RibbonMenuItem[] | undefined): RibbonMenuNode[] {
  if (!items?.length) {
    return [];
  }

  return items.flatMap((item): RibbonMenuNode[] => {
    if (item.hidden) {
      return [];
    }
    if (item.separator) {
      return [{ type: "separator", id: `${item.id}:separator` }];
    }

    return [
      {
        type: "item",
        id: item.id,
        label: item.label,
        icon: item.icon,
        description: item.description,
        disabled: item.disabled,
        state: item.active ? "active" : "default",
        action: item.action,
      },
    ];
  });
}
