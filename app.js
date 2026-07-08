const DB_NAME = "quick-scan-db";
const STORE_NAME = "scans";
const GEMINI_KEY = "quick-scan-gemini-key";
const GEMINI_CONSENT = "quick-scan-gemini-consent";
const GEMINI_MODEL = "gemini-3.5-flash";

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
  if (!els.video.videoWidth) await startCamera();
  if (!els.video.videoWidth) return;

  const canvas = els.sourceCanvas;
  canvas.width = els.video.videoWidth;
  canvas.height = els.video.videoHeight;
  canvas.getContext("2d").drawImage(els.video, 0, 0, canvas.width, canvas.height);
  await createScanJob(canvas, "camera");
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
  await createScanJob(canvas, "photo");
  event.target.value = "";
}

async function createScanJob(canvas, source) {
  const mode = activeMode;
  const originalBlob = await canvasToBlob(canvas, "image/jpeg", 0.92);
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
    await updateScan(scan.id, { status: "processing", progress: 8, note: "壓縮照片" });
    const key = await getGeminiKey();
    if (!key) throw new Error("尚未輸入 Gemini API key");
    if (!confirmGeminiUpload()) throw new Error("已取消 AI 處理");

    const sourceCanvas = await blobToCanvas(scan.originalBlob, 1600);
    await updateScan(scan.id, { progress: 18, note: "準備上傳" });
    const base64 = await canvasToJpegBase64(sourceCanvas, 1280, 0.78);
    await updateScan(scan.id, { progress: 32, note: "AI 找邊中" });

    const points = await askGeminiForCorners(key, base64, sourceCanvas.width, sourceCanvas.height);
    await updateScan(scan.id, { progress: 82, note: "校正圖片" });
    const resultCanvas = cropWithPoints(sourceCanvas, points, scan.mode);
    const blob = await canvasToBlob(resultCanvas, "image/jpeg", 0.92);

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

async function askGeminiForCorners(key, base64, width, height) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: [
        {
          type: "text",
          text: [
            "Find the four visible corners of the main document or ID card in this image.",
            "Return JSON only, no markdown.",
            "Coordinates must be normalized from 0 to 1000 relative to the full image.",
            "Use this exact shape:",
            "{\"points\":[{\"x\":0,\"y\":0},{\"x\":1000,\"y\":0},{\"x\":1000,\"y\":1000},{\"x\":0,\"y\":1000}],\"confidence\":0.0}",
            "Point order must be top-left, top-right, bottom-right, bottom-left.",
            "If unsure, estimate the document rectangle."
          ].join(" ")
        },
        {
          type: "image",
          data: base64,
          mime_type: "image/jpeg"
        }
      ]
    })
  });

  if (!response.ok) throw new Error(`Gemini API ${response.status}`);
  const data = await response.json();
  const parsed = parseJsonFromText(extractText(data));
  return normalizeGeminiPoints(parsed, width, height);
}

async function getGeminiKey() {
  let key = localStorage.getItem(GEMINI_KEY) || "";
  if (key) return key;

  key = prompt("貼上 Google AI Studio / Gemini API key。Key 只會存在這台裝置的瀏覽器本地，不會寫進 GitHub。") || "";
  key = key.trim();
  if (!key) return "";

  localStorage.setItem(GEMINI_KEY, key);
  return key;
}

function confirmGeminiUpload() {
  if (localStorage.getItem(GEMINI_CONSENT) === "1") return true;
  const ok = confirm("AI 處理會把這張照片傳到 Google Gemini API。文件和證件可能含個資，確定要使用嗎？");
  if (ok) localStorage.setItem(GEMINI_CONSENT, "1");
  return ok;
}

function extractText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.output_text) return value.output_text;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (typeof value === "object") return Object.values(value).map(extractText).filter(Boolean).join("\n");
  return "";
}

function parseJsonFromText(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("AI 沒有回傳座標");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeGeminiPoints(parsed, width, height) {
  const raw = parsed && Array.isArray(parsed.points) ? parsed.points : null;
  if (!raw || raw.length < 4) throw new Error("AI 沒有找到四角");
  return orderCorners(raw.slice(0, 4).map((point) => ({
    x: clamp(Number(point.x) / 1000 * width, 0, width),
    y: clamp(Number(point.y) / 1000 * height, 0, height)
  })));
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

  const maxSide = 1900;
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

async function updateScan(id, patch) {
  const scan = scans.find((item) => item.id === id);
  if (!scan) return;
  Object.assign(scan, patch);
  await saveScan(scan);
  renderScans();
}

function resetInterruptedJobs() {
  for (const scan of scans) {
    if (scan.status === "processing") {
      scan.status = "queued";
      scan.progress = Math.min(scan.progress || 0, 20);
      scan.note = "重新排隊";
      saveScan(scan);
    }
  }
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

    if (status === "done" && scan.blob) {
      image.src = URL.createObjectURL(scan.blob);
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
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
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
  out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
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

init().catch((error) => {
  console.error(error);
  alert("啟動失敗，請重新整理後再試。");
});
