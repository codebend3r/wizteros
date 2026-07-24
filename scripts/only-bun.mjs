// Aborts any package-manager script run by a tool other than Bun.
// Wired as preinstall (root + web) and pre<script> guards in web so that
// `npm run dev`, `pnpm run dev`, `npm install`, etc. fail fast while bun passes.
const agent = process.env.npm_config_user_agent ?? ''
const runner = agent.split('/')[0] || 'unknown'

if (!agent.startsWith('bun')) {
  console.error(
    `\n\x1b[31mThis repo is Bun-only.\x1b[0m Detected "${runner}".\n` +
      `Use bun instead:\n` +
      `  bun install            (not npm/pnpm/yarn install)\n` +
      `  bun run <script>       (not npm run <script>)\n`,
  )
  process.exit(1)
}
