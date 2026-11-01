<h1 align="center">Suzu Memory · LoCoMo 评测报告</h1>

<p align="center">
  2026-11-01（Asia/Shanghai） · 10 组英文长对话 · 272 段会话 · 5,882 条原话 · 1540 道问答题 · 含无历史与完整对话对照
</p>

<p align="center">
  <a href="https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376"><img src="https://img.shields.io/badge/%E6%95%B0%E6%8D%AE%E9%9B%86-LoCoMo_3eb6f2c-777bc4?style=for-the-badge" alt="数据集 LoCoMo 3eb6f2c"></a>
  <a href="https://github.com/mem0ai/mem0/tree/393a4fd5a6cfeb754857a2229726f567a9fadf36"><img src="https://img.shields.io/badge/%E8%A3%81%E5%88%A4-Mem0_393a4fd-bf71ac?style=for-the-badge" alt="裁判提示词 Mem0 393a4fd"></a>
  <a href="source-manifest.json"><img src="https://img.shields.io/badge/%E6%BA%90%E7%A0%81%E6%8C%87%E7%BA%B9-426_%E6%96%87%E4%BB%B6-9365cb?style=for-the-badge" alt="源码指纹 426 个文件"></a>
  <a href="#离线复核"><img src="https://img.shields.io/badge/%E7%A6%BB%E7%BA%BF%E5%A4%8D%E6%A0%B8-node_verify.mjs-5FA04E?style=for-the-badge" alt="离线复核 node verify.mjs"></a>
</p>

<p align="center">
  <a href="#结果"><strong>结果</strong></a> ·
  <a href="#数据模型与评分"><strong>数据、模型与评分</strong></a> ·
  <a href="#检索与输入用量"><strong>检索与用量</strong></a> ·
  <a href="#完整性与整理状态"><strong>完整性</strong></a> ·
  <a href="#逐样本结果"><strong>逐样本结果</strong></a> ·
  <a href="#离线复核"><strong>离线复核</strong></a>
</p>

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="../../../docs/assets/locomo-2026-11-01-overview-mobile.svg">
    <img src="../../../docs/assets/locomo-2026-11-01-overview.svg" alt="LoCoMo 对照评测：无历史 0.39%，Suzu Memory 89.87%（每题累计 4,375 token），完整对话 93.51%（每题 21,490 token，随对话增长）。Suzu Memory 达到完整对话准确率的 96.1%，各组对话的每题输入保持在 4,033–4,664 token，时间类问题高于完整对话 0.93 个百分点。" width="1120">
  </picture>
</p>

## 结果

在 LoCoMo 的全部 10 个样本中，类别 1–4 共 **1540 题**。Suzu Memory 答对 **1384 题，准确率 89.87%**。同一作答模型直接阅读完整对话时为 93.51%，不提供历史时为 0.39%。三组共 4620 次作答全部完成裁判评分，执行失败为 0。

| 类别 | 题数 | 无历史 | Suzu Memory | 完整对话 |
| --- | ---: | ---: | ---: | ---: |
| 单跳 | 841 | 0.00%（0） | 94.17%（792） | 96.91%（815） |
| 时间 | 321 | 0.00%（0） | **90.34%（290）** | 89.41%（287） |
| 多跳 | 282 | 0.71%（2） | 84.40%（238） | 93.97%（265） |
| 开放域 | 96 | 4.17%（4） | 66.67%（64） | 76.04%（73） |
| **总体（按题微平均）** | **1540** | **0.39%（6）** | **89.87%（1384）** | **93.51%（1440）** |

括号内为答对题数。Suzu Memory 达到完整对话准确率的 96.1%，时间类问题高于完整对话 0.93 个百分点。

### 输入用量

| 组别 | 每题作答请求 | 每题作答输入 | 每题作答输出 | 输入命中前缀缓存 |
| --- | ---: | ---: | ---: | ---: |
| 无历史 | 1 | 211.86 token | 40.14 token | 0% |
| **Suzu Memory** | **2.17** | **4375.02 token** | **194.66 token** | 未记录 |
| 完整对话 | 1 | 21490.03 token | 66.22 token | 97.80% |

用量为服务商报告的作答模型 token，裁判调用不计在内。记忆组是每题全部作答请求的累计值，包含工具定义、返回的记忆和重发的历史，建库与 Embedding 也不计在内。完整对话组的输入大多命中服务商的前缀缓存，按 token 计费时，实际费用的差距会小于 token 数的差距。

**记忆组的输入不随对话变长。** 完整对话组的输入随对话长度增长，与长度的相关系数为 0.99；记忆组的输入由检索预算决定，相关系数为 0.09。对话长度从 52,707 字符增至 106,835 字符时，完整对话组的每题输入从 12,990 涨到 24,533 token，记忆组保持在 4,033–4,664 token。单题的输入取决于模型检索了几次，而不是对话有多长。

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="../../../docs/assets/locomo-2026-11-01-input-mobile.svg">
    <img src="../../../docs/assets/locomo-2026-11-01-input.svg" alt="作答输入与对话长度：10 组对话从 52,707 到 106,835 字符。完整对话组每题输入从 12,990 增至 24,533 token，与长度的相关系数为 0.99；Suzu Memory 每题输入保持在 4,033–4,664 token，相关系数为 0.09。" width="1120">
  </picture>
</p>

<details>
<summary><strong>各样本的对话长度与每题输入</strong></summary>

<br>

| 样本 | 对话长度（字符） | 完整对话每题输入 | Suzu Memory 每题输入 |
| --- | ---: | ---: | ---: |
| conv-30 | 52,707 | 12,990 token | 4,099 token |
| conv-26 | 72,605 | 16,977 token | 4,321 token |
| conv-49 | 74,330 | 18,206 token | 4,544 token |
| conv-42 | 87,820 | 21,379 token | 4,659 token |
| conv-48 | 92,514 | 22,360 token | 4,357 token |
| conv-47 | 96,151 | 22,588 token | 4,266 token |
| conv-50 | 96,938 | 23,025 token | 4,373 token |
| conv-44 | 100,464 | 24,114 token | 4,664 token |
| conv-43 | 105,687 | 24,582 token | 4,286 token |
| conv-41 | 106,835 | 24,533 token | 4,033 token |

对话长度是完整对话组上下文的字符数，见 [controls.json](controls.json)；每题输入为该样本各题的平均值，由 [questions.jsonl](questions.jsonl) 与 [controls-questions.jsonl](controls-questions.jsonl) 计算。

</details>

### 逐题对照

| 对照 | 两组都对 | 仅记忆组答对 | 仅对照组答对 | 两组都错 | 净差 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 记忆组 vs 无历史 | 6 | 1378 | 0 | 156 | +1378 |
| 记忆组 vs 完整对话 | 1351 | 33 | 89 | 67 | −56 |

净差与两组的正确数之差一致。记忆组每题的回答、裁判标签与用量见 [questions.jsonl](questions.jsonl)，对照组见 [controls-questions.jsonl](controls-questions.jsonl)，汇总见 [summary.json](summary.json) 与 [controls.json](controls.json)。

## 数据、模型与评分

| 项目 | 设置 |
| --- | --- |
| 数据集 | [LoCoMo @ 3eb6f2c](https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376) 的 `data/locomo10.json`，原生英文对话，包含可用的图片描述 |
| 题目范围 | 全部 10 个样本的类别 1–4。类别 5（对抗题，共 446 题）不纳入本报告的计分范围 |
| 记忆分析、作答与裁判 | 请求模型 `deepseek-v4-flash`，关闭思考，温度 `0`，输出上限 `32768` token。作答与裁判响应中报告的模型名称为 `deepseek-flash` |
| 向量模型 | `text-embedding-v4`，`1024` 维 |
| 建库 | 通过正式配置工厂与聊天宿主适配器导入原始对话。正文累计到 `12000` 字符时分批整理，会话结束时处理尾批。问答使用已准备好的记忆和完整的向量索引 |
| 记忆组作答 | 作答模型通过 `suzu_memory_search` 按需检索，见[检索与输入用量](#检索与输入用量) |
| 对照组作答 | 使用同一作答提示词，只替换其中的记忆内容，不提供工具说明和工具，每题直接作答一次。无历史组的记忆内容为空；完整对话组按时间顺序包含全部会话的日期、发言者、正文和图片描述，不截断 |
| 评分 | LLM-as-a-Judge 二元判定 `CORRECT` / `WRONG`，三组采用同一份裁判提示词，来自 [Mem0 评测实现 @ 393a4fd](https://github.com/mem0ai/mem0/tree/393a4fd5a6cfeb754857a2229726f567a9fadf36) |
| 汇总 | 每题等权，执行失败按错计，全部样本保留计分 |

标准答案、题目类别与标注证据不参与建库，也不提供给作答模型。记忆组每题使用独立的检索会话，检索为只读，不改变后续题目的记忆状态。裁判单独接收题目、标准答案和生成的回答。

完整参数见 [settings.json](settings.json)，对照组设置见 [controls.json](controls.json)，其中包含各样本完整对话上下文的字符数与 SHA-256。[作答提示词](answer-prompt.md)、[工具使用说明](tool-instruction.md)与[裁判提示词](judge-prompt.md)随报告公开。二元裁判成绩只对应这里列出的模型、提示词和题目范围，与其他报告对照时，需要同时核对这些设置。

## 检索与输入用量

作答模型通过 `suzu_memory_search` 自行决定查询内容，可以改写查询，或用已返回的记忆编号继续查关联。**每次检索最多返回 10 条记忆、10976 字符，每题最多调用检索工具 6 次。** 同一题内按记忆 ID 去重，记忆编号使用题内的 `m1`、`m2` 等短引用。

| 指标 | 数值 |
| --- | ---: |
| 每题累计作答模型输入 | **4375.02 token** |
| 每题累计作答模型输出 | 194.66 token |
| 作答模型请求总数 | 3345 |
| 实际检索总数（平均每题 2.28 次） | 3505 |
| 每题累计返回记忆 | 22.62 条 |
| 每题累计返回文本 | 5964.72 字符 |

| 每题检索次数 | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 题数 | 61 | 1257 | 25 | 157 | 13 | 27 |

输入 token 是每题全部作答请求的累计值，包含指令、工具定义、查询、返回的记忆，以及后续请求中重发的历史。建库、Embedding 和裁判调用不计在内。因此，它反映的是作答模型的累计输入，不能当作单次检索的注入量，也不代表完整的建库成本。Top 10 的限制作用于每次检索，同一题补查后获得的记忆总数可以超过 10 条。

## 完整性与整理状态

| 问答 | 数量 |
| --- | ---: |
| 记忆组完成作答与评分 | **1540 / 1540** |
| 对照组完成作答与评分 | **3080 / 3080** |
| 执行失败 / 未运行题 | 0 / 0 |
| 排除样本 | 0 |

| 记忆准备诊断 | 数量 | 分布 |
| --- | ---: | --- |
| 原话隔离 / 缺失输入 | 0 / 0 | |
| 仅归档回退批次 | 4 | conv-42、43、44、49 各 1 |
| 抽取未完整返回的批次 | 4 | conv-42、43、44、49 各 1 |
| 未完成结构化抽取的候选 | 8 | conv-44 ×5 · conv-42、43、49 各 1 |
| 维护失败轮次 | 2 | conv-43、48 各 1 |
| 最终待执行 / 失败工作项 | 0 / 0 | |

整理诊断与问答执行失败分开统计，相关样本照常作答并计分。逐样本状态保留在 [samples.json](samples.json) 中。

## 逐样本结果

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="../../../docs/assets/locomo-2026-11-01-samples-mobile.svg">
    <img src="../../../docs/assets/locomo-2026-11-01-samples.svg" alt="Suzu Memory 在 10 组对话、单跳、时间、多跳、开放域四类问题上的准确率热力图。总体准确率在 83.71%（conv-43）到 92.68%（conv-44）之间；conv-30 没有开放域题目。" width="1120">
  </picture>
</p>

<details>
<summary><strong>逐样本数据表</strong>（答对题数 / 题数）</summary>

<br>

| 样本 | 会话 | 原话 | 单跳 | 时间 | 多跳 | 开放域 | Suzu Memory | 准确率 | 完整对话 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| conv-26 | 19 | 419 | 68 / 70 | 35 / 37 | 28 / 32 | 9 / 13 | 140 / 152 | 92.11% | 145 |
| conv-30 | 19 | 369 | 38 / 44 | 26 / 26 | 9 / 11 | — | 73 / 81 | 90.12% | 77 |
| conv-41 | 32 | 663 | 85 / 86 | 25 / 27 | 25 / 31 | 5 / 8 | 140 / 152 | 92.11% | 149 |
| conv-42 | 29 | 629 | 104 / 111 | 36 / 40 | 29 / 37 | 6 / 11 | 175 / 199 | 87.94% | 183 |
| conv-43 | 29 | 680 | 96 / 107 | 21 / 26 | 25 / 31 | 7 / 14 | 149 / 178 | 83.71% | 163 |
| conv-44 | 28 | 675 | 62 / 62 | 22 / 24 | 27 / 30 | 3 / 7 | 114 / 123 | 92.68% | 116 |
| conv-47 | 31 | 689 | 83 / 83 | 29 / 34 | 16 / 20 | 7 / 13 | 135 / 150 | 90.00% | 137 |
| conv-48 | 30 | 681 | 109 / 118 | 38 / 42 | 17 / 21 | 9 / 10 | 173 / 191 | 90.58% | 181 |
| conv-49 | 25 | 509 | 67 / 73 | 29 / 33 | 32 / 37 | 12 / 13 | 140 / 156 | 89.74% | 143 |
| conv-50 | 30 | 568 | 80 / 87 | 29 / 32 | 30 / 32 | 6 / 7 | 145 / 158 | 91.77% | 146 |
| **合计** | **272** | **5,882** | **792 / 841** | **290 / 321** | **238 / 282** | **64 / 96** | **1384 / 1540** | **89.87%** | **1440** |

单跳至准确率各列为 Suzu Memory 的成绩，最后一列为完整对话组的答对题数。conv-30 没有开放域题目。

</details>

## 离线复核

需要 Node.js ≥22.5.0，没有第三方依赖，也不调用模型。在源码仓库根目录运行：

```sh
node benchmarks/locomo/2026-11-01/verify.mjs
```

脚本会检查文件哈希、题目唯一性、逐题裁判标签、总体与分类及样本成绩、调用预算和用量汇总。对照组还会逐题核对与记忆组的题目对应、裁判标签、分组与分类汇总、逐样本成绩、用量和逐题配对。核对通过时输出 `"status": "verified"`。

**可选：同时核对评测源码，以及自行下载的原始 `locomo10.json`**

下载本次评测的[源码包](https://github.com/eryucheng/suzu-memory/releases/download/locomo-2026-11-01/suzu-memory-locomo-2026-11-01-source.tar.gz)，解压得到 `source/` 目录，再运行：

```sh
tar -xzf suzu-memory-locomo-2026-11-01-source.tar.gz
node benchmarks/locomo/2026-11-01/verify.mjs --source-root ./source --dataset ./locomo10.json
```

| 参数 | 作用 |
| --- | --- |
| `--source-root` | 按 [source-manifest.json](source-manifest.json) 的逐文件 SHA-256 核对评测源码，范围是 `packages`、`scripts` 与根目录依赖声明 |
| `--dataset` | 核对原始数据的哈希、题目范围，以及题目与标准答案的对应关系。固定版本与 SHA-256 见[数据标识](dataset-source.json) |

源码校验时只把 CRLF 统一为 LF，以兼容不同平台的检出方式。根目录 README 与评测报告不参与源码指纹。

离线复核复算的是已记录的裁判判断，不会重新评价答案的语义。完整重跑需要配置模型服务，并重新执行建库、检索、作答和裁判调用。

## 文件与许可

| 文件 | 内容 |
| --- | --- |
| [summary.json](summary.json) | 记忆组的总体与分类成绩、用量、完整性、整理诊断和源码指纹 |
| [settings.json](settings.json) | 模型、建库、检索、作答与计分的完整参数 |
| [samples.json](samples.json) | 记忆组逐样本、逐类别的成绩与整理状态 |
| [questions.jsonl](questions.jsonl) | 记忆组逐题的题目、标准答案、实际回答、裁判标签、作答用量与每次检索的返回量 |
| [controls.json](controls.json) | 对照组的设置、分组与分类成绩、逐样本成绩、用量和逐题配对 |
| [controls-questions.jsonl](controls-questions.jsonl) | 对照组逐题的实际回答、裁判标签与作答用量，按样本与题号对应记忆组 |
| [answer-prompt.md](answer-prompt.md) · [tool-instruction.md](tool-instruction.md) | 作答提示词与工具使用说明 |
| [judge-prompt.md](judge-prompt.md) | 裁判提示词 |
| [dataset-source.json](dataset-source.json) | 数据集的仓库、提交、文件 SHA-256、许可与题目范围 |
| [source-manifest.json](source-manifest.json) | 评测源码的逐文件 SHA-256 |
| [verify.mjs](verify.mjs) · [SHA256SUMS](SHA256SUMS) | 离线复核脚本，以及本目录其余文件的校验和 |

连接凭据、服务地址、本机目录、数据库与原始请求日志都不在报告中。

题目、标准答案和类别摘自 [LoCoMo（SNAP Research）](https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376)，按其 [CC BY-NC 4.0 许可](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt)保留使用条件。本报告筛选了类别 1–4，并增加了模型回答、裁判标签和运行统计。裁判提示词来自上述 Mem0 固定版本，遵循其 [Apache-2.0 许可](https://github.com/mem0ai/mem0/blob/393a4fd5a6cfeb754857a2229726f567a9fadf36/LICENSE)。
