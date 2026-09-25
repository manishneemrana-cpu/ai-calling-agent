import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // VPS deployment prep (deploy/): a standalone build bundles only the
  // production node_modules subset next actually needs into
  // .next/standalone, so the Docker image (deploy/../Dockerfile) doesn't
  // need to `npm ci` the full workspace at runtime. No effect on
  // `next dev`/vitest/local `next build && next start`.
  output: "standalone",
};

export default nextConfig;
