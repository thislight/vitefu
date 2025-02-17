import fs from 'node:fs/promises'
import path from 'node:path'

/** @type {import('pnpapi')} */
let pnp
if (process.versions.pnp) {
  try {
    const { createRequire } = (await import('module')).default
    pnp = createRequire(import.meta.url)('pnpapi')
  } catch {}
}

/** @type {import('..').crawlFrameworkPkgs} */
export async function crawlFrameworkPkgs(options) {
  const pkgJsonPath = await findClosestPkgJsonPath(options.root)
  if (!pkgJsonPath) {
    throw new Error(`Cannot find package.json from ${options.root}`)
  }
  const pkgJson = await readJson(pkgJsonPath).catch((e) => {
    throw new Error(`Unable to read ${pkgJsonPath}`, { cause: e })
  })

  /** @type {string[]} */
  let optimizeDepsInclude = []
  /** @type {string[]} */
  let optimizeDepsExclude = []
  /** @type {string[]} */
  let ssrNoExternal = []
  /** @type {string[]} */
  let ssrExternal = []

  await crawl(pkgJsonPath, pkgJson)

  // respect vite user config
  if (options.viteUserConfig) {
    // remove includes that are explicitly excluded in optimizeDeps
    const _optimizeDepsExclude = options.viteUserConfig?.optimizeDeps?.exclude
    if (_optimizeDepsExclude) {
      optimizeDepsInclude = optimizeDepsInclude.filter((dep) => {
        // https://github.com/vitejs/vite/blob/9f268dad2e82c0f1276b1098c0a28f1cf245aa50/packages/vite/src/node/utils.ts#L108-L113
        return !_optimizeDepsExclude.some(
          (id) => id === dep || dep.startsWith(`${id}/`)
        )
      })
    }
    // remove excludes that are explicitly included in optimizeDeps
    const _optimizeDepsInclude = options.viteUserConfig?.optimizeDeps?.include
    if (_optimizeDepsInclude) {
      optimizeDepsExclude = optimizeDepsExclude.filter((dep) => {
        return !optimizeDepsInclude.includes(dep)
      })
    }
    // remove noExternals that are explicitly externalized
    const _ssrExternal = options.viteUserConfig?.ssr?.external
    if (_ssrExternal) {
      ssrNoExternal = ssrNoExternal.filter((dep) => {
        return _ssrExternal.includes(dep)
      })
    }
    // remove externals that are explicitly noExternal
    const _ssrNoExternal = options.viteUserConfig?.ssr?.noExternal
    if (_ssrNoExternal === true) {
      ssrExternal = []
    } else if (_ssrNoExternal) {
      ssrExternal = ssrExternal.filter((dep) => {
        return !isMatch(dep, _ssrNoExternal)
      })
    }
  }

  return {
    optimizeDeps: {
      include: optimizeDepsInclude,
      exclude: optimizeDepsExclude
    },
    ssr: {
      noExternal: ssrNoExternal,
      external: ssrExternal
    }
  }

  /**
   * crawl the package.json dependencies for framework packages. rules:
   * 1. a framework package should be `optimizeDeps.exclude` and `ssr.noExternal`.
   * 2. the deps of the framework package should be `optimizeDeps.include` and `ssr.external`
   *    unless the dep is also a framework package, in which case do no1 & no2 recursively.
   * 3. any non-framework packages that aren't imported by a framework package can be skipped entirely.
   * 4. a semi-framework package is like a framework package, except it isn't `optimizeDeps.exclude`,
   *    but only applies `ssr.noExternal`.
   * @param {string} pkgJsonPath
   * @param {Record<string, any>} pkgJson
   * @param {string[]} [parentDepNames]
   */
  async function crawl(pkgJsonPath, pkgJson, parentDepNames = []) {
    const isRoot = parentDepNames.length === 0

    /** @type {string[]} */
    let deps = [
      ...Object.keys(pkgJson.dependencies || {}),
      ...(isRoot ? Object.keys(pkgJson.devDependencies || {}) : [])
    ]

    deps = deps.filter((dep) => {
      // skip circular deps
      if (parentDepNames.includes(dep)) {
        return false
      }

      const isFrameworkPkg = options.isFrameworkPkgByName?.(dep)
      const isSemiFrameworkPkg = options.isSemiFrameworkPkgByName?.(dep)
      if (isFrameworkPkg) {
        // framework packages should be excluded from optimization as esbuild can't handle them.
        // otherwise it'll cause https://github.com/vitejs/vite/issues/3910
        optimizeDepsExclude.push(dep)
        // framework packages should be noExternal so that they go through vite's transformation
        // pipeline, since nodejs can't support them.
        ssrNoExternal.push(dep)
      } else if (isSemiFrameworkPkg) {
        // semi-framework packages should do the same except for optimization exclude as they
        // aren't needed to work (they don't contain raw framework components)
        ssrNoExternal.push(dep)
      }

      // only those that are explictly false can skip crawling since we don't need to do anything
      // special for them
      if (isFrameworkPkg === false || isSemiFrameworkPkg === false) {
        return false
      }
      // if `true`, we need to crawl the nested deps to deep include and ssr externalize them in dev.
      // if `undefined`, it's the same as "i don't know". we need to crawl and find the package.json
      // to find out.
      else {
        return true
      }
    })

    const promises = deps.map(async (dep) => {
      const depPkgJsonPath = await findDepPkgJsonPath(dep, pkgJsonPath)
      if (!depPkgJsonPath) return
      const depPkgJson = await readJson(depPkgJsonPath).catch(() => {})
      if (!depPkgJson) return

      // fast path if this dep is already a framework dep based on the filter condition above
      const cachedIsFrameworkPkg = ssrNoExternal.includes(dep)
      if (cachedIsFrameworkPkg) {
        return crawl(depPkgJsonPath, depPkgJson, parentDepNames.concat(dep))
      }

      // check if this dep is a framework dep, if so, track and crawl it
      const isFrameworkPkg = options.isFrameworkPkgByJson?.(depPkgJson)
      const isSemiFrameworkPkg = options.isSemiFrameworkPkgByJson?.(depPkgJson)
      if (isFrameworkPkg || isSemiFrameworkPkg) {
        // see explanation in filter condition above
        if (isFrameworkPkg) {
          optimizeDepsExclude.push(dep)
          ssrNoExternal.push(dep)
        } else if (isSemiFrameworkPkg) {
          ssrNoExternal.push(dep)
        }
        return crawl(depPkgJsonPath, depPkgJson, parentDepNames.concat(dep))
      }

      // if we're crawling in a non-root state, the parent is 100% a framework package
      // because of the above if block. in this case, if it's dep of a non-framework
      // package, handle special cases for them.
      if (!isRoot) {
        // deep include it if it's a CJS package, so it becomes ESM and vite is happy.
        if (pkgJsonNeedsOptimization(depPkgJson)) {
          optimizeDepsInclude.push(parentDepNames.concat(dep).join(' > '))
        }
        // also externalize it in dev so it doesn't trip vite's SSR transformation.
        // we do in dev only as build cannot access deep external packages in strict
        // dependency installations, such as pnpm.
        if (!options.isBuild && !ssrExternal.includes(dep)) {
          ssrExternal.push(dep)
        }
      }
    })

    await Promise.all(promises)
  }
}

/** @type {import('..').findDepPkgJsonPath} */
export async function findDepPkgJsonPath(dep, parent) {
  if (pnp) {
    const depRoot = pnp.resolveToUnqualified(dep, parent)
    if (!depRoot) return undefined
    return path.join(depRoot, 'package.json')
  }

  let root = await findClosestPkgJsonPath(parent)
  if (!root) return undefined
  root = path.dirname(root)
  while (root) {
    const pkg = path.join(root, 'node_modules', dep, 'package.json')
    try {
      await fs.access(pkg)
      return await fs.realpath(pkg)
    } catch {}
    const nextRoot = path.dirname(root)
    if (nextRoot === root) break
    root = nextRoot
  }
  return undefined
}

/** @type {import('..').findClosestPkgJsonPath} */
export async function findClosestPkgJsonPath(dir) {
  if (dir.endsWith('package.json')) {
    dir = path.dirname(dir)
  }
  while (dir) {
    const pkg = path.join(dir, 'package.json')
    try {
      await fs.access(pkg)
      return pkg
    } catch {}
    const nextDir = path.dirname(dir)
    if (nextDir === dir) break
    dir = nextDir
  }
  return undefined
}

/** @type {import('..').pkgJsonNeedsOptimization} */
export function pkgJsonNeedsOptimization(pkgJson) {
  // only optimize if is cjs, using the below as heuristic
  // see https://github.com/sveltejs/vite-plugin-svelte/issues/162
  if (pkgJson.module || pkgJson.exports) return false
  // has implicit index.js entrypoint, prebundle
  // see https://github.com/sveltejs/vite-plugin-svelte/issues/281
  if (!pkgJson.main) return true
  // ensure entry is js so vite can prebundle it
  // see https://github.com/sveltejs/vite-plugin-svelte/issues/233
  const entryExt = path.extname(pkgJson.main)
  return !entryExt || entryExt === '.js' || entryExt === '.cjs'
}

/**
 * @param {string} findDepPkgJsonPath
 * @returns {Promise<Record<string, any>>}
 */
async function readJson(findDepPkgJsonPath) {
  return JSON.parse(await fs.readFile(findDepPkgJsonPath, 'utf8'))
}

/**
 * @param {string} target
 * @param {string | RegExp | (string | RegExp)[]} pattern
 */
function isMatch(target, pattern) {
  if (Array.isArray(pattern)) {
    return pattern.some((p) => isMatch(target, p))
  } else if (typeof pattern === 'string') {
    return target === pattern
  } else if (pattern instanceof RegExp) {
    return pattern.test(target)
  }
}
