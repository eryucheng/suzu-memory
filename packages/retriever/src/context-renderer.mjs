import { isStructuredStateMemory as structuredStateNode } from '@suzu-memory/core';
import { createHash } from 'node:crypto';
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
  const limits = allocateTextLengths(sections.map(section => section.length), available);
  return sections.map((section, index) => boundedText(section, limits[index])).join("\n");
}

function allocateTextLengths(lengths, available) {
  const limits = new Array(lengths.length);
  const shortestFirst = lengths.map((length, index) => ({ length, index })).sort((a, b) => a.length - b.length);
  for (const [position, { length, index }] of shortestFirst.entries()) {
    const limit = Math.min(length, Math.floor(available / (lengths.length - position)));
    limits[index] = limit;
    available -= limit;
  }
  return limits;
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

function realityLabel(node) {
  if (node.world_frame === 'dream') return '[梦境] ';
  return ({ fictional: '[虚构] ', hypothetical: '[假设] ', roleplay: '[角色扮演] ', unknown: '[现实属性未知] ' })[node.reality] || '';
}

function formatUtterance(node, options) {
  const speaker = node.metadata?.speaker || options.actorNames?.get(node.subject_key)
    || (node.subject_role === "agent" ? "我" : "对方");
  const time = node.metadata?.sourceTimeKnown === false ? "时间未知" : timestampLabel(node.event_start || node.recorded_at, options.timeZone);
  return `${realityLabel(node)}[${time}] ${speaker}：${boundedText(node.content, options.maximumMessageChars ?? options.maximumContextChars)}`;
}

function formatEvidenceMemory(node, options) {
  if (node.kind === "utterance") return formatUtterance(node, options);
  const time = node.metadata?.sourceTimeKnown === false ? "时间未知" : node.event_date
    || timestampLabel(node.event_start || node.recorded_at, options.timeZone);
  return `[${time}] ${formatStatement(node, options, options.maximumMessageChars ?? options.maximumContextChars)}`;
}

function stateEvidenceNature(node) {
  if (!node || ["not_applicable", "unspecified", ""].includes(clean(node.state_family))) {
    return "";
  }
  return {
    reported: "自述",
    inferred: "推断",
  }[clean(node.representation_layer)] || "";
}

function sourceEvidenceNature(node, options) {
  if (!node || node.kind === "utterance") return "";
  const authorities = new Set(
    options.sourceAuthoritiesByMemoryId?.get(node.id) || [],
  );
  if (node.evidence_mode === "inferred" || authorities.has("model_inference")) {
    return "推断";
  }
  const labels = [];
  if (authorities.has("subject_firsthand")) labels.push("自述");
  if (authorities.has("participant_firsthand")) labels.push("参与者陈述");
  if (authorities.has("direct_observation")) labels.push("观察记录");
  if (authorities.has("external_record")) labels.push("外部记录");
  if (authorities.has("verbatim_record")) labels.push("逐字记录");
  if (authorities.has("hearsay")) labels.push("转述");
  return labels.join("、");
}

function formatStatement(node, options, maximum) {
  const content = boundedText(node.content, maximum);
  const name = clean(options.actorNames?.get(node.subject_key));
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const namesSubject = name && new RegExp(`(?<![\\p{Script=Latin}\\p{N}_])${escapedName}(?![\\p{Script=Latin}\\p{N}_])`, 'u').test(content);
  const subject = namesSubject ? '' : name;
  const nature = stateEvidenceNature(node) || sourceEvidenceNature(node, options);
  if (nature === '自述') return `${realityLabel(node)}${subject}自述：${content}`;
  const label = nature ? `${nature}${subject ? `（关于${subject}）` : ''}` : subject ? `关于${subject}` : '';
  return `${realityLabel(node)}${label ? `${label}：${content}` : content}`;
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
    ? `事件日期：${primary.event_date}${primary.known_at
      ? `；获知时间：${timestampLabel(primary.known_at, options.timeZone)}` : ""}`
    : primary.event_start
    ? `事件时间：${timestampLabel(primary.event_start, options.timeZone)}${primary.event_end
      ? ` 至 ${timestampLabel(primary.event_end, options.timeZone)}`
      : ""}`
    : primary.kind === "topic"
    ? ""
    : primary.known_at
    ? `获知时间：${timestampLabel(primary.known_at, options.timeZone)}`
    : `记录时间：${timestampLabel(primary.recorded_at, options.timeZone)}`;
  const closed = options.closureLabel?.(primary);
  const primarySection = [
    closed ? `状态：${closed}；结束时间：${timestampLabel(primary.valid_to, options.timeZone)}` : "",
    `${time ? `[${time}] ` : ''}${formatStatement(primary, options, options.maximumContextChars)}`,
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

export function fitRecallRecords(sections, maximum) {
  const available = Math.max(0, Math.trunc(Number(maximum) || 0));
  const required = sections.map(record => record.text).join('\n\n').length;
  const minimum = sections.map(record => ('记忆编号：' + record.memoryId + '\n').length + 1);
  let included = sections.length;
  while (included && minimum.slice(0, included).reduce((sum, size) => sum + size, 0) + (included - 1) * 2 > available) included--;
  const records = sections.slice(0, included).map(record => ({ ...record }));
  const reserve = records.reduce((sum, record) => sum + ('记忆编号：' + record.memoryId + '\n').length, 0);
  const bodies = records.map(record => {
    const body = record.text.slice(('记忆编号：' + record.memoryId + '\n').length);
    // A previous fit may already have added an ellipsis. It is presentation,
    // rather than a character consumed from the source.
    return record.nextOffset == null ? body : body.slice(0, record.nextOffset - (record.textOffset || 0));
  });
  const lengths = bodies.map(body => body.length);
  const limits = allocateTextLengths(lengths, available - reserve - Math.max(0, records.length - 1) * 2);
  for (const [index, record] of records.entries()) {
    const label = '记忆编号：' + record.memoryId + '\n';
    const body = bodies[index], offset = record.textOffset || 0;
    const sourceLength = record.sourceTextLength ?? offset + body.length;
    const incomplete = offset + body.length < sourceLength || body.length > limits[index];
    const count = Math.min(body.length, Math.max(1, limits[index] - (incomplete && limits[index] > 1 ? 1 : 0)));
    record.text = label + body.slice(0, count) + (incomplete && limits[index] > 1 ? '…' : '');
    record.textOffset = offset;
    record.sourceTextLength = sourceLength;
    record.nextOffset = offset + count < sourceLength ? offset + count : null;
  }
  const text = records.map(record => record.text).join('\n\n');
  return { text, records, requiredTextChars: required, sectionTruncationApplied: required > text.length };
}

export function renderRecallOutput({ nodes }, options) {
  const maximum = Math.max(1, Math.trunc(Number(options.maximumContextChars) || 1));
  if (!nodes.length) return { text: '', context: '', records: [], outputBudget: {
    maximumContextChars: maximum, requiredTextChars: 0, finalTextChars: 0, sectionTruncationApplied: false } };
  const intro = [options.heading, options.guidance].map(clean).filter(Boolean).join('\n');
  const prefix = intro ? intro + '\n\n' : '';
  const available = Math.max(0, maximum - prefix.length);
  const sections = nodes.map(node => {
    const body = formatPrimary(node, [], { ...options,
      maximumContextChars: Number.MAX_SAFE_INTEGER, maximumMessageChars: Number.MAX_SAFE_INTEGER });
    const textVersion = createHash('sha256').update(body).digest('hex');
    const position = options.recordOffsets?.[node.id];
    const requestedOffset = position?.textVersion === textVersion ? position.offset : 0;
    const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? Math.min(requestedOffset, body.length) : 0;
    const record = { memoryId: node.id, kind: node.kind, textVersion, textOffset: offset, sourceTextLength: body.length,
      text: '记忆编号：' + node.id + '\n' + body.slice(offset) };
    if (node.kind === 'utterance' && Number.isFinite(options.maximumMessageChars) && options.maximumMessageChars > 0) {
      return fitRecallRecords([record], ('记忆编号：' + node.id + '\n').length + options.maximumMessageChars).records[0];
    }
    return record;
  });
  const output = fitRecallRecords(sections, available);
  return { text: output.text, records: output.records, context: output.text ? prefix + output.text : '', outputBudget: {
    maximumContextChars: maximum, availableTextChars: available, requiredTextChars: output.requiredTextChars,
    budgetedTextChars: output.text.length, finalTextChars: output.text.length,
    sectionTruncationApplied: output.sectionTruncationApplied, safetyTruncationApplied: false } };
}
