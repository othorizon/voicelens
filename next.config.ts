import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["jszip", "yauzl"],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    serverActions: {
      // Archives go browser -> bucket now and never reach this process, so the
      // old 900mb allowance is gone; this only has to cover ordinary forms.
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
