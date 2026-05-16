import path from "path";
import { fileURLToPath } from "url";

const configDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(process.cwd(), "../../"),
  output: "export",
  trailingSlash: true,
  typedRoutes: true,
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ["fullmag-api"],
  // echarts v6 and zrender v6 are pure-ESM packages ("type":"module") that use
  // extensive `export *` re-exports. Webpack 5 can leave module slots as
  // undefined during evaluation, causing `__webpack_modules__[moduleId] is not
  // a function` at runtime. Listing them here forces Next.js's SWC pipeline to
  // transpile them to CJS-compatible modules that webpack handles reliably.
  transpilePackages: ["echarts", "zrender"],
  webpack(config, { isServer }) {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@radix-ui/react-compose-refs": path.join(
        configDir,
        "lib/radix/react-compose-refs-shim.ts",
      ),
    };
    if (isServer) {
      config.output = config.output ?? {};
      config.output.chunkFilename = "chunks/[name].js";
    }
    return config;
  },
};

export default nextConfig;
