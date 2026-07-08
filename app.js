const DB_NAME = "quick-scan-db";
const STORE_NAME = "scans";
const WORKER_ENDPOINT = "https://quick-doc-scan-ai.a0952767271.workers.dev";

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
let previewDrag = null;
let queueRunning = false;

window.onOpenCvLoaded = () => {
  if (window.cv && cv.Mat) {
    markCvReady();
    return;
  }
  if (window.cv) cv.onRuntimeInitialized = markCvReady;
};

function markCvReady() {
  cvReady = true;
  setStatus("OpenCV 可用", "ready");
}

async function init() {
  observeOpenCvLoad();
  db = await openDb();
  scans = await readAllScans();
  resetInterruptedJobs();
  preventPageZoom();
  bindEvents();
  syncLibraryExpanded();
  renderScans();
  runQueue();
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
  window.addEventListener("resize", () => syncLibraryExpanded());

  for (const mode of els.modes) {
    mode.addEventListener("click", () => {
      activeMode = mode.dataset.mode;
      els.modes.forEach((item) => item.classList.toggle("is-active", item === mode));
    });
  }
}

async function startCamera() {
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
  } catch (error) {
    setStatus("相機需要 HTTPS", "busy");
    alert("iPhone 相機需要 Safari/主畫面 App 並允許相機權限。");
  }
}

async function tuneCameraTrack(stream) {
  const track = stream.getVideoTracks && stream.getVideoTracks()[0];
  if (!track || !track.getCapabilities || !track.applyConstraints) return;

  const caps = track.getCapabilities();
  const advanced = [];

  if (caps.focusMode && caps.focusMode.includes("continuous")) advanced.push({ focusMode: "continuous" });
  if (caps.exposureMode && caps.exposureMode.includes("continuous")) advanced.push({ exposureMode: "continuous" });
  if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes("continuous")) advanced.push({ whiteBalanceMode: "continuous" });
  if (caps.zoom && Number.isFinite(caps.zoom.min)) advanced.push({ zoom: caps.zoom.min });

  if (advanced.length) {
    await track.applyConstraints({ advanced }).catch(() => {});
  }
}

async function captureCurrentFrame() {
  if (!els.video.videoWidth) await startCamera();
  if (!els.video.videoWidth) return;

  const photoBlob = await captureStillPhoto();
  if (photoBlob) {
    await createScanJobFromBlob(photoBlob, "camera");
    return;
  }

  const canvas = els.sourceCanvas;
  canvas.width = els.video.videoWidth;
  canvas.height = els.video.videoHeight;
  canvas.getContext("2d").drawImage(els.video, 0, 0, canvas.width, canvas.height);
  await createScanJob(canvas, "camera");
}

async function captureStillPhoto() {
  const track = cameraStream && cameraStream.getVideoTracks && cameraStream.getVideoTracks()[0];
  if (!track || typeof ImageCapture === "undefined") return null;

  try {
    const capture = new ImageCapture(track);
    const settings = await bestPhotoSettings(capture);
    return await capture.takePhoto(settings);
  } catch (error) {
    console.warn("ImageCapture fallback", error);
    return null;
  }
}

async function bestPhotoSettings(capture) {
  if (!capture.getPhotoCapabilities) return {};

  try {
    const caps = await capture.getPhotoCapabilities();
    const settings = {};
    if (caps.imageWidth && Number.isFinite(caps.imageWidth.max)) settings.imageWidth = caps.imageWidth.max;
    if (caps.imageHeight && Number.isFinite(caps.imageHeight.max)) settings.imageHeight = caps.imageHeight.max;
    return settings;
  } catch (error) {
    return {};
  }
}

async function handlePickedFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  await createScanJobFromBlob(file, "photo");
  event.target.value = "";
}

async function createScanJob(canvas, source) {
  const mode = activeMode;
  const originalBlob = await canvasToBlob(canvas, "image/jpeg", 0.97);
  await createScanJobFromBlob(originalBlob, source, mode);
}

async function createScanJobFromBlob(originalBlob, source, scanMode = activeMode) {
  const mode = scanMode;
  const scan = {
    id: makeId(),
    createdAt: Date.now(),
    name: `${modeLabel(mode)}-${new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
    source,
    mode,
    status: mode === "original" ? "done" : "queued",
    progress: mode === "original" ? 100 : 0,
    note: mode === "original" ? "已存原圖" : "等待 AI",
    blob: mode === "original" ? originalBlob : null,
    originalBlob: mode === "original" ? null : originalBlob
  };

  await saveScan(scan);
  scans.unshift(scan);
  renderScans();
  setStatus(mode === "original" ? "已儲存" : "已加入背景處理", "ready");
  runQueue();
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;

  try {
    while (true) {
      const scan = scans.find((item) => item.status === "queued" || item.status === "processing");
      if (!scan) break;
      await processQueuedScan(scan);
    }
  } finally {
    queueRunning = false;
  }
}

async function processQueuedScan(scan) {
  try {
    await updateScan(scan.id, { status: "processing", progress: 8, note: "讀取原圖" }, { persist: false });
    const sourceCanvas = await blobToCanvas(scan.originalBlob, 3200);
    const aiCanvas = downscaleCanvas(sourceCanvas, 1280);
    await updateScan(scan.id, { progress: 18, note: "準備上傳" }, { persist: false });
    const base64 = await canvasToJpegBase64(aiCanvas, 1280, 0.82);
    await updateScan(scan.id, { progress: 32, note: "AI 找邊中" }, { persist: false });

    const aiPoints = await findCornersWithWorker(base64, aiCanvas.width, aiCanvas.height);
    const points = scalePoints(aiPoints, sourceCanvas.width / aiCanvas.width, sourceCanvas.height / aiCanvas.height);
    await updateScan(scan.id, { progress: 82, note: "校正圖片" }, { persist: false });
    const resultCanvas = cropWithPoints(sourceCanvas, points, scan.mode);
    if (canvasLooksFlat(resultCanvas)) throw new Error("AI 結果像色塊，請重拍清楚一點");
    const blob = await canvasToBlob(resultCanvas, "image/jpeg", 0.95);

    await updateScan(scan.id, {
      status: "done",
      progress: 100,
      note: "完成",
      blob,
      originalBlob: null
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

async function findCornersWithWorker(base64, width, height) {
  const response = await fetch(WORKER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      image: base64,
      width,
      height
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Worker ${response.status}`);
  }

  return normalizeWorkerPoints(data.points, width, height);
}

function normalizeWorkerPoints(points, width, height) {
  if (!Array.isArray(points) || points.length < 4) throw new Error("AI 沒有找到四角");
  const ordered = orderCorners(points.slice(0, 4).map((point) => ({
    x: clamp(Number(point.x), 0, width),
    y: clamp(Number(point.y), 0, height)
  })));
  validateDocumentPoints(ordered, width, height);
  return ordered;
}

function validateDocumentPoints(points, width, height) {
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new Error("AI 回傳座標異常");
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const boxWidth = Math.max(...xs) - Math.min(...xs);
  const boxHeight = Math.max(...ys) - Math.min(...ys);
  const minSide = Math.min(width, height);
  const area = polygonArea(points);

  if (boxWidth < minSide * 0.08 || boxHeight < minSide * 0.08 || area < width * height * 0.006) {
    throw new Error("AI 邊框太小，請重拍清楚一點");
  }
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function cropWithPoints(canvas, points, mode) {
  if (!cvReady) return cropBoundingBox(canvas, points);

  const src = cv.imread(canvas);
  const size = outputSize(points, mode);
  const warped = warpFromPoints(src, points, size.width, size.height);
  cv.imshow(els.resultCanvas, warped);
  src.delete();
  warped.delete();
  return cloneCanvas(els.resultCanvas);
}

function cropBoundingBox(canvas, points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = clamp(Math.min(...xs), 0, canvas.width);
  const y = clamp(Math.min(...ys), 0, canvas.height);
  const width = clamp(Math.max(...xs) - x, 1, canvas.width - x);
  const height = clamp(Math.max(...ys) - y, 1, canvas.height - y);
  els.resultCanvas.width = width;
  els.resultCanvas.height = height;
  els.resultCanvas.getContext("2d").drawImage(canvas, x, y, width, height, 0, 0, width, height);
  return cloneCanvas(els.resultCanvas);
}

function canvasLooksFlat(canvas) {
  const sample = document.createElement("canvas");
  const size = 24;
  sample.width = size;
  sample.height = size;
  const ctx = sample.getContext("2d");
  ctx.drawImage(canvas, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  let total = 0;
  let totalSq = 0;
  let count = 0;

  for (let index = 0; index < data.length; index += 4) {
    const value = (data[index] + data[index + 1] + data[index + 2]) / 3;
    total += value;
    totalSq += value * value;
    count += 1;
  }

  const mean = total / count;
  const variance = totalSq / count - mean * mean;
  return variance < 14;
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

function outputSize(points, mode) {
  const top = distance(points[0], points[1]);
  const right = distance(points[1], points[2]);
  const bottom = distance(points[2], points[3]);
  const left = distance(points[3], points[0]);
  let width = Math.max(top, bottom);
  let height = Math.max(right, left);

  if (mode === "card") {
    const cardRatio = 1.586;
    if (width >= height) height = width / cardRatio;
    else width = height / cardRatio;
  }

  const maxSide = 3200;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(320, Math.round(width * scale)),
    height: Math.max(220, Math.round(height * scale))
  };
}

function orderCorners(points) {
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.x - a.y - (b.x - b.y));
  return [bySum[0], byDiff[3], bySum[3], byDiff[0]];
}

async function updateScan(id, patch, options = {}) {
  const scan = scans.find((item) => item.id === id);
  if (!scan) return;
  Object.assign(scan, patch);
  if (options.persist !== false) await saveScan(scan);
  renderScans();
}

function resetInterruptedJobs() {
  for (const scan of scans) {
    if (
      scan.status === "processing" ||
      (scan.status === "failed" && scan.originalBlob && isOldKeyError(scan.note))
    ) {
      scan.status = "queued";
      scan.progress = Math.min(scan.progress || 0, 20);
      scan.note = "重新排隊";
      saveScan(scan);
    }
  }
}

function isOldKeyError(note) {
  return /KEY|key|Gemini API key|尚未輸入|輸入/.test(String(note || ""));
}

function renderScans() {
  els.strip.innerHTML = "";
  els.countText.textContent = String(scans.length);

  if (!scans.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "拍照後會先顯示進度，完成後才顯示圖片";
    els.strip.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const scan of scans) {
    const status = scan.status || "done";
    const node = els.template.content.firstElementChild.cloneNode(true);
    const input = node.querySelector("input");
    const image = node.querySelector("img");
    const title = node.querySelector(".scan-meta strong");
    const time = node.querySelector(".scan-meta small");
    const progress = node.querySelector(".progress-ring");
    const progressText = node.querySelector(".progress-ring strong");
    const progressNote = node.querySelector(".progress-card small");

    node.classList.add(status === "done" ? "is-done" : status === "failed" ? "is-failed" : "is-processing");
    input.dataset.id = scan.id;
    input.disabled = status !== "done" || !scan.blob;

    const previewBlob = scan.blob || scan.originalBlob;
    if (previewBlob) {
      image.src = URL.createObjectURL(previewBlob);
      image.onload = () => URL.revokeObjectURL(image.src);
    }

    const pct = Math.round(scan.progress || 0);
    progress.style.setProperty("--progress", String(pct));
    progressText.textContent = status === "failed" ? "!" : `${pct}%`;
    progressNote.textContent = scan.note || (status === "queued" ? "等待 AI" : "處理中");
    title.textContent = scan.name;
    time.textContent = `${modeLabel(scan.mode)} / ${scan.note || ""}`;
    fragment.append(node);
  }
  els.strip.append(fragment);
}

function selectedScans() {
  const ids = new Set(Array.from(els.strip.querySelectorAll("input:checked")).map((input) => input.dataset.id));
  return scans.filter((scan) => ids.has(scan.id) && scan.blob && (scan.status || "done") === "done");
}

function toggleSelectAll() {
  const checks = Array.from(els.strip.querySelectorAll("input[type='checkbox']:not(:disabled)"));
  const shouldCheck = checks.some((input) => !input.checked);
  checks.forEach((input) => {
    input.checked = shouldCheck;
  });
}

async function shareSelected() {
  const selected = selectedScans();
  if (!selected.length) {
    alert("請先選擇已完成的照片。");
    return;
  }

  const files = selected.map((scan, index) => new File([scan.blob], `${scan.name || "scan"}-${index + 1}.jpg`, { type: "image/jpeg" }));
  if (navigator.canShare && navigator.canShare({ files })) {
    await navigator.share({ files, title: "掃描文件", text: "掃描文件" });
  } else {
    alert("這個瀏覽器不支援多張直接分享，會改成下載。");
    await downloadSelected();
  }
}

async function downloadSelected() {
  const selected = selectedScans();
  if (!selected.length) {
    alert("請先選擇已完成的照片。");
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
  const ids = new Set(Array.from(els.strip.querySelectorAll("input:checked")).map((input) => input.dataset.id));
  if (!ids.size) {
    alert("請先選擇要刪除的照片。");
    return;
  }

  await Promise.all(Array.from(ids).map((id) => deleteScan(id)));
  scans = scans.filter((scan) => !ids.has(scan.id));
  renderScans();
}

function startPreviewResize(event) {
  event.preventDefault();
  previewDrag = {
    startY: event.clientY,
    startHeight: els.libraryPane.getBoundingClientRect().height
  };
  els.resizeGrip.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", resizePreview);
  window.addEventListener("pointerup", stopPreviewResize, { once: true });
}

function resizePreview(event) {
  if (!previewDrag) return;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const min = viewportHeight * 0.18;
  const max = viewportHeight * 0.96;
  const next = clamp(previewDrag.startHeight + previewDrag.startY - event.clientY, min, max);
  document.documentElement.style.setProperty("--library-height", `${Math.round(next)}px`);
  syncLibraryExpanded(next, viewportHeight);
}

function stopPreviewResize() {
  previewDrag = null;
  window.removeEventListener("pointermove", resizePreview);
}

function syncLibraryExpanded(height, viewportHeight) {
  const viewHeight = viewportHeight || window.innerHeight || document.documentElement.clientHeight;
  const currentHeight = height || els.libraryPane.getBoundingClientRect().height;
  document.body.classList.toggle("library-expanded", currentHeight >= viewHeight * 0.75);
}

async function blobToCanvas(blob, maxSide) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function downscaleCanvas(canvas, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  if (scale >= 1) return cloneCanvas(canvas);

  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

function scalePoints(points, scaleX, scaleY) {
  return points.map((point) => ({
    x: point.x * scaleX,
    y: point.y * scaleY
  }));
}

function cloneCanvas(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext("2d").drawImage(source, 0, 0);
  return canvas;
}

async function canvasToJpegBase64(canvas, maxSide, quality) {
  const out = document.createElement("canvas");
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", quality).split(",")[1];
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
    const request = txStore("readwrite").put(prepareScanForStorage(scan));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function prepareScanForStorage(scan) {
  return {
    ...scan,
    blob: cloneBlobForStorage(scan.blob),
    originalBlob: cloneBlobForStorage(scan.originalBlob)
  };
}

function cloneBlobForStorage(blob) {
  if (!(blob instanceof Blob)) return blob || null;
  return blob.slice(0, blob.size, blob.type || "image/jpeg");
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

function canvasToBlob(canvas, type, quality = 0.92) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
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

function preventPageZoom() {
  let lastTouchEnd = 0;

  document.addEventListener("touchend", (event) => {
    const now = Date.now();
    if (now - lastTouchEnd < 360) event.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  document.addEventListener("dblclick", (event) => {
    event.preventDefault();
  }, { passive: false });

  for (const eventName of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(eventName, (event) => {
      event.preventDefault();
    }, { passive: false });
  }
}

init().catch((error) => {
  console.error(error);
  alert("啟動失敗，請重新整理後再試。");
});
