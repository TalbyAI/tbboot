$requestJson = [Console]::In.ReadToEnd()
$Request = $requestJson | ConvertFrom-Json
Write-Error "pwsh-log:$($Request.operation)" -ErrorAction Continue
[ordered]@{ status = 'ok'; changed = $false; details = @{ language = 'powershell' } } |
  ConvertTo-Json -Compress
