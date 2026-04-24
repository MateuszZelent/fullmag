import { describe, expect, it } from "vitest";

describe("next config Radix compatibility aliases", () => {
  it("routes Radix compose refs through the React 19 safe shim", async () => {
    const { default: nextConfig } = await import("../next.config.mjs");
    expect(typeof nextConfig.webpack).toBe("function");

    const config = nextConfig.webpack({ resolve: { alias: {} } });
    expect(config.resolve.alias["@radix-ui/react-compose-refs"]).toMatch(
      /lib\/radix\/react-compose-refs-shim\.ts$/,
    );
  });
});
