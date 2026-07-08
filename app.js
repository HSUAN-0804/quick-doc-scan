const DB_NAME = "quick-scan-db";
const STORE_NAME = "scans";
const els = {
  video: document.querySelector("#camera"),
  cameraEmpty: document.querySelector("#cameraEmpty"),
  overlay: document.querySelector("#overlay"),
  openCamera: document.querySelector("#openCamera"),
  capture: document.querySelector("#capture"),
  filePicker: document.querySelector("#filePicker"),
  cvStatus: document.querySelector("#cvStatus"),
  sourceCanvas: document.querySelector("#sourceCanvas"),
  resultCanvas: document.querySelector("#resultCanvas"),
  strip: document.querySelector("#strip"),
  template: document.querySelector("#scanTemplate"),
  countText: document.querySelector("#countText"),
  selectAll: document.querySelector("#selectAll"),
  shareSelected: document.querySelector("#shareSelected"),
  downloadSelected: document.querySelector("#downloadSelected"),
  clearSelected: document.querySelector("#clearSelected"),
  modes: Array.from(document.querySelectorAll(".mode"))
};

let db;
let cameraStream;
let cvReady = false;
let activeMode = "document";
let scans = [];

window.onOpenCvLoaded = () => {
  if (window.cv && cv.Mat) {
    markCvReady();
    return;
  }

  if (window.cv) {
    cv.onRuntimeInitialized = markCvReady;
  }
};

function markCvReady() {
  cvReady = true;
  els.cvStatus.textContent = "OpenCV 可用";
  els.cvStatus.classList.add("is-ready");
}

async function init() {
  observeOpenCvLoad();
  db = await openDb();
  scans = await readAllScans();
  bindEvents();
  renderScans();
  registerServiceWorker();
}

function observeOpenCvLoad() {
  if (window.cv && cv.Mat) {
    markCvReady();
    return;
  }

  if (window.cv) {
    cv.onRuntimeInitialized = markCvReady;
    return;
  }

  setTimeout(() => {
    if (!cvReady) {
      setStatus("OpenCV 載入中", "busy");
    }
  }, 1800);
}

function bindEvents() {
  els.openCamera.addEventListener("click", startCamera);
  els.capture.addEventListener("click", captureCurrentFrame);
  els.filePicker.addEventListener("change", handlePickedFile);
  els.selectAll.addEventListener("click", toggleSelectAll);
  els.shareSelected.addEventListener("click", shareSelected);
  els.downloadSelected.addEventListener("click", downloadSelected);
  els.clearSelected.addEventListener("click", deleteSelected);

  for (const mode of els.modes) {
    mode.addEventListener("click", () => {
      activeMode = mode.dataset.mode;
      els.modes.forEach((item) => item.classList.toggle("is-active", item === mode));
    });
  }
}

async function startCamera() {
  try {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
    }

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });

    els.video.srcObject = cameraStream;
    await els.video.play();
    els.cameraEmpty.classList.add("is-hidden");
  } catch (error) {
    setStatus("相機需要 HTTPS", "busy");
    alert("iPhone 相機需要 HTTPS 網址。你也可以先用「相簿」選照片測試。");
  }
}

async function captureCurrentFrame() {
  if (!els.video.videoWidth) {
    await startCamera();
  }

  if (!els.video.videoWidth) return;

  const canvas = els.sourceCanvas;
  canvas.width = els.video.videoWidth;
  canvas.height = els.video.videoHeight;
  canvas.getContext("2d").drawImage(els.video, 0, 0, canvas.width, canvas.height);
  await processAndStore(canvas, "camera");
}

async function handlePickedFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const bitmap = await createImageBitmap(file);
  const canvas = els.sourceCanvas;
  const maxSide = 2200;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  await processAndStore(canvas, "photo");
  event.target.value = "";
}

async function processAndStore(sourceCanvas, source) {
  setStatus("處理中...", "busy");

  const result = activeMode === "original" || !cvReady
    ? copyOriginal(sourceCanvas)
    : scanWithOpenCv(sourceCanvas, activeMode);

  const blob = await canvasToBlob(result.canvas, result.type);
  const scan = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    name: `${modeLabel(activeMode)}-${new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
    source,
    mode: activeMode,
    note: result.note,
    blob
  };

  await saveScan(scan);
  scans.unshift(scan);
  renderScans();
  flashOverlay(result.points, sourceCanvas);
  setStatus(result.note || "已保存", "ready");
}

function scanWithOpenCv(canvas, mode) {
  const src = cv.imread(canvas);
  const work = new cv.Mat();
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  let best = null;
  let bestFallback = null;

  try {
    const maxDetectSide = 1200;
    const detectScale = Math.min(1, maxDetectSide / Math.max(src.cols, src.rows));
    cv.resize(src, work, new cv.Size(0, 0), detectScale, detectScale, cv.INTER_AREA);
    cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    const passes = [
      makeCannyPass(blur, 40, 120),
      makeCannyPass(blur, 60, 180),
      makeCannyPass(blur, 90, 240),
      makeThresholdPass(gray)
    ];

    for (const pass of passes) {
      const passContours = new cv.MatVector();
      const passHierarchy = new cv.Mat();
      cv.findContours(pass, passContours, passHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const candidate = findBestQuadrilateral(passContours, work.cols * work.rows);
      const fallback = findBestBoundingRectangle(passContours, work.cols * work.rows);

      if (candidate && (!best || candidate.score > best.score)) {
        if (best) best.mat.delete();
        best = candidate;
      } else if (candidate) {
        candidate.mat.delete();
      }

      if (fallback && (!bestFallback || fallback.score > bestFallback.score)) {
        if (bestFallback) bestFallback.mat.delete();
        bestFallback = fallback;
      } else if (fallback) {
        fallback.mat.delete();
      }

      pass.delete();
      passContours.delete();
      passHierarchy.delete();
    }

    if (!best) {
      if (!bestFallback) {
        return copyOriginal(canvas, "未找到外框，已保存原圖");
      }

      best = bestFallback;
      bestFallback = null;
    }

    const points = extractPoints(best.mat).map((point) => ({
      x: point.x / detectScale,
      y: point.y / detectScale
    }));
    const ordered = orderCorners(points);
    const size = outputSize(ordered, mode);
    const warped = warpFromPoints(src, ordered, size.width, size.height);

    cv.imshow(els.resultCanvas, warped);
    warped.delete();

    return {
      canvas: els.resultCanvas,
      type: "image/jpeg",
      points: ordered,
      note: best.kind === "fallback" ? "已用矩形裁切" : "已裁切拉正"
    };
  } finally {
    src.delete();
    work.delete();
    gray.delete();
    blur.delete();
    if (best) best.mat.delete();
    if (bestFallback) bestFallback.mat.delete();
  }
}

function findBestQuadrilateral(contours, frameArea) {
  let best = null;
  let bestScore = 0;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const perimeter = cv.arcLength(contour, true);
    const area = Math.abs(cv.contourArea(contour));

    if (area > frameArea * 0.035) {
      for (const epsilon of [0.012, 0.018, 0.026, 0.038, 0.055]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(contour, approx, epsilon * perimeter, true);

        const approxArea = Math.abs(cv.contourArea(approx));
        const isCandidate = approx.rows === 4 && approxArea > frameArea * 0.035 && cv.isContourConvex(approx);
        const score = approxArea - Math.abs(approxArea - area) * 0.08;

        if (isCandidate && score > bestScore) {
          if (best) best.delete();
          best = approx;
          bestScore = score;
        } else {
          approx.delete();
        }
      }
    }

    contour.delete();
  }

  return best ? { mat: best, score: bestScore, kind: "quad" } : null;
}

function findBestBoundingRectangle(contours, frameArea) {
  let best = null;
  let bestScore = 0;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = Math.abs(cv.contourArea(contour));

    if (area > frameArea * 0.045) {
      const rect = cv.boundingRect(contour);
      const rectArea = rect.width * rect.height;
      const fill = area / rectArea;
      const score = rectArea * Math.min(fill, 0.85);
      const isUsable = rect.width > 80 && rect.height > 80 && rectArea < frameArea * 0.98;

      if (isUsable && score > bestScore) {
        if (best) best.delete();
        best = matFromRect(rect);
        bestScore = score;
      }
    }

    contour.delete();
  }

  return best ? { mat: best, score: bestScore * 0.72, kind: "fallback" } : null;
}

function makeCannyPass(source, low, high) {
  const edges = new cv.Mat();
  cv.Canny(source, edges, low, high);
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
  cv.dilate(edges, edges, kernel);
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
  kernel.delete();
  return edges;
}

function makeThresholdPass(source) {
  const threshold = new cv.Mat();
  cv.adaptiveThreshold(source, threshold, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 8);
  cv.bitwise_not(threshold, threshold);
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
  cv.morphologyEx(threshold, threshold, cv.MORPH_CLOSE, kernel);
  kernel.delete();
  return threshold;
}

function matFromRect(rect) {
  return cv.matFromArray(4, 1, cv.CV_32SC2, [
    rect.x, rect.y,
    rect.x + rect.width, rect.y,
    rect.x + rect.width, rect.y + rect.height,
    rect.x, rect.y + rect.height
  ]);
}

function extractPoints(mat) {
  const points = [];
  for (let i = 0; i < mat.rows; i++) {
    const data = mat.intPtr(i, 0);
    points.push({ x: data[0], y: data[1] });
  }
  return points;
}

function orderCorners(points) {
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.x - a.y - (b.x - b.y));

  return [
    bySum[0],
    byDiff[3],
    bySum[3],
    byDiff[0]
  ];
}

function outputSize(points, mode) {
  const top = distance(points[0], points[1]);
  const right = distance(points[1], points[2]);
  const bottom = distance(points[2], points[3]);
  const left = distance(points[3], points[0]);
  let width = Math.max(top, bottom);
  let height = Math.max(right, left);

  if (mode === "card") {
    const cardRatio = 1.586;
    if (width / height > cardRatio) {
      height = width / cardRatio;
    } else {
      width = height * cardRatio;
    }
  }

  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(320, Math.round(width * scale)),
    height: Math.max(220, Math.round(height * scale))
  };
}

function warpFromPoints(src, points, width, height) {
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    points[0].x, points[0].y,
    points[1].x, points[1].y,
    points[2].x, points[2].y,
    points[3].x, points[3].y
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    width, 0,
    width, height,
    0, height
  ]);
  const matrix = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();

  cv.warpPerspective(src, dst, matrix, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

  srcTri.delete();
  dstTri.delete();
  matrix.delete();
  return dst;
}

function copyOriginal(canvas, note = "已保存原圖") {
  els.resultCanvas.width = canvas.width;
  els.resultCanvas.height = canvas.height;
  els.resultCanvas.getContext("2d").drawImage(canvas, 0, 0);
  return {
    canvas: els.resultCanvas,
    type: "image/jpeg",
    points: null,
    note
  };
}

function flashOverlay(points, sourceCanvas) {
  const overlay = els.overlay;
  const ctx = overlay.getContext("2d");
  overlay.width = overlay.clientWidth * devicePixelRatio;
  overlay.height = overlay.clientHeight * devicePixelRatio;
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  if (!points) return;

  const scaleX = overlay.width / sourceCanvas.width;
  const scaleY = overlay.height / sourceCanvas.height;
  ctx.strokeStyle = "rgba(33, 200, 138, 0.95)";
  ctx.lineWidth = 4 * devicePixelRatio;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = point.x * scaleX;
    const y = point.y * scaleY;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.stroke();
  setTimeout(() => ctx.clearRect(0, 0, overlay.width, overlay.height), 950);
}

function renderScans() {
  els.strip.innerHTML = "";
  els.countText.textContent = String(scans.length);

  if (!scans.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "還沒有圖片。先拍一張文件或證件。";
    els.strip.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const scan of scans) {
    const node = els.template.content.firstElementChild.cloneNode(true);
    const input = node.querySelector("input");
    const image = node.querySelector("img");
    const title = node.querySelector("strong");
    const time = node.querySelector("small");

    input.dataset.id = scan.id;
    image.src = URL.createObjectURL(scan.blob);
    image.onload = () => URL.revokeObjectURL(image.src);
    title.textContent = scan.name;
    time.textContent = `${modeLabel(scan.mode)} · ${scan.note}`;
    fragment.append(node);
  }

  els.strip.append(fragment);
}

function selectedScans() {
  const ids = new Set(Array.from(els.strip.querySelectorAll("input:checked")).map((input) => input.dataset.id));
  return scans.filter((scan) => ids.has(scan.id));
}

function toggleSelectAll() {
  const checks = Array.from(els.strip.querySelectorAll("input[type='checkbox']"));
  const shouldCheck = checks.some((input) => !input.checked);
  checks.forEach((input) => {
    input.checked = shouldCheck;
  });
}

async function shareSelected() {
  const selected = selectedScans();
  if (!selected.length) {
    alert("請先選取要分享的圖片。");
    return;
  }

  const files = selected.map((scan, index) => new File([scan.blob], `${scan.name || "scan"}-${index + 1}.jpg`, { type: "image/jpeg" }));

  if (navigator.canShare && navigator.canShare({ files })) {
    await navigator.share({
      files,
      title: "掃描文件",
      text: "掃描文件"
    });
  } else if (navigator.share && files.length === 1) {
    await navigator.share({
      title: "掃描文件",
      text: "掃描文件",
      url: URL.createObjectURL(files[0])
    });
  } else {
    alert("這個瀏覽器不支援多檔分享，我先幫你下載選取圖片。");
    await downloadSelected();
  }
}

async function downloadSelected() {
  const selected = selectedScans();
  if (!selected.length) {
    alert("請先選取要下載的圖片。");
    return;
  }

  for (const [index, scan] of selected.entries()) {
    const url = URL.createObjectURL(scan.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${scan.name || "scan"}-${index + 1}.jpg`;
    anchor.click();
    URL.revokeObjectURL(url);
    await wait(160);
  }
}

async function deleteSelected() {
  const selected = selectedScans();
  if (!selected.length) {
    alert("請先選取要刪除的圖片。");
    return;
  }

  await Promise.all(selected.map((scan) => deleteScan(scan.id)));
  const deleted = new Set(selected.map((scan) => scan.id));
  scans = scans.filter((scan) => !deleted.has(scan.id));
  renderScans();
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txStore(mode = "readonly") {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function saveScan(scan) {
  return new Promise((resolve, reject) => {
    const request = txStore("readwrite").put(scan);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function readAllScans() {
  return new Promise((resolve, reject) => {
    const request = txStore().getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
  });
}

function deleteScan(id) {
  return new Promise((resolve, reject) => {
    const request = txStore("readwrite").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function modeLabel(mode) {
  return {
    document: "文件",
    card: "證件",
    original: "原圖"
  }[mode] || "掃描";
}

function setStatus(text, kind) {
  els.cvStatus.textContent = text;
  els.cvStatus.classList.toggle("is-ready", kind === "ready");
  els.cvStatus.classList.toggle("is-busy", kind === "busy");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init().catch((error) => {
  console.error(error);
  alert("初始化失敗，請重新整理。");
});
