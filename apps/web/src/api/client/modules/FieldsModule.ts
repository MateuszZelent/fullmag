import type { FieldCatalog, FieldMeta } from "../../generated/openapi-types";
import type { DecodedFieldVector } from "../../codecs/types";
import { decodeFieldVector } from "../../codecs/fieldVectorCodec";
import type { LiveApiClient } from "../LiveApiClient";

export class FieldsModule {
  constructor(private client: LiveApiClient) {}

  async getCatalog(): Promise<FieldCatalog> {
    return this.client.get<FieldCatalog>("/v1/live/current/fields/catalog");
  }

  async getMeta(quantityId: string): Promise<FieldMeta> {
    const encoded = encodeURIComponent(quantityId);
    return this.client.get<FieldMeta>(`/v1/live/current/fields/${encoded}/meta`);
  }

  async getVector(quantityId: string): Promise<DecodedFieldVector> {
    const encoded = encodeURIComponent(quantityId);
    const buffer = await this.client.getBinary(
      `/v1/live/current/fields/${encoded}/vector?format=bin`,
    );
    return decodeFieldVector(buffer);
  }
}
