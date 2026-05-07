# Generates placeholder PNG icons for the extension.
# Run from any directory: powershell -ExecutionPolicy Bypass -File make-icons.ps1
# Replace the generated images with branded artwork before publishing.

Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sizes = 16, 48, 128

# Brand-ish colors: deep blue background, white "G" glyph
$bg = [System.Drawing.Color]::FromArgb(255, 31, 64, 175)
$fg = [System.Drawing.Color]::White

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

    # Background
    $brush = New-Object System.Drawing.SolidBrush $bg
    $g.FillRectangle($brush, 0, 0, $size, $size)
    $brush.Dispose()

    # White "G" centered
    $fontSize = [int]($size * 0.65)
    $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = New-Object System.Drawing.SolidBrush $fg
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $g.DrawString("G", $font, $textBrush, $rect, $sf)
    $font.Dispose()
    $textBrush.Dispose()

    $out = Join-Path $here "icon-$size.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Output "Wrote $out"
}
