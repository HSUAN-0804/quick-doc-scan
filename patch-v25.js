(() => {
  function startAiProgress(scanId) {
    const steps = [
      { after: 5000, progress: 42, note: "AI 分析中" },
      { after: 12000, progress: 55, note: "等待 AI 回應" },
      { after: 24000, progress: 68, note: "AI 還在處理" },
      { after: 45000, progress: 76, note: "等待時間較久" }
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
    }, 1000);

    return () => clearInterval(timer);
  }

  processQueuedScan = async function patchedProcessQueuedScan(scan) {
    try {
      await updateScan(scan.id, { status: "processing", progress: 8, note: "讀取原圖" }, { persist: false });
      const sourceCanvas = await blobToCanvas(scan.originalBlob, 3200);
      const aiCanvas = downscaleCanvas(sourceCanvas, 1280);
      await updateScan(scan.id, { progress: 18, note: "準備上傳" }, { persist: false });
      const base64 = await canvasToJpegBase64(aiCanvas, 1280, 0.82);
      await updateScan(scan.id, { progress: 32, note: "AI 找邊中" }, { persist: false });

      const stopAiProgress = startAiProgress(scan.id);
      let aiPoints;
      try {
        aiPoints = await findCornersWithWorker(base64, aiCanvas.width, aiCanvas.height);
      } finally {
        stopAiProgress();
      }

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
  };

  findCornersWithWorker = async function patchedFindCornersWithWorker(base64, width, height) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
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
        throw new Error("AI 回應逾時，請稍後重試");
      }
      throw new Error(error.message || "AI 連線失敗");
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Worker ${response.status}`);
    return normalizeWorkerPoints(data.points, width, height);
  };

  renderScans = function patchedRenderScans() {
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
      input.disabled = false;

      const previewBlob = scan.blob || scan.originalBlob;
      if (previewBlob) {
        image.src = URL.createObjectURL(previewBlob);
        image.onload = () => URL.revokeObjectURL(image.src);
        image.classList.add("can-expand");
        image.addEventListener("click", () => openImageViewer(scan.id));
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
  };

  saveScan = function patchedSaveScan(scan) {
    if (!db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const request = transaction.objectStore(STORE_NAME).put(prepareScanForStorage(scan));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || request.error || new Error("資料庫儲存中止"));
    });
  };

  readAllScans = function patchedReadAllScans() {
    if (!db) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      let result = [];
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        result = request.result.sort((a, b) => b.createdAt - a.createdAt);
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || request.error || new Error("資料庫讀取中止"));
    });
  };

  deleteScan = function patchedDeleteScan(id) {
    if (!db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const request = transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || request.error || new Error("資料庫刪除中止"));
    });
  };

  setTimeout(renderScans, 0);
})();
