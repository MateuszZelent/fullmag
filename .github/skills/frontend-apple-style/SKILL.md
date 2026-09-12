---
name: frontend-apple-style
description: "Use when building or reviewing gesture-driven UI, spring animations, drag/swipe/sheet interactions, momentum, interruptible transitions, translucent materials, typography, reduced motion, or interaction feedback."
---

# Fluid interaction and motion

Use this skill only for interaction and visual-motion decisions in `apps/control-room`. The user instruction and root `AGENTS.md` take precedence. Reuse already loaded frontend skills and do not load this skill for a static layout, data contract, or ordinary form change.

## Interaction contract

- Respond on pointer-down when feedback is meaningful; update a gesture continuously while it is active.
- Use Pointer Events and `setPointerCapture` for drags. Preserve the grab offset and track a short position/velocity history.
- Make gesture-driven motion interruptible. Start from the current presentation value, carry release velocity into the next animation, and allow retargeting without locking input.
- Use independent X/Y values for two-dimensional movement.
- Project momentum before choosing a snap point; use a spring only when it improves the interaction. A fixed transition is fine for a non-gesture state change.
- Apply rubber-banding at soft boundaries only where it communicates an available action.
- Keep enter and exit paths spatially consistent and anchor popovers to their trigger.

## Fullmag visual constraints

- Use `fm-*` classes and `--fm-*` tokens. Do not use generic class examples or raw Catppuccin/RGB colors.
- Treat translucency, blur, sound, haptics, and motion as optional enhancements. Validate contrast, reduced-transparency behavior, battery/performance impact, and browser support before using them.
- Do not animate persistent or conditionally rendered Inspector controls with opacity. Preserve focus, scroll, stable roots, and last-good content during resource refresh and acknowledgement.
- Keep layout and numerical data stable during transitions. Do not block pointer interaction or compete with scientific data.
- Prefer transform and opacity for compositor-friendly motion, with `will-change` only near an imminent interaction.

## Accessibility

- Respect `prefers-reduced-motion: reduce` with static or short opacity/color feedback and no spring overshoot.
- Respect `prefers-reduced-transparency: reduce` by increasing surface opacity and removing blur where supported.
- Respect `prefers-contrast: more` with solid, contrasting surfaces.
- Preserve keyboard operation, focus visibility, logical tab order, labels, target size, and non-color status cues.
- Keep sound and haptics causal, optional, and usable without the other channels.

## Verification

For a gesture or viewport interaction, run the smallest relevant browser or component regression. Verify pointer capture, interruption, reduced-motion behavior, focus, and measured layout at affected widths. For a WebGL viewport change, also apply the repository viewport smoke requirement, including context-loss and non-zero drawing-buffer checks.

Avoid adding a motion library or a new abstraction when CSS, Pointer Events, `requestAnimationFrame`, or an installed dependency already covers the behavior.
