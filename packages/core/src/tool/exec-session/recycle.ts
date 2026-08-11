import path from "node:path"
import { fileURLToPath } from "node:url"

const WINDOWS_RECYCLE_HELPER = "OpenCode.Windows.RecycleBin.dll"
const WINDOWS_RECYCLE_PROTOCOL = 2

function windowsRecycleHelperPath() {
  const runtime = path.basename(process.execPath).toLowerCase()
  if (!["bun", "bun.exe", "node", "node.exe"].includes(runtime)) {
    return path.join(path.dirname(process.execPath), WINDOWS_RECYCLE_HELPER)
  }
  return fileURLToPath(
    new URL(`../../windows-recycle/bin/Release/netstandard2.0/${WINDOWS_RECYCLE_HELPER}`, import.meta.url),
  )
}

export function powershellRecyclePrelude() {
  const helper = `'${windowsRecycleHelperPath().replaceAll("'", "''")}'`
  return String.raw`
function __opencodeBlockedDelete {
  param(
    [Parameter(Mandatory = $true)] [string] $Reason,
    [System.Exception] $Exception
  )

  $message = @("Deletion could not be completed safely: $Reason")
  if ($null -ne $Exception) {
    $root = $Exception.GetBaseException()
    $message += "Cause: $($root.GetType().FullName): $($root.Message)"
  }
  $message += @(
    'The target was not deleted. Filesystem deletion is only performed through the Recycle Bin.'
    'Do not bypass this safeguard or retry with permanent deletion; ask the user how to proceed.'
  )
  throw ($message -join [Environment]::NewLine)
}

function __opencodeEnsureRecycleApi {
  if ($null -eq ('OpenCode.Windows.RecycleBin' -as [type])) {
    try {
      $null = [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes(${helper}))
    } catch {
      __opencodeBlockedDelete -Reason 'the Recycle Bin helper is unavailable.' -Exception $_.Exception
    }
  }

  if ([OpenCode.Windows.RecycleBin]::ProtocolVersion -ne ${WINDOWS_RECYCLE_PROTOCOL}) {
    __opencodeBlockedDelete -Reason 'the Recycle Bin helper protocol is incompatible.'
  }
}

function __opencodeRecycleFailureReason {
  param(
    [Parameter(Mandatory = $true)] [string] $Target,
    [Parameter(Mandatory = $true)] [string] $Kind,
    [Parameter(Mandatory = $true)] [object] $Result
  )

  $code = if ([string]::IsNullOrWhiteSpace($Result.HResultName)) { $Result.HResultHex } else { $Result.HResultName }
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("the Recycle Bin operation failed for the $($Kind): $Target. $($code): $($Result.Message)")
  $diagnosis = $Result.LockDiagnosis
  if ($null -eq $diagnosis) { return ($lines -join [Environment]::NewLine) }

  if ($diagnosis.BlockingItems.Count -eq 0) {
    $lines.Add('The specific blocking item could not be identified; it may have been released before diagnosis completed.')
  } else {
    $lines.Add('Blocking items observed at diagnosis time:')
    foreach ($blockingItem in $diagnosis.BlockingItems) {
      $blockingKind = if ($blockingItem.Kind -eq 'mapped-image') {
        'loaded image'
      } elseif ($blockingItem.Kind -eq 'mapped-file') {
        'memory-mapped file'
      } else {
        'open handle denies deletion'
      }
      $processes = [System.Collections.Generic.List[string]]::new()
      foreach ($process in $blockingItem.Processes) {
        $name = if ([string]::IsNullOrWhiteSpace($process.Name)) { 'process' } else { $process.Name }
        $processes.Add("$name (PID $($process.ProcessId))")
      }
      $owner = if ($processes.Count -eq 0) { '' } else { '; ' + ($processes -join ', ') }
      $lines.Add("- $($blockingItem.Path) ($blockingKind$owner)")
    }
  }
  if (-not $diagnosis.Complete) {
    $lines.Add('Lock diagnosis was partial; additional blocking items or process details may not have been identified.')
  }
  return ($lines -join [Environment]::NewLine)
}

function __opencodeRecycle {
  param(
    [Parameter(Mandatory = $true)] [string] $Target,
    [Parameter(Mandatory = $true)] [string] $Kind
  )

  try {
    $result = [OpenCode.Windows.RecycleBin]::Recycle($Target)
  } catch {
    __opencodeBlockedDelete -Reason "the Recycle Bin helper failed for the $($Kind): $Target." -Exception $_.Exception
  }
  if ($result.Succeeded) { return }
  __opencodeBlockedDelete -Reason (__opencodeRecycleFailureReason -Target $Target -Kind $Kind -Result $result)
}

function __opencodeResolveRemoveItemTargets {
  param(
    [object[]] $Value,
    [bool] $Literal,
    [bool] $Force,
    [Parameter(Mandatory = $true)] [System.Management.Automation.PSCmdlet] $Cmdlet
  )

  foreach ($item in $Value) {
    if ($null -eq $item) { continue }
    try {
      if ($null -ne $item.PSObject.Properties['PSPath']) {
        Get-Item -LiteralPath $item.PSPath -Force -ErrorAction Stop
        continue
      }
      if ($Literal) {
        Get-Item -LiteralPath ([string] $item) -Force -ErrorAction Stop
        continue
      }
      Get-Item -Path ([string] $item) -Force -ErrorAction Stop
    } catch [System.Management.Automation.ItemNotFoundException] {
      $errorRecord = $_
      $provider = $null
      $drive = $null
      $providerPath = if ($null -ne $item.PSObject.Properties['PSPath']) { [string] $item.PSPath } else { [string] $item }
      try {
        $null = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($providerPath, [ref] $provider, [ref] $drive)
      } catch {
        __opencodeBlockedDelete -Reason "the target provider could not be resolved: $item." -Exception $_.Exception
      }
      if ($null -ne $provider -and $provider.Name -ne 'FileSystem') {
        $Cmdlet.WriteError($errorRecord)
        continue
      }
      __opencodeBlockedDelete -Reason "the target could not be resolved to an existing item: $item." -Exception $errorRecord.Exception
    } catch {
      __opencodeBlockedDelete -Reason "the target could not be resolved to an existing item: $item." -Exception $_.Exception
    }
  }
}

function __opencodeMoveToRecycleBin {
  param(
    [Parameter(Mandatory = $true)] [object] $Item,
    [Parameter(Mandatory = $true)] [System.Management.Automation.PSCmdlet] $Cmdlet,
    [bool] $Recurse,
    [bool] $Force
  )

  if ($null -eq $Item.PSObject.Properties['PSProvider'] -or $Item.PSProvider.Name -ne 'FileSystem') {
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $Item.PSPath -Recurse:$Recurse -Force:$Force
    return
  }

  $target = if ($null -ne $Item.PSObject.Properties['FullName']) {
    [string] $Item.FullName
  } else {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Item.PSPath)
  }

  if (-not $Cmdlet.ShouldProcess($target, 'Move to Recycle Bin')) { return }
  __opencodeEnsureRecycleApi

  if ([System.IO.Directory]::Exists($target)) {
    __opencodeRecycle -Target $target -Kind 'directory'
    return
  }

  if ([System.IO.File]::Exists($target)) {
    __opencodeRecycle -Target $target -Kind 'file'
    return
  }

  __opencodeBlockedDelete "the filesystem target no longer exists: $target."
}

function Remove-Item {
  [CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = 'Path')]
  param(
    [Parameter(Position = 0, ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true, ParameterSetName = 'Path')]
    [SupportsWildcards()]
    [object[]] $Path,

    [Parameter(ValueFromPipelineByPropertyName = $true, ParameterSetName = 'LiteralPath')]
    [Alias('PSPath', 'LP')]
    [object[]] $LiteralPath,

    [switch] $Recurse,
    [switch] $Force
  )

  process {
    $values = if ($PSCmdlet.ParameterSetName -eq 'LiteralPath') { $LiteralPath } else { $Path }
    if ($null -eq $values) { throw 'Remove-Item requires a path.' }
    foreach ($item in (__opencodeResolveRemoveItemTargets -Value $values -Literal:($PSCmdlet.ParameterSetName -eq 'LiteralPath') -Force:$Force -Cmdlet $PSCmdlet)) {
      __opencodeMoveToRecycleBin -Item $item -Cmdlet $PSCmdlet -Recurse:$Recurse -Force:$Force
    }
  }
}

foreach ($__opencodeAlias in @('rm', 'del', 'erase', 'rmdir', 'rd')) {
  Set-Alias -Name $__opencodeAlias -Value Remove-Item -Option AllScope -Force
}
`
}
