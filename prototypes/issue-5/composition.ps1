param(
  [Parameter(Mandatory = $true)]
  [string] $ConsumerRoot,
  [ValidateSet('doctor', 'dry-run', 'install')]
  [string] $Mode = 'doctor',
  [string] $SourceRoot = (Join-Path $PSScriptRoot 'composition\chezmoi-source')
)

$adapter = Join-Path $PSScriptRoot 'composition\composition.ps1'
$adapterArgs = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', $adapter,
  '-ConsumerRoot', $ConsumerRoot,
  '-Mode', $Mode,
  '-SourceRoot', $SourceRoot
)
& powershell @adapterArgs
exit $LASTEXITCODE
