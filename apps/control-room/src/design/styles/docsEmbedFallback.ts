export const EMBED_FALLBACK_STYLE_ID = "fullmag-embed-fallback-style";

export const EMBED_FALLBACK_CSS = `
:root,
html[data-theme="light"] {
  color-scheme: light;
  --fm-docs-bg-app: #eff1f5;
  --fm-docs-bg-chrome: #e6e9ef;
  --fm-docs-bg-surface: #f7f8fb;
  --fm-docs-bg-elevated: #e6e9ef;
  --fm-docs-bg-hover: #dce0e8;
  --fm-docs-border-subtle: #ccd0da;
  --fm-docs-border-default: #bcc0cc;
  --fm-docs-text-primary: #4c4f69;
  --fm-docs-text-secondary: #525570;
  --fm-docs-text-muted: #585c71;
  --fm-docs-accent: #1e66f5;
  --fm-docs-accent-text: #044ee0;
  --fm-docs-accent-soft: #d3e5fd;
  --fm-docs-success: #40a02b;
  --fm-docs-success-text: #256b15;
  --fm-docs-info: #04a5e5;
  --fm-docs-info-text: #09676c;
  --fm-docs-warning: #df8e1d;
  --fm-docs-warning-text: #865006;
  --fm-docs-danger: #d20f39;
  --fm-docs-danger-text: #ba092f;
  --fm-docs-mauve-text: #771af0;
  --fm-docs-peach: #fe640b;
  --fm-docs-degraded-text: #a13b00;
  --root-bg: var(--fm-docs-bg-app);
  --color-base-100: var(--fm-docs-bg-app);
  --color-base-200: var(--fm-docs-border-subtle);
  --color-base-300: var(--fm-docs-border-default);
  --color-base-content: var(--fm-docs-text-primary);
  --color-primary: var(--fm-docs-bg-elevated);
  --color-primary-content: var(--fm-docs-text-primary);
  --color-secondary: var(--fm-docs-bg-surface);
  --color-secondary-content: var(--fm-docs-text-secondary);
  --color-accent: var(--fm-docs-accent-soft);
  --color-accent-content: var(--fm-docs-accent-text);
  --color-neutral: var(--fm-docs-text-primary);
  --color-neutral-content: var(--fm-docs-bg-app);
  --color-info: var(--fm-docs-info);
  --color-info-content: var(--fm-docs-info-text);
  --color-success: var(--fm-docs-success);
  --color-success-content: var(--fm-docs-success-text);
  --color-warning: var(--fm-docs-warning);
  --color-warning-content: var(--fm-docs-warning-text);
  --color-error: var(--fm-docs-danger);
  --color-error-content: var(--fm-docs-danger-text);
  --article-heading--color: var(--fm-docs-text-primary);
  --article-text--color: var(--fm-docs-text-secondary);
  --article-mono--color: var(--fm-docs-mauve-text);
}

html[data-theme="dark"] {
  color-scheme: dark;
  --fm-docs-bg-app: #1e1e2e;
  --fm-docs-bg-chrome: #181825;
  --fm-docs-bg-surface: #242438;
  --fm-docs-bg-elevated: #313244;
  --fm-docs-bg-hover: #3b3c4f;
  --fm-docs-border-subtle: #313244;
  --fm-docs-border-default: #45475a;
  --fm-docs-text-primary: #cdd6f4;
  --fm-docs-text-secondary: #bac2de;
  --fm-docs-text-muted: #a6adc8;
  --fm-docs-accent: #89b4fa;
  --fm-docs-accent-text: #89b4fa;
  --fm-docs-accent-soft: #2a2d52;
  --fm-docs-success: #a6e3a1;
  --fm-docs-success-text: #a6e3a1;
  --fm-docs-info: #89dceb;
  --fm-docs-info-text: #89dceb;
  --fm-docs-warning: #f9e2af;
  --fm-docs-warning-text: #f9e2af;
  --fm-docs-danger: #f38ba8;
  --fm-docs-danger-text: #f592ad;
  --fm-docs-mauve-text: #cba6f7;
  --fm-docs-peach: #fab387;
  --fm-docs-degraded-text: #fab387;
  --root-bg: var(--fm-docs-bg-app);
  --color-base-100: var(--fm-docs-bg-app);
  --color-base-200: var(--fm-docs-border-subtle);
  --color-base-300: var(--fm-docs-border-default);
  --color-base-content: var(--fm-docs-text-primary);
  --color-primary: var(--fm-docs-bg-elevated);
  --color-primary-content: var(--fm-docs-text-primary);
  --color-secondary: var(--fm-docs-bg-surface);
  --color-secondary-content: var(--fm-docs-text-secondary);
  --color-accent: var(--fm-docs-accent-soft);
  --color-accent-content: var(--fm-docs-accent-text);
  --color-neutral: var(--fm-docs-text-primary);
  --color-neutral-content: var(--fm-docs-bg-app);
  --color-info: var(--fm-docs-info);
  --color-info-content: var(--fm-docs-info-text);
  --color-success: var(--fm-docs-success);
  --color-success-content: var(--fm-docs-success-text);
  --color-warning: var(--fm-docs-warning);
  --color-warning-content: var(--fm-docs-warning-text);
  --color-error: var(--fm-docs-danger);
  --color-error-content: var(--fm-docs-danger-text);
  --article-heading--color: var(--fm-docs-text-primary);
  --article-text--color: var(--fm-docs-text-secondary);
  --article-mono--color: var(--fm-docs-mauve-text);
}

html,
body,
.bg-base-100 {
  background-color: var(--fm-docs-bg-app) !important;
  color: var(--fm-docs-text-primary);
}

html[data-fullmag-embedded] {
  --header-height: 0px !important;
  --announcement-height: 0px !important;
}

html[data-fullmag-embedded] #main-header,
html[data-fullmag-embedded] #searchModal,
html[data-fullmag-embedded] .fm-header-build-stamp,
html[data-fullmag-embedded] .mode-select,
html[data-fullmag-embedded] #announcement,
html[data-fullmag-embedded] .announcement {
  display: none !important;
}

article > main div.highlight,
article > main pre {
  background-color: var(--fm-docs-bg-surface) !important;
  border-color: var(--fm-docs-border-subtle);
  color: var(--fm-docs-text-primary);
}

.highlighted {
  background-color: color-mix(in srgb, var(--fm-docs-warning) 22%, transparent);
  border-color: color-mix(in srgb, var(--fm-docs-warning) 55%, transparent);
  color: var(--fm-docs-text-primary);
}
`;
