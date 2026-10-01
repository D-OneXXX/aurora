# 开发用：打包 + 渲染（V1 / V2 通用）
#   pwsh -File build.ps1                       # V1 → aurora-curtain.html
#   pwsh -File build.ps1 -Src src2 -Out aurora-storm.html -Token __AURORA_STORM__
param(
  [string]$Src   = 'src',
  [string]$Out   = 'aurora-curtain.html',
  [string]$Token = '/*__APP_BUNDLE__*/'
)
$ErrorActionPreference = 'Stop'
$root  = $PSScriptRoot
$exe   = Join-Path $root '.build\node_modules\@esbuild\win32-x64\esbuild.exe'
if (-not (Test-Path $exe)) { throw "esbuild 缺失：$exe" }

$entry = Join-Path $root ".build\entry_$($Src -replace '[\\/]','_').js"
Copy-Item (Join-Path $root "$Src\app.js") $entry -Force
$bundle = "$entry.bundle.js"
& $exe $entry --bundle --format=iife --target=chrome100,firefox100,safari15 `
  --charset=utf8 --legal-comments=none --log-level=warning --outfile=$bundle
if (-not (Test-Path $bundle)) { throw '打包失败' }

$js    = ([System.IO.File]::ReadAllText($bundle)) -replace '</script>', '<\/script>'
$shell = [System.IO.File]::ReadAllText((Join-Path $root "$Src\shell.html"))
$html  = $shell.Replace($Token, $js)
if ($html.Length -le $shell.Length) { throw "占位符 $Token 未被替换，检查 shell.html" }

$dest = Join-Path $root $Out
[System.IO.File]::WriteAllText($dest, $html, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("[build] {0}  {1:N0} KB" -f $Out, ((Get-Item $dest).Length / 1KB))
