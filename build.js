#!/usr/bin/env node
const { build, cliopts, file, ts, log } = require("./dist/estrella")
const Path = require("path")
const pkg = require("./package.json")

const common = {
  target: "node12",
  platform: "node",
  define: {
    VERSION: JSON.stringify(pkg.version),
    _runtimeRequire: "require",
  },
  tslint: { format: "short" },
  external: [ "esbuild", "fsevents", "typescript" ],
  bundle: true,
  sourcemap: true,

  async onEnd(config, buildResult) {
    if (!config.debug && buildResult.errors.length == 0) {
      const outfile = Path.join(config.cwd, config.outfile)

      // strip "/*!...*/" comments
      let js = file.readSync(outfile, "utf8")
      js = js.replace(/\/\*\!([\s\S]*?)\*\/\n*/g, "")
      file.writeSync(outfile, js, "utf8")

      // patch source map file locations to include the string "<estrella>"
      // which is used to detect a bug in estrella at runtime. See src/error.ts
      const map = JSON.parse(file.readSync(outfile + ".map", "utf8"))
      map.sources = map.sources.map(fn =>
        fn.startsWith("src/") ? "<estrella>" + fn.substr(3) :
        fn
      )
      file.writeSync(outfile + ".map", JSON.stringify(map))
    }
  }
}

build({ ...common,
  entry: "src/estrella.js",
  outfile: cliopts.debug ? "dist/estrella.g.js" : "dist/estrella.js",
  outfileMode: "+x",
  async onStart(config, changedFiles) {
    await generate_typeinfo_srcfile_if_needed()
  },
  async onEnd(config, buildResult) {
    await common.onEnd(config, buildResult)
    if (config.debug && buildResult.errors.length == 0) {
      // [debug mode only]
      // copy typedefs so that local examples and tests have types colocated with the
      // build products to enable type annotations in IDEs when importing relative paths.
      await Promise.all([
        file.copy("estrella.d.ts", "dist/estrella.d.ts"),
        file.copy("estrella.d.ts", "dist/estrella.g.d.ts"),
      ])
    }
  }
})

build({ ...common,
  entry: "src/debug/debug.ts",
  outfile: cliopts.debug ? "dist/debug.g.js" : "dist/debug.js",
})

build({ ...common,
  entry: "src/watch/watch.ts",
  outfile: cliopts.debug ? "dist/watch.g.js" : "dist/watch.js",
})

build({ ...common,
  entry: "src/register.ts",
  outfile: cliopts.debug ? "dist/register.g.js" : "dist/register.js",
})


// This function generates src/typeinfo.ts describing available properties of the interfaces
// estrella.BuildConfig and esbuild.BuildOptions, used by estrella to filter and verify options
// passed to build()
async function generate_typeinfo_srcfile_if_needed() {
  const outfile = "src/typeinfo.ts"
  const esbuildPFile = "./node_modules/esbuild/package.json"
  const esbuildPkg = require(esbuildPFile)
  const esbuildDFile = Path.resolve(Path.dirname(esbuildPFile), esbuildPkg.types)
  const estrellaDFile = "./estrella.d.ts"

  // Check the generated file's mtime against other files that influence its contents.
  // If outfile is present and younger than influencing files, skip generation.
  const mtimes = await file.mtime(outfile, esbuildDFile, esbuildPFile, estrellaDFile, __filename)
  const outfileMtime = mtimes.shift()
  if (outfileMtime >= Math.max(...mtimes)) {
    // outfile is up-to date
    log.debug(`${outfile} is up-to date; skipping codegen`)
    return
  }

  // Use TypeScript to extract information about interesting interface types
  const BuildOptions = await ts.interfaceInfo(esbuildDFile, "BuildOptions")
  const BuildConfig = await ts.interfaceInfo(estrellaDFile, "BuildConfig")

  // fmtlist formats a list of data as JSON
  const fmtprops = props => {
    let s = "new Set([\n"
    const keys = {}
    const keyMaxlen = Object.keys(props).reduce((a, name) =>
      Math.max(a, JSON.stringify(name).length), 0)
    for (let name of Object.keys(props)) {
      const typeinfo = props[name].typestr.replace(/[\s\n]+/g, " ")
      s += `    ${JSON.stringify(name).padEnd(keyMaxlen, " ")} , // ${typeinfo}\n`
    }
    s += "  ])"
    return s
  }

  // using a template, write outfile (must be writeSync so we don't write partial file)
  log.info(`generated ${outfile} from ${[esbuildDFile,estrellaDFile].join(", ")}`)
  file.writeSync(outfile, `
// Do not edit. Generated by build.js

export const esbuild = {
  version:      ${JSON.stringify(esbuildPkg.version)},
  BuildOptions: ${fmtprops(BuildOptions.computedProps())}, // BuildOptions
}

export const estrella = {
  BuildConfig: ${fmtprops(BuildConfig.props)}, // BuildConfig
}
  `.trim())
}
