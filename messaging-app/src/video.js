// video.js — read a video file in the browser before it goes up: dimensions,
// running time, and a poster frame grabbed from its first second, downscaled
// through the same path a photo takes. The broker has no media tooling, and a
// clip is far too big to inspect after the fact, so this is the only look
// anything gets at the file.
//
// If the browser can't decode the file, this rejects rather than uploading
// blind — a video the operator's own browser can't read is one no investor
// will be able to play either, and better to hear that now.

import { downscale } from "./image.js";

const once = (el, ok, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("This browser couldn't read that video — export it as MP4 (H.264) and try again.")), ms);
  const done = () => { clearTimeout(timer); resolve(); };
  const failed = () => { clearTimeout(timer); reject(new Error("This browser couldn't read that video — export it as MP4 (H.264) and try again.")); };
  el.addEventListener(ok, done, { once: true });
  el.addEventListener("error", failed, { once: true });
});

export async function probeVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.preload = "metadata";
  v.muted = true;
  v.playsInline = true;
  try {
    v.src = url;
    await once(v, "loadedmetadata", 20000);
    const width = v.videoWidth || null;
    const height = v.videoHeight || null;
    const durationS = Number.isFinite(v.duration) ? v.duration : null;
    if (!width || !height) throw new Error("That file has no picture this browser can show.");
    // A frame from one second in (or the midpoint of a very short clip): the
    // first frame of a phone video is usually the floor.
    v.currentTime = Math.min(1, durationS ? durationS / 2 : 0.5);
    await once(v, "seeked", 20000);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(v, 0, 0, width, height);
    const frame = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't capture a frame from that video."))), "image/jpeg", 0.86));
    const full = await downscale(frame, 1600);
    const thumb = await downscale(frame, 480, 0.78);
    return { width, height, durationS, poster: { full: full.dataUrl, thumb: thumb.dataUrl } };
  } finally {
    v.removeAttribute("src");
    v.load();
    URL.revokeObjectURL(url);
  }
}
