# Product Event 来源、检索范围与清理

本接口面向拥有正式 Event 存储的宿主。Memory 接收宿主提供的事件与来源范围，保留实际发送者、接收 Agent、互动空间和观察位置。入口位于 `@suzu-memory/service`，当前数据库为 schema 44；`initialize()` 沿既有迁移升级数据库，保留原记忆与激活状态。

来源范围支持按 Event 全局提交位置限定的 v1 格式，以及按 Agent 已接纳经历位置限定的 v2 格式。以下两种范围按宿主已有的坐标模型选用；现有 companion API 继续可用。

## 消费已提交 Event

### Event 提交位置（v1）

```js
const scope = {
  owner: 'product-events', agentId: 'agent-a', eventUpperBound: 120,
  clears: [{ spaceId: 'direct-a', throughSequence: 90 }],
};
memory.appendEventSources({
  scope,
  events: [{
    occurredAt: '2026-09-06T03:00:00.000Z',
    content: { text: 'B 发来的实际内容。' },
    source: {
      version: 1, owner: 'product-events', recipientAgentId: 'agent-a',
      eventId: 'event-119', spaceId: 'shared-space', commitSequence: 119,
      eventType: 'message.created', sender: { kind: 'agent', id: 'agent-b' },
      topology: { kind: 'space', spaceKind: 'shared' },
    },
  }],
});
```

`source` 是不可变的 JSON 快照，必须有实际 owner、Event ID、Space ID、正整数提交序号、Event 类型、sender、接收 Agent 和 topology。`recipientAgentId` 由调用方的正式体验读取证明；只有上游确实提供完整接收集合时才填写可选 `recipientAgentIds`。额外的可读身份或内容 hash 随来源保留。

延后观察的来源可声明 `observation: { eventId, commitSequence, occurredAt }`，引用真实的观察事实；原始消息的 Event 身份、顺序和发生时间保持不变。观察顺序不得早于原消息，检索与维护同时要求消息和观察顺序处于 `eventUpperBound` 内。没有该字段的来源沿用原上界规则。

`topology.kind` 支持 `space` 和 `direct-user-agent-dm`。后者必须声明实际两个参与者 `{kind,id}`，包括接收 Agent 和一个本地用户；sender 必须是其中一个参与者。一般 Space 的 `participants` 可省略，不会补入假定用户或 Agent。自身 Agent、主要用户、其他 Agent/用户、system/world/unknown 的实际身份分别保留；原始发言的 speaker 和 participant 不再依赖固定双人模板。

内部使用 protocol 2 和既有分片、输入表、归档租约。稳定 external ID 为 `encodeURIComponent(owner) + ':' + encodeURIComponent(eventId)`。同一来源和材料重放复用原行，冲突材料被现有 input hash 拒绝。单次追加和 `progress.consumedThroughSequence` 同事务提交。调用方负责提供该固定上界内真实读取到的有效 Event；该进度表达调用方声明的消费覆盖，不替代上游体验存储的证明。

结果保留原追加 API 的 `accepted/inserted/reused/events`，增加 `progress` 和只含 Event ID 的 `cleared`。超过上界抛 `EVENT_SOURCE_FUTURE`，跨 Agent 抛 `EVENT_SOURCE_AGENT_CONFLICT`。清空范围必须包含已持久化的全部截止位置，否则抛 `EVENT_SOURCE_SCOPE_STALE`。已清来源重放不会恢复正文。

### Agent 经历位置（v2）

```js
const experienceScope = {
  version: 2, owner: 'product-events', agentId: 'agent-a',
  agentGeneration: 1,
  experienceUpperBound: 2,
  globalEventUpperBound: 2000,
  clearedThroughExperienceSequence: 0,
  contentRevision: 0,
};
memory.appendEventSources({
  scope: experienceScope,
  events: [{
    occurredAt: '2026-10-06T00:00:00.000Z',
    content: { text: 'B 在群里的发言。' },
    source: {
      version: 2, owner: 'product-events', recipientAgentId: 'agent-a',
      agentGeneration: 1,
      eventId: 'group-event-10', spaceId: 'shared-space',
      commitSequence: 10, eventType: 'message.created',
      sender: { kind: 'agent', id: 'agent-b' },
      topology: { kind: 'space', spaceKind: 'shared' },
      experienceRef: {
        experienceId: 'experience-2', experienceSequence: 2,
        itemIndex: 0, sourceEventId: 'group-event-10',
      },
      observation: {
        eventId: 'observation-2000', commitSequence: 2000,
        occurredAt: '2026-10-06T01:00:00.000Z',
      },
    },
  }],
});
```

`experienceRef` 引用宿主实际保存的经历条目，`sourceEventId` 必须与原 `eventId` 相同。`experienceSequence` 为正整数，`itemIndex` 为非负整数；来源与 scope 的 `agentGeneration` 必须一致。示例中的旧群消息保持原提交位置 10，在后来观察并接纳为经历 2 时进入该 Agent 的消费范围。

v2 范围同时要求经历位置在 `(clearedThroughExperienceSequence, experienceUpperBound]` 内，原消息和可选观察的提交位置不超过 `globalEventUpperBound`。消费进度使用 `progress.consumedThroughExperienceSequence`；Event 全局序号不代替 Agent 的经历进度。`getEventSourceProgress({ scope: experienceScope })` 返回该范围的持久消费状态。

宿主提供当前代次、内容修订号和清空经历截止位置。清空或来源修订后使用更新的范围；已经持久化的清空门禁不能通过重放旧来源撤回。v2 的 `eraseEventSources` 使用同一范围合同，按所属 Agent 的经历截止位置清理。

离线转换可通过 `adoptExperienceSourceEvidence({ scope, resolveSource, consumedThroughExperienceSequence })` 为既有 Event 来源补齐经历坐标。调用方必须提供已经确认的对应关系，转换保留原来源身份、正文、图节点、提取状态和历史模型材料。

## 有来源范围的检索

```js
const result = await memory.search(query, { sourceScope: scope, persistTrace: false });
// result.fragments[*].eventSources：本次实际物化记忆与证据的真实 Event 来源。
```

范围在候选装载、图扩展、当前状态补全、embedding 候选和最终物化中生效。输入必须为有效 protocol 2，来源字段与实际输入类型、sender 一致；原始来源正文必须能由其输入分片重建。每条记忆的全部来源都有效才可进入候选。未知来源、未来 Event、撤回/清空来源及混合失效来源的派生节点被排除；独立的有效原文和记忆仍参与原有 RAG。

`scoped_exception_to` 的宽泛状态→局部例外、局部例外→宽泛状态两个方向，均使用同一读快照的 eligible memory IDs。补全先排除不合格来源，再按原顺序选择；较新的失效根不会挡住后面的有效根。没有有效补全时保留原有效节点，正文、选中节点与片段来源保持一致。

有范围检索的全部数据库读取使用同一 SQLite 读事务，跨 embedding await 的并发归档不会替换最终证据正文。返回前释放读事务，再读取当前 epoch 和截止位置验证；清理或 v2 来源修订可以否定在途旧快照。新的有效 Event 保留在库中，供后续上界读取。

scoring、候选融合、衰减、主体/时间/现实条件、证据选择策略保持原实现。最终片段返回来源数组，应用无需再次遍历图并丢弃整份结果。embedding 记录其文档引用的 memory IDs；有范围检索只使用依赖全部可验证的向量。迁移前没有依赖信息的向量仍可供旧 API 使用，有范围检索等待正常重建向量。

清理改变持久 epoch。持有旧 SQLite Repository 的提取、embedding、维护或检索执行在写回或返回时失败；当前 search 不会把失效期间生成的 trace 写回。产品 Event 的 usage ledger 只保留路由标识与数值计量，不写 provider 回显正文。该机制不撤销清空前已经发送给外部 provider 的请求，产品 Host 应同时停止和等待其在途执行。

## 候选预览、轨迹与激活

```js
const result = await memory.search(query, {
  sourceScope: scope,
  persistTrace: false,
  reactivate: false,
  options: { includeCandidateContext: true, maximumReturnedCandidates: 5 },
});
// result.candidates[*].memoryId：候选记忆 ID。
// result.candidates[*].recallContext：有界的可读预览。
// 使用 sourceScope 时，候选预览同时保留 eventSources。
```

`includeCandidateContext` 默认关闭，开启后为每个返回候选附加可读材料及状态、现实范围和时间性质。候选保持各自的主体和来源；主焦点的证据展开继续位于 `fragments`。已有记忆 ID 可通过 `search(query, { anchors: memoryIds, sourceScope: scope })` 用于关联查询。

| 选项或方法 | 行为 |
| --- | --- |
| `persistTrace` | 默认 `true`，控制详细检索轨迹的持久化。关闭时返回结果仍可包含用于解释检索的 `trace` 字段。 |
| `reactivate` | 默认 `false`，控制本次搜索是否写入召回激活。它与轨迹保存分别控制；排序仍可读取已有激活状态。 |
| `activationId` | 稳定使用身份。`reactivate: true` 且 `persistTrace: false` 时必须提供；保存轨迹的激活也可沿用轨迹身份。 |
| `reactivateRecall({ activationId, memoryIds, sourceScope })` | 独立记录一组有效记忆的激活，要求稳定 `activationId`，并检查所属 Agent、活跃状态与可选来源范围。 |

schema 44 的持久回执使同一使用身份的重试不会重复增加激活值。调用方为新的使用指定新的身份；激活状态与回执在同一事务内保存。

## 可恢复的按范围物理清理

```js
const job = memory.eraseEventSources({ id: 'stable-product-cleanup-id', scope });
// { id, agentId, owner, requestHash, scope, phase, complete, result }
memory.getEventSourceCleanup(job.id);
memory.recoverEventSourceCleanups();
```

`id` 与规范化 scope 固定绑定；不同材料复用 ID 抛 `EVENT_SOURCE_CLEANUP_CONFLICT`。可选同步 `onProgress(job)` 在持久阶段后报告进度，回调失败会留下可恢复状态。`initialize()` 在物化待处理结构前自动恢复未完成清理。

| 持久阶段 | 实际处理 |
| --- | --- |
| `fenced` | 同事务保存来源截止位置、清理请求和新的写入 epoch。新调用不能退回旧范围。 |
| `database-cleaned` | 同事务清掉命中的全部输入分片正文、原始来源正文、混合或专属派生记忆、FTS、相关向量、修订/提取/维护/检索快照与其真实引用；校验所有外键。 |
| `complete` | 清理 Memory 管理的备份及 import/restore 暂存数据库、更新备份 hash，移除可视化缓存并净化本 Agent 的 usage 诊断正文；才确认完成。 |

清理依据输入 ID、source links、memory links、辅助记录的外键和结构化快照引用，不通过正文关键字猜测归属。混合派生节点及混合批次/分析快照被移除；有效来源、原文、独立派生记忆及其审计保留。同批的有效 processing 输入重新变为 pending，继续走原租约机制。实体名称和别名只保留可由剩余来源验证的部分，已配置的 Agent/用户身份不被清除。

辅助 join 记录通过真实外键命中的父记录，其自身 ID 也进入清理闭包。因此 `recordStateAnalysisRun` 使用默认空 `batchId`、`output` 只含自然语言时，仍会根据 memory/source join 删除受影响的分析正文，并继续清理依赖该分析的观察记录。live 数据库与受管备份使用同一闭包；独立分析和原有效证据保留，文件阶段结束后才返回 `complete`。

闭包按 `(table, id)` 保存依赖。父记录自身命中、向父记录传播和对子记录的 FK 检查均保留 schema 声明的目标表。JSON 使用既有命名引用的所属类型，例如 `selectedIds` 指向 memory、`analysisRunIds` 指向分析运行；普通说明文字、provider request ID 和裸对象 ID 不建立依赖。不同表的合法主键相同，不会使独立 trace、feedback、分析或观察继承另一张表的清理。

保留无正文 input/source/memory tombstone、原 hash、最小来源 ID/序号、单调进度和清理阶段以保证幂等；数据库触发器阻止 fresh Repository 恢复已擦除的正文、向量或来源链接。数据库事务完成时再次推进 epoch，覆盖持久 fence 建立后才打开的在途 Repository。多个 Agent 共用测试数据库时保留其他 Agent 的行；生产布局仍是每个 Agent 一个库。

清理覆盖 SQLite 可读取记录和本 owner 管理的派生文件，不承诺磁盘空闲页、系统快照或介质上的取证级擦除。用户选择到 owner 目录外的导出文件属于另行管理的导出材料。清理路径必须在该 Agent 的显式数据根下，且每个祖先、目标和备份子树均不得通过 symlink/junction 重定向；无法确认文件归属或完成文件阶段时不返回 complete。

已交付 Suzu Lives v1 的 `metadata.suzuLives + metadata.host.id='suzu-lives-events'` 输入可按其真实 Event/Space/Agent/序号清理。这个兼容读取只用于擦除，不把旧的不完整来源升级成可检索的 v2 证据。

## 提取校验与验证

`@suzu-memory/service` 导出 `validateMemoryExtractionOutput(request, output)`，使用正式 extraction parser，支持 `long-term-memory-extraction-v2` 和 `long-term-memory-extraction-repair-v2`，拒绝未知 schema。service 显式声明 extraction 依赖；usage-ledger 显式声明 core 依赖，锁文件同步。

`packages/service/test/event-source-contracts.test.mjs` 使用真实 SQLite、既有提取/检索/embedding API、备份和外键校验。覆盖 v41 有数据迁移、其他 Agent/本地用户/Space、长分片和修订正文、混合来源、同批恢复、跨 Agent 保留、范围检索、迟到提取/embedding 写回。两个子进程分别停在持久 `fenced` 和 `database-cleaned` 阶段，由父进程 SIGKILL 后重开真实数据库恢复。其他延迟 provider 和回调异常是注入故障，分别标明，不冒充远端服务中断。

`packages/service/test/event-source-repair.test.mjs` 另外覆盖双向状态补全的未来/清空/未知来源、双向有效补全、跳过较新未知根，以及空 batch 分析父记录和间接观察在 live/backup 中的清理、独立分析保留与重启幂等。

`packages/service/test/event-source-id-scope.test.mjs` 验证 live/backup 中跨表同 ID 的自身命中、SQL FK、batch/provider 标识和 JSON 引用区分，同时检查真实派生记录删除、有效 source 保留、外键完整性和重启幂等。

## 固定来源范围内的维护与模型材料

`runMaintenance`、`runSemanticMaintenance` 和 `runEmbeddingMaintenance` 接收 `{sourceScope, signal}`。已有 Event 来源的数据库要求显式 scope；缺少时抛 `EVENT_SOURCE_SCOPE_REQUIRED`。未接入 Event 的旧数据库仍支持原 API。`processPendingEvents/syncEmbeddings/analyzePendingState/processConsolidation/search` 也接收该范围与取消信号，嵌套调用由 `withRepository(callback,{sourceScope,signal})` 传播，复用原 Repository、队列和租约。

原有 input、maintenance、state request 和 consolidation 选择在 SQL LIMIT 前筛选来源；带未来、未知或混合失效来源的任务不认领、不增加 attempt，不制造失败审核。范围内任务继续按原顺序处理，后续合格上界可处理先前等待任务。已有当前 canonical state 若不合格，相关分析请求等待，不将它解释成“没有当前状态”。scope 只是调用选择，不改变已消费的其他有效 Event。

执行结束时关闭该 ALS 范围的有效期；在执行期间建立的长期 Host/异步回调不能把已结束的旧 scope 带到后续调用。仍在执行的嵌套调用继续继承 scope 和 signal。

结构/关系快照、状态分析原文与来源、当前状态比较、图扩展及 utterance 向量相邻上下文均使用 `createEventSourceView` 的同一范围。每次材料或 claim 边界刷新视图，允许使用本次执行刚提交的合格派生节点。ALS 同时检查 signal 和持久 epoch；模型返回后、异常降级前和数据库写入前再次检查，取消后的迟到响应不能写回成功、失败或审核行。未完成任务保留既有租约，由原过期恢复方法回收。

内核传给真实 generator 的 request 增加 `sourceMaterial`：

```js
{
  version: 1,
  sourceScope: scope,
  memoryIds: [], sourceIds: [], inputEventIds: [],
  eventSources: [],
}
```

它来自实际 typed snapshot/input builder，并通过原输入→source→memory 链验证。结构和关系 prompt 的序列化省略这项追溯元数据；组合调用合并子请求来源；抽取修复继承原抽取来源。embedding 函数与 embedMany 的第二参数也带 `{sourceMaterial,signal,model,dimensions}`；旧 provider 可以忽略新增参数。`createOpenAiCompatibleEmbeddingProvider.describeRequest(texts)` 与实际 HTTP 共用构造器，返回不含授权头的 URL/body，便于 Host 在发送前保存准确请求。

状态分析 run 将材料存到原 `metadata_json.eventSourceMaterial`，不升级数据库 schema。范围内 canonical review 只读取依赖全部可验证的 observation/run。迁移前没有这份实际材料的历史 analysis run 不被当成范围内模型证据，仍保留在库供旧 API/人工检查；此边界不通过猜测旧 prompt 重建来源。

`@suzu-memory/service` 新导出 `assertMemoryTaskRequest(request)` 和 `validateMemoryTaskOutput(request,output)`。前者检查注册版本和精确 schema，后者先检查声明的 wire 形状，再调用既有 extraction/repair、structure/relation/subject-attribution、检索上下文 proposal/critic 和全部十组专职分析的领域 parser。组合状态分析使用实际 family/phase/analyzerKeys，组合巩固分别检查两个子域；未知 schema 拒绝。`managementStatus()` 返回真实数据库路径与计数，不执行生成；既有管理、审核和 staging 备份 API 可继续复用。

`event-source-maintenance.test.mjs` 覆盖 LIMIT 前等待、混合/未知来源、快照与 embedding 实际输入、当前状态、抽取上下文、取消及租约恢复；`model-task-validation.test.mjs` 调用实际组合请求构造器验证各角色和子 schema。`event-source-experience.test.mjs` 覆盖 v2 经历进度、延后观察、清空门禁及受管备份。
