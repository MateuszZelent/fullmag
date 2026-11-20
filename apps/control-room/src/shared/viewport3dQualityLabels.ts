export const VIEWPORT_3D_QUALITY_PROFILE_LABELS = {
  "interactive-lite": "Fast",
  interactive: "Standard",
  balanced: "Detailed",
  figure: "Figure",
} as const;

export type Viewport3DQualityProfileId = keyof typeof VIEWPORT_3D_QUALITY_PROFILE_LABELS;

export const VIEWPORT_3D_QUALITY_PROFILE_OPTIONS = [
  ["interactive-lite", VIEWPORT_3D_QUALITY_PROFILE_LABELS["interactive-lite"]],
  ["interactive", VIEWPORT_3D_QUALITY_PROFILE_LABELS.interactive],
  ["balanced", VIEWPORT_3D_QUALITY_PROFILE_LABELS.balanced],
  ["figure", VIEWPORT_3D_QUALITY_PROFILE_LABELS.figure],
] as const satisfies readonly (readonly [Viewport3DQualityProfileId, string])[];

/** What each profile changes: render scale (capped by the display density
 * for Fast and Standard), multisampling, and the shadow map used by Presentation. */
export const VIEWPORT_3D_QUALITY_PROFILE_SUMMARIES: Record<
  Viewport3DQualityProfileId,
  string
> = {
  "interactive-lite": "1× resolution · no anti-aliasing · no shadows or AO",
  interactive: "up to 1.25× resolution · anti-aliasing · 512 px shadows",
  balanced: "1.5× resolution on every display · anti-aliasing · 1024 px shadows",
  figure: "2× resolution on every display · anti-aliasing · 2048 px shadows, full-res AO",
};

export const VIEWPORT_3D_QUALITY_PROFILE_DESCRIPTIONS: Record<
  Viewport3DQualityProfileId,
  string
> = {
  "interactive-lite":
    "Fast prioritizes responsive navigation. Anti-aliasing, shadows, and ambient occlusion are omitted; your effect choices are kept for other quality profiles.",
  interactive:
    "Standard provides everyday image quality while keeping your selected effects.",
  balanced:
    "Detailed renders at 1.5× viewport resolution on every display and adds detail to active shadows. Your effect choices stay selected.",
  figure:
    "Figure renders at 2× viewport resolution on every display, including at 100% zoom. In Presentation, choosing Figure—or switching to Presentation while Figure is selected—automatically selects Studio lighting and enables soft shadows and ambient occlusion. You can adjust these effects afterward. It can use more GPU memory and take longer to render.",
};

export const VIEWPORT_3D_CAPTURE_PROFILE_DESCRIPTION =
  "Capture is for image capture. Choose Figure for higher on-screen quality.";
