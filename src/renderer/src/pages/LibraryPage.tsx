/**
 * 音乐方案库页面
 * ------------------------------------------------------------------
 * 功能：搜索（标题/艺术家）、筛选（全部/收藏/游戏任务曲/导入曲谱/手动录入）、
 *       排序（最近更新/标题/时长/音符数）、网格与列表视图切换（本地持久化）、
 *       卡片 hover 快速「演奏/编辑」、更多菜单（导出键位谱/简谱/方案 JSON、删除）、
 *       最近更新置顶区、统计信息、批量管理（多选收藏/删除）、导入/新建/空态引导。
 *
 * 说明：所有数据与操作都复用 app-store 与 window.api.library；
 *       页面级样式见 ../styles/library.css（类名统一 lb- 前缀）。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
} from 'react';
import { importMidiFile } from '@core/import/midi';
import type { Score } from '@core/model/score';
import { buildScoreFromText } from '@core/score/dsl';
import { Icon } from '@renderer/components/Icon';
import { EmptyState, PageHeader } from '@renderer/components/PageHeader';
import { useAppStore } from '@renderer/state/app-store';
import { beatsToMs, formatDateTime, formatDurationMs, keyLabel, sourceKindLabel } from '@renderer/utils/format';
import type { LibraryEntry } from '@shared/types';
import '../styles/library.css';

type FilterKind = 'all' | 'favorite' | 'game' | 'imported' | 'manual';
type SortKind = 'updated' | 'title' | 'duration' | 'notes';
type ViewMode = 'grid' | 'list';
type SourceTone = 'builtin' | 'midi' | 'audio' | 'text' | 'manual';

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

/** 来源徽标：内置 / MIDI / 音频 / 文本 / 手动 / 键位谱 */
const SOURCE_BADGES: Record<string, { label: string; tone: SourceTone }> = {
  builtin: { label: '内置', tone: 'builtin' },
  midi: { label: 'MIDI', tone: 'midi' },
  audio: { label: '音频', tone: 'audio' },
  text: { label: '文本', tone: 'text' },
  manual: { label: '手动', tone: 'manual' },
  keyscore: { label: '键位谱', tone: 'text' },
};

function getSourceBadge(kind: string): { label: string; tone: SourceTone } {
  return SOURCE_BADGES[kind] ?? { label: sourceKindLabel(kind), tone: 'manual' };
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

/** 网格视图图标（Icon 组件没有现成图标，这里内联一个轻量 SVG） */
function GridViewIcon(): JSX.Element {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.6" />
      <rect x="13" y="4" width="7" height="7" rx="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="1.6" />
      <rect x="13" y="13" width="7" height="7" rx="1.6" />
    </svg>
  );
}

/** 列表视图图标 */
function ListViewIcon(): JSX.Element {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 7h14M5 12h14M5 17h14" />
    </svg>
  );
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

  const searchRef = useRef<HTMLInputElement>(null);
  const menuRootRef = useRef<HTMLDivElement>(null);

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

  /** 顶部统计 */
  const stats = useMemo(
    () => ({
      total: app.entries.length,
      favorites: app.entries.filter((entry) => entry.favorite).length,
      imported: app.entries.filter((entry) => entry.sourceKind === 'midi' || entry.sourceKind === 'audio').length,
      notes: app.entries.reduce((sum, entry) => sum + entry.noteCount, 0),
    }),
    [app.entries],
  );

  /** 各筛选项数量（用于工具栏角标） */
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

  /** 最近更新的前 3 个方案（仅在未搜索/未筛选且方案充足时展示，避免与列表重复过多） */
  const recentEntries = useMemo(() => {
    if (search.trim() || filter !== 'all' || app.entries.length <= 3) return [];
    return [...app.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  }, [app.entries, filter, search]);

  const isFiltering = search.trim().length > 0 || filter !== 'all';
  const selectedCount = selectedIds.size;

  // ---------------- 基础操作 ----------------

  const openEntry = (entry: LibraryEntry, page: 'play' | 'editor') => {
    void app.openScore(entry.id, page);
  };

  /** 点击卡片/行：批量模式下切换选中，否则打开演奏台 */
  const activateEntry = (entry: LibraryEntry) => {
    if (selectionMode) {
      toggleSelected(entry.id);
      return;
    }
    openEntry(entry, 'play');
  };

  const handleEntryKeyDown = (event: ReactKeyboardEvent<HTMLElement>, entry: LibraryEntry) => {
    // 只响应卡片本身获得焦点时的键盘事件，避免干扰内部按钮
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateEntry(entry);
    }
  };

  /** 导出：键位谱 / 简谱文本 / 方案 JSON */
  const exportScore = async (id: string, format: 'keys' | 'dsl' | 'json') => {
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

  // ---------------- 批量管理 ----------------

  const toggleSelected = (id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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

  // ---------------- 更多菜单 ----------------

  const closeAllMenus = () => {
    menuRootRef.current?.querySelectorAll<HTMLDetailsElement>('details.lb-menu[open]').forEach((node) => {
      node.open = false;
    });
  };

  /** 同时只允许展开一个更多菜单 */
  const handleMenuToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) return;
    menuRootRef.current?.querySelectorAll<HTMLDetailsElement>('details.lb-menu[open]').forEach((node) => {
      if (node !== event.currentTarget) node.open = false;
    });
  };

  /** 菜单内按钮点击后关闭菜单，并阻止事件冒泡到卡片 */
  const handleMenuAction = (event: ReactMouseEvent<HTMLButtonElement>, action: () => void) => {
    event.stopPropagation();
    event.currentTarget.closest('details')?.removeAttribute('open');
    action();
  };

  /** 页面空白处点击时收起所有更多菜单 */
  const handlePageClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.lb-menu')) return;
    closeAllMenus();
  };

  /** 卡片星标 */
  const renderStar = (entry: LibraryEntry, size: number): JSX.Element => (
    <button
      type="button"
      className={`lb-star ${entry.favorite ? 'active' : ''}`}
      title={entry.favorite ? '取消收藏' : '收藏'}
      aria-label={entry.favorite ? `取消收藏《${entry.title}》` : `收藏《${entry.title}》`}
      onClick={(event) => {
        event.stopPropagation();
        void app.toggleFavorite(entry.id);
      }}
    >
      <Icon name="star" size={size} />
    </button>
  );

  /** 更多操作菜单（导出三种格式 + 删除），网格与列表共用 */
  const renderMenu = (entry: LibraryEntry): JSX.Element => (
    <details className="lb-menu" onClick={(event) => event.stopPropagation()} onToggle={handleMenuToggle}>
      <summary className="lb-icon-btn" title="更多操作" aria-label={`《${entry.title}》更多操作`}>
        <Icon name="chevron" size={14} />
      </summary>
      <div className="lb-menu-list" role="menu">
        <button type="button" role="menuitem" onClick={(event) => handleMenuAction(event, () => void exportScore(entry.id, 'keys'))}>
          <Icon name="download" size={13} /> 导出键位谱
        </button>
        <button type="button" role="menuitem" onClick={(event) => handleMenuAction(event, () => void exportScore(entry.id, 'dsl'))}>
          <Icon name="edit" size={13} /> 导出简谱文本
        </button>
        <button type="button" role="menuitem" onClick={(event) => handleMenuAction(event, () => void exportScore(entry.id, 'json'))}>
          <Icon name="download" size={13} /> 导出方案 JSON
        </button>
        <span className="lb-menu-sep" role="separator" />
        <button type="button" role="menuitem" className="danger" onClick={(event) => handleMenuAction(event, () => void remove(entry))}>
          <Icon name="trash" size={13} /> 删除方案
        </button>
      </div>
    </details>
  );

  // ---------------- 卡片 / 行渲染 ----------------

  const renderCard = (entry: LibraryEntry): JSX.Element => {
    const badge = getSourceBadge(entry.sourceKind);
    const isCurrent = app.currentScore?.id === entry.id;
    const checked = selectedIds.has(entry.id);
    return (
      <article
        key={entry.id}
        className={`lb-card ${selectionMode ? 'is-selecting' : ''} ${checked ? 'is-checked' : ''} ${isCurrent ? 'is-current' : ''}`}
        role="button"
        tabIndex={0}
        aria-pressed={selectionMode ? checked : undefined}
        aria-label={`${entry.title}，${selectionMode ? (checked ? '已选中，回车取消选择' : '未选中，回车选择') : '回车打开演奏台'}`}
        onClick={() => activateEntry(entry)}
        onKeyDown={(event) => handleEntryKeyDown(event, entry)}
      >
        <div className="lb-card-head">
          <span className={`lb-source-badge tone-${badge.tone}`}>{badge.label}</span>
          <div className="lb-card-head-side">
            {isCurrent ? <span className="lb-current-chip">当前</span> : null}
            {selectionMode ? (
              <span className={`lb-check ${checked ? 'checked' : ''}`} aria-hidden="true">
                {checked ? <Icon name="check" size={12} /> : null}
              </span>
            ) : (
              renderStar(entry, 16)
            )}
          </div>
        </div>

        <div className="lb-card-title-block">
          <h3 className="lb-card-title">{entry.title}</h3>
          <p className="lb-card-artist">{entry.artist || '未填写艺术家'}</p>
        </div>

        <div className="lb-card-meta">
          <span className="lb-meta-item">
            <Icon name="clock" size={12} /> {formatEntryDuration(entry)}
          </span>
          <span className="lb-meta-item">{entry.tempo} BPM</span>
          <span className="lb-meta-item">1={keyLabel(entry.keyRoot)}</span>
          <span className="lb-meta-item">
            {entry.meter.num}/{entry.meter.den}
          </span>
          <span className="lb-meta-item">{entry.noteCount} 音符</span>
        </div>

        <div className="lb-card-foot">
          <span className="lb-updated" title={entry.updatedAt}>
            更新于 {formatDateTime(entry.updatedAt) || '未知时间'}
          </span>
          {selectionMode ? null : (
            <>
              <div className="lb-quick-actions">
                <button
                  type="button"
                  className="lb-quick-btn accent"
                  title="打开演奏台"
                  onClick={(event) => {
                    event.stopPropagation();
                    openEntry(entry, 'play');
                  }}
                >
                  <Icon name="play" size={12} /> 演奏
                </button>
                <button
                  type="button"
                  className="lb-quick-btn"
                  title="在编辑器中打开"
                  onClick={(event) => {
                    event.stopPropagation();
                    openEntry(entry, 'editor');
                  }}
                >
                  <Icon name="edit" size={12} /> 编辑
                </button>
              </div>
              {renderMenu(entry)}
            </>
          )}
        </div>
      </article>
    );
  };

  const renderRow = (entry: LibraryEntry): JSX.Element => {
    const badge = getSourceBadge(entry.sourceKind);
    const isCurrent = app.currentScore?.id === entry.id;
    const checked = selectedIds.has(entry.id);
    return (
      <div
        key={entry.id}
        className={`lb-row ${selectionMode ? 'is-selecting' : ''} ${checked ? 'is-checked' : ''} ${isCurrent ? 'is-current' : ''}`}
        role="button"
        tabIndex={0}
        aria-pressed={selectionMode ? checked : undefined}
        aria-label={`${entry.title}，${selectionMode ? (checked ? '已选中，回车取消选择' : '未选中，回车选择') : '回车打开演奏台'}`}
        onClick={() => activateEntry(entry)}
        onKeyDown={(event) => handleEntryKeyDown(event, entry)}
      >
        <div className="lb-row-side">
          {selectionMode ? (
            <span className={`lb-check ${checked ? 'checked' : ''}`} aria-hidden="true">
              {checked ? <Icon name="check" size={12} /> : null}
            </span>
          ) : (
            renderStar(entry, 15)
          )}
        </div>

        <div className="lb-row-main">
          <div className="lb-row-title-line">
            <span className="lb-row-title">{entry.title}</span>
            <span className={`lb-source-badge tone-${badge.tone}`}>{badge.label}</span>
            {isCurrent ? <span className="lb-current-chip">当前</span> : null}
          </div>
          <p className="lb-row-artist">{entry.artist || '未填写艺术家'}</p>
        </div>

        <div className="lb-row-meta">
          <span>{formatEntryDuration(entry)}</span>
          <span>{entry.tempo} BPM</span>
          <span>1={keyLabel(entry.keyRoot)}</span>
          <span>
            {entry.meter.num}/{entry.meter.den}
          </span>
          <span>{entry.noteCount} 音符</span>
        </div>

        <div className="lb-row-updated">{formatDateTime(entry.updatedAt) || '未知时间'}</div>

        <div className="lb-row-actions">
          {selectionMode ? null : (
            <>
              <button
                type="button"
                className="lb-icon-btn"
                title="演奏"
                aria-label={`演奏《${entry.title}》`}
                onClick={(event) => {
                  event.stopPropagation();
                  openEntry(entry, 'play');
                }}
              >
                <Icon name="play" size={15} />
              </button>
              <button
                type="button"
                className="lb-icon-btn"
                title="编辑"
                aria-label={`编辑《${entry.title}》`}
                onClick={(event) => {
                  event.stopPropagation();
                  openEntry(entry, 'editor');
                }}
              >
                <Icon name="edit" size={15} />
              </button>
              {renderMenu(entry)}
            </>
          )}
        </div>
      </div>
    );
  };

  // ---------------- 页面 ----------------

  const dirtyScore = app.dirty ? app.currentScore : null;

  return (
    <div className="page lb-page" onClick={handlePageClick}>
      <PageHeader
        title="音乐方案库"
        subtitle={`已收录 ${stats.total} 个演奏方案 · ${stats.favorites} 个收藏 · 全部保存在本机用户数据目录`}
        actions={
          <>
            <button type="button" className="button ghost" onClick={() => void importFiles()} disabled={importing}>
              <Icon name="import" size={15} /> {importing ? '导入中…' : '导入文件'}
            </button>
            <button type="button" className="button primary" onClick={newScore}>
              <Icon name="plus" size={15} /> 新建曲谱
            </button>
          </>
        }
      />

      {dirtyScore ? (
        <div className="lb-dirty-banner">
          <Icon name="warning" size={16} />
          <div className="lb-dirty-text">
            <strong>当前有未保存的修改</strong>
            <span>《{dirtyScore.meta.title}》尚未保存，离开或切换曲谱前建议先保存。</span>
          </div>
          <div className="lb-dirty-actions">
            <button type="button" className="button ghost small" onClick={() => app.navigate('editor')}>
              继续编辑
            </button>
            <button type="button" className="button primary small" onClick={() => void app.saveCurrentScore()}>
              <Icon name="check" size={13} /> 保存
            </button>
          </div>
        </div>
      ) : null}

      <section className="lb-stats" aria-label="方案库统计">
        <div className="lb-stat">
          <span className="lb-stat-icon">
            <Icon name="library" size={16} />
          </span>
          <div className="lb-stat-text">
            <strong className="lb-stat-value">{stats.total}</strong>
            <span className="lb-stat-label">方案总数</span>
          </div>
        </div>
        <div className="lb-stat">
          <span className="lb-stat-icon tone-warn">
            <Icon name="star" size={16} />
          </span>
          <div className="lb-stat-text">
            <strong className="lb-stat-value">{stats.favorites}</strong>
            <span className="lb-stat-label">收藏</span>
          </div>
        </div>
        <div className="lb-stat">
          <span className="lb-stat-icon tone-cyan">
            <Icon name="import" size={16} />
          </span>
          <div className="lb-stat-text">
            <strong className="lb-stat-value">{stats.imported}</strong>
            <span className="lb-stat-label">导入曲谱</span>
          </div>
        </div>
        <div className="lb-stat">
          <span className="lb-stat-icon tone-ok">
            <Icon name="music" size={16} />
          </span>
          <div className="lb-stat-text">
            <strong className="lb-stat-value">{stats.notes.toLocaleString('zh-CN')}</strong>
            <span className="lb-stat-label">音符总数</span>
          </div>
        </div>
      </section>

      <section className="lb-toolbar" aria-label="搜索、筛选与视图">
        <label className="lb-search">
          <Icon name="target" size={15} />
          <input
            ref={searchRef}
            className="lb-search-input"
            placeholder="搜索标题或艺术家…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearch('');
                searchRef.current?.blur();
              }
            }}
          />
          {search ? (
            <button
              type="button"
              className="lb-search-clear"
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => {
                setSearch('');
                searchRef.current?.focus();
              }}
            >
              <Icon name="close" size={13} />
            </button>
          ) : (
            <kbd className="lb-search-kbd" title="按 / 快速搜索">
              /
            </kbd>
          )}
        </label>

        <div className="lb-filter" role="group" aria-label="筛选方案">
          {FILTER_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`lb-filter-chip ${filter === option.id ? 'active' : ''}`}
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
              <span className="lb-filter-count">{filterCounts[option.id]}</span>
            </button>
          ))}
        </div>

        <div className="lb-toolbar-right">
          <select
            className="select lb-sort"
            value={sort}
            aria-label="排序方式"
            onChange={(event) => setSort(event.target.value as SortKind)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>

          <div className="lb-view-toggle" role="group" aria-label="视图切换">
            <button
              type="button"
              className={`lb-view-btn ${view === 'grid' ? 'active' : ''}`}
              title="网格视图"
              aria-label="网格视图"
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
            >
              <GridViewIcon />
            </button>
            <button
              type="button"
              className={`lb-view-btn ${view === 'list' ? 'active' : ''}`}
              title="列表视图"
              aria-label="列表视图"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <ListViewIcon />
            </button>
          </div>

          <button
            type="button"
            className={`lb-tool-icon ${refreshing ? 'is-busy' : ''}`}
            title="刷新方案库"
            aria-label="刷新方案库"
            onClick={() => void refresh()}
          >
            <Icon name="refresh" size={15} className={refreshing ? 'lb-spin' : ''} />
          </button>
          <button
            type="button"
            className={`lb-tool-icon ${selectionMode ? 'active' : ''}`}
            title={selectionMode ? '退出批量管理' : '批量管理（多选收藏/删除）'}
            aria-label={selectionMode ? '退出批量管理' : '批量管理'}
            aria-pressed={selectionMode}
            onClick={toggleSelectionMode}
          >
            <Icon name="check" size={15} />
          </button>
        </div>
      </section>

      {recentEntries.length > 0 ? (
        <section className="lb-recent" aria-label="最近更新">
          <div className="lb-recent-head">
            <Icon name="clock" size={14} /> 最近更新
          </div>
          <div className="lb-recent-list">
            {recentEntries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="lb-recent-item"
                title={`打开《${entry.title}》演奏台`}
                onClick={() => openEntry(entry, 'play')}
              >
                <span className="lb-recent-mark">
                  <Icon name="music" size={14} />
                </span>
                <span className="lb-recent-text">
                  <strong>{entry.title}</strong>
                  <span>
                    {formatEntryDuration(entry)} · {formatDateTime(entry.updatedAt) || '未知时间'}
                  </span>
                </span>
                <Icon name="play" size={13} />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {app.entries.length === 0 ? (
        <EmptyState
          icon={<Icon name="library" size={34} />}
          title="方案库还是空的"
          description="导入 MIDI / 音频 / 简谱文本，或直接新建一个曲谱开始。所有方案都保存在本机，可随时导出备份。"
          actions={
            <>
              <button type="button" className="button primary" onClick={() => void importFiles()} disabled={importing}>
                <Icon name="import" size={15} /> {importing ? '导入中…' : '导入曲谱文件'}
              </button>
              <button type="button" className="button ghost" onClick={newScore}>
                <Icon name="plus" size={15} /> 新建曲谱
              </button>
              <button type="button" className="button ghost" onClick={() => app.navigate('import')}>
                <Icon name="sparkle" size={15} /> 去智能导入
              </button>
            </>
          }
        />
      ) : visibleEntries.length === 0 ? (
        <EmptyState
          icon={<Icon name="target" size={34} />}
          title="没有匹配的方案"
          description={
            isFiltering
              ? `没有找到符合当前${search.trim() ? `关键词「${search.trim()}」` : ''}${
                  search.trim() && filter !== 'all' ? '和' : ''
                }筛选条件的方案，试试换个关键词或筛选条件。`
              : '当前筛选条件下没有方案。'
          }
          actions={
            <>
              <button type="button" className="button primary" onClick={resetFilters}>
                <Icon name="close" size={15} /> 清除搜索与筛选
              </button>
              <button type="button" className="button ghost" onClick={() => void importFiles()} disabled={importing}>
                <Icon name="import" size={15} /> 导入文件
              </button>
            </>
          }
        />
      ) : (
        <div className="lb-results" ref={menuRootRef}>
          {view === 'grid' ? (
            <div className="lb-grid">{visibleEntries.map(renderCard)}</div>
          ) : (
            <div className="lb-list">
              <div className="lb-list-head" aria-hidden="true">
                <span />
                <span>方案</span>
                <span>参数</span>
                <span>更新时间</span>
                <span>操作</span>
              </div>
              {visibleEntries.map(renderRow)}
            </div>
          )}
        </div>
      )}

      {selectionMode ? (
        <div className="lb-selection-bar">
          <span className="lb-selection-count">
            <Icon name="check" size={14} /> 已选 {selectedCount} 个方案
          </span>
          <div className="lb-selection-actions">
            <button type="button" className="button ghost small" onClick={selectAllVisible}>
              全选筛选结果
            </button>
            <button type="button" className="button ghost small" onClick={clearSelection} disabled={selectedCount === 0}>
              清空
            </button>
            <button
              type="button"
              className="button ghost small"
              disabled={selectedCount === 0}
              onClick={() => void batchFavorite(true)}
            >
              <Icon name="star" size={13} /> 收藏
            </button>
            <button
              type="button"
              className="button ghost small"
              disabled={selectedCount === 0}
              onClick={() => void batchFavorite(false)}
            >
              取消收藏
            </button>
            <button type="button" className="button danger small" disabled={selectedCount === 0} onClick={() => void batchRemove()}>
              <Icon name="trash" size={13} /> 删除
            </button>
            <button type="button" className="button primary small" onClick={toggleSelectionMode}>
              完成
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
