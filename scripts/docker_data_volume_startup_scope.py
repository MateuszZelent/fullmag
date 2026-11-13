"""Short-lived pending-marker read capability for standard DEV startup.

This capability proves only that the exact group has a live, retained managed
admission preparation. It does not admit a namespace, authorize execution, or
resolve the pending marker through a registration.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
import hashlib
import importlib
import os
from pathlib import Path
import sys
import threading
from types import MappingProxyType

import fullmag_data_volume_guard as guard
import fullmag_data_volume_pending as pending_module
import linux_data_volume_provision as qualification


_ACTIVE = ContextVar("fullmag_data_volume_startup_scope", default=None)
_MAX_EVIDENCE_BYTES = 4 * 1024 * 1024
_ISSUER_NAMES = frozenset((
    "docker_dev_data_volume_admission",
    "scripts.docker_dev_data_volume_admission",
))


def _require(condition, message):
    qualification.require(condition, message)


def _source_path(value, filename):
    source = Path(value["context"]["source"])
    return source / "scripts" / filename


def _resolve_issuer(prepared):
    name = type(prepared).__module__
    _require(name in _ISSUER_NAMES, "The original prepared admission issuer is required")
    issuer = sys.modules.get(name)
    expected = Path(__file__).with_name("docker_dev_data_volume_admission.py").resolve()
    _require(issuer is not None and type(prepared) is getattr(issuer, "_PreparedGroup", None) and
             Path(getattr(issuer, "__file__", "")).resolve() == expected and
             callable(getattr(issuer, "require_prepared_group", None)),
             "Prepared admission object did not come from its real local issuer")
    return issuer


def _require_prepared(prepared, expected_issuer=None):
    issuer = _resolve_issuer(prepared)
    _require(expected_issuer is None or issuer is expected_issuer,
             "Prepared admission issuer changed during the startup scope")
    _require(issuer.require_prepared_group(prepared) is prepared,
             "Prepared admission group is no longer live")
    _require(isinstance(prepared, dict) and
             set(prepared) == {"context", "bound_terminal", "terminal", "relocated", "native_before"},
             "Closed live prepared admission group required")
    return issuer


def _admission_job(issuer, prepared):
    module_name = (issuer.__package__ + ".docker_data_volume_admission_job"
                   if issuer.__package__ else "docker_data_volume_admission_job")
    module = sys.modules.get(module_name)
    if module is None:
        module = importlib.import_module(module_name)
    _require(Path(getattr(module, "__file__", "")).resolve() ==
             _source_path(prepared, "docker_data_volume_admission_job.py").resolve() and
             callable(getattr(module, "validate_terminal", None)),
             "Admission terminal validator differs from the selected checkout")
    return module


def _pin_terminal(prepared, issuer):
    """Re-authenticate the successful immutable admission terminal and pins."""
    context = prepared["context"]
    terminal = prepared["terminal"]
    _require(type(context) is dict and type(terminal) is dict and
             terminal.get("state") == "admission-prepared-not-admitted" and
             type(terminal.get("result")) is dict and
             type(terminal["result"].get("request_sha256")) is str,
             "Exact successful admission preparation is required")
    request_sha = terminal["result"]["request_sha256"]
    operation_root = Path(context["operation_root"])
    job = _admission_job(issuer, prepared)
    raw, request = job.qualification._read(operation_root / "linux-admission-request.json", request_sha)
    _require(hashlib.sha256(raw).hexdigest() == request_sha,
             "Admission request bytes differ from the prepared terminal")
    journal_path, _journal = job.qualification._selected_journal(operation_root)
    paths = {
        "request": operation_root / "linux-admission-request.json",
        "started": operation_root / "linux-admission-started.json",
        "result": operation_root / "linux-admission-result.json",
        "journal": Path(journal_path),
    }
    pins = {}
    for name, path in paths.items():
        content = guard._read_optional_regular(
            path, "immutable admission " + name, maximum=_MAX_EVIDENCE_BYTES
        )
        _require(content is not None, "Immutable admission evidence is missing: " + name)
        pins[name] = hashlib.sha256(content).hexdigest()
    _require(pins["request"] == request_sha and pins["result"] == terminal.get("receipt_sha256"),
             "Admission request/result bytes differ from the prepared terminal pins")
    failure_path = operation_root / "linux-admission-failed.json"
    _require(not os.path.lexists(failure_path),
             "Admission failure artifact conflicts with the prepared terminal")
    verified = job.validate_terminal(
        operation_root,
        request,
        request_sha,
        0,
        expected_before=prepared["native_before"],
    )
    _require(verified == terminal,
             "Prepared admission differs from its revalidated terminal and native snapshot")
    for name, path in paths.items():
        content = guard._read_optional_regular(
            path, "immutable admission " + name, maximum=_MAX_EVIDENCE_BYTES
        )
        _require(content is not None and hashlib.sha256(content).hexdigest() == pins[name],
                 "Admission evidence changed while revalidating its terminal: " + name)
    _require(not os.path.lexists(failure_path),
             "Admission failure artifact appeared while revalidating its terminal")
    return job, MappingProxyType(paths), MappingProxyType(pins), failure_path


class _Lease:
    __slots__ = ("active",)

    def __init__(self):
        self.active = True


class _StartupScope:
    __slots__ = ("_prepared", "_issuer", "_pid", "_thread", "_layout",
                 "_job", "_paths", "_pins", "_failure_path", "_lease", "_sealed")

    def __init__(self, prepared, issuer, layout, job, paths, pins, failure_path):
        object.__setattr__(self, "_prepared", prepared)
        object.__setattr__(self, "_issuer", issuer)
        object.__setattr__(self, "_pid", os.getpid())
        object.__setattr__(self, "_thread", threading.get_ident())
        object.__setattr__(self, "_layout", deepcopy(layout))
        object.__setattr__(self, "_job", job)
        object.__setattr__(self, "_paths", paths)
        object.__setattr__(self, "_pins", pins)
        object.__setattr__(self, "_failure_path", failure_path)
        object.__setattr__(self, "_lease", _Lease())
        object.__setattr__(self, "_sealed", True)

    def __setattr__(self, _name, _value):
        raise AttributeError("startup scopes are immutable")


def _check_scope(scope, *, recheck_evidence=True):
    _require(type(scope) is _StartupScope and _ACTIVE.get() is scope,
             "The exact active startup-scope object is required")
    _require(scope._lease.active is True and scope._pid == os.getpid() and
             scope._thread == threading.get_ident(),
             "Startup scope expired or crossed its process/thread boundary")
    issuer = _require_prepared(scope._prepared, scope._issuer)
    _require(issuer is scope._issuer and
             scope._prepared["context"].get("layout") == scope._layout,
             "Prepared startup group changed its selected layout")
    if recheck_evidence:
        for name, path in scope._paths.items():
            raw = guard._read_optional_regular(
                path, "immutable admission " + name, maximum=_MAX_EVIDENCE_BYTES
            )
            _require(raw is not None and hashlib.sha256(raw).hexdigest() == scope._pins[name],
                     "Immutable admission evidence changed: " + name)
        _require(not os.path.lexists(scope._failure_path),
                 "Admission failure artifact appeared after preparation")
    return scope


@contextmanager
def startup_scope(prepared):
    """Temporarily expose an exact live preparation to the pending guard."""
    _require(_ACTIVE.get() is None, "Nested startup scopes are not permitted")
    issuer = _require_prepared(prepared)
    _require(type(prepared.get("native_before")) is dict,
             "The retained pre-root native snapshot is required")
    context = prepared["context"]
    _require(type(context) is dict and type(context.get("layout")) is dict,
             "Prepared admission lacks its exact selected layout")
    job, paths, pins, failure_path = _pin_terminal(prepared, issuer)
    scope = _StartupScope(prepared, issuer, context["layout"], job, paths, pins, failure_path)
    token = _ACTIVE.set(scope)
    try:
        _check_scope(scope)
        yield scope
    except BaseException:
        raise
    else:
        _check_scope(scope)
    finally:
        scope._lease.active = False
        _ACTIVE.reset(token)


def current_scope():
    """Return the current valid scope, or None only when none is active."""
    scope = _ACTIVE.get()
    if scope is None:
        return None
    return _check_scope(scope)


def _canonical_optional_path(value, expected, label):
    if value is None:
        return
    actual = guard._absolute_path(value, label)
    _require(str(actual) == expected, label + " differs from the exact migrated root")


def verify_pending(scope, layout, compose_project, pending, *, state_root=None, user_data_root=None):
    """Verify the retained pending marker for this exact active group only."""
    _check_scope(scope)
    prepared = scope._prepared
    context = prepared["context"]
    _require(type(layout) is dict and layout == scope._layout and
             layout == context["layout"],
             "Pending marker layout differs from the selected prepared group")
    identity = context.get("identity")
    _require(type(identity) is dict and compose_project == identity.get("project_name"),
             "Pending marker Compose project differs from the selected group")

    result = prepared["terminal"]["result"]
    marker_ref = result.get("pending_marker")
    _require(type(marker_ref) is dict and set(marker_ref) == {"path", "sha256"} and
             type(marker_ref.get("path")) is str and type(marker_ref.get("sha256")) is str,
             "Prepared admission lacks its exact pending-marker reference")
    path = pending_module.pending_path(layout)
    _require(marker_ref["path"] == str(path),
             "Pending marker path differs from the prepared terminal")
    raw = guard._read_optional_regular(path, "prepared pending marker",
                                       maximum=pending_module.MAX_BYTES)
    _require(raw is not None and hashlib.sha256(raw).hexdigest() == marker_ref["sha256"],
             "Prepared pending marker is missing or changed")
    observed = pending_module.validate_pending(
        guard._parse_object(raw, "prepared pending marker"), layout, compose_project
    )
    supplied = pending_module.validate_pending(pending, layout, compose_project)
    _require(supplied == observed,
             "Supplied pending marker differs from its exact no-follow disk record")

    bind_result = prepared["bound_terminal"].get("result")
    _require(type(bind_result) is dict and type(bind_result.get("switch")) is dict and
             type(bind_result["switch"].get("roots")) is dict,
             "Prepared bind terminal lacks exact switched roots")
    roots = bind_result["switch"]["roots"]
    _require(set(roots) == {"state", "user_data"} and
             observed["state_root"] == roots["state"].get("canonical_root") and
             observed["user_data_root"] == roots["user_data"].get("canonical_root"),
             "Pending roots differ from the exact migrated canonical roots")
    _canonical_optional_path(state_root, observed["state_root"], "state_root")
    _canonical_optional_path(user_data_root, observed["user_data_root"], "user_data_root")
    raw_after = guard._read_optional_regular(path, "prepared pending marker",
                                             maximum=pending_module.MAX_BYTES)
    _require(raw_after == raw, "Pending marker changed while it was being verified")
    _check_scope(scope)
    return {
        "state": "pending-prepared-not-registered",
        "pending": observed,
        "pending_path": str(path),
        "pending_sha256": marker_ref["sha256"],
        "namespace_admitted": False,
        "data_migrated": False,
        "originals_retired": False,
    }
