# Pinned Next.js patch

`next@16.3.8.patch` is a pnpm patch for the repository's pinned Next.js
16.3.8 dependency. It updates both the CommonJS and ESM router-server
artifacts. In development initialization only, after the render server has
initialized, it propagates the latest
`development.bundler.serverFields.appPathRoutes` through Next's existing
`propagateServerField` method. Production initialization and the normal HMR
propagation path are unchanged.

Regenerate this patch with pnpm's supported patch workflow (`pnpm patch`
followed by `pnpm patch-commit`) when changing the pinned Next.js version.
Review the generated CJS and ESM diff, refresh the workspace and lockfile
registration, and rerun the real direct-mount `/workspace` proof before
retaining it. Remove or revalidate this patch whenever Next.js is upgraded;
do not carry it forward by changing only the version string.

The current managed proof returned HTTP 200 for `/workspace` in 120.472 s
from direct `app`, `src`, `public`, and `scripts` mounts. Its durable JSON and
log are under the current run's diagnostics directory:

`<FULLMAG_PROJECT_STORAGE_ROOT>/runs/docker-all-windows-20261014-f009a6a0b6d6e110/docker-all/be57b979735a411d9ef9ee3fa537ace9/diagnostics/next-patched-route-41001-proof.json`
and the sibling `next-patched-route-41001-proof.log`.

The long cold compile is an observed development-environment property of that
proof, not a release-performance qualification.
