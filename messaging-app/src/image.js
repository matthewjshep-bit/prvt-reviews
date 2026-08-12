// image.js — client-side photo downscaling.
//
// The browser does the resizing because the broker has no image library and
// adding one (sharp) for this alone isn't worth the build weight. Everything
// travels as base64 in the existing JSON body, which is why size discipline
// here matters: the raw file off a phone is 3-6MB, and these settings land it
// around 200-350KB.

// Downscale to fit `maxDim` on the long edge and return the JPEG data URL plus
// the dimensions actually produced. The dimensions are load-bearing, not
// decoration: the investor pages can run no JavaScript, so explicit width/height
// on the <img> is the only thing preventing layout shift as photos load.
export async function downscale(file, maxDim, quality = 0.82) {
  const img = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/jpeg", quality), width: canvas.width, height: canvas.height };
  } finally {
    img.close?.();
  }
}

// The two sizes a property photo is stored at: `full` for tapping through,
// `thumb` for the gallery strip and the portfolio cards. Producing both here
// means the portfolio never ships full-resolution bytes.
export async function propertyPhotoVariants(file) {
  const full = await downscale(file, 1600);
  const thumb = await downscale(file, 480, 0.78);
  return { full: full.dataUrl, thumb: thumb.dataUrl, width: full.width, height: full.height };
}
