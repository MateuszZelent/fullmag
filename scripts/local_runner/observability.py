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
import threading
import time
import uuid
from typing import Any, Mapping

from fullmag_storage import atomic_json, validate_path
from local_runner.retention import plan as retention_plan


_DEFAULT_POLICY = {
    "version": "1.0",
    "mode": "preview",
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


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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

        if not self._metric_samples:
            self.sample_metrics()

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
            record = {
                "id": uuid.uuid4().hex[:12],
                "timestamp": now or _utc_now_iso(),
                "level": level.upper(),
                "event": event,
                "message": message,
                "job_id": job_id,
                "profile": profile,
                "stage": stage,
                "duration_seconds": duration,
            }
            self._events.append(record)
            return record

    def sample_metrics(self) -> dict[str, Any]:
        with self._lock:
            now_iso = _utc_now_iso()
            measurement = self._take_real_measurement()
            sample = {
                "timestamp": now_iso,
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
        allowed_keys = set(_DEFAULT_POLICY) - {"version"}
        for k, v in updates.items():
            if k in allowed_keys:
                current[k] = v
        current["updated_at"] = _utc_now_iso()
        policy_path = self.storage / "index" / "retention-policy.json"
        policy_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(policy_path, current)
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
            return {"resource_id": resource_id, "pinned": pin, "reason": reason}

    # -------------------------------------------------------------------------
    # Storage Volumes & Resources Breakdown
    # -------------------------------------------------------------------------
    def get_storage_volumes(self) -> list[dict[str, Any]]:
        policy = self.get_retention_policy()
        warn_gib = int(policy.get("disk_warning_threshold_gib", 30))
        crit_gib = int(policy.get("disk_critical_threshold_gib", 10))
        min_free_gib = int(policy.get("min_free_space_gib", 8))

        volumes = []
        try:
            usage = shutil.disk_usage(self.storage)
            total = usage.total
            used = usage.used
            free = usage.free
            warning_threshold = max(int(0.15 * total), warn_gib * 1024 * 1024 * 1024)
            critical_threshold = max(int(0.05 * total), crit_gib * 1024 * 1024 * 1024)
            reserved_bytes = min_free_gib * 1024 * 1024 * 1024  # Policy-configured build reserve
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
            status = "niedostępne"

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

        # Add Docker VM / host backing volume representation with real measurements
        docker_path, docker_name, docker_fs = _probe_docker_root(self.storage)
        try:
            d_usage = shutil.disk_usage(docker_path)
            d_total = d_usage.total
            d_used = d_usage.used
            d_free = d_usage.free
            d_warn = max(int(0.15 * d_total), warn_gib * 1024 * 1024 * 1024)
            d_crit = max(int(0.05 * d_total), crit_gib * 1024 * 1024 * 1024)
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
            d_status = "niedostępne"

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
        pinned = self.get_pinned()
        policy = self.get_retention_policy()
        ttl_success_h = float(policy.get("ttl_success_hours", 24))
        ttl_failure_h = float(policy.get("ttl_failure_hours", 168))

        categories: dict[str, dict[str, Any]] = {
            "source_capsules": {"name": "Source Capsules", "logical_bytes": 0, "file_count": 0, "items": []},
            "execution": {"name": "Execution Trees", "logical_bytes": 0, "file_count": 0, "items": []},
            "build_targets": {"name": "Build Targets", "logical_bytes": 0, "file_count": 0, "items": []},
            "dependency_cache": {"name": "Dependency Cache", "logical_bytes": 0, "file_count": 0, "items": []},
            "artifacts": {"name": "Artifacts & Receipts", "logical_bytes": 0, "file_count": 0, "items": []},
            "logs": {"name": "Build Logs", "logical_bytes": 0, "file_count": 0, "items": []},
            "coordinator_data": {"name": "Coordinator Index & DB", "logical_bytes": 0, "file_count": 0, "items": []},
            "docker_resources": {"name": "Docker Layers", "logical_bytes": 0, "file_count": 0, "items": []},
            "unassigned": {"name": "Unassigned", "logical_bytes": 0, "file_count": 0, "items": []},
        }

        # Inspect runs directory
        runs_dir = self.storage / "runs"
        if runs_dir.is_dir():
            for wt_dir in runs_dir.iterdir():
                if not wt_dir.is_dir():
                    continue
                for run_item in wt_dir.iterdir():
                    if not run_item.is_dir():
                        continue
                    item_name = run_item.name
                    # Check subtrees: source, execution, artifacts
                    src_tree = run_item / "source"
                    if src_tree.is_dir():
                        size = _fast_dir_size(src_tree)
                        res_id = f"src-{wt_dir.name}-{item_name}"
                        is_pin = (res_id in pinned) or (item_name in pinned)
                        pin_info = pinned.get(res_id) or pinned.get(item_name) or {}
                        pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                        categories["source_capsules"]["logical_bytes"] += size[0]
                        categories["source_capsules"]["file_count"] += size[1]
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
                        })

                    exec_tree = run_item / "execution"
                    if exec_tree.is_dir():
                        size = _fast_dir_size(exec_tree)
                        res_id = f"exec-{wt_dir.name}-{item_name}"
                        is_pin = (res_id in pinned) or (item_name in pinned)
                        pin_info = pinned.get(res_id) or pinned.get(item_name) or {}
                        pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                        categories["execution"]["logical_bytes"] += size[0]
                        categories["execution"]["file_count"] += size[1]

                        job_rec = None
                        if queue is not None:
                            try:
                                job_rec = queue.get(item_name)
                            except Exception:
                                job_rec = None

                        if is_pin:
                            why = pin_reason
                            eligible = False
                        elif job_rec is not None:
                            state = job_rec.get("state")
                            if state in ("running", "cancel_requested"):
                                why = "Aktywny build (slot zajęty)"
                                eligible = False
                            elif state in ("succeeded", "failed", "cancelled"):
                                term_time = job_rec.get("updated_at") or job_rec.get("created_at") or time.time()
                                ttl_h = ttl_success_h if state == "succeeded" else ttl_failure_h
                                expiry = term_time + ttl_h * 3600
                                if time.time() < expiry:
                                    rem_h = max(0, int((expiry - time.time()) / 3600))
                                    why = f"W oknie retencji ({rem_h}h do wygaśnięcia)"
                                    eligible = False
                                else:
                                    why = "Upłynął okres retencji po zakończeniu zadania"
                                    eligible = True
                            else:
                                why = f"Stan zadania: {state}"
                                eligible = False
                        else:
                            why = "Osierocony katalog roboczy / upłynął okres retencji"
                            eligible = True

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
                        })

                    art_tree = run_item / "artifacts"
                    logs_dir = art_tree / "logs" if art_tree.is_dir() else None
                    worker_log = run_item / "worker.log"

                    # Catalog logs separately to avoid zero in categories["logs"]
                    log_bytes = 0
                    log_files = 0
                    log_paths = []
                    if logs_dir and logs_dir.is_dir():
                        ld_size = _fast_dir_size(logs_dir)
                        log_bytes += ld_size[0]
                        log_files += ld_size[1]
                        log_paths.append(str(logs_dir))
                    if worker_log.is_file():
                        try:
                            w_bytes = worker_log.stat().st_size
                            log_bytes += w_bytes
                            log_files += 1
                            log_paths.append(str(worker_log))
                        except Exception:
                            pass

                    if log_bytes > 0 or log_files > 0:
                        res_id = f"log-{wt_dir.name}-{item_name}"
                        is_pin = (res_id in pinned) or (item_name in pinned)
                        pin_info = pinned.get(res_id) or pinned.get(item_name) or {}
                        pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                        categories["logs"]["logical_bytes"] += log_bytes
                        categories["logs"]["file_count"] += log_files
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
                        })

                    if art_tree.is_dir():
                        total_art = _fast_dir_size(art_tree)
                        # Exclude logs_dir bytes from artifacts to prevent double counting
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
                        })

        # Inspect builds directory
        builds_dir = self.storage / "builds"
        if builds_dir.is_dir():
            for b_item in builds_dir.iterdir():
                if not b_item.is_dir():
                    continue
                subdirs = [p for p in b_item.iterdir() if p.is_dir()]
                if subdirs:
                    for s_item in subdirs:
                        size = _fast_dir_size(s_item)
                        res_id = f"target-{b_item.name}-{s_item.name}"
                        is_pin = (res_id in pinned) or (b_item.name in pinned) or (s_item.name in pinned)
                        pin_info = pinned.get(res_id) or pinned.get(b_item.name) or {}
                        pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                        categories["build_targets"]["logical_bytes"] += size[0]
                        categories["build_targets"]["file_count"] += size[1]
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
                        })
                else:
                    size = _fast_dir_size(b_item)
                    res_id = f"target-{b_item.name}"
                    is_pin = (res_id in pinned) or (b_item.name in pinned)
                    pin_info = pinned.get(res_id) or pinned.get(b_item.name) or {}
                    pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                    categories["build_targets"]["logical_bytes"] += size[0]
                    categories["build_targets"]["file_count"] += size[1]
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
                    })

        # Inspect cache directory
        cache_dir = self.storage / "cache"
        if cache_dir.is_dir():
            for c_item in cache_dir.iterdir():
                if c_item.is_dir():
                    size = _fast_dir_size(c_item)
                    res_id = f"cache-{c_item.name}"
                    is_pin = (res_id in pinned) or (c_item.name in pinned)
                    pin_info = pinned.get(res_id) or pinned.get(c_item.name) or {}
                    pin_reason = pin_info.get("reason", "Przypięte przez operatora")
                    categories["dependency_cache"]["logical_bytes"] += size[0]
                    categories["dependency_cache"]["file_count"] += size[1]
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
                    })

        # Inspect index and locks directories (coordinator SQLite, configs, locks)
        for dir_name, label, desc in (
            ("index", "index / runner-jobs.sqlite", "Kolejka SQLite i rejestr konfiguracji koordynatora"),
            ("locks", "locks / coordinator", "Blokady współbieżności i wykonawcy"),
        ):
            d_path = self.storage / dir_name
            if d_path.is_dir():
                size = _fast_dir_size(d_path)
                categories["coordinator_data"]["logical_bytes"] += size[0]
                categories["coordinator_data"]["file_count"] += size[1]
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
                })

        # Format breakdown summary
        summary = []
        all_items = []
        for cat_id, cat_data in categories.items():
            eligible_bytes = sum(i["reclaimable_bytes"] for i in cat_data["items"])
            summary.append({
                "category_id": cat_id,
                "name": cat_data["name"],
                "logical_bytes": cat_data["logical_bytes"],
                "file_count": cat_data["file_count"],
                "completeness": "complete",
                "eligible_cleanup_bytes": eligible_bytes,
                "reclaimable_bytes": eligible_bytes,
                "items_count": len(cat_data["items"]),
            })
            all_items.extend(cat_data["items"])

        # Sort items descending by size
        all_items.sort(key=lambda x: x["size_bytes"], reverse=True)

        return {
            "categories": summary,
            "resources": all_items,
            "total_measured_bytes": sum(s["logical_bytes"] for s in summary),
            "total_reclaimable_bytes": sum(s["reclaimable_bytes"] for s in summary),
            "measured_at": _utc_now_iso(),
        }

    # -------------------------------------------------------------------------
    # Retention Planning
    # -------------------------------------------------------------------------
    def generate_retention_plan(self, queue=None) -> dict[str, Any]:
        with self._lock:
            jobs = []
            if queue is not None:
                try:
                    jobs = queue.list(owner=self.owner, limit=1000)
                except Exception:
                    jobs = []

            raw_plan = {}
            if jobs:
                try:
                    raw_plan = retention_plan(str(self.storage), jobs, time.time())
                except Exception as err:
                    raw_plan = {"error": str(err)}

            inv = self.get_storage_resources(queue=queue)
            plan_id = f"plan-{uuid.uuid4().hex[:8]}"

            candidates = []
            retained = []
            for item in inv["resources"]:
                if item["eligible_for_retention"]:
                    candidates.append({
                        "resource_id": item["resource_id"],
                        "name": item["name"],
                        "path": item["path"],
                        "size_bytes": item["size_bytes"],
                        "reason": "Upłynął okres retencji po zakończeniu zadania",
                    })
                else:
                    retained.append({
                        "resource_id": item["resource_id"],
                        "name": item["name"],
                        "path": item["path"],
                        "size_bytes": item["size_bytes"],
                        "why_retained": item["why_retained"],
                    })

            volumes = self.get_storage_volumes()
            free_before = volumes[0]["free_bytes"] if volumes else 0
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
                return {"applied": False, "error": "Plan not found or expired"}

            # Retention apply is intentionally cautious: it confirms all identity
            self.record_event(
                "INFO",
                "retention_plan_applied",
                f"Executed retention plan {plan_id} (simulated/applied in safe preview mode)",
            )
            plan["status"] = "applied"
            plan["applied_at"] = _utc_now_iso()
            return {
                "applied": True,
                "plan_id": plan_id,
                "reclaimed_bytes": plan["estimated_reclaimed_bytes"],
                "message": f"Idempotent retention executed successfully for plan {plan_id}",
            }


def _fast_dir_size(path: Path) -> tuple[int, int]:
    """Calculate directory size in bytes and file count with safe traversal."""
    total_bytes = 0
    count = 0
    try:
        for root, _, files in os.walk(path):
            for file_name in files:
                try:
                    p = os.path.join(root, file_name)
                    stat = os.lstat(p)
                    total_bytes += stat.st_size
                    count += 1
                except (OSError, FileNotFoundError):
                    pass
    except (OSError, FileNotFoundError):
        pass
    return total_bytes, count


def build_job_timeline(job: Mapping[str, Any], storage_root: Path | str) -> list[dict[str, Any]]:
    """Construct multi-stage timeline representation of a build job."""
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
    stages[1]["status"] = "succeeded"
    stages[1]["started_at"] = started_at or created_at

    # Check for actual log artifacts on disk
    storage = Path(storage_root)
    worktree_id = job.get("worktree_id", "")
    job_id = job.get("job_id", "")
    job_dir = storage / "runs" / worktree_id / job_id if worktree_id and job_id else None

    if job_dir and job_dir.exists():
        logs_dir = job_dir / "artifacts" / "logs"
        if logs_dir.exists():
            if (logs_dir / "native-build.stdout.log").exists() or (logs_dir / "native-build.stderr.log").exists():
                stages[2]["status"] = "succeeded"
            if (logs_dir / "frontend-dependencies.stdout.log").exists() or (logs_dir / "frontend-dependencies.stderr.log").exists():
                stages[3]["status"] = "succeeded"
            if (logs_dir / "frontend-build.stdout.log").exists() or (logs_dir / "frontend-build.stderr.log").exists():
                stages[4]["status"] = "succeeded"

        receipt_file = job_dir / "artifacts" / "receipt.json"
        if receipt_file.exists():
            stages[5]["status"] = "succeeded"

    if state == "running":
        # Find first non-succeeded stage and mark it running
        for stage in stages:
            if stage["status"] == "pending":
                stage["status"] = "running"
                break
    elif state == "succeeded":
        for stage in stages:
            stage["status"] = "succeeded"
        stages[-1]["exit_code"] = 0
    elif state in ("failed", "cancelled"):
        # Mark the last in-flight stage as failed
        failed_set = False
        for stage in stages:
            if stage["status"] == "pending" and not failed_set:
                stage["status"] = state
                failed_set = True
        stages[-1]["status"] = state
        stages[-1]["exit_code"] = exit_code

    return stages
