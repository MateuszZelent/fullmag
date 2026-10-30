import {describe, expect, it} from "vitest";
import {decodeResultValues, parseResultDatasetIdentity, resultDatasetIdentity} from "./resultsBrowser";

describe("result folder resource identity and values", () => {
  it("separates live and workspace datasets without path interpolation", () => {
    for (const source of [{kind:"current"} as const, {kind:"workspace",itemId:"17"} as const]) {
      expect(parseResultDatasetIdentity(resultDatasetIdentity(source,"opaque-array"))).toEqual({source,arrayId:"opaque-array"});
    }
    for (const key of ['["workspace","../other","x"]','["current","17","x"]','["current",null,""]','{}']) {
      expect(parseResultDatasetIdentity(key)).toBeNull();
    }
  });
  it("decodes exact little-endian sample bytes and rejects unavailable scientific values", () => {
    const buffer=new ArrayBuffer(16),view=new DataView(buffer);
    view.setFloat64(0,1.25,true);view.setFloat64(8,-0.5,true);
    expect(Array.from(decodeResultValues(buffer,2))).toEqual([1.25,-0.5]);
    expect(()=>decodeResultValues(buffer,3)).toThrow(/size/);
    view.setFloat64(8,NaN,true);
    expect(()=>decodeResultValues(buffer,2)).toThrow(/non-finite/);
    expect(()=>decodeResultValues(buffer,Infinity)).toThrow(/size/);
  });
});
