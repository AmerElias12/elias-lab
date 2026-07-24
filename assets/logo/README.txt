Elias Lab logo — exported PNGs
==============================

Generated from assets/elias-lab-logo.svg (the same artwork used in the site
header), rendered with the real Fraunces font so it matches the website exactly.

  elias-lab-logo.png          1016 x 240   transparent   <- use this for Wix
  elias-lab-logo@2x.png       2032 x 480   transparent   retina / large headers
  elias-lab-logo-print.png    5080 x 1200  transparent   posters, slides, print
  elias-lab-logo-onpaper.png  1016 x 240   #f4f1e8 bg    if transparency misbehaves
  elias-lab-mark.png           512 x 512   transparent   icon only (favicon,
                                                         social avatar, slide corner)

Which to use where
------------------
  Wix site header ......... elias-lab-logo.png
  Presentations / posters .. elias-lab-logo-print.png
  Social / avatar / favicon  elias-lab-mark.png
  Anything scalable ........ assets/elias-lab-logo.svg (sharp at any size)

Prefer the SVG whenever the destination accepts it — it never pixelates.

Regenerating
------------
These are exported by rendering the SVG in headless Chrome. If the artwork
changes in index.html, re-extract the SVG and re-render, or just ask Claude to
regenerate the set.

Note: the wordmark uses Fraunces (Google Fonts) and the tagline uses a monospace
face. Both were loaded at render time, so the PNGs are self-contained — no font
installation needed to use them.
