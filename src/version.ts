import { readFileSync } from "node:fs";

/**
 * The package version, read from package.json at runtime.
 *
 * This used to be a string literal in `buildServer()`, which meant every release
 * had to remember to bump it in two places. It drifted: v0.3.0 and v0.3.1 both
 * shipped announcing `0.2.0` in the MCP handshake, because the release bumped
 * package.json and left the literal behind.
 *
 * `../package.json` resolves from both `src/version.ts` (dev, via tsx) and
 * `dist/version.js` (published), because tsconfig maps `src/*` to `dist/*`
 * flatly. A static `import pkg from "../package.json"` would be tidier, but
 * package.json sits outside `rootDir: ./src`, so TypeScript would re-root the
 * emit to `dist/src/*` and break the `bin`/`exports` paths.
 *
 * npm always includes package.json in the published tarball, so this is
 * available at runtime regardless of the `files` allowlist.
 */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version?: unknown;
};

if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  throw new Error("Could not read a version string from package.json");
}

export const VERSION: string = pkg.version;
