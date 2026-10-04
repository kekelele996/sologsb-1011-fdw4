export type ConnectionState = 'connected' | 'degraded' | 'offline';
export type SegmentState = 'pending' | 'confirmed' | 'duplicate' | 'stale' | 'held' | 'ignored';
export type SegmentSource = 'live' | 'offline' | 'manual';
export type RosterSyncState = 'synced' | 'refetch-failed' | 'offline-pending';

/** 会务组名册中的一条正式记录：正式姓名与职务只归名册管。 */
export interface RosterEntry {
  id: string;
  officialName: string;
  title: string;
  /** 片段上可能挂的其他写法（简称、口头称呼等），逐条对账时按别名认人。 */
  aliases: string[];
  active: boolean;
  /** 被换人时指向接手的新条目，挂着旧称呼的片段据此挂起并提示改挂。 */
  replacedBy?: string;
}

/** 会务组持有的那份出席名册，独立于字幕稿存取。 */
export interface RosterModel {
  versionName: string;
  serverVersion: number;
  entries: RosterEntry[];
  syncState: RosterSyncState;
  lastError?: string;
  receivedAt: number;
  syncedAt: number;
}

/** 片段对账成功后，从名册侧映上去的正式信息快照；字幕侧不手抄职务。 */
export interface SpeakerResolution {
  entryId: string;
  officialName: string;
  title: string;
  resolvedAt: number;
}

export interface CaptionSegment {
  id: string;
  sequence: number;
  startTime: number;
  receivedAt: number;
  confirmedAt?: number;
  /** 片段上挂的姓名（字幕台持有，可改），对账就按它逐条核。 */
  speaker: string;
  /** 发言人来源键：旧数据没有，升级时按现有片段回填。 */
  speakerKey: string;
  /** 对账命中名册后挂上的正式姓名/职务快照；名册未命中则为空。 */
  speakerResolved?: SpeakerResolution;
  /** 挂起或已上屏但对不上名册时的说明。 */
  holdReason?: string;
  /** 挂起前所处状态，名册确认改挂后恢复回原状态。 */
  heldFromState?: SegmentState;
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

/** 旧数据升级回填的结果报告；回不上的片段单列在这里。 */
export interface MigrationReport {
  migratedAt: number;
  fromVersion: number;
  backfilled: number;
  unresolved: {
    segmentId: string;
    sequence: number;
    speaker: string;
    /** true = 升级前已上屏，按规则照旧保留，只单列不挂起。 */
    onScreen: boolean;
  }[];
  acknowledged: boolean;
}

export interface DeskModel {
  schemaVersion: number;
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
  lastMergedAt?: number;
  migration?: MigrationReport;
  updatedAt: number;
}

export interface ToastMessage {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  subtitle: string;
}

const now = Date.now();
export const CURRENT_SCHEMA_VERSION = 2;
export const STORAGE_KEY = 'sologsb-1011-live-caption-desk-v1';
/** 会务组那份名册单独存放，重领失败只动它，不碰字幕稿。 */
export const ROSTER_STORAGE_KEY = 'sologsb-1011-attendee-roster-v1';

export function normalizeSpeakerKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function entryMatches(entry: RosterEntry, name: string): boolean {
  const target = normalizeSpeakerKey(name);
  if (!target) return false;
  return normalizeSpeakerKey(entry.officialName) === target
    || entry.aliases.some((alias) => normalizeSpeakerKey(alias) === target);
}

export function findRosterEntry(entries: RosterEntry[], name: string): RosterEntry | undefined {
  const target = normalizeSpeakerKey(name);
  return entries.find((entry) => entryMatches(entry, target));
}

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
    speakerKey: normalizeSpeakerKey(speaker),
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
  segment('seg-9', 9, 70, '现场提问', '我想确认一下离线时修改保存在哪里。', '我想确认一下离线时修改保存在哪里。', 'pending'),
];

const duplicate: CaptionSegment = {
  ...segment('seg-8', 8, 61, '主讲人', '今天我们重点讨论字幕队列。', '今天我们重点讨论字幕队列。', 'duplicate'),
  source: 'live',
  duplicateOf: 'seg-2',
  staleReason: '与第 2 段高度相似',
};

/** 服务端名册版本：会务组换人 / 改写法时发新版，重领时按版本整份领取。 */
const rosterRevisions: Record<number, { versionName: string; entries: RosterEntry[] }> = {
  1: {
    versionName: '第一版（开幕日）',
    entries: [
      { id: 'roster-1', officialName: '陈岚', title: '大会主持人', aliases: ['主持人'], active: true },
      { id: 'roster-2', officialName: '陆明', title: '首席产品官 · 主讲人', aliases: ['主讲人'], active: true },
      { id: 'roster-3', officialName: '周然', title: '产品总监 · 特邀嘉宾', aliases: ['嘉宾 / 周然', '周然', '嘉宾'], active: true },
    ],
  },
  2: {
    versionName: '第二版（午间换届后）',
    entries: [
      { id: 'roster-1', officialName: '陈岚', title: '大会主持人', aliases: ['主持人'], active: true },
      { id: 'roster-2', officialName: '陆明', title: '原首席产品官（已离场）', aliases: ['主讲人'], active: false, replacedBy: 'roster-4' },
      { id: 'roster-3', officialName: '周然', title: '产品副总裁 · 特邀嘉宾', aliases: ['嘉宾 / 周然', '周然', '嘉宾'], active: true },
      { id: 'roster-4', officialName: '韩肃', title: '首席产品官 · 新任主讲人', aliases: ['韩肃'], active: true },
    ],
  },
};

export function rosterEntriesForVersion(serverVersion: number): RosterEntry[] {
  const revision = rosterRevisions[serverVersion] ?? rosterRevisions[1];
  return structuredClone(revision.entries);
}

export function createRosterModel(serverVersion = 1): RosterModel {
  const revision = rosterRevisions[serverVersion] ?? rosterRevisions[1];
  return {
    versionName: revision.versionName,
    serverVersion,
    entries: structuredClone(revision.entries),
    syncState: 'synced',
    receivedAt: now,
    syncedAt: now,
  };
}

/** 挂名对不上名册时的说明；命中已停用条目时给出换人提示。 */
export function holdReasonFor(entries: RosterEntry[], name: string): { reason: string; inactive?: RosterEntry } {
  const direct = findRosterEntry(entries, name);
  if (direct && !direct.active) {
    const target = direct.replacedBy ? entries.find((entry) => entry.id === direct.replacedBy) : undefined;
    return {
      reason: target
        ? `名册中「${direct.officialName}」已更换为「${target.officialName}」，挂名待会务组确认改挂`
        : `名册中「${direct.officialName}」已停用，挂名待会务组确认`,
      inactive: direct,
    };
  }
  return { reason: `名册中查无挂名「${name}」，已挂起等待会务组确认` };
}

export interface ReconcileResult {
  segments: CaptionSegment[];
  heldNames: string[];
  resolvedNames: string[];
  unmatchedOnScreen: number;
}

/**
 * 两边按片段挂的姓名逐条对账：
 * - 待确认类片段（pending/stale）对不上名册 → held 挂起，等会务组确认，期间不送直播区；
 * - 已上屏（confirmed）对不上 → 状态照旧保留，只做标注；
 * - 重复片段保留自身流程，恢复为待确认时再参与挂起；
 * - 重新命中名册 → 恢复挂起前状态并写入正式姓名/职务快照。
 */
export function reconcileSpeakers(segments: CaptionSegment[], entries: RosterEntry[]): ReconcileResult {
  const heldNames = new Set<string>();
  const resolvedNames = new Set<string>();
  let unmatchedOnScreen = 0;

  const next = segments.map((segmentItem): CaptionSegment => {
    const item = { ...segmentItem };
    if (item.state === 'ignored') return item;
    const match = findRosterEntry(entries, item.speaker);

    if (match?.active) {
      const previous = item.speakerResolved;
      const sameSnapshot = previous
        && previous.entryId === match.id
        && previous.officialName === match.officialName
        && previous.title === match.title;
      item.speakerResolved = {
        entryId: match.id,
        officialName: match.officialName,
        title: match.title,
        resolvedAt: sameSnapshot ? previous.resolvedAt : Date.now(),
      };
      item.holdReason = undefined;
      if (item.state === 'held') {
        item.state = item.heldFromState === 'stale' ? 'stale' : 'pending';
        item.heldFromState = undefined;
        resolvedNames.add(item.speaker);
      }
      return item;
    }

    item.speakerResolved = undefined;
    const { reason } = holdReasonFor(entries, item.speaker);

    if (item.state === 'confirmed') {
      // 已上屏的照旧留着，只标注名册对不上，不撤不挂。
      item.holdReason = `已上屏保留：${reason}`;
      unmatchedOnScreen += 1;
      return item;
    }
    if (item.state === 'duplicate') {
      item.holdReason = reason;
      return item;
    }
    if (item.state !== 'held') item.heldFromState = item.state === 'stale' ? 'stale' : 'pending';
    item.state = 'held';
    item.holdReason = reason;
    heldNames.add(item.speaker);
    return item;
  });

  return {
    segments: next,
    heldNames: [...heldNames],
    resolvedNames: [...resolvedNames],
    unmatchedOnScreen,
  };
}

export function createInitialModel(): DeskModel {
  const roster = createRosterModel(1);
  const { segments } = reconcileSpeakers([...seededSegments, duplicate], roster.entries);
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventName: '新品发布会现场字幕',
    eventDate: new Date(now).toISOString().slice(0, 10),
    segments,
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
    updatedAt: now,
  };
}

/**
 * 旧数据没有发言人来源（schemaVersion < 2）：
 * 按现有片段挂名回填 speakerKey，并立即对一遍账。
 * 回不上的片段（含已上屏的）单列进迁移报告。
 */
export function migrateModel(raw: DeskModel, roster: RosterModel): { model: DeskModel; report: MigrationReport } {
  let backfilled = 0;
  const prepared = raw.segments.map((item) => {
    if (item.speakerKey) return item;
    backfilled += 1;
    return { ...item, speakerKey: normalizeSpeakerKey(item.speaker) };
  });
  const { segments } = reconcileSpeakers(prepared, roster.entries);
  const unresolved = segments
    .filter((item) => !item.speakerResolved && item.state !== 'ignored')
    .map((item) => ({
      segmentId: item.id,
      sequence: item.sequence,
      speaker: item.speaker,
      onScreen: item.state === 'confirmed' || !!item.confirmedAt,
    }));
  const model: DeskModel = {
    ...raw,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    segments,
    updatedAt: Date.now(),
  };
  const report: MigrationReport = {
    migratedAt: Date.now(),
    fromVersion: raw.schemaVersion ?? 1,
    backfilled,
    unresolved,
    acknowledged: unresolved.length === 0,
  };
  model.migration = report;
  return { model, report };
}

export function cloneModel(model: DeskModel): DeskModel {
  return structuredClone(model);
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

export function mergeConfirmedSegments(model: DeskModel, roster?: RosterModel): DeskModel {
  const seen: string[] = [];
  const merged = model.segments
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

  // 回网按序号合并后立即补一遍发言人对账：挂起的离线片段依旧不进直播区。
  const { segments } = roster
    ? reconcileSpeakers(merged, roster.entries)
    : { segments: merged };

  return {
    ...model,
    segments,
    connection: 'connected',
    simulatedDelay: Math.max(0.8, model.simulatedDelay - 0.7),
    lastMergedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function queueStats(model: DeskModel) {
  const pending = model.segments.filter((item) => item.state === 'pending');
  const stale = model.segments.filter((item) => item.state === 'stale');
  const duplicate = model.segments.filter((item) => item.state === 'duplicate');
  const held = model.segments.filter((item) => item.state === 'held');
  const offline = model.segments.filter((item) => item.source === 'offline' && item.state === 'confirmed');
  return {
    pending: pending.length,
    stale: stale.length,
    duplicate: duplicate.length,
    held: held.length,
    offline: offline.length,
    backlog: pending.length + stale.length + duplicate.length + held.length + offline.length,
    oldestWaitSeconds: pending.length ? Math.max(...pending.map((item) => Math.round((Date.now() - item.receivedAt) / 1000))) : 0,
  };
}

export function createLiveSegment(sequence: number): CaptionSegment {
  const speakers = ['主持人', '主讲人', '嘉宾 / 周然', '现场提问'];
  const samples = [
    '接下来请产品团队介绍新的工作流。',
    '请注意屏幕右侧的实时队列状态。',
    '在弱网环境下我们会保留未确认片段。',
    '如果网络恢复,系统会按照时间顺序自动合并。',
    '这段字幕包含二零二五年的项目数据。',
    '大家可以在会后查看完整回放和术语表。',
  ];
  const speaker = speakers[(sequence - 1) % speakers.length];
  const start = Math.max(0, sequence * 9 - 10);
  return {
    id: `seg-live-${sequence}-${Date.now().toString(36)}`,
    sequence,
    startTime: start,
    receivedAt: Date.now(),
    speaker,
    speakerKey: normalizeSpeakerKey(speaker),
    original: samples[(sequence - 1) % samples.length],
    corrected: samples[(sequence - 1) % samples.length],
    numberHints: '',
    source: 'live',
    state: 'pending',
    revision: 0,
    tags: [],
  };
}

export function simulateLatency(model: DeskModel, roster?: RosterModel): DeskModel {
  if (model.connection === 'offline') return model;
  const step = model.connection === 'degraded' ? 0.7 : model.simulatedDelay > 2.8 ? -0.3 : 0.15;
  const delay = Math.max(0.7, Math.min(8.9, Number((model.simulatedDelay + step).toFixed(1))));
  const applyStream = model.autoStream && Math.random() > 0.68;
  let nextSequence = model.nextSequence;
  let segments = model.segments;
  if (applyStream) {
    const candidate = createLiveSegment(model.nextSequence);
    const duplicate = isDuplicate(candidate, segments);
    segments = [...segments, duplicate ? { ...candidate, state: 'duplicate', duplicateOf: duplicate.id, staleReason: `与第 ${duplicate.sequence} 段重复` } : candidate];
    nextSequence += 1;
  }
  const pendingCutoff = Date.now() - 90_000;
  segments = segments.map((item) => item.state === 'pending' && item.receivedAt < pendingCutoff
    ? { ...item, state: 'stale', staleReason: `片段已等待 ${Math.round((Date.now() - item.receivedAt) / 1000)} 秒` }
    : item);
  // 新到片段同样按挂名逐条对账，对不上的一进来就挂起。
  if (roster) ({ segments } = reconcileSpeakers(segments, roster.entries));
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
    .map((item, index) => `${index + 1}\n${stamp(item.startTime)} --> ${stamp(item.startTime + 7)}\n[${item.speakerResolved?.officialName ?? item.speaker}] ${item.corrected}\n`)
    .join('\n');
}
