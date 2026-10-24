[CmdletBinding()]
param(
  [string]$ConfigPath = ".\suzu-memory.local.json",
  [string]$DatasetPath = ".\runtime\benchmarks\zh4o\moom-official-v1\data.json",
  [string]$WorkDirectory = "",
  [string]$OutputPath = "",
  [string]$ResumeReport = "",
  [int]$StartSample = 0,
  [int]$MaximumSamples,
  [int]$MaximumQuestionsPerSample,
  [int]$CandidateK,
  [int]$MaximumContextCharacters,
  [int]$MaximumDrainPasses,
  [int]$EmbeddingIntervalMs,
  [switch]$RetrievalOnly,
  [switch]$WithoutEmbedding,
  [switch]$NoControl,
  [switch]$SourceDiagnostics,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$configResolved = (Resolve-Path -LiteralPath $ConfigPath).Path
$datasetResolved = (Resolve-Path -LiteralPath $DatasetPath).Path
if (($RetrievalOnly -or ![string]::IsNullOrWhiteSpace($ResumeReport)) -and [string]::IsNullOrWhiteSpace($WorkDirectory)) {
  throw "RetrievalOnly and ResumeReport require the existing WorkDirectory."
}
if ([string]::IsNullOrWhiteSpace($WorkDirectory)) {
  $WorkDirectory = Join-Path $repositoryRoot ("runtime\benchmarks\zh4o\runs\" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
$workResolved = [System.IO.Path]::GetFullPath($WorkDirectory)
$arguments = @("packages/evaluation/src/zh4o-system-cli.mjs", "--config", $configResolved,
  "--dataset", $datasetResolved, "--work-dir", $workResolved, "--start-sample", [string]$StartSample)
if (![string]::IsNullOrWhiteSpace($OutputPath)) { $arguments += @("--output", [System.IO.Path]::GetFullPath($OutputPath)) }
if (![string]::IsNullOrWhiteSpace($ResumeReport)) { $arguments += @("--resume", (Resolve-Path -LiteralPath $ResumeReport).Path) }
$optionalValues = @{
  MaximumSamples = "max-samples"; MaximumQuestionsPerSample = "max-questions-per-sample"
  CandidateK = "candidate-k"; MaximumContextCharacters = "maximum-context-characters"
  MaximumDrainPasses = "maximum-drain-passes"; EmbeddingIntervalMs = "embedding-interval-ms"
}
foreach ($name in $optionalValues.Keys) {
  if ($PSBoundParameters.ContainsKey($name)) { $arguments += @("--" + $optionalValues[$name], [string]$PSBoundParameters[$name]) }
}
foreach ($entry in @(@("retrieval-only", $RetrievalOnly), @("without-embedding", $WithoutEmbedding),
  @("no-control", $NoControl), @("source-diagnostics", $SourceDiagnostics), @("dry-run", $DryRun))) {
  if ($entry[1]) { $arguments += "--" + $entry[0] }
}
Push-Location $repositoryRoot
try {
  & node @arguments
  $exitCode = $LASTEXITCODE
} finally { Pop-Location }
exit $exitCode
