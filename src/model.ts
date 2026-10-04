export type ConnectionState = 'connected' | 'degraded' | 'offline';
export type SegmentState = 'pending' | 'confirmed' | 'duplicate' | 'stale' | 'ignored';
export type SegmentSource = 'live' | 'offline' | 'manual';

/** 发言人对账状态：已对账 / 名册无此人 / 名册已换人或改写法 */
export type ReconcileStatus = 'matched' | 'missing' | 'changed';
/** 发言人来源：名册领取 / 字幕台自填 / 旧数据未记录来源 */
export type SpeakerSource = 'roster' | 'manual' | 'legacy';

/** 会务组出席名册条目：正式姓名与职务由会务组侧维护 */
export interface RosterEntry {
  id: string;
  name: string;
  title: string;
  aliases: string[];
  updatedAt: number;
}

/** 会务组名册副本：字幕台只领一份，不直接改 */
export interface SpeakerRoster {
  entries: RosterEntry[];
  version: number;
  fetchedAt: number;
}

/** 旧数据回填时对不上发言人的异常条目，单列出来待处理 */
export interface BackfillException {
  segmentId: string;
  sequence: number;
  speaker: string;
  reason: string;
}

/** 名册对账（领取）状态 */
export type RosterSyncStatus = 'idle' | 'syncing' | 'synced' | 'failed';

export interface CaptionSegment {
  id: string;
  sequence: number;
  startTime: number;
  receivedAt: number;
  confirmedAt?: number;
  speaker: string;
  /** 发言人来源，旧数据可能为空，升级时回填 */
  speakerSource?: SpeakerSource;
  /** 对账匹配到的名册条目 id */
  rosterEntryId?: string;
  /** 回填的正式姓名（来自名册） */
  speakerFormalName?: string;
  /** 回填的职务（来自名册） */
  speakerTitle?: string;
  /** 发言人对账状态 */
  reconcileStatus?: ReconcileStatus;
  reconcileNote?: string;
  original: string;
  corrected: string;
  numberHints: string;
  source: SegmentSource;
  state: SegmentState;
  duplicateOf?: string;
  staleReason?: string;
  revision: number;
  tags: string[];
}

export interface TermRule {
  id: string;
  source: string;
  replacement: string;
  speaker: string;
  enabled: boolean;
  caseSensitive: boolean;
  usageCount: number;
  createdAt: number;
}

export interface DeskModel {
  eventName: string;
  eventDate: string;
  segments: CaptionSegment[];
  rules: TermRule[];
  selectedId: string;
  connection: ConnectionState;
  simulatedDelay: number;
  fontSize: number;
  nextSequence: number;
  autoStream: boolean;
  /** 会务组出席名册副本（正式姓名与职务），字幕台只领取、不维护 */
  roster: SpeakerRoster;
  /** 名册领取状态：对账失败只重领名册，不动字幕稿 */
  rosterStatus: RosterSyncStatus;
  rosterError?: string;
  /** 旧数据回填时对不上发言人的条目，单列待处理 */
  backfillExceptions: BackfillException[];
  lastMergedAt?: number;
  updatedAt: number;
}

export interface ToastMessage {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  subtitle: string;
}

const now = Date.now();
export const STORAGE_KEY = 'sologsb-1011-live-caption-desk-v1';

function segment(
  id: string,
  sequence: number,
  startTime: number,
  speaker: string,
  original: string,
  corrected = original,
  state: SegmentState = 'pending',
): CaptionSegment {
  return {
    id,
    sequence,
    startTime,
    receivedAt: now - (100 - sequence) * 8_000,
    confirmedAt: state === 'confirmed' ? now - (100 - sequence) * 7_000 : undefined,
    speaker,
    original,
    corrected,
    numberHints: '',
    source: 'live',
    state,
    revision: 0,
    tags: [],
  };
}

const seededSegments: CaptionSegment[] = [
  segment('seg-1', 1, 0, '主持人', '欢迎大家来到二零二六年产品发布会。', '欢迎大家来到2026年产品发布会。', 'confirmed'),
  segment('seg-2', 2, 7, '主讲人', '今天我们会介绍三个模块,首先是实时协作。', '今天我们会介绍三个模块，首先是实时协作。', 'confirmed'),
  segment('seg-3', 3, 15, '主讲人', '延迟和质量监测会帮助我们保持字幕稳定。', '延迟和质量监测会帮助我们保持字幕稳定。', 'confirmed'),
  segment('seg-4', 4, 24, '嘉宾 / 周然', '我们使用 studio cloud 作为演示环境。', '我们使用 Studio Cloud 作为演示环境。', 'pending'),
  segment('seg-5', 5, 34, '嘉宾 / 周然', '每分钟大约会收到一百二十个片段。', '每分钟大约会收到120个片段。', 'pending'),
  segment('seg-6', 6, 43, '主持人', '如果主持人提到 co pilot,需要统一大小写。', '如果主持人提到 Co-Pilot，需要统一大小写。', 'pending'),
  segment('seg-7', 7, 52, '主持人', '这个例子会演示五G网络下的字幕恢复。', '这个例子会演示5G网络下的字幕恢复。', 'pending'),
];

const duplicate: CaptionSegment = {
  ...segment('seg-8', 8, 61, '主讲人', '今天我们重点讨论字幕队列。', '今天我们重点讨论字幕队列。', 'duplicate'),
  source: 'live',
  duplicateOf: 'seg-2',
  staleReason: '与第 2 段高度相似',
};

/** 旧数据里挂了「现场提问」，名册中没有对应正式姓名，升级时回填不上、单列出来 */
const legacyUnmatched: CaptionSegment = segment(
  'seg-9', 9, 70, '现场提问',
  '现场观众的声音也需要收录进字幕。', '现场观众的声音也需要收录进字幕。',
  'pending',
);

/** 会务组出席名册默认副本：正式姓名与职务由会务组侧维护，字幕台只领取使用 */
export function createDefaultRoster(): SpeakerRoster {
  const now = Date.now();
  return {
    version: 1,
    fetchedAt: now,
    entries: [
      { id: 'r-1', name: '李婷', title: '主持人', aliases: ['主持人', '主持'], updatedAt: now },
      { id: 'r-2', name: '陈杰', title: '技术副总裁', aliases: ['主讲人', '主讲', '主讲嘉宾'], updatedAt: now },
      { id: 'r-3', name: '周然', title: '高级工程师', aliases: ['嘉宾', '周工'], updatedAt: now },
      { id: 'r-4', name: '王芳', title: '市场总监', aliases: ['市场', '市场部'], updatedAt: now },
    ],
  };
}

export function createInitialModel(): DeskModel {
  const model: DeskModel = {
    eventName: '新品发布会现场字幕',
    eventDate: new Date(now).toISOString().slice(0, 10),
    segments: [...seededSegments, duplicate, legacyUnmatched],
    rules: [
      { id: 'term-1', source: 'co pilot', replacement: 'Co-Pilot', speaker: '', enabled: true, caseSensitive: false, usageCount: 4, createdAt: now - 86_400_000 },
      { id: 'term-2', source: 'studio cloud', replacement: 'Studio Cloud', speaker: '', enabled: true, caseSensitive: false, usageCount: 7, createdAt: now - 43_200_000 },
      { id: 'term-3', source: '五G', replacement: '5G', speaker: '', enabled: true, caseSensitive: true, usageCount: 2, createdAt: now - 3_600_000 },
    ],
    selectedId: 'seg-4',
    connection: 'connected',
    simulatedDelay: 1.8,
    fontSize: 18,
    nextSequence: 10,
    autoStream: true,
    roster: createDefaultRoster(),
    rosterStatus: 'synced',
    backfillExceptions: [],
    updatedAt: now,
  };
  // 演示数据同样按旧数据回填：对得上名册的记为名册来源，对不上的列入回填异常
  return backfillLegacySpeakers(model);
}

export function cloneModel(model: DeskModel): DeskModel {
  return structuredClone(model);
}

/**
 * 按片段挂的姓名在会务组名册里逐条对账。
 * 匹配规则：正式姓名精确相等 / 别名相等 / 挂名包含正式姓名或别名（如「嘉宾 / 周然」含「周然」）。
 */
export function matchSpeaker(speaker: string | undefined, roster: SpeakerRoster): RosterEntry | undefined {
  const name = (speaker ?? '').trim();
  if (!name) return undefined;
  return roster.entries.find((entry) => {
    if (entry.name === name) return true;
    if (entry.aliases.some((alias) => alias === name)) return true;
    if (entry.name.length >= 2 && name.includes(entry.name)) return true;
    if (entry.aliases.some((alias) => alias.length >= 2 && name.includes(alias))) return true;
    return false;
  });
}

/** 挂名是否引用了某个正式姓名（精确相等或包含，如「嘉宾 / 周然」引用「周然」） */
function speakerReferences(speaker: string, name: string): boolean {
  const value = speaker.trim();
  if (value === name) return true;
  return name.length >= 2 && value.includes(name);
}

/** 单条片段对账：名册里没有 → missing；以前对得上现在对不上（换人/改写法）→ changed */
export function reconcileSegment(segment: CaptionSegment, roster: SpeakerRoster): CaptionSegment {
  const match = matchSpeaker(segment.speaker, roster);
  if (match) {
    const previousEntry = segment.rosterEntryId
      ? roster.entries.find((entry) => entry.id === segment.rosterEntryId)
      : undefined;
    // 以前对得上某个名册条目：该条目被删，或其正式姓名已不被挂名引用（换人/改写法）→ changed
    const entryRemoved = previousEntry === undefined && segment.rosterEntryId !== undefined;
    const nameChanged = previousEntry !== undefined && !speakerReferences(segment.speaker, previousEntry.name);
    const changed = entryRemoved || nameChanged;
    return {
      ...segment,
      rosterEntryId: match.id,
      speakerFormalName: match.name,
      speakerTitle: match.title,
      reconcileStatus: changed ? 'changed' : 'matched',
      reconcileNote: changed
        ? `名册已变更：原「${segment.speakerFormalName ?? segment.speaker}」已替换为「${match.name}」`
        : undefined,
    };
  }
  const wasMatched = segment.rosterEntryId !== undefined;
  return {
    ...segment,
    reconcileStatus: wasMatched ? 'changed' : 'missing',
    reconcileNote: wasMatched
      ? '名册中已无此发言人，可能已换人或改写法'
      : '名册中没有此发言人，待会务组确认',
  };
}

/**
 * 全量对账：只动未上屏（pending/stale/duplicate）的片段；
 * 已上屏（confirmed）和已忽略的照旧留着，不暂停、不改写。
 */
export function reconcileSpeakers(model: DeskModel): DeskModel {
  const segments = model.segments.map((segment) => {
    if (segment.state === 'confirmed' || segment.state === 'ignored') return segment;
    return reconcileSegment(segment, model.roster);
  });
  return {
    ...model,
    segments,
    backfillExceptions: collectBackfillExceptions(segments),
    updatedAt: Date.now(),
  };
}

/** 收集旧数据回填时对不上发言人的条目，单列出来 */
export function collectBackfillExceptions(segments: CaptionSegment[]): BackfillException[] {
  return segments
    .filter((segment) => segment.speakerSource === 'legacy' && segment.reconcileStatus === 'missing')
    .map((segment) => ({
      segmentId: segment.id,
      sequence: segment.sequence,
      speaker: segment.speaker,
      reason: '旧数据未记录发言人来源，且名册中无对应正式姓名',
    }));
}

/**
 * 升级旧数据：按现有片段回填发言人来源。
 * 对得上名册 → speakerSource='roster' 并回填正式姓名/职务；
 * 对不上 → speakerSource='legacy' 并列入 backfillExceptions。
 */
export function backfillLegacySpeakers(model: DeskModel): DeskModel {
  const segments = model.segments.map((segment) => {
    if (segment.speakerSource) return segment;
    const match = matchSpeaker(segment.speaker, model.roster);
    if (match) {
      return {
        ...segment,
        speakerSource: 'roster' as SpeakerSource,
        rosterEntryId: match.id,
        speakerFormalName: match.name,
        speakerTitle: match.title,
        reconcileStatus: 'matched' as ReconcileStatus,
      };
    }
    return {
      ...segment,
      speakerSource: 'legacy' as SpeakerSource,
      reconcileStatus: 'missing' as ReconcileStatus,
      reconcileNote: '旧数据回填：名册中无此发言人',
    };
  });
  return { ...model, segments, backfillExceptions: collectBackfillExceptions(segments), updatedAt: Date.now() };
}

/** 领取到新名册后对账：名册副本更新，字幕稿不动，只按挂名逐条对账 */
export function applyRoster(model: DeskModel, roster: SpeakerRoster): DeskModel {
  const reconciled = reconcileSpeakers({ ...model, roster, rosterStatus: 'synced', rosterError: undefined });
  return { ...reconciled, backfillExceptions: collectBackfillExceptions(reconciled.segments) };
}

/** 名册领取失败：只记录失败状态，字幕稿与旧名册都不动，等重领 */
export function rosterSyncFailed(model: DeskModel, error: string): DeskModel {
  return { ...model, rosterStatus: 'failed', rosterError: error, updatedAt: Date.now() };
}

/**
 * 读取本地草稿后的升级：补齐名册字段，并对旧数据回填发言人来源。
 * 旧数据没有 roster / speakerSource，升级时按现有片段回填，回不上的列入 backfillExceptions。
 */
export function migrateModel(parsed: Partial<DeskModel>): DeskModel {
  const base = createInitialModel();
  const merged: DeskModel = {
    ...base,
    ...parsed,
    roster: parsed.roster ?? base.roster,
    rosterStatus: parsed.rosterStatus ?? 'synced',
    rosterError: parsed.rosterError,
    backfillExceptions: parsed.backfillExceptions ?? [],
  };
  return backfillLegacySpeakers(merged);
}

/** 待确认片段是否因发言人对不上而挂起（挂起期间不送直播区） */
export function isSuspended(segment: CaptionSegment): boolean {
  return (segment.state === 'pending' || segment.state === 'stale') && segment.reconcileStatus !== 'matched';
}

/** 编辑发言人后重跑这一条的对账；来源按是否对得上名册判定 */
export function reassignSpeaker(segments: CaptionSegment[], selectedId: string, speaker: string, roster: SpeakerRoster): CaptionSegment[] {
  return segments.map((segment) => {
    if (segment.id !== selectedId) return segment;
    const match = matchSpeaker(speaker, roster);
    const base: CaptionSegment = {
      ...segment,
      speaker,
      speakerSource: match ? 'roster' : 'manual',
      revision: segment.revision + 1,
    };
    return reconcileSegment(base, roster);
  });
}

export function normalizeNumbers(text: string): string {
  const digitMap: Record<string, string> = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9' };
  const chineseNumber = (raw: string): number => {
    const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (!/[十百千万]/u.test(raw)) return Number([...raw].map((char) => digits[char] ?? 0).join(''));
    let total = 0;
    let section = 0;
    let number = 0;
    for (const char of raw) {
      if (digits[char] !== undefined) {
        number = digits[char];
      } else if (char === '十') {
        section += (number || 1) * 10;
        number = 0;
      } else if (char === '百') {
        section += (number || 1) * 100;
        number = 0;
      } else if (char === '千') {
        section += (number || 1) * 1000;
        number = 0;
      } else if (char === '万') {
        total += (section + number) * 10_000;
        section = 0;
        number = 0;
      }
    }
    return total + section + number;
  };

  return text
    .replace(/[０-９]/g, (char) => digitMap[char] ?? char)
    .replace(/([零〇一二两三四五六七八九十百千万]+)/gu, (match) => String(chineseNumber(match)))
    .replace(/(?<=\d)[，,](?=\d{3}\b)/g, ',');
}

export function normalizePunctuation(text: string): string {
  return text
    .replace(/([，。！？；：])(?=[^\s，。！？；：])/gu, '$1')
    .replace(/\s+([，。！？；：])/gu, '$1')
    .replace(/([,;:!?])(?=[^\s,;:!?])/g, (match) => ({ ',': '，', ';': '；', ':': '：', '!': '！', '?': '？' }[match] ?? match));
}

export function applyRules(text: string, model: DeskModel): { text: string; used: string[] } {
  let next = text;
  const used: string[] = [];
  for (const rule of model.rules.filter((item) => item.enabled)) {
    if (!rule.source || !next) continue;
    const flags = rule.caseSensitive ? 'g' : 'gi';
    const expression = new RegExp(rule.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    if (expression.test(next)) {
      next = next.replace(expression, rule.replacement);
      used.push(rule.id);
    }
  }
  return { text: normalizePunctuation(next), used };
}

export function isDuplicate(candidate: CaptionSegment, existing: CaptionSegment[]): CaptionSegment | undefined {
  const normalize = (value: string) => value.replace(/[\s，。！？；：,.;:!?]/g, '').toLocaleLowerCase();
  const candidateText = normalize(candidate.corrected || candidate.original);
  return existing.find((segmentItem) => {
    if (segmentItem.id === candidate.id || segmentItem.state === 'ignored') return false;
    const text = normalize(segmentItem.corrected || segmentItem.original);
    if (!candidateText || !text) return false;
    return text === candidateText || (Math.abs(segmentItem.startTime - candidate.startTime) < 12 && (text.includes(candidateText) || candidateText.includes(text)));
  });
}

export function mergeConfirmedSegments(model: DeskModel): DeskModel {
  const seen: string[] = [];
  const segments = model.segments
    .map((item) => ({ ...item }))
    .sort((a, b) => a.sequence - b.sequence || a.startTime - b.startTime)
    .map((item): CaptionSegment => {
      if (item.source === 'offline' && item.state === 'confirmed') {
        item.source = item.confirmedAt && Date.now() - item.confirmedAt > 90_000 ? 'offline' : 'live';
        item.staleReason = Date.now() - item.receivedAt > 90_000 ? `离线恢复后合并，原始片段已延迟 ${Math.round((Date.now() - item.receivedAt) / 1000)} 秒` : undefined;
        if (item.staleReason) item.state = 'stale';
      }
      const duplicate = isDuplicate(item, seen.map((id) => model.segments.find((segmentItem) => segmentItem.id === id)).filter(Boolean) as CaptionSegment[]);
      if (duplicate && item.state !== 'confirmed') {
        item.state = 'duplicate';
        item.duplicateOf = duplicate.id;
      }
      if (item.state !== 'ignored') seen.push(item.id);
      return item;
    });

  return reconcileSpeakers({
    ...model,
    segments,
    connection: 'connected',
    simulatedDelay: Math.max(0.8, model.simulatedDelay - 0.7),
    lastMergedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

export function queueStats(model: DeskModel) {
  const pending = model.segments.filter((item) => item.state === 'pending');
  const stale = model.segments.filter((item) => item.state === 'stale');
  const duplicate = model.segments.filter((item) => item.state === 'duplicate');
  const offline = model.segments.filter((item) => item.source === 'offline' && item.state === 'confirmed');
  const suspended = model.segments.filter((item) => isSuspended(item)).length;
  return {
    pending: pending.length,
    stale: stale.length,
    duplicate: duplicate.length,
    offline: offline.length,
    suspended,
    backlog: pending.length + stale.length + duplicate.length + offline.length,
    oldestWaitSeconds: pending.length ? Math.max(...pending.map((item) => Math.round((Date.now() - item.receivedAt) / 1000))) : 0,
  };
}

export function createLiveSegment(sequence: number, roster: SpeakerRoster): CaptionSegment {
  const speakers = ['主持人', '主讲人', '嘉宾 / 周然', '现场提问'];
  const samples = [
    '接下来请产品团队介绍新的工作流。',
    '请注意屏幕右侧的实时队列状态。',
    '在弱网环境下我们会保留未确认片段。',
    '如果网络恢复,系统会按照时间顺序自动合并。',
    '这段字幕包含二零二五年的项目数据。',
    '大家可以在会后查看完整回放和术语表。',
  ];
  const start = Math.max(0, sequence * 9 - 10);
  const speaker = speakers[(sequence - 1) % speakers.length];
  const match = matchSpeaker(speaker, roster);
  return {
    id: `seg-live-${sequence}-${Date.now().toString(36)}`,
    sequence,
    startTime: start,
    receivedAt: Date.now(),
    speaker,
    speakerSource: match ? 'roster' : 'manual',
    rosterEntryId: match?.id,
    speakerFormalName: match?.name,
    speakerTitle: match?.title,
    reconcileStatus: match ? 'matched' : 'missing',
    reconcileNote: match ? undefined : '名册中没有此发言人，待会务组确认',
    original: samples[(sequence - 1) % samples.length],
    corrected: samples[(sequence - 1) % samples.length],
    numberHints: '',
    source: 'live',
    state: 'pending',
    revision: 0,
    tags: [],
  };
}

export function simulateLatency(model: DeskModel): DeskModel {
  if (model.connection === 'offline') return model;
  const step = model.connection === 'degraded' ? 0.7 : model.simulatedDelay > 2.8 ? -0.3 : 0.15;
  const delay = Math.max(0.7, Math.min(8.9, Number((model.simulatedDelay + step).toFixed(1))));
  const applyStream = model.autoStream && Math.random() > 0.68;
  let nextSequence = model.nextSequence;
  let segments = model.segments;
  if (applyStream) {
    const candidate = createLiveSegment(model.nextSequence, model.roster);
    const duplicate = isDuplicate(candidate, segments);
    segments = [...segments, duplicate ? { ...candidate, state: 'duplicate', duplicateOf: duplicate.id, staleReason: `与第 ${duplicate.sequence} 段重复` } : candidate];
    nextSequence += 1;
  }
  const pendingCutoff = Date.now() - 90_000;
  segments = segments.map((item) => item.state === 'pending' && item.receivedAt < pendingCutoff
    ? { ...item, state: 'stale', staleReason: `片段已等待 ${Math.round((Date.now() - item.receivedAt) / 1000)} 秒` }
    : item);
  return {
    ...model,
    segments,
    nextSequence,
    simulatedDelay: delay,
    connection: delay > 4.2 ? 'degraded' : model.connection,
    updatedAt: Date.now(),
  };
}

export function toSrt(model: DeskModel): string {
  const stamp = (seconds: number, separator = ',') => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
  };
  return model.segments
    .filter((item) => item.state === 'confirmed')
    .sort((a, b) => a.startTime - b.startTime)
    .map((item, index) => `${index + 1}\n${stamp(item.startTime)} --> ${stamp(item.startTime + 7)}\n[${item.speaker}] ${item.corrected}\n`)
    .join('\n');
}
