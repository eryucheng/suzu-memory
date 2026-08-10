const state = {
  apiKey: sessionStorage.getItem("suzu-memory-api-key") || "",
  overview: null,
  selected: null,
  view: "reviews",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(date)
    : String(value);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 18 ? `${text.slice(0, 9)}…${text.slice(-6)}` : text;
}

const TYPE_LABELS = {
  ingestion: "记忆升级",
  "reported-state": "人物状态",
  structure: "主题与事件簇",
  relation: "因果关系",
  "maintenance-failure": "维护失败",
};
const STATE_LABELS = {
  pending: "待审",
  accepted: "已接受",
  dismissed: "已驳回",
  revoked: "已撤销",
};

async function api(pathname, options = {}) {
  const headers = { accept: "application/json", ...(options.headers || {}) };
  if (state.apiKey) headers.authorization = `Bearer ${state.apiKey}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(pathname, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status !== "success") {
    const error = new Error(payload?.error?.message || `请求失败：HTTP ${response.status}`);
    error.code = payload?.error?.code || "HTTP_ERROR";
    throw error;
  }
  return payload.data;
}

function toast(message, error = false) {
  const item = document.createElement("div");
  item.className = `toast${error ? " error" : ""}`;
  item.textContent = message;
  $("#toast-region").append(item);
  setTimeout(() => item.remove(), 4200);
}

function empty(message) {
  return `<div class="empty-list">${escapeHtml(message)}</div>`;
}

function metric(label, value, note, tone) {
  return `<article class="metric ${tone}">
    <small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong><span>${escapeHtml(note)}</span>
  </article>`;
}

function renderMetrics() {
  const counts = state.overview?.counts || {};
  $("#metric-grid").innerHTML = [
    metric("等待审核", counts.reviews || 0, "尚未进入正式长期记忆", "amber"),
    metric("阻塞事件", counts.blockedEvents || 0, "保留原文，等待处理", "red"),
    metric("运行批次", counts.activeBatches || 0, `${counts.expiredBatches || 0} 个租约已过期`, "blue"),
    metric("维护异常", counts.failedMaintenance || 0, `${counts.pendingMaintenance || 0} 个任务等待执行`, "green"),
  ].join("");
}

function reviewRow(item) {
  const selected = state.selected?.id === item.id && state.selected?.type === item.type;
  return `<button class="review-row${selected ? " selected" : ""}" data-review-type="${escapeHtml(item.type)}" data-review-id="${escapeHtml(item.id)}">
    <div class="row-top"><strong>${escapeHtml(item.title)}</strong><span class="badge ${escapeHtml(item.reviewState)}">${escapeHtml(STATE_LABELS[item.reviewState] || item.reviewState)}</span></div>
    <p>${escapeHtml(item.statement || "没有候选正文")}</p>
    <div class="row-meta"><span class="badge type">${escapeHtml(TYPE_LABELS[item.type] || item.type)}</span><span>${escapeHtml(item.action || "create")}</span><span>${escapeHtml(formatTime(item.createdAt))}</span></div>
  </button>`;
}

function renderReviews() {
  const reviews = state.overview?.reviews || { total: 0, items: [] };
  $("#review-list").innerHTML = reviews.items.length
    ? reviews.items.map(reviewRow).join("")
    : empty("当前筛选条件下没有记忆候选");
  $("#queue-caption").textContent = `当前显示 ${reviews.items.length} 条候选`;
  $("#nav-review-count").textContent = String(reviews.total || 0);
}

function healthItem({ title, stateName = "", body = "", action = "" }) {
  return `<article class="health-item"><div class="health-item-head"><strong>${escapeHtml(title)}</strong>${stateName ? `<span class="badge ${escapeHtml(stateName)}">${escapeHtml(stateName)}</span>` : ""}</div>${body ? `<p>${escapeHtml(body)}</p>` : ""}${action}</article>`;
}

function renderPipeline() {
  const pipeline = state.overview?.pipeline || {};
  const blocked = pipeline.blockedEvents?.items || [];
  $("#blocked-events").innerHTML = blocked.length ? blocked.map((item) => healthItem({
    title: item.external_id || item.id,
    stateName: "blocked",
    body: item.last_error || "等待处理",
  })).join("") : empty("没有卡住的输入事件");

  const active = pipeline.activeBatches || [];
  $("#active-batches").innerHTML = active.length ? active.map((batch) => healthItem({
    title: shortId(batch.id),
    stateName: batch.leaseExpired ? "expired" : "processing",
    body: `${batch.event_count} 个事件 · ${batch.input_character_count} 字符\n租约：${formatTime(batch.lease_expires_at)}`,
    action: batch.leaseExpired
      ? `<div class="health-actions"><button class="button secondary recover-batch" data-batch-id="${escapeHtml(batch.id)}">恢复批次</button></div>`
      : "",
  })).join("") : empty("没有运行中的输入批次");

  const failed = pipeline.failedBatches || [];
  $("#failed-batches").innerHTML = failed.length ? failed.map((batch) => healthItem({
    title: shortId(batch.id),
    stateName: "failed",
    body: batch.error_message || "未记录失败原因",
  })).join("") : empty("没有失败批次");

  const maintenance = state.overview?.maintenance?.tasks || [];
  $("#maintenance-tasks").innerHTML = maintenance.length ? maintenance.map((task) => healthItem({
    title: task.task_type,
    stateName: task.status,
    body: `${task.lane} · 尝试 ${task.attempt_count}/${task.max_attempts}${task.error_message ? `\n${task.error_message}` : ""}`,
  })).join("") : empty("没有等待或失败的维护任务");
  $("#nav-pipeline-count").textContent = String((pipeline.blockedEvents?.total || 0) + (pipeline.expiredBatchCount || 0));
}

function storageMeta(entries) {
  return `<dl class="storage-meta">${entries.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

function renderStorage() {
  const storage = state.overview?.storage || {};
  const active = storage.activeDatabase || {};
  $("#active-database").innerHTML = `<span class="storage-status ${escapeHtml(active.status)}">${active.status === "valid" ? "运行库健康" : "运行库异常"}</span><h2>当前记忆数据库</h2><p>每次打开审核台都会运行 SQLite quick_check，不修改任何记忆内容。</p>${storageMeta([
    ["状态", active.status || "unknown"],
    ["大小", formatBytes(active.bytes)],
    ["位置", active.databasePath || "—"],
  ])}`;
  const backups = storage.backups || { status: "missing", total: 0, latest: null };
  const latest = backups.latest || {};
  const statusLabel = backups.status === "valid" ? "最新备份健康" : backups.status === "missing" ? "尚无备份" : "最新备份异常";
  $("#latest-backup").innerHTML = `<span class="storage-status ${escapeHtml(backups.status)}">${escapeHtml(statusLabel)}</span><h2>数据库备份</h2><p>校验最新备份的 SQLite 完整性、SHA-256 清单和 Agent 归属。</p>${storageMeta([
    ["备份数量", String(backups.total || 0)],
    ["最新时间", latest.createdAt || latest.modifiedAt || "—"],
    ["最新备份", latest.databasePath || "—"],
    ...(latest.error ? [["错误", latest.error]] : []),
  ])}`;
  $("#nav-storage-state").textContent = backups.status === "valid" ? "正常" : backups.status === "missing" ? "未建" : "异常";
}

function memoryCard(memory, emptyText = "没有现有状态") {
  if (!memory) return `<div class="memory-card"><p>${escapeHtml(emptyText)}</p></div>`;
  return `<div class="memory-card"><h4>${escapeHtml(memory.title || memory.kind || memory.id)}</h4><p>${escapeHtml(memory.content)}</p><div class="card-meta"><span>${escapeHtml(memory.kind)}</span><span>${escapeHtml(memory.subjectRole || "unknown")}</span><span>${escapeHtml(memory.stateFamily || memory.layer || "")}</span><span>${escapeHtml(memory.eventDate || formatTime(memory.knownAt))}</span></div></div>`;
}

function writePreviewCard(preview) {
  const title = preview.title || preview.kind || preview.relation || "候选内容";
  const content = preview.content || preview.rationale || (preview.fromMemoryId && preview.toMemoryId ? `${preview.fromMemoryId} → ${preview.toMemoryId}` : "");
  const tags = Object.entries(preview || {}).filter(([key, value]) => value !== "" && value !== null && value !== undefined && !["title", "content", "rationale"].includes(key));
  return `<div class="memory-card"><h4>${escapeHtml(title)}</h4><p>${escapeHtml(content || "没有正文")}</p><div class="card-meta">${tags.slice(0, 7).map(([key, value]) => `<span>${escapeHtml(key)}=${escapeHtml(value)}</span>`).join("")}</div></div>`;
}

function evidenceCards(items) {
  if (!items?.length) return empty("这条候选没有可展示的直接证据");
  return items.map((item) => `<article class="evidence-card"><div class="evidence-head"><span>${escapeHtml(item.speaker || item.sourceKind || "来源")}</span><span>${escapeHtml(formatTime(item.occurredAt || item.knownAt))}</span></div><blockquote>${escapeHtml(item.content)}</blockquote><div class="card-meta"><span>${escapeHtml(item.endpointCoverage || "direct")}</span><span title="${escapeHtml(item.id)}">${escapeHtml(shortId(item.id))}</span>${item.selected ? "<span class=\"badge accepted\">选中证据</span>" : ""}</div></article>`).join("");
}

function membersSection(items) {
  if (!items?.length) return "";
  return `<section class="detail-section"><div class="section-title"><h3>组成记忆</h3><span class="badge">${items.length}</span></div>${items.map((item) => `<article class="member-card">${memoryCard(item.memory)}<details class="json-details"><summary>查看该记忆的来源</summary><div>${evidenceCards(item.evidence)}</div></details></article>`).join("")}</section>`;
}

function endpointsSection(endpoints) {
  if (!endpoints) return "";
  return `<section class="detail-section"><div class="section-title"><h3>关系端点</h3></div>${memoryCard(endpoints.from, "起点不存在")}<div class="impact-arrow">影响 / 导致 ↓</div>${memoryCard(endpoints.to, "终点不存在")}</section>`;
}

function maintenanceFailureSection(failure) {
  if (!failure) return "";
  const history = Array.isArray(failure.history) ? failure.history : [];
  return `<section class="detail-section"><div class="section-title"><h3>三次失败记录</h3><span class="badge">${history.length}</span></div>${history.length
    ? history.map((item) => `<article class="evidence-card"><div class="evidence-head"><span>第 ${escapeHtml(item.attempt)} 次</span><span>${escapeHtml(formatTime(item.failedAt))}</span></div><blockquote>${escapeHtml(item.error || "未记录错误")}</blockquote><details class="json-details"><summary>查看失败阶段与参数</summary><pre>${escapeHtml(JSON.stringify(item.details || {}, null, 2))}</pre></details></article>`).join("")
    : empty(failure.lastError || "没有失败历史")}</section>`;
}

function renderDetail(detail) {
  const status = detail.reviewState;
  const pending = detail.permissions?.canAccept || detail.permissions?.canDismiss;
  const humanFallback = ["ingestion", "maintenance-failure"].includes(detail.type);
  $("#review-detail").innerHTML = `<div class="detail-head"><div class="title-line"><div><h2>${escapeHtml(detail.title)}</h2><p>${escapeHtml(TYPE_LABELS[detail.type] || detail.type)} · ${escapeHtml(detail.action || "create")} · ${escapeHtml(formatTime(detail.createdAt))}</p></div><span class="badge ${escapeHtml(status)}">${escapeHtml(STATE_LABELS[status] || status)}</span></div></div><div class="detail-body">
    <section class="detail-section"><div class="section-title"><h3>${humanFallback ? "人工判断" : "准备写入"}</h3>${humanFallback ? "" : `<span class="badge">置信度 ${(Number(detail.confidence || 0) * 100).toFixed(0)}%</span>`}</div>${writePreviewCard(detail.writePreview || {})}</section>
    ${detail.currentState ? `<section class="detail-section"><div class="section-title"><h3>状态变化</h3></div><div class="impact-card">${memoryCard(detail.currentState)}<div class="impact-arrow">${escapeHtml(detail.action || "变更")} ↓</div>${writePreviewCard(detail.writePreview || {})}</div></section>` : ""}
    ${endpointsSection(detail.endpoints)}
    ${membersSection(detail.members)}
    ${maintenanceFailureSection(detail.maintenanceFailure)}
    <section class="detail-section"><div class="section-title"><h3>直接证据</h3><span class="badge">${detail.evidence?.length || 0}</span></div>${evidenceCards(detail.evidence)}</section>
    <details class="json-details"><summary>查看完整审计记录</summary><pre>${escapeHtml(JSON.stringify(detail.proposal, null, 2))}</pre></details>
    ${(pending || detail.permissions?.canRevoke) ? `<div class="decision-box"><textarea id="decision-reason" placeholder="可选：记录本次判断理由"></textarea><div class="decision-actions">${detail.permissions?.canDismiss ? `<button class="button danger proposal-action" data-action="dismiss">${humanFallback ? "保留基础记忆并结束" : "驳回"}</button>` : ""}${detail.permissions?.canAccept ? `<button class="button primary proposal-action" data-action="accept">${humanFallback ? "人工通过并写入" : "接受并写入"}</button>` : ""}${detail.permissions?.canRevoke ? "<button class=\"button danger proposal-action\" data-action=\"revoke\">撤销关系</button>" : ""}</div></div>` : ""}
  </div>`;
}

async function loadDetail(type, id) {
  state.selected = { type, id };
  renderReviews();
  $("#review-detail").innerHTML = empty("正在读取候选证据…");
  try {
    const detail = await api(`/v1/review-console/proposals/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
    if (state.selected?.id !== id || state.selected?.type !== type) return;
    state.selected.detail = detail;
    renderDetail(detail);
  } catch (error) {
    $("#review-detail").innerHTML = `<div class="empty-detail"><h2>无法读取候选</h2><p>${escapeHtml(error.message)}</p></div>`;
    toast(error.message, true);
  }
}

async function loadOverview({ preserveSelection = true } = {}) {
  $("#connection-dot").className = "connection-dot";
  const params = new URLSearchParams({ state: $("#state-filter").value, limit: "100" });
  if ($("#type-filter").value) params.set("type", $("#type-filter").value);
  try {
    state.overview = await api(`/v1/review-console?${params}`);
    $("#connection-dot").className = "connection-dot online";
    $("#agent-id").textContent = state.overview.agentId;
    renderMetrics();
    renderReviews();
    renderPipeline();
    renderStorage();
    if (!preserveSelection) state.selected = null;
    const stillPresent = state.overview.reviews.items.find((item) => (
      item.id === state.selected?.id && item.type === state.selected?.type
    ));
    if (stillPresent) await loadDetail(stillPresent.type, stillPresent.id);
    else if (state.view === "reviews" && state.overview.reviews.items.length) {
      const first = state.overview.reviews.items[0];
      await loadDetail(first.type, first.id);
    } else if (!state.overview.reviews.items.length) {
      state.selected = null;
      $("#review-detail").innerHTML = `<div class="empty-detail"><span class="empty-orbit"></span><h2>当前队列已处理完</h2><p>切换审核状态可以查看过去的判断记录。</p></div>`;
    }
  } catch (error) {
    $("#connection-dot").className = "connection-dot error";
    $("#agent-id").textContent = "连接失败";
    toast(error.message, true);
  }
}

async function resolveSelected(action) {
  const selected = state.selected?.detail;
  if (!selected) return;
  const reason = $("#decision-reason")?.value || "";
  const endpoint = action === "revoke"
    ? `/v1/high-level-proposals/relation/${encodeURIComponent(selected.id)}/revoke`
    : `/v1/high-level-proposals/${encodeURIComponent(selected.type)}/${encodeURIComponent(selected.id)}/resolve`;
  const buttons = $$(".proposal-action");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api(endpoint, {
      method: "POST",
      body: action === "revoke"
        ? { actor: "memory-console", reason }
        : { action, actor: "memory-console", reason },
    });
    const humanFallback = ["ingestion", "maintenance-failure"].includes(selected.type);
    if (result?.resolution?.status === "needs-correction") {
      toast("候选仍不完整，已保留在人工审核队列", true);
      await loadDetail(selected.type, selected.id);
      return;
    }
    toast(action === "accept"
      ? humanFallback ? "人工审核候选已直接写入" : "候选已接受并进入正式记忆"
      : action === "dismiss"
        ? humanFallback ? "已保留基础记忆并结束该升级项" : "候选已驳回"
        : "关系已安全撤销");
    state.selected = null;
    await loadOverview({ preserveSelection: false });
  } catch (error) {
    toast(error.message, true);
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function switchView(view) {
  state.view = view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
  const copy = {
    reviews: ["审核队列", "在候选进入正式长期记忆前，核对内容、证据和状态变化。"],
    pipeline: ["处理状态", "查看卡住的原始事件、输入批次和后台维护任务。"],
    storage: ["备份健康", "确认运行库完整，并验证最近一次可恢复快照。"],
  }[view];
  $("#view-title").textContent = copy[0];
  $("#view-subtitle").textContent = copy[1];
}

$("#review-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-review-id]");
  if (row) loadDetail(row.dataset.reviewType, row.dataset.reviewId);
});
$("#review-detail").addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action) resolveSelected(action);
});
$("#view-pipeline").addEventListener("click", async (event) => {
  const button = event.target.closest(".recover-batch");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api("/v1/input-batches/recover", {
      method: "POST",
      body: { batchId: button.dataset.batchId, force: false },
    });
    toast(`已恢复 ${result.recovered || 0} 个过期批次`);
    await loadOverview();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
});
$("#refresh-button").addEventListener("click", () => loadOverview());
$("#backup-button").addEventListener("click", async () => {
  const button = $("#backup-button");
  button.disabled = true;
  try {
    await api("/v1/database/backups", { method: "POST", body: {} });
    toast("数据库备份已创建并校验");
    await loadOverview();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("#state-filter").addEventListener("change", () => { state.selected = null; loadOverview({ preserveSelection: false }); });
$("#type-filter").addEventListener("change", () => { state.selected = null; loadOverview({ preserveSelection: false }); });
$$(".nav-item").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.view)));
$("#connection-button").addEventListener("click", () => {
  $("#api-key").value = state.apiKey;
  $("#connection-dialog").showModal();
});
$("#connection-form").addEventListener("submit", (event) => {
  if (event.submitter?.id !== "save-connection") return;
  event.preventDefault();
  state.apiKey = $("#api-key").value.trim();
  if (state.apiKey) sessionStorage.setItem("suzu-memory-api-key", state.apiKey);
  else sessionStorage.removeItem("suzu-memory-api-key");
  $("#connection-dialog").close();
  loadOverview();
});

loadOverview({ preserveSelection: false });
