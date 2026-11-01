import { isProvisionalMemory as isProvisionalNode, isStructuredStateMemory as structuredStateNode } from '@suzu-memory/core';
import { memoryCalendarDate } from './temporal-ranking.mjs';
const clean = value => String(value ?? '').trim();
const CLOSED_REPORTED_STATE_LABELS = Object.freeze({
  interrupted: "已中断", completed: "已完成", cancelled: "已取消", ended: "已结束", retired: "不再适用",
});
export const closedStateLabel = phase => CLOSED_REPORTED_STATE_LABELS[phase] || '';

export function boundedText(value, maximum) {
  const text = clean(value)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, "")
    .replace(/<local-command-(?:caveat|stdout)>[\s\S]*?<\/local-command-(?:caveat|stdout)>/giu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .split(/\r?\n/gu)
    .filter((line) => clean(line) !== "NO_REPLY")
    .join("\n")
    .trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

export function joinBoundedSections(values, maximum) {
  const sections = values.map(clean).filter(Boolean);
  if (!sections.length) return "";
  const joined = sections.join("\n");
  const limit = Math.max(1, Math.trunc(Number(maximum) || 1));
  if (joined.length <= limit) return joined;
  const separatorChars = Math.max(0, sections.length - 1);
  const available = limit - separatorChars;
  if (available < sections.length) return boundedText(joined, limit);
  const base = Math.floor(available / sections.length);
  let remainder = available - base * sections.length;
  return sections.map((section) => {
    const sectionLimit = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return boundedText(section, sectionLimit);
  }).join("\n");
}

function timestampLabel(timestamp, timeZone) {
  const date = new Date(timestamp || "");
  if (!Number.isFinite(date.getTime())) return "时间不详";
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

function formatUtterance(node, options) {
  const speaker = node.metadata?.speaker || options.actorNames?.get(node.subject_key)
    || (node.subject_role === "agent" ? "我" : "对方");
  const time = node.metadata?.sourceTimeKnown === false ? "时间未知" : timestampLabel(node.event_start || node.recorded_at, options.timeZone);
  return `[${time}] ${speaker}：${boundedText(node.content, options.maximumMessageChars)}`;
}

function formatEvidenceMemory(node, options) {
  if (node.kind === "utterance") return formatUtterance(node, options);
  const time = node.metadata?.sourceTimeKnown === false ? "时间未知" : node.event_date
    || timestampLabel(node.event_start || node.recorded_at, options.timeZone);
  const kind = node.kind === "event" ? "事件"
    : node.kind === "fact" ? "事实记录"
      : node.kind === "episode" ? "事件簇"
        : "支持记忆";
  return [
    evidenceNatureLine(node, options),
    `[${time}] ${kind}：${boundedText(node.content, options.maximumMessageChars)}`,
  ].filter(Boolean).join("\n");
}

function stateEvidenceNature(node) {
  if (!node || ["not_applicable", "unspecified", ""].includes(clean(node.state_family))) {
    return "";
  }
  return {
    reported: "主体明确表达",
    inferred: "基于行为与多条证据的推断",
    established: "经过专门聚合验证；仍保留来源并允许后续修正",
  }[clean(node.representation_layer)] || "";
}

function sourceEvidenceNature(node, options) {
  if (!node || node.kind === "utterance") return "";
  const authorities = new Set(
    options.sourceAuthoritiesByMemoryId?.get(node.id) || [],
  );
  if (node.evidence_mode === "inferred" || authorities.has("model_inference")) {
    return "基于关联证据的推断";
  }
  const labels = [];
  if (authorities.has("subject_firsthand")) labels.push("主体本人陈述");
  if (authorities.has("participant_firsthand")) labels.push("直接参与者陈述");
  if (authorities.has("direct_observation")) labels.push("直接观察记录");
  if (authorities.has("external_record")) labels.push("外部记录");
  if (authorities.has("verbatim_record")) labels.push("逐字记录");
  if (authorities.has("hearsay")) labels.push("转述");
  if (labels.length) {
    return labels.join("、");
  }
  if (node.evidence_mode === "manual" || authorities.has("manual")) {
    return "经人工审核整理；事实依据仍以所连来源为准";
  }
  if (node.evidence_mode === "imported" || authorities.has("legacy_unknown")) {
    return "旧资料导入；原有来源分级不完整";
  }
  if (authorities.size) return "已关联来源，但认知来源性质尚未分级";
  return "";
}

function evidenceNatureLine(node, options) {
  if (isProvisionalNode(node) && node.metadata?.epistemicStatus === "reported_state") {
    return stateEvidenceNature(node) ? `状态性质：${stateEvidenceNature(node)}` : "";
  }
  if (isProvisionalNode(node) && node.metadata?.epistemicStatus === "source_record") {
    const nature = sourceEvidenceNature(node, options);
    return nature ? `来源性质：${nature}` : "";
  }
  if (isProvisionalNode(node)) {
    return "认知性质：这是 Agent 在相处中形成、尚未审核的个人印象；可能有偏差，不是主体确认的事实，用户可以随时纠正";
  }
  const stateNature = stateEvidenceNature(node);
  if (stateNature) return `状态性质：${stateNature}`;
  const sourceNature = sourceEvidenceNature(node, options);
  return sourceNature ? `来源性质：${sourceNature}` : "";
}

export function formatPrimary(primary, evidence, options, {
  evidenceRequested = false,
  evidenceHeading = "相关原话：",
  missingEvidenceText = "未找到与这条记忆直接关联的原话证据。",
} = {}) {
  if (primary.kind === "utterance") {
    const messages = evidence.length ? evidence : [primary];
    return joinBoundedSections(
      messages.map((node) => formatEvidenceMemory(node, options)),
      options.maximumContextChars,
    );
  }
  const time = primary.metadata?.sourceTimeKnown === false ? "时间未知"
    : options.showRecallDate && structuredStateNode(primary) && memoryCalendarDate(primary, options.timeZone)
    ? `状态记录日期：${memoryCalendarDate(primary, options.timeZone)}${primary.valid_from
      ? `；状态生效时间：${timestampLabel(primary.valid_from, options.timeZone)}${primary.valid_to
        ? ` 至 ${timestampLabel(primary.valid_to, options.timeZone)}` : ''}` : ''}`
    : structuredStateNode(primary) && primary.valid_from
    ? `状态生效时间：${timestampLabel(primary.valid_from, options.timeZone)}${primary.valid_to
      ? ` 至 ${timestampLabel(primary.valid_to, options.timeZone)}`
      : ""}`
    : primary.event_date
    ? `事件日期：${primary.event_date}（已解析）${primary.known_at
      ? `；获知时间：${timestampLabel(primary.known_at, options.timeZone)}` : ""}`
    : primary.event_start
    ? `事件时间：${timestampLabel(primary.event_start, options.timeZone)}${primary.event_end
      ? ` 至 ${timestampLabel(primary.event_end, options.timeZone)}`
      : ""}`
    : primary.kind === "topic"
    ? "长期主题"
    : primary.known_at
    ? `获知时间：${timestampLabel(primary.known_at, options.timeZone)}`
    : `记录时间：${timestampLabel(primary.recorded_at, options.timeZone)}`;
  const label = primary.kind === "episode"
    ? "事件簇"
    : primary.kind === "topic" ? "主题" : "我记得";
  const closed = options.closureLabel?.(primary);
  const primarySection = [
    options.actorNames?.get(primary.subject_key) ? `人物：${options.actorNames.get(primary.subject_key)}` : '',
    evidenceNatureLine(primary, options),
    closed ? `状态：${closed}；结束时间：${timestampLabel(primary.valid_to, options.timeZone)}` : "",
    `[${time}] ${label}：${boundedText(primary.content, Math.floor(options.maximumContextChars * (evidence.length ? 0.34 : 0.62)))}`,
  ].filter(Boolean).join("\n");
  const sections = [primarySection];
  if (evidence.length) {
    sections.push(...evidence.map((node, index) => [
      index === 0 ? evidenceHeading : "",
      formatEvidenceMemory(node, options),
    ].filter(Boolean).join("\n")));
  } else if (evidenceRequested) {
    sections.push(missingEvidenceText);
  }
  return joinBoundedSections(sections, options.maximumContextChars);
}

export function renderRecallOutput({ nodes }, options) {
  const maximum = Math.max(1, Math.trunc(Number(options.maximumContextChars) || 1));
  if (!nodes.length) return { text: '', context: '', records: [], outputBudget: {
    maximumContextChars: maximum, requiredTextChars: 0, finalTextChars: 0, sectionTruncationApplied: false } };
  const prefix = options.heading + '\n' + options.guidance + '\n\n';
  const available = Math.max(0, maximum - prefix.length);
  const sections = nodes.map(node => ({ memoryId: node.id, kind: node.kind,
    text: '记忆编号：' + node.id + '\n' + formatPrimary(node, [], { ...options, maximumContextChars: 1_000_000 }) }));
  const required = sections.map(record => record.text).join('\n\n').length;
  const minimum = sections.map(record => ('记忆编号：' + record.memoryId + '\n').length + 1);
  let included = sections.length;
  while (included && minimum.slice(0, included).reduce((sum, size) => sum + size, 0) + (included - 1) * 2 > available) included--;
  const records = sections.slice(0, included);
  const reserve = records.reduce((sum, record) => sum + ('记忆编号：' + record.memoryId + '\n').length, 0);
  const each = records.length ? Math.floor((available - reserve - Math.max(0, records.length - 1) * 2) / records.length) : 0;
  for (const record of records) {
    const label = '记忆编号：' + record.memoryId + '\n';
    record.text = label + boundedText(record.text.slice(label.length), each);
  }
  const text = records.map(record => record.text).join('\n\n');
  return { text, records, context: text ? prefix + text : '', outputBudget: {
    maximumContextChars: maximum, availableTextChars: available, requiredTextChars: required,
    budgetedTextChars: text.length, finalTextChars: text.length, sectionTruncationApplied: required > text.length, safetyTruncationApplied: false } };
}
