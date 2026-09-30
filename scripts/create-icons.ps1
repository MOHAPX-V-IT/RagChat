Add-Type -AssemblyName System.Drawing
$directory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../web/public/icons'))
foreach ($entry in @(@('icon-192.png',192), @('icon-512.png',512), @('icon-maskable-512.png',512), @('apple-touch-icon.png',180))) {
  $size = [int]$entry[1]
  $bitmap = New-Object System.Drawing.Bitmap($size,$size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#247653'))
  $scale = $size / 512.0
  $graphics.ScaleTransform($scale,$scale)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddLines([System.Drawing.PointF[]]@([System.Drawing.PointF]::new(148,112),[System.Drawing.PointF]::new(267,112)))
  $p.AddBezier(267,112,340,112,384,147,384,209)
  $p.AddBezier(384,209,384,252,362,282,322,296)
  $p.AddLines([System.Drawing.PointF[]]@([System.Drawing.PointF]::new(322,296),[System.Drawing.PointF]::new(396,400),[System.Drawing.PointF]::new(319,400),[System.Drawing.PointF]::new(254,305),[System.Drawing.PointF]::new(213,305),[System.Drawing.PointF]::new(213,400),[System.Drawing.PointF]::new(148,400)))
  $p.CloseFigure()
  $p.StartFigure(); $p.AddRectangle([System.Drawing.RectangleF]::new(213,169,95,80)); $p.CloseFigure()
  $graphics.FillPath([System.Drawing.Brushes]::White,$p)
  $bitmap.Save((Join-Path $directory $entry[0]),[System.Drawing.Imaging.ImageFormat]::Png)
  $p.Dispose();$graphics.Dispose();$bitmap.Dispose()
}
