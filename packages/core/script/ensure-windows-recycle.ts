import { $ } from "bun"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")

export const windowsRecycleProject = path.join(root, "src", "windows-recycle", "OpenCode.Windows.RecycleBin.csproj")

export const windowsRecycleAssembly = path.join(
  root,
  "src",
  "windows-recycle",
  "bin",
  "Release",
  "netstandard2.0",
  "OpenCode.Windows.RecycleBin.dll",
)

export async function buildWindowsRecycleHelper() {
  const result = await $`dotnet build ${windowsRecycleProject} --configuration Release`.quiet().nothrow()
  if (result.exitCode === 0) return
  if (result.stdout.length > 0) process.stderr.write(result.stdout)
  if (result.stderr.length > 0) process.stderr.write(result.stderr)
  throw new Error("Failed to build the Windows Recycle Bin helper")
}

if (import.meta.main && process.platform === "win32") {
  await buildWindowsRecycleHelper()
}
