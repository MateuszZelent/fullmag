"use client";

import { Activity, HardDrive } from "lucide-react";

import type {
  ComputeNodeCpuTopologySummary,
  ComputeNodeFact,
  ComputeNodeFactStatus,
  ComputeNodeGpuPartition,
  ComputeNodeInventorySummary,
  ComputeNodePolicySummary,
  ComputeNodeSnapshotSummary,
  ComputeProbeController,
} from "./model/types";
import { ComputeNodePolicyEditor } from "./ComputeNodePolicyEditor";

const BYTE_GIB = 1024 ** 3;
const cpuFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const gibFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const timestampFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function ComputeNodeInventoryDetails({
  summary,
  canEditNodePolicy = false,
  onUpdateNodePolicy,
}: {
  readonly summary: ComputeNodeInventorySummary;
  readonly canEditNodePolicy?: boolean;
  readonly onUpdateNodePolicy?: ComputeProbeController["updateNodePolicy"];
}) {
  if (!summary.hasSnapshot) return null;

  return (
    <section
      aria-labelledby="fm-start-compute-inventory-title"
      className="fm-start-compute-settings__panel fm-start-compute-settings__panel--inventory"
    >
      <div className="fm-start-compute-settings__panel-head">
        <HardDrive aria-hidden="true" size={16} />
        <h3 id="fm-start-compute-inventory-title">Stable host inventory</h3>
      </div>
      <p className="fm-start-compute-settings__lane-note">
        CPU topology, OS constraints, and GPU identity from the host snapshot. These facts are separate from live telemetry and solver availability.
      </p>
      {summary.nodes.length > 0 ? (
        <div className="fm-start-compute-settings__inventory-nodes">
          {summary.nodes.map((node) => node.snapshot ? (
            <NodeSnapshotCard
              key={node.nodeId}
              nodeState={node.state}
              nodePolicy={node.nodePolicy}
              snapshot={node.snapshot}
              canEditNodePolicy={canEditNodePolicy}
              onUpdateNodePolicy={onUpdateNodePolicy}
            />
          ) : (
            <article className="fm-start-compute-settings__gpu-card" key={node.nodeId}>
              <div className="fm-start-compute-settings__gpu-head">
                <h4>{node.nodeId}</h4>
                <span className="fm-start-compute-settings__status" data-state="unavailable">Snapshot unavailable</span>
              </div>
              <p className="fm-start-compute-settings__reason">
                The host returned an unsupported or inconsistent snapshot version.
              </p>
            </article>
          ))}
        </div>
      ) : (
        <p className="fm-start-compute-settings__notice">
          No node snapshot is available to show stable CPU or GPU identity.
        </p>
      )}
    </section>
  );
}

function NodeSnapshotCard({
  nodeState,
  nodePolicy,
  snapshot,
  canEditNodePolicy,
  onUpdateNodePolicy,
}: {
  readonly nodeState: ComputeNodeInventorySummary["nodes"][number]["state"];
  readonly nodePolicy: ComputeNodePolicySummary | null;
  readonly snapshot: ComputeNodeSnapshotSummary;
  readonly canEditNodePolicy: boolean;
  readonly onUpdateNodePolicy?: ComputeProbeController["updateNodePolicy"];
}) {
  const freshness = snapshot.sample.freshness;
  const status = nodeStatePresentation(nodeState, freshness);
  return (
    <article
      className="fm-start-compute-settings__gpu-card"
      data-freshness={freshness ?? "unknown"}
      data-node-state={nodeState}
    >
      <div className="fm-start-compute-settings__gpu-head">
        <div>
          <h4>{snapshot.nodeId}</h4>
          <p>Inventory revision {snapshot.inventoryRevision}</p>
        </div>
        <span
          className="fm-start-compute-settings__status"
          data-state={status.state}
        >
          {status.label}
        </span>
      </div>

      <dl className="fm-start-compute-settings__metrics fm-start-compute-settings__metrics--gpu">
        <InventoryMetric label="Sample source" value={tokenLabel(snapshot.sample.source)} />
        <InventoryMetric label="Sample freshness" value={freshnessLabel(freshness)} />
        <div className="fm-start-compute-settings__metric">
          <dt>Collected (UTC)</dt>
          <dd>
            {snapshot.sample.collectedAt ? (
              <time dateTime={snapshot.sample.collectedAt}>
                {timestampFormat.format(new Date(snapshot.sample.collectedAt))}
              </time>
            ) : "Not reported"}
          </dd>
        </div>
        <InventoryMetric label="CPU topology" value={factText(snapshot.cpu.topology, describeCpuTopology)} />
        <InventoryMetric
          label="Allowed logical CPUs"
          value={factText(snapshot.cpu.allowedLogicalProcessorIds, compactIds)}
        />
        <InventoryMetric
          label="Observed CPU capacity"
          value={snapshot.cpu.effectiveCapacityAvailable
            && snapshot.cpu.effectiveCapacityMillis !== null
            && Number.isSafeInteger(snapshot.cpu.effectiveCapacityMillis)
            && snapshot.cpu.effectiveCapacityMillis >= 0
            ? `${cpuFormat.format(snapshot.cpu.effectiveCapacityMillis / 1000)} CPU equivalents`
            : snapshot.cpu.effectiveCapacityAvailable
              ? "Not safely displayable"
              : "Unavailable"}
        />
        <InventoryMetric label="OS CPU quota" value={factText(snapshot.cpu.quota, describeCpuQuota)} />
        <InventoryMetric label="Total memory" value={formatOptionalBytes(snapshot.memory.totalBytes)} />
        <InventoryMetric label="Available memory" value={formatOptionalBytes(snapshot.memory.availableBytes)} />
        <InventoryMetric label="CPU affinity enforcement" value={tokenLabel(snapshot.enforcement.cpuAffinity)} />
        <InventoryMetric label="CPU quota enforcement" value={tokenLabel(snapshot.enforcement.cpuQuota)} />
        <InventoryMetric label="Memory cap enforcement" value={tokenLabel(snapshot.enforcement.memoryCap)} />
        <InventoryMetric label="GPU visibility enforcement" value={tokenLabel(snapshot.enforcement.gpuVisibility)} />
        <InventoryMetric label="Storage quota enforcement" value={tokenLabel(snapshot.enforcement.storageQuota)} />
      </dl>

      <div className="fm-start-compute-settings__inventory-gpus">
        <div className="fm-start-compute-settings__gpu-head">
          <Activity aria-hidden="true" size={14} />
          <h4>GPU identity</h4>
          <span
            className="fm-start-compute-settings__status"
            data-state={snapshot.gpus.status === "available" ? "ready" : "unknown"}
          >
            {snapshot.gpus.value !== null
              ? `${snapshot.gpus.value.length} ${snapshot.gpus.status === "available" ? "current" : "last known"}`
              : factStatusLabel(snapshot.gpus.status)}
          </span>
        </div>
        {snapshot.gpus.value === null ? (
          <p className="fm-start-compute-settings__reason">
            GPU inventory is unavailable; this does not establish that the host has no GPU.
          </p>
        ) : snapshot.gpus.value.length === 0 ? (
          <p className="fm-start-compute-settings__reason">
            The snapshot reports no GPU devices{snapshot.gpus.status === "last_known" ? " · last known" : ""}.
          </p>
        ) : (
          <ul aria-label={`GPU inventory for ${snapshot.nodeId}`} className="fm-start-compute-settings__gpu-list">
            {snapshot.gpus.value.map((gpu) => (
              <li className="fm-start-compute-settings__gpu-card" key={gpu.uuid}>
                <div className="fm-start-compute-settings__gpu-head">
                  <div>
                    <h4>{gpu.name.value ?? "GPU name unavailable"}{gpu.name.status === "last_known" ? " · last known" : ""}</h4>
                    <p>Stable UUID · {gpu.uuid}</p>
                  </div>
                  <span className="fm-start-compute-settings__status" data-state={gpu.name.status === "available" ? "ready" : "unknown"}>
                    {factStatusLabel(gpu.name.status)}
                  </span>
                </div>
                <dl className="fm-start-compute-settings__metrics fm-start-compute-settings__metrics--gpu">
                  <InventoryMetric label="PCI ID" value={factText(gpu.pciId, (value) => value)} />
                  <InventoryMetric label="VRAM total" value={factText(gpu.vramBytes, formatBytes)} />
                  <InventoryMetric label="Partition" value={factText(gpu.partition, describeGpuPartition)} />
                  <InventoryMetric label="NUMA node" value={factText(gpu.numaNodeId, (value) => `${value}`)} />
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="fm-start-compute-settings__inventory-gpus">
        <div className="fm-start-compute-settings__gpu-head">
          <HardDrive aria-hidden="true" size={14} />
          <h4>Admission policy</h4>
          <span
            className="fm-start-compute-settings__status"
            data-state={nodePolicy
              ? nodePolicy.overBudget || nodePolicy.blockingReasons.length > 0 ? "unavailable" : nodePolicy.draining ? "unknown" : "ready"
              : "unknown"}
          >
            {nodePolicy
              ? nodePolicy.overBudget ? "Over budget" : nodePolicy.draining ? "Draining" : nodePolicy.blockingReasons.length > 0 ? "Existing policy conflict" : nodePolicy.activeWorkers >= nodePolicy.maxParallelWorkers ? "Worker limit reached" : "Accepting new work"
              : "Not reported"}
          </span>
        </div>
        {nodePolicy ? (
          <>
            <dl className="fm-start-compute-settings__metrics fm-start-compute-settings__metrics--gpu">
              <InventoryMetric label="Policy revision" value={`${nodePolicy.revision}`} />
              <InventoryMetric
                label="Active workers"
                value={`${nodePolicy.activeWorkers} / ${nodePolicy.maxParallelWorkers}`}
              />
              <InventoryMetric
                label="Allowed CPUs"
                value={nodePolicy.allowedCpuIds.length ? compactIds(nodePolicy.allowedCpuIds) : "None"}
              />
              <InventoryMetric
                label="Allowed GPUs"
                value={nodePolicy.allowedGpuUuids.length
                  ? `${nodePolicy.allowedGpuUuids.length} device UUIDs`
                  : "None"}
              />
              <InventoryMetric
                label="CPU reserve"
                value={`${cpuFormat.format(nodePolicy.cpuReserveMillis / 1000)} CPU equivalents`}
              />
              <InventoryMetric label="RAM reserve" value={formatBytes(nodePolicy.memoryReserveBytes)} />
              <InventoryMetric label="Scratch reserve" value={formatBytes(nodePolicy.scratchReserveBytes)} />
              <InventoryMetric
                label="GPU VRAM reserves"
                value={Object.keys(nodePolicy.gpuVramReserves).length
                  ? `${Object.keys(nodePolicy.gpuVramReserves).length} device UUIDs`
                  : "None"}
              />
              <InventoryMetric label="Priority levels" value={`${nodePolicy.priorityOrder.length}`} />
              <InventoryMetric label="Allowed parallelism patterns" value={`${nodePolicy.parallelismPatternCount}`} />
            </dl>
            {nodePolicy.blockingReasons.length > 0 ? (
              <p className="fm-start-compute-settings__reason">
                New admissions are blocked by: {nodePolicy.blockingReasons.map(tokenLabel).join(", ")}.
              </p>
            ) : null}
          </>
        ) : (
          <p className="fm-start-compute-settings__reason">
            No operator policy is reported. New host admissions remain unavailable until a policy is configured.
          </p>
        )}
      </div>
      <ComputeNodePolicyEditor
        canEdit={canEditNodePolicy}
        nodeId={snapshot.nodeId}
        onUpdate={onUpdateNodePolicy}
        policy={nodePolicy}
        snapshot={snapshot}
      />
      <p className="fm-start-compute-settings__reason">
        Observed capacity and memory are readings, not reservations. A concrete device is resolved when a run starts.
      </p>
    </article>
  );
}

function InventoryMetric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="fm-start-compute-settings__metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function factText<T>(fact: ComputeNodeFact<T>, format: (value: T) => string): string {
  if (fact.value === null) return "Unavailable";
  const value = format(fact.value);
  return fact.status === "last_known" ? `${value} · last known` : value;
}

function describeCpuTopology(topology: ComputeNodeCpuTopologySummary): string {
  const parts = [`${topology.logicalProcessorCount} logical CPUs`];
  if (topology.physicalCoreCount !== null) parts.push(`${topology.physicalCoreCount} physical cores`);
  if (topology.socketIds.length) parts.push(`${topology.socketIds.length} known sockets`);
  if (topology.numaNodeIds.length) parts.push(`known NUMA nodes ${topology.numaNodeIds.join(", ")}`);
  return `${parts.join(" · ")} (IDs ${compactIds(topology.logicalCpuIds)})`;
}

function compactIds(ids: readonly number[]): string {
  const ranges: string[] = [];
  for (let index = 0; index < ids.length;) {
    const start = ids[index];
    let end = start;
    while (index + 1 < ids.length && ids[index + 1] === end + 1) {
      index += 1;
      end = ids[index];
    }
    ranges.push(start === end ? `${start}` : `${start}–${end}`);
    index += 1;
  }
  return ranges.join(", ");
}

function describeCpuQuota(quota: NonNullable<ComputeNodeSnapshotSummary["cpu"]["quota"]["value"]>): string {
  if (quota.mode === "unlimited") return "Unlimited";
  return Number.isSafeInteger(quota.capacityMillis) && quota.capacityMillis >= 0
    ? `${cpuFormat.format(quota.capacityMillis / 1000)} CPU equivalents`
    : "Not safely displayable";
}

function describeGpuPartition(partition: ComputeNodeGpuPartition): string {
  switch (partition.kind) {
    case "full_device":
      return "Full GPU device";
    case "mig":
      return `MIG ${partition.partitionId} · parent ${partition.parentGpuUuid}`;
    case "unknown":
      return "Unknown partition";
  }
}

function formatBytes(bytes: number): string {
  return Number.isSafeInteger(bytes) && bytes >= 0
    ? `${gibFormat.format(bytes / BYTE_GIB)} GiB`
    : "Not safely displayable";
}

function formatOptionalBytes(bytes: number | null): string {
  return bytes === null ? "Unavailable" : formatBytes(bytes);
}

function tokenLabel(value: string | null): string {
  return value ? value.replaceAll("_", " ") : "Not reported";
}

function factStatusLabel(status: ComputeNodeFactStatus): string {
  return status === "last_known" ? "Last known" : status === "available" ? "Current" : "Unavailable";
}

function freshnessLabel(freshness: string | null): string {
  return freshness === "current" ? "Current sample"
    : freshness === "stale" ? "Stale sample"
      : freshness === "unavailable" ? "Unavailable sample"
        : "Freshness unknown";
}

function nodeStatePresentation(
  state: ComputeNodeInventorySummary["nodes"][number]["state"],
  freshness: string | null,
): { readonly label: string; readonly state: "ready" | "unknown" | "unavailable" } {
  switch (state) {
    case "current":
      return { label: "Current on this host boot", state: "ready" };
    case "stale":
      return { label: "Stale", state: "unknown" };
    case "unavailable":
      return freshness === "current"
        ? { label: "Unavailable · previous host boot", state: "unavailable" }
        : { label: "Unavailable", state: "unavailable" };
    case "not_probed":
      return { label: "Not probed", state: "unknown" };
  }
}
