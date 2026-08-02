import { describe, expect, test } from "bun:test"
import { selectBuildTargets, type BuildTarget } from "../../script/target-selection"

const targets: BuildTarget[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

describe("build target selection", () => {
  test("keeps all targets without --single", () => {
    expect(selectBuildTargets(targets, [], { os: "win32", arch: "x64" })).toEqual(targets)
  })

  test("selects the native host by default", () => {
    expect(selectBuildTargets(targets, ["--single"], { os: "win32", arch: "arm64" })).toEqual([
      { os: "win32", arch: "arm64" },
    ])
  })

  test("selects an explicit cross-architecture target", () => {
    expect(
      selectBuildTargets(targets, ["--single", "--target=windows-x64", "--baseline"], {
        os: "win32",
        arch: "arm64",
      }),
    ).toEqual([
      { os: "win32", arch: "x64" },
      { os: "win32", arch: "x64", avx2: false },
    ])
  })

  test("accepts the separated target form", () => {
    expect(
      selectBuildTargets(targets, ["--single", "--target", "linux-x64"], { os: "win32", arch: "arm64" }),
    ).toEqual([{ os: "linux", arch: "x64" }])
  })

  test("rejects invalid target arguments", () => {
    expect(() => selectBuildTargets(targets, ["--target=windows-x64"], { os: "win32", arch: "arm64" })).toThrow(
      "--target requires --single",
    )
    expect(() =>
      selectBuildTargets(targets, ["--single", "--target=freebsd-x64"], { os: "win32", arch: "arm64" }),
    ).toThrow("Unsupported build target")
    expect(() => selectBuildTargets(targets, ["--single", "--target"], { os: "win32", arch: "arm64" })).toThrow(
      "--target requires a value",
    )
  })
})
