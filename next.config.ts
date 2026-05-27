import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";
import { settingsToSetupRedirects } from "./src/navigation/setup-redirects";

process.env.SERWIST_SUPPRESS_TURBOPACK_WARNING ??= "1";

function allowedDevOrigins(): string[] {
  const configured = process.env.HIVEWRIGHT_ALLOWED_DEV_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];

  return ["localhost", "127.0.0.1", "100.72.184.71", ...configured];
}

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV !== "production",
});

const nextConfig: NextConfig = {
  redirects: async () => settingsToSetupRedirects,
  allowedDevOrigins: allowedDevOrigins(),
  turbopack: {
    root: __dirname,
  },
};

export default withSerwist(nextConfig);
