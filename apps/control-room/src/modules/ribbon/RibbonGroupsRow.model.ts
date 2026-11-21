import { ICON_COLOR_ALIASES } from "./ribbonCommon";

export function resolveRibbonIconColor(iconColor?: string): string | undefined {
  if (!iconColor) {
    return undefined;
  }

  if (iconColor.startsWith("var(")) {
    return iconColor;
  }

  if (iconColor === "text-muted-foreground") {
    return ICON_COLOR_ALIASES.muted;
  }

  const tailwindToken = /^text-([a-z]+)(?:-\d+)?$/.exec(iconColor);
  if (!tailwindToken) {
    return undefined;
  }

  return ICON_COLOR_ALIASES[tailwindToken[1]];
}

export function resolveRibbonActionTriggerState({
  disabled,
  hasMenu,
  splitButton,
}: {
  disabled?: boolean;
  hasMenu: boolean;
  splitButton?: boolean;
}): {
  disabled: boolean;
  runsActionFromButton: boolean;
  runsActionFromSplitBody: boolean;
} {
  if (disabled) {
    return {
      disabled: true,
      runsActionFromButton: false,
      runsActionFromSplitBody: false,
    };
  }

  return {
    disabled: false,
    runsActionFromButton: !hasMenu,
    runsActionFromSplitBody: hasMenu && Boolean(splitButton),
  };
}
