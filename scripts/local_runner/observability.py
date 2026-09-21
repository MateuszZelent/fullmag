"""Observability, telemetry, resource registry, and storage metrics for Fullmag Build Runner.

Provides structured event recording, time-series metrics sampling, storage volume
analysis, job lifecycle timeline decomposition, and retention policy management.
"""

from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import threading
import time
import uuid
from typing import Any, Mapping

from fullmag_storage import atomic_json, validate_path
from local_runner.retention import plan as retention_plan


_DEFAULT_POLICY = {
    "version": "1.0",
    "mode": "preview",
    "mode_supported": ["preview"],
    "automatic_mode_available": False,
    "notice": "Wszystkie operacje retencji działają w bezpiecznym trybie podglądu (preview); wykonawca automatycznego usuwania nie jest włączony.",
    "ttl_success_hours": 24,
    "ttl_failure_hours": 168,
    "ttl_orphan_hours": 24,
    "ttl_sources_hours": 168,
    "ttl_logs_days": 30,
    "min_artifacts_to_keep": 3,
    "disk_warning_threshold_gib": 30,
    "disk_critical_threshold_gib": 10,
    "min_free_space_gib": 8,
    "disk_sample_interval_seconds": 5,
}

_MAX_EVENTS = 500
_MAX_METRIC_SAMPLES = 120
_REDACT_PATTERN = re.compile(r"(?i)(token|bearer|secret|password|lease_token)[:=\s]+([^\s,]+)")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_REPARSE_POINT = 0x400


def _is_reparse_or_symlink(path: Path | str) -> bool:
    try:
        info = os.lstat(path)
    except (FileNotFoundError, OSError):
        return True
    if stat.S_ISLNK(info.st_mode):
        return True
    return bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT)


def get_process_rss_bytes(pid: int | None = None) -> int | None:
    """Read actual RSS memory bytes of the target process or self using OS interfaces."""
    pid_str = str(pid) if pid else "self"
    status_path = Path(f"/proc/{pid_str}/status")
    if status_path.is_file():
        try:
            for line in status_path.read_text(encoding="utf-8").splitlines():
                if line.startswith("VmRSS:"):
                    parts = line.split()
                    if len(parts) >= 2:
                        return int(parts[1]) * 1024
        except Exception:
            pass

    # Try cgroups (v2 then v1)
    cg2 = Path("/sys/fs/cgroup/memory.current")
    if cg2.is_file():
        try:
            return int(cg2.read_text().strip())
        except Exception:
            pass
    cg1 = Path("/sys/fs/cgroup/memory/memory.usage_in_bytes")
    if cg1.is_file():
        try:
            return int(cg1.read_text().strip())
        except Exception:
            pass

    # psutil fallback
    try:
        import psutil
        p = psutil.Process(pid) if pid else psutil.Process()
        return int(p.memory_info().rss)
    except Exception:
        pass

    return None


def get_process_memory_limit_bytes() -> int | None:
    """Read configured cgroup memory limit in bytes, returning None if unlimited."""
    cg2 = Path("/sys/fs/cgroup/memory.max")
    if cg2.is_file():
        try:
            val = cg2.read_text().strip()
            if val != "max":
                return int(val)
            return None
        except Exception:
            pass

    cg1 = Path("/sys/fs/cgroup/memory/memory.limit_in_bytes")
    if cg1.is_file():
        try:
            val = int(cg1.read_text().strip())
            if val < 1024**5:
                return val
            return None
        except Exception:
            pass

    return None


class ProcessResourceTracker:
    """Samples real CPU and I/O consumption delta rates over elapsed wall clock time."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last_time = time.time()
        self._last_cpu_time = self._read_cpu_time()
        self._last_io_bytes = self._read_io_bytes()

    def _read_cpu_time(self) -> float | None:
        stat_path = Path("/proc/self/stat")
        if stat_path.is_file():
            try:
                parts = stat_path.read_text(encoding="utf-8").split()
                utime = int(parts[13])
                stime = int(parts[14])
                clk_tck = 100
                if hasattr(os, "sysconf") and "SC_CLK_TCK" in getattr(os, "sysconf_names", {}):
                    clk_tck = os.sysconf("SC_CLK_TCK")
                return (utime + stime) / clk_tck
            except Exception:
                pass

        cg_cpu = Path("/sys/fs/cgroup/cpu.stat")
        if cg_cpu.is_file():
            try:
                for line in cg_cpu.read_text().splitlines():
                    if line.startswith("usage_usec"):
                        return int(line.split()[1]) / 1_000_000.0
            except Exception:
                pass

        try:
            import psutil
            times = psutil.Process().cpu_times()
            return float(times.user + times.system)
        except Exception:
            pass

        return None

    def _read_io_bytes(self) -> int | None:
        io_path = Path("/proc/self/io")
        if io_path.is_file():
            try:
                r_bytes = 0
                w_bytes = 0
                for line in io_path.read_text().splitlines():
                    if line.startswith("read_bytes:"):
                        r_bytes = int(line.split()[1])
                    elif line.startswith("write_bytes:"):
                        w_bytes = int(line.split()[1])
                return r_bytes + w_bytes
            except Exception:
                pass

        try:
            import psutil
            io_cnt = psutil.Process().io_counters()
            return int(io_cnt.read_bytes + io_cnt.write_bytes)
        except Exception:
            pass

        return None

    def measure(self) -> tuple[float | None, float | None]:
        with self._lock:
            now = time.time()
            dt = now - self._last_time
            curr_cpu = self._read_cpu_time()
            curr_io = self._read_io_bytes()

            cpu_pct = None
            io_mb_s = None

            if dt > 0.05 and self._last_cpu_time is not None and curr_cpu is not None:
                d_cpu = curr_cpu - self._last_cpu_time
                if d_cpu >= 0:
                    cpus = os.cpu_count() or 1
                    cpu_pct = round((d_cpu / dt) * 100.0 / cpus, 1)

            if dt > 0.05 and self._last_io_bytes is not None and curr_io is not None:
                d_io = curr_io - self._last_io_bytes
                if d_io >= 0:
                    io_mb_s = round((d_io / dt) / (1024 * 1024), 2)

            if cpu_pct is None:
                try:
                    import psutil
                    cpu_pct = float(psutil.Process().cpu_percent(interval=None))
                except Exception:
                    pass

            self._last_time = now
            if curr_cpu is not None:
                self._last_cpu_time = curr_cpu
            if curr_io is not None:
                self._last_io_bytes = curr_io

            return cpu_pct, io_mb_s


def _probe_docker_root(storage_path: Path) -> tuple[str, str, str | None]:
    """Find actual docker storage or backing root path on Linux or Windows."""
    try:
        from local_runner.coordinator import docker
        out = docker(["info", "--format", "{{.DockerRootDir}}"]).strip()
        if out and os.path.exists(out):
            return out, f"Docker backing storage ({out})", "ext4"
    except Exception:
        pass

    candidates = [
        ("/var/lib/docker", "Docker backing storage (/var/lib/docker)", "ext4"),
        ("/run/desktop/mnt/host", "Docker Desktop host mount", "overlay"),
        (os.path.join(os.environ.get("ProgramData", "C:\\ProgramData"), "DockerDesktop"), "Docker Desktop data root", "NTFS"),
        (str(storage_path.anchor if hasattr(storage_path, "anchor") and storage_path.anchor else "/"), "Host backing filesystem", "local"),
    ]
    for path_str, name, fs in candidates:
        if os.path.exists(path_str):
            return path_str, name, fs
    return str(storage_path), "Docker backing storage", None


class ObservabilityHub:
    """Thread-safe state hub for runner telemetry, metrics, and storage inventory."""

    def __init__(self, storage_root: Path | str, owner: str = "operator"):
        self.storage = Path(storage_root)
        self.owner = owner
        self._lock = threading.RLock()
        self._tracker = ProcessResourceTracker()
        self._baseline_used_bytes: int | None = None
        self._events: deque[dict[str, Any]] = deque(maxlen=_MAX_EVENTS)
        self._metric_samples: deque[dict[str, Any]] = deque(maxlen=_MAX_METRIC_SAMPLES)
        self._plans: dict[str, dict[str, Any]] = {}
        self._resources_cache: dict[str, Any] | None = None
        self._resources_cache_time: float = 0.0
        self._init_default_events()
        self._init_metrics_history()

    def _init_default_events(self) -> None:
        now = _utc_now_iso()
        self.record_event("INFO", "runner_started", "Fullmag build runner coordinator online", now=now)
        self.record_event("INFO", "queue_ready", "Single heavy build slot initialized and listening", now=now)

    def _metrics_history_file(self) -> Path:
        return self.storage / "index" / "metrics-history.json"

    def _take_real_measurement(self) -> dict[str, Any]:
        try:
            usage = shutil.disk_usage(self.storage)
            free_gb = round(usage.free / (1024 * 1024 * 1024), 2)
            if self._baseline_used_bytes is None:
                self._baseline_used_bytes = usage.used
            growth_mb = round(max(0.0, (usage.used - self._baseline_used_bytes) / (1024 * 1024)), 1)
        except Exception:
            free_gb = None
            growth_mb = None

        rss_bytes = get_process_rss_bytes()
        ram_mb = round(rss_bytes / (1024 * 1024), 1) if rss_bytes is not None else None
        cpu_pct, io_rate = self._tracker.measure()

        return {
            "disk_free_gb": free_gb,
            "storage_growth_mb": growth_mb,
            "ram_mb": ram_mb,
            "cpu_percent": cpu_pct,
            "io_mb_s": io_rate,
        }

    def _init_metrics_history(self) -> None:
        """Load real persisted samples or take a single current baseline measurement."""
        history_path = self._metrics_history_file()
        if history_path.is_file():
            try:
                saved = json.loads(history_path.read_text(encoding="utf-8"))
                if isinstance(saved, list):
                    for item in saved:
                        if isinstance(item, dict) and "timestamp" in item:
                            self._metric_samples.append(item)
            except Exception:
                pass

        try:
            self.sample_metrics()
        except Exception:
            pass

    def record_event(
        self,
        level: str,
        event: str,
        message: str,
        *,
        job_id: str | None = None,
        profile: str | None = None,
        stage: str | None = None,
        duration: float | None = None,
        now: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            redacted_message = _REDACT_PATTERN.sub(r"\1=***", message)
            record = {
                "id": uuid.uuid4().hex[:12],
                "timestamp": now or _utc_now_iso(),
                "level": level.upper(),
                "event": event,
                "message": redacted_message,
                "job_id": job_id,
                "profile": profile,
                "stage": stage,
                "duration_seconds": duration,
            }
            self._events.append(record)

            # Log structured redacted event to stdout for Docker / container logs
            log_line = f"[{record['timestamp']}] [{record['level']}] {record['event']}: {record['message']}"
            if job_id:
                log_line += f" (job={job_id})"
            if stage:
                log_line += f" (stage={stage})"
            try:
                sys.stdout.write(log_line + "\n")
                sys.stdout.flush()
            except Exception:
                pass

            return record

    def sample_metrics(self) -> dict[str, Any]:
        with self._lock:
            now_iso = _utc_now_iso()
            measurement = self._take_real_measurement()
            sample = {
                "timestamp": now_iso,
                "scope": "coordinator",
                "disk_free_gb": measurement["disk_free_gb"],
                "storage_growth_mb": measurement["storage_growth_mb"],
                "ram_mb": measurement["ram_mb"],
                "cpu_percent": measurement["cpu_percent"],
                "io_mb_s": measurement["io_mb_s"],
            }
            self._metric_samples.append(sample)
            try:
                hist_path = self._metrics_history_file()
                if hist_path.parent.is_dir():
                    atomic_json(hist_path, list(self._metric_samples))
            except Exception:
                pass
            return sample

    def get_events(self, limit: int = 100, level: str | None = None, job_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            items = list(self._events)
            if level:
                items = [e for e in items if e["level"] == level.upper()]
            if job_id:
                items = [e for e in items if e.get("job_id") == job_id]
            return items[-limit:]

    def get_metrics_trends(self) -> list[dict[str, Any]]:
        with self._lock:
            policy = self.get_retention_policy()
            interval = float(policy.get("disk_sample_interval_seconds", 5))
            need_sample = False
            if not self._metric_samples:
                need_sample = True
            else:
                last_ts = self._metric_samples[-1].get("timestamp")
                if last_ts:
                    try:
                        last_dt = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
                        now_dt = datetime.now(timezone.utc)
                        if (now_dt - last_dt).total_seconds() >= interval:
                            need_sample = True
                    except Exception:
                        need_sample = True
            if need_sample:
                try:
                    self.sample_metrics()
                except Exception:
                    pass
            return list(self._metric_samples)

    # -------------------------------------------------------------------------
    # Policy Management
    # -------------------------------------------------------------------------
    def get_retention_policy(self) -> dict[str, Any]:
        policy_path = self.storage / "index" / "retention-policy.json"
        if policy_path.exists():
            try:
                data = json.loads(policy_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return {**_DEFAULT_POLICY, **data}
            except Exception:
                pass
        return dict(_DEFAULT_POLICY)

    def set_retention_policy(self, updates: Mapping[str, Any]) -> dict[str, Any]:
        current = self.get_retention_policy()

        # Validate numeric ranges
        for num_key in (
            "ttl_success_hours",
            "ttl_failure_hours",
            "ttl_orphan_hours",
            "ttl_sources_hours",
            "ttl_logs_days",
            "min_artifacts_to_keep",
            "min_free_space_gib",
            "disk_sample_interval_seconds",
        ):
            if num_key in updates:
                try:
                    val = float(updates[num_key])
                    if val < 0 or not math.isfinite(val):
                        raise ValueError(f"{num_key} must be non-negative")
                    current[num_key] = int(val) if num_key in ("min_artifacts_to_keep", "ttl_logs_days", "disk_sample_interval_seconds") else val
                except (ValueError, TypeError):
                    pass

        for thresh_key in ("disk_warning_threshold_gib", "disk_critical_threshold_gib"):
            if thresh_key in updates:
                try:
                    val = float(updates[thresh_key])
                    if val <= 0 or not math.isfinite(val):
                        raise ValueError(f"{thresh_key} must be positive")
                    current[thresh_key] = val
                except (ValueError, TypeError):
                    pass

        if "mode" in updates:
            requested_mode = str(updates["mode"]).strip().lower()
            if requested_mode == "automatic":
                # Honest notification: automatic cleanup scheduler is not attached
                current["mode"] = "preview"
                current["requested_mode"] = "automatic"
                current["mode_status"] = "not_implemented"
                current["mode_notice"] = "Tryb automatyczny jest niedostępny (brak aktywnego wykonawcy w tle). Pozostawiono tryb preview."
                self.record_event("WARN", "policy_mode_rejected", "Automatic retention mode requested but rejected: scheduler not enabled, remaining in preview mode")
            elif requested_mode in ("preview", "dry-run"):
                current["mode"] = "preview"
                current["mode_status"] = "implemented"
                current.pop("mode_notice", None)

        current["updated_at"] = _utc_now_iso()
        policy_path = self.storage / "index" / "retention-policy.json"
        policy_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(policy_path, current)
        self._resources_cache = None
        self.record_event("INFO", "policy_updated", "Retention and storage policy updated by operator")
        return current

    # -------------------------------------------------------------------------
    # Resource Pinning
    # -------------------------------------------------------------------------
    def _pinned_path(self) -> Path:
        return self.storage / "index" / "pinned-resources.json"

    def get_pinned(self) -> dict[str, dict[str, Any]]:
        path = self._pinned_path()
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data
            except Exception:
                pass
        return {}

    def set_pinned(self, resource_id: str, pin: bool, reason: str = "") -> dict[str, Any]:
        with self._lock:
            pinned = self.get_pinned()
            if pin:
                pinned[resource_id] = {
                    "pinned": True,
                    "reason": reason or "Przypięte przez operatora",
                    "pinned_at": _utc_now_iso(),
                }
                self.record_event("INFO", "resource_pinned", f"Resource {resource_id} pinned: {reason}")
            else:
                pinned.pop(resource_id, None)
                self.record_event("INFO", "resource_unpinned", f"Resource {resource_id} unpinned")

            path = self._pinned_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            atomic_json(path, pinned)
            self._resources_cache = None
            return {"resource_id": resource_id, "pinned": pin, "reason": reason}

    # -------------------------------------------------------------------------
    # Storage Volumes & Resources Breakdown
    # -------------------------------------------------------------------------
    def get_storage_volumes(self) -> list[dict[str, Any]]:
        policy = self.get_retention_policy()
        warn_gib = float(policy.get("disk_warning_threshold_gib", 30))
        crit_gib = float(policy.get("disk_critical_threshold_gib", 10))
        min_free_gib = float(policy.get("min_free_space_gib", 8))

        volumes = []
        try:
            usage = shutil.disk_usage(self.storage)
            total = usage.total
            used = usage.used
            free = usage.free
            warning_threshold = max(int(0.15 * total), int(warn_gib * 1024 * 1024 * 1024))
            critical_threshold = max(int(0.05 * total), int(crit_gib * 1024 * 1024 * 1024))
            reserved_bytes = int(min_free_gib * 1024 * 1024 * 1024)
            status = "healthy"
            if free <= critical_threshold:
                status = "critical"
            elif free <= warning_threshold:
                status = "warning"
        except Exception:
            total = None
            used = None
            free = None
            warning_threshold = None
            critical_threshold = None
            reserved_bytes = None
            status = "unavailable"

        volumes.append({
            "id": "storage-root",
            "name": "Project Storage Root",
            "mount_point": str(self.storage),
            "filesystem": "local",
            "total_bytes": total,
            "used_bytes": used,
            "free_bytes": free,
            "reserved_bytes": reserved_bytes,
            "warning_threshold_bytes": warning_threshold,
            "critical_threshold_bytes": critical_threshold,
            "status": status,
            "measured_at": _utc_now_iso(),
        })

        # Probe Docker VM / host backing volume ONLY if a distinct path actually exists
        docker_path, docker_name, docker_fs = _probe_docker_root(self.storage)
        is_distinct = False
        try:
            if os.path.exists(docker_path):
                try:
                    is_distinct = not os.path.samefile(docker_path, str(self.storage))
                except (OSError, ValueError):
                    is_distinct = Path(docker_path).resolve() != self.storage.resolve()
        except Exception:
            is_distinct = False

        if is_distinct:
            try:
                d_usage = shutil.disk_usage(docker_path)
                d_total = d_usage.total
                d_used = d_usage.used
                d_free = d_usage.free
                d_warn = max(int(0.15 * d_total), int(warn_gib * 1024 * 1024 * 1024))
                d_crit = max(int(0.05 * d_total), int(crit_gib * 1024 * 1024 * 1024))
                d_status = "healthy"
                if d_free <= d_crit:
                    d_status = "critical"
                elif d_free <= d_warn:
                    d_status = "warning"
            except Exception:
                d_total = None
                d_used = None
                d_free = None
                d_warn = None
                d_crit = None
                d_status = "unavailable"

            volumes.append({
                "id": "docker-backing-vhdx",
                "name": docker_name,
                "mount_point": docker_path,
                "filesystem": docker_fs or "ext4",
                "total_bytes": d_total,
                "used_bytes": d_used,
                "free_bytes": d_free,
                "reserved_bytes": 0 if d_total else None,
                "warning_threshold_bytes": d_warn,
                "critical_threshold_bytes": d_crit,
                "status": d_status,
                "measured_at": _utc_now_iso(),
            })

        return volumes

    def get_storage_resources(self, queue=None) -> dict[str, Any]:
        """Aggregate categorized storage inventory with protection rationales."""
        now = time.time()
        if self._resources_cache and (now - self._resources_cache_time < 10.0) and queue is None:
            return self._resources_cache

        pinned = self.get_pinned()
        policy = self.get_retention_policy()
        ttl_success_h = float(policy.get("ttl_success_hours", 24))
        ttl_failure_h = float(policy.get("ttl_failure_hours", 168))

        raw_engine_plan = {}
        engine_candidates: dict[tuple[str, str], Mapping[str, Any]] = {}
        engine_retained: dict[tuple[str, str], Mapping[str, Any]] = {}
        if queue is not None:
            jobs = []
            try:
                if hasattr(queue, 'connection') and getattr(queue, 'path', None) and Path(queue.path).is_file():
                    with queue.connection() as db:
                        rows = db.execute("SELECT * FROM jobs ORDER BY sequence DESC").fetchall()
                        jobs = [queue.record(row) for row in rows]
                else:
                    jobs = queue.list(owner=self.owner, limit=1000)
            except Exception:
                jobs = []
            if jobs:
                try:
                    raw_engine_plan = retention_plan(
                        str(self.storage), jobs, now, success_hours=ttl_success_h, failed_hours=ttl_failure_h
                    )
                    for c in raw_engine_plan.get("candidates", []):
                        if c.get("worktree_id") and c.get("job_id"):
                            engine_candidates[(c["worktree_id"], c["job_id"])] = c
                    for r in raw_engine_plan.get("retained", []):
                        if r.get("worktree_id") and r.get("job_id"):
                            engine_retained[(r["worktree_id"], r["job_id"])] = r
                except Exception:
                    pass

        categories: dict[str, dict[str, Any]] = {
            "source_capsules": {"name": "Source Capsules", "logical_bytes": 0, "file_count": 0, "had_errors": False, "items": []},
            "execution": {"name": "Execution Trees", "logical_bytes": 0, "file_count": 0, "had_errors": False, "items": []},
            "build_targets": {"name": "Build Targets", "logical_bytes": 0, "file_count": 0, "had_errors": False, "items": []},
            "dependency_cache": {"name": "Dependency Cache", "logical_bytes": 0, "file_count": 0, "had_errors": False, "items": []},
            "artifacts": {"name": "Artifacts & Receipts", "logical_bytes": 0, "file_count": 0, "had_errors": False, "items": []},
            "logs": {"name": "Build Logs", "logical_bytes": 0, "file_count": 0, "had_errors": False, "items": []},
            "coordinator_data": {"name": "Coordinator Index & DB", "logical_bytes": 0, "file_count": 0, "had_errors": False, "items": []},
            "docker_resources": {"name": "Docker Layers", "logical_bytes": 0, "file_count": 0, "had_errors": False, "items": []},
            "unassigned": {"name": "Unassigned", "logical_bytes": 0, "file_count": 0, "had_errors": False, "items": []},
        }

        # Inspect runs directory
        runs_dir = self.storage / "runs"
        if runs_dir.is_dir():
            for wt_dir in runs_dir.iterdir():
                if not wt_dir.is_dir() or _is_reparse_or_symlink(wt_dir):
                    continue
                for run_item in wt_dir.iterdir():
                    if not run_item.is_dir() or _is_reparse_or_symlink(run_item):
                        continue
                    item_name = run_item.name
                    # Check subtrees: source, execution, artifacts
                    src_tree = run_item / "source"
                    if src_tree.is_dir() and not _is_reparse_or_symlink(src_tree):
                        size = _fast_dir_size(src_tree)
                        res_id = f"src-{wt_dir.name}-{item_name}"
                        is_pin = (res_id in pinned) or (item_name in pinned)
                        pin_info = pinned.get(res_id) or pinned.get(item_name) or {}
                        pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                        categories["source_capsules"]["logical_bytes"] += size[0]
                        categories["source_capsules"]["file_count"] += size[1]
                        if size[2]:
                            categories["source_capsules"]["had_errors"] = True
                        categories["source_capsules"]["items"].append({
                            "resource_id": res_id,
                            "name": f"{wt_dir.name}/{item_name}/source",
                            "category": "source_capsules",
                            "path": str(src_tree),
                            "size_bytes": size[0],
                            "file_count": size[1],
                            "pinned": is_pin,
                            "why_retained": pin_reason if is_pin else "Aktywny capture lub referencja zadania",
                            "eligible_for_retention": False,
                            "reclaimable_bytes": 0,
                            "had_errors": size[2],
                        })

                    exec_tree = run_item / "execution"
                    if exec_tree.is_dir() and not _is_reparse_or_symlink(exec_tree):
                        size = _fast_dir_size(exec_tree)
                        res_id = f"exec-{wt_dir.name}-{item_name}"
                        is_pin = (res_id in pinned) or (item_name in pinned)
                        pin_info = pinned.get(res_id) or pinned.get(item_name) or {}
                        pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                        categories["execution"]["logical_bytes"] += size[0]
                        categories["execution"]["file_count"] += size[1]
                        if size[2]:
                            categories["execution"]["had_errors"] = True

                        cand = engine_candidates.get((wt_dir.name, item_name))
                        ret = engine_retained.get((wt_dir.name, item_name))

                        if is_pin:
                            why = pin_reason
                            eligible = False
                        elif cand is not None:
                            why = f"Kwalifikuje się do retencji ({cand.get('reason', 'wygasła')})"
                            eligible = True
                        elif ret is not None:
                            why = f"Zachowane przez silnik ({ret.get('reason', 'chronione')})"
                            eligible = False
                        else:
                            why = "Niezweryfikowany lub osierocony katalog - ochrona przed usunięciem"
                            eligible = False

                        categories["execution"]["items"].append({
                            "resource_id": res_id,
                            "name": f"{wt_dir.name}/{item_name}/execution",
                            "category": "execution",
                            "path": str(exec_tree),
                            "size_bytes": size[0],
                            "file_count": size[1],
                            "pinned": is_pin,
                            "why_retained": why,
                            "eligible_for_retention": eligible,
                            "reclaimable_bytes": size[0] if eligible else 0,
                            "had_errors": size[2],
                        })

                    art_tree = run_item / "artifacts"
                    logs_dir = art_tree / "logs" if art_tree.is_dir() else None
                    worker_log = run_item / "worker.log"

                    # Catalog logs separately to avoid zero in categories["logs"]
                    log_bytes = 0
                    log_files = 0
                    log_paths = []
                    log_had_errors = False
                    if logs_dir and logs_dir.is_dir() and not _is_reparse_or_symlink(logs_dir):
                        ld_size = _fast_dir_size(logs_dir)
                        log_bytes += ld_size[0]
                        log_files += ld_size[1]
                        if ld_size[2]:
                            log_had_errors = True
                        log_paths.append(str(logs_dir))
                    if worker_log.is_file():
                        try:
                            w_bytes = worker_log.stat().st_size
                            log_bytes += w_bytes
                            log_files += 1
                            log_paths.append(str(worker_log))
                        except Exception:
                            log_had_errors = True

                    if log_bytes > 0 or log_files > 0:
                        res_id = f"log-{wt_dir.name}-{item_name}"
                        is_pin = (res_id in pinned) or (item_name in pinned)
                        pin_info = pinned.get(res_id) or pinned.get(item_name) or {}
                        pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                        categories["logs"]["logical_bytes"] += log_bytes
                        categories["logs"]["file_count"] += log_files
                        if log_had_errors:
                            categories["logs"]["had_errors"] = True
                        categories["logs"]["items"].append({
                            "resource_id": res_id,
                            "name": f"{wt_dir.name}/{item_name}/logs",
                            "category": "logs",
                            "path": "; ".join(log_paths),
                            "size_bytes": log_bytes,
                            "file_count": log_files,
                            "pinned": is_pin,
                            "why_retained": pin_reason if is_pin else "Dzienniki i logi etapów kompilacji",
                            "eligible_for_retention": False,
                            "reclaimable_bytes": 0,
                            "had_errors": log_had_errors,
                        })

                    if art_tree.is_dir() and not _is_reparse_or_symlink(art_tree):
                        total_art = _fast_dir_size(art_tree)
                        logs_in_art_bytes = _fast_dir_size(logs_dir)[0] if (logs_dir and logs_dir.is_dir()) else 0
                        logs_in_art_files = _fast_dir_size(logs_dir)[1] if (logs_dir and logs_dir.is_dir()) else 0
                        art_bytes = max(0, total_art[0] - logs_in_art_bytes)
                        art_files = max(0, total_art[1] - logs_in_art_files)

                        res_id = f"art-{wt_dir.name}-{item_name}"
                        is_pin = (res_id in pinned) or (item_name in pinned)
                        pin_info = pinned.get(res_id) or pinned.get(item_name) or {}
                        pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                        categories["artifacts"]["logical_bytes"] += art_bytes
                        categories["artifacts"]["file_count"] += art_files
                        if total_art[2]:
                            categories["artifacts"]["had_errors"] = True
                        categories["artifacts"]["items"].append({
                            "resource_id": res_id,
                            "name": f"{wt_dir.name}/{item_name}/artifacts",
                            "category": "artifacts",
                            "path": str(art_tree),
                            "size_bytes": art_bytes,
                            "file_count": art_files,
                            "pinned": is_pin,
                            "why_retained": pin_reason if is_pin else "Trwałe dowody builda i receipt",
                            "eligible_for_retention": False,
                            "reclaimable_bytes": 0,
                            "had_errors": total_art[2],
                        })

        # Inspect builds directory
        builds_dir = self.storage / "builds"
        if builds_dir.is_dir():
            for b_item in builds_dir.iterdir():
                if not b_item.is_dir() or _is_reparse_or_symlink(b_item):
                    continue
                subdirs = [p for p in b_item.iterdir() if p.is_dir() and not _is_reparse_or_symlink(p)]
                if subdirs:
                    for s_item in subdirs:
                        size = _fast_dir_size(s_item)
                        res_id = f"target-{b_item.name}-{s_item.name}"
                        is_pin = (res_id in pinned) or (b_item.name in pinned) or (s_item.name in pinned)
                        pin_info = pinned.get(res_id) or pinned.get(b_item.name) or {}
                        pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                        categories["build_targets"]["logical_bytes"] += size[0]
                        categories["build_targets"]["file_count"] += size[1]
                        if size[2]:
                            categories["build_targets"]["had_errors"] = True
                        categories["build_targets"]["items"].append({
                            "resource_id": res_id,
                            "name": f"{b_item.name}/{s_item.name}",
                            "category": "build_targets",
                            "path": str(s_item),
                            "size_bytes": size[0],
                            "file_count": size[1],
                            "pinned": is_pin,
                            "why_retained": pin_reason if is_pin else "Trwały build target worktree/profilu",
                            "eligible_for_retention": False,
                            "reclaimable_bytes": 0,
                            "had_errors": size[2],
                        })
                else:
                    size = _fast_dir_size(b_item)
                    res_id = f"target-{b_item.name}"
                    is_pin = (res_id in pinned) or (b_item.name in pinned)
                    pin_info = pinned.get(res_id) or pinned.get(b_item.name) or {}
                    pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                    categories["build_targets"]["logical_bytes"] += size[0]
                    categories["build_targets"]["file_count"] += size[1]
                    if size[2]:
                        categories["build_targets"]["had_errors"] = True
                    categories["build_targets"]["items"].append({
                        "resource_id": res_id,
                        "name": b_item.name,
                        "category": "build_targets",
                        "path": str(b_item),
                        "size_bytes": size[0],
                        "file_count": size[1],
                        "pinned": is_pin,
                        "why_retained": pin_reason if is_pin else "Trwały build target worktree/profilu",
                        "eligible_for_retention": False,
                        "reclaimable_bytes": 0,
                        "had_errors": size[2],
                    })

        # Inspect cache directory
        cache_dir = self.storage / "cache"
        if cache_dir.is_dir():
            for c_item in cache_dir.iterdir():
                if c_item.is_dir() and not _is_reparse_or_symlink(c_item):
                    size = _fast_dir_size(c_item)
                    res_id = f"cache-{c_item.name}"
                    is_pin = (res_id in pinned) or (c_item.name in pinned)
                    pin_info = pinned.get(res_id) or pinned.get(c_item.name) or {}
                    pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                    categories["dependency_cache"]["logical_bytes"] += size[0]
                    categories["dependency_cache"]["file_count"] += size[1]
                    if size[2]:
                        categories["dependency_cache"]["had_errors"] = True
                    categories["dependency_cache"]["items"].append({
                        "resource_id": res_id,
                        "name": c_item.name,
                        "category": "dependency_cache",
                        "path": str(c_item),
                        "size_bytes": size[0],
                        "file_count": size[1],
                        "pinned": is_pin,
                        "why_retained": pin_reason if is_pin else "Współdzielony cache zależności (Cargo/pnpm)",
                        "eligible_for_retention": False,
                        "reclaimable_bytes": 0,
                        "had_errors": size[2],
                    })

        # Inspect index and locks directories (coordinator SQLite, configs, locks)
        for dir_name, label, desc in (
            ("index", "index / runner-jobs.sqlite", "Kolejka SQLite i rejestr konfiguracji koordynatora"),
            ("locks", "locks / coordinator", "Blokady współbieżności i wykonawcy"),
        ):
            d_path = self.storage / dir_name
            if d_path.is_dir() and not _is_reparse_or_symlink(d_path):
                size = _fast_dir_size(d_path)
                categories["coordinator_data"]["logical_bytes"] += size[0]
                categories["coordinator_data"]["file_count"] += size[1]
                if size[2]:
                    categories["coordinator_data"]["had_errors"] = True
                categories["coordinator_data"]["items"].append({
                    "resource_id": f"coordinator-{dir_name}",
                    "name": label,
                    "category": "coordinator_data",
                    "path": str(d_path),
                    "size_bytes": size[0],
                    "file_count": size[1],
                    "pinned": True,
                    "why_retained": desc,
                    "eligible_for_retention": False,
                    "reclaimable_bytes": 0,
                    "had_errors": size[2],
                })

        # Scan unassigned root items
        known_roots = {"runs", "builds", "cache", "index", "locks"}
        if self.storage.is_dir():
            for root_child in self.storage.iterdir():
                if root_child.name not in known_roots and not _is_reparse_or_symlink(root_child):
                    if root_child.is_dir():
                        size = _fast_dir_size(root_child)
                        res_bytes, res_count, res_err = size[0], size[1], size[2]
                    else:
                        try:
                            res_bytes = root_child.stat().st_size
                            res_count = 1
                            res_err = False
                        except Exception:
                            res_bytes, res_count, res_err = 0, 0, True
                    categories["unassigned"]["logical_bytes"] += res_bytes
                    categories["unassigned"]["file_count"] += res_count
                    if res_err:
                        categories["unassigned"]["had_errors"] = True
                    categories["unassigned"]["items"].append({
                        "resource_id": f"unassigned-{root_child.name}",
                        "name": root_child.name,
                        "category": "unassigned",
                        "path": str(root_child),
                        "size_bytes": res_bytes,
                        "file_count": res_count,
                        "pinned": False,
                        "why_retained": "Nieskategoryzowany element katalogu głównego storage",
                        "eligible_for_retention": False,
                        "reclaimable_bytes": 0,
                        "had_errors": res_err,
                    })

        # Format breakdown summary
        summary = []
        all_items = []
        for cat_id, cat_data in categories.items():
            eligible_bytes = sum(i["reclaimable_bytes"] for i in cat_data["items"])
            comp = "partial" if cat_data["had_errors"] else "complete"
            summary.append({
                "category_id": cat_id,
                "name": cat_data["name"],
                "logical_bytes": cat_data["logical_bytes"],
                "file_count": cat_data["file_count"],
                "completeness": comp,
                "eligible_cleanup_bytes": eligible_bytes,
                "reclaimable_bytes": eligible_bytes,
                "items_count": len(cat_data["items"]),
            })
            all_items.extend(cat_data["items"])

        # Sort items descending by size
        all_items.sort(key=lambda x: x["size_bytes"], reverse=True)

        had_errors = any(s["completeness"] == "partial" for s in summary)
        completeness = "partial" if had_errors else "complete"

        result = {
            "categories": summary,
            "resources": all_items,
            "total_measured_bytes": sum(s["logical_bytes"] for s in summary),
            "total_reclaimable_bytes": sum(s["reclaimable_bytes"] for s in summary),
            "completeness": completeness,
            "had_errors": had_errors,
            "measured_at": _utc_now_iso(),
        }
        self._resources_cache = result
        self._resources_cache_time = now
        return result

    # -------------------------------------------------------------------------
    # Retention Planning
    # -------------------------------------------------------------------------
    def generate_retention_plan(self, queue=None) -> dict[str, Any]:
        with self._lock:
            jobs = []
            if queue is not None:
                try:
                    if hasattr(queue, 'connection') and getattr(queue, 'path', None) and Path(queue.path).is_file():
                        with queue.connection() as db:
                            rows = db.execute("SELECT * FROM jobs ORDER BY sequence DESC").fetchall()
                            jobs = [queue.record(row) for row in rows]
                    else:
                        jobs = queue.list(owner=self.owner, limit=1000)
                except Exception:
                    jobs = []

            policy = self.get_retention_policy()
            ttl_success_h = float(policy.get("ttl_success_hours", 24))
            ttl_failure_h = float(policy.get("ttl_failure_hours", 168))
            now = time.time()

            raw_plan = {}
            if jobs:
                try:
                    raw_plan = retention_plan(str(self.storage), jobs, now, success_hours=ttl_success_h, failed_hours=ttl_failure_h)
                except Exception as err:
                    raw_plan = {"error": str(err), "candidates": [], "retained": []}

            pinned = self.get_pinned()
            plan_id = f"plan-{uuid.uuid4().hex[:8]}"

            candidates = []
            pinned_retained = []
            for c in raw_plan.get("candidates", []):
                wt = c.get("worktree_id")
                jid = c.get("job_id")
                res_id = f"exec-{wt}-{jid}"
                if res_id in pinned or jid in pinned:
                    pin_info = pinned.get(res_id) or pinned.get(jid) or {}
                    pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                    pinned_retained.append({
                        "resource_id": res_id,
                        "name": f"{wt}/{jid}/execution",
                        "worktree_id": wt,
                        "job_id": jid,
                        "path": c.get("execution"),
                        "size_bytes": c.get("bytes", 0),
                        "why_retained": f"{pin_reason} (ochrona przed retencją)",
                    })
                    continue
                candidates.append({
                    "resource_id": res_id,
                    "name": f"{wt}/{jid}/execution",
                    "worktree_id": wt,
                    "job_id": jid,
                    "path": c.get("execution"),
                    "size_bytes": c.get("bytes", 0),
                    "reason": c.get("reason", "Upłynął okres retencji po zakończeniu zadania"),
                })

            retained = list(pinned_retained)
            for r in raw_plan.get("retained", []):
                wt = r.get("worktree_id")
                jid = r.get("job_id")
                res_id = f"exec-{wt}-{jid}"
                retained.append({
                    "resource_id": res_id,
                    "name": f"{wt}/{jid}/execution" if wt and jid else "unknown",
                    "worktree_id": wt,
                    "job_id": jid,
                    "path": r.get("execution"),
                    "size_bytes": r.get("bytes", 0) or 0,
                    "why_retained": r.get("reason", "Chronione przez silnik retencji"),
                })

            # Ensure all on-disk execution trees missing identity/journal or absent from raw_plan are protected
            accounted_identities = {
                (item.get("worktree_id"), item.get("job_id"))
                for item in candidates + retained
                if item.get("worktree_id") and item.get("job_id")
            }
            runs_dir = self.storage / "runs"
            if runs_dir.is_dir() and not _is_reparse_or_symlink(runs_dir):
                for wt_dir in sorted(runs_dir.iterdir()):
                    if not wt_dir.is_dir() or _is_reparse_or_symlink(wt_dir):
                        continue
                    for job_dir in sorted(wt_dir.iterdir()):
                        if not job_dir.is_dir() or _is_reparse_or_symlink(job_dir):
                            continue
                        ident = (wt_dir.name, job_dir.name)
                        if ident not in accounted_identities:
                            exec_dir = job_dir / "execution"
                            if exec_dir.is_dir() and not _is_reparse_or_symlink(exec_dir):
                                sz = _fast_dir_size(exec_dir)
                                retained.append({
                                    "resource_id": f"exec-{wt_dir.name}-{job_dir.name}",
                                    "name": f"{wt_dir.name}/{job_dir.name}/execution",
                                    "worktree_id": wt_dir.name,
                                    "job_id": job_dir.name,
                                    "path": str(exec_dir),
                                    "size_bytes": sz[0],
                                    "why_retained": "Niezweryfikowany lub osierocony katalog - ochrona przed usunięciem",
                                })
                                accounted_identities.add(ident)

            volumes = self.get_storage_volumes()
            free_before = volumes[0]["free_bytes"] if volumes and volumes[0]["free_bytes"] is not None else 0
            estimated_reclaim = sum(c["size_bytes"] for c in candidates)

            plan_record = {
                "plan_id": plan_id,
                "created_at": _utc_now_iso(),
                "policy_version": self.get_retention_policy()["version"],
                "status": "preview",
                "candidates_count": len(candidates),
                "candidates": candidates,
                "retained_count": len(retained),
                "retained": retained,
                "estimated_reclaimed_bytes": estimated_reclaim,
                "disk_free_before_bytes": free_before,
                "disk_free_after_estimated_bytes": free_before + estimated_reclaim,
                "raw_engine_plan": raw_plan,
            }
            self._plans[plan_id] = plan_record
            self.record_event("INFO", "retention_plan_created", f"Created retention plan {plan_id} ({len(candidates)} candidates)")
            return plan_record

    def apply_retention_plan(self, plan_id: str) -> dict[str, Any]:
        """Idempotent and safe plan execution. Never removes unverified or shared data."""
        with self._lock:
            plan = self._plans.get(plan_id)
            if not plan:
                return {
                    "applied": False,
                    "plan_id": plan_id,
                    "status": "preview_only",
                    "error": "Plan not found or expired",
                    "reclaimed_bytes": 0,
                }

            self.record_event(
                "WARN",
                "retention_plan_preview_only",
                f"Retention plan {plan_id} requested for apply, but cleanup executor is not enabled. Kept in preview_only status.",
            )
            plan["status"] = "preview_only"
            plan["applied"] = False
            plan["actual_reclaimed_bytes"] = 0
            return {
                "applied": False,
                "plan_id": plan_id,
                "status": "preview_only",
                "error": "cleanup_executor_not_enabled",
                "reclaimed_bytes": 0,
                "message": "Operacja w trybie podglądu (preview_only): wykonawca automatycznego usuwania nie jest włączony (cleanup_executor_not_enabled).",
            }


def _fast_dir_size(path: Path) -> tuple[int, int, bool]:
    """Calculate directory size in bytes and file count with safe traversal."""
    total_bytes = 0
    count = 0
    had_errors = False

    def on_walk_error(err: OSError) -> None:
        nonlocal had_errors
        had_errors = True

    try:
        if _is_reparse_or_symlink(path):
            return 0, 0, True
        for root, dirs, files in os.walk(path, onerror=on_walk_error):
            pruned_dirs = []
            for d in dirs:
                full_d = Path(root) / d
                if _is_reparse_or_symlink(full_d):
                    had_errors = True
                else:
                    pruned_dirs.append(d)
            dirs[:] = pruned_dirs

            for file_name in files:
                try:
                    p = Path(root) / file_name
                    if _is_reparse_or_symlink(p):
                        had_errors = True
                        continue
                    stat_info = os.lstat(p)
                    total_bytes += stat_info.st_size
                    count += 1
                except (OSError, FileNotFoundError, PermissionError):
                    had_errors = True
    except (OSError, FileNotFoundError, PermissionError):
        had_errors = True
    return total_bytes, count, had_errors


def build_job_timeline(job: Mapping[str, Any], storage_root: Path | str) -> list[dict[str, Any]]:
    """Construct multi-stage timeline representation of a build job with honest status."""
    created_at = job.get("created_at")
    started_at = job.get("started_at")
    updated_at = job.get("updated_at")
    state = job.get("state", "unknown")
    exit_code = job.get("exit_code")

    stages = [
        {"id": "queued", "name": "Kolejka (Queued)", "status": "succeeded", "started_at": created_at, "duration_seconds": None},
        {"id": "prepare", "name": "Przygotowanie (Source & Mounts)", "status": "pending", "started_at": None, "duration_seconds": None},
        {"id": "native-build", "name": "Kompilacja natywna (Rust/CLI)", "status": "pending", "started_at": None, "duration_seconds": None},
        {"id": "frontend-dependencies", "name": "Zależności frontendu (pnpm)", "status": "pending", "started_at": None, "duration_seconds": None},
        {"id": "frontend-build", "name": "Kompilacja frontendu (Next/Vite)", "status": "pending", "started_at": None, "duration_seconds": None},
        {"id": "receipt-verification", "name": "Weryfikacja receipt i hashy", "status": "pending", "started_at": None, "duration_seconds": None},
        {"id": "result", "name": "Wynik końcowy", "status": "pending", "started_at": None, "duration_seconds": None},
    ]

    if state == "queued":
        stages[0]["status"] = "running"
        return stages

    stages[0]["status"] = "succeeded"

    storage = Path(storage_root)
    worktree_id = job.get("worktree_id", "")
    job_id = job.get("job_id", "")
    job_dir = storage / "runs" / worktree_id / job_id if worktree_id and job_id else None

    journal = {}
    receipt_data = None
    worker_log_text = ""

    if job_dir and job_dir.exists():
        coord_file = job_dir / "coordinator.json"
        if coord_file.is_file():
            try:
                journal = json.loads(coord_file.read_text(encoding="utf-8"))
            except Exception:
                journal = {}

        for r_path in (
            job_dir / "artifacts" / "build-receipt.json",
            job_dir / "artifacts" / "receipt.json",
            job_dir / "receipt.json",
        ):
            if r_path.is_file():
                try:
                    loaded = json.loads(r_path.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        receipt_data = loaded
                        break
                except Exception:
                    pass

        worker_log_file = job_dir / "worker.log"
        if worker_log_file.is_file():
            try:
                worker_log_text = worker_log_file.read_text(encoding="utf-8")
            except Exception:
                worker_log_text = ""

    if not started_at and journal.get("started_at"):
        started_at = journal["started_at"]

    # Stage 1: prepare
    stages[1]["status"] = "succeeded"
    stages[1]["started_at"] = started_at or created_at
    if started_at and created_at and isinstance(started_at, (int, float)) and isinstance(created_at, (int, float)):
        stages[0]["duration_seconds"] = max(0.0, round(started_at - created_at, 2))

    # Case A: We have a valid build receipt with recorded stages
    if receipt_data and isinstance(receipt_data.get("stages"), list) and receipt_data["stages"]:
        stage_map = {
            "native-build": 2,
            "frontend-dependencies": 3,
            "frontend-build": 4,
        }
        for st_info in receipt_data["stages"]:
            s_name = st_info.get("name")
            if s_name in stage_map:
                idx = stage_map[s_name]
                s_code = st_info.get("exit_code")
                stages[idx]["status"] = "succeeded" if s_code == 0 else "failed"
                stages[idx]["started_at"] = st_info.get("started_at")
                stages[idx]["exit_code"] = s_code
                dur_ms = st_info.get("duration_ms")
                if dur_ms is not None:
                    stages[idx]["duration_seconds"] = round(dur_ms / 1000.0, 2)

        # Stage 5: receipt-verification
        if receipt_data.get("state") == "succeeded" and all(s.get("exit_code") == 0 for s in receipt_data["stages"]):
            stages[5]["status"] = "succeeded"
            stages[5]["started_at"] = receipt_data.get("finished_at")
        else:
            stages[5]["status"] = "failed" if state == "failed" else "cancelled"

        # Stage 6: result
        stages[6]["status"] = state if state in ("succeeded", "failed", "cancelled") else "succeeded"
        stages[6]["exit_code"] = exit_code if exit_code is not None else (0 if stages[6]["status"] == "succeeded" else 1)
        return stages

    # Case B: No complete build receipt yet (job is running or ended abnormally)
    logs_dir = job_dir / "artifacts" / "logs" if job_dir else None

    stage_prefixes = [
        (2, "native-build"),
        (3, "frontend-dependencies"),
        (4, "frontend-build"),
    ]

    has_stage_log = {}
    if logs_dir and logs_dir.is_dir():
        for idx, prefix in stage_prefixes:
            out_f = logs_dir / f"{prefix}.stdout.log"
            err_f = logs_dir / f"{prefix}.stderr.log"
            has_stage_log[prefix] = out_f.exists() or err_f.exists()
    else:
        for _, prefix in stage_prefixes:
            has_stage_log[prefix] = False

    stage_ended = {}
    if worker_log_text:
        for _, prefix in stage_prefixes:
            end_match = re.search(rf"\[fullmag runner\] stage {re.escape(prefix)} end exit_code=(\d+)", worker_log_text)
            if end_match:
                code = int(end_match.group(1))
                stage_ended[prefix] = code

    if state == "running":
        if started_at:
            stages[1]["status"] = "succeeded"
            if stage_ended:
                for idx, prefix in stage_prefixes:
                    if prefix in stage_ended:
                        code = stage_ended[prefix]
                        stages[idx]["status"] = "succeeded" if code == 0 else "failed"
                        stages[idx]["exit_code"] = code
                    else:
                        stages[idx]["status"] = "running"
                        break
                else:
                    stages[5]["status"] = "running"
            else:
                if has_stage_log.get("frontend-build"):
                    stages[2]["status"] = "succeeded"
                    stages[3]["status"] = "succeeded"
                    stages[4]["status"] = "running"
                elif has_stage_log.get("frontend-dependencies"):
                    stages[2]["status"] = "succeeded"
                    stages[3]["status"] = "running"
                else:
                    stages[2]["status"] = "running"
        else:
            stages[1]["status"] = "running"
    elif state == "succeeded":
        for s in stages:
            s["status"] = "succeeded"
        stages[6]["exit_code"] = 0
    elif state in ("failed", "cancelled"):
        if stage_ended:
            for idx, prefix in stage_prefixes:
                if prefix in stage_ended:
                    code = stage_ended[prefix]
                    stages[idx]["status"] = "succeeded" if code == 0 else "failed"
                    stages[idx]["exit_code"] = code
                elif stages[idx - 1]["status"] == "succeeded":
                    stages[idx]["status"] = state
                    break
        else:
            if has_stage_log.get("frontend-build"):
                stages[2]["status"] = "succeeded"
                stages[3]["status"] = "succeeded"
                stages[4]["status"] = state
            elif has_stage_log.get("frontend-dependencies"):
                stages[2]["status"] = "succeeded"
                stages[3]["status"] = state
            elif has_stage_log.get("native-build"):
                stages[2]["status"] = state
            else:
                stages[1]["status"] = state
        stages[5]["status"] = "failed" if state == "failed" else "cancelled"
        stages[6]["status"] = state
        stages[6]["exit_code"] = exit_code

    return stages
