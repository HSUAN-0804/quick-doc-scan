(() => {
  const previousStartCamera = startCamera;
  const previousCaptureCurrentFrame = captureCurrentFrame;
  const previousCaptureStillPhoto = typeof captureStillPhoto === "function" ? previousCaptureStillPhoto : null;
})();