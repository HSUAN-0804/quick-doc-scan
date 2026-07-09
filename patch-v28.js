(() => {
  const previousStartCamera = startCamera;
  const previousCaptureCurrentFrame = captureCurrentFrame;
  const previousCaptureStillPhoto = typeof captureStillPhoto === "function" ? captureStillPhoto : null;

  startCamera = async function patchedStartCameraV28() {
    try {
      if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          resizeMode: "none"
        },
        audio: false
      });
      await tuneCameraTrack(cameraStream);
      els.video.srcObject = cameraStream;
      await els.video.play();
      els.cameraEmpty.classList.add("is-hidden");
      clearOverlayV28();
      setStatus("高解析相機就緒", "ready");
    } catch (error) {
      console.warn("V28 camera fallback", error);
      await previousStartCamera();
      clearOverlayV28();
    }
  };

  captureCurrentFrame = async function patchedCaptureCurrentFrameV28() {
    if (!els.video.videoWidth) await startCamera();
    if (!els.video.videoWidth) return;

    setStatus("拍下原圖，交給 AI 找邊", "busy");
    const photoBlob = await (previousCaptureStillPhoto ? previousCaptureStillPhoto() : Promise.resolve(null));
    if (photoBlob) {
      await createScanJobFromBlob(photoBlob, "camera", activeMode, null, { smartLocal: false });
      return;
    }

    const canvas = els.sourceCanvas;
    canvas.width = els.video.videoWidth;
    canvas.height = els.video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(els.video, 0, 0, canvas.width, canvas.height);
    const originalBlob = await canvasToBlob(canvas, "image/jpeg", 0.99);
    await createScanJobFromBlob(originalBlob, "camera", activeMode, null, { smartLocal: false });
  };

  function rebindControlsV28() {
    if (els.openCamera) {
      els.openCamera.removeEventListener("click", previousStartCamera);
      els.openCamera.removeEventListener("click", startCamera);
      els.openCamera.addEventListener("click", startCamera);
    }
    if (els.capture) {
      els.capture.removeEventListener("click", previousCaptureCurrentFrame);
      els.capture.removeEventListener("click", captureCurrentFrame);
      els.capture.addEventListener("click", captureCurrentFrame);
    }
  }

  function clearOverlayV28() {
    const overlay = els.overlay;
    if (!overlay) return;
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width || overlay.clientWidth, overlay.height || overlay.clientHeight);
  }

  setTimeout(rebindControlsV28, 0);
  setTimeout(rebindControlsV28, 700);
})();
