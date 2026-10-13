//! Immutable auxiliary object bindings carried by the public 0.3 physics graph.

use crate::{PhysicsObjectIR, ProblemIR, PHYSICS_OBJECT_SCHEMA_VERSION};
use std::collections::{BTreeMap, BTreeSet};

/// Absence permits the legacy auxiliary-name adapter; an explicit empty table
/// does not. Presentation types never activate solver physics here.
pub fn physics_object_geometry_bindings_v03(
    problem: &ProblemIR,
) -> Result<Option<BTreeMap<String, String>>, Vec<String>> {
    let Some(graph) = problem.physics_graph.as_ref() else {
        return Ok(None);
    };
    let graph = graph
        .as_object()
        .ok_or_else(|| vec!["physics_graph must be an object".to_string()])?;
    let Some(objects) = graph.get("objects") else {
        return Ok(None);
    };
    if graph.get("schema_version").and_then(serde_json::Value::as_str)
        != Some("physics_graph.v1")
    {
        return Err(vec!["physics_graph.schema_version must be 'physics_graph.v1'".to_string()]);
    }
    let objects = objects
        .as_array()
        .ok_or_else(|| vec!["physics_graph.objects must be an array".to_string()])?;
    let magnetic_ids = problem
        .magnets
        .iter()
        .flat_map(|magnet| {
            std::iter::once(magnet.name.as_str()).chain(magnet.object_id.as_deref())
        })
        .collect::<BTreeSet<_>>();
    let magnetic_geometry = problem
        .magnets
        .iter()
        .flat_map(|magnet| {
            problem
                .regions
                .iter()
                .filter(move |region| region.name == magnet.region)
                .map(|region| region.geometry.as_str())
        })
        .collect::<BTreeSet<_>>();
    let mut errors = Vec::new();
    let mut bindings = BTreeMap::new();
    let mut geometry_owners = BTreeSet::new();
    for (index, value) in objects.iter().enumerate() {
        let path = format!("physics_graph.objects[{index}]");
        let object = match serde_json::from_value::<PhysicsObjectIR>(value.clone()) {
            Ok(object) => object,
            Err(error) => {
                errors.push(format!("{path}: {error}"));
                continue;
            }
        };
        if object.schema_version != PHYSICS_OBJECT_SCHEMA_VERSION {
            errors.push(format!("{path}.schema_version must be '{PHYSICS_OBJECT_SCHEMA_VERSION}'"));
        }
        for (field, value) in [
            ("object_id", &object.object_id),
            ("name", &object.name),
            ("geometry_id", &object.geometry_id),
        ] {
            if value.trim().is_empty() {
                errors.push(format!("{path}.{field} must not be empty"));
            }
        }
        if bindings.contains_key(&object.object_id) {
            errors.push(format!("{path}.object_id duplicates '{}'", object.object_id));
        }
        if magnetic_ids.contains(object.object_id.as_str()) {
            errors.push(format!("{path}.object_id conflicts with a magnetic object or its legacy alias"));
        }
        let matches = problem
            .geometry
            .entries
            .iter()
            .filter(|entry| entry.name() == object.geometry_id)
            .count();
        if matches != 1 {
            errors.push(format!("{path}.geometry_id must reference exactly one geometry entry, found {matches}"));
        }
        if !geometry_owners.insert(object.geometry_id.clone()) {
            errors.push(format!("{path}.geometry_id has more than one auxiliary owner"));
        }
        if magnetic_geometry.contains(object.geometry_id.as_str()) {
            errors.push(format!("{path}.geometry_id is already owned by a magnetic object"));
        }
        bindings.insert(object.object_id, object.geometry_id);
    }
    if errors.is_empty() {
        Ok(Some(bindings))
    } else {
        Err(errors)
    }
}

/// Resolve to the actual geometry entry, never to a display label or a guessed
/// owner. Both validation and dedicated antenna planning share this contract.
pub fn geometry_name_for_physics_object_v03<'a>(
    problem: &'a ProblemIR,
    object_id: &str,
) -> Result<&'a str, Vec<String>> {
    let bindings = physics_object_geometry_bindings_v03(problem)?;
    let explicit_geometry = bindings.as_ref().and_then(|table| table.get(object_id));
    let fail = |reason: String| vec![format!("object '{object_id}': {reason}")];
    let has_explicit_magnet = problem
        .magnets
        .iter()
        .any(|magnet| magnet.object_id.as_deref() == Some(object_id));
    // Preserve the historical priority: explicit magnet ID, exact legacy
    // geometry name, then magnet-name alias. Never silently change the source.
    if bindings.is_none() && !has_explicit_magnet {
        let mut entries = problem.geometry.entries.iter().filter(|entry| entry.name() == object_id);
        if let Some(entry) = entries.next() {
            if entries.next().is_some() {
                return Err(fail(format!("ambiguous geometry '{object_id}'")));
            }
            return Ok(entry.name());
        }
    }
    let geometry = if let Some(geometry) = explicit_geometry {
        geometry.as_str()
    } else {
        let mut magnets = problem.magnets.iter().filter(|magnet| {
            if has_explicit_magnet {
                magnet.object_id.as_deref() == Some(object_id)
            } else {
                magnet.name == object_id
            }
        });
        if let Some(magnet) = magnets.next() {
            if magnets.next().is_some() {
                return Err(fail("ambiguous magnetic owner binding".to_string()));
            }
            let mut regions = problem.regions.iter().filter(|region| region.name == magnet.region);
            let region = regions.next().ok_or_else(|| fail(format!("missing region '{}'", magnet.region)))?;
            if regions.next().is_some() {
                return Err(fail(format!("ambiguous region '{}'", magnet.region)));
            }
            region.geometry.as_str()
        } else if bindings.is_none() {
            object_id
        } else {
            return Err(fail("no explicit auxiliary geometry binding in physics_graph.objects".to_string()));
        }
    };
    let mut entries = problem.geometry.entries.iter().filter(|entry| entry.name() == geometry);
    let entry = entries.next().ok_or_else(|| fail(format!("missing geometry '{geometry}'")))?;
    if entries.next().is_some() {
        return Err(fail(format!("ambiguous geometry '{geometry}'")));
    }
    Ok(entry.name())
}
