# 接入题库与运行评测

统一跑分入口复用配置工厂、聊天宿主适配器、分批整理、只读服务和 Agent 检索工具。题库适配器负责把原始数据转成下列格式，并提供该题库的评分规则。

## 运行

在源码仓库安装依赖后：

```sh
node packages/evaluation/src/benchmark-cli.mjs \
  --dataset ./examples/benchmark/dataset.json \
  --config ./suzu-memory.local.json \
  --output ./runtime/benchmark-example \
  --concurrency 3 --open-progress
```

安装 npm 插件包后，也可以独立运行，不需要启动 DSH：

```sh
npm install dsh-suzu-memory
npx suzu-memory-benchmark --dataset ./dataset.json --config ./memory.json --output ./results --open-progress
```

`--progress` 只输出本地进度地址；`--open-progress` 同时打开浏览器进度窗口。页面通过事件流增量更新，显示当前阶段、并发请求数、完成数、成绩、检索次数和输入 token。运行完成或中止后，进度服务关闭，已打开页面保留最后结果。命令行按题输出进展，不清屏、不反复重绘。

`--concurrency` 同时限制整个运行的实际 HTTP 请求数与并发答题数；不同样本可以并行建库，同一历史位置的问题可以并行答题。整理中的请求、向量请求、答题和使用内置 completion 的裁判请求共用 HTTP 上限。

## 数据格式

```json
{
  "version": 1,
  "name": "Example",
  "answerInstruction": "Answer A or B only.",
  "samples": [{
    "id": "sample-1",
    "identity": {
      "primaryUserId": "avery", "primaryUserName": "Avery",
      "companionId": "robin", "companionName": "Robin"
    },
    "turns": [{
      "sessionId": "chat-1", "turnId": "1",
      "recordedAt": "2026-01-01T10:00:00Z",
      "userMessage": { "text": "My cat is called Cedar." },
      "assistantMessage": { "text": "Cedar is your cat's name." }
    }],
    "questions": [{
      "id": "q1", "cutoff": 1, "now": "2026-01-02T10:00:00Z",
      "question": "What is the cat's name? A: Cedar; B: Maple.",
      "reference": "A", "category": "single-hop"
    }]
  }]
}
```

- `turns` 按记录时间排序。可以只有用户或助手消息。消息可分别指定 `occurredAt`、`knownAt`，省略时沿用 `recordedAt`；所有时间须包含时区。
- `cutoff` 是允许使用的前多少轮对话，省略时使用该样本全部轮次。题目不能看到截止点之后的消息，也不能看到 `now` 之后才记录的消息。
- 一份样本使用一个独立记忆库，身份、世界和会话来自该样本。跨多名用户或多种空间的题库应由适配器按自身身份语义映射。
- `reference` 只传给评分器；题目、参考答案和任意题库元数据不会被写入对话事件。默认精确评分接受字符串或多个可接受字符串组成的数组，忽略大小写、首尾空白和连续空白差异。
- `answerInstruction` 是该题库的作答要求，三组使用相同内容。开放题应提供题库对应的评分器。

## 检索与对照

默认 `--modes memory`。三组一起运行时：

```sh
npx suzu-memory-benchmark --dataset ./dataset.json --config ./memory.json --output ./results \
  --modes memory,no-memory,full-history --concurrency 3 --open-progress
```

| 模式 | 提供的材料 | 检索工具 |
| --- | --- | --- |
| `memory` | 记忆库；可通过 `--recent-turns` 增加最近原文，默认 0 轮 | 默认必须先检索，自选查询与补查 |
| `no-memory` | 当前问题 | 不提供 |
| `full-history` | 允许范围内全部原文，含日期与姓名，不截断 | 不提供 |

记忆组首轮指定调用检索工具；执行层拒绝未经检索的最终答案，并将该题记为失败。需要研究模型自行决定是否检索时，显式使用 `--allow-no-search`。每道题新建检索会话，默认最多 6 次工具调用，每次返回数量和字符预算沿用配置中的 `defaults.retrieval`，不会为跑分另造 Top-K 或字符上限。同题多次查询共享已返回证据，跳过已返回的记录。

配置中的生成与向量连接用于建库和查询，生成连接同时用于默认答题。模型、输出上限、思考设置与额外请求参数沿用原配置。实际生效的服务默认值写入各样本状态；运行设置、逐题工具记录和请求用量写入报告。

## 历史推进与续跑

同一样本按 `cutoff` 从小到大推进。写入时沿用原生长度分批整理；到题目截止点后整理尾部，再以只读服务答题。同一截止点的所有题与对照结束后，才继续写后面的历史。整个过程不复制记忆库快照。

```sh
npx suzu-memory-benchmark --dataset ./dataset.json --config ./memory.json --output ./results --resume
```

续跑核对题库、引擎源码、模型配置、检索与评分设置，保留已完成的逐题结果和累计请求用量。当前历史截止点的未完成题可接着回答；已提交结果不重复调用模型。答案在判分前独立保存，判分中断后续跑只补评分，不再整理、检索或重新作答；尚未保存答案的题会重新作答。更换实验参数使用新的输出目录。

输出目录保存 `run.json`、`requests.jsonl`、`progress.json`、`answers/` 与各样本的独立数据库、整理日志和小体积进度状态。`responses/` 暂存已作答但尚未完成评分的结果，最终结果保存后移除对应暂存文件。请求记录包含阶段、结构化任务名称、模型和原始用量，可分别核算抽取、修复、人物分析、事件延续、归纳与向量化。请求与逐题结果增量写入；`report.json` 在完成或中止时汇总，不随每个请求重写整份记录。运行锁防止两个进程同时改同一目录。Ctrl+C 会中止请求、保存部分结果并释放本次进度服务；异常退出留下的锁在续跑时核对原进程是否已退出。

答题或评分失败只影响对应题，按错计分。建库中的隔离、原文降级、未完成分析等质量问题保留诊断并参加评分；建库遭遇未恢复的网络、鉴权、限流或额度等基础设施故障时，该记忆组题目标为未计分。鉴权或额度故障立即停止，连续三次同类基础设施失败也停止并保留部分报告。报告同时列出完成数、失败数、未计分数与待完成数。

## 使用题库自己的评分器

通过 `--grader ./grader.mjs` 加载模块，其内容可以复用官方评分函数：

```js
export async function grade({ question, reference, answer, category, complete, signal }) {
  // 在这里调用题库的评分实现。需要模型裁判时使用 complete，复用连接、并发与请求统计。
  return { correct: answer.trim() === reference };
}
```

评分器必须返回 `{ correct: boolean }`，还可附带理由等字段。`complete(messages, { json: true, signal })` 返回 `{ message, model, usage }`，支持普通文本、JSON 与函数工具。评分器在答题结束后才接收参考答案。

## 程序接口

```js
import { runMemoryBenchmark } from '@suzu-memory/evaluation/benchmark';
// npm 插件安装者使用：import { runMemoryBenchmark } from 'dsh-suzu-memory/benchmark';

const report = await runMemoryBenchmark({
  dataset, config: './memory.json', outputDirectory: './results',
  concurrency: 3, modes: ['memory'],
  onProgress: state => console.log(state.summary.finished),
});
```

已有第三方跑分器可以直接使用插件的基础接口，不必采用这里的数据格式：

```js
import { createMemoryServiceFromConfig, createChatHostMemoryAdapter,
  createMemorySearchSession } from 'dsh-suzu-memory/memory';
import { answerWithMemoryTools } from 'dsh-suzu-memory/benchmark';
```

这些入口不会启动 DSH，也不会注册插件。第三方可以传入自己的 `complete` 和评分函数；使用自定义评分函数时同时指定稳定的 `graderId`，以便核对续跑条件。报告包含对话和模型输出，适合本地分析；对外分享前应按数据内容脱敏。连接密钥与认证请求头不会写入运行设置或请求记录。
