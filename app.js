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
  libraryPane: document.querySelector("#libraryPane"),
  resizeGrip: document.querySelector("#resizeGrip"),
  modes: Array.from(document.querySelectorAll(".mode"))
};

let db;
let cameraStream;
let cvReady = false;
let activeMode = "document";
let scans = [];
let dragState = null;

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
  setStatus("OpenCV 可用", "ready");
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
    if (!cvReady) setStatus("OpenCV 載入中", "busy");
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
  els.resizeGrip.addEventListener("pointerdown", startPreviewResize);

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
    alert("iPhone 相機需要 Safari/主畫面 App 並允許相機權限。");
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
  const maxSide = 2400;
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
    id: makeId(),
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
  setStatus(result.note || "已儲存", "ready");
}

function scanWithOpenCv(canvas, mode) {
  const src = cv.imread(canvas);
  const work = new cv.Mat();
  const gray = new cv.Mat();
  const equalized = new cv.Mat();
  const blur = new cv.Mat();
  let best = null;

  try {
    const maxDetectSide = 1280;
    const detectScale = Math.min(1, maxDetectSide / Math.max(src.cols, src.rows));
    cv.resize(src, work, new cv.Size(0, 0), detectScale, detectScale, cv.INTER_AREA);
    cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
    cv.equalizeHist(gray, equalized);
    cv.GaussianBlur(equalized, blur, new cv.Size(5, 5), 0);

    const passes = [
      makeCannyPass(blur, 30, 100, 7),
      makeCannyPass(blur, 50, 160, 5),
      makeCannyPass(blur, 80, 220, 3),
      makeThresholdPass(equalized, 31, 7),
      makeThresholdPass(gray, 51, 10)
    ];

    for (const pass of passes) {
      const passBest = findBestDocumentCandidate(pass, work.cols * work.rows);
      if (passBest && (!best || passBest.score > best.score)) {
        best = passBest;
      }
      pass.delete();
    }

    if (!best) {
      best = safeFrameCandidate(work.cols, work.rows);
    }

    const points = best.points.map((point) => ({
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
      note: best.note
    };
  } catch (error) {
    console.error(error);
    return copyOriginal(canvas, "已存原圖");
  } finally {
    src.delete();
    work.delete();
    gray.delete();
    equalized.delete();
    blur.delete();
  }
}

function findBestDocumentCandidate(binary, frameArea) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let best = null;

  try {
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = Math.abs(cv.contourArea(contour));
      const minArea = frameArea * 0.025;
      const maxArea = frameArea * 0.985;

      if (area >= minArea && area <= maxArea) {
        const quad = candidateFromApprox(contour, area, frameArea);
        const corners = candidateFromContourCorners(contour, area, frameArea);
        const rotated = candidateFromMinAreaRect(contour, area, frameArea);

        for (const candidate of [quad, corners, rotated]) {
          if (candidate && (!best || candidate.score > best.score)) {
            best = candidate;
          }
        }
      }

      contour.delete();
    }
  } finally {
    contours.delete();
    hierarchy.delete();
  }

  return best;
}

function candidateFromApprox(contour, area, frameArea) {
  const perimeter = cv.arcLength(contour, true);
  let best = null;

  for (const epsilon of [0.01, 0.016, 0.024, 0.035, 0.055, 0.08]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, epsilon * perimeter, true);

    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const points = extractIntPoints(approx);
      const quadArea = polygonArea(points);
      const quality = shapeQuality(points, frameArea);
      const score = quadArea * 1.25 + area * 0.2 + quality * frameArea * 0.18;
      best = scoreCandidate(best, { points, score, note: "已抓到外框" });
    }

    approx.delete();
  }

  return best;
}

function candidateFromContourCorners(contour, area, frameArea) {
  const points = extractContourCornerPoints(contour);
  if (!points) return null;

  const quadArea = polygonArea(orderCorners(points));
  if (quadArea < frameArea * 0.02) return null;

  return {
    points,
    score: quadArea * 1.05 + area * 0.18 + shapeQuality(points, frameArea) * frameArea * 0.14,
    note: "已用角點校正"
  };
}

function candidateFromMinAreaRect(contour, area, frameArea) {
  const rect = cv.minAreaRect(contour);
  const rectArea = rect.size.width * rect.size.height;

  if (rectArea < frameArea * 0.035 || rectArea > frameArea * 0.985) return null;

  const ratio = Math.max(rect.size.width, rect.size.height) / Math.max(1, Math.min(rect.size.width, rect.size.height));
  if (ratio > 8) return null;

  const points = rotatedRectPoints(rect);
  const fill = Math.min(1, area / Math.max(1, rectArea));

  return {
    points,
    score: rectArea * (0.66 + fill * 0.22) + shapeQuality(points, frameArea) * frameArea * 0.08,
    note: "已用旋轉外框"
  };
}

function safeFrameCandidate(width, height) {
  const insetX = Math.round(width * 0.025);
  const insetY = Math.round(height * 0.025);

  return {
    points: [
      { x: insetX, y: insetY },
      { x: width - insetX, y: insetY },
      { x: width - insetX, y: height - insetY },
      { x: insetX, y: height - insetY }
    ],
    score: 1,
    note: "已存整張"
  };
}

function scoreCandidate(current, next) {
  if (!current || next.score > current.score) return next;
  return current;
}

function makeCannyPass(source, low, high, kernelSize) {
  const edges = new cv.Mat();
  cv.Canny(source, edges, low, high);
  const kernel = cv.Mat.ones(kernelSize, kernelSize, cv.CV_8U);
  cv.dilate(edges, edges, kernel);
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
  kernel.delete();
  return edges;
}

function makeThresholdPass(source, blockSize, cValue) {
  const threshold = new cv.Mat();
  cv.adaptiveThreshold(source, threshold, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, cValue);
  const inverted = new cv.Mat();
  cv.bitwise_not(threshold, inverted);
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
  cv.morphologyEx(inverted, inverted, cv.MORPH_CLOSE, kernel);
  threshold.delete();
  kernel.delete();
  return inverted;
}

function extractIntPoints(mat) {
  const points = [];
  for (let i = 0; i < mat.rows; i++) {
    const data = mat.intPtr(i, 0);
    points.push({ x: data[0], y: data[1] });
  }
  return points;
}

function extractContourCornerPoints(contour) {
  const rect = cv.minAreaRect(contour);
  const center = rect.center;
  const corners = {
    topLeft: null,
    topRight: null,
    bottomRight: null,
    bottomLeft: null
  };
  const distances = {
    topLeft: -1,
    topRight: -1,
    bottomRight: -1,
    bottomLeft: -1
  };

  for (let i = 0; i < contour.data32S.length; i += 2) {
    const point = { x: contour.data32S[i], y: contour.data32S[i + 1] };
    const distanceFromCenter = distance(point, center);
    let key = null;

    if (point.x <= center.x && point.y <= center.y) key = "topLeft";
    else if (point.x > center.x && point.y <= center.y) key = "topRight";
    else if (point.x > center.x && point.y > center.y) key = "bottomRight";
    else key = "bottomLeft";

    if (distanceFromCenter > distances[key]) {
      corners[key] = point;
      distances[key] = distanceFromCenter;
    }
  }

  if (!corners.topLeft || !corners.topRight || !corners.bottomRight || !corners.bottomLeft) {
    return null;
  }

  return [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
}

function rotatedRectPoints(rect) {
  const cx = rect.center.x;
  const cy = rect.center.y;
  const width = rect.size.width;
  const height = rect.size.height;
  const angle = rect.angle * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const halves = [
    { x: -width / 2, y: -height / 2 },
    { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 },
    { x: -width / 2, y: height / 2 }
  ];

  return halves.map((point) => ({
    x: cx + point.x * cos - point.y * sin,
    y: cy + point.x * sin + point.y * cos
  }));
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

function shapeQuality(points, frameArea) {
  const ordered = orderCorners(points);
  const area = polygonArea(ordered);
  const top = distance(ordered[0], ordered[1]);
  const right = distance(ordered[1], ordered[2]);
  const bottom = distance(ordered[2], ordered[3]);
  const left = distance(ordered[3], ordered[0]);
  const width = Math.max(top, bottom);
  const height = Math.max(right, left);
  const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
  const areaScore = Math.min(1, area / (frameArea * 0.62));
  const ratioScore = ratio > 0.9 && ratio < 3.2 ? 1 : 0.62;

  return areaScore * ratioScore;
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
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
    if (width >= height) {
      height = width / cardRatio;
    } else {
      width = height / cardRatio;
    }
  }

  const maxSide = 1900;
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

function copyOriginal(canvas, note = "已存原圖") {
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
    empty.textContent = "拍照後會自動裁切、拉正，並顯示在這裡";
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
    time.textContent = `${modeLabel(scan.mode)} / ${scan.note}`;
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
    alert("請先選擇要分享的照片。");
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
    alert("這個瀏覽器不支援多張直接分享，會改成下載。");
    await downloadSelected();
  }
}

async function downloadSelected() {
  const selected = selectedScans();
  if (!selected.length) {
    alert("請先選擇要下載的照片。");
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
    alert("請先選擇要刪除的照片。");
    return;
  }

  await Promise.all(selected.map((scan) => deleteScan(scan.id)));
  const deleted = new Set(selected.map((scan) => scan.id));
  scans = scans.filter((scan) => !deleted.has(scan.id));
  renderScans();
}

function startPreviewResize(event) {
  event.preventDefault();
  dragState = {
    startY: event.clientY,
    startHeight: els.libraryPane.getBoundingClientRect().height
  };
  els.resizeGrip.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", resizePreview);
  window.addEventListener("pointerup", stopPreviewResize, { once: true });
}

function resizePreview(event) {
  if (!dragState) return;

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const min = viewportHeight * 0.18;
  const max = viewportHeight * 0.62;
  const next = clamp(dragState.startHeight + dragState.startY - event.clientY, min, max);
  document.documentElement.style.setProperty("--library-height", `${Math.round(next)}px`);
}

function stopPreviewResize() {
  dragState = null;
  window.removeEventListener("pointermove", resizePreview);
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
  alert("啟動失敗，請重新整理後再試。");
});
