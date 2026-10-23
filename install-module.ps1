# Copies the Foundry MCP Bridge module into your Foundry user data folder.
# Usage: .\install-module.ps1 -DataPath "D:\FoundryData"
# DataPath is the folder that contains "Data" (shown in Foundry's setup screen under "User Data Path").
param(
  [string]$DataPath = "$env:LOCALAPPDATA\FoundryVTT"
)

$modules = Join-Path $DataPath "Data\modules"
if (-not (Test-Path $modules)) {
  Write-Error "Could not find $modules. Pass -DataPath with your Foundry User Data Path."
  exit 1
}
$target = Join-Path $modules "foundry-mcp"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot "foundry-module\*") $target
Write-Host "Installed to $target. Restart Foundry (or return to setup) and enable 'Foundry MCP Bridge' in your world."
