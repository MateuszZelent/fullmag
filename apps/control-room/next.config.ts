import type { NextConfig } from "next";
import path from "node:path";

function controlRoomApiProxyTarget(): string {
  return (
    process.env.FULLMAG_API_PROXY_TARGET ??
    process.env.FULLMAG_API_URL ??
    "http://localhost:8081"
  ).replace(/\/+$/, "");
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["fullmag.amucontainers.orion.zfns.eu.org"],
  // R3F v9 force-loses WebGL during React development strict remounts.
  reactStrictMode: false,
  async rewrites() {
    const apiTarget = controlRoomApiProxyTarget();
    return [
      {
        source: "/v2/:path*",
        destination: `${apiTarget}/v2/:path*`,
      },
    ];
  },
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
};

export default nextConfig;
