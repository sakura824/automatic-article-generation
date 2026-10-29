param(
  [Parameter(Mandatory = $true)][string]$BaseDir
)
# Creates (or refreshes) the desktop shortcut for the portable build.
$dist = Join-Path $BaseDir 'dist'
$exe = Get-ChildItem -LiteralPath $dist -Filter '*.exe' -ErrorAction Stop |
  Where-Object { $_.Name -notlike '*Setup*' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $exe) { throw "portable exe not found in $dist" }

$icon = Join-Path $BaseDir 'build\icon.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop '公众号写作助手.lnk'

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $exe.FullName
$lnk.WorkingDirectory = $exe.DirectoryName
if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = "$icon,0" }
$lnk.Description = '公众号写作助手：素材成文 / 对话共创 / 全网聚合 / 仓库自动'
$lnk.WindowStyle = 1
$lnk.Save()

$check = $ws.CreateShortcut($lnkPath)
if ($check.TargetPath -ne $exe.FullName) { throw "shortcut verification failed" }
if (-not (Test-Path -LiteralPath $check.TargetPath)) { throw "target missing: $($check.TargetPath)" }

Write-Host ("OK desktop  : {0}" -f $desktop)
Write-Host ("OK shortcut : {0}" -f $lnkPath)
Write-Host ("OK target   : {0} ({1:N1} MB)" -f $exe.Name, ($exe.Length / 1MB))
Write-Host ("OK icon     : {0}" -f $check.IconLocation)
