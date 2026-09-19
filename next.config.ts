import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["jszip"],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    serverActions: {
      // Uploading the demo zip and importing large archives can take a while.
      bodySizeLimit: "900mb",
    },
  },
};

export default nextConfig;
