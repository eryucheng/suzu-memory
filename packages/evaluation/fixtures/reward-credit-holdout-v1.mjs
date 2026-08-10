const LIMITS = Object.freeze({
  maximumConsolidationDelta: 0.04,
  maximumUtilityDelta: 0.08,
});

const MUST_NOT_CHANGE = Object.freeze([
  "content",
  "subject",
  "confidence",
  "base_edge_weight",
]);

const SURFACES = Object.freeze([
  {
    id: "quiet-restaurant",
    kind: "preference_state",
    layer: "reported",
    title: "安静餐厅偏好",
    content: "用户明确说过，和熟人吃饭时更喜欢安静、可以慢慢说话的餐厅。",
    query: "今晚想找个地方吃饭，不想周围太吵。",
    response: "你以前明确说过更喜欢安静、能慢慢聊天的餐厅，可以先按环境筛选。",
    reference: "更喜欢安静餐厅的偏好",
    outcome: "吃饭时周围很安静，整晚都很放松",
    failure: "到店后还是吵得没法说话",
    external: "朋友临时把聚餐改成在家做饭；我没按你想起的偏好选店，晚上也很安静",
  },
  {
    id: "train-transfer",
    kind: "event",
    layer: "episodic",
    title: "火车站换乘路线",
    content: "用户上次在同一车站从北广场进站，走地下通道换乘，赶上了末班车。",
    query: "我又要在那个车站换乘，时间只有十五分钟。",
    response: "上次你从北广场进站后走地下通道赶上了车，这次可以优先沿那条路线。",
    reference: "上次从北广场走地下通道的路线",
    outcome: "最后顺利赶上了车",
    failure: "最后还是没赶上车",
    external: "列车临时晚点二十分钟；我没走你说的路线也赶上了",
  },
  {
    id: "apology-message",
    kind: "event",
    layer: "episodic",
    title: "道歉信息的写法",
    content: "用户上次和朋友有误会时，先直接承认影响，再解释原因，对方愿意继续沟通。",
    query: "我想给朋友道歉，但越写越像在为自己辩解。",
    response: "你上次先承认给对方造成的影响，再解释原因，沟通才继续下去；可以先保留这个顺序。",
    reference: "上次先承认影响再解释的顺序",
    outcome: "对方看完后愿意继续沟通",
    failure: "对方看完后反而更生气了",
    external: "对方先主动发来和解消息；我还没采用那个写法，误会就已经缓和了",
  },
  {
    id: "focus-session",
    kind: "habit_state",
    layer: "reported",
    title: "专注工作的分段方法",
    content: "用户明确记录过，先写二十五分钟再休息五分钟，比较容易完成长文的第一版。",
    query: "这份长文我一直拖着，今晚怎么开始比较好？",
    response: "你以前记录过二十五分钟写作加五分钟休息更容易启动，可以先只做第一轮。",
    reference: "二十五分钟写作再休息的分段方法",
    outcome: "今晚写完了第一版提纲",
    failure: "折腾一晚还是一个字都没写出来",
    external: "临时会议取消后多出了整晚时间；我没用分段方法也写完了提纲",
  },
  {
    id: "packing-list",
    kind: "plan_state",
    layer: "reported",
    title: "短途出门清单",
    content: "用户上次短途出门前按证件、充电、钥匙三个类别检查，没有漏带必需品。",
    query: "明早要很早出门，我怕又漏东西。",
    response: "你上次按证件、充电和钥匙三类检查没有漏带，可以照那个顺序快速过一遍。",
    reference: "按证件、充电和钥匙分类的清单",
    outcome: "出门后没有发现漏带东西",
    failure: "到了车站才发现还是漏带了充电器",
    external: "同行的人额外带了一套充电设备；我没按那份清单准备也没有耽误",
  },
  {
    id: "shared-movie",
    kind: "relationship_state",
    layer: "reported",
    title: "一起看片时避开剧透",
    content: "用户明确说过，一起挑电影时不想先看包含关键剧情的长预告，更愿意只看题材和时长。",
    query: "今晚一起挑部电影吧，怎么筛快一点？",
    response: "你说过不想被长预告剧透，我们可以只看题材和时长，再从剩下的里面选。",
    reference: "一起挑片时避开长预告的约定",
    outcome: "最后挑到了一部都愿意看的电影，也没有提前看到剧透",
    failure: "筛了半天还是没选出来，还被预告剧透了",
    external: "平台临时送来一份不含预告的片单；我们没用原来的筛选办法也挑到了电影",
  },
]);

function memory(id, title, content, { kind = "event", layer = "episodic" } = {}) {
  return {
    id,
    kind,
    layer,
    title,
    content,
    subjectRole: "user",
    subjectKey: "user",
  };
}

function edge(id, fromMemoryId, toMemoryId) {
  return {
    id,
    fromMemoryId,
    toMemoryId,
    relation: "associated_with",
    direction: "directed",
    weight: 0.8,
  };
}

function pathFor(memoryId, itemEdge) {
  return {
    memoryId,
    score: 0.8,
    sourceCount: 1,
    seedContributions: [{ seedMemoryId: itemEdge.fromMemoryId, score: 0.8 }],
    edges: [{
      edgeId: itemEdge.id,
      relation: itemEdge.relation,
      traversalFromMemoryId: itemEdge.fromMemoryId,
      traversalToMemoryId: itemEdge.toMemoryId,
      relationView: "associative",
    }],
  };
}

function memoryCredit(memoryId, contributionClass, contributionShare, status, direction) {
  return { memoryId, contributionClass, contributionShare, status, direction };
}

function pathCredit(edgeId, status, direction) {
  return { edgeId, status, direction };
}

function commonExpected(values) {
  return {
    ...values,
    mustNotChange: MUST_NOT_CHANGE,
    limits: LIMITS,
  };
}

function simpleCase(surface, family) {
  const caseId = `${family.id}-${surface.id}`;
  const seedId = `${caseId}-seed`;
  const targetId = `${caseId}-target`;
  const itemEdge = edge(`${caseId}-edge`, seedId, targetId);
  return {
    caseId,
    category: family.category,
    scenarioId: surface.id,
    scenario: {
      memories: [
        memory(seedId, "当前对话线索", `当前对话正在处理${surface.title}。`),
        memory(targetId, surface.title, surface.content, surface),
      ],
      edges: [itemEdge],
      query: surface.query,
      recallIntent: "companion-assistance",
      assistantResponse: surface.response,
      usedMemoryIds: [targetId],
      seedIds: [seedId],
      selectedIds: [targetId],
      paths: [pathFor(targetId, itemEdge)],
      followUp: family.followUp(surface),
      feedbackBinding: family.feedbackBinding || "immediate-next-user-input",
      delayDays: Math.max(0, Number(family.delayDays || 0)),
    },
    expected: commonExpected({
      outcomeClass: family.outcomeClass,
      evidenceTier: family.evidenceTier,
      feedbackTarget: family.feedbackTarget,
      targetMemoryIds: family.targeted ? [targetId] : [],
      memoryCredits: [memoryCredit(
        targetId,
        family.contributionClass,
        family.contributionShare,
        family.status,
        family.direction,
      )],
      pathCredits: [pathCredit(itemEdge.id, family.status, family.direction)],
    }),
  };
}

function multiMemoryCase(surface) {
  const caseId = `multi-memory-${surface.id}`;
  const seedId = `${caseId}-seed`;
  const firstId = `${caseId}-first`;
  const secondId = `${caseId}-second`;
  const firstEdge = edge(`${caseId}-edge-first`, seedId, firstId);
  const secondEdge = edge(`${caseId}-edge-second`, seedId, secondId);
  return {
    caseId,
    category: "multi_memory_partial",
    scenarioId: surface.id,
    scenario: {
      memories: [
        memory(seedId, "当前对话线索", `当前对话正在处理${surface.title}。`),
        memory(firstId, surface.title, surface.content, surface),
        memory(secondId, "执行前确认", "用户以前明确说过，开始行动前先确认当下条件是否仍与旧经历一致。"),
      ],
      edges: [firstEdge, secondEdge],
      query: surface.query,
      recallIntent: "companion-assistance",
      assistantResponse: `${surface.response} 开始前也确认一下现在的条件有没有变化。`,
      usedMemoryIds: [firstId, secondId],
      seedIds: [seedId],
      selectedIds: [firstId, secondId],
      paths: [pathFor(firstId, firstEdge), pathFor(secondId, secondEdge)],
      followUp: `我同时用了“${surface.reference}”和你提醒的当下条件检查，两部分都起了作用，${surface.outcome}。`,
    },
    expected: commonExpected({
      outcomeClass: "successful_outcome",
      evidenceTier: "explicit_attribution",
      feedbackTarget: "retrieved_memory",
      targetMemoryIds: [firstId, secondId],
      memoryCredits: [
        memoryCredit(firstId, "partial", 0.5, "eligible", "increase"),
        memoryCredit(secondId, "partial", 0.5, "eligible", "increase"),
      ],
      pathCredits: [
        pathCredit(firstEdge.id, "eligible", "increase"),
        pathCredit(secondEdge.id, "eligible", "increase"),
      ],
    }),
  };
}

function highFanoutCase(surface) {
  const caseId = `high-fanout-${surface.id}`;
  const seedId = `${caseId}-seed`;
  const targetId = `${caseId}-target`;
  const noiseAId = `${caseId}-noise-a`;
  const noiseBId = `${caseId}-noise-b`;
  const targetEdge = edge(`${caseId}-edge-target`, seedId, targetId);
  const noiseAEdge = edge(`${caseId}-edge-noise-a`, seedId, noiseAId);
  const noiseBEdge = edge(`${caseId}-edge-noise-b`, seedId, noiseBId);
  return {
    caseId,
    category: "high_fanout_isolation",
    scenarioId: surface.id,
    scenario: {
      memories: [
        memory(seedId, "高连接对话主题", `与${surface.title}有关的当前主题。`),
        memory(targetId, surface.title, surface.content, surface),
        memory(noiseAId, "同主题旧闲聊", "用户以前聊过相似主题，但这条没有提供本次采用的事实或方法。"),
        memory(noiseBId, "同主题旧浏览", "用户以前看过相似内容，但这条没有形成当前结论。"),
      ],
      edges: [targetEdge, noiseAEdge, noiseBEdge],
      query: surface.query,
      recallIntent: "companion-assistance",
      assistantResponse: `${surface.response} 另外还有两段同主题背景。`,
      usedMemoryIds: [targetId, noiseAId, noiseBId],
      seedIds: [seedId],
      selectedIds: [targetId, noiseAId, noiseBId],
      paths: [
        pathFor(targetId, targetEdge),
        pathFor(noiseAId, noiseAEdge),
        pathFor(noiseBId, noiseBEdge),
      ],
      followUp: `我是在评价三段记忆：只有“${surface.reference}”帮助了我，${surface.outcome}；另外两段旧背景都没有作用。`,
    },
    expected: commonExpected({
      outcomeClass: "successful_outcome",
      evidenceTier: "explicit_attribution",
      feedbackTarget: "retrieved_memory",
      targetMemoryIds: [targetId, noiseAId, noiseBId],
      memoryCredits: [
        memoryCredit(targetId, "direct", 1, "eligible", "increase"),
        memoryCredit(noiseAId, "none", 0, "blocked", "hold"),
        memoryCredit(noiseBId, "none", 0, "blocked", "hold"),
      ],
      pathCredits: [
        pathCredit(targetEdge.id, "eligible", "increase"),
        pathCredit(noiseAEdge.id, "blocked", "hold"),
        pathCredit(noiseBEdge.id, "blocked", "hold"),
      ],
    }),
  };
}

const SIMPLE_FAMILIES = Object.freeze([
  {
    id: "explicit-help",
    category: "explicit_help",
    outcomeClass: "explicit_help",
    evidenceTier: "explicit_attribution",
    feedbackTarget: "retrieved_memory",
    targeted: true,
    contributionClass: "direct",
    contributionShare: 1,
    status: "eligible",
    direction: "increase",
    followUp: (value) => `你把“${value.reference}”想起来后，我一下知道下一步该怎么处理了；我还没有实际去做。`,
  },
  {
    id: "successful-outcome",
    category: "successful_outcome",
    outcomeClass: "successful_outcome",
    evidenceTier: "explicit_attribution",
    feedbackTarget: "retrieved_memory",
    targeted: true,
    contributionClass: "direct",
    contributionShare: 1,
    status: "eligible",
    direction: "increase",
    followUp: (value) => `我确实采用了“${value.reference}”，而且事情已经完成：${value.outcome}。`,
  },
  {
    id: "adoption-pending",
    category: "adoption_pending",
    outcomeClass: "adoption_pending",
    evidenceTier: "none",
    feedbackTarget: "retrieved_memory",
    targeted: true,
    contributionClass: "uncertain",
    contributionShare: 0,
    status: "pending",
    direction: "hold",
    followUp: (value) => `我决定等会照“${value.reference}”做，但现在还没有任何结果。`,
  },
  {
    id: "social-affect",
    category: "social_affect",
    outcomeClass: "social_affect",
    evidenceTier: "none",
    feedbackTarget: "relationship_affect",
    targeted: false,
    contributionClass: "none",
    contributionShare: 0,
    status: "blocked",
    direction: "hold",
    followUp: () => "先抱一下，和你待在一起让我安心。",
  },
  {
    id: "correction",
    category: "correction",
    outcomeClass: "correction",
    evidenceTier: "explicit_attribution",
    feedbackTarget: "retrieved_memory",
    targeted: true,
    contributionClass: "direct",
    contributionShare: 1,
    status: "blocked",
    direction: "hold",
    followUp: (value) => `这段记忆的主体错了：“${value.reference}”是我朋友的经历，不是我的。`,
  },
  {
    id: "failed-outcome",
    category: "failed_outcome",
    outcomeClass: "failed_outcome",
    evidenceTier: "explicit_attribution",
    feedbackTarget: "retrieved_memory",
    targeted: true,
    contributionClass: "direct",
    contributionShare: 1,
    status: "eligible",
    direction: "decrease",
    followUp: (value) => `我采用了“${value.reference}”，结果没有奏效：${value.failure}。`,
  },
  {
    id: "no-result",
    category: "no_result",
    outcomeClass: "no_result",
    evidenceTier: "none",
    feedbackTarget: "uncertain",
    targeted: false,
    contributionClass: "none",
    contributionShare: 0,
    status: "blocked",
    direction: "hold",
    followUp: () => "收到，先放在这里吧，我之后再说。",
  },
  {
    id: "answer-content",
    category: "answer_content",
    outcomeClass: "no_result",
    evidenceTier: "none",
    feedbackTarget: "answer_content",
    targeted: false,
    contributionClass: "none",
    contributionShare: 0,
    status: "blocked",
    direction: "hold",
    followUp: () => "这个回答的内容正好覆盖了我问的重点，不过我还没有开始行动。",
  },
  {
    id: "external-event",
    category: "external_event",
    outcomeClass: "no_result",
    evidenceTier: "none",
    feedbackTarget: "external_event",
    targeted: false,
    contributionClass: "none",
    contributionShare: 0,
    status: "blocked",
    direction: "hold",
    followUp: (value) => `结果来自另一件外部事情：${value.external}。这不能算你刚才想起的记忆起了作用。`,
  },
  {
    id: "uncertain-attribution",
    category: "uncertain",
    outcomeClass: "uncertain",
    evidenceTier: "uncertain",
    feedbackTarget: "retrieved_memory",
    targeted: true,
    contributionClass: "uncertain",
    contributionShare: 0,
    status: "pending",
    direction: "hold",
    followUp: (value) => `我只能确定“${value.reference}”可能参与了结果，但也可能完全是巧合，现在无法判断。`,
  },
  {
    id: "delayed-explicit-success",
    category: "delayed_explicit_success",
    outcomeClass: "successful_outcome",
    evidenceTier: "explicit_attribution",
    feedbackTarget: "retrieved_memory",
    targeted: true,
    contributionClass: "direct",
    contributionShare: 1,
    status: "eligible",
    direction: "increase",
    feedbackBinding: "explicit-usage-request",
    delayDays: 7,
    followUp: (value) => `一周后回来确认：我采用的就是“${value.reference}”，结果是${value.outcome}。`,
  },
  {
    id: "superseded-state-correction",
    category: "superseded_state",
    outcomeClass: "correction",
    evidenceTier: "explicit_attribution",
    feedbackTarget: "retrieved_memory",
    targeted: true,
    contributionClass: "direct",
    contributionShare: 1,
    status: "blocked",
    direction: "hold",
    followUp: (value) => `“${value.reference}”只代表以前；我已经明确改变了做法，不能继续当成当前状态。`,
  },
]);

const cases = SURFACES.flatMap((surface) => [
  ...SIMPLE_FAMILIES.map((family) => simpleCase(surface, family)),
  multiMemoryCase(surface),
  highFanoutCase(surface),
]);

export const REWARD_CREDIT_HOLDOUT_V1 = Object.freeze({
  version: "suzu-reward-credit-holdout-v1-rc1",
  license: "CC-BY-4.0",
  synthetic: true,
  intendedUse: "unseen-holdout",
  description: "84条完全原创、完全虚构、覆盖六类陪伴记忆表面的奖励归因留出案例。",
  cases: Object.freeze(cases),
});

export function loadRewardCreditHoldoutV1() {
  return REWARD_CREDIT_HOLDOUT_V1;
}
