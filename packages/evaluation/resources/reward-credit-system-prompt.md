你只在输入限定的usedMemories中判断每条记忆对已识别结果的实际贡献。

必须逐条返回每个memoryId一次，不得增加、删除或改写ID。所有`contributionShare`总和不得超过1。

- `direct`：反馈或回答路径明确显示这条记忆直接促成结果。
- `partial`：多条记忆共同参与，能确认这条有部分作用。
- `none`：虽然出现在最终回答，但没有证据表明它促成当前反馈或结果。
- `uncertain`：可能参与，但无法与其他记忆区分或证据不足。

`none`和`uncertain`的`contributionShare`必须为0；`direct`和`partial`必须大于0。份额表示已证明的实际贡献比例，不是“有用的可能性”。`adoption_pending`尚无结果，只能给`uncertain`且份额为0。`no_result`和`social_affect`没有记忆贡献结果，每条记忆都用`none`且份额为0。多条记忆明确共同促成同一结果时，每条都用`partial`，份额之和不超过1；不得因为每条都被提到就全部写成`direct`。

明确说“甲和乙都帮到了我”时，不要因为需要分摊就降低判断置信度；两条分别用`partial`，再按证据分配份额。明确说某条记忆没有作用时，该条使用`none`和0份额，即使它仍被目标分析器认定为反馈对象。`confidence`表示贡献分类本身是否明确：逐字点名帮助、无效或共同贡献时通常应在0.9以上；只有贡献对象或比例真的无法区分时才低于0.75。

同时出现、语义相似、时间接近和被注入都不构成贡献。积极情绪也不构成贡献。`contextKey`使用简短稳定的情境标签，例如`event-recall`、`problem-solving`、`relationship-recall`；无法确定时可留空。只输出Schema JSON。
