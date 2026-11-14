<#
.SYNOPSIS
Checks isolated ECR configuration without calling AWS or a credential helper.
.PARAMETER TempRoot
Existing base directory for all fixtures; use the verifier scratch tree when isolated.
Defaults to the operating system temporary directory without changing TEMP or TMP.
#>
param([string]$TempRoot = [IO.Path]::GetTempPath())
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/ecr-auth.ps1')
function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$names = @('DOCKER_CONFIG', 'AWS_ECR_DISABLE_CACHE', 'AWS_ECR_CACHE_DIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'AWS_PROFILE', 'AWS_REGION')
$original = @{}
foreach ($name in $names) { $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$fixture = Join-Path $TempRoot ('test-ecr-auth-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$canary = Join-Path $fixture 'config.json'
$canaryText = '{"credsStore":"canary-do-not-change"}'
[IO.File]::WriteAllText($canary, $canaryText)
$registry = '000000000000.dkr.ecr.us-east-1.amazonaws.com'
try {
    $env:DOCKER_HOST = 'synthetic-host'
    $env:DOCKER_CONTEXT = 'synthetic-context'
    $env:AWS_PROFILE = 'synthetic-profile'
    $env:AWS_REGION = 'us-east-1'
    foreach ($throws in @($false, $true)) {
        foreach ($preset in @($false, $true)) {
            foreach ($name in @('DOCKER_CONFIG', 'AWS_ECR_DISABLE_CACHE', 'AWS_ECR_CACHE_DIR')) {
                $value = if ($preset) { $fixture } else { $null }
                [Environment]::SetEnvironmentVariable($name, $value, 'Process')
            }
            $observed = @{ Directory = $null; Called = 0 }
            $caught = $null
            try {
                $output = Invoke-EcrAuthScope -Registry $registry -TempRoot $fixture -Command {
                    $observed.Called++
                    $observed.Directory = $env:DOCKER_CONFIG
                    Assert ($env:DOCKER_CONFIG -ne $fixture) 'Must not reuse preexisting config'
                    $config = Get-Content -LiteralPath (Join-Path $env:DOCKER_CONFIG 'config.json') -Raw | ConvertFrom-Json
                    Assert (@($config.PSObject.Properties.Name).Count -eq 1) 'Only credHelpers is permitted'
                    Assert ($config.PSObject.Properties.Name -eq 'credHelpers') 'No auths or global credential store'
                    Assert (@($config.credHelpers.PSObject.Properties.Name).Count -eq 1) 'Only one registry permitted'
                    Assert ($config.credHelpers.$registry -eq 'ecr-login') 'Wrong credential helper'
                    Assert ($env:AWS_ECR_DISABLE_CACHE -ceq 'true') 'Cache must be disabled'
                    Assert ($env:AWS_ECR_CACHE_DIR -eq (Join-Path $env:DOCKER_CONFIG 'ecr-cache')) 'Cache/logs must be owned'
                    New-Item -ItemType Directory -Path (Join-Path $env:AWS_ECR_CACHE_DIR 'log') -Force | Out-Null
                    [IO.File]::WriteAllText((Join-Path $env:AWS_ECR_CACHE_DIR 'log/synthetic.log'), 'synthetic')
                    Assert ($env:DOCKER_HOST -eq 'synthetic-host' -and $env:DOCKER_CONTEXT -eq 'synthetic-context') 'Docker endpoint changed'
                    Assert ($env:AWS_PROFILE -eq 'synthetic-profile' -and $env:AWS_REGION -eq 'us-east-1') 'AWS environment changed'
                    if ($throws) { throw 'synthetic command failure' }
                    'synthetic success'
                }
            } catch { $caught = $_.Exception.Message }
            Assert ($observed.Called -eq 1) "Command must run once; caught: $caught"
            if ($throws) { Assert ($caught -eq 'synthetic command failure') 'Must propagate command failure' }
            else {
                Assert ($null -eq $caught) "Unexpected failure: $caught"
                Assert ($output -ceq 'synthetic success') 'Command output changed'
            }
            Assert (-not (Test-Path -LiteralPath $observed.Directory)) 'Exact owned directory must be removed'
            Assert ((Get-Content -LiteralPath $canary -Raw) -ceq $canaryText) 'Canary config changed'
            foreach ($name in @('DOCKER_CONFIG', 'AWS_ECR_DISABLE_CACHE', 'AWS_ECR_CACHE_DIR')) {
                $expected = if ($preset) { $fixture } else { $null }
                Assert ([Environment]::GetEnvironmentVariable($name, 'Process') -eq $expected) "Environment not restored: $name"
            }
        }
    }
    Write-Output 'PASS: 4 scoped-auth cases (success/failure, existing/absent environment)'
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process') }
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
