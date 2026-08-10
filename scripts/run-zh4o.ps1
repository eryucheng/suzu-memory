[CmdletBinding()]
param(
  [string]$ConfigPath = ".\suzu-memory.local.json",
  [string]$DatasetPath = ".\runtime\benchmarks\zh4o\moom-official-v1\data.json",
  [string]$WorkDirectory = "",
  [int]$CandidateK = 9,
  [int]$MaximumEvents = 50,
  [int]$MaximumContentCharacters = 24000,
  [int]$MaximumContextCharacters = 24000,
  [int]$MaximumSemanticPasses = 100,
  [int]$EmbeddingIntervalMs = 50,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repositoryRoot

function Resolve-RequiredPath([string]$PathValue, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($PathValue) -or -not (Test-Path -LiteralPath $PathValue)) {
    throw "$Label was not found: $PathValue"
  }
  return (Resolve-Path -LiteralPath $PathValue).Path
}

$configPathResolved = Resolve-RequiredPath $ConfigPath "Memory configuration"
$datasetPathResolved = Resolve-RequiredPath $DatasetPath "ZH-4O dataset"
$benchmarkConfig = ([System.IO.File]::ReadAllText($configPathResolved).TrimStart([char]0xFEFF) | ConvertFrom-Json)
$generation = $benchmarkConfig.providers.generation
$embedding = $benchmarkConfig.providers.embedding

if (-not $DryRun) {
  foreach ($environmentName in @($generation.apiKeyEnv, $embedding.apiKeyEnv) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($environmentName))) {
      throw "Required environment variable is empty: $environmentName"
    }
  }
}

if ([string]::IsNullOrWhiteSpace($WorkDirectory)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $WorkDirectory = ".\runtime\benchmarks\zh4o\runs\$stamp"
}
New-Item -ItemType Directory -Force -Path $WorkDirectory | Out-Null
$workDirectoryResolved = (Resolve-Path -LiteralPath $WorkDirectory).Path

$runManifest = [ordered]@{
  schemaVersion = 1
  runner = "scripts/run-zh4o.ps1"
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  dataset = [ordered]@{
    path = $datasetPathResolved
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $datasetPathResolved).Hash.ToLowerInvariant()
  }
  config = [ordered]@{
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $configPathResolved).Hash.ToLowerInvariant()
    generation = [ordered]@{
      type = $generation.type
      name = $generation.name
      baseUrl = $generation.baseUrl
      endpoint = $generation.endpoint
      model = $generation.model
      structuredOutputMode = $generation.structuredOutputMode
      maxOutputTokens = $generation.maxOutputTokens
    }
    embedding = [ordered]@{
      type = $embedding.type
      name = $embedding.name
      baseUrl = $embedding.baseUrl
      endpoint = $embedding.endpoint
      model = $embedding.model
      dimensions = $embedding.dimensions
    }
  }
  parameters = [ordered]@{
    candidateK = $CandidateK
    maximumEvents = $MaximumEvents
    maximumContentCharacters = $MaximumContentCharacters
    maximumContextCharacters = $MaximumContextCharacters
    maximumSemanticPasses = $MaximumSemanticPasses
    embeddingIntervalMs = $EmbeddingIntervalMs
    dryRun = [bool]$DryRun
  }
}
$runManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $workDirectoryResolved "run-manifest.json") -Encoding utf8

$arguments = @(
  ".\packages\evaluation\src\zh4o-system-cli.mjs",
  "--dataset", $datasetPathResolved,
  "--config", $configPathResolved,
  "--work-dir", $workDirectoryResolved,
  "--candidate-k", $CandidateK,
  "--maximum-events", $MaximumEvents,
  "--maximum-content-characters", $MaximumContentCharacters,
  "--maximum-context-characters", $MaximumContextCharacters,
  "--maximum-semantic-passes", $MaximumSemanticPasses,
  "--embedding-interval-ms", $EmbeddingIntervalMs,
  "--output", (Join-Path $workDirectoryResolved "report.json")
)
if ($DryRun) { $arguments += "--dry-run" }

Write-Host "ZH-4O run directory: $workDirectoryResolved"
& node @arguments
exit $LASTEXITCODE
