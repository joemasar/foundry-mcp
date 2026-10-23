# Packages the Foundry module and publishes it as a GitHub release.
# Usage: .\release-module.ps1 -Version 0.1.1
# Bumps the version and download URL in module.json, builds foundry-mcp.zip, commits, tags,
# pushes, and uploads module.json + the zip to the release. Foundry's "Check for updates" then finds it.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$NoPublish
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$moduleDir = Join-Path $root "foundry-module"
$manifestPath = Join-Path $moduleDir "module.json"
$zip = Join-Path $root "foundry-mcp.zip"

$json = Get-Content $manifestPath -Raw
$json = $json -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`""
$json = $json -replace 'releases/download/v[^/]+/', "releases/download/v$Version/"
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding $false))

# Windows' bsdtar writes zips with forward-slash paths, which Foundry on Linux needs.
if (Test-Path $zip) { Remove-Item $zip }
& "$env:SystemRoot\System32\tar.exe" -a -c -f $zip -C $moduleDir module.json scripts languages
if ($LASTEXITCODE -ne 0) { throw "zip failed" }
Write-Host "Built $zip"

if ($NoPublish) { return }
git -C $root add foundry-module/module.json
git -C $root commit -m "Release module v$Version"
git -C $root tag "v$Version"
git -C $root push origin HEAD --tags
gh release create "v$Version" $zip $manifestPath --repo joemasar/foundry-mcp --title "v$Version" --notes "Foundry MCP Bridge v$Version"
