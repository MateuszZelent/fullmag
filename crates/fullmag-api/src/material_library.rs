//! Shared workspace material catalog used by the HTTP resource.
pub use fullmag_workspace::material_catalog::{
    default_material_library_path, validate_properties,
    MaterialLibraryEntryResource, MaterialLibraryError, MaterialLibraryMutationResource,
    MaterialLibraryResource, MaterialLibraryStore, MaterialLibraryWriteRequest,
    MaterialVersionMutationResource, MaterialVersionPublishRequest, MaterialVersionUpdateRequest,
    PublishedMaterialVersion,
};
