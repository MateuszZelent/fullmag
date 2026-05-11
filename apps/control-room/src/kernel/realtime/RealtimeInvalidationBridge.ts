import type { ResourceRevision } from "../api/apiTypes";
import type { ResourceInvalidationController } from "../resources/ResourceInvalidationController";

interface RealtimeResourceEvent {
  resource_key?: string;
  revision?: ResourceRevision;
  type: string;
}

export class RealtimeInvalidationBridge {
  constructor(private readonly resources: ResourceInvalidationController) {}

  handleEvent(event: RealtimeResourceEvent): boolean {
    if (event.type !== "resource.updated") {
      return false;
    }

    if (!event.resource_key || event.revision === undefined) {
      return false;
    }

    this.resources.invalidate(event.resource_key, event.revision);
    return true;
  }
}
