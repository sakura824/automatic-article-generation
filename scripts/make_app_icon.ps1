param(
  [Parameter(Mandatory = $true)][string]$OutIco,
  [string]$OutPng,
  [string]$OutPng1024
)
# Author: draws the app icon (dark rounded square + document card + green accent bar)
# Master is rendered at 1024px and downscaled to every ICO frame for clean antialiasing.
Add-Type -AssemblyName System.Drawing

function New-RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  if ($d -gt $w) { $d = $w }
  if ($d -gt $h) { $d = $h }
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$S = 1024
$bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# --- background: dark navy gradient rounded square ---
$bgPath = New-RoundRect 8 8 1008 1008 224
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(8, 8)),
  (New-Object System.Drawing.Point(1016, 1016)),
  [System.Drawing.Color]::FromArgb(255, 15, 23, 42),
  [System.Drawing.Color]::FromArgb(255, 29, 78, 111))
$g.FillPath($bgBrush, $bgPath)

# --- document card ---
$k = 4.0
$cardPath = New-RoundRect (56 * $k) (58 * $k) (144 * $k) (140 * $k) (14 * $k)
$cardBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 252, 253, 255))
$g.FillPath($cardBrush, $cardPath)

# --- green accent bar ---
$barPath = New-RoundRect (74 * $k) (88 * $k) (9 * $k) (102 * $k) (4.5 * $k)
$barP1 = New-Object System.Drawing.Point([single](74 * $k), [single](88 * $k))
$barP2 = New-Object System.Drawing.Point([single](83 * $k), [single](190 * $k))
$barBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $barP1, $barP2,
  [System.Drawing.Color]::FromArgb(255, 52, 211, 153),
  [System.Drawing.Color]::FromArgb(255, 16, 185, 129))
$g.FillPath($barBrush, $barPath)

# --- text lines ---
$titleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 41, 59))
$lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 203, 213, 225))

$l1 = New-RoundRect (96 * $k) (88 * $k) (88 * $k) (14 * $k) (7 * $k)
$g.FillPath($titleBrush, $l1)
$l2 = New-RoundRect (96 * $k) (122 * $k) (104 * $k) (10 * $k) (5 * $k)
$g.FillPath($lineBrush, $l2)
$l3 = New-RoundRect (96 * $k) (146 * $k) (96 * $k) (10 * $k) (5 * $k)
$g.FillPath($lineBrush, $l3)
$l4 = New-RoundRect (96 * $k) (170 * $k) (62 * $k) (10 * $k) (5 * $k)
$g.FillPath($lineBrush, $l4)

$g.Dispose()

# --- downscale into ICO frames ---
$sizes = @(256, 128, 64, 48, 32, 16)
$frames = New-Object System.Collections.ArrayList
foreach ($sz in $sizes) {
  $b = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gg = [System.Drawing.Graphics]::FromImage($b)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $gg.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)))
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  [void]$frames.Add($ms.ToArray())
  $ms.Dispose(); $gg.Dispose(); $b.Dispose()
}
if ($OutPng) {
  $b256 = New-Object System.Drawing.Bitmap(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g256 = [System.Drawing.Graphics]::FromImage($b256)
  $g256.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g256.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, 256, 256)))
  $b256.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
  $g256.Dispose(); $b256.Dispose()
}
if ($OutPng1024) {
  # 1024px 母版直接落 PNG（mac 打包用 build/icon.png；Windows 用 icon.ico）
  $bmp.Save($OutPng1024, [System.Drawing.Imaging.ImageFormat]::Png)
}
$bmp.Dispose()

# --- assemble ICO (PNG-compressed frames) ---
$fs = [System.IO.File]::Create($OutIco)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $sz = $sizes[$i]
  $dim = if ($sz -ge 256) { 0 } else { $sz }
  $data = $frames[$i]
  $bw.Write([byte]$dim)
  $bw.Write([byte]$dim)
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length)
  $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($d in $frames) { $bw.Write($d) }
$bw.Flush(); $bw.Dispose(); $fs.Dispose()

Write-Host ("icon written: {0} ({1} bytes, {2} frames)" -f $OutIco, (Get-Item $OutIco).Length, $sizes.Count)
