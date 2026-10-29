param(
  [Parameter(Mandatory = $true)][string]$OutPng
)
# Draws the default article cover (900x383) with System.Drawing — same approach as make_app_icon.ps1.
# Text: 每日更新 / 新文章速递 (domain-neutral). Output PNG is the app's built-in fallback cover.
Add-Type -AssemblyName System.Drawing

$W = 900
$H = 383
$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

# --- background: soft gradient ---
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($W, $H)),
  [System.Drawing.Color]::FromArgb(255, 15, 23, 42),
  [System.Drawing.Color]::FromArgb(255, 29, 78, 111))
$g.FillRectangle($bgBrush, 0, 0, $W, $H)

# --- green accent bar on the left ---
$barBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(56, 96)),
  (New-Object System.Drawing.Point(66, 200)),
  [System.Drawing.Color]::FromArgb(255, 52, 211, 153),
  [System.Drawing.Color]::FromArgb(255, 16, 185, 129))
$g.FillRectangle($barBrush, 56, 96, 10, 104)

# --- title / subtitle ---
$titleFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 44, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$subFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$titleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 252, 253, 255))
$subBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 203, 213, 225))

$g.DrawString('每日更新', $titleFont, $titleBrush, 86, 92)
$g.DrawString('新文章速递', $subFont, $subBrush, 90, 168)

$g.Dispose()
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host ("default cover written: {0} ({1} bytes)" -f $OutPng, (Get-Item $OutPng).Length)
