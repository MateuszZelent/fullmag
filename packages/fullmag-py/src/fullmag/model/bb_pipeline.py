"""Validate the nonexecuted carrier for an explicitly BB-only pipeline."""
from collections.abc import Mapping


def is_gpu_bb_only_pipeline(value: object) -> bool:
    if (not isinstance(value, Mapping) or set(value) - {"version", "nodes"}
            or not isinstance(value.get("version"), str)
            or value.get("version") not in {"study_pipeline.v1", "study_pipeline.v2"}):
        return False
    seen = set()
    enabled_bb = 0

    def visit(nodes, parent_enabled=True, depth=0):
        nonlocal enabled_bb
        if not isinstance(nodes, list) or depth > 64:
            return False
        for node in nodes:
            if not isinstance(node, Mapping):
                return False
            kind = node.get("node_kind")
            common = {"node_kind", "id", "label", "enabled", "notes", "source"}
            allowed = common | ({"stage_kind", "payload"} if kind == "primitive" else {"children", "collapsed"})
            identity = node.get("id")
            if (not isinstance(kind, str) or kind not in {"primitive", "group"} or set(node) - allowed
                    or not isinstance(identity, str) or not identity.strip() or identity in seen
                    or len(seen) >= 4096 or not isinstance(node.get("label"), str)
                    or not isinstance(node.get("enabled", True), bool)
                    or any(node.get(key) is not None and not isinstance(node[key], str) for key in ("notes", "source"))):
                return False
            seen.add(identity)
            enabled = parent_enabled and node.get("enabled", True)
            if kind == "group":
                if not isinstance(node.get("collapsed", False), bool) or not visit(node.get("children", []), enabled, depth + 1):
                    return False
            else:
                payload = node.get("payload", {})
                if not isinstance(node.get("stage_kind"), str) or not isinstance(payload, Mapping):
                    return False
                if enabled:
                    algorithms = [payload[key] for key in ("algorithm", "relax_algorithm") if key in payload]
                    if (node["stage_kind"] != "relax" or not algorithms
                            or any(algorithm != "projected_gradient_bb" for algorithm in algorithms)
                            or ("kind" in payload and payload["kind"] != "relax")
                            or ("entrypoint_kind" in payload and payload["entrypoint_kind"] not in ("flat_relax", "study_pipeline_relax", "build"))
                            or ("enabled" in payload and payload["enabled"] is not True)):
                        return False
                    enabled_bb += 1
        return True

    return visit(value.get("nodes")) and enabled_bb > 0
