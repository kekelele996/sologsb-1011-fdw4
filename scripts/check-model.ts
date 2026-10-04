import assert from 'node:assert';
import {
  createInitialModel,
  createRosterModel,
  reconcileSpeakers,
  migrateModel,
  mergeConfirmedSegments,
  simulateLatency,
  findRosterEntry,
  rosterEntriesForVersion,
  normalizeSpeakerKey,
  STORAGE_KEY,
  ROSTER_STORAGE_KEY,
  CURRENT_SCHEMA_VERSION,
  type DeskModel,
  type RosterModel,
} from '../src/model';

// 1. 初始模型：名册三个人，“现场提问”查无 -> 挂起；seg-8 duplicate 不挂
const initial = createInitialModel();
const seg9 = initial.segments.find((s) => s.id === 'seg-9')!;
assert.equal(seg9.state, 'held', '现场提问应挂起');
assert.ok(seg9.holdReason?.includes('查无'));
assert.equal(seg9.heldFromState, 'pending');
const seg4 = initial.segments.find((s) => s.id === 'seg-4')!;
assert.equal(seg4.state, 'pending');
assert.equal(seg4.speakerResolved?.officialName, '周然');
assert.equal(seg4.speakerResolved?.title, '产品总监 · 特邀嘉宾');
const seg8 = initial.segments.find((s) => s.id === 'seg-8')!;
assert.equal(seg8.state, 'duplicate', '重复片段不进入挂起');
const seg1 = initial.segments.find((s) => s.id === 'seg-1')!;
assert.equal(seg1.state, 'confirmed');
assert.equal(seg1.speakerResolved?.officialName, '陈岚');

// 2. 会务组补录挂名 -> 挂起解除，恢复 pending
const roster1 = createRosterModel(1);
const claimed: RosterModel = {
  ...roster1,
  entries: [
    { id: 'roster-q', officialName: '现场记者团', title: '现场提问席', aliases: ['现场提问'], active: true },
    ...roster1.entries,
  ],
};
const r2 = reconcileSpeakers(initial.segments, claimed.entries);
assert.equal(r2.segments.find((s) => s.id === 'seg-9')!.state, 'pending');
assert.equal(r2.segments.find((s) => s.id === 'seg-9')!.speakerResolved!.officialName, '现场记者团');
assert.equal(r2.resolvedNames.includes('现场提问'), true);

// 3. 名册换第二版：陆明停用、韩肃接手 -> 所有挂“主讲人”的待确认片段挂起，已上屏照旧
const roster2 = { ...createRosterModel(2) };
const r3 = reconcileSpeakers(initial.segments, roster2.entries);
const heldSpeaker = r3.segments.filter((s) => s.speaker === '主讲人');
// seg-2、seg-3 已上屏 -> 仍 confirmed 但有 holdReason
for (const id of ['seg-2', 'seg-3']) {
  const s = r3.segments.find((x) => x.id === id)!;
  assert.equal(s.state, 'confirmed', `${id} 已上屏应照旧保留`);
  assert.ok(s.holdReason?.includes('已上屏保留'));
  assert.ok(s.holdReason?.includes('韩肃'));
}
// seg-8 duplicate 保持 duplicate
assert.equal(r3.segments.find((x) => x.id === 'seg-8')!.state, 'duplicate');
// seg-9 现场提问仍然查无
assert.equal(r3.segments.find((x) => x.id === 'seg-9')!.state, 'held');
assert.equal(r3.unmatchedOnScreen >= 2, true);

// 4. 改挂到接手人后解除
let mapped = r3.segments.map((s) => s.state === 'held' && s.speaker === '主讲人'
  ? { ...s, speaker: '韩肃', speakerKey: normalizeSpeakerKey('韩肃') }
  : s);
const r4 = reconcileSpeakers(mapped, roster2.entries);
assert.equal(r4.segments.filter((s) => s.speaker === '韩肃' && s.state === 'held').length, 0);

// 5. 改写法（别名调整）：去掉“嘉宾 / 周然”别名 -> seg-4/seg-5 挂起；加回别名 -> 解除
const roster2b: RosterModel = {
  ...roster2,
  entries: roster2.entries.map((e) => e.id === 'roster-3' ? { ...e, aliases: ['周然', '嘉宾'] } : e),
};
const r5 = reconcileSpeakers(initial.segments, roster2b.entries);
assert.equal(r5.segments.find((s) => s.id === 'seg-4')!.state, 'held');
const roster2c: RosterModel = {
  ...roster2,
  entries: roster2.entries.map((e) => e.id === 'roster-3' ? { ...e, aliases: ['嘉宾 / 周然', '周然', '嘉宾'] } : e),
};
const r6 = reconcileSpeakers(r5.segments, roster2c.entries);
assert.equal(r6.segments.find((s) => s.id === 'seg-4')!.state, 'pending', '恢复挂起前状态');
assert.equal(r6.segments.find((s) => s.id === 'seg-4')!.speakerResolved!.title, '产品副总裁 · 特邀嘉宾');

// 6. 旧数据迁移：无 speakerKey / schemaVersion
const legacy = {
  ...createInitialModel(),
  schemaVersion: undefined as unknown as number,
  migration: undefined,
  segments: createInitialModel().segments
    .map((s) => ({ ...s, speakerKey: undefined as unknown as string, speakerResolved: undefined }))
    // 再造一条已上屏、但挂名不在名册里的旧片段
    .concat([{
      ...createInitialModel().segments[0],
      id: 'seg-old-onscreen',
      sequence: 99,
      speaker: '往届嘉宾 / 老周',
      state: 'confirmed' as const,
      confirmedAt: Date.now() - 10_000,
      speakerKey: undefined as unknown as string,
      speakerResolved: undefined,
      holdReason: undefined,
    }]),
};
const rosterFresh = createRosterModel(1);
const { model: migrated, report } = migrateModel(legacy as DeskModel, rosterFresh);
assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
assert.equal(report.backfilled, legacy.segments.length, '所有片段都没有 speakerKey 时应全部回填');
assert.ok(report.unresolved.some((u) => u.speaker === '现场提问'));
const unresolvedOnScreen = report.unresolved.find((u) => u.segmentId === 'seg-old-onscreen');
assert.equal(unresolvedOnScreen?.onScreen, true, '已上屏的回不上也要单列');
assert.equal(migrated.segments.find((s) => s.id === 'seg-old-onscreen')!.state, 'confirmed', '已上屏的迁移后照旧保留不撤');


// 7. 离线确认 + 回网合并：按序号排序、挂起仍不进直播区
let offline = { ...initial, connection: 'offline' as const };
// 让 seg-9 在名册补录前尝试确认：离线状态下模拟“先补录名册后挂起解除，再确认”的反向用例：
// 7a. 直接对 held 片段，组件层会拦截，model 层 merge 时若某离线确认片段对不上 -> 挂起
offline = {
  ...offline,
  segments: offline.segments.map((s) => s.id === 'seg-9'
    ? { ...s, state: 'confirmed' as const, source: 'offline' as const, confirmedAt: Date.now(), holdReason: undefined }
    : s),
};
const merged = mergeConfirmedSegments(offline, rosterFresh);
assert.equal(merged.connection, 'connected');
const mseg9 = merged.segments.find((s) => s.id === 'seg-9')!;
assert.equal(mseg9.state, 'held', '离线补送后对不上名册仍然挂起');
// 序号有序
const seqs = merged.segments.map((s) => s.sequence);
assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '合并后按序号有序');

// 8. 模拟延迟：新片段到达也会对账（第一版名册下，“现场提问”新片段应挂起）
const withStream = simulateLatency({ ...initial, autoStream: true, nextSequence: 20 }, rosterFresh);
// 随机可能没生成片段；强制造一条
import { createLiveSegment } from '../src/model';
const live = createLiveSegment(20);
assert.equal(live.speaker, '现场提问');
const forced = reconcileSpeakers([...initial.segments, live], rosterFresh.entries);
assert.equal(forced.segments.at(-1)!.state, 'held');

// 9. 存储键分离
assert.ok(STORAGE_KEY !== ROSTER_STORAGE_KEY);
assert.ok(rosterEntriesForVersion(2).find((e) => e.id === 'roster-4'));
assert.ok(findRosterEntry(rosterFresh.entries, '主持人')?.officialName === '陈岚');

console.log('all assertions passed');
