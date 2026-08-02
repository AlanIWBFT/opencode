export type BuildTarget = {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

function readTargetArgument(args: string[]) {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--target") {
      const value = args[index + 1]
      if (!value || value.startsWith("--")) throw new Error("--target requires a value")
      values.push(value)
      index++
      continue
    }
    if (arg.startsWith("--target=")) values.push(arg.slice("--target=".length))
  }
  if (values.length > 1) throw new Error("--target may only be specified once")
  if (values.length === 0) return

  const match = /^(linux|darwin|windows)-(arm64|x64)$/.exec(values[0])
  if (!match) {
    throw new Error(`Unsupported build target ${JSON.stringify(values[0])}. Expected <linux|darwin|windows>-<arm64|x64>`)
  }
  return {
    os: match[1] === "windows" ? "win32" : match[1],
    arch: match[2] as BuildTarget["arch"],
  }
}

export function selectBuildTargets(
  allTargets: BuildTarget[],
  args: string[],
  host: { os: string; arch: string },
) {
  const single = args.includes("--single")
  const baseline = args.includes("--baseline")
  const requested = readTargetArgument(args)
  if (requested && !single) throw new Error("--target requires --single")
  if (!single) return allTargets

  const os = requested?.os ?? host.os
  const arch = requested?.arch ?? host.arch
  const targets = allTargets.filter((item) => {
    if (item.os !== os || item.arch !== arch) return false

    // Baseline adds the compatibility binary while preserving the existing
    // native single-target output.
    if (item.avx2 === false) return baseline
    if (item.abi !== undefined) return false
    return true
  })
  if (targets.length === 0) throw new Error(`No build target matches ${os}-${arch}`)
  return targets
}
