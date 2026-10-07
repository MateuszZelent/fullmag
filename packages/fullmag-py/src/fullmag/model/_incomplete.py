"""Internal markers for authoring states that are not runnable yet."""


class IncompletePhysicsError(ValueError):
    """A valid authoring draft does not yet describe executable physics."""
