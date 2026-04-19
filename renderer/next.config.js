/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export for Electron (file:// protocol)
  output: 'export',
  // Disable image optimization (not supported in static export)
  images: { unoptimized: true },
  // Asset prefix for Electron file:// loading in production
  assetPrefix: process.env.NODE_ENV === 'production' ? '.' : '',
  trailingSlash: true,
};

module.exports = nextConfig;
