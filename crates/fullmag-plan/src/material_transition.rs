use fullmag_ir::{
    MaterialParameterNameIR, MaterialTransitionScopeIR, MaterialTransitionSpecIR, ObjectRegionIR,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum ResolvedMaterialTransition {
    MeshRelative {
        cells: u32,
        scope: MaterialTransitionScopeIR,
    },
    Metric {
        width: f64,
        scope: MaterialTransitionScopeIR,
    },
    Sharp,
    None,
}

pub(crate) fn resolved_region_transition(
    region: &ObjectRegionIR,
    parameter: MaterialParameterNameIR,
) -> ResolvedMaterialTransition {
    match &region.material_transition {
        Some(MaterialTransitionSpecIR::MeshRelative { cells, scope }) => {
            ResolvedMaterialTransition::MeshRelative {
                cells: *cells,
                scope: *scope,
            }
        }
        Some(MaterialTransitionSpecIR::Metric { width, scope }) => {
            ResolvedMaterialTransition::Metric {
                width: *width,
                scope: *scope,
            }
        }
        Some(MaterialTransitionSpecIR::Sharp) => ResolvedMaterialTransition::Sharp,
        None if matches!(
            parameter,
            MaterialParameterNameIR::Ms | MaterialParameterNameIR::Aex
        ) =>
        {
            ResolvedMaterialTransition::MeshRelative {
                cells: 3,
                scope: MaterialTransitionScopeIR::Boundary,
            }
        }
        None => ResolvedMaterialTransition::None,
    }
}

pub(crate) fn region_transition_is_sharp(
    region: &ObjectRegionIR,
    parameter: MaterialParameterNameIR,
) -> bool {
    matches!(
        resolved_region_transition(region, parameter),
        ResolvedMaterialTransition::Sharp
    )
}
