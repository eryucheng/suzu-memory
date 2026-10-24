import fs from "node:fs";
import path from "node:path";

import {
  createOpenAiCompatibleEmbeddingProvider,
  createOpenAiCompatibleStructuredGenerator,
} from "@suzu-memory/providers";
import { WORLD_FRAMES } from "@suzu-memory/core";
import { createMemoryService } from "@suzu-memory/service";
import { DEFAULT_LENGTH_ARCHIVE_POLICY } from "@suzu-memory/ingestion";

function clean(value) {
  return String(value ?? "").trim();
}

function finiteInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return result;
}

function httpUrl(value, label, { required = true } = {}) {
  const text = clean(value).replace(/\/+$/u, "");
  if (!text && !required) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} must be an HTTP(S) URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must be an HTTP(S) URL.`);
  }
  return text;
}

function plainObject(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return { ...value };
}

const MINIMUM_SERVER_BODY_BYTES = 1024;
const DEFAULT_SERVER_BODY_BYTES = 1024 * 1024;
const MAXIMUM_SERVER_BODY_BYTES = 64 * 1024 * 1024;
const SERVER_BODY_JSON_HEADROOM_BYTES = 512 * 1024;

function defaultServerBodyBytes(maximumBatchCharacters) {
  return Math.min(
    MAXIMUM_SERVER_BODY_BYTES,
    Math.max(
      DEFAULT_SERVER_BODY_BYTES,
      (maximumBatchCharacters * 4) + SERVER_BODY_JSON_HEADROOM_BYTES,
    ),
  );
}

function normalizeProvider(value, kind) {
  if (value === undefined || value === null || value === false) return null;
  const input = plainObject(value, `providers.${kind}`);
  const type = clean(input.type || "openai-compatible").toLowerCase();
  if (!["openai-compatible", "dashscope"].includes(type)) {
    throw new Error(`providers.${kind}.type is not supported: ${type}.`);
  }
  const model = clean(input.model);
  if (!model) throw new Error(`providers.${kind}.model is required.`);
  const structuredOutputMode = clean(input.structuredOutputMode || "json-object").toLowerCase();
  if (!["json-object", "strict-tool"].includes(structuredOutputMode)) {
    throw new Error(`providers.${kind}.structuredOutputMode is not supported: ${structuredOutputMode}.`);
  }
  return Object.freeze({
    type,
    name: clean(input.name) || "OpenAI Compatible",
    baseUrl: httpUrl(input.baseUrl, `providers.${kind}.baseUrl`),
    endpoint: clean(input.endpoint),
    structuredOutputMode,
    model,
    apiKey: clean(input.apiKey),
    apiKeyEnv: clean(input.apiKeyEnv),
    timeoutMs: finiteInteger(
      input.timeoutMs,
      kind === "embedding" ? 30_000 : kind === "intervention" ? 30_000 : 180_000,
      1_000,
      600_000,
      `providers.${kind}.timeoutMs`,
    ),
    dimensions: finiteInteger(input.dimensions, 0, 0, 100_000, `providers.${kind}.dimensions`),
    maxOutputTokens: finiteInteger(
      input.maxOutputTokens,
      kind === "intervention" ? 512 : 8_192,
      256,
      64_000,
      `providers.${kind}.maxOutputTokens`,
    ),
    ...(kind === "embedding" ? {} : {
      maximumTransportAttempts: finiteInteger(
        input.maximumTransportAttempts,
        3,
        1,
        5,
        `providers.${kind}.maximumTransportAttempts`,
      ),
      transportRetryDelayMs: finiteInteger(
        input.transportRetryDelayMs,
        500,
        0,
        30_000,
        `providers.${kind}.transportRetryDelayMs`,
      ),
    }),
    extraHeaders: plainObject(input.extraHeaders, `providers.${kind}.extraHeaders`),
    extraBody: plainObject(input.extraBody, `providers.${kind}.extraBody`),
  });
}

function resolveOptionalPath(value, baseDirectory) {
  const text = clean(value);
  if (!text) return "";
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(baseDirectory, text);
}

export function normalizeMemoryConfig(value, {
  baseDirectory = process.cwd(),
  sourcePath = "",
} = {}) {
  const input = plainObject(value, "config");
  const version = finiteInteger(input.version, 1, 1, 1, "version");
  const providers = plainObject(input.providers, "providers");
  const server = plainObject(input.server, "server");
  const defaults = plainObject(input.defaults, "defaults");
  const ingestion = plainObject(defaults.ingestion, "defaults.ingestion");
  const generationProvider = normalizeProvider(providers.generation, "generation");
  const interventionProvider = Object.hasOwn(providers, "intervention")
    ? normalizeProvider(providers.intervention, "intervention")
    : generationProvider;
  const normalizedIngestion = Object.freeze({
    ...Object.fromEntries(Object.entries(DEFAULT_LENGTH_ARCHIVE_POLICY).map(([key, fallback]) => [
      key, finiteInteger(ingestion[key], fallback, 1, 10_000_000, `defaults.ingestion.${key}`),
    ])),
    maximumEventCharacters: finiteInteger(
      ingestion.maximumEventCharacters,
      12_000,
      1_000,
      1_000_000,
      "defaults.ingestion.maximumEventCharacters",
    ),
    maximumBatchCharacters: finiteInteger(
      ingestion.maximumBatchCharacters,
      48_000,
      1_000,
      10_000_000,
      "defaults.ingestion.maximumBatchCharacters",
    ),
    leaseSeconds: finiteInteger(
      ingestion.leaseSeconds,
      1800,
      60,
      86_400,
      "defaults.ingestion.leaseSeconds",
    ),
  });
  const normalized = {
    version,
    sourcePath: clean(sourcePath) ? path.resolve(sourcePath) : "",
    dataRoot: resolveOptionalPath(input.dataRoot, baseDirectory),
    projectRoot: resolveOptionalPath(input.projectRoot, baseDirectory),
    agentId: clean(input.agentId),
    databasePath: resolveOptionalPath(input.databasePath, baseDirectory),
    usageLedgerPath: resolveOptionalPath(input.usageLedgerPath, baseDirectory),
    defaults: Object.freeze({
      memoryOwner: clean(defaults.memoryOwner),
      userName: clean(defaults.userName),
      primaryUserId: clean(defaults.primaryUserId) || "user",
      companionId: clean(defaults.companionId) || clean(input.agentId),
      relationshipLabel: clean(defaults.relationshipLabel) || "关系",
      defaultWorldId: clean(defaults.defaultWorldId) || "relationship",
      defaultWorldFrame: clean(defaults.defaultWorldFrame) || "relational",
      ingestion: normalizedIngestion,
      retrieval: plainObject(defaults.retrieval, "defaults.retrieval"),
    }),
    providers: Object.freeze({
      generation: generationProvider,
      intervention: interventionProvider,
      embedding: normalizeProvider(providers.embedding, "embedding"),
    }),
    server: Object.freeze({
      host: clean(server.host) || "127.0.0.1",
      port: finiteInteger(server.port, 37779, 0, 65535, "server.port"),
      apiKeyEnv: clean(server.apiKeyEnv) || "SUZU_MEMORY_API_KEY",
      maxBodyBytes: finiteInteger(
        server.maxBodyBytes,
        defaultServerBodyBytes(normalizedIngestion.maximumBatchCharacters),
        MINIMUM_SERVER_BODY_BYTES,
        MAXIMUM_SERVER_BODY_BYTES,
        "server.maxBodyBytes",
      ),
    }),
  };
  if (!normalized.agentId && !normalized.projectRoot) {
    throw new Error("Config requires agentId or projectRoot.");
  }
  if (normalized.defaults.ingestion.maximumEventCharacters
    > normalized.defaults.ingestion.maximumBatchCharacters) {
    throw new Error("defaults.ingestion.maximumEventCharacters cannot exceed maximumBatchCharacters.");
  }
  if (!WORLD_FRAMES.includes(normalized.defaults.defaultWorldFrame)) {
    throw new Error("defaults.defaultWorldFrame is not supported.");
  }
  return Object.freeze(normalized);
}

export function loadMemoryConfig(configPath, options = {}) {
  const selected = clean(configPath);
  if (!selected) throw new Error("A Suzu Memory config path is required.");
  const resolved = path.resolve(selected);
  let value;
  try {
    const text = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/u, "");
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot read Suzu Memory config ${resolved}: ${error.message}`);
  }
  return normalizeMemoryConfig(value, {
    ...options,
    baseDirectory: path.dirname(resolved),
    sourcePath: resolved,
  });
}

function secret(provider, environment, label) {
  if (!provider) return "";
  const value = clean(provider.apiKey)
    || (provider.apiKeyEnv ? clean(environment[provider.apiKeyEnv]) : "");
  if (!value) {
    const hint = provider.apiKeyEnv ? ` Set ${provider.apiKeyEnv}.` : "";
    throw new Error(`${label} API key is not configured.${hint}`);
  }
  return value;
}

export function validateMemoryProviderConfig(config, {
  environment = process.env, requireGeneration = false, embedding = true,
} = {}) {
  if (requireGeneration && !config.providers.generation) throw new Error("Generation provider is required.");
  for (const kind of ["generation", ...(embedding ? ["embedding"] : [])]) {
    if (config.providers[kind]) secret(config.providers[kind], environment, kind);
  }
  return { generation: Boolean(config.providers.generation), embedding: embedding && Boolean(config.providers.embedding) };
}

export function createProvidersFromMemoryConfig(config, {
  environment = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const generationConfig = config.providers.generation;
  const interventionConfig = config.providers.intervention;
  const embeddingConfig = config.providers.embedding;
  let resolvedGenerator = null;
  const generator = generationConfig ? async (request) => {
    resolvedGenerator ||= createOpenAiCompatibleStructuredGenerator({
      connection: {
        ...generationConfig,
        apiKey: secret(generationConfig, environment, "Generation"),
      },
      fetchImpl,
      timeoutMs: generationConfig.timeoutMs,
      maxOutputTokens: generationConfig.maxOutputTokens,
    });
    return resolvedGenerator(request);
  } : null;
  if (generator) {
    generator.supportsCombinedStateAnalysis = true;
    generator.supportsCombinedConsolidation = true;
  }
  let resolvedInterventionGenerator = null;
  const interventionGenerator = interventionConfig === generationConfig
    ? generator
    : interventionConfig ? async (request) => {
      resolvedInterventionGenerator ||= createOpenAiCompatibleStructuredGenerator({
        connection: {
          ...interventionConfig,
          apiKey: secret(interventionConfig, environment, "Intervention"),
        },
        fetchImpl,
        timeoutMs: interventionConfig.timeoutMs,
        maxOutputTokens: interventionConfig.maxOutputTokens,
      });
      return resolvedInterventionGenerator(request);
    } : null;
  let resolvedEmbedding = null;
  function embeddingProvider() {
    resolvedEmbedding ||= createOpenAiCompatibleEmbeddingProvider({
      baseUrl: embeddingConfig.baseUrl,
      type: embeddingConfig.type,
      endpoint: embeddingConfig.endpoint || "embeddings",
      apiKey: secret(embeddingConfig, environment, "Embedding"),
      model: embeddingConfig.model,
      dimensions: embeddingConfig.dimensions,
      timeoutMs: embeddingConfig.timeoutMs,
      extraHeaders: embeddingConfig.extraHeaders,
      extraBody: embeddingConfig.extraBody,
      fetchImplementation: fetchImpl,
    });
    return resolvedEmbedding;
  }
  const embedding = embeddingConfig ? async (text) => embeddingProvider()(text) : null;
  if (embedding) {
    embedding.embedMany = async (texts) => embeddingProvider().embedMany(texts);
    embedding.model = embeddingConfig.model;
    embedding.dimensions = embeddingConfig.dimensions;
  }
  return Object.freeze({
    generator,
    interventionGenerator,
    structureGenerator: generator,
    retrievalContextGenerator: generator,
    embedding,
  });
}

export function createMemoryServiceFromConfig(configOrPath, {
  environment = process.env,
  fetchImpl = globalThis.fetch,
  overrides = {},
} = {}) {
  const config = typeof configOrPath === "string"
    ? loadMemoryConfig(configOrPath)
    : normalizeMemoryConfig(configOrPath, { baseDirectory: process.cwd() });
  const providers = createProvidersFromMemoryConfig(config, { environment, fetchImpl });
  const selectedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  const instanceDefaults = selectedOverrides.defaults || {};
  const isolatedPaths = selectedOverrides.dataRoot ? {
    projectRoot: "", databasePath: "", usageLedgerPath: "",
  } : {};
  return createMemoryService({
    dataRoot: config.dataRoot,
    projectRoot: config.projectRoot,
    agentId: config.agentId,
    databasePath: config.databasePath,
    usageLedgerPath: config.usageLedgerPath,
    defaults: config.defaults,
    providers,
    ...isolatedPaths,
    ...selectedOverrides,
    defaults: {
      ...config.defaults, ...instanceDefaults,
      ingestion: { ...config.defaults.ingestion, ...instanceDefaults.ingestion },
      retrieval: { ...config.defaults.retrieval, ...instanceDefaults.retrieval },
    },
  });
}
