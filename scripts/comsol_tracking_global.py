"""Independent reconstruction of cluster selection and modal edge assignment."""
import math

import numpy as np

from comsol_tracking_assignment import maximum_weight_assignment
from comsol_tracking_clusters import frequency_clusters, frequency_group_candidates


def _select_edges(edges, mode_count, method):
    if method == "overlap_greedy":
        selected, rows, columns = [], set(), set()
        for edge in sorted(edges, key=lambda edge: (-edge["score"], edge["branch_id"], edge["mode_slot"])):
            if edge["branch_id"] not in rows and edge["mode_slot"] not in columns:
                selected.append(edge)
                rows.add(edge["branch_id"])
                columns.add(edge["mode_slot"])
        return selected
    row_ids = sorted({edge["branch_id"] for edge in edges})
    if not row_ids:
        return []
    by_pair = {(edge["branch_id"], edge["mode_slot"]): edge for edge in edges}
    size = len(row_ids) + mode_count
    # Native costs are1(dummy),2(ineligible),1-score(eligible).
    # (2-cost)/2 is an equivalent weight in[0,1] for a fixed square matching.
    weights = np.full((size, size), .5)
    weights[:len(row_ids), :mode_count] = 0.
    for row, identity in enumerate(row_ids):
        for column in range(mode_count):
            edge = by_pair.get((identity, column))
            if edge is not None:
                weights[row, column] = .5 + .5 * edge["score"]
    assignment, _ = maximum_weight_assignment(weights)
    return [by_pair[(identity, assignment[row])] for row, identity in enumerate(row_ids)
            if assignment[row] < mode_count and (identity, assignment[row]) in by_pair]


def reconstruct_global_assignment(metric, frames, previous, current, policy, frequency_score, *, allow_subspaces=True):
    """Compute producer-policy predictions, without qualifying recorded artifacts.

    Previous records are(branch ID,real Hz,imag Hz); current records retain
    native spectrum order and carry raw_mode_index/frequencies/envelope.
    All previous frames must be supplied; there is no frequency-only fallback.
    """
    floor, window, method = policy["overlap_floor"], policy["frequency_window_hz"], policy["method"]
    if type(floor) not in (int, float) or not math.isfinite(floor) or not 0 <= floor <= 1:
        raise ValueError("global overlap floor must be finite in[0,1]")
    if method not in {"overlap_greedy", "overlap_hungarian"}:
        raise ValueError("unsupported global assignment method")
    raw_ids = [mode["raw_mode_index"] for mode in current]
    if any(type(raw) is not int or raw < 0 for raw in raw_ids) or len(set(raw_ids)) != len(raw_ids):
        raise ValueError("invalid or duplicate global candidate raw ID")
    current_entries = [(slot, mode["frequency_real_hz"], mode["frequency_imag_hz"])
                       for slot, mode in enumerate(current)]
    # Native tracking disables all subspace transport when eligible branches
    # retain frames from different physical samples; pair matching still runs.
    groups = frequency_group_candidates(previous, current_entries, window) if allow_subspaces else []
    if any(identity not in frames for identity, _, _ in previous):
        raise ValueError("missing previous candidate frame")
    for identity, _, _ in previous:
        metric.normalized(frames[identity])
    for mode in current:
        metric.normalized(mode["envelope"])
    previous_by_id = {identity: real for identity, real, _ in previous}
    candidates = []
    for group in groups:
        ids, slots = group["previous_ids"], group["current_ids"]
        try:
            cosines, transported, weights = metric.transport_with_assignment_weights(
                [frames[identity] for identity in ids], [current[slot]["envelope"] for slot in slots])
        except ValueError:
            # Native transport rejects a dependent basis, leaving pair edges.
            continue
        if cosines[0] < floor:
            continue
        left = sum(previous_by_id[identity] for identity in ids) / len(ids)
        right = sum(current[slot]["frequency_real_hz"] for slot in slots) / len(slots)
        score = .85 * float(cosines[0]) + .15 * frequency_score(left, right, window)
        assignment, _ = maximum_weight_assignment(weights)
        candidates.append({**group, "score": min(1., max(0., score)),
            "assignments": assignment, "frames": transported})
    left_count, right_count = len(frequency_clusters(previous)), len(frequency_clusters(current_entries))
    selected_groups = []
    if candidates:
        best = {}
        size = left_count + right_count
        weights = np.zeros((size, size))
        for candidate in candidates:
            pair = candidate["previous_cluster"], candidate["current_cluster"]
            if pair not in best or candidate["score"] > best[pair]["score"]:
                best[pair] = candidate
                weights[pair] = candidate["score"]
        assignment, _ = maximum_weight_assignment(weights)
        used_rows, used_columns = set(), set()
        for row, column in enumerate(assignment[:left_count]):
            candidate = best.get((row, column))
            if candidate is None:
                continue
            if used_rows.intersection(candidate["previous_ids"]) or used_columns.intersection(candidate["current_ids"]):
                continue
            selected_groups.append(candidate)
            used_rows.update(candidate["previous_ids"])
            used_columns.update(candidate["current_ids"])
    edges, excluded_rows, excluded_columns, next_frames = [], set(), set(), {}
    for group in selected_groups:
        for row, column in enumerate(group["assignments"]):
            identity, slot = group["previous_ids"][row], group["current_ids"][column]
            edges.append(dict(branch_id=identity, mode_slot=slot, score=group["score"], group=group))
            excluded_rows.add(identity)
            excluded_columns.add(slot)
            next_frames[identity] = group["frames"][row]
    for identity, real, _ in previous:
        if identity in excluded_rows:
            continue
        for slot, mode in enumerate(current):
            if slot in excluded_columns:
                continue
            overlap = metric.overlap(frames[identity], mode["envelope"])
            if overlap >= floor:
                score = .85 * overlap + .15 * frequency_score(real, mode["frequency_real_hz"], window)
                edges.append(dict(branch_id=identity, mode_slot=slot, score=min(1., max(0., score)), group=None))
    matches = _select_edges(edges, len(current), method)
    predicted = {}
    for edge in matches:
        identity, slot = edge["branch_id"], edge["mode_slot"]
        predicted[identity] = {**edge, "raw_mode_index": current[slot]["raw_mode_index"]}
        if edge["group"] is None:
            next_frames[identity] = current[slot]["envelope"]
    return {"matches": predicted, "selected_groups": selected_groups,
            "candidate_count": len(candidates),
            "next_frames": {identity: next_frames[identity] for identity in predicted},
            "qualification": "NOT VERIFIED"}
