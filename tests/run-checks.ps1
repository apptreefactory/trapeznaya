$ErrorActionPreference = 'Stop'
$expectedCount = 8
$root = Split-Path -Parent $PSScriptRoot
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$utf8 = [Text.UTF8Encoding]::new($false)
$checks = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'checks.js'), $utf8)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())

function Invoke-PageChecks {
    param([string]$Page, [string]$Mode, [string]$Project = '', [string]$ProjectError = '')

    $dir = Join-Path $tempRoot ('trapeznaya-checks-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $dir
    try {
        $html = [IO.File]::ReadAllText((Join-Path $root $Page), $utf8)
        $bodyEnd = $html.LastIndexOf('</body>', [StringComparison]::OrdinalIgnoreCase)
        if ($bodyEnd -lt 0) { throw "В $Page не найден закрывающий тег body." }
        $projectBase64 = [Convert]::ToBase64String($utf8.GetBytes($Project))
        $errorBase64 = [Convert]::ToBase64String($utf8.GetBytes($ProjectError))
        $script = "<script>window.__CHECK_MODE='$Mode'; window.__CHECK_PROJECT='$projectBase64'; window.__CHECK_PROJECT_ERROR='$errorBase64';" +
                  [Environment]::NewLine + $checks + [Environment]::NewLine + '</script>'
        $pagePath = Join-Path $dir 'check.html'
        [IO.File]::WriteAllText($pagePath, $html.Insert($bodyEnd, $script), $utf8)

        $uri = [uri]::new($pagePath).AbsoluteUri
        foreach ($noSandbox in @($false, $true)) {
            $profile = Join-Path $dir ('profile-' + [int]$noSandbox)
            $edgeArgs = @(
                '--headless=new', '--disable-gpu', ('--user-data-dir="{0}"' -f $profile),
                '--virtual-time-budget=30000', '--dump-dom', '--no-first-run',
                '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync',
                '--host-resolver-rules="MAP * ~NOTFOUND"'
            )
            if ($noSandbox) { $edgeArgs += '--no-sandbox' }
            $edgeArgs += ('"{0}"' -f $uri)
            $browser = [Diagnostics.Process]::new()
            $browser.StartInfo.FileName = $edge
            $browser.StartInfo.Arguments = $edgeArgs -join ' '
            $browser.StartInfo.UseShellExecute = $false
            $browser.StartInfo.CreateNoWindow = $true
            $browser.StartInfo.RedirectStandardOutput = $true
            $browser.StartInfo.RedirectStandardError = $true
            $browser.StartInfo.StandardOutputEncoding = $utf8
            $browser.StartInfo.StandardErrorEncoding = $utf8
            try {
                $null = $browser.Start()
                $stdout = $browser.StandardOutput.ReadToEndAsync()
                $stderr = $browser.StandardError.ReadToEndAsync()
                $streams = [Threading.Tasks.Task[]]@($stdout, $stderr)
                if (![Threading.Tasks.Task]::WaitAll($streams, 50000) -or !$browser.WaitForExit(5000)) {
                    if (!$browser.HasExited) { $browser.Kill() }
                    $problem = 'Edge превысил время ожидания'
                    continue
                }
                $dom = $stdout.Result
                $edgeExit = $browser.ExitCode
                $errorLine = ($stderr.Result -split '\r?\n')[0]
            }
            finally { $browser.Dispose() }
            $match = [regex]::Match($dom, '(?s)<pre\s+id="test-results"[^>]*>(.*?)</pre>')
            if ($edgeExit -eq 0 -and $match.Success) {
                $output = [Net.WebUtility]::HtmlDecode($match.Groups[1].Value) | ConvertFrom-Json
                if ($output.fatal) { throw "$Page — $($output.fatal)" }
                return $output
            }
            $problem = "код Edge $($edgeExit), нет результатов в DOM. $errorLine"
        }
        throw "$Page — $problem"
    }
    finally {
        $resolved = [IO.Path]::GetFullPath($dir)
        if ([IO.Path]::GetDirectoryName($resolved).TrimEnd('\') -eq $tempRoot.TrimEnd('\') -and
            [IO.Path]::GetFileName($resolved) -match '^trapeznaya-checks-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}

try {
    $current = Invoke-PageChecks -Page 'index.html' -Mode 'current'
    $previous = Invoke-PageChecks -Page 'v\2\index.html' -Mode 'v2' -Project $current.project -ProjectError $current.compatibilityError
    $results = @($current.results + $previous.results | Sort-Object id)
    foreach ($test in $results) {
        $label = if ($test.passed -eq $true) { 'ПРОШЛО' } else { 'ПРОВАЛ' }
        $note = if ($test.note) { " — $($test.note)" } else { '' }
        Write-Output ('{0}: {1}{2}' -f $label, $test.name, $note)
    }
    if ($results.Count -ne $expectedCount -or ($results.id -join ',') -ne ((1..$expectedCount) -join ',')) {
        throw "Ожидалось $expectedCount разных тестов, получено $($results.Count)."
    }
    if ($results | Where-Object { $_.passed -ne $true }) { exit 1 }
    exit 0
}
catch {
    Write-Output "ПРОВАЛ: $($_.Exception.Message)"
    exit 1
}
