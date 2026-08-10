function clean(value) {
  return String(value ?? "").trim();
}

function dashScopeHost(hostname) {
  const normalized = clean(hostname).toLowerCase();
  return normalized === "dashscope.aliyuncs.com"
    || normalized === "dashscope-intl.aliyuncs.com"
    || normalized === "dashscope-us.aliyuncs.com"
    || normalized.endsWith(".dashscope.aliyuncs.com");
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl, type = "") {
  const raw = clean(baseUrl).replace(/\/+$/u, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Provider API 地址必须是 HTTP(S) URL。");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Provider API 地址必须是 HTTP(S) URL。");
  }
  if (clean(type).toLowerCase() === "dashscope"
    && dashScopeHost(parsed.hostname)
    && /\/api\/v1$/u.test(parsed.pathname)) {
    parsed.pathname = "/compatible-mode/v1";
  }
  return parsed.toString().replace(/\/+$/u, "");
}

export function openAiCompatibleEndpoint(baseUrl, endpoint, type = "") {
  const base = normalizeOpenAiCompatibleBaseUrl(baseUrl, type);
  const suffix = clean(endpoint).replace(/^\/+|\/+$/gu, "");
  if (!suffix) return base;
  const parsed = new URL(base);
  if (parsed.pathname.endsWith(`/${suffix}`)) return parsed.toString();
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/${suffix}`;
  return parsed.toString();
}
