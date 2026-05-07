// QR scanning helper — uses jsQR which is loaded as a global from a
// <script> tag in worker.html (window.jsQR).
//
// startQRScan opens the rear camera, draws each video frame onto a canvas,
// and feeds the pixel data into jsQR. When a QR is detected, the callback
// fires once and the camera stream is stopped.

/**
 * Start a QR scan session.
 *
 * @param {HTMLVideoElement} videoEl  - <video> element to show the preview
 * @param {HTMLCanvasElement} canvasEl - hidden <canvas> used to read pixels
 * @param {(text: string) => void} onSuccess - called once with decoded text
 * @returns {Promise<() => void>} a stop() function the caller can use to cancel
 */
export async function startQRScan(videoEl, canvasEl, onSuccess) {
  if (!window.jsQR) {
    throw new Error('jsQR library is not loaded');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });

  videoEl.srcObject = stream;
  videoEl.setAttribute('playsinline', 'true');
  videoEl.muted = true;
  await videoEl.play();

  const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  }

  function tick() {
    if (stopped) return;
    if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
      ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
      const imageData = ctx.getImageData(
        0,
        0,
        canvasEl.width,
        canvasEl.height
      );
      const code = window.jsQR(
        imageData.data,
        imageData.width,
        imageData.height,
        { inversionAttempts: 'dontInvert' }
      );
      if (code && code.data) {
        stop();
        onSuccess(code.data);
        return;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return stop;
}
