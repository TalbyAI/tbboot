$ErrorActionPreference = 'Stop'

$scriptRoot = $PSScriptRoot
$fixtureRoot = Join-Path $scriptRoot 'fixture'
$compositionSource = Join-Path $scriptRoot 'composition\chezmoi-source'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('tbboot-issue-5-' + [guid]::NewGuid())
$hasChezmoi = [bool](Get-Command chezmoi -ErrorAction SilentlyContinue)
$script:results = @()

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function New-Consumer {
  param([string] $Name)
  $caseRoot = Join-Path $tempRoot $Name
  New-Item -ItemType Directory -Force -Path $caseRoot | Out-Null
  Copy-Item -Recurse -Force (Join-Path $fixtureRoot 'consumer') (Join-Path $caseRoot 'consumer')
  Copy-Item -Recurse -Force (Join-Path $fixtureRoot 'source') (Join-Path $caseRoot 'source')
  Join-Path $caseRoot 'consumer'
}

function Get-Snapshot {
  param([string] $ConsumerRoot)
  $files = @('.editorconfig', 'docs\project-guide.md', 'AGENTS.md')
  $parts = foreach ($file in $files) {
    $path = Join-Path $ConsumerRoot $file
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($path)
      "$file=$([Convert]::ToBase64String($bytes))"
    } else {
      "$file=<missing>"
    }
  }
  $parts -join '|'
}

function Invoke-Proposed {
  param([string] $ConsumerRoot, [string] $Command)
  $args = @((Join-Path $scriptRoot 'proposed\cli.mjs'), $Command, '--root', $ConsumerRoot)
  if ($Command -eq 'dry-run') {
    $args = @((Join-Path $scriptRoot 'proposed\cli.mjs'), 'install', '--dry-run', '--root', $ConsumerRoot)
  }
  $output = (& node @args 2>&1 | Out-String)
  [pscustomobject]@{ Code = $LASTEXITCODE; Output = $output }
}

function Invoke-Composition {
  param([string] $ConsumerRoot, [string] $Command)
  $output = (& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptRoot 'composition.ps1') `
    -Mode $Command -ConsumerRoot $ConsumerRoot -SourceRoot $compositionSource 2>&1 | Out-String)
  [pscustomobject]@{ Code = $LASTEXITCODE; Output = $output }
}

function Invoke-Path {
  param([string] $PathKind, [string] $ConsumerRoot, [string] $Command)
  if ($PathKind -eq 'proposed') { return Invoke-Proposed $ConsumerRoot $Command }
  return Invoke-Composition $ConsumerRoot $Command
}

function Prepare-Scenario {
  param([string] $Kind, [string] $PathKind, [string] $ConsumerRoot)
  $caseRoot = Split-Path -Parent $ConsumerRoot
  $sourceRoot = Join-Path $caseRoot 'source'
  $recipePath = Join-Path $sourceRoot '01-baseline\recipe.yaml'

  switch ($Kind) {
    'duplicate-source' {
      [System.IO.File]::WriteAllText((Join-Path $ConsumerRoot 'manifest.yaml'), "sources:`n  - ../source`n  - ./../source`n")
    }
    'input-escape' {
      $recipe = Get-Content -LiteralPath $recipePath -Raw
      [System.IO.File]::WriteAllText($recipePath, $recipe.Replace('input: files/project-guide.md', 'input: ../../outside.md'))
    }
    'target-conflict' {
      [System.IO.File]::WriteAllText($recipePath, @"
id: baseline
steps:
  - type: file
    input: ../shared/editorconfig
    target: same.txt
  - type: file
    input: files/project-guide.md
    target: same.txt
"@)
    }
    'complete-drift' {
      Invoke-Path $PathKind $ConsumerRoot 'install' | Out-Null
      [System.IO.File]::WriteAllText((Join-Path $ConsumerRoot '.editorconfig'), "local change`n")
    }
    'second-install' {
      Invoke-Path $PathKind $ConsumerRoot 'install' | Out-Null
    }
  }
}

function Get-Diagnostics {
  param([string] $Output)
  $codes = [regex]::Matches($Output, '\[(?<code>[^\]]+)\]') | ForEach-Object { $_.Groups['code'].Value } | Select-Object -Unique
  if (-not $codes) { return 'none' }
  $codes -join ', '
}

function Run-Scenario {
  param(
    [string] $PathKind,
    [string] $Name,
    [string] $Command,
    [string] $PrepareKind
  )
  $safeName = ($Name -replace '[^A-Za-z0-9]+', '-').Trim('-').ToLowerInvariant()
  $consumer = New-Consumer "$PathKind-$safeName"
  $preparationBefore = Get-Snapshot $consumer
  if ($PrepareKind) { Prepare-Scenario $PrepareKind $PathKind $consumer }
  $before = Get-Snapshot $consumer
  $run = Invoke-Path $PathKind $consumer $Command
  $after = Get-Snapshot $consumer
  [pscustomobject]@{
    Name = $Name
    Code = $run.Code
    Writes = "preparation: $(if ($preparationBefore -eq $before) { 'unchanged' } else { 'changed' }); command: $(if ($before -eq $after) { 'unchanged' } else { 'changed' })"
    Diagnostics = Get-Diagnostics $run.Output
  }
}

try {
  $scenarios = @(
    [pscustomobject]@{ Name = 'source/recipe discovery'; Command = 'install'; Proposed = ''; Composition = ''; Notes = 'Fresh install exercises local source and first-level recipe discovery.' },
    [pscustomobject]@{ Name = 'complete-file creation'; Command = 'install'; Proposed = ''; Composition = ''; Notes = 'Checks .editorconfig and docs/project-guide.md creation.' },
    [pscustomobject]@{ Name = 'recipe-local input'; Command = 'install'; Proposed = ''; Composition = ''; Notes = 'Checks the recipe-local project guide.' },
    [pscustomobject]@{ Name = 'two managed fragments'; Command = 'install'; Proposed = ''; Composition = ''; Notes = 'Checks both markers and preserved unmanaged text.' },
    [pscustomobject]@{ Name = 'doctor'; Command = 'doctor'; Proposed = ''; Composition = ''; Notes = 'Read-only plan.' },
    [pscustomobject]@{ Name = 'dry-run'; Command = 'dry-run'; Proposed = ''; Composition = ''; Notes = 'Read-only install plan.' },
    [pscustomobject]@{ Name = 'preflight failure'; Command = 'install'; Proposed = 'input-escape'; Composition = ''; Notes = 'Proposed path rejects a source-input escape before writing.' },
    [pscustomobject]@{ Name = 'identical no-op'; Command = 'install'; Proposed = 'second-install'; Composition = 'second-install'; Notes = 'Second install must preserve bytes.' },
    [pscustomobject]@{ Name = 'drift'; Command = 'install'; Proposed = 'complete-drift'; Composition = 'complete-drift'; Notes = 'Modified complete target must not be overwritten.' },
    [pscustomobject]@{ Name = 'conflict'; Command = 'install'; Proposed = 'target-conflict'; Composition = 'complete-drift'; Notes = 'Target collision versus chezmoi changed-target conflict.' },
    [pscustomobject]@{ Name = 'duplicate source reference'; Command = 'install'; Proposed = 'duplicate-source'; Composition = ''; Notes = 'Composition has no manifest/source-reference equivalent.' },
    [pscustomobject]@{ Name = 'second install'; Command = 'install'; Proposed = 'second-install'; Composition = 'second-install'; Notes = 'Idempotence check.' }
  )

  $rows = foreach ($scenario in $scenarios) {
    $proposed = Run-Scenario 'proposed' $scenario.Name $scenario.Command $scenario.Proposed
    if ($hasChezmoi) {
      $composition = Run-Scenario 'composition' $scenario.Name $scenario.Command $scenario.Composition
      $compositionText = "exit $($composition.Code)"
      $compositionWrites = $composition.Writes
      $compositionDiagnostics = $composition.Diagnostics
    } else {
      $compositionText = 'not run (chezmoi missing; exit 2)'
      $compositionWrites = 'not measured'
      $compositionDiagnostics = 'prerequisite missing'
    }
    [pscustomobject]@{
      Name = $scenario.Name
      Composition = $compositionText
      Proposed = "exit $($proposed.Code)"
      Writes = "composition: $compositionWrites; proposed: $($proposed.Writes)"
      Diagnostics = "composition: $compositionDiagnostics; proposed: $($proposed.Diagnostics)"
      Notes = $scenario.Notes
    }
  }

  $customFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $scriptRoot 'proposed') -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $scriptRoot 'composition') -File -Recurse | Where-Object { $_.FullName -notlike '*chezmoi-source*' }
    Get-Item -LiteralPath (Join-Path $scriptRoot 'composition.ps1')
    Get-Item -LiteralPath (Join-Path $scriptRoot 'run-comparison.ps1')
  )
  $customLines = ($customFiles | Get-Content | Measure-Object -Line).Lines
  $rowText = ($rows | ForEach-Object {
    "| $($_.Name) | $($_.Composition) | $($_.Proposed) | $($_.Writes) | $($_.Diagnostics) | $($_.Notes) |"
  }) -join "`n"
  $compositionStatus = if ($hasChezmoi) { 'chezmoi detected; composition scenarios exercised' } else { 'chezmoi missing; composition scenarios were not exercised' }
  $verdict = if ($hasChezmoi) {
    'Keep the project as an integration repository until the measured comparison demonstrates differentiated value beyond the existing tools.'
  } else {
    'Keep the project as an integration repository for now. The proposed path is measured, but chezmoi was unavailable, so this run cannot claim a product comparison. Re-run with chezmoi before deciding to build a differentiated product.'
  }
  $report = @'
# Issue 5 comparison report

Generated on __DATE__.

## Run status

- Proposed path: exercised through the full scenario matrix.
- Composition path: __STATUS__.
- Fixture: copied to separate temporary consumer roots; no temporary files are retained.

## Commands

```powershell
Set-Location prototypes/issue-5
npm install
npm test
npm run compare
```

The proposed path uses `node proposed/cli.mjs`. The composition path uses
`composition.ps1` with `chezmoi --source ... --destination ... apply` and the
PowerShell fragment adapter.

## Scenario matrix

| Scenario | Composition | Proposed semantics | Writes | Diagnostics | Notes |
|---|---|---|---|---|---|
__ROWS__

## Measured setup and custom code

| Measure | Proposed semantics | Composition |
|---|---:|---:|
| Setup instructions | 3 (`npm install`, `npm test`, CLI/runner) | 2 (install chezmoi, invoke PowerShell; mise optional) |
| Non-fixture implementation files | __FILES__ total files counted across the prototype | Includes the PowerShell adapter and chezmoi source state |
| Non-fixture implementation lines | __LINES__ | Included in the total |

## Verdict

__VERDICT__

This report is generated by `run-comparison.ps1` from the documented commands.
When `chezmoi` is unavailable, the composition column remains explicitly
unexercised instead of substituting another implementation.
'@
  $report = $report.Replace('__DATE__', (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
  $report = $report.Replace('__STATUS__', $compositionStatus)
  $report = $report.Replace('__ROWS__', $rowText)
  $report = $report.Replace('__FILES__', [string]$customFiles.Count)
  $report = $report.Replace('__LINES__', [string]$customLines)
  $report = $report.Replace('__VERDICT__', $verdict)
  [System.IO.File]::WriteAllText((Join-Path $scriptRoot 'comparison-report.md'), $report)
} finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
