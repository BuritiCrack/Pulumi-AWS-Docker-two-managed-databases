function Invoke-EcrAuthScope {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Registry,
        [Parameter(Mandatory)][scriptblock]$Command,
        # Optional fixture base keeps isolated verification inside its scratch tree.
        [string]$TempRoot = [IO.Path]::GetTempPath()
    )
    $previous = @{}
    foreach ($name in @('DOCKER_CONFIG', 'AWS_ECR_DISABLE_CACHE', 'AWS_ECR_CACHE_DIR')) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    $directory = Join-Path $TempRoot ('prestashop-ecr-auth-' + [guid]::NewGuid().ToString('N'))
    # No -Force: only a newly created directory may be owned and cleaned up.
    New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
    try {
        $config = @{ credHelpers = @{ $Registry = 'ecr-login' } } | ConvertTo-Json -Depth 3
        [IO.File]::WriteAllText((Join-Path $directory 'config.json'), $config)
        $env:DOCKER_CONFIG = $directory
        $env:AWS_ECR_DISABLE_CACHE = 'true'
        $env:AWS_ECR_CACHE_DIR = Join-Path $directory 'ecr-cache'
        & $Command
    }
    finally {
        foreach ($name in $previous.Keys) {
            [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
        }
        Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction Stop
    }
}
