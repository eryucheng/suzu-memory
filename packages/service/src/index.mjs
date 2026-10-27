import fs from "node:fs";
import path from "node:path";
import { appendMemoryEventSources } from './event-source-ingestion.mjs';
import { adoptLegacySourceEvidence, adoptExperienceSourceEvidence } from './legacy-source-import.mjs';
import { eraseMemoryEventSources, recoverMemoryEventSourceCleanups } from './event-source-cleanup.mjs';
export { validateMemoryExtractionOutput } from './event-source-ingestion.mjs';
export { assertMemoryTaskRequest, validateMemoryTaskOutput, isMemoryStateAnalysisRequest } from './model-task-validation.mjs';

import { processPendingStateAnalysisRequests } from "@suzu-memory/analysis";
import {
  databaseInfo,
  assertEventSourceScope,
  eventSourceState,
  getEventSourceCleanup,
  withEventSourceExecution,
  assertEventSourceExecutionCurrent,
  currentEventSourceExecution,
  executionEventSourceView,
  ensureCompanionRelationshipStructure,
  materializePendingMemoryStructureProposals,
  MemoryRepository,
  openMemoryDatabase,
  rebuildAssociationGraph,
  resolveMemoryIngestionReview,
  resolveEventContinuityReview,
  resolveMemoryRelationProposal,
  resolveMemoryStructureProposal,
  resolveReportedStateProposal,
  resolvePreferenceStateProposal,
  revokeMemoryRelationProposal,
} from "@suzu-memory/core";
import { syncMemoryEmbeddings } from "@suzu-memory/embedding-indexer";
import {
  appendCompanionEvents,
  DEFAULT_LENGTH_ARCHIVE_POLICY,
  processPendingCompanionEvents,
  reviseCompanionEvent,
} from "@suzu-memory/ingestion";
import {
  inspectMaintenance,
  MAINTENANCE_TASK_TYPES,
  runEmbeddingMaintenance,
  DEFAULT_MINIMUM_STRUCTURE_MEMORIES,
  runImmediateMemoryMaintenance,
  runSemanticMemoryMaintenance,
} from "@suzu-memory/maintenance";
import {
  normalizeRecallReactivationOptions,
  retrieveMemories,
  closeRetrievalWorker,
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
  importDatabaseAsAgent,
  inspectDatabaseBackup,
  restoreDatabaseBackup,
} from "./database-backup.mjs";
import {
  buildReviewProposalDetail,
  consolidationFailureReviewEnvelope,
  inspectReviewConsoleStorage,
  reviewProposalSummary,
  resolveIngestionReviewInput,
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

function requireMaintenanceScope() {
  const execution = currentEventSourceExecution();
  if (execution?.sourceScoped && !execution.sourceScope) {
    throw Object.assign(new Error('Event-backed maintenance requires its fixed sourceScope.'), { code: 'EVENT_SOURCE_SCOPE_REQUIRED' });
  }
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
  "preference-state",
  "structure",
  "relation",
  "event-continuity",
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
  agentRoot = "",
  databasePath = "",
  usageLedgerPath = "",
} = {}) {
  const resolvedDataRoot = resolveMemoryDataRoot({ configuredRoot: dataRoot });
  const resolvedAgentId = clean(agentId) || stableAgentId(projectRoot);
  if (!resolvedAgentId) {
    throw new Error("Suzu Memory requires agentId or projectRoot.");
  }
  const resolvedAgentRoot = clean(agentRoot) ? path.resolve(agentRoot) : resolveAgentDataRoot({
    dataRoot: resolvedDataRoot,
    agentId: resolvedAgentId,
  });
  const relative = path.relative(resolvedDataRoot, resolvedAgentRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Memory Agent storage must belong to its configured data root.');
  const memoryRoot = path.join(resolvedAgentRoot, "memory");
  return Object.freeze({
    dataRoot: resolvedDataRoot,
    agentId: resolvedAgentId,
    agentRoot: resolvedAgentRoot,
    memoryRoot,
    databasePath: clean(databasePath)
      ? path.resolve(databasePath)
      : path.join(memoryRoot, "memory.db"),
    usageLedgerPath: clean(usageLedgerPath)
      ? path.resolve(usageLedgerPath)
      : path.join(resolvedAgentRoot, "usage", "events.jsonl"),
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
    agentRoot = "",
    databasePath = "",
    usageLedgerPath = "",
    providers = {},
    defaults = {},
    readOnly = false,
  } = {}) {
    this.paths = resolveMemoryServicePaths({
      dataRoot,
      projectRoot,
      agentId,
      agentRoot,
      databasePath,
      usageLedgerPath,
    });
    this.initialized = false;
    this.readOnly = Boolean(readOnly);
    this.providers = Object.freeze({
      generator: providers.generator || null,
      structureGenerator: providers.structureGenerator || providers.generator || null,
      retrievalContextGenerator: providers.retrievalContextGenerator || null,
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
      userName: clean(defaults.userName) || (defaults.createPrimaryRelationship === false ? '' : '对方'),
      primaryUserId: clean(defaults.primaryUserId) || (defaults.createPrimaryRelationship === false ? '' : 'user'),
      companionId: clean(defaults.companionId) || this.paths.agentId,
      relationshipLabel: clean(defaults.relationshipLabel) || "关系",
      createPrimaryRelationship: defaults.createPrimaryRelationship !== false,
      defaultWorldId: clean(defaults.defaultWorldId) || "relationship",
      defaultWorldFrame: clean(defaults.defaultWorldFrame) || "relational",
      ingestion: Object.freeze({
        ...Object.fromEntries(Object.entries(DEFAULT_LENGTH_ARCHIVE_POLICY).map(([key, fallback]) => [key, defaults.ingestion?.[key] ?? fallback])),
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

  close() { return closeRetrievalWorker(this.paths.databasePath); }

  initialize() {
    if (!this.readOnly) fs.mkdirSync(this.paths.memoryRoot, { recursive: true });
    const database = openMemoryDatabase(this.paths.databasePath, { readOnly: this.readOnly });
    try {
      const repository = new MemoryRepository(database, { timeZone: this.defaults.retrieval.timeZone });
      if (!this.readOnly) recoverMemoryEventSourceCleanups(this, repository);
      const identityStructure = this.readOnly ? null : ensureCompanionRelationshipStructure({
        createPrimaryRelationship: this.defaults.createPrimaryRelationship,
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
      const pendingStructureMaterialization = this.readOnly ? null : materializePendingMemoryStructureProposals(
        repository,
        { agentId: this.agentId },
      );
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
        pendingStructureMaterialization: pendingStructureMaterialization && {
          materialized: pendingStructureMaterialization.materialized.length,
          alreadyMaterialized: pendingStructureMaterialization.skipped.length,
          failed: pendingStructureMaterialization.failed,
        },
        identityStructure: identityStructure && {
          userEntityId: identityStructure.user?.id || '',
          companionEntityId: identityStructure.companion.id,
          relationshipId: identityStructure.relationship?.id || '',
          relationshipLabel: identityStructure.relationship?.label || '',
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

  withRepository(callback, { readOnly = false, sourceScope = null, signal = null } = {}) {
    if (typeof callback !== "function") throw new Error("withRepository requires a callback.");
    this.ensureInitialized();
    const database = openMemoryDatabase(this.paths.databasePath, { readOnly: this.readOnly || readOnly });
    try {
      const repository = new MemoryRepository(database, { timeZone: this.defaults.retrieval.timeZone });
      const result = withEventSourceExecution(repository, () => callback(repository, database), { sourceScope, signal });
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

  eraseEventSources(input) { this.ensureInitialized(); return eraseMemoryEventSources(this, input); }
  getEventSourceCleanup(id) { return this.withRepository(repository => getEventSourceCleanup(repository, this.agentId, id), { readOnly: true }); }

  getEventSourceProgress({ scope } = {}) {
    return this.withRepository(repository => eventSourceState(repository,
      assertEventSourceScope(repository, scope, this.agentId)), { readOnly: true });
  }

  recoverEventSourceCleanups() {
    this.ensureInitialized();
    return this.withRepository(repository => recoverMemoryEventSourceCleanups(this, repository));
  }

  backupDatabase({ destinationPath = "", overwrite = false, now = new Date() } = {}) {
    if (this.readOnly) throw new Error('Read-only memory service cannot create database backups.');
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

  inspectDatabaseImport(sourcePath) {
    // An import accepts a raw runtime database, not only an exported backup.
    // Ignore a neighbouring manifest because it may belong to an older copy.
    return inspectDatabaseBackup(sourcePath, { verifyManifest: false });
  }

  restoreDatabaseBackup(sourcePath, {
    confirmAgentId = "",
    now = new Date(),
  } = {}) {
    if (this.readOnly) throw new Error('Read-only memory service cannot restore database backups.');
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

  importDatabaseAsAgent(sourcePath, {
    confirmAgentId = "",
    now = new Date(),
  } = {}) {
    if (this.readOnly) throw new Error('Read-only memory service cannot import databases.');
    if (clean(confirmAgentId) !== this.agentId) {
      const error = new Error(`Database import requires confirmAgentId=${this.agentId}.`);
      error.code = "IMPORT_CONFIRMATION_REQUIRED";
      throw error;
    }
    const result = importDatabaseAsAgent({
      databasePath: this.paths.databasePath,
      sourcePath,
      agentId: this.agentId,
      backupDirectory: this.paths.backupDirectory,
      now: validDate(now, "database import now"),
    });
    // Layout coordinates are local presentation cache, not part of a portable
    // memory DB. Rebuild them from the imported graph on the next view.
    fs.rmSync(this.paths.visualizationCachePath, { force: true });
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

  appendEventSources(input) { return appendMemoryEventSources(this, input); }

  adoptLegacySourceEvidence(input) { return adoptLegacySourceEvidence(this, input); }
  adoptExperienceSourceEvidence(input) { return adoptExperienceSourceEvidence(this, input); }

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

  recoverRunningMaintenance({
    force = false,
    now = new Date(),
  } = {}) {
    const recoveredAt = validDate(now, "maintenance recovery now").toISOString();
    return this.withRepository((repository) => ({
      tasks: repository.recoverRunningMaintenanceTasks(this.agentId, {
        force: Boolean(force),
        recoveredAt,
      }),
      consolidations: repository.recoverRunningConsolidationRuns(this.agentId, {
        force: Boolean(force),
        recoveredAt,
      }),
    }));
  }

  async retryLongTermExtractionFailure(taskId, {
    actor = "human",
    reason = "",
    generator = this.providers.generator,
    now = new Date(),
  } = {}) {
    const normalizedTaskId = clean(taskId);
    if (!normalizedTaskId) throw new Error("Retrying long-term extraction requires a review task id.");
    if (typeof generator !== "function") {
      throw new Error("Long-term extraction retry requires a generation provider.");
    }
    const executionTime = validDate(now, "long-term extraction retry now");
    const task = this.withRepository((repository) => {
      const current = repository.getMaintenanceTask(this.agentId, normalizedTaskId);
      if (!current || current.task_type !== "long-term-extraction"
        || current.status !== "failed" || current.review_state !== "pending") {
        throw new Error("Long-term extraction failure is not awaiting human retry.");
      }
      const eventIds = [...new Set(
        (Array.isArray(current.payload?.eventIds) ? current.payload.eventIds : [])
          .map(clean)
          .filter(Boolean),
      )];
      const view = executionEventSourceView(repository, this.agentId);
      if (view && eventIds.some(id => !view.inputIds.has(id))) {
        throw Object.assign(new Error('Extraction review sources await an eligible scope.'), { code: 'EVENT_SOURCE_TASK_DEFERRED' });
      }
      if (!eventIds.length) {
        throw new Error("Long-term extraction failure has no recoverable source events.");
      }
      repository.requeueArchivedInputEventsForHumanRetry({
        agentId: this.agentId,
        eventIds,
        retryTaskId: current.id,
        reason: clean(reason),
        retriedAt: executionTime.toISOString(),
      });
      return current;
    });
    let result = null;
    let latestError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        result = await this.processPendingEvents({
          candidateEventIds: task.payload.eventIds,
          generator,
          now: executionTime,
        });
        break;
      } catch (error) {
        assertEventSourceExecutionCurrent();
        latestError = error;
      }
    }
    if (!result) throw latestError || new Error("Long-term extraction retry did not produce a result.");
    if (result.status !== "processed" || result.generationDiagnostics?.degraded) {
      return {
        status: "retry-degraded",
        result,
        reviewTask: this.withRepository((repository) => (
          repository.getMaintenanceTask(this.agentId, normalizedTaskId)
        ), { readOnly: true }),
      };
    }
    return this.withRepository((repository) => ({
      status: "retried",
      result,
      reviewTask: repository.reviewMaintenanceTaskFailure({
        agentId: this.agentId,
        taskId: normalizedTaskId,
        action: "accept",
        reviewedBy: clean(actor) || "human",
        note: clean(reason) || "Human requested a successful long-term extraction retry.",
        reviewedAt: executionTime.toISOString(),
      }),
    }));
  }

  processPendingEvents({
    chunkPolicy = null,
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
    sourceScope = null,
    signal = null,
  } = {}) {
    return this.withRepository((repository) => processPendingCompanionEvents({
      repository,
      agentId: this.agentId,
      identity: this.companionIdentity(),
      chunkPolicy,
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
      timeZone: this.defaults.retrieval.timeZone,
      now: validDate(now, "event processing now"),
      memoriesOverride,
    }), { sourceScope, signal });
  }

  maintenanceStatus({ limit = 100, minimumStructureMemories = DEFAULT_MINIMUM_STRUCTURE_MEMORIES } = {}) {
    return this.withRepository((repository) => {
      const maintenance = inspectMaintenance({
        repository,
        agentId: this.agentId,
        limit,
        minimumStructureMemories,
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

  managementStatus() {
    return this.withRepository((repository, database) => ({
      status: 'ready', agentId: this.agentId, databasePath: this.paths.databasePath,
      memories: repository.listMemories(this.agentId, { statuses: ['active'], limit: 1 }).total,
      edges: Number(database.prepare('SELECT COUNT(*) AS count FROM memory_edges WHERE agent_id=?').get(this.agentId).count),
      embeddings: Number(database.prepare(`SELECT COUNT(*) AS count FROM memory_embeddings embedding
        JOIN memory_nodes memory ON memory.id=embedding.memory_id WHERE memory.agent_id=? AND memory.status='active'`).get(this.agentId).count),
    }), { readOnly: true });
  }

  runEmbeddingMaintenance({
    maximumTasks = 10,
    batchSize = 10,
    embeddingProvider = this.providers.embedding,
    sourceScope = null,
    signal = null,
  } = {}) {
    return this.withRepository((repository) => {
      requireMaintenanceScope();
      return runEmbeddingMaintenance({
        repository,
        agentId: this.agentId,
        embeddingProvider,
        usageLedgerPath: this.paths.usageLedgerPath,
        maximumTasks,
        batchSize,
      });
    }, { sourceScope, signal });
  }

  async runSemanticMaintenance({
    embeddingProvider = this.providers.embedding,
    chunkPolicy = null,
    processInputEvents = true,
    maximumInputBatches = 1,
    maximumEvents = 100,
    maximumContentCharacters = this.defaults.ingestion.maximumBatchCharacters,
    leaseSeconds = this.defaults.ingestion.leaseSeconds,
    maximumTasks = 10,
    minimumStructureMemories = DEFAULT_MINIMUM_STRUCTURE_MEMORIES,
    maximumStateRequests = 10,
    maximumConsolidationRuns = 3,
    generator = this.providers.generator,
    structureGenerator = this.providers.structureGenerator,
    retrievalContextGenerator = this.providers.retrievalContextGenerator,
    now = new Date(),
    sourceScope = null,
    signal = null,
  } = {}) {
    return this.withRepository(async () => {
      requireMaintenanceScope();
      const inputBatches = [];
      const failures = [];
      const maximumBatches = Math.min(20, Math.max(1, Math.trunc(Number(maximumInputBatches) || 1)));
      if (processInputEvents && typeof generator === "function") {
        for (let index = 0; index < maximumBatches; index += 1) {
          let result;
          try {
            result = await this.processPendingEvents({
              chunkPolicy,
              maximumEvents,
              maximumContentCharacters,
              leaseSeconds,
              generator,
              now,
            });
          } catch (error) {
            signal?.throwIfAborted();
            assertEventSourceExecutionCurrent();
            const failure = maintenanceFailure("input-events", error);
            inputBatches.push(failure);
            failures.push(failure);
            break;
          }
          inputBatches.push(result);
          if (!['processed', 'quarantined'].includes(result.status)) break;
        }
      }
      if (chunkPolicy?.maximumCoreCharacters != null && inputBatches.at(-1)?.status === 'waiting'
        && !inputBatches.some(batch => ['processed', 'quarantined'].includes(batch.status))) {
        return { status: 'waiting', inputBatches, failures, tasks: [] };
      }
      let semantic;
      try {
        semantic = await this.withRepository((repository) => runSemanticMemoryMaintenance({
          repository,
          embeddingProvider,
          agentId: this.agentId,
          generator,
          structureGenerator,
          retrievalContextGenerator,
          usageLedgerPath: this.paths.usageLedgerPath,
          maximumTasks,
          minimumStructureMemories,
          maximumStateRequests,
          maximumConsolidationRuns,
          maximumRequestCharacters: this.defaults.ingestion.maximumRequestCharacters,
        }));
      } catch (error) {
        signal?.throwIfAborted();
        assertEventSourceExecutionCurrent();
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
    }, { sourceScope, signal });
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
        if (error.code?.startsWith('EVENT_SOURCE_')) throw error;
        options.signal?.throwIfAborted();
        assertEventSourceExecutionCurrent();
        result.semantic = maintenanceFailure("semantic", error);
        result.failures.push(result.semantic);
      }
    }
    if (["embedding", "all"].includes(selected)) {
      try {
        result.embedding = await this.runEmbeddingMaintenance(options);
      } catch (error) {
        if (error.code?.startsWith('EVENT_SOURCE_')) throw error;
        options.signal?.throwIfAborted();
        assertEventSourceExecutionCurrent();
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
        const proposals = type === 'event-continuity'
          ? repository.listMaintenanceTasks(this.agentId, { taskTypes: ['event-continuity-review'], reviewStates: supportedStates, limit: maximum, order: 'desc' })
          : type === "ingestion"
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
            : type === "preference-state"
            ? repository.listPreferenceStateProposals(this.agentId, {
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
                }).filter(task => task.task_type !== 'event-continuity-review'),
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
          : normalizedType === "preference-state"
          ? repository.getPreferenceStateProposal(this.agentId, id)
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
    candidateMemoryId = '',
    identityBindings = {},
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
    return this.withRepository((repository) => repository.transaction(() => {
      if (normalizedType === 'event-continuity') {
        const resolution = resolveEventContinuityReview(repository, { agentId: this.agentId, taskId: id,
          action: normalizedAction, candidateMemoryId: clean(candidateMemoryId), actor: clean(actor) || 'human', reason: clean(reason) });
        return { type: normalizedType, id, action: normalizedAction, resolution };
      }
      if (normalizedType === "ingestion") {
        const current = repository.getIngestionDecision(this.agentId, id);
        if (!current) throw new Error("Memory ingestion review was not found.");
        const input = normalizedAction === 'accept'
          ? resolveIngestionReviewInput(repository, this.agentId, current, identityBindings) : null;
        if (current.review_state === 'pending' && input?.identityChoices.some(choice => !identityBindings?.[choice.key])) {
          return { type: normalizedType, id, action: normalizedAction,
            resolution: { status: 'needs-correction', decision: current, memory: null, reasons: ['ambiguous-participant-identity'] } };
        }
        const resolution = resolveMemoryIngestionReview(repository, {
          agentId: this.agentId,
          decisionId: id,
          action: normalizedAction,
          candidate: input?.candidate || null,
          note: clean(reason),
          resolvedBy: clean(actor) || "human",
        });
        const maintenance = normalizedAction === "accept" && resolution.memory?.id
          ? runImmediateMemoryMaintenance({
            repository,
            agentId: this.agentId,
            batchId: `ingestion-review:${id}`,
            memoryIds: [resolution.memory.id],
            requiredFollowUpEnqueue: true,
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
        : normalizedType === "preference-state"
          ? resolvePreferenceStateProposal(repository, common)
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
    }));
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
    return this.withRepository((repository) => repository.transaction(() => {
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
          memoryIds: [...new Set([id, ...(edited.eventContinuityInvalidatedMemoryIds || [])])],
          requiredFollowUpEnqueue: true,
        }),
      };
    }));
  }

  setMemoryDeleted(memoryId, deleted, { actor = "human", reason = "" } = {}) {
    const id = clean(memoryId);
    if (!id) throw new Error("setMemoryDeleted requires memoryId.");
    return this.withRepository((repository) => repository.transaction(() => {
      const changed = repository.setMemoryDeleted({
        agentId: this.agentId,
        memoryId: id,
        deleted: Boolean(deleted),
        actor: clean(actor) || "human",
        reason: clean(reason),
      });
      return {
        ...changed,
        maintenance: runImmediateMemoryMaintenance({
          repository,
          agentId: this.agentId,
          batchId: `manual-${deleted ? 'delete' : 'restore'}:${changed.id}:${changed.updated_at}`,
          memoryIds: [...new Set([id, ...(changed.eventContinuityInvalidatedMemoryIds || [])])],
          ...(deleted ? { embeddingMemoryIds: [], followUpTaskTypes: ['event-continuity'], planConsolidation: false } : {}),
          requiredFollowUpEnqueue: true,
        }),
      };
    }));
  }

  deleteMemory(memoryId, options = {}) {
    return this.setMemoryDeleted(memoryId, true, options);
  }

  restoreMemory(memoryId, options = {}) {
    return this.setMemoryDeleted(memoryId, false, options);
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
    reactivate = false,
    activationId = "",
    sourceScope = null,
    signal = null,
  } = {}) {
    if (this.readOnly && (persistTrace || reactivate)) {
      throw new Error('Read-only memory service requires trace persistence and reactivation to be disabled.');
    }
    return this.withRepository(async () => {
      const text = clean(query);
      if (!text) throw new Error("search requires query.");
      if (reactivate && !persistTrace && !clean(activationId)) {
        throw new Error("Trace-free reactivation requires a stable activationId.");
      }
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
      if (sourceScope) sourceScope = this.withRepository(repository => assertEventSourceScope(repository, sourceScope, this.agentId), { readOnly: true });
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
        sourceScope,
        signal,
      });
      assertEventSourceExecutionCurrent();
      if ((!persistTrace && !reactivate) || !result.trace) return result;
      const persisted = this.withRepository((repository) => repository.transaction(() => {
        if (sourceScope) assertEventSourceScope(repository, sourceScope, this.agentId);
        const storedTrace = persistTrace ? repository.recordRetrievalTrace(result.trace) : null;
        const reactivation = reactivate ? repository.applyRecallReactivation({
          agentId: this.agentId,
          traceId: storedTrace?.id || "",
          activationId: clean(activationId),
          memoryIds: result.status === 'ready' ? [...new Set([
            ...result.trace.selectedIds, ...(result.trace.metadata?.recalledMemoryIds || []),
          ])] : [],
          activatedAt: executionTime.toISOString(),
          policy: recallReactivationPolicy,
        }) : { status: "disabled", applied: 0, states: [] };
        return { storedTrace, reactivation };
      }));
      return {
        ...result,
        trace: {
          ...result.trace,
          ...(persisted.storedTrace ? { id: persisted.storedTrace.id } : {}),
          persisted: Boolean(persisted.storedTrace),
          reactivation: persisted.reactivation,
        },
      };
    }, { sourceScope, signal, readOnly: !persistTrace && !reactivate });
  }

  reactivateRecall({ activationId, memoryIds = [], options = {}, now = new Date(), sourceScope = null, signal = null } = {}) {
    const key = clean(activationId);
    if (!key) throw new Error("reactivateRecall requires a stable activationId.");
    const retrieval = { ...this.defaults.retrieval, ...options };
    const policy = normalizeRecallReactivationOptions(retrieval.recallReactivation);
    return this.withRepository(repository => {
      const view = executionEventSourceView(repository, this.agentId);
      const selectedIds = [...new Set(memoryIds.map(clean).filter(Boolean))].filter(id => {
        const node = repository.getMemory(id);
        return node?.agent_id === this.agentId && node.status === 'active' && (!view || view.allows(node));
      });
      return repository.applyRecallReactivation({ agentId: this.agentId, activationId: key,
        memoryIds: selectedIds, activatedAt: validDate(now, "recall activation now").toISOString(), policy });
    }, { sourceScope, signal });
  }

  syncEmbeddings(options = {}) {
    const embeddingProvider = options.embeddingProvider || this.providers.embedding;
    return this.withRepository((repository) => syncMemoryEmbeddings({
      ...options,
      repository,
      agentId: this.agentId,
      embeddingProvider,
      ledgerPath: clean(options.ledgerPath) || this.paths.usageLedgerPath,
    }), { sourceScope: options.sourceScope, signal: options.signal });
  }

  analyzePendingState({
    maxRequests = 10,
    generator = this.providers.generator,
    snapshotOptions = {},
    reviewVersion = "",
    preferencePolicy,
    sourceScope = null,
    signal = null,
  } = {}) {
    return this.withRepository((repository) => processPendingStateAnalysisRequests({
      repository,
      agentId: this.agentId,
      generator,
      maxRequests,
      usageLedgerPath: this.paths.usageLedgerPath,
      snapshotOptions,
      reviewVersion,
      preferencePolicy,
    }), { sourceScope, signal });
  }

  processConsolidation({
    maximumRuns = 3,
    generator = this.providers.structureGenerator,
    sourceScope = null,
    signal = null,
  } = {}) {
    return this.withRepository((repository) => processPlannedConsolidationRuns({
      repository,
      agentId: this.agentId,
      generator,
      maximumRuns,
      usageLedgerPath: this.paths.usageLedgerPath,
    }), { sourceScope, signal });
  }

  rebuildAssociationGraph(options = {}) {
    return this.withRepository((repository) => rebuildAssociationGraph({
      repository,
      agentId: this.agentId,
      options,
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
  importDatabaseAsAgent,
  inspectDatabaseBackup,
  restoreDatabaseBackup,
};
