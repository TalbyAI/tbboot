param(
  [Parameter(Mandatory = $true)]
  [string] $ConsumerRoot,
  [ValidateSet('doctor', 'dry-run', 'install')]
  [string] $Mode = 'doctor',
  [string] $SourceRoot = (Join-Path $PSScriptRoot 'chezmoi-source')
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command chezmoi -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine('chezmoi is required for the composition comparison path.')
  exit 2
}

$fixtureRoot = Join-Path $PSScriptRoot '..\fixture\source'
$fragmentFiles = @(
  [pscustomobject]@{ Recipe = 'baseline'; Input = (Join-Path $fixtureRoot '01-baseline\files\agents-block.md') },
  [pscustomobject]@{ Recipe = 'review'; Input = (Join-Path $fixtureRoot '02-review\files\review-block.md') }
)

function Get-FragmentPlan {
  param([string] $Root)

  $target = Join-Path $Root 'AGENTS.md'
  $exists = Test-Path -LiteralPath $target -PathType Leaf
  $content = if ($exists) { Get-Content -LiteralPath $target -Raw } else { '' }
  $plans = @()

  foreach ($fragment in $fragmentFiles) {
    $body = Get-Content -LiteralPath $fragment.Input -Raw
    if (-not $body.EndsWith("`n")) { $body += "`n" }
    $marker = "source/$($fragment.Recipe)"
    $start = "<!-- managed-by: $marker -->"
    $end = "<!-- end-managed-by: $marker -->"
    $startCount = ([regex]::Matches($content, [regex]::Escape($start))).Count
    $endCount = ([regex]::Matches($content, [regex]::Escape($end))).Count

    if ($startCount -gt 1 -or $endCount -gt 1) {
      throw "fragment-marker-collision [$marker] $target"
    }
    if ($startCount -ne $endCount) {
      throw "incomplete-fragment [$marker] $target"
    }

    $block = "$start`n$body$end"
    if ($startCount -eq 0) {
      $separator = if (-not $content) { '' } elseif ($content.EndsWith("`n`n")) { '' } elseif ($content.EndsWith("`n")) { "`n" } else { "`n`n" }
      $next = "$content$separator$block`n"
      $action = if ($exists) { 'update' } else { 'create' }
    } else {
      $startIndex = $content.IndexOf($start)
      $endIndex = $content.IndexOf($end, $startIndex + $start.Length)
      $currentBlock = $content.Substring($startIndex, $endIndex + $end.Length - $startIndex)
      if ($currentBlock -cne $block) { throw "fragment-drift [$marker] $target" }
      $next = $content
      $action = 'noop'
    }

    $content = $next
    $exists = $true
    $plans += [pscustomobject]@{ Action = $action; Target = $target; Content = $content }
  }

  [pscustomobject]@{ Target = $target; Plans = $plans }
}

try {
  $fragmentPlan = Get-FragmentPlan $ConsumerRoot
  $chezmoiArgs = @('--source', $SourceRoot, '--destination', $ConsumerRoot, '--no-pager', 'apply', '--error-on-conflict')
  if ($Mode -ne 'install') { $chezmoiArgs += @('--dry-run', '--verbose') }
  & chezmoi @chezmoiArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  foreach ($fragment in $fragmentPlan.Plans) {
    Write-Output "$($fragment.Action) $($fragment.Target)"
    if ($Mode -eq 'install' -and $fragment.Action -ne 'noop') {
      $parent = Split-Path -Parent $fragment.Target
      if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
      [System.IO.File]::WriteAllText($fragment.Target, $fragment.Content)
    }
  }
} catch {
  Write-Error $_
  exit 1
}
