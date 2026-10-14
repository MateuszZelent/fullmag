// Opt-in fixture diagnostic. Retain metadata only, never hook values or fibers.
export async function installInspectorCommitTrace(page) {
  await page.addInitScript(() => {
    const trace = { commits: [], dropped: 0, errors: 0 };
    window.__FULLMAG_INSPECTOR_COMMIT_TRACE__ = trace;
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ?? {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer) {
        const id = this.renderers.size + 1;
        this.renderers.set(id, renderer);
        return id;
      },
      onCommitFiberUnmount() {},
    };
    const previousCommit = hook.onCommitFiberRoot;
    const lastCommittedFiber = new WeakMap();
    hook.onCommitFiberRoot = function (...args) {
      previousCommit?.apply(this, args);
      try {
        const search = [args[1]?.current];
        let inspector = null;
        let visited = 0;
        while (search.length && visited++ < 4096) {
          const fiber = search.pop();
          if (!fiber) continue;
          if (fiber.memoizedProps?.id === "InspectorModule") {
            inspector = fiber;
            break;
          }
          if (fiber.sibling) search.push(fiber.sibling);
          if (fiber.child) search.push(fiber.child);
        }
        if (!inspector) return;
        const pending = [inspector.child];
        const changes = [];
        let changesTruncated = false;
        visited = 0;
        while (pending.length && visited++ < 4096) {
          const fiber = pending.pop();
          if (!fiber) continue;
          if (fiber.sibling) pending.push(fiber.sibling);
          if (fiber.child) pending.push(fiber.child);
          const reused = lastCommittedFiber.get(fiber) === fiber;
          lastCommittedFiber.set(fiber, fiber);
          if (fiber.alternate) lastCommittedFiber.set(fiber.alternate, fiber);
          if (reused || ![0, 11, 15].includes(fiber.tag)) continue;
          const changedHooks = [];
          let current = fiber.memoizedState;
          let previous = fiber.alternate?.memoizedState;
          for (let index = 0; current && index < 32; index++) {
            if (!previous || current.memoizedState !== previous.memoizedState) changedHooks.push(index);
            current = current.next;
            previous = previous?.next;
          }
          if (!(fiber.flags & 1) && changedHooks.length === 0) continue;
          if (changes.length >= 128) { changesTruncated = true; continue; }
          const type = fiber.type;
          changes.push({
            name: type?.displayName ?? type?.name ?? type?.render?.displayName ?? type?.render?.name ?? `tag:${fiber.tag}`,
            flags: fiber.flags,
            actualDuration: fiber.actualDuration,
            mounted: !fiber.alternate,
            changedHooks,
          });
        }
        if (trace.commits.length >= 64) {
          trace.commits.shift();
          trace.dropped++;
        }
        trace.commits.push({ at: performance.now(), changes, changesTruncated, traversalTruncated: pending.length > 0 });
      } catch {
        trace.errors++;
      }
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  });
}
