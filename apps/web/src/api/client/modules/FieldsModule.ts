import type { FieldCatalog, FieldMeta } from "../../generated/openapi-types";
import type { DecodedFieldVector } from "../../codecs/types";
import { decodeFieldVector } from "../../codecs/fieldVectorCodec";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class FieldsModule {
  constructor(private client: LiveApiClient) {}

  async getCatalog(opts?: RequestOptions): Promise<FieldCatalog> {
    return this.client.get<FieldCatalog>("/v1/live/current/fields/catalog", opts);
  }

  async getMeta(quantityId: string, opts?: RequestOptions): Promise<FieldMeta> {
    const encoded = encodeURIComponent(quantityId);
    return this.client.get<FieldMeta>(
      `/v1/live/current/fields/${encoded}/meta`,
      opts,
    );
  }

  async getVector(
    quantityId: string,
    opts?: RequestOptions,
  ): Promise<DecodedFieldVector> {
    const encoded = encodeURIComponent(quantityId);
    const buffer = await this.client.getBinary(
      `/v1/live/current/fields/${encoded}/vector?format=bin`,
      opts,
    );
    return decodeFieldVector(buffer);
  }
}
