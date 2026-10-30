//! Live observation demand for one accepted worker process.
//!
//! The Control Room visualization state names the spatial quantities it
//! currently displays. The API derives them (`observation_quantities`) and the
//! accepted worker installs them here, so the live capture paths copy `m` and
//! those quantities instead of the whole active catalog on every published
//! step. Terminal bundles, artifacts and explicit materialization never consult
//! this filter; they keep the complete active catalog.
//!
//! No demand installed (`None`) keeps the full active catalog, which is the
//! behaviour of every non-accepted caller (CLI, interactive host, tests).

use std::sync::RwLock;

static LIVE_QUANTITY_DEMAND: RwLock<Option<Vec<String>>> = RwLock::new(None);

/// Install the demanded live quantities, or `None` for the full active catalog.
///
/// Quantity ids are canonical catalog ids. `m` is always captured because it
/// carries the live state and its clock.
pub fn set_live_quantity_demand(quantities: Option<Vec<String>>) {
    if let Ok(mut demand) = LIVE_QUANTITY_DEMAND.write() {
        *demand = quantities;
    }
}

/// The currently installed demand, for diagnostics and change detection.
pub fn live_quantity_demand() -> Option<Vec<String>> {
    LIVE_QUANTITY_DEMAND
        .read()
        .ok()
        .and_then(|demand| demand.clone())
}

/// Keep `m` and the demanded quantities of an already plan-filtered list.
pub(crate) fn retain_demanded_live_quantities<'a>(quantities: Vec<&'a str>) -> Vec<&'a str> {
    match LIVE_QUANTITY_DEMAND.read() {
        Ok(demand) => retain_in_demand(quantities, demand.as_deref()),
        Err(_) => quantities,
    }
}

fn retain_in_demand<'a>(quantities: Vec<&'a str>, demand: Option<&[String]>) -> Vec<&'a str> {
    let Some(demand) = demand else {
        return quantities;
    };
    quantities
        .into_iter()
        .filter(|quantity| *quantity == "m" || demand.iter().any(|id| id == quantity))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demand_keeps_m_and_requested_quantities_only() {
        let catalog = vec!["m", "H_eff", "H_demag"];
        assert_eq!(retain_in_demand(catalog.clone(), None), catalog);
        let demand = vec!["H_demag".to_string()];
        assert_eq!(retain_in_demand(catalog.clone(), Some(&demand)), vec!["m", "H_demag"]);
        assert_eq!(retain_in_demand(catalog, Some(&[])), vec!["m"]);
    }
}
