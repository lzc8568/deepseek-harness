/**
 * Shared process lifecycle for the generic and closed-runtime JSON-RPC bins.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-demo/runner
 */

import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

/* v8 ignore start -- composition over tested app-boot/jsonrpc and executable acceptance paths */
const NAME = 'dsh-jsonrpc-agent'

/**
 * Let sharp's native addon find its libvips shared libraries when running as
 * the packaged single-file executable. pkg's virtual filesystem cannot dlopen
 * `.so`/`.dylib` files, so the build places the `@img/sharp-libvips-*` bundle
 * beside the executable as a `<product>-libvips` directory; exposing that
 * directory on the loader path makes dlopen resolve from real disk bytes
 * rather than the snapshot. Regular Node execution has no `process.pkg`, so
 * sharp resolves libvips from its own `node_modules` and nothing is changed.
 */
function setupSharpNativeEnv(): void {
  if (typeof process.pkg !== 'string') return
  const libvipsDir = join(dirname(process.pkg), `${basename(process.pkg)}-libvips`)
  if (!existsSync(libvipsDir)) return
  const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'
  const existing = process.env[key]
  process.env[key] = existing === undefined ? libvipsDir : `${libvipsDir}:${existing}`
}

/**
 * Boot the explicitly selected external configuration and own process exit.
 * @param bareModuleBaseUrl - optional installed-runtime base for bare plugins;
 * omit it when the configuration project owns its plugin packages.
 * @returns after process handlers are installed; process lifetime then belongs
 * to stdin and signal events.
 */
export async function runJsonrpcAgent(bareModuleBaseUrl?: string): Promise<void> {
  installFailLoud(NAME)
  loadEnv(NAME)
  setupSharpNativeEnv()

  // Env wins over argv; empty values are absent. External config defines the deployment.
  const fromEnv = process.env['DSH_CORDIS_CONFIG']
  const fromArgv = process.argv[2]
  const requested = fromEnv !== undefined && fromEnv !== ''
    ? fromEnv
    : fromArgv !== undefined && fromArgv !== '' ? fromArgv : undefined
  const configPath = requested === undefined ? undefined : resolveConfigPath(requested, undefined)
  if (configPath === undefined || !existsSync(configPath)) {
    process.stderr.write(
      `usage: ${NAME} <path/to/cordis.yml> (or set DSH_CORDIS_CONFIG=<path>, which wins); the config is required — there is no built-in fallback\n`,
    )
    process.exit(1)
  }

  const ctx = await boot(NAME, configPath, undefined, undefined, bareModuleBaseUrl)
  let exiting = false

  async function disposeAndExit(code: number): Promise<void> {
    if (exiting) return
    exiting = true
    try {
      await ctx.fiber.dispose()
    } finally {
      process.exit(code)
    }
  }

  process.stdin.on('end', () => { void disposeAndExit(0) })
  process.on('SIGTERM', () => { void disposeAndExit(0) })
  process.on('SIGINT', () => { void disposeAndExit(130) })
}
/* v8 ignore stop */
