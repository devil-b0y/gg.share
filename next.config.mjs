// Next.js configuration.
//
// The app runs through the custom server in server.js (not `next start`),
// which supplies the security headers and the client IP -- see that file.

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Native and binary-shipping packages must be loaded from node_modules at
  // runtime rather than bundled: better-sqlite3 and sharp are native
  // addons, ffmpeg-static locates its binary relative to its own directory,
  // and the TensorFlow packages are large and optionally native.
  serverExternalPackages: [
    'better-sqlite3',
    'sharp',
    'ffmpeg-static',
    'nsfwjs',
    '@tensorflow/tfjs',
    '@tensorflow/tfjs-node',
    'busboy',
    'proxy-addr'
  ],

  // The Express version served static .html files. Old links -- shared
  // post URLs especially -- keep working through these redirects.
  async redirects() {
    return [
      {
        source: '/post.html',
        has: [{ type: 'query', key: 'id', value: '(?<id>\\d+)' }],
        destination: '/post/:id',
        permanent: true
      },
      { source: '/index.html', destination: '/', permanent: true },
      { source: '/admin.html', destination: '/admin', permanent: true }
    ];
  }
};

export default nextConfig;
