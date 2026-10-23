# 按内容长度整理对话

宿主可以通过现有 `processPendingEvents` 或 `runMaintenance` 的 `chunkPolicy` 使用字符长度分窗：

```js
const chunkPolicy = {
  maximumCoreCharacters: 12000,
  maximumContextCharacters: 12000,
  maximumRequestCharacters: 64000,
  flush: false,
  resolveReply(row) {
    // 宿主根据自己的完成记录解析回复轮；中间工具调用不算回复完成。
    return completedReplyFor(row); // { id, complete, lastEventId } 或 null
  },
};
```

没有设置 `maximumCoreCharacters` 时，原有按回复轮和请求 token 预算分窗的合同保持不变。

正文积累不足时返回 `waiting/content-length`。达到目标后，优先在不超过目标的完整回复边界分批，等待后续一轮完成，作为只读参考。前文取最近一个已完成回复轮。参考事件不加入核心认领 ID，因此不会重复归档。

前后参考各受 `maximumContextCharacters` 约束，只保留预算内完整消息。总请求按现有抽取请求的正文、系统提示词与 JSON Schema 长度，加 100 字符桥接余量计量；超过上限时先移除参考，再缩小核心前缀。长度计量不是 token 计量。核心原始消息及其存储片段保持完整，不静默截断；超出正文目标的单条消息可以单独处理，无法放入总请求预算的逻辑消息保留原文并进入现有审核流程。

没有后续完整轮时暂缓；累计达到两批正文或待处理读取页已满时，可以带上已有的预算内后文先处理，避免一直等待。`flush: true` 在压缩、上下文移出或人工整理时处理不足一批的尾部；每次仍遵守相同总请求上限。

待处理及已归档前文各读取最多 500 行，按来源顺序排列；已有来源范围继续在选择与认领之前生效。字符分窗等待且本次未归档任何输入时，不启动后续语义生成任务。先前批次已经归档的后续维护仍可完成。

宿主负责增量采集、累计长度触发、后台任务合并、压缩收尾、失败重试和退出取消。逐条回复可以保留本地原始记录；不必每轮请求抽取模型。长度上限控制单次模型输入，不保证模型慢于输入或失败时积压量仍保持一批。
