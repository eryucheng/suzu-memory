import fs from "node:fs";
import path from "node:path";

import { processPendingStateAnalysisRequests } from "@suzu-memory/analysis";
import {
  databaseInfo,
  ensureCompanionRelationshipStructure,
  MemoryRepository,
  openMemoryDatabase,
  resolveMemoryIngestionReview,
  resolveMemoryRelationProposal,
  resolveMemoryStructureProposal,
  resolveReportedStateProposal,
  revokeMemoryRelationProposal,
} from "@suzu-memory/core";
import { syncMemoryEmbeddings } from "@suzu-memory/embedding-indexer";
import {
  appendCompanionEvents,
  processPendingCompanionEvents,
  reviseCompanionEvent,
} from "@suzu-memory/ingestion";
import {
  inspectMaintenance,
  MAINTENANCE_TASK_TYPES,
  runEmbeddingMaintenance,
  runImmediateMemoryMaintenance,
  runSemanticMemoryMaintenance,
} from "@suzu-memory/maintenance";
import {
  normalizeRecallReactivationOptions,
  retrieveMemories,
} from "@suzu-memory/retriever";
import {
  resolveAgentDataRoot,
  resolveMemoryDataRoot,
  stableAgentId,
} from "@suzu-memory/runtime";
import { processPlannedConsolidationRuns } from "@suzu-memory/structurer";
import { createBrainSnapshot } from "@suzu-memory/visualization";
import {
  createDatabaseBackup,
  inspectDatabaseBackup,
  restoreDatabaseBackup,
} from "./database-backup.mjs";
import {
  buildReviewProposalDetail,
  consolidationFailureReviewEnvelope,
  inspectReviewConsoleStorage,
  reviewProposalSummary,
} from "./review-console.mjs";

const PRODUCT_NATURAL_DECAY = Object.freeze({
  enabled: true,
  configurationVersion: "companion-natural-decay-v2",
  floor: 0.25,
  scaleDays: 30,
  decayExponent: 0.5,
  maximumScoreReduction: 0.12,
});

const PRODUCT_RECALL_REACTIVATION = Object.freeze({
  enabled: true,
  configurationVersion: "companion-recall-reactivation-v2",
  activationGain: 0.025,
  maximumActivation: 0.35,
  scaleDays: 10,
  decayExponent: 0.5,
  maximumScoreAdjustment: 0.03,
});

function productRetrievalOptions(value) {
  const retrieval = value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
  if (!Object.hasOwn(retrieval, "naturalDecay")) {
    retrieval.naturalDecay = PRODUCT_NATURAL_DECAY;
  }
  if (!Object.hasOwn(retrieval, "recallReactivation")) {
    retrieval.recallReactivation = PRODUCT_RECALL_REACTIVATION;
  }
  return retrieval;
}

function clean(value) {
  return String(value ?? "").trim();
}

function maintenanceFailure(stage, error) {
  return {
    status: "failed",
    stage,
    error: {
      code: clean(error?.code) || "MAINTENANCE_FAILURE",
      name: clean(error?.name) || "Error",
      message: clean(error?.message) || "Unknown maintenance failure.",
    },
  };
}

const HIGH_LEVEL_PROPOSAL_TYPES = Object.freeze([
  "ingestion",
  "reported-state",
  "structure",
  "relation",
  "maintenance-failure",
]);

function highLevelProposalType(value) {
  const normalized = clean(value).toLowerCase().replaceAll("_", "-");
  if (!HIGH_LEVEL_PROPOSAL_TYPES.includes(normalized)) {
    throw new Error(`Unknown high-level proposal type: ${normalized || "(empty)"}.`);
  }
  return normalized;
}

function highLevelProposalEnvelope(type, proposal) {
  if (!proposal) return null;
  return {
    type,
    id: proposal.id,
    reviewState: proposal.review_state,
    createdAt: proposal.created_at,
    updatedAt: proposal.updated_at,
    proposal,
  };
}

function existingIngestionCandidate(repository, agentId, decision) {
  const candidate = decision?.candidate && typeof decision.candidate === "object"
    ? decision.candidate
    : {};
  const provisional = clean(decision?.provisional_memory_id)
    ? repository.getMemory(decision.provisional_memory_id)
    : null;
  const request = repository.listStateAnalysisRequests(agentId, {
    batchId: decision?.batch_id,
    limit: 500,
  }).find((item) => Number(item.candidate_index) === Number(decision?.candidate_index)) || null;
  const subjectRole = clean(candidate.subjectRole || request?.subject_role || provisional?.subject_role);
  const subjectKey = clean(candidate.subjectKey || request?.subject_key || provisional?.subject_key);
  const actorRoles = (Array.isArray(candidate.actorRoles) ? candidate.actorRoles : []).map((actor) => {
    const actorRole = clean(actor?.actorRole);
    return {
      ...actor,
      actorKey: clean(actor?.actorKey)
        || (actorRole === subjectRole ? subjectKey : actorRole === "agent" ? agentId : ""),
    };
  });
  return {
    ...candidate,
    subjectRole,
    subjectKey,
    representationLayer: clean(
      candidate.representationLayer
      || request?.representation_layer
      || provisional?.representation_layer,
    ) || undefined,
    actorRoles,
  };
}

function proposalReviewStates(value) {
  const states = [...new Set(
    (Array.isArray(value) ? value : [value]).map(clean).filter(Boolean),
  )];
  const normalized = states.length ? states : ["pending"];
  if (normalized.some((state) => !["pending", "accepted", "dismissed", "revoked"].includes(state))) {
    throw new Error("Unknown high-level proposal review state.");
  }
  return normalized;
}

function validDate(value, label) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid date.`);
    return value;
  }
  if (!clean(value)) return new Date();
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error(`${label} must be a valid date.`);
  return result;
}

export function resolveMemoryServicePaths({
  dataRoot = "",
  projectRoot = "",
  agentId = "",
  databasePath = "",
  usageLedgerPath = "",
} = {}) {
  const resolvedDataRoot = resolveMemoryDataRoot({ configuredRoot: dataRoot });
  const resolvedAgentId = clean(agentId) || stableAgentId(projectRoot);
  if (!resolvedAgentId) {
    throw new Error("Suzu Memory requires agentId or projectRoot.");
  }
  const agentRoot = resolveAgentDataRoot({
    dataRoot: resolvedDataRoot,
    agentId: resolvedAgentId,
  });
  const memoryRoot = path.join(agentRoot, "memory");
  return Object.freeze({
    dataRoot: resolvedDataRoot,
    agentId: resolvedAgentId,
    agentRoot,
    memoryRoot,
    databasePath: clean(databasePath)
      ? path.resolve(databasePath)
      : path.join(memoryRoot, "memory.db"),
    usageLedgerPath: clean(usageLedgerPath)
      ? path.resolve(usageLedgerPath)
      : path.join(agentRoot, "usage", "events.jsonl"),
    visualizationCachePath: path.join(memoryRoot, "visualization", "brain-layout.json"),
    backupDirectory: path.join(memoryRoot, "backups"),
  });
}

function closeDatabase(database) {
  try {
    database.close();
  } catch {
    // The operation result is more important than a redundant close failure.
  }
}

export class MemoryService {
  constructor({
    dataRoot = "",
    projectRoot = "",
    agentId = "",
    databasePath = "",
    usageLedgerPath = "",
    providers = {},
    defaults = {},
  } = {}) {
    this.paths = resolveMemoryServicePaths({
      dataRoot,
      projectRoot,
      agentId,
      databasePath,
      usageLedgerPath,
    });
    this.initialized = false;
    this.providers = Object.freeze({
      generator: providers.generator || null,
      structureGenerator: providers.structureGenerator || providers.generator || null,
      retrievalContextGenerator: providers.retrievalContextGenerator || providers.generator || null,
      embedding: providers.embedding || null,
    });
    const maximumBatchCharacters = Math.max(
      1,
      Math.trunc(Number(defaults.ingestion?.maximumBatchCharacters) || 48_000),
    );
    const maximumEventCharacters = Math.max(
      1,
      Math.trunc(Number(defaults.ingestion?.maximumEventCharacters) || 12_000),
    );
    if (maximumEventCharacters > maximumBatchCharacters) {
      throw new Error("maximumEventCharacters cannot exceed maximumBatchCharacters.");
    }
    this.defaults = Object.freeze({
      memoryOwner: clean(defaults.memoryOwner) || "记忆拥有者",
      userName: clean(defaults.userName) || "对方",
      primaryUserId: clean(defaults.primaryUserId) || "user",
      companionId: clean(defaults.companionId) || this.paths.agentId,
      relationshipLabel: clean(defaults.relationshipLabel) || "关系",
      defaultWorldId: clean(defaults.defaultWorldId) || "relationship",
      defaultWorldFrame: clean(defaults.defaultWorldFrame) || "relational",
      ingestion: Object.freeze({
        maximumEventCharacters,
        maximumBatchCharacters,
        leaseSeconds: Math.min(
          86_400,
          Math.max(60, Math.trunc(Number(defaults.ingestion?.leaseSeconds) || 1800)),
        ),
      }),
      retrieval: productRetrievalOptions(defaults.retrieval),
    });
  }

  get agentId() {
    return this.paths.agentId;
  }

  initialize() {
    fs.mkdirSync(this.paths.memoryRoot, { recursive: true });
    const database = openMemoryDatabase(this.paths.databasePath);
    try {
      const repository = new MemoryRepository(database);
      const identityStructure = ensureCompanionRelationshipStructure({
        repository,
        agentId: this.agentId,
        primaryUserId: this.defaults.primaryUserId,
        primaryUserName: this.defaults.userName,
        companionId: this.defaults.companionId,
        companionName: this.defaults.memoryOwner,
        relationshipLabel: this.defaults.relationshipLabel,
        worldId: this.defaults.defaultWorldId,
        worldFrame: this.defaults.defaultWorldFrame,
      });
      const memories = repository.listMemories(this.agentId, {
        statuses: [],
        limit: 1,
      });
      const result = {
        status: "ready",
        agentId: this.agentId,
        dataRoot: this.paths.dataRoot,
        databasePath: this.paths.databasePath,
        usageLedgerPath: this.paths.usageLedgerPath,
        memoryCount: memories.total,
        identityStructure: {
          userEntityId: identityStructure.user.id,
          companionEntityId: identityStructure.companion.id,
          relationshipId: identityStructure.relationship.id,
          relationshipLabel: identityStructure.relationship.label,
        },
        database: databaseInfo(database),
      };
      this.initialized = true;
      return result;
    } finally {
      closeDatabase(database);
    }
  }

  ensureInitialized() {
    if (!this.initialized) this.initialize();
  }

  withRepository(callback, { readOnly = false } = {}) {
    if (typeof callback !== "function") throw new Error("withRepository requires a callback.");
    this.ensureInitialized();
    const database = openMemoryDatabase(this.paths.databasePath, { readOnly });
    try {
      const result = callback(new MemoryRepository(database), database);
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).finally(() => closeDatabase(database));
      }
      closeDatabase(database);
      return result;
    } catch (error) {
      closeDatabase(database);
      throw error;
    }
  }

  info() {
    return this.initialize();
  }

  backupDatabase({ destinationPath = "", overwrite = false, now = new Date() } = {}) {
    this.ensureInitialized();
    const timestamp = validDate(now, "database backup now");
    const selectedPath = clean(destinationPath)
      ? path.resolve(destinationPath)
      : path.join(
        this.paths.backupDirectory,
        `memory-${timestamp.toISOString().replaceAll(":", "-").replaceAll(".", "-")}.db`,
      );
    return createDatabaseBackup({
      databasePath: this.paths.databasePath,
      destinationPath: selectedPath,
      agentId: this.agentId,
      overwrite,
      now: timestamp,
    });
  }

  inspectDatabaseBackup(sourcePath) {
    return inspectDatabaseBackup(sourcePath);
  }

  restoreDatabaseBackup(sourcePath, {
    confirmAgentId = "",
    now = new Date(),
  } = {}) {
    if (clean(confirmAgentId) !== this.agentId) {
      const error = new Error(`Database restore requires confirmAgentId=${this.agentId}.`);
      error.code = "RESTORE_CONFIRMATION_REQUIRED";
      throw error;
    }
    const result = restoreDatabaseBackup({
      databasePath: this.paths.databasePath,
      sourcePath,
      agentId: this.agentId,
      backupDirectory: this.paths.backupDirectory,
      now: validDate(now, "database restore now"),
    });
    this.initialized = false;
    return {
      ...result,
      service: this.initialize(),
    };
  }

  companionIdentity() {
    return Object.freeze({
      spaceId: this.agentId,
      primaryUserId: this.defaults.primaryUserId,
      primaryUserName: this.defaults.userName,
      companionId: this.defaults.companionId,
      companionName: this.defaults.memoryOwner,
      relationshipLabel: this.defaults.relationshipLabel,
      defaultWorldId: this.defaults.defaultWorldId,
      defaultWorldFrame: this.defaults.defaultWorldFrame,
    });
  }

  appendEvents(events) {
    return this.withRepository((repository) => appendCompanionEvents({
      repository,
      agentId: this.agentId,
      identity: this.companionIdentity(),
      events,
      maximumEventCharacters: this.defaults.ingestion.maximumEventCharacters,
    }));
  }

  appendEvent(event) {
    return this.appendEvents([event]);
  }

  reviseEvent(targetEventId, {
    action,
    replacementEvent = null,
    revisionId = "",
    reason = "",
    metadata = {},
    now = new Date(),
  } = {}) {
    return this.withRepository((repository) => reviseCompanionEvent({
      repository,
      agentId: this.agentId,
      targetEventId,
      action,
      replacementEvent,
      revisionId,
      reason,
      metadata,
      identity: this.companionIdentity(),
      maximumEventCharacters: this.defaults.ingestion.maximumEventCharacters,
      createdAt: validDate(now, "event revision now"),
    }));
  }

  listInputEvents(options = {}) {
    return this.withRepository(
      (repository) => repository.listInputEvents(this.agentId, options),
      { readOnly: true },
    );
  }

  listInputBatches(options = {}) {
    return this.withRepository(
      (repository) => repository.listInputBatches(this.agentId, options),
      { readOnly: true },
    );
  }

  recoverProcessingEvents({
    batchId = "",
    force = false,
    now = new Date(),
  } = {}) {
    return this.withRepository((repository) => repository.recoverProcessingInputBatches(
      this.agentId,
      {
        batchId,
        force: Boolean(force),
        recoveredAt: validDate(now, "event recovery now").toISOString(),
        errorMessage: force
          ? "Input batch was explicitly recovered before completion."
          : "Input batch lease expired before completion.",
      },
    ));
  }

  processPendingEvents({
    maximumEvents = 100,
    maximumContentCharacters = this.defaults.ingestion.maximumBatchCharacters,
    candidateEventIds = [],
    leaseSeconds = this.defaults.ingestion.leaseSeconds,
    generator = this.providers.generator,
    previousContextEvents = [],
    continuationGuidanceEvents = [],
    archiveWindows = [],
    systemPrompt = "",
    now = new Date(),
    memoriesOverride = null,
  } = {}) {
    return this.withRepository((repository) => processPendingCompanionEvents({
      repository,
      agentId: this.agentId,
      identity: this.companionIdentity(),
      maximumEvents,
      maximumContentCharacters,
      candidateEventIds,
      leaseSeconds,
      generator,
      previousContextEvents,
      continuationGuidanceEvents,
      archiveWindows,
      usageLedgerPath: this.paths.usageLedgerPath,
      systemPrompt,
      now: validDate(now, "event processing now"),
      memoriesOverride,
    }));
  }

  maintenanceStatus({ limit = 100 } = {}) {
    return this.withRepository((repository) => {
      const maintenance = inspectMaintenance({
        repository,
        agentId: this.agentId,
        limit,
      });
      return {
        ...maintenance,
        pendingInputEvents: repository.listInputEvents(this.agentId, {
          statuses: ["pending"],
          limit: 1,
        }).total,
      };
    }, { readOnly: true });
  }

  runEmbeddingMaintenance({
    maximumTasks = 10,
    batchSize = 10,
    embeddingProvider = this.providers.embedding,
  } = {}) {
    return this.withRepository((repository) => runEmbeddingMaintenance({
      repository,
      agentId: this.agentId,
      embeddingProvider,
      usageLedgerPath: this.paths.usageLedgerPath,
      maximumTasks,
      batchSize,
    }));
  }

  async runSemanticMaintenance({
    processInputEvents = true,
    maximumInputBatches = 1,
    maximumEvents = 100,
    maximumContentCharacters = this.defaults.ingestion.maximumBatchCharacters,
    leaseSeconds = this.defaults.ingestion.leaseSeconds,
    maximumTasks = 10,
    maximumStateRequests = 10,
    maximumConsolidationRuns = 3,
    generator = this.providers.generator,
    structureGenerator = this.providers.structureGenerator,
    retrievalContextGenerator = this.providers.retrievalContextGenerator,
    now = new Date(),
  } = {}) {
    const inputBatches = [];
    const failures = [];
    const maximumBatches = Math.min(20, Math.max(1, Math.trunc(Number(maximumInputBatches) || 1)));
    if (processInputEvents && typeof generator === "function") {
      for (let index = 0; index < maximumBatches; index += 1) {
        let result;
        try {
          result = await this.processPendingEvents({
            maximumEvents,
            maximumContentCharacters,
            leaseSeconds,
            generator,
            now,
          });
        } catch (error) {
          const failure = maintenanceFailure("input-events", error);
          inputBatches.push(failure);
          failures.push(failure);
          break;
        }
        inputBatches.push(result);
        if (!['processed', 'quarantined'].includes(result.status)) break;
      }
    }
    let semantic;
    try {
      semantic = await this.withRepository((repository) => runSemanticMemoryMaintenance({
        repository,
        agentId: this.agentId,
        generator,
        structureGenerator,
        retrievalContextGenerator,
        usageLedgerPath: this.paths.usageLedgerPath,
        maximumTasks,
        maximumStateRequests,
        maximumConsolidationRuns,
      }));
    } catch (error) {
      semantic = maintenanceFailure("semantic-tasks", error);
      failures.push(semantic);
    }
    return {
      ...semantic,
      inputBatches: processInputEvents && typeof generator !== "function"
        ? [{ status: "disabled", reason: "generation-provider-not-configured" }]
        : inputBatches,
      failures,
      status: failures.length || semantic.status === "failed"
        ? "completed-with-failures"
        : semantic.status || "completed",
    };
  }

  async runMaintenance({ lane = "all", ...options } = {}) {
    const selected = clean(lane).toLowerCase() || "all";
    if (!["embedding", "semantic", "all"].includes(selected)) {
      throw new Error("Maintenance lane must be embedding, semantic, or all.");
    }
    const result = { status: "completed", lane: selected, failures: [] };
    if (["semantic", "all"].includes(selected)) {
      try {
        result.semantic = await this.runSemanticMaintenance(options);
      } catch (error) {
        result.semantic = maintenanceFailure("semantic", error);
        result.failures.push(result.semantic);
      }
    }
    if (["embedding", "all"].includes(selected)) {
      try {
        result.embedding = await this.runEmbeddingMaintenance(options);
      } catch (error) {
        result.embedding = maintenanceFailure("embedding", error);
        result.failures.push(result.embedding);
      }
    }
    if (result.failures.length || [result.semantic, result.embedding].some((item) => (
      item?.status === "failed" || item?.status === "completed-with-failures"
    ))) result.status = "completed-with-failures";
    return result;
  }

  listHighLevelProposals({
    types = HIGH_LEVEL_PROPOSAL_TYPES,
    reviewStates = ["pending"],
    limit = 100,
  } = {}) {
    const selectedTypes = [...new Set(
      (Array.isArray(types) ? types : [types]).map(highLevelProposalType),
    )];
    const states = proposalReviewStates(reviewStates);
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    return this.withRepository((repository) => {
      const items = [];
      for (const type of selectedTypes) {
        const supportedStates = type === "relation"
          ? states
          : states.filter((state) => state !== "revoked");
        if (!supportedStates.length) continue;
        const proposals = type === "ingestion"
          ? supportedStates.flatMap((reviewState) => repository.listIngestionDecisions(
            this.agentId,
            { reviewState, limit: maximum },
          ))
          : type === "reported-state"
          ? repository.listReportedStateProposals(this.agentId, {
            reviewStates: supportedStates,
            limit: maximum,
          })
          : type === "structure"
            ? repository.listStructureProposals(this.agentId, {
              reviewStates: supportedStates,
              limit: maximum,
            })
            : type === "relation"
              ? repository.listRelationProposals(this.agentId, {
                reviewStates: supportedStates,
                limit: maximum,
              })
              : [
                ...repository.listMaintenanceTasks(this.agentId, {
                  reviewStates: supportedStates,
                  limit: maximum,
                  order: "desc",
                }),
                ...repository.listConsolidationRuns(this.agentId, {
                  statuses: ["failed", "completed", "cancelled"],
                  limit: maximum,
                }).filter((run) => supportedStates.includes(run.review_state))
                  .map(consolidationFailureReviewEnvelope),
              ];
        items.push(...proposals.map((proposal) => highLevelProposalEnvelope(type, proposal)));
      }
      items.sort((left, right) => (
        String(right.createdAt).localeCompare(String(left.createdAt))
        || right.id.localeCompare(left.id)
      ));
      return {
        total: items.length,
        items: items.slice(0, maximum),
      };
    }, { readOnly: true });
  }

  getHighLevelProposal(type, proposalId) {
    const normalizedType = highLevelProposalType(type);
    const id = clean(proposalId);
    if (!id) throw new Error("getHighLevelProposal requires proposalId.");
    return this.withRepository((repository) => {
      const proposal = normalizedType === "ingestion"
        ? repository.getIngestionDecision(this.agentId, id)
        : normalizedType === "reported-state"
        ? repository.getReportedStateProposal(this.agentId, id)
        : normalizedType === "structure"
          ? repository.getStructureProposal(this.agentId, id)
          : normalizedType === "relation"
            ? repository.getRelationProposal(this.agentId, id)
            : repository.getMaintenanceTask(this.agentId, id)
              || consolidationFailureReviewEnvelope(
                repository.getConsolidationRun(this.agentId, id),
              );
      return highLevelProposalEnvelope(normalizedType, proposal);
    }, { readOnly: true });
  }

  reviewConsoleOverview({
    types = HIGH_LEVEL_PROPOSAL_TYPES,
    reviewStates = ["pending"],
    limit = 100,
    now = new Date(),
  } = {}) {
    const inspectedAt = validDate(now, "review console now");
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    const reviews = this.listHighLevelProposals({ types, reviewStates, limit: maximum });
    return this.withRepository((repository, database) => {
      const pipeline = repository.inspectInputPipeline(this.agentId, {
        now: inspectedAt.toISOString(),
        limit: Math.min(200, maximum),
      });
      const maintenance = inspectMaintenance({
        repository,
        agentId: this.agentId,
        limit: Math.min(500, maximum),
      });
      const storage = inspectReviewConsoleStorage({
        database,
        databasePath: this.paths.databasePath,
        backupDirectory: this.paths.backupDirectory,
        agentId: this.agentId,
      });
      const pendingMaintenance = maintenance.tasks.filter((task) => task.status === "pending").length;
      const failedMaintenance = maintenance.tasks.filter((task) => task.status === "failed").length
        + maintenance.consolidationRuns.failed;
      return {
        status: "ready",
        agentId: this.agentId,
        generatedAt: inspectedAt.toISOString(),
        counts: {
          reviews: reviews.total,
          blockedEvents: pipeline.blockedEvents.total,
          activeBatches: pipeline.activeBatches.length,
          expiredBatches: pipeline.expiredBatchCount,
          failedBatches: pipeline.batchCounts.failed,
          pendingMaintenance,
          failedMaintenance,
        },
        reviews: {
          total: reviews.total,
          items: reviews.items.map(reviewProposalSummary),
        },
        pipeline,
        maintenance,
        storage,
      };
    }, { readOnly: true });
  }

  getReviewConsoleProposal(type, proposalId) {
    const envelope = this.getHighLevelProposal(type, proposalId);
    if (!envelope) return null;
    return this.withRepository((repository) => buildReviewProposalDetail({
      repository,
      agentId: this.agentId,
      envelope,
    }), { readOnly: true });
  }

  resolveHighLevelProposal(type, proposalId, {
    action,
    actor = "human",
    reason = "",
  } = {}) {
    const normalizedType = highLevelProposalType(type);
    const id = clean(proposalId);
    const normalizedAction = clean(action).toLowerCase();
    if (!id) throw new Error("resolveHighLevelProposal requires proposalId.");
    if (!["accept", "dismiss"].includes(normalizedAction)) {
      throw new Error("High-level proposal action must be accept or dismiss.");
    }
    return this.withRepository((repository) => {
      if (normalizedType === "ingestion") {
        const current = repository.getIngestionDecision(this.agentId, id);
        if (!current) throw new Error("Memory ingestion review was not found.");
        const resolution = resolveMemoryIngestionReview(repository, {
          agentId: this.agentId,
          decisionId: id,
          action: normalizedAction,
          candidate: normalizedAction === "accept"
            ? existingIngestionCandidate(repository, this.agentId, current)
            : null,
          note: clean(reason),
          resolvedBy: clean(actor) || "human",
        });
        const maintenance = normalizedAction === "accept" && resolution.memory?.id
          ? runImmediateMemoryMaintenance({
            repository,
            agentId: this.agentId,
            batchId: `ingestion-review:${id}`,
            memoryIds: [resolution.memory.id],
            followUpTaskTypes: [
              MAINTENANCE_TASK_TYPES.memoryEmbedding,
              MAINTENANCE_TASK_TYPES.retrievalContext,
            ],
            planConsolidation: false,
          })
          : {
            status: "not-required",
            reason: normalizedAction === "dismiss"
              ? "ingestion-review-dismissed"
              : "ingestion-review-needs-correction",
          };
        return {
          type: normalizedType,
          id,
          action: normalizedAction,
          resolution,
          maintenance,
        };
      }
      if (normalizedType === "maintenance-failure") {
        const current = repository.getMaintenanceTask(this.agentId, id);
        const consolidation = current ? null : repository.getConsolidationRun(this.agentId, id);
        if (consolidation) {
          const resolution = repository.reviewConsolidationFailure({
            agentId: this.agentId,
            runId: id,
            action: normalizedAction,
            reviewedBy: clean(actor) || "human",
            note: clean(reason),
          });
          return {
            type: normalizedType,
            id,
            action: normalizedAction,
            resolution: { run: resolution },
            maintenance: {
              status: "completed-by-human",
              reason: normalizedAction === "accept"
                ? "partial-consolidation-proposals-retained-for-separate-review"
                : "consolidation-failure-dismissed",
            },
          };
        }
        if (!current) throw new Error("Maintenance failure was not found.");
        if (current.task_type === "input-event-quarantine") {
          const task = repository.reviewMaintenanceTaskFailure({
            agentId: this.agentId,
            taskId: id,
            action: normalizedAction,
            reviewedBy: clean(actor) || "human",
            note: clean(reason),
          });
          return {
            type: normalizedType,
            id,
            action: normalizedAction,
            resolution: { task },
            maintenance: {
              status: "completed-by-human",
              reason: normalizedAction === "accept"
                ? "input-event-quarantine-confirmed"
                : "input-event-quarantine-dismissed",
            },
          };
        }
        const applicableFailures = (Array.isArray(current.result?.failures)
          ? current.result.failures
          : []).filter((failure) => (
          clean(failure?.memoryIds?.[0])
          && clean(failure?.sourceHash)
          && clean(failure?.candidate?.context)
        ));
        if (normalizedAction === "accept" && current.task_type !== MAINTENANCE_TASK_TYPES.retrievalContext) {
          throw new Error("This maintenance failure has no human-reviewable semantic candidate.");
        }
        if (normalizedAction === "accept" && !applicableFailures.length) {
          throw new Error("This maintenance failure has no completed candidate to accept.");
        }
        const resolution = repository.transaction(() => {
          const applied = normalizedAction === "accept"
            ? applicableFailures.map((failure) => repository.upsertMemoryRetrievalContext({
              agentId: this.agentId,
              memoryId: clean(failure.memoryIds[0]),
              policyVersion: clean(current.result?.policyVersion) || "retrieval-context-v1",
              sourceHash: clean(failure.sourceHash),
              contextText: clean(failure.candidate.context),
              queryTerms: Array.isArray(failure.candidate.queryTerms)
                ? failure.candidate.queryTerms
                : [],
              provider: "human-review",
              model: clean(failure.candidate.model),
              promptVersion: "manual-maintenance-review-v1",
              proposalRequestId: clean(failure.candidate.requestId),
              metadata: {
                approvedBy: clean(actor) || "human",
                approvalReason: clean(reason),
                originalProvider: clean(failure.candidate.provider),
                failedTaskId: id,
              },
            }))
            : [];
          const task = repository.reviewMaintenanceTaskFailure({
            agentId: this.agentId,
            taskId: id,
            action: normalizedAction,
            reviewedBy: clean(actor) || "human",
            note: clean(reason),
          });
          return { applied, task };
        });
        const acceptedMemoryIds = normalizedAction === "accept"
          ? [...new Set(applicableFailures.map((failure) => clean(failure.memoryIds[0])))]
          : [];
        const followUp = acceptedMemoryIds.length
          ? runImmediateMemoryMaintenance({
            repository,
            agentId: this.agentId,
            batchId: `maintenance-human-review:${id}`,
            memoryIds: [],
            embeddingMemoryIds: acceptedMemoryIds,
            followUpTaskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding],
            planConsolidation: false,
          })
          : { status: "not-required", queued: [] };
        return {
          type: normalizedType,
          id,
          action: normalizedAction,
          resolution,
          maintenance: normalizedAction === "accept"
            ? { status: "completed-by-human", followUp }
            : { status: "completed-by-human", reason: "maintenance-failure-dismissed" },
        };
      }
      const common = {
        agentId: this.agentId,
        proposalId: id,
        action: normalizedAction,
        resolvedBy: clean(actor) || "human",
        note: clean(reason),
      };
      const resolution = normalizedType === "reported-state"
        ? resolveReportedStateProposal(repository, common)
        : normalizedType === "structure"
          ? resolveMemoryStructureProposal(repository, common)
          : resolveMemoryRelationProposal(repository, common);
      let maintenance = {
        status: "not-required",
        reason: normalizedAction === "dismiss"
          ? "proposal-dismissed"
          : "relation-edge-is-immediately-queryable",
      };
      if (normalizedAction === "accept" && resolution.memory?.id) {
        maintenance = runImmediateMemoryMaintenance({
          repository,
          agentId: this.agentId,
          batchId: `high-level-resolution:${normalizedType}:${id}`,
          memoryIds: [resolution.memory.id],
          followUpTaskTypes: [
            MAINTENANCE_TASK_TYPES.memoryEmbedding,
            MAINTENANCE_TASK_TYPES.retrievalContext,
          ],
          planConsolidation: normalizedType === "reported-state",
        });
      }
      return {
        type: normalizedType,
        id,
        action: normalizedAction,
        resolution,
        maintenance,
      };
    });
  }

  revokeHighLevelRelation(proposalId, {
    actor = "human",
    reason = "",
  } = {}) {
    const id = clean(proposalId);
    if (!id) throw new Error("revokeHighLevelRelation requires proposalId.");
    return this.withRepository((repository) => ({
      type: "relation",
      id,
      proposal: revokeMemoryRelationProposal(repository, {
        agentId: this.agentId,
        proposalId: id,
        revokedBy: clean(actor) || "human",
        note: clean(reason),
      }),
    }));
  }

  listMemories(options = {}) {
    return this.withRepository(
      (repository) => repository.listMemories(this.agentId, options),
      { readOnly: true },
    );
  }

  getMemory(memoryId) {
    const id = clean(memoryId);
    if (!id) throw new Error("getMemory requires memoryId.");
    return this.withRepository(
      (repository) => repository.getMemoryDetail(this.agentId, id),
      { readOnly: true },
    );
  }

  editMemory(memoryId, patch, { actor = "human", reason = "" } = {}) {
    const id = clean(memoryId);
    if (!id) throw new Error("editMemory requires memoryId.");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("editMemory requires a patch object.");
    }
    return this.withRepository((repository) => {
      const edited = repository.editMemoryManually({
        agentId: this.agentId,
        memoryId: id,
        patch,
        actor: clean(actor) || "human",
        reason: clean(reason),
      });
      return {
        ...edited,
        maintenance: runImmediateMemoryMaintenance({
          repository,
          agentId: this.agentId,
          batchId: `manual-edit:${edited.id}:${edited.updated_at}`,
          memoryIds: [id],
        }),
      };
    });
  }

  setMemoryDeleted(memoryId, deleted, { actor = "human", reason = "" } = {}) {
    const id = clean(memoryId);
    if (!id) throw new Error("setMemoryDeleted requires memoryId.");
    return this.withRepository((repository) => repository.setMemoryDeleted({
      agentId: this.agentId,
      memoryId: id,
      deleted: Boolean(deleted),
      actor: clean(actor) || "human",
      reason: clean(reason),
    }));
  }

  deleteMemory(memoryId, options = {}) {
    return this.setMemoryDeleted(memoryId, true, options);
  }

  restoreMemory(memoryId, options = {}) {
    const restored = this.setMemoryDeleted(memoryId, false, options);
    return this.withRepository((repository) => ({
      ...restored,
      maintenance: runImmediateMemoryMaintenance({
        repository,
        agentId: this.agentId,
        batchId: `manual-restore:${restored.id}:${restored.updated_at}`,
        memoryIds: [clean(memoryId)],
      }),
    }));
  }

  listRetrievalTraces(options = {}) {
    return this.withRepository(
      (repository) => repository.listRetrievalTraces(this.agentId, options),
      { readOnly: true },
    );
  }

  recordRetrievalFeedback({ traceId, signal, targetMemoryIds = [], note = "", metadata = {} } = {}) {
    return this.withRepository((repository) => repository.recordRetrievalFeedback({
      agentId: this.agentId,
      traceId: clean(traceId),
      signal: clean(signal),
      targetMemoryIds,
      note: clean(note),
      metadata,
    }));
  }

  setRetrievalSessionHead({
    sessionId,
    traceId = "",
    now = new Date(),
  } = {}) {
    return this.withRepository((repository) => repository.setRetrievalSessionHead({
      agentId: this.agentId,
      sessionId: clean(sessionId),
      traceId: clean(traceId),
      updatedAt: validDate(now, "retrieval session head now").toISOString(),
    }));
  }

  bindRetrievalUsageResponse({
    sessionId,
    responseText,
    metadata = {},
    now = new Date(),
  } = {}) {
    return this.withRepository((repository) => repository.bindRetrievalUsageResponse({
      agentId: this.agentId,
      sessionId: clean(sessionId),
      responseText: clean(responseText),
      metadata,
      createdAt: validDate(now, "retrieval response now").toISOString(),
    }));
  }

  bindRewardObservation({
    sessionId,
    feedbackText,
    metadata = {},
    now = new Date(),
  } = {}) {
    return this.withRepository((repository) => repository.bindRewardObservation({
      agentId: this.agentId,
      sessionId: clean(sessionId),
      feedbackText: clean(feedbackText),
      metadata,
      observedAt: validDate(now, "reward observation now").toISOString(),
    }));
  }

  async search(query, {
    now = new Date(),
    anchors = [],
    anchorSelection = {},
    queryPerspective = {},
    world = null,
    allowCrossWorld = false,
    options = {},
    embeddingProvider = this.providers.embedding,
    persistTrace = true,
  } = {}) {
    const text = clean(query);
    if (!text) throw new Error("search requires query.");
    const executionTime = validDate(now, "search now");
    const retrievalOptions = {
      ...this.defaults.retrieval,
      ...(options && typeof options === "object" ? options : {}),
    };
    const requestedWorld = world && typeof world === "object" && !Array.isArray(world)
      ? world
      : {};
    const requestedWorldId = clean(requestedWorld.id || requestedWorld.worldId);
    const requestedWorldFrame = clean(requestedWorld.frame || requestedWorld.worldFrame);
    const hasRequestedWorld = Boolean(requestedWorldId || requestedWorldFrame);
    const worldScope = hasRequestedWorld
      ? {
        id: requestedWorldId || this.defaults.defaultWorldId,
        frame: requestedWorldFrame || this.defaults.defaultWorldFrame,
      }
      : {};
    const providedQueryPerspective = queryPerspective && typeof queryPerspective === "object"
      && !Array.isArray(queryPerspective)
      ? queryPerspective
      : {};
    const resolvedQueryPerspective = {
      speakerRole: "user",
      speakerKey: this.defaults.primaryUserId,
      speakerNames: [this.defaults.userName],
      addresseeRole: "agent",
      addresseeKey: this.defaults.companionId,
      addresseeNames: [this.defaults.memoryOwner],
      ...providedQueryPerspective,
    };
    const recallReactivationPolicy = normalizeRecallReactivationOptions(
      retrievalOptions.recallReactivation,
    );
    this.initialize();
    const result = await retrieveMemories({
      databasePath: this.paths.databasePath,
      agentId: this.agentId,
      query: text,
      anchorMemoryIds: anchors,
      anchorSelection,
      now: executionTime,
      embeddingProvider,
      usageLedgerPath: this.paths.usageLedgerPath,
      queryPerspective: resolvedQueryPerspective,
      world: worldScope,
      allowCrossWorld: Boolean(allowCrossWorld || requestedWorld.allowCrossWorld),
      options: retrievalOptions,
    });
    if (!persistTrace || !result.trace) return result;
    const persisted = this.withRepository((repository) => repository.transaction(() => {
      const storedTrace = repository.recordRetrievalTrace(result.trace);
      const reactivation = repository.applyRecallReactivation({
        agentId: this.agentId,
        traceId: storedTrace.id,
        activatedAt: executionTime.toISOString(),
        policy: recallReactivationPolicy,
      });
      return { storedTrace, reactivation };
    }));
    return {
      ...result,
      trace: {
        ...result.trace,
        id: persisted.storedTrace.id,
        persisted: true,
        reactivation: persisted.reactivation,
      },
    };
  }

  syncEmbeddings(options = {}) {
    const embeddingProvider = options.embeddingProvider || this.providers.embedding;
    return this.withRepository((repository) => syncMemoryEmbeddings({
      ...options,
      repository,
      agentId: this.agentId,
      embeddingProvider,
      ledgerPath: clean(options.ledgerPath) || this.paths.usageLedgerPath,
    }));
  }

  analyzePendingState({
    maxRequests = 10,
    generator = this.providers.generator,
    snapshotOptions = {},
    reviewVersion = "",
  } = {}) {
    return this.withRepository((repository) => processPendingStateAnalysisRequests({
      repository,
      agentId: this.agentId,
      generator,
      maxRequests,
      usageLedgerPath: this.paths.usageLedgerPath,
      snapshotOptions,
      reviewVersion,
    }));
  }

  processConsolidation({
    maximumRuns = 3,
    generator = this.providers.structureGenerator,
  } = {}) {
    return this.withRepository((repository) => processPlannedConsolidationRuns({
      repository,
      agentId: this.agentId,
      generator,
      maximumRuns,
      usageLedgerPath: this.paths.usageLedgerPath,
    }));
  }

  brainSnapshot({ cachePath = this.paths.visualizationCachePath } = {}) {
    return this.withRepository((repository) => createBrainSnapshot({
      repository,
      agentId: this.agentId,
      cachePath,
    }));
  }
}

export function createMemoryService(options = {}) {
  return new MemoryService(options);
}

export {
  createDatabaseBackup,
  inspectDatabaseBackup,
  restoreDatabaseBackup,
};
