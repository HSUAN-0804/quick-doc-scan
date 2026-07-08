(() => {
  const previousStartCamera = startCamera;
  const previousCaptureStillPhoto = typeof captureStillPhoto === "function" ? captureStillPhoto : null;

  let assistTimer = null;
  let assistBusy = false;
  let assistCandidate = null;
  let assistCanvas = null;
  let assistStableCount = 0;
  let lastAssistPoints = null;

  startCamera = async function patchedStartCameraV26() {
    await previousStartCamera();
    startLocalScanAssist();
  };

  captureCurrentFrame = async function patchedCaptureCurrentFrameV26() {
    if (!els.video.videoWidth) await startCamera();
    if (!els.video.videoWidth) return;

    const localDetection = getUsableLocalDetection();
    if (activeMode !== "original" && localDetection) {
      setStatus("用本機巡邊裁切", "busy");
      let photoBlob = null;
      if (previousCaptureStillPhoto) {
        photoBlob = await previousCaptureStillPhoto();
      }

      if (photoBlob) {
        await createScanJobFromBlob(photoBlob, "camera", activeMode, localDetection);
        return;
      }

      const canvas = els.sourceCanvas;
      canvas.width = els.video.videoWidth;
      canvas.height = els.video.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(els.video, 0, 0, canvas.width, canvas.height);
      await createScanJob(canvas, "camera", localDetection);
      return;
    }

    const photoBlob = await (previousCaptureStillPhoto ? previousCaptureStillPhoto() : Promise.resolve(null));
    if (photoBlob) {
      await createScanJobFromBlob(photoBlob, "camera");
      return;
    }

    const canvas = els.sourceCanvas;
    canvas.width = els.video.videoWidth;
    canvas.height = els.video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(els.video, 0, 0, canvas.width, canvas.height);
    await createScanJob(canvas, "camera");
  };

  createScanJob = async function patchedCreateScanJobV26(canvas, source, localDetection = null) {
    const mode = activeMode;
    const originalBlob = await canvasToBlob(canvas, "image/jpeg", 0.98);
    await createScanJobFromBlob(originalBlob, source, mode, localDetection);
  };

  createScanJobFromBlob = async function patchedCreateScanJobFromBlobV26(
    originalBlob,
    source,
    scanMode = activeMode,
    localDetection = null
  ) {
    const mode = scanMode;
    const hasLocalDetection = Boolean(localDetection && localDetection.points && localDetection.frame);
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
      note: mode === "original" ? "保留原圖" : hasLocalDetection ? "本機巡邊鎖定" : "等待 AI",
      blob: mode === "original" ? originalBlob : null,
      originalBlob: mode === "original" ? null : originalBlob,
      localPoints: hasLocalDetection ? clonePoints(localDetection.points) : null,
      localFrame: hasLocalDetection ? { ...localDetection.frame } : null,
      localScore: hasLocalDetection ? localDetection.score : 0
    };

    await saveScan(scan);
    scans.unshift(scan);
    renderScans();
    setStatus(mode === "original" ? "已儲存原圖" : hasLocalDetection ? "已加入本機裁切" : "已加入 AI 處理", "ready");
    scheduleQueue();
  };

  processQueuedScan = async function patchedProcessQueuedScanV26(scan) {
    if (scan.localPoints && scan.localFrame) {
      try {
        await processWithLocalDetection(scan);
        return;
      } catch (error) {
        console.warn("Local document crop failed, falling back to AI", error);
        await updateScan(scan.id, {
          progress: 18,
          note: "本機裁切不穩，改用 AI"
        }, { persist: false });
      }
    }

    await processWithAi(scan);
  };

  function startLocalScanAssist() {
    if (assistTimer || !els.video) return;
    runLocalScanAssist();
    assistTimer = setInterval(runLocalScanAssist, 850);
  }

  function getUsableLocalDetection() {
    if (!assistCandidate) return null;
    if (Date.now() - assistCandidate.seenAt > 2600) return null;
    if (!assistCandidate.locked && assistCandidate.score < 2.05) return null;
    return {
      points: clonePoints(assistCandidate.points),
      frame: {
        width: assistCandidate.frame.width,
        height: assistCandidate.frame.height
      },
      score: assistCandidate.score
    };
  }

  async function runLocalScanAssist() {
    if (assistBusy) return;
    if (!els.video || !els.video.videoWidth || !els.video.videoHeight) return;

    if (!cvReady || !window.cv || !cv.Mat) {
      drawAssistOverlay(null);
      return;
    }

    assistBusy = true;
    try {
      const sample = drawVideoSample();
      const detected = detectLocalDocument(sample.canvas);
      if (!detected) {
        assistStableCount = 0;
        assistCandidate = null;
        drawAssistOverlay(null);
        setStatus("尋找文件邊緣", "busy");
        return;
      }

      const videoPoints = scalePoints(detected.points, sample.videoScaleX, sample.videoScaleY);
      const distance = lastAssistPoints ? averagePointDistance(videoPoints, lastAssistPoints) : Infinity;
      const stableThreshold = Math.min(els.video.videoWidth, els.video.videoHeight) * 0.045;
      assistStableCount = distance < stableThreshold ? assistStableCount + 1 : 1;
      lastAssistPoints = clonePoints(videoPoints);

      assistCandidate = {
        points: videoPoints,
        frame: {
          width: els.video.videoWidth,
          height: els.video.videoHeight
        },
        score: detected.score,
        locked: assistStableCount >= 2 || detected.score >= 2.25,
        seenAt: Date.now()
      };

      drawAssistOverlay(assistCandidate);
      setStatus(assistCandidate.locked ? "本機巡邊鎖定" : "正在對齊文件", assistCandidate.locked ? "ready" : "busy");
    } catch (error) {
      console.warn("Local scan assist failed", error);
      drawAssistOverlay(null);
    } finally {
      assistBusy = false;
    }
  }

  function drawVideoSample() {
    if (!assistCanvas) assistCanvas = document.createElement("canvas");
    const videoWidth = els.video.videoWidth;
    const videoHeight = els.video.videoHeight;
    const maxSide = 720;
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

  function detectLocalDocument(canvas) {
    const src = cv.imread(canvas);
    const candidates = [];
    let gray;
    let blur;
    let edges;
    let kernel;
    let binary;
    let rgb;
    let hsv;
    let low;
    let high;
    let mask;

    try {
      gray = new cv.Mat();
      blur = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

      edges = new cv.Mat();
      kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
      cv.Canny(blur, edges, 38, 125);
      cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 1);
      collectContourCandidates(edges, canvas.width, canvas.height, "edge", candidates);

      binary = new cv.Mat();
      cv.adaptiveThreshold(blur, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 41, 7);
      cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
      collectContourCandidates(binary, canvas.width, canvas.height, "light", candidates);

      rgb = new cv.Mat();
      hsv = new cv.Mat();
      mask = new cv.Mat();
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 92, 0]);
      high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 105, 255, 255]);
      cv.inRange(hsv, low, high, mask);
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
      collectContourCandidates(mask, canvas.width, canvas.height, "paper", candidates);
    } finally {
      [src, gray, blur, edges, kernel, binary, rgb, hsv, low, high, mask].forEach((mat) => {
        if (mat && typeof mat.delete === "function") mat.delete();
      });
    }

    if (!candidates.length) return null;

    const imageData = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    for (const candidate of candidates) {
      const contrast = edgeContrastScore(candidate.points, imageData);
      const center = centerScore(candidate.points, canvas.width, canvas.height);
      const border = borderPenalty(candidate.points, canvas.width, canvas.height);
      candidate.score += contrast * 0.95 + center * 0.3 - border;
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  function collectContourCandidates(binary, width, height, source, candidates) {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    try {
      cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const limit = Math.min(contours.size(), 32);
      const ranked = [];

      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        const area = cv.contourArea(contour);
        ranked.push({ index, area });
        contour.delete();
      }

      ranked.sort((a, b) => b.area - a.area);
      for (const item of ranked.slice(0, limit)) {
        const contour = contours.get(item.index);
        tryCandidateFromContour(contour, width, height, source, candidates);
        contour.delete();
      }
    } finally {
      contours.delete();
      hierarchy.delete();
    }
  }

  function tryCandidateFromContour(contour, width, height, source, candidates) {
    const perimeter = cv.arcLength(contour, true);
    if (!Number.isFinite(perimeter) || perimeter < Math.min(width, height) * 0.35) return;

    const approximations = [0.018, 0.026, 0.036];
    for (const epsilon of approximations) {
      const approx = new cv.Mat();
      try {
        cv.approxPolyDP(contour, approx, perimeter * epsilon, true);
        if (approx.rows === 4) {
          const candidate = scoreCandidate(pointsFromMat(approx), width, height, source);
          if (candidate) candidates.push(candidate);
          return;
        }
      } finally {
        approx.delete();
      }
    }

    const hull = new cv.Mat();
    const hullApprox = new cv.Mat();
    try {
      cv.convexHull(contour, hull);
      cv.approxPolyDP(hull, hullApprox, perimeter * 0.035, true);
      if (hullApprox.rows === 4) {
        const candidate = scoreCandidate(pointsFromMat(hullApprox), width, height, `${source}-hull`);
        if (candidate) candidates.push(candidate);
      }
    } finally {
      hull.delete();
      hullApprox.delete();
    }
  }

  function scoreCandidate(rawPoints, width, height, source) {
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
    if (areaRatio < (activeMode === "card" ? 0.025 : 0.045) || areaRatio > 0.91) return null;
    if (boxWidth < minDim * 0.16 || boxHeight < minDim * 0.13) return null;

    const sides = [
      distance(points[0], points[1]),
      distance(points[1], points[2]),
      distance(points[2], points[3]),
      distance(points[3], points[0])
    ];
    if (Math.min(...sides) < minDim * 0.11) return null;
    if (Math.max(...sides) / Math.max(1, Math.min(...sides)) > 5.2) return null;

    const longSide = Math.max(boxWidth, boxHeight);
    const shortSide = Math.max(1, Math.min(boxWidth, boxHeight));
    const aspect = longSide / shortSide;
    if (activeMode === "card" && (aspect < 1.1 || aspect > 2.9)) return null;
    if (activeMode !== "card" && aspect > 4.4) return null;

    const angle = angleScore(points);
    if (angle < 0.25) return null;

    const fill = area / Math.max(1, boxWidth * boxHeight);
    const areaBoost = Math.min(1, areaRatio / 0.36);
    const sourceBoost = source === "edge" ? 0.22 : source === "paper" ? 0.14 : 0.08;
    const sizeBalance = 1 - Math.min(0.45, Math.abs(maxDim * 0.58 - longSide) / maxDim);

    return {
      points,
      score: areaBoost * 0.85 + angle * 0.75 + fill * 0.42 + sizeBalance * 0.28 + sourceBoost,
      source
    };
  }

  function pointsFromMat(mat) {
    const points = [];
    const data = mat.data32S;
    for (let index = 0; index < mat.rows; index += 1) {
      points.push({
        x: data[index * 2],
        y: data[index * 2 + 1]
      });
    }
    return points;
  }

  async function processWithLocalDetection(scan) {
    await updateScan(scan.id, { status: "processing", progress: 8, note: "讀取原圖" }, { persist: false });
    const sourceCanvas = await blobToCanvas(scan.originalBlob, 3600);
    const points = mapFramePointsToCanvas(scan.localPoints, scan.localFrame, sourceCanvas);
    validateDocumentPoints(points, sourceCanvas.width, sourceCanvas.height);

    await updateScan(scan.id, { progress: 52, note: "本機拉正文件" }, { persist: false });
    const resultCanvas = cropWithPoints(sourceCanvas, points, scan.mode);
    if (canvasLooksFlat(resultCanvas)) throw new Error("本機裁切結果太單一");

    const blob = await canvasToBlob(resultCanvas, "image/jpeg", 0.96);
    await updateScan(scan.id, {
      status: "done",
      progress: 100,
      note: "本機完成",
      blob,
      originalBlob: null,
      localPoints: null,
      localFrame: null
    });
    flashOverlay(points, sourceCanvas);
  }

  async function processWithAi(scan) {
    try {
      await updateScan(scan.id, { status: "processing", progress: 8, note: "讀取原圖" }, { persist: false });
      const sourceCanvas = await blobToCanvas(scan.originalBlob, 3200);
      const aiCanvas = downscaleCanvas(sourceCanvas, 1024);
      await updateScan(scan.id, { progress: 18, note: "準備 AI 找邊" }, { persist: false });
      const base64 = await canvasToJpegBase64(aiCanvas, 1024, 0.76);
      await updateScan(scan.id, { progress: 32, note: "AI 找邊中" }, { persist: false });

      const stopAiProgress = startAiProgressV26(scan.id);
      let aiPoints;
      try {
        aiPoints = await findCornersWithWorkerV26(base64, aiCanvas.width, aiCanvas.height);
      } finally {
        stopAiProgress();
      }

      const points = scalePoints(aiPoints, sourceCanvas.width / aiCanvas.width, sourceCanvas.height / aiCanvas.height);
      await updateScan(scan.id, { progress: 82, note: "裁切拉正" }, { persist: false });
      const resultCanvas = cropWithPoints(sourceCanvas, points, scan.mode);
      if (canvasLooksFlat(resultCanvas)) throw new Error("AI 裁切結果太單一，請重拍");
      const blob = await canvasToBlob(resultCanvas, "image/jpeg", 0.95);

      await updateScan(scan.id, {
        status: "done",
        progress: 100,
        note: "完成",
        blob,
        originalBlob: null,
        localPoints: null,
        localFrame: null
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

  async function findCornersWithWorkerV26(base64, width, height) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 75000);
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
        throw new Error("AI 等太久，請重拍或稍後再試");
      }
      throw new Error(error.message || "AI 連線失敗");
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Worker ${response.status}`);
    return normalizeWorkerPoints(data.points, width, height);
  }

  function startAiProgressV26(scanId) {
    const steps = [
      { after: 4500, progress: 44, note: "AI 分析文件邊界" },
      { after: 10000, progress: 57, note: "等待 AI 回傳" },
      { after: 20000, progress: 68, note: "AI 還在處理" },
      { after: 38000, progress: 78, note: "網路較慢，持續等待" },
      { after: 58000, progress: 86, note: "最後等待中" }
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
    }, 800);

    return () => clearInterval(timer);
  }

  function mapFramePointsToCanvas(points, frame, canvas) {
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

  function drawAssistOverlay(candidate) {
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

    const displayPoints = mapVideoPointsToOverlay(candidate.points, candidate.frame, viewWidth, viewHeight);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = candidate.locked ? "rgba(33, 200, 138, 0.96)" : "rgba(95, 180, 255, 0.86)";
    ctx.fillStyle = candidate.locked ? "rgba(33, 200, 138, 0.08)" : "rgba(95, 180, 255, 0.08)";
    ctx.lineWidth = candidate.locked ? 4 : 3;
    ctx.beginPath();
    displayPoints.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    for (const point of displayPoints) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, candidate.locked ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = candidate.locked ? "rgba(33, 200, 138, 0.98)" : "rgba(95, 180, 255, 0.94)";
      ctx.fill();
    }
  }

  function mapVideoPointsToOverlay(points, frame, viewWidth, viewHeight) {
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

  function edgeContrastScore(points, imageData) {
    const center = centroid(points);
    let total = 0;
    let count = 0;
    const offset = Math.max(5, Math.round(Math.min(imageData.width, imageData.height) * 0.012));

    for (let side = 0; side < points.length; side += 1) {
      const start = points[side];
      const end = points[(side + 1) % points.length];
      for (const t of [0.22, 0.38, 0.54, 0.7]) {
        const x = start.x + (end.x - start.x) * t;
        const y = start.y + (end.y - start.y) * t;
        const towardCenter = normalize({ x: center.x - x, y: center.y - y });
        const inside = luminanceAt(imageData, x + towardCenter.x * offset, y + towardCenter.y * offset);
        const outside = luminanceAt(imageData, x - towardCenter.x * offset, y - towardCenter.y * offset);
        total += Math.abs(inside - outside);
        count += 1;
      }
    }

    return clamp((total / Math.max(1, count)) / 64, 0, 1);
  }

  function luminanceAt(imageData, x, y) {
    const px = Math.max(0, Math.min(imageData.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(imageData.height - 1, Math.round(y)));
    const index = (py * imageData.width + px) * 4;
    const data = imageData.data;
    return data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
  }

  function angleScore(points) {
    let total = 0;
    for (let index = 0; index < points.length; index += 1) {
      const prev = points[(index + 3) % 4];
      const current = points[index];
      const next = points[(index + 1) % 4];
      const a = normalize({ x: prev.x - current.x, y: prev.y - current.y });
      const b = normalize({ x: next.x - current.x, y: next.y - current.y });
      total += Math.abs(a.x * b.x + a.y * b.y);
    }
    return clamp(1 - total / 4 / 0.62, 0, 1);
  }

  function centerScore(points, width, height) {
    const center = centroid(points);
    const dx = Math.abs(center.x - width / 2) / (width / 2);
    const dy = Math.abs(center.y - height / 2) / (height / 2);
    return clamp(1 - Math.sqrt(dx * dx + dy * dy) / 1.2, 0, 1);
  }

  function borderPenalty(points, width, height) {
    const margin = Math.min(width, height) * 0.018;
    const near = points.filter((point) => (
      point.x < margin ||
      point.y < margin ||
      point.x > width - margin ||
      point.y > height - margin
    )).length;
    return near >= 3 ? 0.65 : near * 0.12;
  }

  function averagePointDistance(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    return a.reduce((sum, point, index) => sum + distance(point, b[index]), 0) / a.length;
  }

  function centroid(points) {
    return points.reduce((sum, point) => ({
      x: sum.x + point.x / points.length,
      y: sum.y + point.y / points.length
    }), { x: 0, y: 0 });
  }

  function normalize(vector) {
    const length = Math.hypot(vector.x, vector.y) || 1;
    return { x: vector.x / length, y: vector.y / length };
  }

  function clonePoints(points) {
    return points.map((point) => ({ x: point.x, y: point.y }));
  }
})();
