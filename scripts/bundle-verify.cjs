const esbuild = require('esbuild')
const path = require('node:path')
const fs = require('node:fs')

const resolveTs = (target) => {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target
  for (const ext of ['.ts', '.tsx', '.js', '.mts']) {
    if (fs.existsSync(target + ext)) return target + ext
  }
  for (const ext of ['.ts', '.tsx', '.js']) {
    const index = path.join(target, 'index' + ext)
    if (fs.existsSync(index)) return index
  }
  return target
}

const aliasPlugin = {
  name: 'at-alias',
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => ({
      path: resolveTs(path.resolve(__dirname, '..', 'src', args.path.slice(2))),
    }))
  },
}

const entry = process.argv[2]
  ? path.resolve(__dirname, '..', process.argv[2])
  : path.resolve(__dirname, '..', 'scripts', 'verify-chain.mts')
const outName = path.basename(entry).replace(/\.mts$/, '.mjs')

esbuild
  .build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
    resolveExtensions: ['.ts', '.js', '.mts', '.cjs'],
    outfile: path.resolve(__dirname, '..', 'node_modules', '.cache', outName),
    plugins: [aliasPlugin],
    logLevel: 'info',
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
