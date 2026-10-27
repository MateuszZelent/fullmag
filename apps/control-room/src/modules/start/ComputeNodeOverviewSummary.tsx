import type {
  ComputeNodeCpuTopologySummary,
  ComputeNodeFact,
  ComputeNodeInventoryNodeSummary,
  ComputeNodeInventorySummary,
} from "./model/types";
import { CopyableIdentifier } from "./ui/CopyableIdentifier";

const GIB = 1024 ** 3;
const cpuFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const gibFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const sampleTimeFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ComputeNodeOverviewSummary({
  summary,
}: {
  readonly summary: ComputeNodeInventorySummary;
}) {
  if (summary.nodes.length === 0) {
    const state = summary.state ?? (
      summary.refreshFailed || summary.resourceStatus === "error"
        ? "unavailable"
        : "not_probed"
    );
    const loading = summary.resourceStatus === "loading" || summary.resourceStatus === "idle";
    const unavailable = summary.refreshFailed || summary.resourceStatus === "error" || summary.state === "unavailable";
    const notProbed = !summary.hasSnapshot || summary.state === "not_probed";
    const label = loading
      ? "Reading host inventory…"
      : unavailable
        ? "Unavailable"
        : notProbed
          ? "Not probed"
          : "No nodes reported";
    const detail = loading
      ? "Node identity and stable capacity will appear when the host inventory is available."
      : unavailable
        ? "Node identity and stable capacity could not be read from the host. Refresh to try again."
        : notProbed
          ? "The configured desktop host has not published a snapshot yet."
          : "The host inventory contains no compute node to identify.";

    return (
      <div aria-label="Compute host identity and capacity" className="fm-start-node-summary" role="group">
        <article className="fm-start-node-summary__card" data-node-state={state}>
          <div className="fm-start-node-summary__head">
            <h3>Compute node</h3>
            <span className="fm-start-compute-settings__status" data-state={nodeStateTone(state)} title={label}>
              {label}
            </span>
          </div>
          <p className="fm-start-node-summary__host">Stable identity and capacity</p>
          <p className="fm-start-compute-settings__notice" role="status">{detail}</p>
        </article>
      </div>
    );
  }

  return (
    <div aria-label="Compute host identity and capacity" className="fm-start-node-summary" role="group">
      {summary.nodes.map((node) => (
        <NodeSummary key={node.nodeId} node={node} />
      ))}
    </div>
  );
}

function NodeSummary({ node }: { readonly node: ComputeNodeInventoryNodeSummary }) {
  const snapshot = node.snapshot;
  const stateLabel = describeNodeState(node.state);

  return (
    <article className="fm-start-node-summary__card" data-node-state={node.state}>
      <div className="fm-start-node-summary__head">
        <h3>Compute node</h3>
        <span className="fm-start-compute-settings__status" data-state={nodeStateTone(node.state)}>
          {stateLabel}
        </span>
      </div>
      <p className="fm-start-node-summary__host">
        <CopyableIdentifier label="compute host ID" value={node.nodeId} />
      </p>
      <dl className="fm-start-node-summary__metrics">
        <Metric
          label="CPU topology"
          value={snapshot
            ? factText(snapshot.cpu.topology, describeCpuTopology)
            : "Unavailable"}
        />
        <Metric
          label="OS-allowed logical CPUs"
          value={snapshot
            ? factText(snapshot.cpu.allowedLogicalProcessorIds, (ids) => `${ids.length}`)
            : "Unavailable"}
        />
        <Metric
          label="Effective CPU capacity"
          value={snapshot ? describeEffectiveCapacity(snapshot) : "Unavailable"}
        />
        <Metric
          label="System memory"
          value={snapshot
            ? describeMemory(snapshot.memory.totalBytes, snapshot.memory.availableBytes)
            : "Unavailable"}
        />
        <Metric
          label="Stable GPU identities"
          value={snapshot
            ? factText(snapshot.gpus, (gpus) =>
                `${gpus.length} ${gpus.length === 1 ? "GPU UUID" : "GPU UUIDs"}`,
              )
            : "Unavailable"}
        />
        <Metric
          label="Inventory revision"
          value={snapshot ? `${snapshot.inventoryRevision}` : "Unavailable"}
        />
        <SampleMetric collectedAt={snapshot?.sample.collectedAt ?? null} />
        <Metric
          label="Fullmag workers"
          value={node.nodePolicy
            ? `${node.nodePolicy.activeWorkers} active · ${node.nodePolicy.maxParallelWorkers} max`
            : "Not reported"}
        />
      </dl>
    </article>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="fm-start-node-summary__metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SampleMetric({ collectedAt }: { readonly collectedAt: string | null }) {
  const timestamp = collectedAt ? Date.parse(collectedAt) : Number.NaN;
  const dateTime = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  return (
    <div className="fm-start-node-summary__metric">
      <dt>Inventory sample</dt>
      <dd>
        {dateTime
          ? <time dateTime={dateTime}>{sampleTimeFormat.format(timestamp)}</time>
          : "Not reported"}
      </dd>
    </div>
  );
}

function factText<T>(fact: ComputeNodeFact<T>, describe: (value: T) => string): string {
  if (fact.value === null) {
    return fact.status === "unavailable" ? "Unavailable" : "Not reported";
  }
  const value = describe(fact.value);
  return fact.status === "last_known" ? `Last known · ${value}` : value;
}

function describeCpuTopology(topology: ComputeNodeCpuTopologySummary): string {
  const parts = [
    topology.socketIds.length > 0 ? `${topology.socketIds.length} sockets` : undefined,
    topology.physicalCoreCount === null ? undefined : `${topology.physicalCoreCount} physical cores`,
    `${topology.logicalProcessorCount} logical CPUs`,
  ].filter((part): part is string => part !== undefined);
  return parts.join(" · ");
}

function describeMemory(totalBytes: number | null, availableBytes: number | null): string {
  const total = formatGiB(totalBytes);
  const available = formatGiB(availableBytes);
  if (total && available) return `${total} total · ${available} available`;
  if (total) return `${total} total`;
  if (available) return `${available} available`;
  return "Not reported";
}

function describeEffectiveCapacity(
  snapshot: NonNullable<ComputeNodeInventoryNodeSummary["snapshot"]>,
): string {
  const { effectiveCapacityAvailable, effectiveCapacityMillis, effectiveCapacityReason } = snapshot.cpu;
  if (
    effectiveCapacityAvailable && effectiveCapacityMillis !== null &&
    Number.isSafeInteger(effectiveCapacityMillis) && effectiveCapacityMillis >= 0
  ) {
    return `${cpuFormat.format(effectiveCapacityMillis / 1000)} CPU equivalents`;
  }

  switch (effectiveCapacityReason) {
    case "not_reported":
      return "Not reported";
    case "permission_denied":
      return "Unavailable · permission denied";
    case "unsupported":
      return "Unavailable · unsupported on this host";
    case "probe_failed":
      return "Unavailable · probe failed";
    case "source_unavailable":
      return "Unavailable · source unavailable";
    case "future_timestamp":
      return "Unavailable · sample timestamp is invalid";
    default:
      return "Unavailable";
  }
}

function formatGiB(bytes: number | null): string | null {
  if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  return `${gibFormat.format(bytes / GIB)} GiB`;
}

function describeNodeState(state: ComputeNodeInventoryNodeSummary["state"]): string {
  switch (state) {
    case "current":
      return "Connected";
    case "stale":
      return "Stale";
    case "not_probed":
      return "Not probed";
    case "unavailable":
      return "Unavailable";
    default:
      return "Not reported";
  }
}

function nodeStateTone(state: ComputeNodeInventoryNodeSummary["state"]): string {
  switch (state) {
    case "current":
      return "ready";
    case "stale":
    case "not_probed":
      return "unknown";
    case "unavailable":
      return "unavailable";
    default:
      return "unknown";
  }
}
