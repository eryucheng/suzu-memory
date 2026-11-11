import { createMemoryService, MemoryService } from "@suzu-memory/service";

function clean(value) {
  return String(value ?? "").trim();
}

function queryString(options = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export class SuzuMemoryHttpClient {
  constructor({ baseUrl = "http://127.0.0.1:37779", apiKey = "", fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("SuzuMemoryHttpClient requires fetch.");
    this.baseUrl = clean(baseUrl).replace(/\/+$/u, "");
    if (!this.baseUrl) throw new Error("SuzuMemoryHttpClient requires baseUrl.");
    this.apiKey = clean(apiKey);
    this.fetchImpl = fetchImpl;
  }

  async request(pathname, { method = "GET", body, signal } = {}) {
    const bodySignal = typeof body?.signal?.throwIfAborted === 'function' ? body.signal : undefined;
    signal ??= bodySignal;
    signal?.throwIfAborted();
    if (bodySignal) {
      const { signal: _signal, ...payload } = body;
      body = payload;
    }
    const headers = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const payload = await response.json().catch(() => null);
    signal?.throwIfAborted();
    if (!response.ok || payload?.status !== "success") {
      const error = new Error(payload?.error?.message || `Suzu Memory HTTP ${response.status}.`);
      error.code = payload?.error?.code || "HTTP_ERROR";
      error.status = response.status;
      throw error;
    }
    return payload.data;
  }

  health() { return this.request("/v1/health"); }
  status() { return this.request("/v1/status"); }
  backupDatabase(options = {}) {
    return this.request("/v1/database/backups", { method: "POST", body: options });
  }
  appendEvents(events) {
    return this.request("/v1/events", { method: "POST", body: { events } });
  }
  appendEvent(event) { return this.appendEvents([event]); }
  reviseEvent(targetEventId, revision = {}) {
    return this.request(`/v1/events/${encodeURIComponent(targetEventId)}/revision`, {
      method: "POST",
      body: revision,
    });
  }
  listInputEvents(options = {}) {
    const { statuses, eventTypes, lifecycles, ...rest } = options;
    return this.request(`/v1/events${queryString({
      ...rest,
      status: statuses ?? rest.status,
      type: eventTypes ?? rest.type,
      lifecycle: lifecycles ?? rest.lifecycle,
    })}`);
  }
  listInputBatches(options = {}) { return this.request(`/v1/input-batches${queryString(options)}`); }
  processPendingEvents(options = {}) {
    return this.request("/v1/input-batches/process", { method: "POST", body: options });
  }
  recoverProcessingEvents(options = {}) {
    return this.request("/v1/input-batches/recover", { method: "POST", body: options });
  }
  maintenanceStatus(options = {}) {
    return this.request(`/v1/maintenance${queryString(options)}`);
  }
  runMaintenance(options = {}) {
    return this.request("/v1/maintenance/run", { method: "POST", body: options });
  }
  listHighLevelProposals(options = {}) {
    const { types, reviewStates, ...rest } = options;
    return this.request(`/v1/high-level-proposals${queryString({
      ...rest,
      type: types ?? rest.type,
      state: reviewStates ?? rest.state,
    })}`);
  }
  reviewConsoleOverview(options = {}) {
    const { types, reviewStates, ...rest } = options;
    return this.request(`/v1/review-console${queryString({
      ...rest,
      type: types ?? rest.type,
      state: reviewStates ?? rest.state,
    })}`);
  }
  getReviewConsoleProposal(type, proposalId) {
    return this.request(`/v1/review-console/proposals/${encodeURIComponent(type)}/${encodeURIComponent(proposalId)}`);
  }
  getHighLevelProposal(type, proposalId) {
    return this.request(`/v1/high-level-proposals/${encodeURIComponent(type)}/${encodeURIComponent(proposalId)}`);
  }
  resolveHighLevelProposal(type, proposalId, resolution) {
    return this.request(`/v1/high-level-proposals/${encodeURIComponent(type)}/${encodeURIComponent(proposalId)}/resolve`, {
      method: "POST",
      body: resolution,
    });
  }
  revokeHighLevelRelation(proposalId, options = {}) {
    return this.request(`/v1/high-level-proposals/relation/${encodeURIComponent(proposalId)}/revoke`, {
      method: "POST",
      body: options,
    });
  }
  listMemories({ statuses, kinds, ...options } = {}) {
    return this.request(`/v1/memories${queryString({ ...options, status: statuses ?? options.status, kind: kinds ?? options.kind })}`);
  }
  getMemory(memoryId) { return this.request(`/v1/memories/${encodeURIComponent(memoryId)}`); }
  search(query, options = {}) { return this.request("/v1/search", { method: "POST", body: { query, ...options } }); }
  editMemory(memoryId, patch, options = {}) {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      body: { patch, ...options },
    });
  }
  deleteMemory(memoryId, options = {}) {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}`, {
      method: "DELETE",
      body: options,
    });
  }
  restoreMemory(memoryId, options = {}) {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}/restore`, {
      method: "POST",
      body: options,
    });
  }
  listRetrievalTraces({ resultStatus, ...options } = {}) {
    return this.request(`/v1/retrieval-traces${queryString({ ...options, status: resultStatus ?? options.status })}`);
  }
  recordRetrievalFeedback(traceIdOrOptions, feedback = {}) {
    const options = traceIdOrOptions && typeof traceIdOrOptions === "object"
      ? traceIdOrOptions
      : { traceId: traceIdOrOptions, ...feedback };
    const traceId = clean(options.traceId);
    if (!traceId) throw new Error("recordRetrievalFeedback requires traceId.");
    const { traceId: _traceId, ...body } = options;
    return this.request(`/v1/retrieval-traces/${encodeURIComponent(traceId)}/feedback`, {
      method: "POST",
      body,
    });
  }
  setRetrievalSessionHead({ sessionId, ...body } = {}) {
    const id = clean(sessionId);
    if (!id) throw new Error("setRetrievalSessionHead requires sessionId.");
    return this.request(`/v1/runtime-sessions/${encodeURIComponent(id)}/retrieval-head`, {
      method: "POST",
      body,
    });
  }
  bindRetrievalUsageResponse({ sessionId, ...body } = {}) {
    const id = clean(sessionId);
    if (!id) throw new Error("bindRetrievalUsageResponse requires sessionId.");
    return this.request(`/v1/runtime-sessions/${encodeURIComponent(id)}/response`, {
      method: "POST",
      body,
    });
  }
  bindRewardObservation({ sessionId, ...body } = {}) {
    const id = clean(sessionId);
    if (!id) throw new Error("bindRewardObservation requires sessionId.");
    return this.request(`/v1/runtime-sessions/${encodeURIComponent(id)}/follow-up`, {
      method: "POST",
      body,
    });
  }
  brainSnapshot() { return this.request("/v1/brain"); }
}

export function createEmbeddedMemoryClient(options = {}) {
  return createMemoryService(options);
}

export function createHttpMemoryClient(options = {}) {
  return new SuzuMemoryHttpClient(options);
}

export {
  createMemoryService,
  MemoryService,
};
