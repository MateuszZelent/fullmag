//! API side of the live observation demand (see `accepted_live_demand`).
//!
//! The demand is the union of
//! - the quantities the Control Room displays (`observation_quantities`,
//!   derived from the visualization state on every display mutation), and
//! - the spatial quantities any client read through the field endpoints in the
//!   last `RECENT_FIELD_REQUEST_WINDOW` (Inspector panels, Python clients).
//!
//! The projector publishes it beside the active run whenever it changes.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use fullmag_quantities::{normalize_quantity_id, quantity_spec};
use fullmag_runner::quantities::QuantityKind;

const RECENT_FIELD_REQUEST_WINDOW: Duration = Duration::from_secs(15);
const MAX_RECENT_FIELD_REQUESTS: usize = 32;

static RECENT_FIELD_REQUESTS: Mutex<BTreeMap<String, Instant>> = Mutex::new(BTreeMap::new());

fn canonical_spatial_quantity(quantity_id: &str) -> Option<String> {
    let quantity = normalize_quantity_id(quantity_id.trim()).ok()?;
    let spec = quantity_spec(quantity.as_str())?;
    matches!(
        spec.shape,
        QuantityKind::VectorField | QuantityKind::SpatialScalar
    )
    .then(|| quantity.as_str().to_owned())
}

/// Record that a client read a spatial field, so live capture keeps it.
pub(crate) fn note_live_field_request(quantity_id: &str) {
    let Some(quantity) = canonical_spatial_quantity(quantity_id) else {
        return;
    };
    let Ok(mut recent) = RECENT_FIELD_REQUESTS.lock() else {
        return;
    };
    let now = Instant::now();
    recent.retain(|_, at| now.duration_since(*at) <= RECENT_FIELD_REQUEST_WINDOW);
    if recent.len() >= MAX_RECENT_FIELD_REQUESTS && !recent.contains_key(&quantity) {
        return;
    }
    recent.insert(quantity, now);
}

/// Displayed quantities first, then recently read ones; canonical, deduplicated.
/// An empty display demand means no client expressed one: publish nothing and
/// keep the full live catalog.
fn current_live_demand(display: &[String]) -> Option<Vec<String>> {
    if display.is_empty() {
        return None;
    }
    let mut demand: Vec<String> = Vec::new();
    let mut push = |quantity: String| {
        if !demand.contains(&quantity) {
            demand.push(quantity);
        }
    };
    for quantity in display.iter().filter_map(|id| canonical_spatial_quantity(id)) {
        push(quantity);
    }
    if let Ok(recent) = RECENT_FIELD_REQUESTS.lock() {
        let now = Instant::now();
        for (quantity, at) in recent.iter() {
            if now.duration_since(*at) <= RECENT_FIELD_REQUEST_WINDOW {
                push(quantity.clone());
            }
        }
    }
    Some(demand)
}

/// Publish the current demand for `run_id` when it differs from the last one
/// published. Failures are logged; the worker then keeps its previous demand.
pub(crate) async fn publish_live_demand(
    state: &crate::AppState,
    store_root: &Path,
    run_id: &str,
    last_published: &mut Option<(String, Vec<String>)>,
) {
    let display = state
        .current_display_selection
        .read()
        .await
        .observation_quantities
        .clone();
    let Some(demand) = current_live_demand(&display) else {
        return;
    };
    if last_published
        .as_ref()
        .is_some_and(|(published_run, published)| published_run == run_id && *published == demand)
    {
        return;
    }
    let root = store_root.to_path_buf();
    let run = run_id.to_owned();
    let quantities = demand.clone();
    let written = tokio::task::spawn_blocking(move || {
        crate::accepted_live_demand::write_accepted_live_demand(&root, &run, &quantities)
    })
    .await;
    match written {
        Ok(Ok(true)) => *last_published = Some((run_id.to_owned(), demand)),
        Ok(Ok(false)) => {}
        Ok(Err(error)) => tracing::warn!(error = %error, "accepted live demand not published"),
        Err(error) => tracing::warn!(error = %error, "accepted live demand task failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_display_demand_keeps_the_full_catalog() {
        assert_eq!(current_live_demand(&[]), None);
    }

    #[test]
    fn display_demand_is_canonical_and_spatial_only() {
        let demand = current_live_demand(&["m".to_string(), "E_total".to_string()]).unwrap();
        assert!(demand.contains(&"m".to_string()));
        assert!(!demand.contains(&"E_total".to_string()));
    }
}
