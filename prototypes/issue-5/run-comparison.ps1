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

function Test-Scenario {
  param([string] $Check, [string] $ConsumerRoot, $Run)
  switch ($Check) {
    'not-applicable' { return 'not applicable' }
    'discovery' { if ((Test-Path (Join-Path $ConsumerRoot '.editorconfig')) -and (Test-Path (Join-Path $ConsumerRoot 'docs\project-guide.md'))) { return 'passed' } return 'failed' }
    'complete-file' { if (Test-Path (Join-Path $ConsumerRoot '.editorconfig')) { return 'passed' } return 'failed' }
    'recipe-local' { if ((Test-Path (Join-Path $ConsumerRoot 'docs\project-guide.md')) -and ((Get-Content (Join-Path $ConsumerRoot 'docs\project-guide.md') -Raw) -match 'recipe-local')) { return 'passed' } return 'failed' }
    'fragments' {
      $content = Get-Content (Join-Path $ConsumerRoot 'AGENTS.md') -Raw
      if (($content -match 'managed-by: source/baseline') -and ($content -match 'managed-by: source/review') -and ($content -match 'Keep this unmanaged text')) { return 'passed' } return 'failed'
    }
    'readonly' { if (($Run.Code -eq 0) -and ($Run.Writes -match 'command: unchanged')) { return 'passed' } return 'failed' }
    'preflight' { if (($Run.Code -eq 1) -and -not (Test-Path (Join-Path $ConsumerRoot '.editorconfig'))) { return 'passed' } return 'failed' }
    'idempotent' { if (($Run.Code -eq 0) -and ($Run.Writes -match 'command: unchanged')) { return 'passed' } return 'failed' }
    'drift' { if (($Run.Code -eq 1) -and ((Get-Content (Join-Path $ConsumerRoot '.editorconfig') -Raw) -match 'local change')) { return 'passed' } return 'failed' }
    'collision' { if (($Run.Code -eq 1) -and -not (Test-Path (Join-Path $ConsumerRoot 'same.txt'))) { return 'passed' } return 'failed' }
    'duplicate' { if (($Run.Code -eq 1) -and -not (Test-Path (Join-Path $ConsumerRoot '.editorconfig'))) { return 'passed' } return 'failed' }
  }
  'failed'
}

function Run-Scenario {
  param(
    [string] $PathKind,
    [string] $Name,
    [string] $Command,
    [string] $PrepareKind,
    [string] $Check
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
    Checks = Test-Scenario $Check $consumer ([pscustomobject]@{
      Code = $run.Code
      Writes = "preparation: $(if ($preparationBefore -eq $before) { 'unchanged' } else { 'changed' }); command: $(if ($before -eq $after) { 'unchanged' } else { 'changed' })"
    })
  }
}

try {
  $scenarios = @(
    [pscustomobject]@{ Name = 'source/recipe discovery'; Command = 'install'; Proposed = ''; Composition = ''; CompositionCoverage = 'unsupported'; ProposedCheck = 'discovery'; CompositionCheck = 'not-applicable'; Notes = 'Proposed path discovers source.yaml and recipe.yaml; the composition adapter has no equivalent.' },
    [pscustomobject]@{ Name = 'complete-file creation'; Command = 'install'; Proposed = ''; Composition = ''; CompositionCoverage = 'adapter-emulated'; ProposedCheck = 'complete-file'; CompositionCheck = 'complete-file'; Notes = 'Composition uses its fixed chezmoi-source; this is adapter-emulated.' },
    [pscustomobject]@{ Name = 'recipe-local input'; Command = 'install'; Proposed = ''; Composition = ''; CompositionCoverage = 'unsupported'; ProposedCheck = 'recipe-local'; CompositionCheck = 'not-applicable'; Notes = 'The composition adapter does not read recipe-local input from recipe.yaml.' },
    [pscustomobject]@{ Name = 'two managed fragments'; Command = 'install'; Proposed = ''; Composition = ''; CompositionCoverage = 'adapter-emulated'; ProposedCheck = 'fragments'; CompositionCheck = 'fragments'; Notes = 'Composition uses fixed fixtureRoot and fragmentFiles through its fragment adapter.' },
    [pscustomobject]@{ Name = 'doctor'; Command = 'doctor'; Proposed = ''; Composition = ''; CompositionCoverage = 'adapter-emulated'; ProposedCheck = 'readonly'; CompositionCheck = 'readonly'; Notes = 'Read-only plan over the adapter inputs.' },
    [pscustomobject]@{ Name = 'dry-run'; Command = 'dry-run'; Proposed = ''; Composition = ''; CompositionCoverage = 'adapter-emulated'; ProposedCheck = 'readonly'; CompositionCheck = 'readonly'; Notes = 'Read-only install plan over the adapter inputs.' },
    [pscustomobject]@{ Name = 'preflight failure'; Command = 'install'; Proposed = 'input-escape'; Composition = ''; CompositionCoverage = 'unsupported'; ProposedCheck = 'preflight'; CompositionCheck = 'not-applicable'; Notes = 'The proposed path rejects a source-input escape; the composition adapter has no source-input preflight.' },
    [pscustomobject]@{ Name = 'identical no-op'; Command = 'install'; Proposed = 'second-install'; Composition = 'second-install'; CompositionCoverage = 'adapter-emulated'; ProposedCheck = 'idempotent'; CompositionCheck = 'idempotent'; Notes = 'Second install preserves bytes through the fixed adapter inputs.' },
    [pscustomobject]@{ Name = 'drift'; Command = 'install'; Proposed = 'complete-drift'; Composition = 'complete-drift'; CompositionCoverage = 'adapter-emulated'; ProposedCheck = 'drift'; CompositionCheck = 'drift'; Notes = 'Complete-file drift is checked through the fixed composition adapter.' },
    [pscustomobject]@{ Name = 'conflict'; Command = 'install'; Proposed = 'target-conflict'; Composition = ''; CompositionCoverage = 'unsupported'; ProposedCheck = 'collision'; CompositionCheck = 'not-applicable'; Notes = 'The proposed path changes recipe.yaml; the composition adapter ignores that input.' },
    [pscustomobject]@{ Name = 'duplicate source reference'; Command = 'install'; Proposed = 'duplicate-source'; Composition = ''; CompositionCoverage = 'unsupported'; ProposedCheck = 'duplicate'; CompositionCheck = 'not-applicable'; Notes = 'Composition has no manifest/source-reference equivalent.' },
    [pscustomobject]@{ Name = 'second install'; Command = 'install'; Proposed = 'second-install'; Composition = 'second-install'; CompositionCoverage = 'adapter-emulated'; ProposedCheck = 'idempotent'; CompositionCheck = 'idempotent'; Notes = 'Idempotence check through the fixed adapter inputs.' }
  )

  $rows = foreach ($scenario in $scenarios) {
    $proposed = Run-Scenario 'proposed' $scenario.Name $scenario.Command $scenario.Proposed $scenario.ProposedCheck
    if ($hasChezmoi -and $scenario.CompositionCoverage -eq 'adapter-emulated') {
      $composition = Run-Scenario 'composition' $scenario.Name $scenario.Command $scenario.Composition $scenario.CompositionCheck
      $compositionText = "adapter-emulated: exit $($composition.Code)"
      $compositionWrites = $composition.Writes
      $compositionDiagnostics = $composition.Diagnostics
      $compositionChecks = $composition.Checks
    } elseif ($hasChezmoi) {
      $compositionText = 'unsupported: not exercised (fixed adapter has no equivalent)'
      $compositionWrites = 'not measured'
      $compositionDiagnostics = 'not applicable'
      $compositionChecks = 'not applicable'
    } else {
      $compositionText = "$($scenario.CompositionCoverage): not run (chezmoi missing; exit 2)"
      $compositionWrites = 'not measured'
      $compositionDiagnostics = 'prerequisite missing'
      $compositionChecks = 'not exercised'
    }
    [pscustomobject]@{
      Name = $scenario.Name
      Composition = $compositionText
      Proposed = "exit $($proposed.Code)"
      Writes = "composition: $compositionWrites; proposed: $($proposed.Writes)"
      Diagnostics = "composition: $compositionDiagnostics; proposed: $($proposed.Diagnostics)"
      Checks = "composition: $compositionChecks; proposed: $($proposed.Checks)"
      ProposedChecks = $proposed.Checks
      CompositionChecks = $compositionChecks
      Notes = $scenario.Notes
    }
  }

  $proposedFiles = @(Get-ChildItem -LiteralPath (Join-Path $scriptRoot 'proposed') -File -Recurse | Where-Object { $_.Extension -eq '.mjs' })
  $compositionFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $scriptRoot 'composition') -File -Recurse | Where-Object { $_.Extension -eq '.ps1' }
    Get-Item -LiteralPath (Join-Path $scriptRoot 'composition.ps1')
  )
  $proposedLines = ($proposedFiles | Get-Content | Measure-Object -Line).Lines
  $compositionLines = ($compositionFiles | Get-Content | Measure-Object -Line).Lines
  $proposedPassed = @($rows | Where-Object { $_.ProposedChecks -eq 'passed' }).Count
  $compositionScenarios = @($scenarios | Where-Object { $_.CompositionCoverage -eq 'adapter-emulated' })
  $compositionUnsupported = @($scenarios | Where-Object { $_.CompositionCoverage -eq 'unsupported' }).Count
  $compositionPassed = @($rows | Where-Object { $_.CompositionChecks -eq 'passed' }).Count
  $rowText = ($rows | ForEach-Object {
    "| $($_.Name) | $($_.Composition) | $($_.Proposed) | $($_.Writes) | $($_.Diagnostics) | $($_.Checks) | $($_.Notes) |"
  }) -join "`n"
  $compositionStatus = if ($hasChezmoi) { "chezmoi detected; adapter-emulated scenarios exercised; $compositionUnsupported unsupported because the fixed adapter does not discover source.yaml or recipe.yaml" } else { "chezmoi missing; adapter-emulated scenarios were not exercised; $compositionUnsupported scenarios are unsupported by the fixed adapter" }
  $compositionCoverage = if ($hasChezmoi) { "$compositionPassed/$($compositionScenarios.Count) adapter-emulated checks passed; $compositionUnsupported unsupported" } else { "not exercised (chezmoi missing); $compositionUnsupported unsupported" }
  $verdict = "Prototype closed. Proposed checks: $proposedPassed/$($rows.Count); composition coverage: $compositionCoverage; setup 3 versus 2 instructions; and $($proposedFiles.Count)/$proposedLines versus $($compositionFiles.Count)/$compositionLines non-fixture code files/lines. Composition coverage is adapter-emulated from fixed compositionSource, fixtureRoot, and fragmentFiles inputs; no native source.yaml or recipe.yaml discovery is claimed. The fixture covers files, fragments, preflight, drift, conflicts, and idempotence, but not command checks, interactive source selection, catalogs, or dependencies. Product decision: build the differentiated tool in TypeScript on Node.js. Missing chezmoi limits the technical comparison coverage but does not block this product decision based on the final scope."
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

Composition rows marked `adapter-emulated` use fixed composition inputs,
including `compositionSource`, `fixtureRoot`, and `fragmentFiles`. Rows marked
`unsupported` have no equivalent in this adapter; it does not discover
`source.yaml` or `recipe.yaml`, so no native composition coverage is claimed.

## Scenario matrix

| Scenario | Composition | Proposed semantics | Writes | Diagnostics | Checks | Notes |
|---|---|---|---|---|---|---|
__ROWS__

## Measured setup and custom code

| Measure | Proposed semantics | Composition |
|---|---:|---:|
| Setup instructions | 3 (`npm install`, `npm test`, CLI/runner) | 2 (install chezmoi, invoke PowerShell; mise optional) |
| Path implementation files | __PROPOSED_FILES__ | __COMPOSITION_FILES__ |
| Path implementation lines | __PROPOSED_LINES__ | __COMPOSITION_LINES__ |

## Verdict

__VERDICT__

This report is generated by `run-comparison.ps1` from the documented commands.
When `chezmoi` is unavailable, the composition column remains explicitly
unexercised instead of substituting another implementation.
'@
  $report = $report.Replace('__DATE__', (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
  $report = $report.Replace('__STATUS__', $compositionStatus)
  $report = $report.Replace('__ROWS__', $rowText)
  $report = $report.Replace('__PROPOSED_FILES__', [string]$proposedFiles.Count)
  $report = $report.Replace('__COMPOSITION_FILES__', [string]$compositionFiles.Count)
  $report = $report.Replace('__PROPOSED_LINES__', [string]$proposedLines)
  $report = $report.Replace('__COMPOSITION_LINES__', [string]$compositionLines)
  $report = $report.Replace('__VERDICT__', $verdict)
  [System.IO.File]::WriteAllText((Join-Path $scriptRoot 'comparison-report.md'), $report)
} finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
