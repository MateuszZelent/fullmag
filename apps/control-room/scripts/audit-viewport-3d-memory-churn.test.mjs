import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "vitest";

const auditSource = readFileSync(
  new URL("./audit-viewport-3d-memory-churn.mjs", import.meta.url),
  "utf8",
);
const resolverStart = auditSource.indexOf("function resolveInitialFdmFieldAdoption(");
const resolverEnd = auditSource.indexOf(
  "\nasync function assertPublicationRendered(",
  resolverStart,
);
assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
const resolveInitialFdmFieldAdoption = runInNewContext(
  `${auditSource.slice(resolverStart, resolverEnd)}; resolveInitialFdmFieldAdoption`,
  { URL },
);

const timelineStart = auditSource.indexOf(
  "function appendBoundedGpuLifecycleSnapshot(",
);
const timelineEnd = auditSource.indexOf(
  "\nasync function captureGpuLifecycleSnapshot(",
  timelineStart,
);
assert.ok(timelineStart >= 0 && timelineEnd > timelineStart);
const appendBoundedGpuLifecycleSnapshot = runInNewContext(
  auditSource.slice(timelineStart, timelineEnd) +
    "; appendBoundedGpuLifecycleSnapshot",
);
const quantityId = "H_eff";
const expectedObjectTargetId = "object:fdm-ready-box";
const payloadEtag = '"fdm-memory-H_eff-r0"';
const resourceKey =
  'api:scope-7|/v2/sessions/current/data/fields/H_eff/samples/vector?component=full&scope_kind=full';
const currentIdentity = {
  fieldBufferId: "full-buffer-current",
  fieldRevision: payloadEtag,
  resourceKey,
  sessionEpoch: "fdm-memory-session@1",
  sessionId: "fdm-memory-session",
};
const activeObjectAdoption = {
  adoptionSequence: 4,
  carrierId: "fdm-domain",
  fieldBufferId: currentIdentity.fieldBufferId,
  kind: "surface",
  requestScopeEpoch: "api:scope-7",
  resourceKey,
  sessionEpoch: currentIdentity.sessionEpoch,
  sessionId: currentIdentity.sessionId,
  targetId: "object:fdm-ready-box",
  targetKind: "object",
};
const latestRegionAdoption = {
  adoptionSequence: 5,
  carrierId: "fdm-domain",
  fieldBufferId: "region-buffer-newer",
  kind: "surface",
  requestScopeEpoch: "api:scope-7",
  resourceKey,
  sessionEpoch: currentIdentity.sessionEpoch,
  sessionId: currentIdentity.sessionId,
  targetId: "region:body",
  vectorBuildKey: null,
};
const surfaceEvent = {
  event: "surface-adoption",
  surfaceAdoption: {
    carrierId: activeObjectAdoption.carrierId,
    fieldBufferId: currentIdentity.fieldBufferId,
    requestScopeEpoch: "api:scope-7",
    resourceKey,
    result: { status: "adopted" },
    sessionEpoch: currentIdentity.sessionEpoch,
    sessionId: currentIdentity.sessionId,
    targetId: null,
  },
};

function frameCommit(overrides = {}) {
  return {
    currentFullBuffer: currentIdentity,
    currentFullBufferActiveAdoptions: [activeObjectAdoption],
    event: "frame-commit",
    latestActiveAdoption: latestRegionAdoption,
    requestScopeEpoch: "api:scope-7",
    ...overrides,
  };
}

test(
  "accepts an active object when the global latest receipt belongs to a region",
  () => {
    const result = resolveInitialFdmFieldAdoption(
      [surfaceEvent, frameCommit()],
      quantityId,
      payloadEtag,
      expectedObjectTargetId,
    );

    assert.equal(result.activeObjectAdoption.targetId, expectedObjectTargetId);
    assert.equal(result.latestActiveAdoption.targetId, "region:body");
    assert.equal(result.fieldBufferId, currentIdentity.fieldBufferId);
    assert.equal(result.surfaceAdoption.targetId, null);
  },
);

test(
  "rejects a historical surface event without an active object receipt",
  () => {
    assert.throws(
      () => resolveInitialFdmFieldAdoption(
        [surfaceEvent, frameCommit({ currentFullBufferActiveAdoptions: [] })],
        quantityId,
        payloadEtag,
        expectedObjectTargetId,
      ),
      /no active object surface adoption/,
    );
  },
);

test(
  "rejects a payload whose ETag differs from the current full buffer",
  () => {
    assert.throws(
      () => resolveInitialFdmFieldAdoption(
        [surfaceEvent, frameCommit()],
        quantityId,
        '"fdm-memory-H_eff-r1"',
        expectedObjectTargetId,
      ),
      /did not match recorded payload ETag/,
    );
  },
);

test(
  "rejects active receipts with mismatched target, resource, session, epoch, or scope",
  () => {
    const invalidAdoptions = [
      { ...activeObjectAdoption, targetKind: "region" },
      { ...activeObjectAdoption, targetId: "object:another-box" },
      { ...activeObjectAdoption, resourceKey: "other-resource" },
      { ...activeObjectAdoption, sessionId: "other-session" },
      { ...activeObjectAdoption, sessionEpoch: "other-epoch" },
      { ...activeObjectAdoption, requestScopeEpoch: "api:scope-stale" },
    ];

    for (const adoption of invalidAdoptions) {
      assert.throws(
        () => resolveInitialFdmFieldAdoption(
          [surfaceEvent, frameCommit({ currentFullBufferActiveAdoptions: [adoption] })],
          quantityId,
          payloadEtag,
          expectedObjectTargetId,
        ),
        /no active object surface adoption/,
      );
    }
  },
);

test(
  "requires the latest adoption to retain the exact resource and scope fences",
  () => {
    for (const latestActiveAdoption of [
      { ...latestRegionAdoption, resourceKey: "other-resource" },
      { ...latestRegionAdoption, sessionId: "other-session" },
      { ...latestRegionAdoption, sessionEpoch: "other-epoch" },
      { ...latestRegionAdoption, requestScopeEpoch: "api:scope-stale" },
    ]) {
      assert.throws(
        () => resolveInitialFdmFieldAdoption(
          [surfaceEvent, frameCommit({ latestActiveAdoption })],
          quantityId,
          payloadEtag,
          expectedObjectTargetId,
        ),
        /matching active adoption receipt/,
      );
    }
  },
);

test("bounds lifecycle snapshots while retaining the newest transition evidence", () => {
  const timeline = [];
  let dropped = 0;
  for (let index = 0; index < 260; index += 1) {
    dropped += appendBoundedGpuLifecycleSnapshot(
      timeline,
      { index },
    );
  }

  assert.equal(timeline.length, 256);
  assert.equal(timeline[0].index, 4);
  assert.equal(timeline.at(-1).index, 259);
  assert.equal(dropped, 4);
});
