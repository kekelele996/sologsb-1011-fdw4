import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  applyRules,
  cloneModel,
  createInitialModel,
  createRosterModel,
  CURRENT_SCHEMA_VERSION,
  findRosterEntry,
  mergeConfirmedSegments,
  migrateModel,
  normalizeNumbers,
  normalizeSpeakerKey,
  queueStats,
  reconcileSpeakers,
  ROSTER_STORAGE_KEY,
  rosterEntriesForVersion,
  simulateLatency,
  STORAGE_KEY,
  toSrt,
  type CaptionSegment,
  type ConnectionState,
  type DeskModel,
  type MigrationReport,
  type RosterEntry,
  type RosterModel,
  type SegmentState,
  type ToastMessage,
} from './model';

const HISTORY_LIMIT = 80;

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒前`;
}

function stateLabel(state: SegmentState): string {
  return {
    pending: '待确认',
    confirmed: '已确认',
    duplicate: '重复片段',
    stale: '过期修改',
    held: '挂起待确认',
    ignored: '已忽略',
  }[state];
}

function connectionLabel(state: ConnectionState): string {
  return { connected: '连接稳定', degraded: '延迟波动', offline: '离线校正' }[state];
}

interface BootState {
  model: DeskModel;
  roster: RosterModel;
}

@customElement('caption-desk')
export class CaptionDesk extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      --caption-font-size: 18px;
      color: var(--cds-text-primary, #161616);
      background: var(--cds-background, #f4f4f4);
      font-family: "IBM Plex Sans", "PingFang SC", sans-serif;
    }

    * { box-sizing: border-box; }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto auto 1fr;
      background:
        linear-gradient(90deg, rgba(15,98,254,.025) 1px, transparent 1px),
        linear-gradient(rgba(15,98,254,.025) 1px, transparent 1px),
        var(--cds-background, #f4f4f4);
      background-size: 24px 24px;
    }

    .shell.dark {
      --cds-background: #161616;
      --cds-layer: #262626;
      --cds-layer-01: #262626;
      --cds-layer-02: #393939;
      --cds-field: #262626;
      --cds-text-primary: #f4f4f4;
      --cds-text-secondary: #c6c6c6;
      --cds-border-subtle: #393939;
      --cds-border-strong: #6f6f6f;
      color: #f4f4f4;
    }

    .topbar {
      min-height: 64px;
      padding: 8px 18px 8px 20px;
      display: grid;
      grid-template-columns: minmax(330px, 1fr) auto minmax(420px, 1fr);
      align-items: center;
      gap: 20px;
      background: #161616;
      color: #f4f4f4;
      border-bottom: 1px solid #393939;
      position: relative;
      z-index: 5;
    }

    .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .brand-mark {
      width: 38px; height: 38px; display: grid; place-items: center;
      border: 1px solid #78a9ff; color: #78a9ff; font: 600 11px/1 "IBM Plex Mono", monospace;
      clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
    }
    .brand-copy { min-width: 0; }
    .brand-copy strong { display: block; font-size: 15px; letter-spacing: .015em; white-space: nowrap; }
    .brand-copy span { display: block; color: #a8a8a8; font-size: 11px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .connection-pill {
      justify-self: center; display: flex; align-items: center; gap: 10px; padding: 8px 13px;
      min-width: 260px; background: #262626; border: 1px solid #525252;
    }
    .connection-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: #42be65; box-shadow: 0 0 0 4px rgba(66,190,101,.13); }
    .connection-pill.degraded .connection-dot { background: #f1c21b; box-shadow: 0 0 0 4px rgba(241,194,27,.14); }
    .connection-pill.offline .connection-dot { background: #fa4d56; box-shadow: 0 0 0 4px rgba(250,77,86,.14); }
    .connection-copy { min-width: 0; }
    .connection-copy strong { display: block; font-size: 12px; }
    .connection-copy small { display: block; color: #c6c6c6; margin-top: 2px; font-size: 10px; }

    .header-actions { justify-self: end; display: flex; align-items: center; gap: 8px; }
    .header-actions cds-button { --cds-button-primary: #0f62fe; }

    .status-strip {
      min-height: 60px; padding: 8px 20px; display: grid; grid-template-columns: 1.5fr repeat(4, minmax(118px, .6fr)) auto;
      gap: 0; align-items: stretch; background: var(--cds-layer, #fff); border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0);
    }
    .status-cell { padding: 7px 16px; border-right: 1px solid var(--cds-border-subtle, #e0e0e0); display: flex; flex-direction: column; justify-content: center; }
    .status-cell:first-child { padding-left: 4px; }
    .status-cell:last-child { border-right: 0; }
    .status-cell strong { font-size: 20px; font-weight: 400; line-height: 1.05; font-variant-numeric: tabular-nums; }
    .status-cell span { margin-top: 3px; color: var(--cds-text-secondary, #525252); font-size: 10px; letter-spacing: .03em; }
    .status-cell.warning strong, .status-cell.warning span { color: #b28600; }
    .status-cell.danger strong, .status-cell.danger span { color: #da1e28; }
    .status-cell.hero strong { font-size: 14px; }
    .queue-track { width: 100%; height: 3px; margin-top: 6px; background: #e0e0e0; }
    .queue-track > span { display: block; height: 100%; background: #0f62fe; transition: width .3s ease; }
    .font-controls { min-width: 190px; padding: 7px 4px 7px 18px; display: flex; align-items: center; gap: 8px; }
    .font-controls label { color: var(--cds-text-secondary, #525252); font-size: 10px; }

    .workspace {
      min-height: 0; display: grid; grid-template-columns: minmax(390px, .95fr) minmax(430px, 1.05fr) minmax(370px, .9fr);
      gap: 1px; background: var(--cds-border-subtle, #e0e0e0); overflow: hidden;
    }

    .column { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--cds-background, #f4f4f4); }
    .column-head {
      min-height: 62px; padding: 11px 14px 9px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
      background: var(--cds-layer, #fff); border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0);
    }
    .column-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
    .column-head p { margin: 4px 0 0; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .column-body { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-color: #8d8d8d transparent; }

    .segment-list { padding: 8px; display: flex; flex-direction: column; gap: 1px; }
    .segment-card {
      width: 100%; border: 0; border-left: 3px solid transparent; background: var(--cds-layer, #fff);
      color: inherit; text-align: left; padding: 11px 12px 10px 14px; cursor: pointer; position: relative;
    }
    .segment-card:hover { background: var(--cds-layer-hover, #e8e8e8); }
    .segment-card.selected { border-left-color: #0f62fe; background: var(--cds-layer-selected, #edf5ff); outline: 1px solid #78a9ff; }
    .segment-card.duplicate { border-left-color: #a56eff; }
    .segment-card.stale { border-left-color: #f1c21b; background: color-mix(in srgb, #fff 92%, #f1c21b 8%); }
    .segment-card.confirmed { border-left-color: #42be65; }
    .segment-card.held { border-left-color: #da1e28; background: color-mix(in srgb, #fff 93%, #fa4d56 7%); }
    .segment-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
    .segment-meta > span:first-child { color: var(--cds-text-secondary, #525252); font: 500 10px/1 "IBM Plex Mono", monospace; }
    .segment-state { font-size: 10px; color: #525252; }
    .segment-state.stale { color: #8d6e00; }
    .segment-state.duplicate { color: #6929c4; }
    .segment-state.confirmed { color: #198038; }
    .segment-state.held { color: #da1e28; font-weight: 600; }
    .segment-text { margin: 0; font-size: var(--caption-font-size); line-height: 1.5; }
    .segment-corrected { margin: 6px 0 0; padding-left: 8px; border-left: 2px solid #42be65; color: #198038; font-size: calc(var(--caption-font-size) * .88); line-height: 1.45; }
    .segment-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--cds-text-secondary, #525252); font-size: 10px; flex-wrap: wrap; }
    .segment-foot b { color: #0f62fe; font-weight: 500; }
    .resolved-chip { color: #198038; }
    .issue-note { margin-top: 8px; padding: 7px 8px; background: #fff8e1; border-left: 2px solid #f1c21b; color: #684e00; font-size: 10px; line-height: 1.45; }
    .duplicate-note { background: #f6f2ff; border-color: #a56eff; color: #491d8b; }
    .hold-note { background: #fff1f1; border-color: #fa4d56; color: #8a3a3f; }

    .empty { padding: 48px 24px; text-align: center; color: var(--cds-text-secondary, #525252); }
    .empty strong { display: block; color: var(--cds-text-primary, #161616); margin-bottom: 6px; }
    .empty p { margin: 0; font-size: 11px; line-height: 1.5; }

    .editor-scroll { padding: 14px; overflow: auto; }
    .editor-card { background: var(--cds-layer, #fff); border: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .editor-top { padding: 12px 14px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: start; }
    .editor-time { color: #0f62fe; font: 500 12px/1.4 "IBM Plex Mono", monospace; }
    .editor-title { margin: 4px 0 0; font-size: 12px; color: var(--cds-text-secondary, #525252); }
    .editor-status { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .editor-form { padding: 14px; display: flex; flex-direction: column; gap: 13px; }
    .form-grid { display: grid; grid-template-columns: minmax(130px, .6fr) 1fr; gap: 12px; align-items: end; }
    .caption-input { min-height: 158px; --cds-body-compact-01-font-size: var(--caption-font-size); --cds-body-compact-02-font-size: var(--caption-font-size); }
    .edit-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .edit-toolbar > span { margin-right: 5px; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .number-input { width: 110px; }
    .rule-suggestions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .rule-suggestions small { color: var(--cds-text-secondary, #525252); }
    .confirm-bar { padding: 12px 14px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--cds-border-subtle, #e0e0e0); background: var(--cds-layer-02, #f4f4f4); }
    .confirm-hint { color: var(--cds-text-secondary, #525252); font-size: 10px; line-height: 1.4; }
    .confirm-hint kbd { padding: 3px 5px; border: 1px solid var(--cds-border-strong, #8d8d8d); background: var(--cds-layer, #fff); color: var(--cds-text-primary, #161616); font: 10px/1 "IBM Plex Mono", monospace; }

    .inspector { padding: 12px 14px 20px; display: flex; flex-direction: column; gap: 14px; }
    .inspector-section { background: var(--cds-layer, #fff); border: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .inspector-section-head { padding: 10px 12px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .inspector-section-head h3 { margin: 0; font-size: 12px; }
    .inspector-section-head span { color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .rule-list { padding: 5px 0; }
    .rule-item { padding: 8px 10px; display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .rule-item:last-child { border-bottom: 0; }
    .rule-item strong { display: block; font-size: 11px; }
    .rule-item p { margin: 3px 0 0; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .rule-item-actions { display: flex; gap: 3px; }
    .rule-form { padding: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .rule-form cds-text-input, .rule-form cds-button { width: 100%; }
    .rule-form .full { grid-column: 1 / -1; }

    .roster-body { padding: 9px 10px 11px; display: flex; flex-direction: column; gap: 9px; }
    .roster-sync { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .roster-sync > div { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .roster-sync small { color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .roster-entry { padding: 8px; border: 1px solid var(--cds-border-subtle, #e0e0e0); display: flex; flex-direction: column; gap: 6px; }
    .roster-entry.inactive { opacity: .62; background: color-mix(in srgb, var(--cds-layer, #fff) 90%, #8d8d8d 10%); }
    .roster-entry-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .roster-entry-head small { color: var(--cds-text-secondary, #525252); font-size: 9px; }
    .roster-input { width: 100%; padding: 5px 7px; border: 1px solid var(--cds-border-strong, #8d8d8d); background: var(--cds-field, #fff); color: inherit; font: inherit; font-size: 11px; border-radius: 0; }
    .roster-input:focus { outline: 2px solid #0f62fe; outline-offset: -2px; }
    .roster-entry-actions { display: flex; gap: 4px; align-items: center; }
    .roster-held { border-left: 3px solid #fa4d56; background: #fff1f1; padding: 8px 9px; color: #8a3a3f; }
    .roster-held-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; font-weight: 600; }
    .roster-held p { margin: 4px 0 0; font-size: 10px; line-height: 1.45; }
    .roster-held-actions { display: flex; gap: 5px; margin-top: 7px; flex-wrap: wrap; }
    .roster-add { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .roster-add .full { grid-column: 1 / -1; }
    .migration-list { margin: 8px 0 0; padding-left: 16px; font-size: 10px; line-height: 1.7; }

    .live-timeline { padding: 6px 0; }
    .live-item { padding: 8px 11px; border-left: 3px solid #42be65; margin: 0 10px 7px; background: var(--cds-layer-02, #f4f4f4); }
    .live-item time { color: #198038; font: 500 9px/1 "IBM Plex Mono", monospace; }
    .live-item p { margin: 5px 0 0; font-size: var(--caption-font-size); line-height: 1.45; }
    .live-item small { display: block; margin-top: 4px; color: var(--cds-text-secondary, #525252); font-size: 9px; }
    .live-item small.onscreen-hold { color: #b81921; }
    .delivery-status { margin: 0 10px 10px; padding: 9px 10px; background: #edf5ff; border-left: 3px solid #0f62fe; color: #0043ce; font-size: 10px; line-height: 1.45; }
    .delivery-status.held { background: #fff1f1; border-left-color: #fa4d56; color: #8a3a3f; }

    .toast-stack { position: fixed; right: 18px; bottom: 18px; z-index: 20; width: 380px; display: flex; flex-direction: column; gap: 8px; }
    cds-toast-notification { box-shadow: 0 8px 22px rgba(0,0,0,.18); }

    @media (max-width: 1280px) {
      .workspace { grid-template-columns: minmax(340px, .85fr) minmax(410px, 1fr) minmax(330px, .85fr); }
      .status-strip { grid-template-columns: 1.4fr repeat(4, minmax(100px, .55fr)); }
      .font-controls { display: none; }
    }

    @media (max-width: 980px) {
      .topbar { grid-template-columns: 1fr auto; }
      .connection-pill { grid-row: 2; grid-column: 1 / -1; justify-self: stretch; min-width: 0; }
      .workspace { grid-template-columns: 1fr; overflow: visible; }
      .column { min-height: 520px; }
      .shell { display: block; }
      .status-strip { grid-template-columns: repeat(4, 1fr); }
      .status-cell.hero { grid-column: 1 / -1; }
    }
  `;

  private boot: BootState = this.bootstrap();

  @state() private model: DeskModel = this.boot.model;
  @state() private roster: RosterModel = this.boot.roster;
  @state() private dark = localStorage.getItem(`${STORAGE_KEY}-theme`) === 'dark';
  @state() private toasts: ToastMessage[] = [];
  @state() private ruleSource = '';
  @state() private ruleReplacement = '';
  @state() private ruleSpeaker = '';
  @state() private filter: 'active' | 'all' | 'attention' = 'active';
  @state() private showRuleForm = false;
  @state() private failNextRefetch = false;
  @state() private rosterName = '';
  @state() private rosterTitle = '';
  private past: DeskModel[] = [];
  private future: DeskModel[] = [];
  private ticker?: number;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.handleShortcut);
    this.ticker = window.setInterval(() => {
      const next = simulateLatency(this.model, this.roster);
      const changed = JSON.stringify(next.segments) !== JSON.stringify(this.model.segments) || next.connection !== this.model.connection;
      if (!changed) return;
      this.model = next;
      this.persist();
    }, 5_000);
  }

  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.handleShortcut);
    if (this.ticker) window.clearInterval(this.ticker);
    super.disconnectedCallback();
  }

  /** 启动时各取各的账：字幕稿一份、会务组名册一份；旧稿在这里做升级回填。 */
  private bootstrap(): BootState {
    let roster: RosterModel;
    try {
      const raw = localStorage.getItem(ROSTER_STORAGE_KEY);
      roster = raw ? JSON.parse(raw) as RosterModel : createRosterModel(1);
      if (!roster.entries?.length) roster = createRosterModel(1);
      if (roster.syncState === 'refetch-failed') roster = { ...roster, syncState: 'synced', lastError: undefined };
    } catch {
      roster = createRosterModel(1);
    }
    localStorage.setItem(ROSTER_STORAGE_KEY, JSON.stringify(roster));

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DeskModel;
        if (parsed.segments?.length) {
          if (parsed.schemaVersion !== CURRENT_SCHEMA_VERSION) {
            const { model } = migrateModel(parsed, roster);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(model));
            return { model, roster };
          }
          // 名册可能在别处换过版，启动时按挂名补一遍正式信息。
          const { segments } = reconcileSpeakers(parsed.segments, roster.entries);
          return { model: { ...parsed, segments }, roster };
        }
      }
    } catch {
      // 损坏草稿会回退到演示数据。
    }
    return { model: createInitialModel(), roster };
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.model, updatedAt: Date.now() }));
  }

  private persistRoster(): void {
    localStorage.setItem(ROSTER_STORAGE_KEY, JSON.stringify(this.roster));
  }

  private commit(label: string, update: (current: DeskModel) => DeskModel): void {
    const previous = cloneModel(this.model);
    const next = update(cloneModel(this.model));
    next.updatedAt = Date.now();
    this.past = [...this.past, previous].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = next;
    this.persist();
    if (label) this.pushToast('info', label, '已写入浏览器本地草稿');
  }

  private automatic(next: DeskModel): void {
    this.model = next;
    this.persist();
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.pushToast('info', '没有可撤销的修改', '历史记录为空');
    this.future = [cloneModel(this.model), ...this.future].slice(0, HISTORY_LIMIT);
    this.model = previous;
    this.persist();
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    this.past = [...this.past, cloneModel(this.model)].slice(-HISTORY_LIMIT);
    this.model = next;
    this.persist();
  }

  private pushToast(kind: ToastMessage['kind'], title: string, subtitle: string): void {
    const toast = { id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind, title, subtitle };
    this.toasts = [toast, ...this.toasts].slice(0, 3);
    window.setTimeout(() => {
      this.toasts = this.toasts.filter((item) => item.id !== toast.id);
    }, 4_500);
  }

  private get selected(): CaptionSegment | undefined {
    return this.model.segments.find((item) => item.id === this.model.selectedId);
  }

  private get stats() {
    return queueStats(this.model);
  }

  /** 挂起的挂名分组，供会务组在名册侧逐条确认。 */
  private get heldGroups(): { name: string; sequences: number[] }[] {
    const groups = new Map<string, number[]>();
    for (const item of this.model.segments.filter((segment) => segment.state === 'held')) {
      const list = groups.get(item.speaker) ?? [];
      list.push(item.sequence);
      groups.set(item.speaker, list);
    }
    return [...groups.entries()].map(([name, sequences]) => ({ name, sequences: sequences.sort((a, b) => a - b) }));
  }

  private get migration(): MigrationReport | undefined {
    return this.model.migration && !this.model.migration.acknowledged ? this.model.migration : undefined;
  }

  private get pendingSegments(): CaptionSegment[] {
    const items = this.model.segments.filter((item) => {
      if (this.filter === 'active') return ['pending', 'stale', 'duplicate', 'held'].includes(item.state);
      if (this.filter === 'attention') return ['stale', 'duplicate', 'held'].includes(item.state);
      return true;
    });
    return [...items].sort((a, b) => a.sequence - b.sequence);
  }

  /** 名册变动后用本地这份重新逐条对账，返回挂起/解除结果用于提示。 */
  private applyRoster(roster: RosterModel): { held: number; resolved: number; onScreen: number } {
    this.roster = roster;
    this.persistRoster();
    const result = reconcileSpeakers(this.model.segments, roster.entries);
    this.automatic({ ...this.model, segments: result.segments });
    return { held: result.heldNames.length, resolved: result.resolvedNames.length, onScreen: result.unmatchedOnScreen };
  }

  private updateSelected(patch: Partial<CaptionSegment>, label = ''): void {
    const selected = this.selected;
    if (!selected) return;
    this.commit(label, (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, ...patch, revision: item.revision + 1 } : item),
    }));
  }

  private selectSegment(id: string): void {
    this.model = { ...this.model, selectedId: id };
    this.persist();
  }

  private navigate(direction: number): void {
    const candidates = this.pendingSegments.length ? this.pendingSegments : [...this.model.segments].sort((a, b) => a.sequence - b.sequence);
    const index = candidates.findIndex((item) => item.id === this.model.selectedId);
    const next = candidates[Math.max(0, Math.min(candidates.length - 1, index + direction))];
    if (next) this.selectSegment(next.id);
  }

  private applyTerm(ruleId: string): void {
    const selected = this.selected;
    const rule = this.model.rules.find((item) => item.id === ruleId);
    if (!selected || !rule) return;
    const flags = rule.caseSensitive ? 'g' : 'gi';
    const expression = new RegExp(rule.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    if (!expression.test(selected.corrected)) {
      this.pushToast('warning', '当前字幕没有该术语', `${rule.source} → ${rule.replacement}`);
      return;
    }
    this.commit('应用术语替换', (current) => ({
      ...current,
      rules: current.rules.map((item) => item.id === rule.id ? { ...item, usageCount: item.usageCount + 1 } : item),
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, corrected: item.corrected.replace(expression, rule.replacement), revision: item.revision + 1 } : item),
    }));
  }

  private applyInlineEdit(transform: (value: string) => string, label: string, cursorShift = 0): void {
    const selected = this.selected;
    if (!selected) return;
    const host = this.renderRoot.querySelector('cds-textarea');
    const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
    let value = selected.corrected;
    let cursor = value.length;

    if (textarea) {
      value = `${value.slice(0, textarea.selectionStart)}${transform('')}${value.slice(textarea.selectionEnd)}`;
      cursor = textarea.selectionStart + transform('').length + cursorShift;
    } else {
      value = transform(value);
    }

    this.updateSelected({ corrected: value }, label);
    this.updateComplete.then(() => {
      const nextTextarea = this.renderRoot.querySelector('cds-textarea')?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
      if (nextTextarea && textarea) {
        nextTextarea.focus();
        nextTextarea.setSelectionRange(cursor, cursor);
      }
    });
  }

  private insertPunctuation(mark: string): void {
    this.applyInlineEdit(() => mark, `插入${mark}`);
  }

  private wrapSelection(open: string, close: string): void {
    const host = this.renderRoot.querySelector('cds-textarea');
    const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
    const selected = this.selected;
    if (!textarea || !selected) return;
    const selectedText = selected.corrected.slice(textarea.selectionStart, textarea.selectionEnd) || '重点';
    const value = `${selected.corrected.slice(0, textarea.selectionStart)}${open}${selectedText}${close}${selected.corrected.slice(textarea.selectionEnd)}`;
    this.updateSelected({ corrected: value }, '添加强调标点');
  }

  private normalizeCurrentNumbers(): void {
    const selected = this.selected;
    if (!selected) return;
    const normalized = normalizeNumbers(selected.corrected);
    if (normalized === selected.corrected) {
      this.pushToast('info', '没有需要规范化的数字', '已检查全角数字和中文数字');
      return;
    }
    this.updateSelected({ corrected: normalized, numberHints: normalized }, '规范化数字');
  }

  /** 字幕台改挂名：改完立刻按名册重新对账，对不上当场挂起。 */
  private changeSpeaker(name: string): void {
    const selected = this.selected;
    if (!selected || name === selected.speaker) return;
    this.commit('修改挂名发言人', (current) => {
      const mapped = current.segments.map((item) => item.id === selected.id
        ? { ...item, speaker: name, speakerKey: normalizeSpeakerKey(name), revision: item.revision + 1 }
        : item);
      return { ...current, segments: reconcileSpeakers(mapped, this.roster.entries).segments };
    });
  }

  private confirmSelected(): void {
    const selected = this.selected;
    if (!selected) {
      this.pushToast('warning', '没有可确认的片段', '请先从待确认区选择字幕');
      return;
    }
    if (selected.state === 'held') {
      // 挂起期间不送进直播区。
      this.pushToast('error', '发言人未通过名册对账，已挂起', '请会务组在右侧出席名册中确认、补录或改挂后再上屏');
      return;
    }
    const { text, used } = applyRules(selected.corrected, this.model);
    const offline = this.model.connection === 'offline';
    const nextOrder = this.pendingSegments.filter((item) => item.id !== selected.id);
    this.commit('确认并送入直播区', (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? {
        ...item,
        corrected: text,
        state: 'confirmed',
        source: offline ? 'offline' : item.source,
        confirmedAt: Date.now(),
        staleReason: item.state === 'stale' ? item.staleReason : undefined,
        holdReason: undefined,
        tags: used.length ? [...new Set([...item.tags, '术语已应用'])] : item.tags,
        revision: item.revision + 1,
      } : item),
      rules: current.rules.map((rule) => used.includes(rule.id) ? { ...rule, usageCount: rule.usageCount + 1 } : rule),
      selectedId: nextOrder[0]?.id ?? selected.id,
    }));
    this.pushToast(offline ? 'warning' : 'success', offline ? '已加入离线发件箱' : '字幕已进入直播区', offline ? '恢复连接后将按序号合并，并补一遍发言人对账' : `第 ${selected.sequence} 段已确认`);
  }

  private ignoreSelected(): void {
    const selected = this.selected;
    if (!selected) return;
    const next = this.pendingSegments.find((item) => item.id !== selected.id);
    this.commit('忽略问题片段', (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, state: 'ignored', staleReason: '已人工忽略' } : item),
      selectedId: next?.id ?? selected.id,
    }));
  }

  private recoverDuplicate(): void {
    const selected = this.selected;
    if (!selected) return;
    this.commit('保留重复片段', (current) => {
      const mapped = current.segments.map((item) => item.id === selected.id
        ? { ...item, state: 'pending' as SegmentState, duplicateOf: undefined, staleReason: '重复提示已由校对员确认保留' }
        : item);
      // 恢复为待确认后立即参与发言人对账，对不上照样挂起。
      return { ...current, segments: reconcileSpeakers(mapped, this.roster.entries).segments };
    });
  }

  private setConnection(connection: ConnectionState): void {
    this.commit(connection === 'offline' ? '切换到离线校正' : connection === 'degraded' ? '模拟延迟波动' : '连接已恢复', (current) => ({
      ...current,
      connection,
      simulatedDelay: connection === 'connected' ? 0.8 : connection === 'degraded' ? 4.6 : current.simulatedDelay,
    }));
    if (connection === 'offline') {
      this.roster = { ...this.roster, syncState: 'synced' };
      this.persistRoster();
      this.pushToast('info', '名册也可离线继续改', '会务组侧的改动暂存本地，回网合并后统一补对账');
    }
  }

  /** 回网：离线片段按序号合并补送，合并后立刻按名册补对账。 */
  private mergeOffline(): void {
    const merged = mergeConfirmedSegments(this.model, this.roster);
    this.past = [...this.past, cloneModel(this.model)].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = merged;
    this.persist();
    const offlineCount = this.model.segments.filter((item) => item.source === 'offline').length;
    const heldCount = this.model.segments.filter((item) => item.state === 'held').length;
    this.roster = { ...this.roster, syncState: 'synced', lastError: undefined, syncedAt: Date.now() };
    this.persistRoster();
    this.pushToast('success', '离线队列已按序号合并补送', `离线来源 ${offlineCount} 段 · 发言人挂起 ${heldCount} 段（不进直播区），过期修改继续提示`);
  }

  // ── 会务组出席名册（独立的那份账） ────────────────────────────────

  /** 会务组侧重领名册：失败只重试自己这份，字幕稿不动。 */
  private refetchRoster(): void {
    if (this.model.connection === 'offline' || this.failNextRefetch) {
      const reason = this.model.connection === 'offline' ? '当前处于断网状态，名册留在本地' : '模拟名册服务领取失败';
      this.roster = { ...this.roster, syncState: 'refetch-failed', lastError: `${reason} · ${new Date().toLocaleTimeString('zh-CN')}` };
      this.persistRoster();
      this.failNextRefetch = false;
      this.pushToast('error', '出席名册重领失败', '只重试会务组这份名册，字幕台片段正文未做任何改动');
      return;
    }
    const entries = rosterEntriesForVersion(this.roster.serverVersion);
    const summary = this.applyRoster({
      ...this.roster,
      entries,
      syncState: 'synced',
      lastError: undefined,
      receivedAt: Date.now(),
      syncedAt: Date.now(),
    });
    this.pushToast('success', '已重新领取出席名册', `按挂名逐条对账：新挂起 ${summary.held} 个姓名 · 解除挂起 ${summary.resolved} 个`);
  }

  /** 演示：会务组发布第二版名册（换人 / 改写法）。 */
  private publishRosterRevision(): void {
    const fresh = createRosterModel(2);
    const summary = this.applyRoster({
      ...fresh,
      syncState: this.model.connection === 'offline' ? 'offline-pending' : 'synced',
      receivedAt: Date.now(),
      syncedAt: Date.now(),
    });
    this.pushToast('warning', '会务组发布了第二版名册', `已按新名册重新对账：挂起 ${summary.held} 个挂名，已上屏对不上的 ${summary.onScreen} 段照旧保留`);
  }

  private patchRosterEntry(id: string, patch: Partial<RosterEntry>): void {
    const entries = this.roster.entries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry);
    const syncState: RosterModel['syncState'] = this.model.connection === 'offline' ? 'offline-pending' : 'synced';
    this.applyRoster({ ...this.roster, entries, syncState, syncedAt: Date.now() });
  }

  private editRosterAliases(id: string, value: string): void {
    const aliases = value.split(/[,，、]/u).map((item) => item.trim()).filter(Boolean);
    this.patchRosterEntry(id, { aliases });
  }

  private toggleRosterEntry(entry: RosterEntry): void {
    this.patchRosterEntry(entry.id, { active: !entry.active, replacedBy: entry.active ? entry.replacedBy : undefined });
  }

  /** 会务组确认：把挂着的名字补录进名册，挂起片段逐条自动解除。 */
  private claimHeldName(name: string): void {
    const entry: RosterEntry = {
      id: `roster-${Date.now().toString(36)}`,
      officialName: name,
      title: '待会务组补全职务',
      aliases: [name],
      active: true,
    };
    const summary = this.applyRoster({
      ...this.roster,
      entries: [entry, ...this.roster.entries],
      syncedAt: Date.now(),
      syncState: this.model.connection === 'offline' ? 'offline-pending' : 'synced',
    });
    this.pushToast('success', `已把挂名「${name}」补录进名册`, `相关片段解除挂起，当前仍有 ${summary.held} 个挂名待确认`);
  }

  /** 会务组确认换人：把挂旧称呼的片段改挂到接手人，再对账解除。 */
  private reattachHeldName(name: string): void {
    const inactive = findRosterEntry(this.roster.entries, name);
    const target = inactive?.replacedBy ? this.roster.entries.find((entry) => entry.id === inactive.replacedBy) : undefined;
    if (!inactive || !target) {
      this.pushToast('warning', '名册里没有接手人', '请先在名册中补录或改写法');
      return;
    }
    this.commit(`会务组确认改挂到「${target.officialName}」`, (current) => {
      const mapped = current.segments.map((item) => item.state === 'held' && item.speaker === name
        ? { ...item, speaker: target.officialName, speakerKey: normalizeSpeakerKey(target.officialName), revision: item.revision + 1 }
        : item);
      return { ...current, segments: reconcileSpeakers(mapped, this.roster.entries).segments };
    });
  }

  private addRosterEntry(): void {
    const officialName = this.rosterName.trim();
    const title = this.rosterTitle.trim();
    if (!officialName) {
      this.pushToast('warning', '正式姓名不能为空', '职务可以稍后再补');
      return;
    }
    const entry: RosterEntry = {
      id: `roster-${Date.now().toString(36)}`,
      officialName,
      title: title || '待补职务',
      aliases: [officialName],
      active: true,
    };
    const summary = this.applyRoster({
      ...this.roster,
      entries: [entry, ...this.roster.entries],
      syncedAt: Date.now(),
      syncState: this.model.connection === 'offline' ? 'offline-pending' : 'synced',
    });
    this.rosterName = '';
    this.rosterTitle = '';
    this.pushToast('success', '名册已新增发言人', `逐条对账后解除挂起 ${summary.resolved} 个挂名`);
  }

  private reconcileManually(): void {
    const result = reconcileSpeakers(this.model.segments, this.roster.entries);
    this.automatic({ ...this.model, segments: result.segments });
    this.pushToast('info', '已按出席名册逐条对账', `挂起 ${result.heldNames.length} 个挂名 · 解除 ${result.resolvedNames.length} 个 · 已上屏未匹配 ${result.unmatchedOnScreen} 段照旧保留`);
  }

  private acknowledgeMigration(): void {
    if (!this.model.migration) return;
    this.automatic({ ...this.model, migration: { ...this.model.migration, acknowledged: true } });
  }

  private addRuleFromSelection(): void {
    const selected = this.selected;
    if (!selected) return;
    this.ruleSource = selected.corrected.length > 24 ? selected.corrected.slice(0, 24) : selected.corrected;
    this.ruleReplacement = selected.corrected;
    this.ruleSpeaker = selected.speaker;
    this.showRuleForm = true;
  }

  private addRule(): void {
    const source = this.ruleSource.trim();
    const replacement = this.ruleReplacement.trim();
    if (!source || !replacement) {
      this.pushToast('warning', '规则不完整', '原文和替换文本均不能为空');
      return;
    }
    this.commit('新增术语快捷规则', (current) => ({
      ...current,
      rules: [{
        id: `term-${Date.now().toString(36)}`,
        source,
        replacement,
        speaker: this.ruleSpeaker,
        enabled: true,
        caseSensitive: false,
        usageCount: 0,
        createdAt: Date.now(),
      }, ...current.rules],
    }));
    this.ruleSource = '';
    this.ruleReplacement = '';
    this.ruleSpeaker = '';
    this.showRuleForm = false;
  }

  private deleteRule(id: string): void {
    this.commit('删除术语规则', (current) => ({ ...current, rules: current.rules.filter((item) => item.id !== id) }));
  }

  private exportSrt(): void {
    const content = toSrt(this.model);
    if (!content) {
      this.pushToast('warning', '暂无已确认字幕', '先确认至少一个片段再导出');
      return;
    }
    const blob = new Blob([content], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${this.model.eventName.replace(/[^\p{L}\p{N}-]+/gu, '-')}.srt`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.pushToast('success', 'SRT 已导出', `${toSrt(this.model).split('\n\n').length} 段字幕`);
  }

  private adjustFont(delta: number): void {
    const fontSize = Math.max(14, Math.min(28, this.model.fontSize + delta));
    this.automatic({ ...this.model, fontSize });
  }

  private toggleTheme(): void {
    this.dark = !this.dark;
    localStorage.setItem(`${STORAGE_KEY}-theme`, this.dark ? 'dark' : 'light');
  }

  private handleShortcut = (event: KeyboardEvent): void => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLocaleLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLocaleLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (modifier && event.key === 'Enter') {
      event.preventDefault();
      this.confirmSelected();
      return;
    }
    if (event.altKey && event.key.toLocaleLowerCase() === 'j') {
      event.preventDefault();
      this.navigate(1);
      return;
    }
    if (event.altKey && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault();
      this.navigate(-1);
      return;
    }
    const punctuation: Record<string, string> = { '1': '，', '2': '。', '3': '？', '4': '！' };
    if (modifier && punctuation[event.key]) {
      event.preventDefault();
      this.insertPunctuation(punctuation[event.key]);
    }
  };

  private renderPendingList() {
    const segments = this.pendingSegments;
    if (!segments.length) {
      return html`<div class="empty"><strong>待确认区已清空</strong><p>新的实时片段到达时会自动进入这里。</p></div>`;
    }
    return html`
      <div class="segment-list">
        ${segments.map((item) => html`
          <button class="segment-card ${item.id === this.model.selectedId ? 'selected' : ''} ${item.state}" @click=${() => this.selectSegment(item.id)}>
            <div class="segment-meta">
              <span>${formatClock(item.startTime)} · #${String(item.sequence).padStart(3, '0')}</span>
              <span class="segment-state ${item.state}">${stateLabel(item.state)}</span>
            </div>
            <p class="segment-text">${item.original}</p>
            ${item.corrected !== item.original ? html`<p class="segment-corrected">${item.corrected}</p>` : nothing}
            <div class="segment-foot">
              <span title="片段上挂的姓名（字幕台持有）">挂名：${item.speaker}</span>
              ${item.speakerResolved ? html`<span class="resolved-chip" title=${`名册正式信息：${item.speakerResolved.title}`}>→ ${item.speakerResolved.officialName} · ${item.speakerResolved.title}</span>` : nothing}
              <span>·</span>
              <span>${formatAge(item.receivedAt)}</span>
              ${item.revision > 0 ? html`<span>· <b>修改 ${item.revision} 次</b></span>` : nothing}
            </div>
            ${item.state === 'held' ? html`<div class="issue-note hold-note">${item.holdReason}。挂起期间不送直播区，请会务组在右侧名册确认。</div>` : nothing}
            ${item.state === 'stale' && item.staleReason ? html`<div class="issue-note">${item.staleReason}。确认前请核对直播上下文。</div>` : nothing}
            ${item.state === 'duplicate' ? html`<div class="issue-note duplicate-note">${item.staleReason || '检测到重复片段'}，请保留或忽略。</div>` : nothing}
          </button>
        `)}
      </div>
    `;
  }

  private renderEditor() {
    const item = this.selected;
    if (!item) {
      return html`<div class="empty"><strong>选择一条待确认字幕</strong><p>可以使用 Alt+J / Alt+K 在片段之间移动。</p></div>`;
    }
    const applicableRules = this.model.rules.filter((rule) => rule.enabled && (!rule.speaker || rule.speaker === item.speaker));
    const rosterNames: string[] = [];
    for (const entry of this.roster.entries.filter((rosterEntry) => rosterEntry.active)) {
      if (!rosterNames.includes(entry.officialName)) rosterNames.push(entry.officialName);
    }
    if (!rosterNames.includes(item.speaker)) rosterNames.unshift(item.speaker);
    return html`
      <div class="editor-scroll">
        <div class="editor-card">
          <div class="editor-top">
            <div>
              <div class="editor-time">${formatClock(item.startTime)} — ${formatClock(item.startTime + 7)}</div>
              <p class="editor-title">实时片段 #${String(item.sequence).padStart(3, '0')} · 到达于 ${formatAge(item.receivedAt)}</p>
            </div>
            <div class="editor-status">
              <cds-tag type=${item.state === 'stale' ? 'warm-gray' : item.state === 'duplicate' ? 'purple' : item.state === 'held' ? 'red' : 'blue'} size="sm">${stateLabel(item.state)}</cds-tag>
              <cds-tag type="outline" size="sm">修改 ${item.revision} 次</cds-tag>
            </div>
          </div>
          <div class="editor-form">
            ${item.state === 'held' ? html`
              <cds-inline-notification kind="error" low-contrast title="发言人对账未通过，片段挂起中" subtitle=${item.holdReason || '名册查无此挂名'}>
                <cds-button slot="action" size="sm" @click=${this.reconcileManually}>重新按名册对账</cds-button>
              </cds-inline-notification>
            ` : nothing}
            ${item.state === 'duplicate' ? html`
              <cds-inline-notification kind="warning" low-contrast title="重复片段提示" subtitle=${item.staleReason || '与已确认片段高度相似'}>
                <cds-button slot="action" size="sm" @click=${this.recoverDuplicate}>保留并继续校对</cds-button>
              </cds-inline-notification>
            ` : nothing}
            ${item.state === 'stale' ? html`
              <cds-inline-notification kind="warning" low-contrast title="过期修改" subtitle=${`${item.staleReason || '该片段已超过 90 秒未确认'}。请结合上下文确认，或忽略以避免污染直播区。`}></cds-inline-notification>
            ` : nothing}
            <div class="form-grid">
              <cds-select label-text="挂名发言人（按出席名册对账）" value=${item.speaker} @cds-select-selected=${(event: CustomEvent<{ value: string }>) => this.changeSpeaker(event.detail.value)}>
                ${rosterNames.map((speaker) => html`<cds-select-item value=${speaker}>${speaker}</cds-select-item>`)}
              </cds-select>
              <cds-number-input class="number-input" label="延迟（秒）" .value=${this.model.simulatedDelay} step="0.1" min="0" max="9" @input=${(event: Event) => this.automatic({ ...this.model, simulatedDelay: Number((event.currentTarget as any).value) })}></cds-number-input>
            </div>
            ${item.speakerResolved ? html`
              <cds-inline-notification kind="info" low-contrast title=${`名册正式信息：${item.speakerResolved.officialName}`} subtitle=${`${item.speakerResolved.title} · 由出席名册 ${this.roster.versionName} 映上，字幕台不手抄职务`}></cds-inline-notification>
            ` : nothing}
            <cds-textarea
              class="caption-input"
              label-text="校对后的字幕文本"
              helper-text="Ctrl/⌘ + 1–4 快速插入标点；术语规则将从左到右自动应用"
              .value=${item.corrected}
              @input=${(event: Event) => this.updateSelected({ corrected: (event.currentTarget as any).value }, '')}
            ></cds-textarea>
            <div class="edit-toolbar">
              <span>快速标点</span>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('，')}>，逗号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('。')}>。句号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('？')}>？问号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('…')}>…省略</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.wrapSelection('（', '）')}>（）括注</cds-button>
              <cds-button kind="secondary" size="sm" @click=${this.normalizeCurrentNumbers}>规范化数字</cds-button>
            </div>
            <div class="rule-suggestions">
              <small>术语快捷替换</small>
              ${applicableRules.length ? applicableRules.map((rule) => html`
                <cds-button kind="tertiary" size="sm" @click=${() => this.applyTerm(rule.id)}>${rule.source} → ${rule.replacement}</cds-button>
              `) : html`<small>当前发言人的规则为空</small>`}
              <cds-button kind="ghost" size="sm" @click=${this.addRuleFromSelection}>＋ 从当前文本新建</cds-button>
            </div>
          </div>
          <div class="confirm-bar">
            <div class="confirm-hint"><kbd>⌘/Ctrl Enter</kbd> 确认并进入直播区 · <kbd>Alt J/K</kbd> 切换片段${item.state === 'held' ? ' · 挂起片段需会务组确认后才能上屏' : ''}</div>
            <div>
              <cds-button kind="danger--tertiary" size="sm" @click=${this.ignoreSelected}>忽略片段</cds-button>
              <cds-button kind="primary" ?disabled=${item.state === 'held'} @click=${this.confirmSelected}>确认并送入直播区</cds-button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderRosterSection() {
    const failed = this.roster.syncState === 'refetch-failed';
    const offlinePending = this.model.connection === 'offline';
    return html`
      <section class="inspector-section">
        <div class="inspector-section-head">
          <h3>出席名册（会务组那份）</h3>
          <span>${this.roster.versionName} · ${this.roster.entries.filter((entry) => entry.active).length} 人在册</span>
        </div>
        <div class="roster-body">
          <div class="roster-sync">
            <div>
              <cds-tag type=${failed ? 'red' : offlinePending ? 'warm-gray' : 'green'} size="sm">
                ${failed ? '重领失败' : offlinePending ? '离线暂存' : '已同步'}
              </cds-tag>
              <small>${failed ? (this.roster.lastError ?? '名册服务不可用') : `最近领取 ${formatAge(this.roster.syncedAt)}`}</small>
            </div>
            <div>
              <cds-button kind="ghost" size="xs" @click=${this.toggleFailNextRefetch}>${this.failNextRefetch ? '✓ 下次领取将失败' : '模拟领取失败'}</cds-button>
              <cds-button kind="tertiary" size="xs" @click=${this.refetchRoster}>重新领取</cds-button>
              <cds-button kind="primary" size="xs" ?disabled=${this.roster.serverVersion >= 2} @click=${this.publishRosterRevision}>
                ${this.roster.serverVersion >= 2 ? '已是第二版' : '发第二版（换人/改写法）'}
              </cds-button>
            </div>
          </div>
          ${failed ? html`
            <cds-inline-notification kind="error" low-contrast title="名册对账失败，只重领会务组这份" subtitle="字幕台的片段正文和上屏内容没有改动；网络恢复后点“重新领取”即可。"></cds-inline-notification>
          ` : nothing}
          ${offlinePending ? html`
            <cds-inline-notification kind="info" low-contrast title="断网期间名册照常可改" subtitle="改动暂存在本地这份名册，回网合并后随“恢复并合并”补送对账。"></cds-inline-notification>
          ` : nothing}

          ${this.roster.entries.map((entry) => html`
            <div class="roster-entry ${entry.active ? '' : 'inactive'}">
              <div class="roster-entry-head">
                <small>${entry.active ? '在册' : '已停用 / 换人'}</small>
                <div class="roster-entry-actions">
                  <cds-button kind=${entry.active ? 'danger--ghost' : 'ghost'} size="xs" @click=${() => this.toggleRosterEntry(entry)}>${entry.active ? '停用' : '恢复'}</cds-button>
                </div>
              </div>
              <input class="roster-input" .value=${entry.officialName} placeholder="正式姓名" @change=${(event: Event) => this.patchRosterEntry(entry.id, { officialName: (event.currentTarget as HTMLInputElement).value })} />
              <input class="roster-input" .value=${entry.title} placeholder="职务" @change=${(event: Event) => this.patchRosterEntry(entry.id, { title: (event.currentTarget as HTMLInputElement).value })} />
              <input class="roster-input" .value=${entry.aliases.join('，')} placeholder="片段上可能挂的写法（逗号分隔）" @change=${(event: Event) => this.editRosterAliases(entry.id, (event.currentTarget as HTMLInputElement).value)} />
            </div>
          `)}

          <div class="roster-add">
            <input class="roster-input" placeholder="新发言人正式姓名" .value=${this.rosterName} @input=${(event: Event) => { this.rosterName = (event.currentTarget as HTMLInputElement).value; }} />
            <input class="roster-input" placeholder="职务" .value=${this.rosterTitle} @input=${(event: Event) => { this.rosterTitle = (event.currentTarget as HTMLInputElement).value; }} />
            <cds-button class="full" kind="tertiary" size="sm" @click=${this.addRosterEntry}>＋ 名册补录发言人</cds-button>
          </div>

          <div class="roster-sync">
            <small>两边按片段挂名逐条对账</small>
            <cds-button kind="ghost" size="xs" @click=${this.reconcileManually}>立即对账</cds-button>
          </div>

          ${this.heldGroups.length ? this.heldGroups.map((group) => {
            const inactive = findRosterEntry(this.roster.entries, group.name);
            const target = inactive?.replacedBy ? this.roster.entries.find((rosterEntry) => rosterEntry.id === inactive.replacedBy) : undefined;
            return html`
              <div class="roster-held">
                <div class="roster-held-head">
                  <span>挂名「${group.name}」待确认</span>
                  <span>#${group.sequences.map((sequence) => String(sequence).padStart(3, '0')).join('、')}</span>
                </div>
                <p>${inactive && !inactive.active
                  ? `名册显示已换人，正式记录为「${inactive.officialName}」${target ? `，接手人：${target.officialName} · ${target.title}` : ''}`
                  : '出席名册里没有这个写法'}</p>
                <div class="roster-held-actions">
                  <cds-button kind="primary" size="xs" @click=${() => this.claimHeldName(group.name)}>补录为正式发言人</cds-button>
                  ${target ? html`<cds-button kind="tertiary" size="xs" @click=${() => this.reattachHeldName(group.name)}>改挂到「${target.officialName}」</cds-button>` : nothing}
                </div>
              </div>
            `;
          }) : html`<small style="color:#198038;">所有待确认片段的挂名都能在名册中对上。</small>`}
        </div>
      </section>
    `;
  }

  // 内联事件里避免直接读状态字段时写错，保留一个语义化小方法。
  private toggleFailNextRefetch(): void {
    this.failNextRefetch = !this.failNextRefetch;
  }

  private renderMigrationNotice() {
    const report = this.migration;
    if (!report) return nothing;
    return html`
      <section class="inspector-section">
        <div class="inspector-section-head">
          <h3>旧数据升级回填</h3>
          <span>${new Date(report.migratedAt).toLocaleString('zh-CN')}</span>
        </div>
        <div style="padding: 10px;">
          <cds-inline-notification kind=${report.unresolved.length ? 'warning' : 'success'} low-contrast
            title=${report.unresolved.length ? `旧稿已回填发言人来源，${report.unresolved.length} 段对不上名册` : '旧稿已完成发言人来源回填，全部对得上名册'}
            subtitle=${`共回填 ${report.backfilled} 条片段的发言人来源；未确认且对不上的已挂起，已上屏的照旧保留并单列。`}>
            <cds-button slot="action" size="sm" @click=${this.acknowledgeMigration}>知道了</cds-button>
          </cds-inline-notification>
          ${report.unresolved.length ? html`
            <ul class="migration-list">
              ${report.unresolved.map((item) => html`
                <li>#${String(item.sequence).padStart(3, '0')} · 挂名「${item.speaker}」${item.onScreen ? ' · 已上屏（照旧保留）' : ' · 已挂起待会务组确认'}</li>
              `)}
            </ul>
          ` : nothing}
        </div>
      </section>
    `;
  }

  private renderInspector() {
    const item = this.selected;
    const confirmed = this.model.segments.filter((segment) => segment.state === 'confirmed').sort((a, b) => a.startTime - b.startTime);
    return html`
      <div class="inspector">
        ${this.renderRosterSection()}
        ${this.renderMigrationNotice()}

        <section class="inspector-section">
          <div class="inspector-section-head">
            <h3>术语快捷规则</h3>
            <span>${this.model.rules.filter((rule) => rule.enabled).length} 条启用</span>
          </div>
          <div class="rule-list">
            ${this.model.rules.map((rule) => html`
              <div class="rule-item">
                <div>
                  <strong>${rule.source} → ${rule.replacement}</strong>
                  <p>${rule.speaker || '全部发言人'} · 已使用 ${rule.usageCount} 次</p>
                </div>
                <div class="rule-item-actions">
                  <cds-button kind="ghost" size="sm" @click=${() => this.applyTerm(rule.id)}>应用</cds-button>
                  <cds-button kind="danger--ghost" size="xs" @click=${() => this.deleteRule(rule.id)}>删除</cds-button>
                </div>
              </div>
            `)}
          </div>
          ${this.showRuleForm ? html`
            <div class="rule-form">
              <cds-text-input label-text="原文" .value=${this.ruleSource} @input=${(event: Event) => { this.ruleSource = (event.currentTarget as any).value; }}></cds-text-input>
              <cds-text-input label-text="替换为" .value=${this.ruleReplacement} @input=${(event: Event) => { this.ruleReplacement = (event.currentTarget as any).value; }}></cds-text-input>
              <cds-text-input class="full" label-text="仅对某发言人应用（可空）" .value=${this.ruleSpeaker} @input=${(event: Event) => { this.ruleSpeaker = (event.currentTarget as any).value; }}></cds-text-input>
              <cds-button class="full" size="sm" kind="primary" @click=${this.addRule}>保存规则</cds-button>
            </div>
          ` : html`
            <div style="padding: 10px;"><cds-button kind="tertiary" size="sm" @click=${() => { this.showRuleForm = true; }}>＋ 新增术语规则</cds-button></div>
          `}
        </section>

        <section class="inspector-section">
          <div class="inspector-section-head">
            <h3>直播区时间线</h3>
            <span>${confirmed.length} 段已上屏</span>
          </div>
          <div class="live-timeline">
            ${confirmed.length ? confirmed.slice(-12).reverse().map((segment) => html`
              <article class="live-item">
                <time>${formatClock(segment.startTime)} · ${segment.speakerResolved ? `${segment.speakerResolved.officialName}（${segment.speakerResolved.title}）` : segment.speaker}</time>
                <p>${segment.corrected}</p>
                ${segment.source === 'offline' ? html`<small>离线来源 · 恢复后按序号合并</small>` : nothing}
                ${segment.holdReason ? html`<small class="onscreen-hold">${segment.holdReason}</small>` : nothing}
              </article>
            `) : html`<div class="empty"><strong>直播区等待内容</strong><p>确认一块字幕后，它会从这里进入实时输出。</p></div>`}
          </div>
          ${this.stats.held > 0 ? html`<div class="delivery-status held">有 ${this.stats.held} 段发言人对账未通过被挂起，会务组确认前不会送进直播区；已上屏内容不受影响。</div>` : nothing}
          ${this.stats.offline > 0 ? html`<div class="delivery-status">离线发件箱有 ${this.stats.offline} 段待合并。恢复连接后按序号提交，不会覆盖已确认内容。</div>` : nothing}
        </section>

        <section class="inspector-section">
          <div class="inspector-section-head">
            <h3>当前片段上下文</h3>
            <span>${item ? `#${item.sequence}` : '未选择'}</span>
          </div>
          <div style="padding: 12px; line-height: 1.5; font-size: 11px;">
            ${item ? html`
              <div><strong>原始字幕：</strong>${item.original}</div>
              <div style="margin-top: 8px;"><strong>修改前校正：</strong>${item.corrected}</div>
              <div style="margin-top: 8px;"><strong>挂名来源：</strong>${item.speakerKey}${item.speakerResolved ? html` · 正式：${item.speakerResolved.officialName} / ${item.speakerResolved.title}` : ' · 名册未命中'}</div>
              <div style="margin-top: 8px; color: var(--cds-text-secondary);">${item.tags.length ? `标签：${item.tags.join('、')}` : '尚未应用术语标签'}</div>
            ` : html`<span>请选择片段以查看上下文。</span>`}
          </div>
        </section>
      </div>
    `;
  }

  render() {
    const stats = this.stats;
    const backlogRatio = Math.min(100, stats.backlog * 8);
    return html`
      <div class="shell ${this.dark ? 'dark' : ''}" style=${`--caption-font-size: ${this.model.fontSize}px`}>
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">CC</div>
            <div class="brand-copy">
              <strong>LiveCaption Desk</strong>
              <span>${this.model.eventName} · ${this.model.eventDate}</span>
            </div>
          </div>
          <div class="connection-pill ${this.model.connection}">
            <span class="connection-dot"></span>
            <div class="connection-copy">
              <strong>${connectionLabel(this.model.connection)} · ${this.model.simulatedDelay.toFixed(1)} 秒延迟</strong>
              <small>${this.model.connection === 'offline'
                ? '仍可编辑，确认内容进入离线发件箱，名册改动也留本地'
                : `待确认 ${stats.pending} 段 · 挂起 ${stats.held} 段 · 最近自动保存 ${new Date(this.model.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}</small>
            </div>
          </div>
          <div class="header-actions">
            <cds-button kind="ghost" size="sm" @click=${this.toggleTheme}>${this.dark ? '浅色界面' : '深色值守'}</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.undo}>撤销</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.redo}>重做</cds-button>
            <cds-button kind="primary" size="sm" @click=${this.exportSrt}>导出 SRT</cds-button>
          </div>
        </header>

        <section class="status-strip">
          <div class="status-cell hero">
            <strong>${this.model.connection === 'offline' ? '离线校正中，确认后暂存发件箱' : stats.held > 0 ? '有片段发言人对账未通过，挂起等会务组确认' : stats.backlog > 8 ? '队列积压，建议优先处理过期片段' : '队列节奏正常，可以继续逐段确认'}</strong>
            <span>待确认 ${stats.pending} · 挂起 ${stats.held} · 过期 ${stats.stale} · 重复 ${stats.duplicate} · 离线待合并 ${stats.offline}</span>
            <div class="queue-track"><span style=${`width:${backlogRatio}%`}></span></div>
          </div>
          <div class="status-cell"><strong>${stats.pending}</strong><span>待确认片段</span></div>
          <div class="status-cell ${stats.held > 0 ? 'danger' : ''}"><strong>${stats.held}</strong><span>挂起等名册确认</span></div>
          <div class="status-cell warning"><strong>${stats.oldestWaitSeconds}s</strong><span>最长等待时间</span></div>
          <div class="status-cell danger"><strong>${stats.stale + stats.duplicate}</strong><span>需要明确处理</span></div>
          <div class="font-controls">
            <label>字幕字号</label>
            <cds-button kind="ghost" size="sm" @click=${() => this.adjustFont(-1)}>A−</cds-button>
            <strong>${this.model.fontSize}</strong>
            <cds-button kind="ghost" size="sm" @click=${() => this.adjustFont(1)}>A＋</cds-button>
          </div>
        </section>

        <main class="workspace">
          <section class="column">
            <div class="column-head">
              <div>
                <h2>待确认区</h2>
                <p>按收到顺序排列，挂起、重复和过期内容不会被静默覆盖</p>
              </div>
              <cds-dropdown value=${this.filter} @cds-dropdown-selected=${(event: CustomEvent<{ item: { value: string } }>) => { this.filter = event.detail.item.value as typeof this.filter; }}>
                <cds-dropdown-item value="active">仅需处理</cds-dropdown-item>
                <cds-dropdown-item value="attention">异常优先</cds-dropdown-item>
                <cds-dropdown-item value="all">全部片段</cds-dropdown-item>
              </cds-dropdown>
            </div>
            <div class="column-body">${this.renderPendingList()}</div>
          </section>

          <section class="column">
            <div class="column-head">
              <div>
                <h2>校对编辑台</h2>
                <p>字幕台只管片段正文和挂名；正式姓名与职务以出席名册为准</p>
              </div>
              <cds-tag type="green" size="sm">本地草稿</cds-tag>
            </div>
            <div class="column-body" style=${`font-size:${this.model.fontSize}px`}>${this.renderEditor()}</div>
          </section>

          <section class="column">
            <div class="column-head">
              <div>
                <h2>名册、规则与直播区</h2>
                <p>名册管正式姓名和职务；挂起片段不上屏，离线内容恢复后统一合并</p>
              </div>
              ${this.model.connection === 'offline'
                ? html`<cds-button kind="primary" size="sm" @click=${this.mergeOffline}>恢复并合并</cds-button>`
                : html`<cds-button kind="danger--tertiary" size="sm" @click=${() => this.setConnection('offline')}>模拟断线</cds-button>`}
            </div>
            <div class="column-body">${this.renderInspector()}</div>
          </section>
        </main>

        <div class="toast-stack">
          ${this.toasts.map((toast) => html`
            <cds-toast-notification
              kind=${toast.kind}
              title=${toast.title}
              subtitle=${toast.subtitle}
              @cds-notification-closed=${() => { this.toasts = this.toasts.filter((item) => item.id !== toast.id); }}
            ></cds-toast-notification>
          `)}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'caption-desk': CaptionDesk;
  }
}
