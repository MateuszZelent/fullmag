//! Cold validation against owned canonical RT0 moments. The caller first binds J traces
//! to these moments through exact reconstruction and the existing rounding budget.
use super::closed_loop_v2::{invalid, ClosedLoopAcceptedSourceInputV2};
use crate::types::RunError;
use std::collections::{BTreeMap, BTreeSet};
fn require(ok: bool, why: &str) -> Result<(), RunError> {
    if ok {
        Ok(())
    } else {
        Err(invalid(why))
    }
}
struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], RunError> {
        let end = self
            .p
            .checked_add(n)
            .ok_or_else(|| invalid("certificate offset overflow"))?;
        let out = self
            .b
            .get(self.p..end)
            .ok_or_else(|| invalid("certificate truncated"))?;
        self.p = end;
        Ok(out)
    }
    fn u(&mut self) -> Result<u64, RunError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn byte(&mut self) -> Result<u8, RunError> {
        Ok(self.take(1)?[0])
    }
    fn f(&mut self) -> Result<f64, RunError> {
        let v = f64::from_bits(self.u()?);
        require(v.is_finite(), "certificate nonfinite scalar")?;
        Ok(v)
    }
    fn text(&mut self) -> Result<&'a str, RunError> {
        let n = usize::try_from(self.u()?).map_err(|_| invalid("certificate text size"))?;
        require(n <= 255, "certificate text bound")?;
        std::str::from_utf8(self.take(n)?).map_err(|_| invalid("certificate text encoding"))
    }
    fn key<const N: usize>(&mut self) -> Result<[u64; N], RunError> {
        let mut v = [0; N];
        for x in &mut v {
            *x = self.u()?;
        }
        Ok(v)
    }
}
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|k| a[k] - b[k])
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}
fn gate(value: f64, scale: f64) -> bool {
    value.is_finite() && scale.is_finite() && scale >= 0.0 && value.abs() <= 1e-18 + 1e-10 * scale
}
fn agree(a: f64, b: f64, scale: f64) -> bool {
    gate(a - b, scale)
}
fn sorted<const N: usize>(mut v: [u64; N]) -> [u64; N] {
    v.sort();
    v
}
#[derive(Clone)]
struct Face {
    owners: Vec<usize>,
    outward: Vec<f64>,
    canonical: Vec<f64>,
}
pub(crate) fn verify_balance_certificate(
    source: &ClosedLoopAcceptedSourceInputV2,
    cut_pairs: &[([u64; 3], [u64; 3])],
    cut_id: &str,
) -> Result<(), RunError> {
    let mut r = Reader {
        b: &source.canonical_balance_certificate,
        p: 0,
    };
    require(
        r.text()? == "fem_conservative_current_balance_certificate.v1",
        "certificate schema",
    )?;
    require(
        r.f()?.to_bits() == 1e-12f64.to_bits()
            && r.f()?.to_bits() == 1e-10f64.to_bits()
            && r.f()?.to_bits() == 1e-18f64.to_bits(),
        "certificate gates",
    )?;
    let rows = r.u()?;
    let rank = r.u()?;
    let ne = r.u()?;
    let nf = r.u()?;
    let nc = r.u()?;
    let no = r.u()?;
    let cells = source.cells.len();
    require(
        cells > 0
            && cells <= 1_048_576
            && ne == cells as u64
            && nf <= 4 * ne
            && nc <= nf
            && no <= rows
            && rows == ne + cut_pairs.len() as u64
            && rank.checked_add(no) == Some(rows),
        "certificate count/rank relation",
    )?;
    let by_id = source
        .stable_vertex_ids
        .iter()
        .copied()
        .zip(source.vertex_xyz_m.iter().copied())
        .collect::<BTreeMap<_, _>>();
    let fluxes = source.canonical_face_records.iter().copied().collect::<BTreeMap<_, _>>();
    require(fluxes.len() == source.canonical_face_records.len(), "certificate duplicate canonical faces")?;
    let mut faces: BTreeMap<[u64; 3], Face> = BTreeMap::new();
    let mut cell_keys = Vec::new();
    for (ordinal, c) in source.cells.iter().enumerate() {
        require(
            c.source_element_index == ordinal as u64,
            "certificate source cell ordering",
        )?;
        cell_keys.push(sorted(c.vertex_ids));
        for omitted in 0..4 {
            let face = sorted(std::array::from_fn(|i| c.vertex_ids[(omitted + 1 + i) % 4]));
            let points = face
                .map(|id| by_id.get(&id).copied())
                .map(|p| p.ok_or_else(|| invalid("certificate foreign vertex")));
            let [a, b, d] = points;
            let a = a?;
            let b = b?;
            let d = d?;
            let normal = cross(sub(b, a), sub(d, a));
            let opposite = *by_id
                .get(&c.vertex_ids[omitted])
                .ok_or_else(|| invalid("certificate opposite absent"))?;
            let side = dot(normal, sub(opposite, a));
            require(
                side.is_finite() && side != 0.0,
                "certificate degenerate face orientation",
            )?;
            // Physical balance belongs to the retained moment, not to a second
            // integration of its lossy binary64 display samples.
            let q = *fluxes.get(&face).ok_or_else(|| invalid("certificate canonical face absent"))?;
            require(q.is_finite(), "certificate nonfinite canonical face moment")?;
            let row = faces.entry(face).or_insert(Face {
                owners: Vec::new(),
                outward: Vec::new(),
                canonical: Vec::new(),
            });
            row.owners.push(ordinal);
            row.outward.push(if side < 0.0 { q } else { -q });
            row.canonical.push(q);
            require(row.owners.len() <= 2, "certificate nonmanifold face")?;
        }
    }
    require(
        faces.len() as u64 == nf && source.canonical_face_records.len() == faces.len(),
        "certificate complete face carrier",
    )?;
    require(fluxes.len() == faces.len(), "certificate foreign canonical faces")?;
    let mut balances = vec![0.0; cells];
    let mut denominators = vec![0.0; cells];
    for f in faces.values() {
        for (&owner, &outward) in f.owners.iter().zip(&f.outward) {
            balances[owner] += outward;
            denominators[owner] += outward.abs();
        }
    }
    let mut order = (0..cells).collect::<Vec<_>>();
    order.sort_by_key(|i| cell_keys[*i]);
    let mut maximum_div = 0.0f64;
    for i in order.iter().copied() {
        require(
            r.key::<4>()? == cell_keys[i],
            "certificate element key ordering",
        )?;
        let residual = r.f()?;
        let denominator = r.f()?;
        let relative = r.f()?;
        require(
            denominator >= 0.0
                && relative.to_bits() == (residual / denominator.max(1e-30)).to_bits()
                && gate(residual, denominator)
                && agree(residual, balances[i], denominator + denominators[i])
                && agree(denominator, denominators[i], denominator + denominators[i]),
            "certificate element balance/denominator",
        )?;
        maximum_div = maximum_div.max(residual.abs());
    }
    let mut certified = BTreeMap::new();
    let mut maximum_jump = 0.0f64;
    for (key, f) in &faces {
        require(
            r.key::<3>()? == *key && r.byte()? as usize == f.owners.len(),
            "certificate face key/side count",
        )?;
        let a = r.f()?;
        let b = r.f()?;
        let jump = r.f()?;
        let scale = a.abs() + b.abs();
        let mut indices = (0..f.owners.len()).collect::<Vec<_>>();
        indices.sort_by_key(|i| cell_keys[f.owners[*i]]);
        require(
            agree(
                a,
                f.outward[indices[0]],
                scale + f.outward[indices[0]].abs(),
            ),
            "certificate first outward flux",
        )?;
        if f.owners.len() == 2 {
            require(
                agree(
                    b,
                    f.outward[indices[1]],
                    scale + f.outward[indices[1]].abs(),
                ) && gate(jump, scale)
                    && agree(jump.abs(), (f.canonical[0] - f.canonical[1]).abs(), scale),
                "certificate internal face jump",
            )?;
            maximum_jump = maximum_jump.max(jump.abs());
        } else {
            require(b == 0.0 && jump == 0.0, "certificate boundary second side")?;
        }
        certified.insert(*key, (f.owners.len(), a));
    }
    let mut used = BTreeSet::new();
    let mut previous = None;
    let mut observed_pairs = BTreeSet::new();
    let mut net_outer = 0.0;
    let mut max_pair = 0.0f64;
    let mut pair_scale = 0.0f64;
    let expected_pairs = cut_pairs.iter().copied().collect::<BTreeSet<_>>();
    require(
        expected_pairs.len() == cut_pairs.len(),
        "certificate duplicate cut pairs",
    )?;
    for _ in 0..nc {
        let kind = r.byte()?;
        let id = r.text()?.to_owned();
        let a = r.key::<3>()?;
        let b = r.key::<3>()?;
        let flux = r.f()?;
        let paired = r.f()?;
        let mismatch = r.f()?;
        let key = (kind, id.clone(), a, b);
        require(
            previous.as_ref().is_none_or(|old| old < &key),
            "certificate circuit order",
        )?;
        previous = Some(key);
        let &(count, outward) = certified
            .get(&a)
            .ok_or_else(|| invalid("certificate circuit face absent"))?;
        require(
            count == 1 && used.insert(a) && agree(flux, outward, flux.abs() + outward.abs()),
            "certificate circuit boundary/flux",
        )?;
        if kind == 2 {
            let &(count, other) = certified
                .get(&b)
                .ok_or_else(|| invalid("certificate paired face absent"))?;
            require(
                id == cut_id
                    && count == 1
                    && used.insert(b)
                    && expected_pairs.contains(&(a, b))
                    && observed_pairs.insert((a, b))
                    && agree(paired, other, paired.abs() + other.abs())
                    && (mismatch == 0.0 && flux + paired == 0.0
                        || mismatch.to_bits() == (flux + paired).to_bits())
                    && gate(mismatch, flux.abs() + paired.abs()),
                "certificate source-cut pairing/mismatch",
            )?;
            max_pair = max_pair.max(mismatch.abs());
            pair_scale = pair_scale.max(flux.abs() + paired.abs());
        } else {
            require(
                kind == 4
                    && id.is_empty()
                    && b == [0; 3]
                    && paired == 0.0
                    && mismatch == 0.0
                    && gate(flux, flux.abs()),
                "certificate insulation row",
            )?;
            net_outer += flux;
        }
    }
    require(
        observed_pairs == expected_pairs
            && used.len() == faces.values().filter(|f| f.owners.len() == 1).count(),
        "certificate complete circuit boundary classification",
    )?;
    // For one connected insulated loop the incidence rows have exactly one divergence dependency.
    let anchor = cell_keys[*order.first().unwrap()];
    let mut adjacency = vec![Vec::new(); cells];
    for f in faces.values() {
        if f.owners.len() == 2 {
            adjacency[f.owners[0]].push(f.owners[1]);
            adjacency[f.owners[1]].push(f.owners[0]);
        }
    }
    for (a, b) in cut_pairs {
        let x = faces[a].owners[0];
        let y = faces[b].owners[0];
        adjacency[x].push(y);
        adjacency[y].push(x);
    }
    let mut connected = BTreeSet::new();
    let mut queue = vec![0usize];
    while let Some(i) = queue.pop() {
        if connected.insert(i) {
            queue.extend(&adjacency[i]);
        }
    }
    require(
        connected.len() == cells && no == 1 && rank == rows - 1,
        "certificate connected closed-loop rank",
    )?;
    let expected_id = format!(
        "divergence:{}:{}:{}:{}",
        anchor[0], anchor[1], anchor[2], anchor[3]
    );
    require(
        r.text()? == expected_id && r.byte()? == 1 && r.key::<4>()? == anchor,
        "certificate omitted divergence anchor/reason",
    )?;
    let residual = r.f()?;
    let anchor_ordinal = *order.first().unwrap();
    require(
        gate(residual, denominators[anchor_ordinal]),
        "certificate omitted residual",
    )?;
    let divergence = r.f()?;
    let jump = r.f()?;
    let outer = r.f()?;
    let relative = r.f()?;
    let kkt = r.f()?;
    let correction = r.f()?;
    require(
        divergence.to_bits() == maximum_div.to_bits()
            && jump.to_bits() == maximum_jump.to_bits()
            && agree(outer, net_outer, source.metadata.source_absolute_flux_a)
            && relative.to_bits() == (max_pair / pair_scale.max(1e-30)).to_bits()
            && relative >= 0.0
            && kkt >= 0.0
            && kkt <= 1e-12
            && correction >= 0.0
            && r.byte()? == 1
            && r.p == r.b.len(),
        "certificate summary, KKT or trailing bytes",
    )?;
    Ok(())
}
