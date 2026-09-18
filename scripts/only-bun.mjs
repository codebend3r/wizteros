// Aborts any package-manager script run by a tool other than Bun, or by a Bun
// whose version is not the one this repo pins.
// Wired as preinstall (workspace root + apps/admin-portal) and pre<script>
// guards in apps/admin-portal so that
// `npm run dev`, `pnpm run dev`, `npm install`, etc. fail fast while bun passes.
import { readFileSync } from 'node:fs'

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

// The root `packageManager` field is the single source of truth for the Bun
// version: GitHub Actions reads it through oven-sh/setup-bun, and netlify.toml
// mirrors it as BUN_VERSION. Run under a different Bun and the lockfile format,
// the test runner, and the CI result can all disagree with what shipped, so
// fail fast rather than let the mismatch through.
const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const pinned = (rootPackage.packageManager ?? '').replace(/^bun@/, '')
const running = agent.split(' ')[0].split('/')[1] ?? ''

if (pinned.length > 0 && running.length > 0 && running !== pinned) {
  console.error(
    `\n\x1b[31mWrong Bun version.\x1b[0m This repo pins \x1b[1m${pinned}\x1b[0m, you are on \x1b[1m${running}\x1b[0m.\n` +
      `Either match the pin:\n` +
      `  curl -fsSL https://bun.sh/install | bash -s "bun-v${pinned}"\n` +
      `or move it, in packageManager (package.json) and BUN_VERSION (netlify.toml) together.\n`,
  )
  process.exit(1)
}
