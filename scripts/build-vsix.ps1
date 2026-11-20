$ErrorActionPreference = 'Stop'

# 离线构建 VSIX：不依赖 npm / vsce
$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$pkg.version
$outDir = Join-Path $root 'dist-vsix'
$stage = Join-Path $outDir 'stage'
$ext = Join-Path $stage 'extension'

if (Test-Path -LiteralPath $stage) { [System.IO.Directory]::Delete($stage, $true) }
New-Item -ItemType Directory -Path (Join-Path $ext 'media') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $ext 'bin') -Force | Out-Null

foreach ($f in @('extension.js','package.json','README.md','CHANGELOG.md','LICENSE.txt','NOTICE.md')) {
  Copy-Item -LiteralPath (Join-Path $root $f) -Destination (Join-Path $ext $f) -Force
}
Copy-Item -LiteralPath (Join-Path $root 'media') -Destination $ext -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root 'bin') -Destination $ext -Recurse -Force

$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".css" ContentType="text/css" />
  <Default Extension=".html" ContentType="text/html" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".txt" ContentType="text/plain" />
  <Default Extension=".cs" ContentType="text/plain" />
  <Default Extension=".exe" ContentType="application/octet-stream" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
'@
Set-Content -LiteralPath (Join-Path $stage '[Content_Types].xml') -Value $contentTypes -Encoding UTF8

$desc = [System.Security.SecurityElement]::Escape([string]$pkg.description)
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="zh-CN" Id="$($pkg.name)" Version="$version" Publisher="$($pkg.publisher)" />
    <DisplayName>$($pkg.displayName)</DisplayName>
    <Description xml:space="preserve">$desc</Description>
    <Tags>wallpaper,wallpaper engine,background,transparency,scene</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($pkg.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
"@
Set-Content -LiteralPath (Join-Path $stage 'extension.vsixmanifest') -Value $manifest -Encoding UTF8

$vsix = Join-Path $outDir ("vscode-wallpaper-engine-$version.vsix")
if (Test-Path -LiteralPath $vsix) { [System.IO.File]::Delete($vsix) }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($vsix, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $zip.Dispose()
}

Write-Output ("Built: " + $vsix)
