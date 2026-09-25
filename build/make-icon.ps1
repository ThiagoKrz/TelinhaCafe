# Gera build/icon.png (256px), build/icon.ico e src/renderer/icon.png
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

# Fundo arredondado com degradê
$bg = New-RoundRect 8 8 240 240 56
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point 256, 256), ([System.Drawing.Color]::FromArgb(255, 91, 140, 255)), ([System.Drawing.Color]::FromArgb(255, 124, 77, 255))
$g.FillPath($grad, $bg)

# Monitor
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$screen = New-RoundRect 52 64 152 102 14
$g.FillPath($white, $screen)
$inner = New-RoundRect 64 76 128 78 6
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 60, 90, 210))), $inner)
$g.FillRectangle($white, 118, 166, 20, 18)
$foot = New-RoundRect 90 182 76 14 7
$g.FillPath($white, $foot)

# "Ao vivo": triângulo de play
$pts = [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 116, 96), (New-Object System.Drawing.PointF 116, 134), (New-Object System.Drawing.PointF 146, 115))
$g.FillPolygon($white, $pts)
$g.Dispose()

New-Item -ItemType Directory -Force "$root\build" | Out-Null
$bmp.Save("$root\build\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Save("$root\src\renderer\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)

# ICO com PNG embutido (256x256)
$png = [System.IO.File]::ReadAllBytes("$root\build\icon.png")
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)
$bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0)
$bw.Write([UInt16]1); $bw.Write([UInt16]32)
$bw.Write([UInt32]$png.Length); $bw.Write([UInt32]22)
$bw.Write($png)
[System.IO.File]::WriteAllBytes("$root\build\icon.ico", $ms.ToArray())
$bmp.Dispose()
Write-Host "Icones gerados."
