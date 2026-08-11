import { ShellSelect } from "../../shell/select.js"
import { persistentShellPosix, persistentShellSupported } from "./shell.js"

export function description(shell?: string, platform: NodeJS.Platform = process.platform) {
  return [
    "Execute a shell command and return early with partial output while the process may continue running.",
    shell
      ? shellDescription(shell, platform)
      : "Use the configured persistent shell described in the session instructions.",
    "Every command runs in a persistent slot. Use lane_id=0 for ordinary sequential work and reuse the same slot for cwd, environment variables, functions, modules, and activated environments.",
    "Use different numeric slots for commands that must run concurrently (slots 0 through 7 per session). Never submit parallel commands to the same slot.",
    "Execution output is the control-sequence-free transcript observed from the shared slot while that execution is active, not process-attributed output. Output emitted while no execution is active (for example from background processes still running after a command finishes) is discarded.",
    'Each poll_exec call returns only newly arrived output; output not yet returned stays buffered and is delivered by later polls, so polling less frequently does not lose output. If bursts exceed the 256KB buffer while an execution is running, the middle is dropped once and marked as "... N bytes omitted ...".',
    "When an execution completes, its remaining buffered output (up to the 256KB buffer, head and tail) is returned and consumed by the chunk that reports running=false. Later poll_exec calls return the completion status without replaying that output. Keep polling until running=false to guarantee you receive the final output.",
    "Keep long-running work in the foreground when it needs reliable polling, input, termination, and transcript continuity. Work left running after the shell command completes is not managed, and its output may interleave with a later execution in the same slot.",
    "Use reset_lane=true when a command needs a clean shell. A busy slot must be terminated before it can be reset.",
    "If a slot's shell state was lost, the next command automatically creates a new generation and reports that inherited shell state was reset.",
    "If a slot reports that its environment changed, retry with reset_lane=true; reset deliberately discards the old shell generation.",
    "Use poll_exec with the returned exec_id to collect more output.",
    "Use write_stdin with the returned exec_id only when the current command is waiting for that exact input. Unconsumed input can be read by the slot protocol after the command exits.",
    "Use terminate_exec to stop a running execution and end its slot generation.",
    "Set tty=true when creating or resetting a slot for a REPL, Read-Host, or a full-screen terminal program.",
    "To switch an existing slot between non-TTY and TTY, pass the desired tty value and reset_lane=true in the same call. This discards its shell state; use another unused slot to preserve it. Omitting tty reuses the current mode; creating or resetting a slot defaults to tty=false.",
    "Avoid Git commands that open an editor. Use explicit message/no-edit flags, or GIT_EDITOR=true for that command only when continuing a rebase, merge, or cherry-pick. When accepting a generated rebase todo (including --autosquash), set GIT_SEQUENCE_EDITOR=true for that command; GIT_EDITOR alone does not suppress the todo editor. Restore any temporary environment changes afterward because the slot persists.",
  ].join("\n")
}

export function shellDescription(shell: string, platform: NodeJS.Platform) {
  if (platform === "linux")
    return [
      "Commands run in Bash on `linux`, independently of config.shell and $SHELL. Bash must be installed on PATH; there is no fallback to sh.",
      "Pass only the Bash command body. The tool uses non-interactive `bash --noprofile --norc -p`, with -s for pipes and /dev/stdin as the script for PTYs. It inherits OpenCode's prepared environment without importing shell options/functions or running login profiles, bashrc, or prompt hooks; BASH_ENV and ENV are empty at lane creation.",
      "Each lane starts in normal Bash mode with the installed version's default compatibility behavior. tty=true gives child programs a terminal, not an interactive parent shell. Ctrl+C can end the lane generation; the next command rebuilds it if needed.",
      "Bash arrays, [[ ... ]], process substitution and pipefail are available. Explicitly source any additional environment setup; cwd, variables and functions persist in the lane.",
      "Invoke zsh, fish, sh or another interpreter explicitly when needed. Changes to a nested shell's cwd, variables or functions do not propagate back to the Bash lane.",
    ].join("\n")
  const name = ShellSelect.name(shell)
  const display =
    name === "pwsh"
      ? "PowerShell 7+ (`pwsh`)"
      : name === "powershell"
        ? "Windows PowerShell 5.1 (`powershell`)"
        : name === "cmd"
          ? "`cmd.exe`"
          : `\`${name}\``
  const launch = persistentShellPosix(shell)
    ? `\`${name} -l\` as a persistent stdin-driven POSIX shell`
    : name === "cmd"
      ? "`cmd.exe /d /q /v:off` as a persistent shell"
      : ShellSelect.ps(shell)
        ? `\`${name} -NoProfile\` as a persistent shell`
        : `\`${name}\``
  const syntax =
    name === "pwsh"
      ? "PowerShell profiles are not loaded. PowerShell 7 supports `&&` and `||`."
      : name === "powershell"
        ? "PowerShell profiles are not loaded. Windows PowerShell 5.1 does not support `&&` or `||`; use PowerShell conditionals instead."
        : name === "cmd"
          ? "Commands execute from a temporary batch file. Use batch-file syntax, including `%NAME%` for environment variables and `%%A` for FOR variables."
          : persistentShellPosix(shell)
            ? `Use POSIX-compatible ${name} syntax.`
            : "This configured shell does not support the persistent execution protocol."
  return [
    `Commands run in ${display} on \`${platform}\`.`,
    ...(persistentShellSupported(shell, platform)
      ? []
      : ["The configured shell is unsupported; choose PowerShell, cmd, bash, dash, ksh, sh, or zsh."]),
    `Pass only the command body; the tool starts ${launch}. Do not prefix it with another shell launcher unless a nested shell is intentional.`,
    syntax,
    ...(ShellSelect.ps(shell)
      ? [
          "PowerShell console input and output are configured as UTF-8.",
          "A final failing native program's exit code is propagated to the tool result.",
          "exit ends only the current command; use terminate_exec to end the persistent slot generation.",
          ...(platform === "win32"
            ? [
                "Direct filesystem deletion through Remove-Item or an alias resolving to it (rm, ri, del, erase, rmdir, rd) is sent to the Recycle Bin. This applies only to FileSystem provider items in this PowerShell process, not env:/Registry: providers or nested shells/external programs.",
                "Do not bypass the Recycle Bin safeguard with a module-qualified cmdlet, cmd /c, a nested shell, .NET APIs, or another runtime/deletion utility. If recycling fails, stop and ask the user; never retry with permanent deletion.",
              ]
            : []),
        ]
      : []),
  ].join("\n")
}
