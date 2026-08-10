import { createOpenAiCompatibleEmbeddingProvider } from "@suzu-memory/providers";

function clean(value) {
  return String(value ?? "").trim();
}

export function selectedMemoryEmbeddingConnection(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    clean(value.key || value.apiKey)
    && clean(value.baseUrl)
    && clean(value.model || (clean(value.type).toLowerCase() === "dashscope" ? "text-embedding-v4" : "")),
  );
}

export function environmentMemoryEmbeddingConnection(environment = process.env) {
  const key = clean(environment.DASHSCOPE_API_KEY);
  if (!key) return null;
  return {
    type: "dashscope",
    provider: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    model: "text-embedding-v4",
    key,
  };
}

export function memoryEmbeddingProviderFromConnection(
  connection,
  embeddingProviderFactory = createOpenAiCompatibleEmbeddingProvider,
) {
  if (!selectedMemoryEmbeddingConnection(connection)) {
    throw new Error("memory-embedding 连接不完整。");
  }
  const type = clean(connection.type).toLowerCase();
  let baseUrl = clean(connection.baseUrl).replace(/\/+$/u, "");
  if (type === "dashscope") baseUrl = baseUrl.replace(/\/api\/v1$/u, "/compatible-mode/v1");
  const raw = embeddingProviderFactory({
    baseUrl,
    apiKey: clean(connection.key || connection.apiKey),
    model: clean(connection.model) || (type === "dashscope" ? "text-embedding-v4" : ""),
    dimensions: 1024,
    extraBody: { encoding_format: "float" },
  });
  const provider = async (text) => {
    const response = await raw(text);
    return {
      ...response,
      metadata: {
        ...response.metadata,
        provider: clean(connection.provider) || (type === "dashscope" ? "阿里云百炼" : "openai-compatible"),
      },
    };
  };
  if (typeof raw.embedMany === "function") {
    provider.embedMany = async (texts) => {
      const response = await raw.embedMany(texts);
      return {
        ...response,
        metadata: {
          ...response.metadata,
          provider: clean(connection.provider) || (type === "dashscope" ? "阿里云百炼" : "openai-compatible"),
        },
      };
    };
  }
  provider.model = raw.model;
  provider.dimensions = raw.dimensions;
  return provider;
}

export async function resolveMemoryEmbeddingConnection({
  connectionResolver = null,
  dataRoot = "",
  agentId = "",
  environment = process.env,
} = {}) {
  const resolved = typeof connectionResolver === "function"
    ? await connectionResolver({ kind: "memory-embedding", dataRoot, agentId })
    : environmentMemoryEmbeddingConnection(environment);
  if (!selectedMemoryEmbeddingConnection(resolved)) {
    throw new Error("memory-embedding 尚未配置；请在软件中绑定百炼 Embedding，或设置 DASHSCOPE_API_KEY。");
  }
  return resolved;
}
