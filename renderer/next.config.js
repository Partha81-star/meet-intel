/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export for Electron (file:// protocol)
  output: process.env.DESKTOP_BUILD === '1' ? 'export' : 'standalone',
  // Disable image optimization (not supported in static export)
  images: { unoptimized: true },
  // Asset prefix for Electron file:// loading in production
  assetPrefix: process.env.DESKTOP_BUILD === '1' ? '.' : '',
  trailingSlash: true,
  async rewrites() {
    return process.env.DESKTOP_BUILD === '1' ? [] : [{
      source: '/api/:path*',
      destination: `${process.env.BACKEND_URL || 'http://127.0.0.1:8000'}/:path*`,
    }];
  },
};

module.exports = nextConfig;
