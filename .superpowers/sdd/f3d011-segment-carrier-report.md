# F3D-011 segment carrier alignment

Implemented explicit degraded `object-segment` render carriers. Mesh parts retain ownership when present; segment-only manifests render using their published topology ranges but are not field-capable. Field/scalar/vector passes use a separate mesh-part-only topology model. Inspector target lookup uses the same carrier normalization. Diagnostics now expose carrier kind and degraded count.

Verification: focused Vitest (161 tests), `pnpm --dir apps/control-room typecheck`, targeted ESLint, and `git diff --check` passed.
