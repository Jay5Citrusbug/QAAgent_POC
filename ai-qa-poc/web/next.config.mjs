/** @type {import('next').NextConfig} */
const nextConfig = {
  // The API routes read and write files in the parent ai-qa-poc project
  // (schemas, missions, analysis). Nothing here is bundled for the browser.
  experimental: {},
};

export default nextConfig;
