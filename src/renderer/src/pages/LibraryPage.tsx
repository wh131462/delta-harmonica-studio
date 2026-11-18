/**
 * 音乐方案库页面
 * ------------------------------------------------------------------
 * 结构：PageHeader → 未保存提示（条件出现）→ 紧凑统计行 →
 *       工具栏（搜索/视图、筛选/排序/刷新）→ 结果（网格卡片 / 紧凑列表）→ 批量操作条。
 * 功能：搜索（标题/艺术家）、筛选（全部/收藏/游戏任务曲/导入曲谱/手动录入）、
 *       排序（最近更新/标题/时长/音符数）、网格与列表视图（本地持久化）、
 *       打开演奏台/编辑器、收藏、删除、导出（键位谱/简谱/JSON/鼠标宏/键位表）、
 *       批量管理、当前曲谱标记；未保存修改提示（条件出现，提供继续编辑/保存）。
 * 说明：数据与操作复用 app-store 与 window.api.library；本页只负责呈现与交互编排。
 *       页面样式见 ../styles/library.css（类名统一 library- 前缀）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { importMidiFile } from '@core/import/midi';
import type { Score } from '@core/model/score';
import { buildScoreFromText } from '@core/score/dsl';
import { Icon } from '@renderer/components/Icon';
import { Chip, EmptyState, Notice, PageHeader } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { beatsToMs, formatDateTime, formatDurationMs, keyLabel, sourceKindLabel } from '@renderer/utils/format';
import type { ExportFormat, LibraryEntry } from '@shared/types';
import '../styles/library.css';

type FilterKind = 'all' | 'favorite' | 'game' | 'imported' | 'manual';
type SortKind = 'updated' | 'title' | 'duration' | 'notes';
type ViewMode = 'grid' | 'list';

/** 网格/列表视图的本地记忆键（localStorage） */
const VIEW_MODE_KEY = 'dfh.library.viewMode';

const FILTER_OPTIONS: Array<{ id: FilterKind; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'favorite', label: '收藏' },
  { id: 'game', label: '游戏任务曲' },
  { id: 'imported', label: '导入曲谱' },
  { id: 'manual', label: '手动录入' },
];

const SORT_OPTIONS: Array<{ id: SortKind; label: string }> = [
  { id: 'updated', label: '最近更新' },
  { id: 'title', label: '按标题' },
  { id: 'duration', label: '按时长' },
  { id: 'notes', label: '按音符数' },
];

/** 来源徽标：内置 / MIDI / 音频 / 文本 / 手动 / 键位谱（统一中性色，不抢状态语义） */
const SOURCE_LABELS: Record<string, string> = {
  builtin: '内置',
  midi: 'MIDI',
  audio: '音频',
  text: '文本',
  manual: '手动',
  keyscore: '键位谱',
};

function getSourceLabel(kind: string): string {
  return SOURCE_LABELS[kind] ?? sourceKindLabel(kind);
}

/** 由「拍数 + 速度」换算出毫秒，用于时长展示 */
function entryDurationMs(entry: LibraryEntry): number {
  return beatsToMs(entry.durationBeats, entry.tempo);
}

function formatEntryDuration(entry: LibraryEntry): string {
  return formatDurationMs(entryDurationMs(entry));
}

/** 筛选语义与原页面保持一致（游戏任务曲暂用标题关键词近似识别） */
function matchesFilter(entry: LibraryEntry, filter: FilterKind): boolean {
  if (filter === 'all') return true;
  if (filter === 'favorite') return entry.favorite;
  if (filter === 'game') return entry.title.includes('风声未止') || entry.title.includes('任务');
  if (filter === 'imported') return entry.sourceKind === 'midi' || entry.sourceKind === 'audio';
  return entry.sourceKind === 'manual' || entry.sourceKind === 'text' || entry.sourceKind === 'builtin';
}

/** 列表排序（返回新数组，不改动 store 数据） */
function sortEntries(list: LibraryEntry[], sort: SortKind): LibraryEntry[] {
  const copy = [...list];
  if (sort === 'title') return copy.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  if (sort === 'duration') return copy.sort((a, b) => entryDurationMs(b) - entryDurationMs(a));
  if (sort === 'notes') return copy.sort((a, b) => b.noteCount - a.noteCount);
  return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 读取上次使用的视图模式（读取失败时回退到网格） */
function readViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function LibraryPage(): JSX.Element {
  const app = useAppStore();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKind>('all');
  const [sort, setSort] = useState<SortKind>('updated');
  const [view, setView] = useState<ViewMode>(readViewMode);
  const [importing, setImporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const menuPanelRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);

  // 记住网格/列表视图选择
  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_MODE_KEY, view);
    } catch {
      /* 本地存储不可用时忽略，不影响页面使用 */
    }
  }, [view]);

  // 键盘快捷键：在非输入状态下按 "/" 聚焦搜索框
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 批量模式下按 Esc 退出
  useEffect(() => {
    if (!selectionMode) return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSelectionMode(false);
      setSelectedIds(new Set<string>());
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectionMode]);

  // 批量模式下改变搜索/筛选时清空勾选，避免误操作到已被隐藏的方案
  useEffect(() => {
    if (selectionMode) setSelectedIds(new Set<string>());
  }, [filter, search, selectionMode]);

  // 搜索、筛选、排序、视图或模式变化时收起更多菜单
  useEffect(() => {
    setOpenMenuId(null);
  }, [filter, search, sort, view, selectionMode]);

  // 更多菜单：打开后聚焦第一个菜单项；点击菜单外部或按 Esc 关闭
  useEffect(() => {
    if (!openMenuId) return undefined;
    menuPanelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuWrapRef.current?.contains(event.target)) return;
      setOpenMenuId(null);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [openMenuId]);

  /** 过滤 + 排序后的可见方案 */
  const visibleEntries = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const list = app.entries.filter((entry) => {
      if (!matchesFilter(entry, filter)) return false;
      if (!keyword) return true;
      return entry.title.toLowerCase().includes(keyword) || (entry.artist ?? '').toLowerCase().includes(keyword);
    });
    return sortEntries(list, sort);
  }, [app.entries, filter, search, sort]);

  /** 各筛选项数量（用于按钮的 title / aria-label，不在视觉上堆数字） */
  const filterCounts = useMemo(() => {
    const counts: Record<FilterKind, number> = {
      all: app.entries.length,
      favorite: 0,
      game: 0,
      imported: 0,
      manual: 0,
    };
    for (const entry of app.entries) {
      if (entry.favorite) counts.favorite += 1;
      if (matchesFilter(entry, 'game')) counts.game += 1;
      if (matchesFilter(entry, 'imported')) counts.imported += 1;
      if (matchesFilter(entry, 'manual')) counts.manual += 1;
    }
    return counts;
  }, [app.entries]);

  const isFiltering = search.trim().length > 0 || filter !== 'all';
  const selectedCount = selectedIds.size;

  // ---------------- 基础操作 ----------------

  const openEntry = (entry: LibraryEntry, page: 'play' | 'editor') => {
    void app.openScore(entry.id, page);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 卡片/行的主操作：批量模式下切换选中，否则打开演奏台 */
  const activateEntry = (entry: LibraryEntry) => {
    if (selectionMode) {
      toggleSelected(entry.id);
      return;
    }
    openEntry(entry, 'play');
  };

  /** 点击卡片空白处（忽略内部按钮与菜单）执行主操作 */
  const handleSurfaceClick = (event: ReactMouseEvent<HTMLElement>, entry: LibraryEntry) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, [role="menu"]')) return;
    activateEntry(entry);
  };

  /** 导出：键位谱 / 简谱文本 / 方案 JSON / 鼠标宏 / 触发键位表 */
  const exportScore = async (id: string, format: ExportFormat) => {
    try {
      const score = await window.api.library.load(id);
      const path = await window.api.library.exportScore(score, format);
      if (path) app.showToast('success', `已导出：${path}`);
    } catch (error) {
      app.showToast('error', `导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const remove = async (entry: LibraryEntry) => {
    if (!window.confirm(`确定删除《${entry.title}》吗？此操作不可撤销。`)) return;
    await app.deleteScore(entry.id);
  };

  const newScore = () => {
    app.setCurrentScore(null, false);
    app.navigate('editor');
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await app.refreshLibrary();
    } finally {
      setRefreshing(false);
    }
  };

  /** 导入文件：.mid/.midi 交给 MIDI 导入器；.json/.dfh 视为方案 JSON；其余按简谱文本解析 */
  const importFiles = async () => {
    setImporting(true);
    try {
      const files = await window.api.library.importScoreFile();
      if (files.length === 0) return;
      let imported = 0;
      for (const file of files) {
        try {
          let score: Score | null = null;
          const lower = file.name.toLowerCase();
          if (lower.endsWith('.mid') || lower.endsWith('.midi')) {
            const result = importMidiFile(file.data, {
              fileName: file.name,
              title: file.name.replace(/\.(mid|midi)$/i, ''),
            });
            score = result.score;
          } else if (lower.endsWith('.json') || lower.endsWith('.dfh')) {
            const parsed = JSON.parse(new TextDecoder('utf-8').decode(file.data)) as Score;
            if (parsed.meta && Array.isArray(parsed.notes)) score = parsed;
          } else {
            const text = new TextDecoder('utf-8').decode(file.data);
            const parsed = buildScoreFromText(text, { title: file.name.replace(/\.[^.]+$/, '') });
            if (!parsed.diagnostics.some((item) => item.severity === 'error')) score = parsed.score;
          }
          if (!score) {
            app.showToast('warning', `无法识别文件格式：${file.name}`);
            continue;
          }
          await window.api.library.save(score);
          imported += 1;
        } catch (error) {
          app.showToast('error', `导入 ${file.name} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await app.refreshLibrary();
      if (imported > 0) app.showToast('success', `成功导入 ${imported} 个音乐方案`);
    } finally {
      setImporting(false);
    }
  };

  // ---------------- 更多菜单 ----------------

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpenMenuId(null);
    if (restoreFocus) menuTriggerRef.current?.focus();
  }, []);

  const toggleMenu = (entry: LibraryEntry, trigger: HTMLButtonElement) => {
    if (openMenuId === entry.id) {
      setOpenMenuId(null);
      return;
    }
    menuTriggerRef.current = trigger;
    setOpenMenuId(entry.id);
  };

  /** 执行菜单项：先收起菜单并把焦点还给触发按钮，再执行动作 */
  const runMenuAction = (action: () => void) => {
    setOpenMenuId(null);
    menuTriggerRef.current?.focus();
    action();
  };

  /** 菜单键盘操作：Esc 关闭并回到触发按钮，方向键在菜单项间移动，Tab 收起菜单 */
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeMenu(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const items = Array.from(menuPanelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Home') {
      items[0]?.focus();
      return;
    }
    if (event.key === 'End') {
      items[items.length - 1]?.focus();
      return;
    }
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + offset + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  // ---------------- 批量管理 ----------------

  const toggleSelectionMode = () => {
    setSelectionMode((previous) => !previous);
    setSelectedIds(new Set<string>());
  };

  const selectAllVisible = () => {
    setSelectedIds(new Set(visibleEntries.map((entry) => entry.id)));
  };

  const clearSelection = () => setSelectedIds(new Set<string>());

  /** 批量收藏 / 取消收藏（只处理状态需要变化的项） */
  const batchFavorite = async (favorite: boolean) => {
    const targets = visibleEntries.filter((entry) => selectedIds.has(entry.id) && entry.favorite !== favorite);
    if (targets.length === 0) {
      app.showToast('info', favorite ? '选中的方案都已经收藏过了' : '选中的方案都没有收藏');
      return;
    }
    for (const entry of targets) {
      await app.toggleFavorite(entry.id);
    }
    app.showToast('success', `已${favorite ? '收藏' : '取消收藏'} ${targets.length} 个方案`);
  };

  /** 批量删除（逐个走 store，保持与单条删除一致的清理逻辑） */
  const batchRemove = async () => {
    const targets = visibleEntries.filter((entry) => selectedIds.has(entry.id));
    if (targets.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${targets.length} 个音乐方案吗？此操作不可撤销。`)) return;
    setSelectedIds(new Set<string>());
    for (const entry of targets) {
      await app.deleteScore(entry.id);
    }
    app.showToast('success', `已删除 ${targets.length} 个音乐方案`);
  };

  const resetFilters = () => {
    setSearch('');
    setFilter('all');
  };

  // ---------------- 收藏 / 选择 / 更多菜单 ----------------

  /** 收藏星标（aria-pressed 表达状态，与「当前」徽标语义区分） */
  const renderFavorite = (entry: LibraryEntry): JSX.Element => (
    <button
      type="button"
      className="btn btn--icon btn--sm btn--quiet library-fav"
      aria-pressed={entry.favorite}
      aria-label={entry.favorite ? `取消收藏《${entry.title}》` : `收藏《${entry.title}》`}
      title={entry.favorite ? '取消收藏' : '收藏'}
      onClick={() => void app.toggleFavorite(entry.id)}
    >
      <Icon name="star" size={15} />
    </button>
  );

  /** 批量模式下的选择开关 */
  const renderSelectToggle = (entry: LibraryEntry, checked: boolean): JSX.Element => (
    <button
      type="button"
      className={`btn btn--icon btn--sm ${checked ? 'is-active' : ''}`}
      aria-pressed={checked}
      aria-label={checked ? `取消选择《${entry.title}》` : `选择《${entry.title}》`}
      title={checked ? '取消选择' : '选择'}
      onClick={() => toggleSelected(entry.id)}
    >
      <Icon name={checked ? 'checkbox' : 'checkbox-blank'} size={15} />
    </button>
  );

  /** 更多操作菜单（打开编辑器 / 导出 / 删除），网格与列表共用 */
  const renderMenu = (entry: LibraryEntry): JSX.Element => {
    const menuId = `library-menu-${entry.id}`;
    const open = openMenuId === entry.id;
    return (
      <div className="library-menu-anchor" ref={open ? menuWrapRef : undefined}>
        <button
          type="button"
          className="btn btn--icon btn--sm btn--quiet library-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={`《${entry.title}》更多操作`}
          title="更多操作"
          onClick={(event) => toggleMenu(entry, event.currentTarget)}
        >
          <Icon name="more" size={16} />
        </button>
        {open ? (
          <div
            id={menuId}
            className="library-menu"
            role="menu"
            aria-label={`《${entry.title}》操作`}
            ref={menuPanelRef}
            onKeyDown={handleMenuKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="library-menu__item"
              onClick={() => runMenuAction(() => openEntry(entry, 'editor'))}
            >
              <Icon name="edit" size={14} /> 在编辑器中打开
            </button>
            <span className="library-menu__sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="library-menu__item"
              onClick={() => runMenuAction(() => void exportScore(entry.id, 'keys'))}
            >
              <Icon name="download" size={14} /> 导出键位谱
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="library-menu__item"
              onClick={() => runMenuAction(() => void exportScore(entry.id, 'dsl'))}
            >
              <Icon name="download" size={14} /> 导出简谱文本
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="library-menu__item"
              onClick={() => runMenuAction(() => void exportScore(entry.id, 'json'))}
            >
              <Icon name="download" size={14} /> 导出方案 JSON
            </button>
            <span className="library-menu__sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="library-menu__item"
              onClick={() => runMenuAction(() => void exportScore(entry.id, 'macro-ahk'))}
            >
              <Icon name="download" size={14} /> 导出 AutoHotkey v1 宏
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="library-menu__item"
              onClick={() => runMenuAction(() => void exportScore(entry.id, 'macro-ahk2'))}
            >
              <Icon name="download" size={14} /> 导出 AutoHotkey v2 宏
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="library-menu__item"
              onClick={() => runMenuAction(() => void exportScore(entry.id, 'macro-lua'))}
            >
              <Icon name="download" size={14} /> 导出罗技 G HUB Lua 宏
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="library-menu__item"
              onClick={() => runMenuAction(() => void exportScore(entry.id, 'macro-csv'))}
            >
              <Icon name="download" size={14} /> 导出宏时序表 CSV
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="library-menu__item"
              onClick={() => runMenuAction(() => void exportScore(entry.id, 'trigger-table'))}
            >
              <Icon name="download" size={14} /> 导出触发键位表
            </button>
            <span className="library-menu__sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="library-menu__item library-menu__item--danger"
              onClick={() => runMenuAction(() => void remove(entry))}
            >
              <Icon name="trash" size={14} /> 删除方案
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  // ---------------- 卡片 / 行渲染 ----------------

  const renderCard = (entry: LibraryEntry): JSX.Element => {
    const isCurrent = app.currentScore?.id === entry.id;
    const checked = selectedIds.has(entry.id);
    const updated = formatDateTime(entry.updatedAt) || '未知时间';
    const updatedDate = updated.slice(0, 10);
    return (
      <article
        key={entry.id}
        className="card library-card"
        aria-label={entry.title}
        data-selected={checked ? 'true' : undefined}
        onClick={(event) => handleSurfaceClick(event, entry)}
      >
        <div className="library-card__top">
          <div className="library-card__badges">
            <span className="badge" title={`来源：${sourceKindLabel(entry.sourceKind)}`}>
              {getSourceLabel(entry.sourceKind)}
            </span>
            {isCurrent ? <span className="badge badge--accent">当前</span> : null}
          </div>
          {selectionMode ? renderSelectToggle(entry, checked) : renderFavorite(entry)}
        </div>

        <div className="library-card__heading">
          <button
            type="button"
            className="library-card__title"
            title={entry.title}
            aria-label={selectionMode ? `${checked ? '取消选择' : '选择'}《${entry.title}》` : `演奏《${entry.title}》`}
            onClick={() => activateEntry(entry)}
          >
            {entry.title}
          </button>
          <p className="library-card__artist" title={entry.artist || undefined}>
            {entry.artist || '未填写艺术家'}
          </p>
        </div>

        <div className="chip-row library-card__meta">
          <Chip label="时长" value={formatEntryDuration(entry)} />
          <Chip label="速度" value={`${entry.tempo} BPM`} />
          <Chip label="调号" value={`1=${keyLabel(entry.keyRoot)}`} />
          <Chip label="拍号" value={`${entry.meter.num}/${entry.meter.den}`} />
        </div>

        <div className="library-card__foot">
          <span className="library-card__updated" title={updated}>
            更新于 {updatedDate}
          </span>
          {selectionMode ? null : (
            <div className="library-card__actions">
              <button
                type="button"
                className="btn btn--sm"
                title={`打开演奏台并载入《${entry.title}》`}
                aria-label={`演奏《${entry.title}》`}
                onClick={() => openEntry(entry, 'play')}
              >
                <Icon name="play" size={13} /> 演奏
              </button>
              {renderMenu(entry)}
            </div>
          )}
        </div>
      </article>
    );
  };

  const renderRow = (entry: LibraryEntry): JSX.Element => {
    const isCurrent = app.currentScore?.id === entry.id;
    const checked = selectedIds.has(entry.id);
    const updated = formatDateTime(entry.updatedAt) || '未知时间';
    return (
      <div
        key={entry.id}
        className="library-row"
        data-selected={checked ? 'true' : undefined}
        onClick={(event) => handleSurfaceClick(event, entry)}
      >
        <div className="library-row__side">
          {selectionMode ? renderSelectToggle(entry, checked) : renderFavorite(entry)}
        </div>

        <div className="library-row__main">
          <div className="library-row__title-line">
            <button
              type="button"
              className="library-row__title"
              title={entry.title}
              aria-label={selectionMode ? `${checked ? '取消选择' : '选择'}《${entry.title}》` : `演奏《${entry.title}》`}
              onClick={() => activateEntry(entry)}
            >
              {entry.title}
            </button>
            <span className="badge" title={`来源：${sourceKindLabel(entry.sourceKind)}`}>
              {getSourceLabel(entry.sourceKind)}
            </span>
            {isCurrent ? <span className="badge badge--accent">当前</span> : null}
          </div>
          <p className="library-row__artist" title={entry.artist || undefined}>
            {entry.artist || '未填写艺术家'}
          </p>
        </div>

        <div className="library-row__meta">
          <span>
            <span className="sr-only">时长 </span>
            {formatEntryDuration(entry)}
          </span>
          <span>{entry.tempo} BPM</span>
          <span>1={keyLabel(entry.keyRoot)}</span>
          <span>
            {entry.meter.num}/{entry.meter.den}
          </span>
          <span>{entry.noteCount} 音</span>
        </div>

        <div className="library-row__updated" title={updated}>
          <span className="sr-only">更新于 </span>
          {updated}
        </div>

        <div className="library-row__actions">
          {selectionMode ? null : (
            <>
              <button
                type="button"
                className="btn btn--icon btn--sm btn--quiet"
                aria-label={`演奏《${entry.title}》`}
                title="演奏"
                onClick={() => openEntry(entry, 'play')}
              >
                <Icon name="play" size={15} />
              </button>
              {renderMenu(entry)}
            </>
          )}
        </div>
      </div>
    );
  };

  // ---------------- 页面 ----------------

  const emptyLibrary = app.entries.length === 0;
  const dirtyScore = app.dirty ? app.currentScore : null;

  return (
    <div className="page library-page">
      <PageHeader
        title="音乐方案库"
        subtitle="保存在本机用户数据目录"
        actions={
          <>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void importFiles()}
              disabled={importing}
              title="从文件导入 MIDI / 音频 / 简谱 / 方案 JSON"
            >
              <Icon name="import" size={14} /> {importing ? '导入中…' : '导入文件'}
            </button>
            <button type="button" className="btn btn--primary btn--sm" onClick={newScore}>
              <Icon name="plus" size={14} /> 新建曲谱
            </button>
          </>
        }
      />

      {dirtyScore ? (
        <Notice
          tone="warn"
          title="当前有未保存的修改"
          icon={<Icon name="warning" size={15} />}
          actions={
            <>
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => app.navigate('editor')}>
                继续编辑
              </button>
              <button type="button" className="btn btn--sm" onClick={() => void app.saveCurrentScore()}>
                <Icon name="save" size={13} /> 保存修改
              </button>
            </>
          }
        >
          《{dirtyScore.meta.title}》的修改会随切换曲谱丢失。
        </Notice>
      ) : null}

      {emptyLibrary ? null : (
        <div className="library-tools">
          <div className="library-tools__row">
            <div className="library-search">
              <Icon name="search" size={15} className="library-search__icon" />
              <input
                ref={searchRef}
                type="search"
                className="input library-search__input"
                aria-label="搜索方案标题或艺术家"
                placeholder="搜索标题或艺术家"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.stopPropagation();
                  setSearch('');
                  searchRef.current?.blur();
                }}
              />
              {search ? (
                <button
                  type="button"
                  className="btn btn--icon btn--sm btn--quiet library-search__clear"
                  aria-label="清除搜索"
                  title="清除搜索"
                  onClick={() => {
                    setSearch('');
                    searchRef.current?.focus();
                  }}
                >
                  <Icon name="close" size={14} />
                </button>
              ) : (
                <kbd className="library-search__hint" title="按 / 聚焦搜索">
                  /
                </kbd>
              )}
            </div>

            <div className="segmented library-view" role="group" aria-label="视图切换">
              <button
                type="button"
                className="segmented__item"
                aria-pressed={view === 'grid'}
                aria-label="网格视图"
                title="网格视图"
                onClick={() => setView('grid')}
              >
                <Icon name="grid" size={15} />
              </button>
              <button
                type="button"
                className="segmented__item"
                aria-pressed={view === 'list'}
                aria-label="列表视图"
                title="列表视图"
                onClick={() => setView('list')}
              >
                <Icon name="list" size={15} />
              </button>
            </div>
          </div>

          <div className="library-tools__row">
            <div className="segmented" role="group" aria-label="筛选方案">
              {FILTER_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="segmented__item"
                  aria-pressed={filter === option.id}
                  aria-label={`${option.label}，${filterCounts[option.id]} 个方案`}
                  title={`${option.label} · ${filterCounts[option.id]} 个`}
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="library-tools__end">
              <select
                className="select compact"
                value={sort}
                aria-label="排序方式"
                title="排序方式"
                onChange={(event) => setSort(event.target.value as SortKind)}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="btn btn--icon btn--sm btn--quiet"
                aria-label="刷新方案库"
                aria-busy={refreshing}
                title="刷新方案库"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <Icon name="refresh" size={15} className={refreshing ? 'library-spin' : ''} />
              </button>

              <button
                type="button"
                className={`btn btn--icon btn--sm btn--quiet ${selectionMode ? 'is-active' : ''}`}
                aria-label={selectionMode ? '退出批量管理' : '批量管理'}
                aria-pressed={selectionMode}
                title={selectionMode ? '退出批量管理' : '批量管理（多选收藏或删除）'}
                onClick={toggleSelectionMode}
              >
                <Icon name={selectionMode ? 'checkbox' : 'checkbox-blank'} size={15} />
              </button>
            </div>
          </div>
        </div>
      )}

      {emptyLibrary ? (
        <EmptyState
          icon={<Icon name="library" size={20} />}
          title="方案库还是空的"
          description="从 MIDI、音频或简谱文本导入，也可以直接新建一份曲谱；所有方案都保存在本机，可随时导出备份。"
          actions={
            <>
              <button type="button" className="btn btn--primary btn--sm" onClick={newScore}>
                <Icon name="plus" size={14} /> 新建曲谱
              </button>
              <button type="button" className="btn btn--sm" onClick={() => app.navigate('import')}>
                <Icon name="import" size={14} /> 智能导入
              </button>
            </>
          }
        />
      ) : visibleEntries.length === 0 ? (
        <EmptyState
          icon={<Icon name="search" size={20} />}
          title="没有找到方案"
          description={
            isFiltering
              ? '没有符合当前搜索或筛选条件的方案，清除条件后可以查看全部方案。'
              : '当前条件下没有方案。'
          }
          actions={
            <button type="button" className="btn btn--sm" onClick={resetFilters}>
              <Icon name="close" size={14} /> 清除搜索与筛选
            </button>
          }
        />
      ) : view === 'grid' ? (
        <div className="library-cards">{visibleEntries.map(renderCard)}</div>
      ) : (
        <div className="card card--flush library-list">
          <div className="library-list__head" aria-hidden="true">
            <span />
            <span>方案</span>
            <span>参数</span>
            <span>更新时间</span>
            <span className="library-list__head-end">操作</span>
          </div>
          {visibleEntries.map(renderRow)}
        </div>
      )}

      {selectionMode ? (
        <div className="card library-selection" role="group" aria-label="批量操作">
          <span className="library-selection__count">
            <span className="badge badge--accent">已选 {selectedCount}</span>
            <span className="library-selection__label">个方案</span>
          </span>
          <div className="library-selection__actions">
            <button type="button" className="btn btn--sm" onClick={selectAllVisible} disabled={visibleEntries.length === 0}>
              全选结果
            </button>
            <button type="button" className="btn btn--sm" onClick={clearSelection} disabled={selectedCount === 0}>
              清空
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={selectedCount === 0}
              onClick={() => void batchFavorite(true)}
            >
              <Icon name="star" size={13} /> 收藏
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={selectedCount === 0}
              onClick={() => void batchFavorite(false)}
            >
              取消收藏
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={selectedCount === 0}
              onClick={() => void batchRemove()}
            >
              <Icon name="trash" size={13} /> 删除
            </button>
            <button type="button" className="btn btn--sm" onClick={toggleSelectionMode}>
              完成
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
