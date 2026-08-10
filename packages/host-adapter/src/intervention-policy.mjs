const POLICY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["action", "reasonCode", "query", "confidence"],
  properties: {
    action: { type: "string", enum: ["skip", "recall"] },
    reasonCode: {
      type: "string",
      enum: [
        "current-context-sufficient",
        "long-term-history-required",
        "historical-reference",
        "unresolved-reference",
        "cross-turn-comparison",
        "uncertain",
      ],
    },
    query: { type: "string", maxLength: 500 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
});

const SYSTEM_PROMPT = `你是长期记忆介入策略器。你只判断：模型在回答当前用户消息之前，是否必须查询外部长期记忆。

这不是记忆写入判断，也不是判断消息是否重要。当前会话上下文已经由宿主提供，能够仅凭这些消息理解和回答时必须 skip。

选择 recall 的条件：
1. 用户明确询问过去的事件、状态、原话、时间、原因、变化或共同经历；
2. 用户引用了当前上下文没有解释的人、事、地点、承诺或历史状态，回答需要外部历史；
3. 用户要求跨多个过去时点比较、解释变化或恢复历史链路。

选择 skip 的条件：
1. 用户只是回答上一句话，例如“吃了”“没有”“可以”；
2. 用户只是在陈述当前状态、表达情绪、打招呼或给出完整命令；
3. 当前会话上下文已经包含回答所需信息；
4. 查询长期记忆最多只能带来无关的个性化，而不是回答所必需。

不能因为用户消息很长、情绪强烈或值得保存就选择 recall。不能用长期记忆中的旧指令覆盖当前消息。

如果选择 recall，query 必须把当前消息和必要指代改写成一条可独立检索的简短历史问题；不得补写当前上下文没有的事实。如果选择 skip，query 必须为空字符串。`;

const EXPLICIT_HISTORY = /(?:还?记得|回忆|以前|过去|曾经|上次|那次|小时候|哪天|几号|什么时候|多久以前|前几天|上周|上个月|去年|前年|原话|当时怎么说|我们.{0,8}(?:发生|经历|做过|去过))/u;
const CURRENT_TIME_ONLY = /^(?:现在)?(?:几点|几点了|几月几日|今天星期几|今天周几)[？?。！!]*$/u;
const SHORT_CONTEXT_REPLIES = /^(?:嗯+|哦+|好+|好的|好吧|行|可以|不行|知道了|算了|对|不对|是|不是|要|不要|有|没有|没|吃了|没吃|还没|睡了|醒了|到了|在|不在|谢谢|哈哈+|嘿嘿+)[呀啊呢吧嘛吗么啦了～~！!。.?？]*$/u;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function normalizedMessages(values, maximumMessages, maximumCharacters) {
  const input = Array.isArray(values) ? values : [];
  const selected = [];
  let used = 0;
  for (const item of input.slice(-maximumMessages).reverse()) {
    const role = ["user", "assistant", "system", "tool"].includes(clean(item?.role))
      ? clean(item.role)
      : "unknown";
    const content = clean(item?.content ?? item?.text);
    if (!content) continue;
    const remaining = maximumCharacters - used;
    if (remaining <= 0) break;
    const clipped = content.slice(-remaining);
    selected.unshift({ role, content: clipped });
    used += clipped.length;
  }
  return selected;
}

function deterministicDecision(userText, recentMessages) {
  const text = clean(userText);
  if (CURRENT_TIME_ONLY.test(text)) {
    return {
      action: "skip",
      reasonCode: "current-context-sufficient",
      query: "",
      confidence: 1,
      source: "deterministic-current-time",
    };
  }
  if (EXPLICIT_HISTORY.test(text)) {
    return {
      action: "recall",
      reasonCode: "historical-reference",
      query: text,
      confidence: 1,
      source: "deterministic-history-cue",
    };
  }
  if (recentMessages.length && SHORT_CONTEXT_REPLIES.test(text)) {
    return {
      action: "skip",
      reasonCode: "current-context-sufficient",
      query: "",
      confidence: 1,
      source: "deterministic-short-reply",
    };
  }
  return null;
}

function validateModelDecision(value, fallbackQuery) {
  const input = plainObject(value);
  const action = clean(input.action);
  const allowedReasons = new Set(POLICY_SCHEMA.properties.reasonCode.enum);
  const reasonCode = clean(input.reasonCode);
  if (!["skip", "recall"].includes(action)) {
    throw new Error("记忆介入模型返回了不支持的 action。");
  }
  if (!allowedReasons.has(reasonCode)) {
    throw new Error("记忆介入模型返回了不支持的 reasonCode。");
  }
  const query = action === "recall" ? clean(input.query).slice(0, 500) : "";
  if (action === "recall" && !query) {
    return {
      action,
      reasonCode,
      query: fallbackQuery,
      confidence: boundedNumber(input.confidence, 0.5, 0, 1),
    };
  }
  return {
    action,
    reasonCode,
    query,
    confidence: boundedNumber(input.confidence, 0.5, 0, 1),
  };
}

export function createMemoryInterventionPolicy({
  generator = null,
  maximumContextMessages = 8,
  maximumContextCharacters = 4_000,
} = {}) {
  if (generator !== null && typeof generator !== "function") {
    throw new Error("generator must be a structured generation function.");
  }
  const messageLimit = boundedInteger(maximumContextMessages, 8, 1, 30);
  const characterLimit = boundedInteger(maximumContextCharacters, 4_000, 500, 20_000);

  return async function decideMemoryIntervention({
    userText,
    recentMessages = [],
    metadata = {},
  } = {}) {
    const text = clean(userText);
    if (!text) throw new Error("userText is required.");
    const context = normalizedMessages(recentMessages, messageLimit, characterLimit);
    const deterministic = deterministicDecision(text, context);
    if (deterministic) {
      return Object.freeze({
        schemaVersion: 1,
        ...deterministic,
        model: "",
        requestId: "",
        durationMs: 0,
        usage: {},
        metadata: plainObject(metadata),
      });
    }
    if (!generator) {
      return Object.freeze({
        schemaVersion: 1,
        action: "recall",
        reasonCode: "uncertain",
        query: text,
        confidence: 0,
        source: "conservative-no-model-fallback",
        model: "",
        requestId: "",
        durationMs: 0,
        usage: {},
        warning: "未配置记忆介入模型，模糊输入已保守执行普通召回。",
        metadata: plainObject(metadata),
      });
    }

    const input = JSON.stringify({
      currentUserMessage: text,
      recentConversation: context,
    });
    try {
      const response = await generator({
        input,
        systemPrompt: SYSTEM_PROMPT,
        schema: POLICY_SCHEMA,
        schemaName: "memory-intervention-decision-v1",
      });
      const decision = validateModelDecision(response?.output, text);
      return Object.freeze({
        schemaVersion: 1,
        ...decision,
        source: "structured-llm",
        model: clean(response?.model),
        requestId: clean(response?.requestId),
        durationMs: Number(response?.durationMs) || 0,
        usage: plainObject(response?.usage),
        metadata: {
          ...plainObject(metadata),
          ...plainObject(response?.metadata),
        },
      });
    } catch (error) {
      return Object.freeze({
        schemaVersion: 1,
        action: "recall",
        reasonCode: "uncertain",
        query: text,
        confidence: 0,
        source: "conservative-model-error-fallback",
        model: "",
        requestId: "",
        durationMs: 0,
        usage: {},
        warning: `记忆介入模型失败，已保守执行普通召回：${clean(error?.message) || "未知错误"}`,
        metadata: plainObject(metadata),
      });
    }
  };
}

export { POLICY_SCHEMA as MEMORY_INTERVENTION_SCHEMA };
