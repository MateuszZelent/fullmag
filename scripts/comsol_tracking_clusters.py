"""Independent replay of the producer's frequency-cluster candidate policy."""
import math


DEGENERACY_ABSOLUTE_HZ = 1e-6
DEGENERACY_RELATIVE = 1e-4
SINGLETON_BOUNDARY_RELATIVE = 1e-12


def frequency_clusters(entries):
    """Return entry slots grouped against their first frequency anchor."""
    identities = set()
    for identity, real, imag in entries:
        if type(identity) is not int or identity < 0 or identity in identities:
            raise ValueError("invalid or duplicate cluster identity")
        identities.add(identity)
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in (real, imag)):
            raise ValueError("cluster frequency must be finite numeric")
        if real <= 0:
            raise ValueError("cluster frequency must be positive")
    order = sorted(range(len(entries)), key=lambda slot: (entries[slot][1], entries[slot][2], entries[slot][0]))
    clusters = []
    for slot in order:
        if clusters:
            _, ar, ai = entries[clusters[-1][0]]
            _, br, bi = entries[slot]
            distance = math.hypot(ar - br, ai - bi)
            scale = max(math.hypot(ar, ai), math.hypot(br, bi), 1.)
            if math.isfinite(distance) and distance <= DEGENERACY_ABSOLUTE_HZ + DEGENERACY_RELATIVE * scale:
                clusters[-1].append(slot)
                continue
        clusters.append([slot])
    return clusters


def _center(entries, slots):
    return tuple(sum(entries[slot][axis] for slot in slots) / len(slots) for axis in (1, 2))


def _nearest_singletons(entries, clusters, center, rank, window):
    eligible = []
    for cluster in clusters:
        if len(cluster) != 1:
            continue
        slot = cluster[0]
        _, real, imag = entries[slot]
        if window is not None and abs(real - center[0]) >= window:
            continue
        distance = math.hypot(real - center[0], imag - center[1])
        if math.isfinite(distance):
            eligible.append((distance, slot))
    eligible.sort(key=lambda pair: (pair[0], entries[pair[1]][0]))
    if len(eligible) < rank:
        return None
    boundary = eligible[rank - 1][0]
    if len(eligible) > rank:
        following = eligible[rank][0]
        if abs(following - boundary) <= SINGLETON_BOUNDARY_RELATIVE * max(abs(following), abs(boundary), 1.):
            return None
    return [slot for _, slot in eligible[:rank]]


def frequency_group_candidates(previous, current, window=None):
    """Enumerate frequency-legal groups; mass floor/global selection still follow."""
    if window is not None and (type(window) not in (int, float) or not math.isfinite(window) or window <= 0):
        raise ValueError("cluster frequency window must be finite positive")
    left, right = frequency_clusters(previous), frequency_clusters(current)
    candidates = []

    def add(pi, ci, transition, pslots, cslots):
        pcenter, ccenter = _center(previous, pslots), _center(current, cslots)
        if not all(math.isfinite(value) for value in (*pcenter, *ccenter)):
            return
        # Equal-rank degenerate groups remain candidates even at frequency
        # score zero: the principal-angle floor, not frequency, controls them.
        candidates.append(dict(previous_cluster=pi, current_cluster=ci,
            transition=transition, previous_ids=[previous[slot][0] for slot in pslots],
            current_ids=[current[slot][0] for slot in cslots]))

    for pi, pg in enumerate(left):
        for ci, cg in enumerate(right):
            if len(pg) >= 2 and len(pg) == len(cg):
                add(pi, ci, "degenerate_to_degenerate", pg, cg)
    for ci, cg in enumerate(right):
        if len(cg) >= 2:
            pg = _nearest_singletons(previous, left, _center(current, cg), len(cg), window)
            if pg is not None:
                pi = next(index for index, cluster in enumerate(left) if cluster == [pg[0]])
                add(pi, ci, "split_to_degenerate", pg, cg)
    for pi, pg in enumerate(left):
        if len(pg) >= 2:
            cg = _nearest_singletons(current, right, _center(previous, pg), len(pg), window)
            if cg is not None:
                ci = next(index for index, cluster in enumerate(right) if cluster == [cg[0]])
                add(pi, ci, "degenerate_to_split", pg, cg)
    return candidates
