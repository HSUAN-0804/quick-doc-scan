(() => {
  const previousStartCamera = startCamera;
  const previousCaptureCurrentFrame = captureCurrentFrame;
  const previousCaptureStillPhoto = typeof captureStillPhoto === "function" ? captureStillPhoto : null;

  let assistTimer = null;
  let assistBusy = false;
  let assistCandidate = null;
  let assistCanvas = null;
  let lastAssistPoints = null;
  let stableCount = 0;

  startCamera = async function patchedStartCameraV27() {
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
      startMagicAssist();
    } catch (error) {
      console.warn("V27 camera fallback", error);
      await previousStartCamera();
      startMagicAssist();
    }
  };

  captureCurrentFrame = async function patchedCaptureCurrentFrameV27() {
    if (!els.video.videoWidth) await startCamera();
    if (!els.video.videoWidth) return;

    const localDetection = activeMode === "original" ? null : getUsableDetection();
    if (localDetection) setStatus("已鎖定，拍下高解析", "busy");

    const photoBlob = await (previousCaptureStillPhoto ? previousCaptureStillPhoto() : Promise.resolve(null));
    if (photoBlob) {
      await createScanJobFromBlob(photoBlob, "camera", activeMode, localDetection, { smartLocal: true });
      return;
    }

    const canvas = els.sourceCanvas;
    canvas.width = els.video.videoWidth;
    canvas.height = els.video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(els.video, 0, 0, canvas.width, canvas.height);
    await createScanJob(canvas, "camera", localDetection, { smartLocal: true });
  };

  createScanJob = async function patchedCreateScanJobV27(canvas, source, localDetection = null, options = {}) {
    const mode = activeMode;
    const originalBlob = await canvasToBlob(canvas, "image/jpeg", 0.99);
    await createScanJobFromBlob(originalBlob, source, mode, localDetection, options);
  };

  createScanJobFromBlob = async function patchedCreateScanJobFromBlobV27(
    originalBlob,
    source,
    scanMode = activeMode,
    localDetection = null,
    options = {}
  ) {
    const mode = scanMode;
    const hasLocalDetection = Boolean(localDetection && localDetection.points && localDetection.frame);
    const shouldUseSmartLocal = mode !== "original" && options.smartLocal !== false;
    const scan = {
      id: makeId(),
      createdAt: Date.now(),
      name: `${modeLabel(mode)}-${new Date().toLocaleTimeString("zh-TW", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })}`,
      source,
      mode,
      status: mode === "original" ? "done" : "queued",
      progress: mode === "original" ? 100 : 0,
      note: mode === "original" ? "保留原圖" : hasLocalDetection ? "高解析精修中" : "本機找邊中",
      blob: mode === "original" ? originalBlob : null,
      originalBlob: mode === "original" ? null : originalBlob,
      localPoints: hasLocalDetection ? clonePointsV27(localDetection.points) : null,
      localFrame: hasLocalDetection ? { ...localDetection.frame } : null,
      localScore: hasLocalDetection ? localDetection.score : 0,
      smartLocal: shouldUseSmartLocal
    };

    await saveScan(scan);
    scans.unshift(scan);
    renderScans();
    setStatus(mode === "original" ? "已儲存原圖" : hasLocalDetection ? "已加入精修" : "已加入本機找邊", "ready");
    scheduleQueue();
  };

  processQueuedScan = async function patchedProcessQueuedScanV27(scan) {
    if (scan.smartLocal && scan.mode !== "original") {
      try {
        await processWithMagicLocal(scan);
        return;
      } catch (error) {
        console.warn("V27 local pass failed, falling back to AI", error);
        await updateScan(scan.id, {
          progress: 24,
          note: "本機找邊不穩，改用 AI"
        }, { persist: false });
      }
    }
    await processWithAiV27(scan);
  };

  function rebindControls() {
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

  setTimeout(rebindControls, 0);
  setTimeout(rebindControls, 600);

  function startMagicAssist() {
    if (assistTimer || !els.video) return;
    runMagicAssist();
    assistTimer = setInterval(runMagicAssist, 520);
  }

  function getUsableDetection() {
    if (!assistCandidate) return null;
    if (Date.now() - assistCandidate.seenAt > 1600) return null;
    if (!assistCandidate.locked && assistCandidate.score < 2.2) return null;
    return {
      points: clonePointsV27(assistCandidate.points),
      frame: { ...assistCandidate.frame },
      score: assistCandidate.score
    };
  }

  async function runMagicAssist() {
    if (assistBusy || !els.video || !els.video.videoWidth || !els.video.videoHeight) return;
    if (!cvReady || !window.cv || !cv.Mat) {
      drawMagicOverlay(null);
      return;
    }

    assistBusy = true;
    try {
      const sample = drawVideoSampleV27();
      const detected = detectDocumentV27(sample.canvas, { live: true });

      if (!detected) {
        stableCount = 0;
        assistCandidate = null;
        drawMagicOverlay(null);
        setStatus("尋找文件邊緣", "busy");
        return;
      }

      const videoPoints = scalePoints(detected.points, sample.videoScaleX, sample.videoScaleY);
      const movement = lastAssistPoints ? averagePointDistanceV27(videoPoints, lastAssistPoints) : Infinity;
      const threshold = Math.min(els.video.videoWidth, els.video.videoHeight) * 0.035;
      stableCount = movement < threshold ? stableCount + 1 : 1;
      lastAssistPoints = clonePointsV27(videoPoints);

      assistCandidate = {
        points: videoPoints,
        frame: {
          width: els.video.videoWidth,
          height: els.video.videoHeight
        },
        score: detected.score,
        locked: stableCount >= 2 || detected.score >= 2.45,
        seenAt: Date.now()
      };

      drawMagicOverlay(assistCandidate);
      setStatus(assistCandidate.locked ? "本機巡邊鎖定" : "正在貼齊邊緣", assistCandidate.locked ? "ready" : "busy");
    } catch (error) {
      console.warn("V27 assist failed", error);
      drawMagicOverlay(null);
    } finally {
      assistBusy = false;
    }
  }

  function drawVideoSampleV27() {
    if (!assistCanvas) assistCanvas = document.createElement("canvas");
    const videoWidth = els.video.videoWidth;
    const videoHeight = els.video.videoHeight;
    const maxSide = 860;
    const scale = Math.min(1, maxSide / Math.max(videoWidth, videoHeight));
    assistCanvas.width = Math.max(1, Math.round(videoWidth * scale));
    assistCanvas.height = Math.max(1, Math.round(videoHeight * scale));
    const ctx = assistCanvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(els.video, 0, 0, assistCanvas.width, assistCanvas.height);
    return {
      canvas: assistCanvas,
      videoScaleX: videoWidth / assistCanvas.width,
      videoScaleY: videoHeight / assistCanvas.height
    };
  }

  async function processWithMagicLocal(scan) {
    await updateScan(scan.id, { status: "processing", progress: 8, note: "讀取高解析照片" }, { persist: false });
    const sourceCanvas = await blobToCanvas(scan.originalBlob, 3800);
    await updateScan(scan.id, { progress: 22, note: "本機精修邊界" }, { persist: false });

    const refined = refinePointsOnStillCanvas(sourceCanvas, scan);
    if (!refined) throw new Error("本機找不到穩定外框");

    validateDocumentPoints(refined.points, sourceCanvas.width, sourceCanvas.height);
    await updateScan(scan.id, { progress: 56, note: refined.note }, { persist: false });
    let resultCanvas = cropWithPoints(sourceCanvas, refined.points, scan.mode);
    if (canvasLooksFlat(resultCanvas)) throw new Error("本機裁切結果太單一");

    await updateScan(scan.id, { progress: 82, note: "微調清晰度" }, { persist: false });
    resultCanvas = polishDocumentCanvas(resultCanvas, scan.mode);
    const blob = await canvasToBlob(resultCanvas, "image/jpeg", 0.97);

    await updateScan(scan.id, {
      status: "done",
      progress: 100,
      note: refined.source === "hint" ? "本機完成" : "本機精修完成",
      blob,
      originalBlob: null,
      localPoints: null,
      localFrame: null,
      smartLocal: false
    });
    flashOverlay(refined.points, sourceCanvas);
  }

  function refinePointsOnStillCanvas(sourceCanvas, scan) {
    const sample = downscaleCanvas(sourceCanvas, 1400);
    const detected = cvReady && window.cv && cv.Mat ? detectDocumentV27(sample, { live: false }) : null;
    const hintPoints = scan.localPoints && scan.localFrame
      ? mapFramePointsToCanvasV27(scan.localPoints, scan.localFrame, sourceCanvas)
      : null;

    if (detected) {
      const stillPoints = scalePoints(detected.points, sourceCanvas.width / sample.width, sourceCanvas.height / sample.height);
      if (!hintPoints) {
        return { points: stillPoints, source: "still", note: "本機高解析找邊" };
      }

      const distance = averagePointDistanceV27(stillPoints, hintPoints);
      const maxAccept = Math.min(sourceCanvas.width, sourceCanvas.height) * 0.18;
      if (distance < maxAccept || detected.score >= 2.35) {
        const mixed = mixPointsV27(hintPoints, stillPoints, detected.score >= 2.35 ? 0.78 : 0.62);
        return { points: mixed, source: "still", note: "本機高解析精修" };
      }
    }

    if (hintPoints) {
      return { points: hintPoints, source: "hint", note: "使用鎖定外框裁切" };
    }
    return null;
  }

  function detectDocumentV27(canvas, options = {}) {
    const src = cv.imread(canvas);
    const candidates = [];
    let gray;
    let blur;
    let edges;
    let kernel3;
    let kernel5;
    let binary;
    let binaryInv;
    let rgb;
    let hsv;
    let lowPaper;
    let highPaper;
    let paperMask;
    let gradX;
    let gradY;
    let absX;
    let absY;
    let gradient;

    try {
      gray = new cv.Mat();
      blur = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      kernel3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      kernel5 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));

      edges = new cv.Mat();
      cv.Canny(blur, edges, options.live ? 32 : 26, options.live ? 118 : 105);
      cv.dilate(edges, edges, kernel3, new cv.Point(-1, -1), 1);
      collectCandidatesV27(edges, canvas.width, canvas.height, "edge", candidates);

      binary = new cv.Mat();
      cv.adaptiveThreshold(blur, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 51, 8);
      cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel5, new cv.Point(-1, -1), 2);
      collectCandidatesV27(binary, canvas.width, canvas.height, "adaptive", candidates);

      binaryInv = new cv.Mat();
      cv.adaptiveThreshold(blur, binaryInv, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 45, 6);
      cv.morphologyEx(binaryInv, binaryInv, cv.MORPH_CLOSE, kernel5, new cv.Point(-1, -1), 2);
      collectCandidatesV27(binaryInv, canvas.width, canvas.height, "ink", candidates);

      rgb = new cv.Mat();
      hsv = new cv.Mat();
      paperMask = new cv.Mat();
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      lowPaper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 82, 0]);
      highPaper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 118, 255, 255]);
      cv.inRange(hsv, lowPaper, highPaper, paperMask);
      cv.morphologyEx(paperMask, paperMask, cv.MORPH_CLOSE, kernel5, new cv.Point(-1, -1), 2);
      collectCandidatesV27(paperMask, canvas.width, canvas.height, "paper", candidates);

      gradX = new cv.Mat();
      gradY = new cv.Mat();
      absX = new cv.Mat();
      absY = new cv.Mat();
      gradient = new cv.Mat();
      cv.Sobel(blur, gradX, cv.CV_16S, 1, 0, 3, 1, 0, cv.BORDER_DEFAULT);
      cv.Sobel(blur, gradY, cv.CV_16S, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT);
      cv.convertScaleAbs(gradX, absX);
      cv.convertScaleAbs(gradY, absY);
      cv.addWeighted(absX, 0.5, absY, 0.5, 0, gradient);
      cv.threshold(gradient, gradient, options.live ? 42 : 34, 255, cv.THRESH_BINARY);
      cv.dilate(gradient, gradient, kernel3, new cv.Point(-1, -1), 1);
      collectCandidatesV27(gradient, canvas.width, canvas.height, "gradient", candidates);
    } finally {
      [
        src, gray, blur, edges, kernel3, kernel5, binary, binaryInv, rgb, hsv,
        lowPaper, highPaper, paperMask, gradX, gradY, absX, absY, gradient
      ].forEach((mat) => {
        if (mat && typeof mat.delete === "function") mat.delete();
      });
    }

    if (!candidates.length) return null;

    const imageData = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    for (const candidate of candidates) {
      candidate.score += edgeContrastScoreV27(candidate.points, imageData) * 1.08;
      candidate.score += centerScoreV27(candidate.points, canvas.width, canvas.height) * 0.32;
      candidate.score -= borderPenaltyV27(candidate.points, canvas.width, canvas.height);
      candidate.score += paperInteriorScoreV27(candidate.points, imageData) * 0.34;
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].score >= (options.live ? 1.45 : 1.58) ? candidates[0] : null;
  }

  function collectCandidatesV27(binary, width, height, source, candidates) {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    try {
      cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const ranked = [];
      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        const area = cv.contourArea(contour);
        ranked.push({ index, area });
        contour.delete();
      }
      ranked.sort((a, b) => b.area - a.area);
      for (const item of ranked.slice(0, 42)) {
        const contour = contours.get(item.index);
        tryCandidateV27(contour, width, height, source, candidates);
        contour.delete();
      }
    } finally {
      contours.delete();
      hierarchy.delete();
    }
  }

  function tryCandidateV27(contour, width, height, source, candidates) {
    const perimeter = cv.arcLength(contour, true);
    if (!Number.isFinite(perimeter) || perimeter < Math.min(width, height) * 0.28) return;

    for (const ratio of [0.012, 0.018, 0.026, 0.038, 0.052]) {
      const approx = new cv.Mat();
      try {
        cv.approxPolyDP(contour, approx, perimeter * ratio, true);
        if (approx.rows === 4) {
          const candidate = scoreCandidateV27(pointsFromMatV27(approx), width, height, source);
          if (candidate) candidates.push(candidate);
          return;
        }
        if (approx.rows > 4 && approx.rows <= 9) {
          const simplified = simplifyPolygonToQuadV27(pointsFromMatV27(approx), width, height);
          const candidate = scoreCandidateV27(simplified, width, height, `${source}-simple`);
          if (candidate) candidates.push(candidate);
        }
      } finally {
        approx.delete();
      }
    }

    const hull = new cv.Mat();
    const hullApprox = new cv.Mat();
    try {
      cv.convexHull(contour, hull);
      cv.approxPolyDP(hull, hullApprox, perimeter * 0.032, true);
      if (hullApprox.rows >= 4 && hullApprox.rows <= 10) {
        const raw = hullApprox.rows === 4
          ? pointsFromMatV27(hullApprox)
          : simplifyPolygonToQuadV27(pointsFromMatV27(hullApprox), width, height);
        const candidate = scoreCandidateV27(raw, width, height, `${source}-hull`);
        if (candidate) candidates.push(candidate);
      }
    } finally {
      hull.delete();
      hullApprox.delete();
    }
  }

  function simplifyPolygonToQuadV27(points, width, height) {
    if (!points || points.length < 4) return points;
    const center = centroidV27(points);
    const buckets = [
      { score: Infinity, point: null },
      { score: Infinity, point: null },
      { score: -Infinity, point: null },
      { score: -Infinity, point: null }
    ];

    for (const point of points) {
      const sum = point.x + point.y;
      const diff = point.x - point.y;
      if (sum < buckets[0].score) buckets[0] = { score: sum, point };
      if (diff > buckets[1].score) buckets[1] = { score: diff, point };
      if (sum > buckets[2].score) buckets[2] = { score: sum, point };
      if (diff < buckets[3].score) buckets[3] = { score: diff, point };
    }

    const quad = buckets.map((bucket) => bucket.point).filter(Boolean);
    if (new Set(quad.map((point) => `${Math.round(point.x)}:${Math.round(point.y)}`)).size === 4) {
      return quad;
    }

    const radius = Math.min(width, height) * 0.02;
    return [
      { x: center.x - radius, y: center.y - radius },
      { x: center.x + radius, y: center.y - radius },
      { x: center.x + radius, y: center.y + radius },
      { x: center.x - radius, y: center.y + radius }
    ];
  }

  function scoreCandidateV27(rawPoints, width, height, source) {
    if (!rawPoints || rawPoints.length !== 4) return null;
    const points = orderCorners(rawPoints);
    const area = polygonArea(points);
    const areaRatio = area / (width * height);
    const minDim = Math.min(width, height);
    const maxDim = Math.max(width, height);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const boxWidth = Math.max(...xs) - Math.min(...xs);
    const boxHeight = Math.max(...ys) - Math.min(...ys);

    if (areaRatio < (activeMode === "card" ? 0.018 : 0.032) || areaRatio > 0.94) return null;
    if (boxWidth < minDim * 0.12 || boxHeight < minDim * 0.1) return null;

    const sides = [
      distance(points[0], points[1]),
      distance(points[1], points[2]),
      distance(points[2], points[3]),
      distance(points[3], points[0])
    ];
    if (Math.min(...sides) < minDim * 0.08) return null;
    if (Math.max(...sides) / Math.max(1, Math.min(...sides)) > 5.8) return null;

    const longSide = Math.max(boxWidth, boxHeight);
    const shortSide = Math.max(1, Math.min(boxWidth, boxHeight));
    const aspect = longSide / shortSide;
    if (activeMode === "card" && (aspect < 1.08 || aspect > 3.15)) return null;
    if (activeMode !== "card" && aspect > 4.8) return null;

    const angle = angleScoreV27(points);
    if (angle < 0.18) return null;

    const fill = area / Math.max(1, boxWidth * boxHeight);
    if (fill < 0.48) return null;

    const areaBoost = Math.min(1, areaRatio / (activeMode === "card" ? 0.18 : 0.42));
    const sizeBalance = 1 - Math.min(0.5, Math.abs(maxDim * 0.6 - longSide) / maxDim);
    const sourceBoost = {
      edge: 0.3,
      gradient: 0.28,
      paper: 0.2,
      adaptive: 0.14,
      ink: 0.08
    }[source.split("-")[0]] || 0.1;

    return {
      points,
      score: areaBoost * 0.82 + angle * 0.82 + fill * 0.46 + sizeBalance * 0.3 + sourceBoost,
      source
    };
  }

  async function processWithAiV27(scan) {
    try {
      await updateScan(scan.id, { status: "processing", progress: 28, note: "準備 AI 找邊" }, { persist: false });
      const sourceCanvas = await blobToCanvas(scan.originalBlob, 3200);
      const aiCanvas = downscaleCanvas(sourceCanvas, 960);
      const base64 = await canvasToJpegBase64(aiCanvas, 960, 0.74);
      await updateScan(scan.id, { progress: 36, note: "AI 找邊中" }, { persist: false });

      const stop = startAiProgressV27(scan.id);
      let aiPoints;
      try {
        aiPoints = await findCornersWithWorkerV27(base64, aiCanvas.width, aiCanvas.height);
      } finally {
        stop();
      }

      const points = scalePoints(aiPoints, sourceCanvas.width / aiCanvas.width, sourceCanvas.height / aiCanvas.height);
      await updateScan(scan.id, { progress: 84, note: "裁切拉正" }, { persist: false });
      let resultCanvas = cropWithPoints(sourceCanvas, points, scan.mode);
      if (canvasLooksFlat(resultCanvas)) throw new Error("AI 裁切結果太單一，請重拍");
      resultCanvas = polishDocumentCanvas(resultCanvas, scan.mode);
      const blob = await canvasToBlob(resultCanvas, "image/jpeg", 0.96);

      await updateScan(scan.id, {
        status: "done",
        progress: 100,
        note: "AI 完成",
        blob,
        originalBlob: null,
        localPoints: null,
        localFrame: null,
        smartLocal: false
      });
      flashOverlay(points, sourceCanvas);
    } catch (error) {
      console.error(error);
      await updateScan(scan.id, {
        status: "failed",
        progress: 100,
        note: error.message || "AI 處理失敗"
      });
    }
  }

  async function findCornersWithWorkerV27(base64, width, height) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 65000);
    let response;

    try {
      response = await fetch(WORKER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ image: base64, width, height })
      });
    } catch (error) {
      if (error.name === "AbortError" || /aborted/i.test(error.message || "")) {
        throw new Error("AI 等太久，請重拍或換亮一點");
      }
      throw new Error(error.message || "AI 連線失敗");
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Worker ${response.status}`);
    return normalizeWorkerPoints(data.points, width, height);
  }

  function startAiProgressV27(scanId) {
    const steps = [
      { after: 3500, progress: 46, note: "AI 檢查邊緣" },
      { after: 9000, progress: 59, note: "等待 AI 回傳" },
      { after: 18000, progress: 70, note: "AI 還在處理" },
      { after: 34000, progress: 81, note: "快完成了" },
      { after: 52000, progress: 88, note: "最後等待" }
    ];
    const startedAt = Date.now();
    let index = 0;
    let writing = false;

    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const step = steps[index];
      if (!step || elapsed < step.after || writing) return;
      index += 1;
      writing = true;
      updateScan(scanId, { progress: step.progress, note: step.note }, { persist: false })
        .finally(() => {
          writing = false;
        });
    }, 750);

    return () => clearInterval(timer);
  }

  function polishDocumentCanvas(canvas, mode) {
    const out = cloneCanvas(canvas);
    const ctx = out.getContext("2d", { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, out.width, out.height);
    const data = image.data;
    const values = [];
    const step = Math.max(4, Math.floor((out.width * out.height) / 60000));

    for (let pixel = 0; pixel < data.length; pixel += 4 * step) {
      values.push(luminanceRgb(data[pixel], data[pixel + 1], data[pixel + 2]));
    }
    values.sort((a, b) => a - b);
    const low = values[Math.floor(values.length * 0.02)] || 0;
    const high = values[Math.floor(values.length * 0.985)] || 255;
    const range = Math.max(36, high - low);
    const strength = mode === "card" ? 0.32 : 0.48;

    for (let index = 0; index < data.length; index += 4) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const lum = luminanceRgb(r, g, b);
      const sat = saturationRgb(r, g, b);
      const normalized = clamp((lum - low) / range, 0, 1) * 255;
      const target = lum < 82
        ? lum * 0.92
        : lum + (normalized - lum) * strength;
      const shadowLift = mode !== "card" && lum > 86 && lum < 205 && sat < 0.22 ? 10 : 0;
      const factor = (target + shadowLift) / Math.max(1, lum);
      data[index] = clamp(Math.round(r * factor), 0, 255);
      data[index + 1] = clamp(Math.round(g * factor), 0, 255);
      data[index + 2] = clamp(Math.round(b * factor), 0, 255);
    }

    ctx.putImageData(image, 0, 0);
    return out;
  }

  function drawMagicOverlay(candidate) {
    const overlay = els.overlay;
    if (!overlay) return;
    const viewWidth = overlay.clientWidth || overlay.offsetWidth || 1;
    const viewHeight = overlay.clientHeight || overlay.offsetHeight || 1;
    const ratio = window.devicePixelRatio || 1;
    overlay.width = Math.round(viewWidth * ratio);
    overlay.height = Math.round(viewHeight * ratio);

    const ctx = overlay.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, viewWidth, viewHeight);
    if (!candidate) return;

    const points = mapVideoPointsToOverlayV27(candidate.points, candidate.frame, viewWidth, viewHeight);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = candidate.locked ? "rgba(34, 211, 150, 0.98)" : "rgba(106, 181, 255, 0.9)";
    ctx.fillStyle = candidate.locked ? "rgba(34, 211, 150, 0.1)" : "rgba(106, 181, 255, 0.08)";
    ctx.lineWidth = candidate.locked ? 4.5 : 3;
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const corner = candidate.locked ? 24 : 18;
    for (let index = 0; index < points.length; index += 1) {
      const prev = points[(index + 3) % points.length];
      const point = points[index];
      const next = points[(index + 1) % points.length];
      drawCornerV27(ctx, point, prev, next, corner, candidate.locked);
    }
  }

  function drawCornerV27(ctx, point, prev, next, length, locked) {
    const a = normalizeV27({ x: prev.x - point.x, y: prev.y - point.y });
    const b = normalizeV27({ x: next.x - point.x, y: next.y - point.y });
    ctx.strokeStyle = locked ? "rgba(255, 255, 255, 0.96)" : "rgba(255, 255, 255, 0.78)";
    ctx.lineWidth = locked ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(point.x + a.x * length, point.y + a.y * length);
    ctx.lineTo(point.x, point.y);
    ctx.lineTo(point.x + b.x * length, point.y + b.y * length);
    ctx.stroke();
  }

  function mapFramePointsToCanvasV27(points, frame, canvas) {
    if (!frame || !frame.width || !frame.height) {
      return scalePoints(points, canvas.width / els.video.videoWidth, canvas.height / els.video.videoHeight);
    }
    const scale = Math.max(frame.width / canvas.width, frame.height / canvas.height);
    const offsetX = (frame.width - canvas.width * scale) / 2;
    const offsetY = (frame.height - canvas.height * scale) / 2;
    return points.map((point) => ({
      x: clamp((point.x - offsetX) / scale, 0, canvas.width),
      y: clamp((point.y - offsetY) / scale, 0, canvas.height)
    }));
  }

  function mapVideoPointsToOverlayV27(points, frame, viewWidth, viewHeight) {
    const videoWidth = frame.width || els.video.videoWidth || 1;
    const videoHeight = frame.height || els.video.videoHeight || 1;
    const scale = Math.max(viewWidth / videoWidth, viewHeight / videoHeight);
    const offsetX = (viewWidth - videoWidth * scale) / 2;
    const offsetY = (viewHeight - videoHeight * scale) / 2;
    return points.map((point) => ({
      x: offsetX + point.x * scale,
      y: offsetY + point.y * scale
    }));
  }

  function edgeContrastScoreV27(points, imageData) {
    const center = centroidV27(points);
    const offset = Math.max(4, Math.round(Math.min(imageData.width, imageData.height) * 0.01));
    let total = 0;
    let count = 0;

    for (let side = 0; side < points.length; side += 1) {
      const start = points[side];
      const end = points[(side + 1) % points.length];
      for (const t of [0.16, 0.28, 0.4, 0.52, 0.64, 0.76, 0.88]) {
        const x = start.x + (end.x - start.x) * t;
        const y = start.y + (end.y - start.y) * t;
        const inward = normalizeV27({ x: center.x - x, y: center.y - y });
        const inside = luminanceAtV27(imageData, x + inward.x * offset, y + inward.y * offset);
        const outside = luminanceAtV27(imageData, x - inward.x * offset, y - inward.y * offset);
        total += Math.abs(inside - outside);
        count += 1;
      }
    }

    return clamp((total / Math.max(1, count)) / 58, 0, 1);
  }

  function paperInteriorScoreV27(points, imageData) {
    const center = centroidV27(points);
    const samples = [
      center,
      mixPointV27(points[0], points[2], 0.45),
      mixPointV27(points[1], points[3], 0.45),
      mixPointV27(center, points[0], 0.32),
      mixPointV27(center, points[1], 0.32),
      mixPointV27(center, points[2], 0.32),
      mixPointV27(center, points[3], 0.32)
    ];
    let bright = 0;
    for (const point of samples) {
      const lum = luminanceAtV27(imageData, point.x, point.y);
      if (lum > 115) bright += 1;
    }
    return bright / samples.length;
  }

  function luminanceAtV27(imageData, x, y) {
    const px = Math.max(0, Math.min(imageData.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(imageData.height - 1, Math.round(y)));
    const index = (py * imageData.width + px) * 4;
    const data = imageData.data;
    return luminanceRgb(data[index], data[index + 1], data[index + 2]);
  }

  function angleScoreV27(points) {
    let total = 0;
    for (let index = 0; index < points.length; index += 1) {
      const prev = points[(index + 3) % 4];
      const current = points[index];
      const next = points[(index + 1) % 4];
      const a = normalizeV27({ x: prev.x - current.x, y: prev.y - current.y });
      const b = normalizeV27({ x: next.x - current.x, y: next.y - current.y });
      total += Math.abs(a.x * b.x + a.y * b.y);
    }
    return clamp(1 - total / 4 / 0.64, 0, 1);
  }

  function centerScoreV27(points, width, height) {
    const center = centroidV27(points);
    const dx = Math.abs(center.x - width / 2) / (width / 2);
    const dy = Math.abs(center.y - height / 2) / (height / 2);
    return clamp(1 - Math.sqrt(dx * dx + dy * dy) / 1.18, 0, 1);
  }

  function borderPenaltyV27(points, width, height) {
    const margin = Math.min(width, height) * 0.016;
    const near = points.filter((point) => (
      point.x < margin ||
      point.y < margin ||
      point.x > width - margin ||
      point.y > height - margin
    )).length;
    return near >= 3 ? 0.68 : near * 0.1;
  }

  function pointsFromMatV27(mat) {
    const points = [];
    const data = mat.data32S;
    for (let index = 0; index < mat.rows; index += 1) {
      points.push({ x: data[index * 2], y: data[index * 2 + 1] });
    }
    return points;
  }

  function averagePointDistanceV27(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    return a.reduce((sum, point, index) => sum + distance(point, b[index]), 0) / a.length;
  }

  function mixPointsV27(a, b, amount) {
    return a.map((point, index) => mixPointV27(point, b[index], amount));
  }

  function mixPointV27(a, b, amount) {
    return {
      x: a.x + (b.x - a.x) * amount,
      y: a.y + (b.y - a.y) * amount
    };
  }

  function centroidV27(points) {
    return points.reduce((sum, point) => ({
      x: sum.x + point.x / points.length,
      y: sum.y + point.y / points.length
    }), { x: 0, y: 0 });
  }

  function normalizeV27(vector) {
    const length = Math.hypot(vector.x, vector.y) || 1;
    return { x: vector.x / length, y: vector.y / length };
  }

  function luminanceRgb(r, g, b) {
    return r * 0.299 + g * 0.587 + b * 0.114;
  }

  function saturationRgb(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max <= 0 ? 0 : (max - min) / max;
  }

  function clonePointsV27(points) {
    return points.map((point) => ({ x: point.x, y: point.y }));
  }
})();
