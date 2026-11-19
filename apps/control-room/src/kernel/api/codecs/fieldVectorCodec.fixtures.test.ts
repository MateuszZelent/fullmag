import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decodeFieldVector } from "./fieldVectorCodec";
import { decodeTableRows } from "./tableRowsCodec";

// Shared with the Python live client (packages/fullmag-py/tests/test_live_client_data.py);
// both decoders must produce expected.json from the same bytes (ADR 0068 spec §6).
const FIXTURES = new URL("../../../../../../packages/fullmag-py/tests/fixtures/fmvp/", import.meta.url);

type Expected = Record<string, Record<string, unknown>>;

function load(name: string): ArrayBuffer {
  const bytes = readFileSync(new URL(`${name}.bin`, FIXTURES));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const expected = JSON.parse(readFileSync(new URL("expected.json", FIXTURES), "utf8")) as Expected;

describe("shared FMVP/FMTB fixtures", () => {
  for (const [name, fields] of Object.entries(expected)) {
    it(`decodes ${name} like the Python client`, () => {
      if (name.startsWith("fmtb")) {
        const rows = decodeTableRows(load(name));
        expect({
          revision: rows.revision,
          schemaRevision: rows.schemaRevision,
          cursorStart: rows.cursorStart,
          cursorEnd: rows.cursorEnd,
          totalRows: rows.totalRows,
          resyncRequired: rows.resyncRequired,
          rowCount: rows.rowCount,
          columnCount: rows.columnCount,
          values: Array.from(rows.values),
        }).toEqual(fields);
        return;
      }
      const decoded = decodeFieldVector(load(name));
      const actual: Record<string, unknown> = {
        formatVersion: decoded.formatVersion,
        quantityId: decoded.quantityId,
        nComp: decoded.nComp,
        grid: decoded.grid,
        indexing: decoded.indexing,
        values: Array.from(decoded.values),
        nodeIndices: decoded.nodeIndices ? Array.from(decoded.nodeIndices) : undefined,
        domainGenerationId: decoded.domainGenerationId,
        meshTopologyRevision: decoded.meshTopologyRevision,
        meshTopologyHash: decoded.meshTopologyHash,
        scopeKind: decoded.scopeKind,
        scopeId: decoded.scopeId,
        sourceKind: decoded.sourceKind,
        sourceId: decoded.sourceId,
        sourceRevision: decoded.sourceRevision,
        fieldGenerationId: decoded.fieldGenerationId,
        artifactIdentityIds: decoded.artifactMapping
          ? Array.from(decoded.artifactMapping.identityIds, (id) => id.toString())
          : undefined,
      };
      for (const [key, value] of Object.entries(fields)) {
        expect(actual[key], key).toEqual(value);
      }
    });
  }
});
