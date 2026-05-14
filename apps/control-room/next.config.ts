import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // R3F v9 force-loses WebGL during React development strict remounts.
  reactStrictMode: false,
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
};

export default nextConfig;
