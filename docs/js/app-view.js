import { renderFileTree } from './fileTree.js';
import { ICON } from './icons.js';
import { RAW_BASE } from './github.js';

const state = { currentFile: null, activeDir: null };
const BASE = new URL(document.baseURI).pathname;
const $ = (id) => document.getElementById(id);

const fileTreeEl    = $('file-tree');
const pathDisplay   = $('file-path-display');
const contentView   = $('content-view');
const skeletonLoader = $('skeleton-loader');
const dirView       = $('dir-view');
const dirFilesGrid  = $('dir-files-grid');
const cacheInfoEl   = $('tree-cache-info');
const fileCacheEl   = $('file-cache-info');

// ── Fetch ──────────────────────────────────────────────────

let treeCache = { fetchedAt: null, expiresAt: null };
let fileCache = { fetchedAt: null, expiresAt: null };

function readCacheHeaders(res) {
  const maxAge = Number((/max-age=(\d+)/.exec(res.headers.get('cache-control') || '') || [])[1]);
  const expiresRaw = Date.parse(res.headers.get('expires') || '');
  const sane = Number.isFinite(expiresRaw) && Math.abs(expiresRaw - Date.now()) < 86400000;
  const expiresAt = sane ? new Date(expiresRaw) : null;

  const fetchedAt = (expiresAt && Number.isFinite(maxAge))
    ? new Date(expiresAt.getTime() - maxAge * 1000)
    : new Date();

  return { fetchedAt, expiresAt };
}

async function fetchTree() {
  const res = await fetch(`${RAW_BASE}/_tree.json`);
  if (!res.ok) throw new Error('_tree.json not found — 에디터에서 파일을 한 번 저장해주세요');
  treeCache = readCacheHeaders(res);
  return await res.json();
}

async function fetchFile(filePath) {
  const res = await fetch(`${RAW_BASE}/${filePath}`);
  if (!res.ok) throw new Error('file load failed');
  fileCache = readCacheHeaders(res);
  return await res.text();
}

// ── File tree ──────────────────────────────────────────────

let fileTreeData = [];

function showTreeSkeleton() {
  const widths = ['65%', '80%', '50%', '72%', '58%', '85%', '45%'];
  fileTreeEl.innerHTML = widths.map(w =>
    `<div class="sk-tree-item">
      <div class="sk-tree-icon"></div>
      <div class="sk-tree-text" style="width:${w}"></div>
    </div>`
  ).join('');
}

async function refreshTree() {
  showTreeSkeleton();
  try {
    fileTreeData = await fetchTree();
    renderFileTree(fileTreeData, fileTreeEl, openFile, state.currentFile, null, null, null, null, state.activeDir, true);
    if (state.activeDir !== null && dirView.style.display !== 'none') {
      const items = state.activeDir === '' ? fileTreeData : findDirItems(fileTreeData, state.activeDir);
      renderDirGrid(items || []);
    }
    startCacheInfo();
  } catch (e) {
    fileTreeEl.innerHTML = '';
    cacheInfoEl.hidden = true;
    console.error('Tree load failed:', e);
  }
}

// ── 캐시 정보 표시 ─────────────────────────────────────────

function fmtDateTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 1초마다 다시 그려서 카운트다운된다.
function untilText(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}분 ${s}초 후` : `${s}초 후`;
}

function cacheStatus({ expiresAt }) {
  const remaining = expiresAt ? expiresAt - Date.now() : 0;
  const expired = !expiresAt || remaining <= 0;
  const next = !expiresAt ? '알 수 없음'
             : expired   ? '새로고침하면 갱신'
             : untilText(remaining);
  return { next, expired };
}

function cacheTitle(expiresAt) {
  return expiresAt
    ? `raw.githubusercontent.com CDN 캐시 만료: ${fmtDateTime(expiresAt)}`
    : 'CDN 캐시 만료 시각을 알 수 없습니다';
}

// 사이드바 하단 — 파일 트리(_tree.json)
function renderTreeCacheInfo() {
  const { fetchedAt, expiresAt } = treeCache;
  if (!fetchedAt) { cacheInfoEl.hidden = true; return true; }

  const { next, expired } = cacheStatus(treeCache);
  cacheInfoEl.textContent = `${fmtDateTime(fetchedAt)} (${next})`;
  cacheInfoEl.title = cacheTitle(expiresAt);
  cacheInfoEl.classList.toggle('stale', expired);
  cacheInfoEl.hidden = false;
  return expired;
}

// 툴바 — 현재 열어 둔 .md
function renderFileCacheInfo() {
  const { fetchedAt, expiresAt } = fileCache;
  if (!fetchedAt || !state.currentFile) { fileCacheEl.hidden = true; return true; }

  const { next, expired } = cacheStatus(fileCache);
  fileCacheEl.textContent = `${fmtDateTime(fetchedAt)} (${next})`;
  fileCacheEl.title = cacheTitle(expiresAt);
  fileCacheEl.classList.toggle('stale', expired);
  fileCacheEl.hidden = false;
  return expired;
}

let cacheTimer = null;

function tickCacheInfo() {
  // 둘 다 만료되면 더 갱신할 게 없으므로 타이머를 멈춘다.
  const treeDone = renderTreeCacheInfo();
  const fileDone = renderFileCacheInfo();
  if (treeDone && fileDone) { clearInterval(cacheTimer); cacheTimer = null; }
}

function startCacheInfo() {
  clearInterval(cacheTimer);
  tickCacheInfo();
  cacheTimer = setInterval(tickCacheInfo, 1000);
}

// ── Markdown rendering ─────────────────────────────────────

function headingAnchor(text) {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^\w가-힣ㄱ-㆏-]/g, '');
}

let mermaidReady = false;

function initMermaid() {
  if (mermaidReady || !window.mermaid) return;
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'base',
    themeVariables: {
      primaryColor: '#f0f0f0',
      primaryTextColor: '#333',
      primaryBorderColor: '#999',
      lineColor: '#777',
      secondaryColor: '#e8e8e8',
      tertiaryColor: '#f5f5f5',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '14px',
    },
  });
  mermaidReady = true;
}

async function renderContent(markdown) {
  const withRawImages = markdown.replace(/\(\/images\//g, `(${RAW_BASE}/images/`);

  // 빈 단락 복원 (에디터에서 <!-- empty-paragraph -->로 저장됨)
  const withEmptyParas = withRawImages.replace(/<!-- empty-paragraph -->/g, '<p></p>');

  // 목차 플레이스홀더 치환 (<!-- toc --> → 나중에 렌더링할 div)
  const withToc = withEmptyParas.replace(/<!-- toc -->/g, '<div data-type="toc-placeholder"></div>');

  // Extract mermaid blocks before marked parses them
  const mermaidBlocks = [];
  const withPlaceholders = withToc.replace(/```mermaid\n([\s\S]*?)```/g, (_, code) => {
    const idx = mermaidBlocks.length;
    mermaidBlocks.push(code.trim());
    return `<div class="mermaid-placeholder" data-idx="${idx}"></div>`;
  });

  const html = window.marked ? window.marked.parse(withPlaceholders) : withPlaceholders;
  contentView.innerHTML = `<div class="md-body">${html}</div>`;

  // 헤딩에 앵커 ID 추가
  contentView.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
    if (!h.id) h.id = headingAnchor(h.textContent);
  });

  // 목차 블록 렌더링
  contentView.querySelectorAll('[data-type="toc-placeholder"]').forEach(placeholder => {
    const headings = [...contentView.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    if (!headings.length) { placeholder.remove(); return; }

    const tocBlock = document.createElement('div');
    tocBlock.className = 'toc-block';
    const tocHeader = document.createElement('div');
    tocHeader.className = 'toc-header';
    tocHeader.textContent = '목차';
    tocBlock.appendChild(tocHeader);

    const list = document.createElement('div');
    list.className = 'toc-list';
    headings.forEach(h => {
      const level = parseInt(h.tagName[1]);
      const item = document.createElement('div');
      item.className = `toc-item toc-h${level}`;
      item.style.paddingLeft = `${(level - 1) * 16}px`;
      item.textContent = h.textContent;
      item.addEventListener('click', () => {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      list.appendChild(item);
    });
    tocBlock.appendChild(list);
    placeholder.replaceWith(tocBlock);
  });

  // Syntax highlighting
  if (window.hljs) {
    contentView.querySelectorAll('pre code').forEach(el => window.hljs.highlightElement(el));
  }

  // Mermaid rendering
  if (mermaidBlocks.length && window.mermaid) {
    initMermaid();
    const placeholders = contentView.querySelectorAll('.mermaid-placeholder');
    for (const el of placeholders) {
      const code = mermaidBlocks[Number(el.dataset.idx)];
      try {
        const uid = 'mm' + Date.now() + Math.random().toString(36).slice(2);
        const { svg } = await window.mermaid.render(uid, code);
        el.outerHTML = `<div class="mermaid-view">${svg}</div>`;
      } catch (e) {
        el.outerHTML = `<div class="mermaid-error">⚠ ${e.message}</div>`;
      }
    }
  }
}

// ── Open file ──────────────────────────────────────────────

async function openFile(filePath) {
  contentView.style.display = 'none';
  dirView.style.display = 'none';
  skeletonLoader.style.display = '';

  let content;
  try {
    content = await fetchFile(filePath);
  } catch (e) {
    skeletonLoader.style.display = 'none';
    return;
  }

  skeletonLoader.style.display = 'none';
  state.currentFile = filePath;
  state.activeDir = null;

  await renderContent(content);
  startCacheInfo();
  contentView.style.display = '';

  pathDisplay.textContent = filePath;
  pathDisplay.classList.remove('placeholder');
  history.pushState(null, '', BASE + filePath);

  if (window.innerWidth <= 640) setSidebarCollapsed(true);
  renderFileTree(fileTreeData, fileTreeEl, openFile, state.currentFile, null, null, null, null, state.activeDir, true);
}

// ── Directory view ─────────────────────────────────────────

function findDirItems(tree, dirPath) {
  for (const item of tree) {
    if (item.type === 'dir') {
      if (item.path === dirPath) return item.children;
      const found = findDirItems(item.children, dirPath);
      if (found) return found;
    }
  }
  return null;
}

function renderDirGrid(items) {
  dirFilesGrid.innerHTML = '';
  if (!items || items.length === 0) {
    dirFilesGrid.innerHTML = '<div class="dir-empty">이 폴더는 비어 있습니다</div>';
    return;
  }

  const header = document.createElement('div');
  header.className = 'dir-list-header';
  header.innerHTML = '<span>이름</span>';
  dirFilesGrid.appendChild(header);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'dir-card';
    const typeLabel = item.type === 'dir' ? '폴더' : 'Markdown';
    row.innerHTML = `
      <span class="dir-card-icon">${item.type === 'dir' ? ICON.folder : ICON.file}</span>
      <span class="dir-card-name">${item.name}</span>
      <span class="dir-card-type">${typeLabel}</span>
    `;
    row.addEventListener('click', () => {
      if (item.type === 'dir') openDir(item.path);
      else openFile(item.path);
    });
    dirFilesGrid.appendChild(row);
  }
}

function showDirView(dirPath, items) {
  contentView.style.display = 'none';
  dirView.style.display = '';
  state.currentFile = null;
  fileCacheEl.hidden = true;
  pathDisplay.textContent = dirPath ? dirPath + '/' : '';
  pathDisplay.classList.toggle('placeholder', !dirPath);
  renderDirGrid(items);
}

function openDir(dirPath) {
  state.currentFile = null;
  state.activeDir = dirPath;
  const items = findDirItems(fileTreeData, dirPath);
  showDirView(dirPath, items || []);
  history.pushState(null, '', BASE + dirPath);
  if (window.innerWidth <= 640) setSidebarCollapsed(true);
  renderFileTree(fileTreeData, fileTreeEl, openFile, state.currentFile, null, null, null, null, state.activeDir, true);
}

function openRootDir() {
  state.activeDir = '';
  showDirView('', fileTreeData);
  history.pushState(null, '', BASE);
  if (window.innerWidth <= 640) setSidebarCollapsed(true);
  renderFileTree(fileTreeData, fileTreeEl, openFile, state.currentFile, null, null, null, null, state.activeDir, true);
}

function handleDirTap(e) {
  const header = e.target.closest('.tree-item.dir');
  if (!header || e.target.closest('.tree-chevron')) return;
  const dirPath = header.dataset.dirPath;
  if (dirPath) openDir(dirPath);
}
fileTreeEl.addEventListener('click', handleDirTap);
fileTreeEl.addEventListener('touchend', (e) => {
  const header = e.target.closest('.tree-item.dir');
  if (!header || e.target.closest('.tree-chevron')) return;
  e.preventDefault();
  const dirPath = header.dataset.dirPath;
  if (dirPath) openDir(dirPath);
}, { passive: false });

// ── Theme ──────────────────────────────────────────────────

const THEMES = [
  { id: 'default', label: '기본',     bg: '#fff',    fg: '#37352f' },
  { id: 'ocean',   label: '오션',     bg: '#e0f2fe', fg: '#0080ff' },
  { id: 'forest',  label: '포레스트', bg: '#dcfce7', fg: '#05A600FF' },
  { id: 'rose',    label: '로즈',     bg: '#ffe0da', fg: '#ff2600' },
  { id: 'mono',    label: '모노',     bg: '#f5f5f5', fg: '#000' },
];

const mainEl = $('main');
let currentTheme = localStorage.getItem('sc-theme') || 'default';

function applyTheme(id) {
  currentTheme = id;
  mainEl.dataset.theme = id === 'default' ? '' : id;
  localStorage.setItem('sc-theme', id);
}
applyTheme(currentTheme);

function buildThemePicker(anchorEl) {
  const existing = document.querySelector('.theme-picker');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.className = 'theme-picker';
  document.body.appendChild(panel);

  const title = document.createElement('div');
  title.className = 'theme-picker-title';
  title.textContent = '테마 선택';
  panel.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'theme-picker-grid';
  panel.appendChild(grid);

  THEMES.forEach(({ id, label, bg, fg }) => {
    const opt = document.createElement('div');
    opt.className = 'theme-option' + (id === currentTheme ? ' active' : '');
    const swatch = document.createElement('div');
    swatch.className = 'theme-swatch';
    swatch.style.background = bg;
    swatch.style.color = fg;
    swatch.textContent = 'Aa';
    opt.appendChild(swatch);
    opt.addEventListener('click', () => {
      applyTheme(id);
      grid.querySelectorAll('.theme-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
    });
    grid.appendChild(opt);
  });

  const rect = anchorEl.getBoundingClientRect();
  panel.style.top   = (rect.bottom + 6) + 'px';
  panel.style.right = (window.innerWidth - rect.right) + 'px';

  const close = (e) => {
    if (!panel.contains(e.target) && e.target !== anchorEl) {
      panel.remove();
      document.removeEventListener('mousedown', close);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

$('btn-theme').addEventListener('click', (e) => buildThemePicker(e.currentTarget));

// ── Width toggle ───────────────────────────────────────────

const btnWidth = $('btn-width');
if (localStorage.getItem('sc-wide') === 'true') contentView.classList.add('wide');
btnWidth.addEventListener('click', () => {
  const isWide = contentView.classList.toggle('wide');
  localStorage.setItem('sc-wide', isWide);
});

// ── Sidebar ────────────────────────────────────────────────

const sidebarEl   = $('sidebar');
const resizerEl   = $('sidebar-resizer');
const appEl       = document.getElementById('app');
const btnCollapse = $('btn-collapse-sidebar');
btnCollapse.innerHTML = ICON.sidebarClose;
const btnMenu = $('btn-menu');
btnMenu.innerHTML = ICON.sidebarOpen;

const savedSidebarWidth = localStorage.getItem('sc-sidebar-width');
if (savedSidebarWidth) {
  sidebarEl.style.width    = savedSidebarWidth + 'px';
  sidebarEl.style.minWidth = savedSidebarWidth + 'px';
}

if (localStorage.getItem('sc-sidebar-collapsed') === 'true') {
  appEl.classList.add('sidebar-collapsed');
  btnCollapse.innerHTML = ICON.sidebarOpen;
}
if (window.innerWidth <= 640) setSidebarCollapsed(true);

function setSidebarCollapsed(collapsed) {
  appEl.classList.toggle('sidebar-collapsed', collapsed);
  btnCollapse.innerHTML = collapsed ? ICON.sidebarOpen : ICON.sidebarClose;
  localStorage.setItem('sc-sidebar-collapsed', collapsed);
  const backdrop = $('sidebar-backdrop');
  if (backdrop) backdrop.style.display = (!collapsed && window.innerWidth <= 640) ? 'block' : 'none';
}

btnCollapse.addEventListener('click', () => {
  setSidebarCollapsed(!appEl.classList.contains('sidebar-collapsed'));
});
btnMenu.addEventListener('click', () => setSidebarCollapsed(false));
$('sidebar-backdrop').addEventListener('click', () => setSidebarCollapsed(true));

resizerEl.addEventListener('click', () => {
  if (appEl.classList.contains('sidebar-collapsed')) setSidebarCollapsed(false);
});

let isResizing = false, dragStartX = 0, dragStartWidth = 0;
resizerEl.addEventListener('mousedown', (e) => {
  if (appEl.classList.contains('sidebar-collapsed')) return;
  isResizing = true;
  dragStartX = e.clientX;
  dragStartWidth = sidebarEl.offsetWidth;
  resizerEl.classList.add('dragging');
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
});
document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const newWidth = Math.max(160, Math.min(480, dragStartWidth + e.clientX - dragStartX));
  sidebarEl.style.width    = newWidth + 'px';
  sidebarEl.style.minWidth = newWidth + 'px';
  localStorage.setItem('sc-sidebar-width', newWidth);
});
document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  resizerEl.classList.remove('dragging');
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
});

// ── app-identity → root ────────────────────────────────────

document.querySelector('.app-identity').addEventListener('click', openRootDir);

// ── Circular favicon ───────────────────────────────────────

(function () {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.beginPath();
    ctx.arc(32, 32, 32, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, 0, 0, 64, 64);
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.href = c.toDataURL('image/png');
  };
  img.src = 'https://avatars.githubusercontent.com/u/112409928';
})();

// ── URL navigation ─────────────────────────────────────────

async function openFromPath() {
  const path = decodeURIComponent(window.location.pathname.slice(BASE.length));
  await refreshTree();
  if (!path) { openRootDir(); return; }
  if (path.endsWith('.md')) await openFile(path);
  else openDir(path);
}

window.addEventListener('popstate', () => {
  const path = decodeURIComponent(window.location.pathname.slice(BASE.length));
  if (!path) { openRootDir(); return; }
  if (path.endsWith('.md')) { if (path !== state.currentFile) openFile(path); }
  else openDir(path);
});

// ── Init ───────────────────────────────────────────────────

openFromPath();
