import http from "node:http";

import { getMemoryConsoleAsset } from "@suzu-memory/console";
import { createMemoryService } from "@suzu-memory/service";

const MINIMUM_BODY_BYTES = 1024;
const DEFAULT_BODY_BYTES = 1024 * 1024;
const MAXIMUM_BODY_BYTES = 64 * 1024 * 1024;
const PUBLIC_FAILURES = Object.freeze({
  BODY_TOO_LARGE: Object.freeze({
    statusCode: 413,
    message: "Request body exceeds the configured limit.",
  }),
  INVALID_JSON: Object.freeze({
    statusCode: 400,
    message: "Request body must be a JSON object.",
  }),
  INPUT_EVENT_CONFLICT: Object.freeze({
    statusCode: 409,
    message: "The input event conflicts with an existing event.",
  }),
  INPUT_EVENT_REVISION_RACE: Object.freeze({
    statusCode: 409,
    message: "The input event is currently being processed and cannot be revised.",
  }),
  INPUT_BATCH_LEASE_LOST: Object.freeze({
    statusCode: 409,
    message: "The input batch lease changed before processing completed.",
  }),
  BACKUP_EXISTS: Object.freeze({
    statusCode: 409,
    message: "A backup already exists at the requested destination.",
  }),
  BACKUP_NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "The requested backup was not found.",
  }),
  DATABASE_NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "The requested database was not found.",
  }),
  MEMORY_NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "The requested memory was not found.",
  }),
  PROPOSAL_NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "The requested proposal was not found.",
  }),
  BACKUP_MANIFEST_INVALID: Object.freeze({
    statusCode: 422,
    message: "The backup manifest is invalid.",
  }),
  BACKUP_HASH_MISMATCH: Object.freeze({
    statusCode: 422,
    message: "The backup does not match its manifest.",
  }),
  BACKUP_INTEGRITY_FAILED: Object.freeze({
    statusCode: 422,
    message: "The backup failed integrity validation.",
  }),
  BACKUP_AGENT_MISMATCH: Object.freeze({
    statusCode: 422,
    message: "The backup belongs to another Agent scope.",
  }),
  RESTORE_CONFIRMATION_REQUIRED: Object.freeze({
    statusCode: 422,
    message: "The restore requires explicit Agent confirmation.",
  }),
  INPUT_EVENT_FRAGMENT_GROUP_INCOMPLETE: Object.freeze({
    statusCode: 422,
    message: "The input event fragment group is incomplete.",
  }),
  INPUT_EVENT_FRAGMENT_GROUP_TOO_LARGE: Object.freeze({
    statusCode: 422,
    message: "The input event fragment group exceeds the configured processing budget.",
  }),
  INPUT_EVENT_TOO_LARGE: Object.freeze({
    statusCode: 422,
    message: "The input event exceeds the configured processing budget.",
  }),
  MEMORY_PROVIDER_TRANSPORT_EXHAUSTED: Object.freeze({
    statusCode: 503,
    message: "A configured memory provider is temporarily unavailable.",
  }),
  UPSTREAM_TIMEOUT: Object.freeze({
    statusCode: 503,
    message: "A configured memory provider timed out.",
  }),
  MEMORY_GENERATION_INVALID_OUTPUT: Object.freeze({
    statusCode: 502,
    message: "A configured memory provider returned an invalid response.",
  }),
});

function clean(value) {
  return String(value ?? "").trim();
}

function jsonResponse(response, statusCode, payload) {
  const text = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function success(response, data, statusCode = 200) {
  jsonResponse(response, statusCode, { status: "success", data });
}

function failure(response, statusCode, code, message) {
  jsonResponse(response, statusCode, {
    status: "error",
    error: { code, message },
  });
}

function normalizeBodyLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_BODY_BYTES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MINIMUM_BODY_BYTES || parsed > MAXIMUM_BODY_BYTES) {
    throw new Error(
      `maxBodyBytes must be an integer between ${MINIMUM_BODY_BYTES} and ${MAXIMUM_BODY_BYTES}.`,
    );
  }
  return parsed;
}

function publicFailure(error) {
  const code = clean(error?.code);
  const mapped = PUBLIC_FAILURES[code];
  if (mapped) return { code, ...mapped };
  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "The server could not complete the request.",
  };
}

function assetResponse(response, asset) {
  response.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": asset.content.length,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(asset.content);
}

async function readJson(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error(`Request body exceeds ${maximumBytes} bytes.`);
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON body must be an object.");
    }
    return value;
  } catch (error) {
    if (error.code === "BODY_TOO_LARGE") throw error;
    const invalid = new Error(`Invalid JSON body: ${error.message}`);
    invalid.code = "INVALID_JSON";
    throw invalid;
  }
}

function authorized(request, apiKey) {
  if (!apiKey) return true;
  const bearer = clean(request.headers.authorization).replace(/^Bearer\s+/iu, "");
  const direct = clean(request.headers["x-suzu-memory-key"]);
  return bearer === apiKey || direct === apiKey;
}

function list(value) {
  return clean(value).split(",").map(clean).filter(Boolean);
}

function integer(value, fallback, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(0, Math.trunc(parsed)));
}

function memoryIdFrom(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/v1/memories/([^/]+)/${suffix}$`, "u")
    : /^\/v1\/memories\/([^/]+)$/u;
  const match = pathname.match(pattern);
  return match ? decodeURIComponent(match[1]) : "";
}

function traceIdFrom(pathname) {
  const match = pathname.match(/^\/v1\/retrieval-traces\/([^/]+)\/feedback$/u);
  return match ? decodeURIComponent(match[1]) : "";
}

function runtimeSessionPath(pathname) {
  const match = pathname.match(
    /^\/v1\/runtime-sessions\/([^/]+)\/(retrieval-head|response|follow-up)$/u,
  );
  return match ? {
    sessionId: decodeURIComponent(match[1]),
    action: match[2],
  } : null;
}

function highLevelProposalPath(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/v1/high-level-proposals/([^/]+)/([^/]+)/${suffix}$`, "u")
    : /^\/v1\/high-level-proposals\/([^/]+)\/([^/]+)$/u;
  const match = pathname.match(pattern);
  return match ? {
    type: decodeURIComponent(match[1]),
    id: decodeURIComponent(match[2]),
  } : null;
}

function reviewConsoleProposalPath(pathname) {
  const match = pathname.match(/^\/v1\/review-console\/proposals\/([^/]+)\/([^/]+)$/u);
  return match ? {
    type: decodeURIComponent(match[1]),
    id: decodeURIComponent(match[2]),
  } : null;
}

function isLoopback(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(clean(host).toLowerCase());
}

export function createMemoryHttpServer({
  service = null,
  serviceOptions = {},
  apiKey = "",
  maxBodyBytes = 1024 * 1024,
} = {}) {
  const memory = service || createMemoryService(serviceOptions);
  const key = clean(apiKey);
  const bodyLimit = normalizeBodyLimit(maxBodyBytes);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    const method = clean(request.method).toUpperCase();
    try {
      const consoleAsset = method === "GET" ? getMemoryConsoleAsset(url.pathname) : null;
      if (consoleAsset) {
        assetResponse(response, consoleAsset);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/health") {
        success(response, {
          service: "suzu-memory",
          version: "v1",
          agentId: memory.agentId,
        });
        return;
      }
      if (!authorized(request, key)) {
        failure(response, 401, "UNAUTHORIZED", "A valid Suzu Memory API key is required.");
        return;
      }
      if (method === "GET" && url.pathname === "/v1/status") {
        success(response, memory.info());
        return;
      }
      if (method === "POST" && url.pathname === "/v1/database/backups") {
        const body = await readJson(request, bodyLimit);
        success(response, memory.backupDatabase({ now: body.now }), 201);
        return;
      }
      if (method === "POST" && url.pathname === "/v1/events") {
        const body = await readJson(request, bodyLimit);
        const events = body.events ?? body.event;
        success(response, memory.appendEvents(events), 201);
        return;
      }
      const eventRevisionMatch = url.pathname.match(/^\/v1\/events\/([^/]+)\/revision$/u);
      if (method === "POST" && eventRevisionMatch) {
        const body = await readJson(request, bodyLimit);
        success(response, memory.reviseEvent(
          decodeURIComponent(eventRevisionMatch[1]),
          {
            action: body.action,
            replacementEvent: body.replacementEvent ?? null,
            revisionId: body.revisionId,
            reason: body.reason,
            metadata: body.metadata,
            now: body.now,
          },
        ), 201);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/events") {
        success(response, memory.listInputEvents({
          statuses: url.searchParams.has("status")
            ? list(url.searchParams.get("status"))
            : ["pending"],
          eventTypes: list(url.searchParams.get("type")),
          lifecycles: url.searchParams.has("lifecycle")
            ? list(url.searchParams.get("lifecycle"))
            : ["active"],
          hostId: clean(url.searchParams.get("hostId")),
          sessionId: clean(url.searchParams.get("sessionId")),
          limit: integer(url.searchParams.get("limit"), 100, 500),
          offset: integer(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER),
        }));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/input-batches") {
        success(response, memory.listInputBatches({
          limit: integer(url.searchParams.get("limit"), 100, 500),
          offset: integer(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER),
        }));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/input-batches/process") {
        const body = await readJson(request, bodyLimit);
        success(response, await memory.processPendingEvents({
          maximumEvents: integer(body.maximumEvents, 100, 500),
          maximumContentCharacters: integer(
            body.maximumContentCharacters,
            undefined,
            10_000_000,
          ),
          ...(Array.isArray(body.candidateEventIds)
            ? { candidateEventIds: body.candidateEventIds }
            : {}),
          leaseSeconds: integer(body.leaseSeconds, undefined, 86_400),
          ...(Array.isArray(body.previousContextEvents)
            ? { previousContextEvents: body.previousContextEvents }
            : {}),
          ...(Array.isArray(body.continuationGuidanceEvents)
            ? { continuationGuidanceEvents: body.continuationGuidanceEvents }
            : {}),
          ...(Array.isArray(body.archiveWindows)
            ? { archiveWindows: body.archiveWindows }
            : {}),
          now: body.now,
        }));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/input-batches/recover") {
        const body = await readJson(request, bodyLimit);
        success(response, memory.recoverProcessingEvents({
          batchId: clean(body.batchId),
          force: body.force === true,
          now: body.now,
        }));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/maintenance") {
        success(response, memory.maintenanceStatus({
          limit: integer(url.searchParams.get("limit"), 100, 500),
        }));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/maintenance/run") {
        const body = await readJson(request, bodyLimit);
        success(response, await memory.runMaintenance({
          lane: clean(body.lane) || "all",
          processInputEvents: body.processInputEvents !== false,
          maximumInputBatches: integer(body.maximumInputBatches, 1, 20),
          maximumEvents: integer(body.maximumEvents, 100, 500),
          maximumContentCharacters: integer(
            body.maximumContentCharacters,
            undefined,
            10_000_000,
          ),
          leaseSeconds: integer(body.leaseSeconds, undefined, 86_400),
          maximumTasks: integer(body.maximumTasks, 10, 100),
          maximumStateRequests: integer(body.maximumStateRequests, 10, 500),
          maximumConsolidationRuns: integer(body.maximumConsolidationRuns, 3, 100),
          batchSize: integer(body.batchSize, 10, 10),
          now: body.now,
        }));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/high-level-proposals") {
        success(response, memory.listHighLevelProposals({
          types: url.searchParams.has("type")
            ? list(url.searchParams.get("type"))
            : undefined,
          reviewStates: url.searchParams.has("state")
            ? list(url.searchParams.get("state"))
            : ["pending"],
          limit: integer(url.searchParams.get("limit"), 100, 500),
        }));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/review-console") {
        success(response, memory.reviewConsoleOverview({
          types: url.searchParams.has("type")
            ? list(url.searchParams.get("type"))
            : undefined,
          reviewStates: url.searchParams.has("state")
            ? list(url.searchParams.get("state"))
            : ["pending"],
          limit: integer(url.searchParams.get("limit"), 100, 500),
          now: url.searchParams.get("now") || undefined,
        }));
        return;
      }
      const reviewConsoleProposal = reviewConsoleProposalPath(url.pathname);
      if (method === "GET" && reviewConsoleProposal) {
        const data = memory.getReviewConsoleProposal(
          reviewConsoleProposal.type,
          reviewConsoleProposal.id,
        );
        if (!data) failure(response, 404, "PROPOSAL_NOT_FOUND", "Review proposal was not found.");
        else success(response, data);
        return;
      }
      const highLevelResolution = highLevelProposalPath(url.pathname, "resolve");
      if (method === "POST" && highLevelResolution) {
        const body = await readJson(request, bodyLimit);
        success(response, memory.resolveHighLevelProposal(
          highLevelResolution.type,
          highLevelResolution.id,
          {
            action: body.action,
            actor: body.actor,
            reason: body.reason,
          },
        ));
        return;
      }
      const highLevelRevocation = highLevelProposalPath(url.pathname, "revoke");
      if (method === "POST" && highLevelRevocation) {
        if (highLevelRevocation.type !== "relation") {
          failure(response, 400, "UNSUPPORTED_REVOCATION", "Only accepted relation proposals can be revoked safely.");
          return;
        }
        const body = await readJson(request, bodyLimit);
        success(response, memory.revokeHighLevelRelation(highLevelRevocation.id, {
          actor: body.actor,
          reason: body.reason,
        }));
        return;
      }
      const highLevelProposal = highLevelProposalPath(url.pathname);
      if (method === "GET" && highLevelProposal) {
        const data = memory.getHighLevelProposal(highLevelProposal.type, highLevelProposal.id);
        if (!data) failure(response, 404, "PROPOSAL_NOT_FOUND", "High-level proposal was not found.");
        else success(response, data);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/memories") {
        const statuses = url.searchParams.has("status") ? list(url.searchParams.get("status")) : ["active"];
        success(response, memory.listMemories({
          query: clean(url.searchParams.get("query")),
          statuses,
          kinds: list(url.searchParams.get("kind")),
          limit: integer(url.searchParams.get("limit"), 50, 200),
          offset: integer(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER),
        }));
        return;
      }
      const restoreId = memoryIdFrom(url.pathname, "restore");
      if (method === "POST" && restoreId) {
        const body = await readJson(request, bodyLimit);
        success(response, memory.restoreMemory(restoreId, {
          actor: body.actor,
          reason: body.reason,
        }));
        return;
      }
      const memoryId = memoryIdFrom(url.pathname);
      if (memoryId && method === "GET") {
        const data = memory.getMemory(memoryId);
        if (!data) failure(response, 404, "MEMORY_NOT_FOUND", "Memory was not found.");
        else success(response, data);
        return;
      }
      if (memoryId && method === "PATCH") {
        const body = await readJson(request, bodyLimit);
        success(response, memory.editMemory(memoryId, body.patch, {
          actor: body.actor,
          reason: body.reason,
        }));
        return;
      }
      if (memoryId && method === "DELETE") {
        const body = await readJson(request, bodyLimit);
        success(response, memory.deleteMemory(memoryId, {
          actor: body.actor,
          reason: body.reason,
        }));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/search") {
        const body = await readJson(request, bodyLimit);
        success(response, await memory.search(body.query, {
          now: body.now,
          anchors: body.anchors,
          anchorSelection: body.anchorSelection,
          queryPerspective: body.queryPerspective,
          world: body.world,
          allowCrossWorld: body.allowCrossWorld,
          options: body.options,
          persistTrace: body.persistTrace !== false,
        }));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/retrieval-traces") {
        success(response, memory.listRetrievalTraces({
          resultStatus: clean(url.searchParams.get("status")),
          limit: integer(url.searchParams.get("limit"), 100, 500),
          offset: integer(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER),
        }));
        return;
      }
      const runtimeSession = runtimeSessionPath(url.pathname);
      if (method === "POST" && runtimeSession) {
        const body = await readJson(request, bodyLimit);
        const data = runtimeSession.action === "retrieval-head"
          ? memory.setRetrievalSessionHead({
            sessionId: runtimeSession.sessionId,
            traceId: body.traceId,
            now: body.now,
          })
          : runtimeSession.action === "response"
            ? memory.bindRetrievalUsageResponse({
              sessionId: runtimeSession.sessionId,
              responseText: body.responseText,
              metadata: body.metadata,
              now: body.now,
            })
            : memory.bindRewardObservation({
              sessionId: runtimeSession.sessionId,
              feedbackText: body.feedbackText,
              metadata: body.metadata,
              now: body.now,
            });
        success(response, data);
        return;
      }
      const traceId = traceIdFrom(url.pathname);
      if (method === "POST" && traceId) {
        const body = await readJson(request, bodyLimit);
        success(response, memory.recordRetrievalFeedback({
          traceId,
          signal: body.signal,
          targetMemoryIds: body.targetMemoryIds,
          note: body.note,
          metadata: body.metadata,
        }), 201);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/brain") {
        success(response, memory.brainSnapshot());
        return;
      }
      failure(response, 404, "NOT_FOUND", "Endpoint was not found.");
    } catch (error) {
      const mapped = publicFailure(error);
      failure(response, mapped.statusCode, mapped.code, mapped.message);
    }
  });

  return {
    service: memory,
    server,
    async listen({ host = "127.0.0.1", port = 37779 } = {}) {
      const normalizedHost = clean(host) || "127.0.0.1";
      const normalizedPort = Math.max(0, Math.min(65535, Math.trunc(Number(port) || 0)));
      if (!isLoopback(normalizedHost) && !key) {
        throw new Error("Binding Suzu Memory beyond loopback requires an API key.");
      }
      memory.initialize();
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(normalizedPort, normalizedHost);
      });
      const address = server.address();
      return {
        host: typeof address === "object" && address ? address.address : normalizedHost,
        port: typeof address === "object" && address ? address.port : normalizedPort,
        baseUrl: `http://${normalizedHost}:${typeof address === "object" && address ? address.port : normalizedPort}`,
      };
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
