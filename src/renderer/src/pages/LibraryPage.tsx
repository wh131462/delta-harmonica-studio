import { useMemo, useState } from 'react';
import { buildScoreFromText } from '@core/score/dsl';
import { importMidiFile } from '@core/import/midi';
import type { Score } from '@core/model/score';
import { Icon } from '@renderer/components/Icon';
import { PageHeader, EmptyState } from '@renderer/components/PageHeader';
import { useAppStore, type PageId } from '@renderer/state/app-store';
import { formatDateTime, sourceKindLabel } from '@renderer/utils/format';
import type { LibraryEntry } from '@shared/types';

type FilterKind = 'all' | 'favorite' | 'game' | 'imported' | 'manual';
type SortKind = 'updated' | 'title' | 'duration';

const FILTER_LABEL: Record<FilterKind, string> = {
  all: '全部',
  favorite: '收藏',
  game: '游戏任务曲',
  imported: '导入曲谱',
  manual: '手动录入',
};

function matchesFilter(entry: LibraryEntry, filter: FilterKind): boolean {
  if (filter === 'all') return true;
  if (filter === 'favorite') return entry.favorite;
  if (filter === 'game') return entry.title.includes('风声未止') || entry.title.includes('任务');
  if (filter === 'imported') return entry.sourceKind === 'midi' || entry.sourceKind === 'audio';
  return entry.sourceKind === 'manual' || entry.sourceKind === 'text' || entry.sourceKind === 'builtin';
}

export function LibraryPage(): JSX.Element {
  const app = useAppStore();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKind>('all');
  const [sort, setSort] = useState<SortKind>('updated');
  const [busy, setBusy] = useState(false);

  const entries = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const list = app.entries.filter((entry) => {
      if (!matchesFilter(entry, filter)) return false;
      if (!keyword) return true;
      return (
        entry.title.toLowerCase().includes(keyword) ||
        (entry.artist ?? '').toLowerCase().includes(keyword)
      );
    });
    return [...list].sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, 'zh-CN');
      if (sort === 'duration') return b.durationBeats - a.durationBeats;
      return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
    });
  }, [app.entries, search, filter, sort]);

  const favoriteCount = app.entries.filter((entry) => entry.favorite).length;

  const open = async (id: string, page: PageId) => {
    await app.openScore(id, page);
  };

  const exportScore = async (id: string, format: 'dsl' | 'keys' | 'json') => {
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

  const importFiles = async () => {
    setBusy(true);
    try {
      const files = await window.api.library.importScoreFile();
      if (files.length === 0) return;
      let imported = 0;
      for (const file of files) {
        try {
          let score: Score | null = null;
          const lower = file.name.toLowerCase();
          if (lower.endsWith('.mid') || lower.endsWith('.midi')) {
            const result = importMidiFile(file.data, { fileName: file.name, title: file.name.replace(/\.(mid|midi)$/i, '') });
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
      setBusy(false);
    }
  };

  const newScore = () => {
    app.setCurrentScore(null, false);
    app.navigate('editor');
  };

  return (
    <div className="page">
      <PageHeader
        title="音乐方案库"
        subtitle={`共 ${app.entries.length} 个方案 · ${favoriteCount} 个收藏 · 曲谱文件保存在本机用户数据目录`}
        actions={
          <>
            <button type="button" className="button ghost" onClick={() => void importFiles()} disabled={busy}>
              <Icon name="import" size={15} /> {busy ? '导入中…' : '导入文件'}
            </button>
            <button type="button" className="button primary" onClick={newScore}>
              <Icon name="plus" size={15} /> 新建曲谱
            </button>
          </>
        }
      />

      <div className="library-toolbar">
        <div className="search-box">
          <Icon name="target" size={15} />
          <input
            className="input"
            placeholder="搜索标题或艺术家…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="filter-group">
          {(Object.keys(FILTER_LABEL) as FilterKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`filter-chip ${filter === kind ? 'active' : ''}`}
              onClick={() => setFilter(kind)}
            >
              {FILTER_LABEL[kind]}
            </button>
          ))}
        </div>
        <select className="select" value={sort} onChange={(event) => setSort(event.target.value as SortKind)}>
          <option value="updated">最近更新</option>
          <option value="title">按标题</option>
          <option value="duration">按时长</option>
        </select>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={<Icon name="library" size={34} />}
          title={app.entries.length === 0 ? '方案库还是空的' : '没有匹配的方案'}
          description={
            app.entries.length === 0
              ? '导入 MIDI / 音频 / 简谱文本，或直接新建一个曲谱开始。'
              : '试试其他关键词或筛选条件。'
          }
          actions={
            <button type="button" className="button primary" onClick={() => app.navigate('import')}>
              <Icon name="import" size={15} /> 去导入曲谱
            </button>
          }
        />
      ) : (
        <div className="library-grid">
          {entries.map((entry) => (
            <article key={entry.id} className="score-card">
              <div className="score-card-head">
                <div className="score-card-title">
                  <h3>{entry.title}</h3>
                  <p>{entry.artist || '未填写艺术家'}</p>
                </div>
                <button
                  type="button"
                  className={`star-button ${entry.favorite ? 'active' : ''}`}
                  title={entry.favorite ? '取消收藏' : '收藏'}
                  onClick={() => void app.toggleFavorite(entry.id)}
                >
                  <Icon name="star" size={17} />
                </button>
              </div>
              <div className="score-card-meta">
                <span>{sourceKindLabel(entry.sourceKind)}</span>
                <span>{entry.tempo} BPM</span>
                <span>
                  1={['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][entry.keyRoot]}
                </span>
                <span>{entry.noteCount} 音</span>
                <span>
                  {entry.meter.num}/{entry.meter.den}
                </span>
              </div>
              <p className="score-card-time">更新于 {formatDateTime(entry.updatedAt)}</p>
              <div className="score-card-actions">
                <button type="button" className="button primary small" onClick={() => void open(entry.id, 'play')}>
                  <Icon name="play" size={14} /> 演奏
                </button>
                <button type="button" className="button ghost small" onClick={() => void open(entry.id, 'editor')}>
                  <Icon name="edit" size={14} /> 编辑
                </button>
                <details className="menu">
                  <summary className="button ghost small">
                    <Icon name="download" size={14} /> 导出
                  </summary>
                  <div className="menu-list">
                    <button type="button" onClick={() => void exportScore(entry.id, 'keys')}>
                      键位谱（照着按）
                    </button>
                    <button type="button" onClick={() => void exportScore(entry.id, 'dsl')}>
                      简谱文本
                    </button>
                    <button type="button" onClick={() => void exportScore(entry.id, 'json')}>
                      方案 JSON
                    </button>
                  </div>
                </details>
                <button type="button" className="icon-button danger" title="删除" onClick={() => void remove(entry)}>
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
