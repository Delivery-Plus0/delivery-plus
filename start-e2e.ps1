# Delivery Plus E2E + Observability integration smoke test
# Usage:
#   .\start-e2e.ps1
#   .\start-e2e.ps1 -SkipBuild
#
# Expected layout:
#   open-source/
#     delivery-plus/
#     <observability-agent-repo>/
#       go.mod
#       cmd/investigator/
#       deploy/compose/docker-compose.yml

[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$E2EProject = 'delivery-plus-e2e'
$ObsProject = 'obs-agent-local'
$ObsComposeRelative = 'deploy/compose/docker-compose.yml'

function Write-Step([string]$Message) {
    Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found."
    }
}

function Invoke-Compose {
    param(
        [string]$WorkingDirectory,
        [string[]]$Arguments
    )

    Push-Location $WorkingDirectory
    try {
        & docker compose @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Docker Compose failed in '$WorkingDirectory'."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-ComposeCapture {
    param(
        [string]$WorkingDirectory,
        [string[]]$Arguments
    )

    Push-Location $WorkingDirectory
    try {
        $result = & docker compose @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw ($result | Out-String)
        }
        return ($result | Out-String).Trim()
    }
    finally {
        Pop-Location
    }
}

function Find-ObservabilityRepo {
    $Parent = Split-Path $ProjectRoot -Parent

    $Candidates = @(
        Get-ChildItem -LiteralPath $Parent -Directory |
        Where-Object { $_.FullName -ne $ProjectRoot } |
        Where-Object {
            (Test-Path (Join-Path $_.FullName 'go.mod')) -and
            (Test-Path (Join-Path $_.FullName 'cmd/investigator')) -and
            (Test-Path (Join-Path $_.FullName $ObsComposeRelative))
        }
    )

    if ($Candidates.Count -eq 0) {
        throw @"
Could not discover the Observability Agent repository.

Expected a sibling directory containing:
  go.mod
  cmd/investigator/
  $ObsComposeRelative

No services were started by the discovery step.
"@
    }

    if ($Candidates.Count -gt 1) {
        $Names = $Candidates.FullName -join "`n"
        throw "Multiple candidate repositories found. Keep one candidate or set an explicit path.`n$Names"
    }

    return $Candidates[0].FullName
}

function Set-EnvValue {
    param(
        [string]$Path,
        [string]$Name,
        [string]$Value
    )

    $Lines = @()
    if (Test-Path -LiteralPath $Path) {
        $Lines = @(Get-Content -LiteralPath $Path)
    }

    $Pattern = '^\s*' + [regex]::Escape($Name) + '='
    $Found = $false

    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match $Pattern) {
            $Lines[$i] = "$Name=$Value"
            $Found = $true
        }
    }

    if (-not $Found) {
        $Lines += "$Name=$Value"
    }

    Set-Content -LiteralPath $Path -Value $Lines -Encoding utf8
}

function Invoke-ObsCurl {
    param([string[]]$CurlArguments)

    $Output = & docker run --rm `
        --network $script:ObsNetwork `
        curlimages/curl:8.12.1 `
        @CurlArguments 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "HTTP check failed: $($Output | Out-String)"
    }

    return ($Output | Out-String).Trim()
}

function Get-ComposeServiceNames {
    $Ids = @(
        & docker ps -q `
            --filter "label=com.docker.compose.project=$E2EProject"
    )

    if ($LASTEXITCODE -ne 0 -or $Ids.Count -eq 0) {
        throw "No running containers found for Compose project '$E2EProject'."
    }

    $Names = foreach ($Id in $Ids) {
        $Name = & docker inspect $Id `
            --format '{{ index .Config.Labels "com.docker.compose.service" }}'

        if ($LASTEXITCODE -eq 0 -and $Name -and $Name -ne '<no value>') {
            $Name.Trim()
        }
    }

    return @($Names | Sort-Object -Unique)
}

function Get-FirstContainerNetwork {
    param([string]$ContainerId)

    $Networks = @(
        & docker inspect $ContainerId `
            --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
    )

    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect investigator container network."
    }

    $Network = $Networks |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ } |
        Select-Object -First 1

    if (-not $Network) {
        throw "Investigator container has no attached Docker network."
    }

    return $Network
}

try {
    Assert-Command 'docker'
    Assert-Command 'npm'

    Write-Step 'Discovering project directories'

    $ObsRoot = Find-ObservabilityRepo
    $ObsCompose = Join-Path $ObsRoot $ObsComposeRelative
    $ObsComposeDir = Split-Path $ObsCompose -Parent

    Write-Host "Delivery Plus: $ProjectRoot"
    Write-Host "Observability: $ObsRoot"

    $E2EComposeFiles = @(
        'docker-compose.base.yml',
        'docker-compose.test.yml',
        'docker-compose.e2e.yml'
    )

    foreach ($File in $E2EComposeFiles) {
        if (-not (Test-Path (Join-Path $ProjectRoot $File))) {
            throw "Required E2E Compose file not found: $File"
        }
    }

    $E2EArgs = @('-p', $E2EProject)
    foreach ($File in $E2EComposeFiles) {
        $E2EArgs += @('-f', $File)
    }

    Write-Step 'Starting Delivery Plus E2E'

    if ($SkipBuild) {
        $E2EArgs += @('up', '-d', '--wait',
            '--wait-timeout', "$TimeoutSeconds")
    }
    else {
        $E2EArgs += @('up', '-d', '--build', '--wait',
            '--wait-timeout', "$TimeoutSeconds")
    }

    try {
        Invoke-Compose -WorkingDirectory $ProjectRoot `
            -Arguments $E2EArgs
    }
    catch {
        Write-Host "`nE2E startup failed. Diagnostics:" -ForegroundColor Red

        $DiagnosticArgs = @('-p', $E2EProject)
        foreach ($File in $E2EComposeFiles) {
            $DiagnosticArgs += @('-f', $File)
        }

        & docker compose @DiagnosticArgs ps
        & docker compose @DiagnosticArgs logs `
            --no-color --tail=200 kafka zookeeper

        throw
    }

    Write-Step 'Seeding E2E test data'

    Push-Location $ProjectRoot
    try {
        & npm run seed:e2e
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run seed:e2e failed.'
        }
    }
    finally {
        Pop-Location
    }

    $Services = @(Get-ComposeServiceNames)
    Write-Host "Running application services: $($Services -join ', ')"

    $TargetService = if ($Services -contains 'api-gateway') {
        'api-gateway'
    }
    else {
        $null
    }

    if (-not $TargetService) {
        throw "Could not identify api-gateway in the running E2E containers."
    }

    Write-Step 'Preparing Observability configuration'

    $EnvFile = Join-Path $ObsComposeDir '.env'
    $EnvExample = Join-Path $ObsComposeDir '.env.example'

    if (-not (Test-Path $EnvFile)) {
        if (-not (Test-Path $EnvExample)) {
            throw "Neither .env nor .env.example exists in $ObsComposeDir"
        }
        Copy-Item $EnvExample $EnvFile
    }

    $ExistingToken = $null
    $TokenLine = Get-Content $EnvFile |
        Where-Object { $_ -match '^INVESTIGATOR_API_TOKEN=' } |
        Select-Object -Last 1

    if ($TokenLine) {
        $ExistingToken = $TokenLine.Substring(
            'INVESTIGATOR_API_TOKEN='.Length
        )
    }

    if (-not $ExistingToken -or $ExistingToken.Length -lt 32) {
        $Bytes = New-Object byte[] 32
        $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $Rng.GetBytes($Bytes)
        }
        finally {
            $Rng.Dispose()
        }

        $ExistingToken = [Convert]::ToHexString($Bytes).ToLowerInvariant()
    }

    $Token = $ExistingToken
    Set-EnvValue -Path $EnvFile `
        -Name 'INVESTIGATOR_API_TOKEN' -Value $Token

    # Empty provider selects deterministic analysis; no AI API key required.
    Set-EnvValue -Path $EnvFile -Name 'AI_PROVIDER' -Value ''

    $CertScript = Join-Path $ObsComposeDir 'certs/gen-certs.sh'
    if (Test-Path $CertScript) {
        if (Get-Command bash -ErrorAction SilentlyContinue) {
            Push-Location $ObsComposeDir
            try {
                & bash './certs/gen-certs.sh'
                if ($LASTEXITCODE -ne 0) {
                    throw 'Development certificate generation failed.'
                }
            }
            finally {
                Pop-Location
            }
        }
        else {
            throw @"
Certificate generation script exists, but 'bash' is unavailable in PowerShell.
Run the documented cert generation command using WSL or Git Bash, then rerun this script.
"@
        }
    }

    Write-Step 'Starting Observability Agent and Investigator'

    $ObsArgs = @(
        '-p', $ObsProject,
        '-f', $ObsCompose
    )

    # Validate both the default stack and requested profiles before startup.
    Invoke-Compose -WorkingDirectory $ObsComposeDir `
        -Arguments ($ObsArgs + @('config', '--quiet'))

    Invoke-Compose -WorkingDirectory $ObsComposeDir `
        -Arguments ($ObsArgs + @(
            '--profile', 'demo',
            '--profile', 'investigator',
            'config', '--quiet'
        ))

    Invoke-Compose -WorkingDirectory $ObsComposeDir `
        -Arguments ($ObsArgs + @(
            '--profile', 'demo',
            '--profile', 'investigator',
            'up', '-d', '--build'
        ))

    $InvestigatorId = Invoke-ComposeCapture `
        -WorkingDirectory $ObsComposeDir `
        -Arguments ($ObsArgs + @(
            '--profile', 'investigator', 'ps', '-q', 'investigator'
        ))

    $InvestigatorId = $InvestigatorId.Trim()

    if (-not $InvestigatorId) {
        throw @"
Could not find the 'investigator' Compose service.
Inspect the Compose service names; the script will not guess an alternative.
"@
    }

    $script:ObsNetwork = Get-FirstContainerNetwork $InvestigatorId

    Write-Host "Observability network: $script:ObsNetwork"

    Write-Step 'Waiting for Investigator readiness'

    $Ready = $false
    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    do {
        try {
            $null = Invoke-ObsCurl -CurlArguments @(
                '--fail-with-body', '-sS',
                'http://investigator:8080/readyz'
            )
            $Ready = $true
        }
        catch {
            Start-Sleep -Seconds 3
        }
    } while (-not $Ready -and (Get-Date) -lt $Deadline)

    if (-not $Ready) {
        throw 'Investigator did not become ready before the timeout.'
    }

    Write-Step 'Checking Loki readiness'

    $LokiReady = Invoke-ObsCurl -CurlArguments @(
        '--fail-with-body', '-sS',
        'http://loki:3100/ready'
    )

    Write-Host "Loki readiness: $LokiReady"

    Write-Step 'Waiting for actual application logs in Loki'

    $EncodedQuery = [Uri]::EscapeDataString(
        "{service_name=`"$TargetService`"}"
    )

    $LogsFound = $false
    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    do {
        $StartNs = [DateTimeOffset]::UtcNow.AddMinutes(-10).
            ToUnixTimeMilliseconds() * 1000000
        $EndNs = [DateTimeOffset]::UtcNow.
            ToUnixTimeMilliseconds() * 1000000

        $QueryUrl = "http://loki:3100/loki/api/v1/query_range?query=$EncodedQuery&start=$StartNs&end=$EndNs&limit=10"

        try {
            $QueryResult = Invoke-ObsCurl -CurlArguments @(
                '--fail-with-body', '-sS', $QueryUrl
            )

            $Parsed = $QueryResult | ConvertFrom-Json

            if ($Parsed.status -eq 'success' -and
                $Parsed.data.result -and
                $Parsed.data.result.Count -gt 0) {
                $LogsFound = $true
            }
        }
        catch {
            Write-Host "Waiting for Loki evidence..."
        }

        if (-not $LogsFound) {
            Start-Sleep -Seconds 5
        }
    } while (-not $LogsFound -and (Get-Date) -lt $Deadline)

    if (-not $LogsFound) {
        throw @"
No recent logs were found for service '$TargetService' in Loki.

The script will not submit an incident and falsely report a successful end-to-end test.
Inspect the collector logs, Docker log source mount, OTLP export, and Loki labels.
"@
    }

    Write-Host "Confirmed recent Loki logs for $TargetService" `
        -ForegroundColor Green

    Write-Step 'Submitting an incident and retrieving the report'

    $Now = [DateTimeOffset]::UtcNow
    $IncidentId = "delivery-plus-local-" +
        [Guid]::NewGuid().ToString('N')

    $Incident = @{
        incident_id = $IncidentId
        alert_name = 'DeliveryPlusLocalSmokeTest'
        severity = 'warning'
        service_name = $TargetService
        environment = 'local'
        summary = 'Automated Delivery Plus observability smoke test'
        description = 'Verify collection of recent application logs and incident report persistence.'
        start_time = $Now.AddMinutes(-10).ToString('yyyy-MM-ddTHH:mm:ssZ')
        end_time = $Now.ToString('yyyy-MM-ddTHH:mm:ssZ')
        trace_id = $null
        request_id = $null
        labels = @{
            source = 'start-e2e.ps1'
            environment = 'local'
        }
    } | ConvertTo-Json -Depth 8 -Compress

    $IncidentResponse = Invoke-ObsCurl -CurlArguments @(
        '--fail-with-body', '-sS',
        '-H', "Authorization: Bearer $Token",
        '-H', 'Content-Type: application/json',
        '--data-binary', $Incident,
        'http://investigator:8080/api/v1/incidents'
    )

    $Report = $IncidentResponse | ConvertFrom-Json

    if (-not $Report.incident_id) {
        throw 'Investigator response did not contain incident_id.'
    }

    $ReportResponse = Invoke-ObsCurl -CurlArguments @(
        '--fail-with-body', '-sS',
        '-H', "Authorization: Bearer $Token",
        "http://investigator:8080/api/v1/incidents/$IncidentId"
    )

    $SavedReport = $ReportResponse | ConvertFrom-Json

    $ReportPath = Join-Path $ProjectRoot 'e2e-observability-report.json'
    $SavedReport | ConvertTo-Json -Depth 30 |
        Set-Content -LiteralPath $ReportPath -Encoding utf8

    Write-Host "Incident report saved: $ReportPath"
    Write-Host "Incident ID: $IncidentId"
    Write-Host "Investigation status: $($SavedReport.status)"

    if ($SavedReport.status -eq 'failed') {
        throw 'Investigator persisted a failed report. Inspect the report errors.'
    }

    Write-Step 'E2E and Observability smoke test completed'

    Write-Host 'API Gateway: http://localhost:3100'
    Write-Host 'Media Storage: http://localhost:9100'
    Write-Host "Incident report: $ReportPath"

    if ($SavedReport.status -eq 'partial') {
        Write-Warning 'The investigation is partial. Inspect errors and evidence_gaps in the report.'
    }
}
catch {
    Write-Host "`nAUTOMATION FAILED: $($_.Exception.Message)" `
        -ForegroundColor Red
    exit 1
}