/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next 16 appends its own agent instructions to CLAUDE.md, or creates
  // AGENTS.md, whenever `next dev` runs under a coding agent, which includes
  // this app's own terminals. That leaves contributors with changed or new
  // files they didn't touch.
  agentRules: false,
};

export default nextConfig;
