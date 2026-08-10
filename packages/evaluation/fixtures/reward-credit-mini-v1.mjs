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

const SCENARIOS = Object.freeze([
  {
    id: "puzzle",
    title: "旧机关谜题",
    content: "用户以前解机关谜题时，用排除法先排除了互相矛盾的开关。",
    query: "这道机关谜题卡住了，应该从哪里开始？",
    response: "你上次解机关题时用过排除法，可以先找互相矛盾的条件。",
    reference: "上次机关题的排除法",
    outcome: "这道谜题顺利解开了",
    failure: "机关还是没有打开",
  },
  {
    id: "museum",
    title: "科技馆参观路线",
    content: "用户上次去科技馆时，先看闭馆较早的航天厅，再参观常设展厅。",
    query: "今天去科技馆时间不多，先去哪里比较好？",
    response: "你上次先看闭馆较早的航天厅，这次也可以沿用这个顺序。",
    reference: "上次科技馆先去航天厅的路线",
    outcome: "闭馆前想看的展厅都看完了",
    failure: "还是错过了最想看的展厅",
  },
  {
    id: "noodles",
    title: "煮面加蛋的方法",
    content: "用户以前煮面时先调成小火，再沿锅边加入鸡蛋，面和蛋没有煮散。",
    query: "煮面的时候怎么加蛋才不容易散？",
    response: "你上次是先调小火再沿锅边加蛋，那个办法可以继续用。",
    reference: "上次先调小火再加蛋的方法",
    outcome: "这次面和蛋都没有煮散",
    failure: "鸡蛋还是散开了",
  },
  {
    id: "commute",
    title: "避开施工路段的换乘",
    content: "用户上次通勤时避开施工路段，提前一站换乘地铁后准时到达。",
    query: "今天那条路又施工了，怎么走比较稳？",
    response: "你上次提前一站换乘地铁避开了施工路段，可以按那条路线走。",
    reference: "上次提前一站换乘的路线",
    outcome: "最后准时到了",
    failure: "最后还是迟到了",
  },
  {
    id: "file-recovery",
    title: "损坏文件恢复步骤",
    content: "用户以前修复损坏文件时，先复制副本，再在副本上尝试恢复。",
    query: "这个文件打不开了，我现在先做什么？",
    response: "你上次先复制副本再修复，避免了二次损坏，这次也先备份。",
    reference: "上次先复制副本再修复的步骤",
    outcome: "文件已经恢复了",
    failure: "文件仍然打不开",
  },
  {
    id: "interview",
    title: "面试回答结构",
    content: "用户上次面试时先说结论，再补充过程和证据，回答更清楚。",
    query: "这道面试题我总是越答越乱，怎么办？",
    response: "你上次先讲结论再补过程，结构更清楚，可以继续这样答。",
    reference: "上次先讲结论再补过程的结构",
    outcome: "这次面试题答得很顺",
    failure: "回答还是讲乱了",
  },
  {
    id: "alarms",
    title: "两个闹钟的提醒方法",
    content: "用户以前把起床提醒拆成相隔五分钟的两个闹钟，避免了睡过头。",
    query: "明早特别早，我怕自己睡过头。",
    response: "你上次用两个相隔五分钟的闹钟比较稳，这次可以继续这样设。",
    reference: "上次设置两个闹钟的方法",
    outcome: "早上按时起来了",
    failure: "早上还是睡过头了",
  },
  {
    id: "camera",
    title: "摄像头占用排查",
    content: "用户以前先关闭占用摄像头的程序，再重新打开目标应用，摄像头恢复。",
    query: "摄像头又打不开了，先检查什么？",
    response: "你上次先释放摄像头占用再重开应用，这次也先检查占用。",
    reference: "上次先释放摄像头占用的排查顺序",
    outcome: "摄像头已经恢复了",
    failure: "摄像头仍然没有画面",
  },
  {
    id: "plant",
    title: "绿植浇水判断",
    content: "用户以前先检查盆土湿度，再决定是否浇水，避免了重复浇水。",
    query: "叶子有点黄，我是不是应该马上浇水？",
    response: "你上次先检查盆土再决定是否浇水，这次也先确认土壤湿度。",
    reference: "上次先检查盆土再浇水的方法",
    outcome: "叶子没有继续发黄",
    failure: "叶子还是继续发黄",
  },
  {
    id: "presentation",
    title: "汇报开场压缩",
    content: "用户以前把汇报开场压缩成一句结论，把时间留给核心内容。",
    query: "这次汇报只有五分钟，开场怎么处理？",
    response: "你上次把开场压成一句结论后没有超时，这次也可以这样安排。",
    reference: "上次把开场压成一句结论的方法",
    outcome: "这次汇报没有超时",
    failure: "这次汇报还是超时了",
  },
]);

function memory(id, title, content) {
  return {
    id,
    kind: "event",
    layer: "episodic",
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

function path(memoryId, edges) {
  return {
    memoryId,
    score: 0.8,
    sourceCount: 1,
    seedContributions: [{ seedMemoryId: edges[0].fromMemoryId, score: 0.8 }],
    edges: edges.map((item) => ({
      edgeId: item.id,
      relation: item.relation,
      traversalFromMemoryId: item.fromMemoryId,
      traversalToMemoryId: item.toMemoryId,
      relationView: "associative",
    })),
  };
}

function expectedCredit(memoryId, contributionClass, contributionShare, status, direction) {
  return { memoryId, contributionClass, contributionShare, status, direction };
}

function expectedPath(edgeId, status, direction) {
  return { edgeId, status, direction };
}

function simpleCase(surface, family) {
  const caseId = `${family.id}-${surface.id}`;
  const seedId = `${caseId}-seed`;
  const targetId = `${caseId}-target`;
  const pathEdge = edge(`${caseId}-edge`, seedId, targetId);
  const contributionClass = family.contributionClass || "none";
  const contributionShare = Number(family.contributionShare || 0);
  return {
    caseId,
    category: family.category,
    scenarioId: surface.id,
    scenario: {
      memories: [
        memory(seedId, "当前问题线索", `当前正在处理与${surface.title}相关的新问题。`),
        memory(targetId, surface.title, surface.content),
      ],
      edges: [pathEdge],
      query: surface.query,
      recallIntent: "problem-solving",
      assistantResponse: surface.response,
      usedMemoryIds: [targetId],
      seedIds: [seedId],
      selectedIds: [targetId],
      paths: [path(targetId, [pathEdge])],
      followUp: family.followUp(surface),
      feedbackBinding: family.feedbackBinding || "immediate-next-user-input",
      delayDays: Math.max(0, Number(family.delayDays || 0)),
    },
    expected: {
      outcomeClass: family.outcomeClass,
      evidenceTier: family.evidenceTier,
      feedbackTarget: family.feedbackTarget,
      targetMemoryIds: family.targeted ? [targetId] : [],
      memoryCredits: [expectedCredit(
        targetId,
        contributionClass,
        contributionShare,
        family.status,
        family.direction,
      )],
      pathCredits: [expectedPath(pathEdge.id, family.status, family.direction)],
      mustNotChange: MUST_NOT_CHANGE,
      limits: LIMITS,
    },
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
        memory(seedId, "当前问题线索", `当前正在处理与${surface.title}相关的新问题。`),
        memory(firstId, surface.title, surface.content),
        memory(secondId, "补充检查清单", "用户以前还会在执行方法前检查必要条件，避免漏掉前置步骤。"),
      ],
      edges: [firstEdge, secondEdge],
      query: surface.query,
      recallIntent: "problem-solving",
      assistantResponse: `${surface.response} 另外先检查必要条件，避免漏掉前置步骤。`,
      usedMemoryIds: [firstId, secondId],
      seedIds: [seedId],
      selectedIds: [firstId, secondId],
      paths: [path(firstId, [firstEdge]), path(secondId, [secondEdge])],
      followUp: `你提到的“${surface.reference}”和补充检查都帮到了我，${surface.outcome}。`,
    },
    expected: {
      outcomeClass: "explicit_help",
      evidenceTier: "explicit_attribution",
      feedbackTarget: "retrieved_memory",
      targetMemoryIds: [firstId, secondId],
      memoryCredits: [
        expectedCredit(firstId, "partial", 0.5, "eligible", "increase"),
        expectedCredit(secondId, "partial", 0.5, "eligible", "increase"),
      ],
      pathCredits: [
        expectedPath(firstEdge.id, "eligible", "increase"),
        expectedPath(secondEdge.id, "eligible", "increase"),
      ],
      mustNotChange: MUST_NOT_CHANGE,
      limits: LIMITS,
    },
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
        memory(seedId, "高连接主题", `与${surface.title}有关的常见主题。`),
        memory(targetId, surface.title, surface.content),
        memory(noiseAId, "同主题闲聊", "用户以前随口聊过同一主题，但没有提供当前方法。"),
        memory(noiseBId, "同主题背景", "用户以前看过同主题内容，但没有形成可执行步骤。"),
      ],
      edges: [targetEdge, noiseAEdge, noiseBEdge],
      query: surface.query,
      recallIntent: "problem-solving",
      assistantResponse: `${surface.response} 你以前也聊过和看过这个主题。`,
      usedMemoryIds: [targetId, noiseAId, noiseBId],
      seedIds: [seedId],
      selectedIds: [targetId, noiseAId, noiseBId],
      paths: [
        path(targetId, [targetEdge]),
        path(noiseAId, [noiseAEdge]),
        path(noiseBId, [noiseBEdge]),
      ],
      followUp: `只有“${surface.reference}”真正帮到了我，${surface.outcome}；另外两段背景没有作用。`,
    },
    expected: {
      outcomeClass: "explicit_help",
      evidenceTier: "explicit_attribution",
      feedbackTarget: "retrieved_memory",
      targetMemoryIds: [targetId, noiseAId, noiseBId],
      memoryCredits: [
        expectedCredit(targetId, "direct", 1, "eligible", "increase"),
        expectedCredit(noiseAId, "none", 0, "blocked", "hold"),
        expectedCredit(noiseBId, "none", 0, "blocked", "hold"),
      ],
      pathCredits: [
        expectedPath(targetEdge.id, "eligible", "increase"),
        expectedPath(noiseAEdge.id, "blocked", "hold"),
        expectedPath(noiseBEdge.id, "blocked", "hold"),
      ],
      mustNotChange: MUST_NOT_CHANGE,
      limits: LIMITS,
    },
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
    followUp: (value) => `你想起“${value.reference}”真的帮了我，${value.outcome}。`,
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
    followUp: (value) => `我照你从“${value.reference}”总结的办法做了，${value.outcome}。`,
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
    followUp: (value) => `我准备照“${value.reference}”试试，结果还不知道。`,
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
    followUp: () => "抱抱你，能和你说话我就很开心。",
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
    followUp: (value) => `你记错了，“${value.reference}”不是我的经历，是别人的。`,
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
    followUp: (value) => `我照“${value.reference}”做了，但没有用，${value.failure}。`,
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
    followUp: () => "好，我知道了，先去处理别的事情。",
  },
  {
    id: "answer-content",
    category: "answer_content",
    outcomeClass: "social_affect",
    evidenceTier: "none",
    feedbackTarget: "answer_content",
    targeted: false,
    contributionClass: "none",
    contributionShare: 0,
    status: "blocked",
    direction: "hold",
    followUp: () => "你刚才这段解释写得很清楚，表达得真好。",
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
    followUp: (value) => `后来是外部条件发生了变化，${value.outcome}。`,
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
    followUp: (value) => `可能“${value.reference}”有点用，也可能只是碰巧，我说不清。`,
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
    delayDays: 3,
    followUp: (value) => `三天后确认一下：我确实照“${value.reference}”做了，${value.outcome}。`,
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
    followUp: (value) => `“${value.reference}”已经是旧情况了，我后来改过做法，不能再把它当成现在的方法。`,
  },
]);

const cases = SCENARIOS.flatMap((surface) => [
  ...SIMPLE_FAMILIES.map((family) => simpleCase(surface, family)),
  multiMemoryCase(surface),
  highFanoutCase(surface),
]);

export const REWARD_CREDIT_MINI_V1 = Object.freeze({
  version: "suzu-reward-credit-mini-v1-rc1",
  license: "CC-BY-4.0",
  synthetic: true,
  description: "140条完全原创、完全虚构、可回放的陪伴型长期记忆奖励归因候选案例。",
  cases: Object.freeze(cases),
});

export function loadRewardCreditMiniV1() {
  return REWARD_CREDIT_MINI_V1;
}
