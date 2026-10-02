"""Replay recorded modal metrics from actual hash-bound native fields.

This checks the chosen edges, not candidate-cluster selection or the global
assignment optimum. A metric pass therefore retains NOT VERIFIED overall.
"""
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from comsol_tracking_fields import load_tracking_fields
from comsol_tracking_assignment import maximum_weight_assignment
from comsol_tracking_clusters import frequency_group_candidates
from verify_fem_frequency_domain_eigen_artifacts import validate_tracking_edge_provenance


METRIC_TOLERANCE = 1e-9  # Roundtrip algebra, not a physics acceptance budget.


def _number(value, label):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f"{label} must be finite numeric")
    return float(value)


def _close(actual, expected, label, *, relative=False):
    expected = _number(expected, label)
    tolerance = METRIC_TOLERANCE * (max(1., abs(actual), abs(expected)) if relative else 1.)
    if not math.isfinite(actual) or abs(actual - expected) > tolerance:
        raise ValueError(f"{label} differs from field replay: {expected} vs {actual}")


def _frequency_score(previous, current, window):
    delta = abs(previous - current)
    if window is not None:
        window = _number(window, "frequency_window_hz")
        if window <= 0:
            raise ValueError("frequency_window_hz must be positive")
        return max(0., 1. - delta / window)
    return 1. / (1. + delta / max(abs(previous), abs(current), 1.))


def spectrum_candidate_selections(samples):
    """Inventory every exported candidate, without inferring solver completeness."""
    selections = []
    seen_samples = set()
    for sample in samples:
        identity = sample["sample_index"]
        if type(identity) is not int or identity < 0 or identity in seen_samples:
            raise ValueError("invalid candidate sample ID")
        seen_samples.add(identity)
        seen_raw = set()
        for mode in sample["modes"]:
            raw = mode["raw_mode_index"]
            if type(raw) is not int or raw < 0 or raw in seen_raw:
                raise ValueError("invalid or duplicate candidate raw ID")
            seen_raw.add(raw)
            selections.append((identity, raw))
    if not selections:
        raise ValueError("empty spectrum candidate inventory")
    return selections


def bind_candidate_fields(samples, modes):
    """Bind unselected candidates as strictly as selected tracking endpoints."""
    for sample in samples:
        k = sample["k_vector"]
        if not isinstance(k, list) or len(k) != 3 or any(
            type(value) not in (int, float) or not math.isfinite(value) for value in k
        ):
            raise ValueError("invalid candidate signed k vector")
        for mode in sample["modes"]:
            field = modes[(sample["sample_index"], mode["raw_mode_index"])]
            if _number(mode["frequency_real_hz"], "candidate spectrum frequency") <= 0:
                raise ValueError("candidate spectrum frequency must be positive")
            if not np.allclose(field["k_vector_rad_per_m"], k, rtol=1e-12, atol=1e-10):
                raise ValueError("candidate field signed k differs from spectrum")
            for name in ("frequency_real_hz", "frequency_imag_hz"):
                _close(_number(mode[name], "candidate spectrum frequency"), field[name],
                       f"candidate field {name}", relative=True)


def replay_recorded_frames(metric, modes, branches, samples, *, candidate_branch_ids=None):
    """Reconstruct every chosen frame/metric; inputs already bound by caller.

    All dependent cluster branches must be present over the full path. Raw
    assignments are retained as recorded, never inferred from frequency sort.
    """
    order = [sample["sample_index"] for sample in samples]
    if not order or any(type(s) is not int or s < 0 for s in order) or len(set(order)) != len(order):
        raise ValueError("invalid spectrum sample order")
    try:
        validate_tracking_edge_provenance(branches, order)
    except SystemExit as error:
        raise ValueError(f"invalid tracking provenance: {error}") from error
    if branches.get("tracking_policy_availability") != "complete":
        raise ValueError("complete recorded tracking policy required")
    by_branch = {}
    for branch in branches["branches"]:
        identity = branch["branch_id"]
        if identity in by_branch:
            raise ValueError("duplicate branch ID")
        points = {point["sample_index"]: point for point in branch["points"]}
        if set(points) != set(order):
            raise ValueError("dependent tracking branch is incomplete")
        by_branch[identity] = points
    if not by_branch:
        raise ValueError("no tracked branches to replay")
    frequencies = {}
    for sample in samples:
        if not isinstance(sample["k_vector"], list) or any(
            type(value) not in (int, float) for value in sample["k_vector"]
        ):
            raise ValueError("spectrum k must contain real numeric components")
        k = np.asarray(sample["k_vector"], dtype=float)
        if k.shape != (3,) or not np.all(np.isfinite(k)):
            raise ValueError("invalid spectrum k vector")
        if any(type(mode["raw_mode_index"]) is not int or mode["raw_mode_index"] < 0
               for mode in sample["modes"]):
            raise ValueError("invalid spectrum raw mode ID")
        raw_modes = {mode["raw_mode_index"]: mode for mode in sample["modes"]}
        if len(raw_modes) != len(sample["modes"]):
            raise ValueError("duplicate spectrum raw mode")
        used = set()
        for identity, points in by_branch.items():
            point = points[sample["sample_index"]]
            raw = point["raw_mode_index"]
            key = (sample["sample_index"], raw)
            if raw in used or raw not in raw_modes or key not in modes:
                raise ValueError("duplicate or missing tracking endpoint")
            used.add(raw)
            field = modes[key]
            if not np.allclose(field["k_vector_rad_per_m"], k, rtol=1e-12, atol=1e-10):
                raise ValueError("field signed k differs from spectrum")
            real = _number(raw_modes[raw]["frequency_real_hz"], "spectrum frequency")
            imag = _number(raw_modes[raw]["frequency_imag_hz"], "spectrum imaginary frequency")
            if real <= 0:
                raise ValueError("tracked spectrum frequency must be positive")
            for name, frequency in (("frequency_real_hz", real), ("frequency_imag_hz", imag)):
                _close(frequency, field[name], f"field {name}", relative=True)
                _close(frequency, point[name], f"branch {name}", relative=True)
            frequencies[(identity, sample["sample_index"])] = real
    frames = {}
    records = []
    sample_by_id = {item["sample_index"]: item for item in samples}
    if candidate_branch_ids is None:
        candidate_branch_ids = {(sample_id, point["raw_mode_index"]): branch_id
                                for branch_id, points in by_branch.items() for sample_id, point in points.items()}
    for position, sample in enumerate(order):
        next_frames = {}
        processed = set()
        for identity, points in by_branch.items():
            if identity in processed:
                continue
            point = points[sample]
            edge = point["tracking_edge"]
            field = modes[(sample, point["raw_mode_index"])]["envelope"]
            if position == 0:
                if edge["transition"] != "seed":
                    raise ValueError("initial frame requires a seed")
                metric.normalized(field)
                _close(1., point["tracking_confidence"], "seed confidence")
                next_frames[identity] = field
                processed.add(identity)
                continue
            previous = order[position - 1]
            if edge["previous_sample_index"] != previous or edge["skipped_sample_count"] != 0:
                raise ValueError("replay requires adjacent path edges")
            if edge["metric"] != "consistent_p1_tet4_cartesian_nodal_envelope":
                raise ValueError("replay requires consistent P1 mass")
            floor = edge["policy"]["overlap_floor"]
            window = edge["policy"]["frequency_window_hz"]
            if edge["transition"] == "pair":
                overlap = metric.overlap(frames[identity], field)
                _close(overlap, point["overlap_prev"], "pair overlap")
                if overlap + METRIC_TOLERANCE < floor:
                    raise ValueError("replayed overlap violates policy floor")
                frequency = _frequency_score(frequencies[(identity, previous)], frequencies[(identity, sample)], window)
                score = .85 * overlap + .15 * frequency
                _close(score, point["tracking_confidence"], "pair confidence")
                next_frames[identity] = field
                processed.add(identity)
                records.append(dict(sample_index=sample, branch_ids=[identity], overlap=overlap, score=score))
                continue
            subspace = edge["subspace"]
            ids = subspace["branch_ids"]
            if any(branch not in by_branch or branch in processed for branch in ids):
                raise ValueError("missing or overlapping subspace branch dependency")
            current_raw = subspace["current_raw_mode_indices"]
            for slot, branch in enumerate(ids):
                current_point = by_branch[branch][sample]
                current_edge = current_point["tracking_edge"]
                if current_edge["subspace"] != subspace or current_edge["transition"] != edge["transition"] \
                        or current_edge["previous_sample_index"] != previous \
                        or current_edge["metric"] != "consistent_p1_tet4_cartesian_nodal_envelope":
                    raise ValueError("inconsistent participant subspace records")
                if by_branch[branch][previous]["raw_mode_index"] != subspace["previous_raw_mode_indices"][slot]:
                    raise ValueError("subspace previous raw ID differs from branch")
            if set(current_raw) != {by_branch[branch][sample]["raw_mode_index"] for branch in ids}:
                raise ValueError("subspace current raw IDs differ from assigned branches")
            previous_entries = []
            for mode in sample_by_id[previous]["modes"]:
                key = (previous, mode["raw_mode_index"])
                if key not in candidate_branch_ids:
                    raise ValueError("missing candidate branch provenance")
                previous_entries.append((candidate_branch_ids[key], mode["frequency_real_hz"], mode["frequency_imag_hz"]))
            current_modes = sample_by_id[sample]["modes"]
            current_entries = [(slot, mode["frequency_real_hz"], mode["frequency_imag_hz"])
                               for slot, mode in enumerate(current_modes)]
            candidates = frequency_group_candidates(previous_entries, current_entries, window)
            if not any(candidate["previous_cluster"] == subspace["previous_cluster"]
                       and candidate["current_cluster"] == subspace["current_cluster"]
                       and candidate["transition"] == edge["transition"]
                       and set(candidate["previous_ids"]) == set(ids)
                       and {current_modes[slot]["raw_mode_index"] for slot in candidate["current_ids"]} == set(current_raw)
                       for candidate in candidates):
                raise ValueError("recorded subspace is not a frequency group candidate")
            cosines, transported, weights = metric.transport_with_assignment_weights([frames[branch] for branch in ids],
                [modes[(sample, raw)]["envelope"] for raw in current_raw])
            optimal_assignment, optimal_weight = maximum_weight_assignment(weights)
            recorded_assignment = [current_raw.index(by_branch[branch][sample]["raw_mode_index"]) for branch in ids]
            recorded_weight = float(weights[np.arange(len(ids)), recorded_assignment].sum())
            if (optimal_weight - recorded_weight) / len(ids) > METRIC_TOLERANCE:
                raise ValueError("subspace raw assignment is not an optimum of the replayed rotation")
            stored_cosines = sorted(subspace["principal_cosines"])
            for measured, stored in zip(cosines, stored_cosines, strict=True):
                _close(float(measured), stored, "principal cosine")
            _close(float(cosines[0]), subspace["principal_minimum"], "principal minimum")
            if cosines[0] + METRIC_TOLERANCE < floor:
                raise ValueError("replayed principal minimum violates policy floor")
            previous_center = sum(frequencies[(branch, previous)] for branch in ids) / len(ids)
            current_center = sum(frequencies[(branch, sample)] for branch in ids) / len(ids)
            score = .85 * float(cosines[0]) + .15 * _frequency_score(previous_center, current_center, window)
            for branch, frame in zip(ids, transported, strict=True):
                _close(score, by_branch[branch][sample]["tracking_confidence"], "subspace confidence")
                next_frames[branch] = frame
                processed.add(branch)
            records.append(dict(sample_index=sample, branch_ids=ids, principal_cosines=cosines.tolist(), score=score,
                frequency_group_candidate=dict(status="pass", candidate_count=len(candidates)),
                subspace_raw_assignment=dict(status="pass", recorded_columns=recorded_assignment,
                    optimal_columns=optimal_assignment, current_raw_mode_indices=current_raw,
                    recorded_raw_mode_indices=[current_raw[column] for column in recorded_assignment],
                    optimal_raw_mode_indices=[current_raw[column] for column in optimal_assignment],
                    recorded_mean_weight=recorded_weight / len(ids),
                    optimal_mean_weight=optimal_weight / len(ids), equivalent_optimum=recorded_assignment != optimal_assignment)))
        frames = next_frames
    return {"status": "pass", "sample_count": len(order), "branch_count": len(by_branch),
            "replayed_edges": records,
            "frequency_group_candidates_replay": "pass" if any("frequency_group_candidate" in record for record in records) else "not_applicable",
            "subspace_raw_assignment_replay": "pass" if any("subspace_raw_assignment" in record for record in records) else "not_applicable",
            "assignment_replay": "NOT VERIFIED", "qualification": "NOT VERIFIED"}


def replay_tracking_fields(case_dir, *, selected_branch_ids=None, expected_hashes=None):
    """Execute metric replay from disk; never trust a precomputed JSON verdict."""
    root = Path(case_dir)
    report = {"status": "missing", "qualification": "NOT VERIFIED", "reasons": []}
    try:
        inputs = {}
        hashes = []
        for relative in ("eigen/spectrum.v2.json", "eigen/branches.v2.json"):
            path = root / relative
            for candidate in (path, *path.parents):
                if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
                    raise ValueError("tracking control input is a link")
                if candidate == root:
                    break
            data = path.read_bytes()
            inputs[relative] = json.loads(data)
            hashes.append({"path": relative, "sha256": "sha256:" + hashlib.sha256(data).hexdigest()})
        spectrum = inputs["eigen/spectrum.v2.json"]
        branches = inputs["eigen/branches.v2.json"]
        candidate_branch_ids = {}
        for branch in branches["branches"]:
            for point in branch["points"]:
                key = (point["sample_index"], point["raw_mode_index"])
                if key in candidate_branch_ids:
                    raise ValueError("duplicate candidate branch provenance")
                candidate_branch_ids[key] = branch["branch_id"]
        try:
            validate_tracking_edge_provenance(branches, [sample["sample_index"] for sample in spectrum["samples"]])
        except SystemExit as error:
            raise ValueError(f"invalid tracking provenance: {error}") from error
        if selected_branch_ids is not None:
            all_branches = {branch["branch_id"]: branch for branch in branches["branches"]}
            selected = set(selected_branch_ids)
            pending = list(selected)
            while pending:
                branch = all_branches[pending.pop()]
                for point in branch["points"]:
                    edge = point.get("tracking_edge")
                    if not isinstance(edge, dict):
                        raise ValueError("missing tracking edge")
                    subspace = edge.get("subspace")
                    for dependency in subspace["branch_ids"] if subspace else []:
                        if dependency not in selected:
                            selected.add(dependency)
                            pending.append(dependency)
            branches = {**branches, "branches": [branch for branch in branches["branches"] if branch["branch_id"] in selected]}
        selections = spectrum_candidate_selections(spectrum["samples"])
        for sample, raw in selections:
            for relative in (f"eigen/modes/sample_{sample:04d}/mode_{raw:04d}.json",
                             f"eigen/mode_fields/sample_{sample:04d}/mode_{raw:04d}/vector.bin"):
                if not (root / relative).is_file():
                    raise FileNotFoundError(f"tracking field payload missing: {relative}")
        fields = load_tracking_fields(root, selections)
        bind_candidate_fields(spectrum["samples"], fields["modes"])
        bound_hashes = hashes + fields["file_hashes"]
        if expected_hashes is not None:
            measured = {item["path"]: item["sha256"] for item in bound_hashes}
            for relative, expected in expected_hashes.items():
                if measured.get(relative) != expected:
                    raise ValueError(f"tracking replay input differs from gate-bound artifact: {relative}")
        report = replay_recorded_frames(fields["metric"], fields["modes"], branches, spectrum["samples"],
                                        candidate_branch_ids=candidate_branch_ids)
        report.update(file_hashes=bound_hashes, reasons=[],
            candidate_field_coverage={"status": "pass", "exported_candidate_count": len(selections),
                                      "solver_spectral_completeness": "NOT VERIFIED"})
    except (OSError, ValueError, TypeError, KeyError, IndexError, OverflowError, AttributeError) as error:
        report["reasons"] = [str(error)]
        # Missing fields fail closed without pretending the replay executed.
        report["status"] = "missing" if isinstance(error, OSError) else "fail"
    return report
