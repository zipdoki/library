import { initEditor, setContent, getMarkdown, focusEditor, setCurrentFilePath } from './editor.js';
import { renderFileTree, showInlineCreate } from './fileTree.js';
import { ICON } from './icons.js';
import { showConfirm, showAlert, showTokenInput } from './modal.js';
import {
  getToken, saveToken, clearToken,
  fetchTree, fetchFile,
  saveFile as ghSave,
  createFile as ghCreate,
  deleteFile as ghDelete,
  renameFile as ghRename,
  getKnownPaths,
  uploadImage as ghUpload,
  RAW_BASE,
} from './github.js';

const state = { currentFile: null, activeDir: null, isDirty: false };

const BASE = new URL(document.baseURI).pathname;
const $ = (id) => document.getElementById(id);
const fileTreeEl      = $('file-tree');
const pathDisplay     = $('file-path-display');
const pathInput       = $('file-path-input');
const statusText      = $('status-text');
const btnSave         = $('btn-save');
const btnGithubFile   = document.createElement('a');
btnGithubFile.className = 'btn-theme';
btnGithubFile.target    = '_blank';
btnGithubFile.rel       = 'noopener noreferrer';
btnGithubFile.title     = 'GitHub에서 열기';
btnGithubFile.innerHTML = ICON.externalLink;
btnGithubFile.style.display = 'none';
$('toolbar-actions').insertBefore(btnGithubFile, btnSave);
const btnNew          = $('btn-new-file');
btnNew.innerHTML      = ICON.plus;
const btnToken        = $('btn-token');
const editorContainer = $('editor-container');
const skeletonLoader  = $('skeleton-loader');
const dirView         = $('dir-view');
const dirFilesGrid    = $('dir-files-grid');

// ── Utilities ──────────────────────────────────────────────

function setStatus(msg, level = '') {
  statusText.textContent = msg;
  statusText.className = `status${level ? ' ' + level : ''}`;
}

function hhmm() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── Token helpers ──────────────────────────────────────────

function updateTokenBtn() {
  const btn = $('btn-token');
  if (!btn) return;
  const has = !!getToken();
  btn.classList.toggle('no-token', !has);
  btn.title = has ? 'GitHub 토큰 변경' : 'GitHub 토큰 필요';
}

async function ensureToken() {
  let token = getToken();
  if (token) return token;
  token = await showTokenInput();
  if (!token) throw new Error('cancelled');
  saveToken(token);
  updateTokenBtn();
  return token;
}

async function withToken(fn) {
  const token = await ensureToken();
  try {
    return await fn(token);
  } catch (e) {
    if (e.message?.includes('Bad credentials') || e.message?.includes('401')) {
      clearToken();
      updateTokenBtn();
      throw new Error('토큰이 유효하지 않습니다. 다시 시도해 주세요.');
    }
    throw e;
  }
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
    fileTreeData = await withToken(token => fetchTree(token));
    renderFileTree(fileTreeData, fileTreeEl, openFile, state.currentFile, moveItem, deleteFile, doCreateFile, renameItem, state.activeDir);
    if (state.activeDir !== null && dirView.style.display !== 'none') {
      const items = state.activeDir === '' ? fileTreeData : findDirItems(fileTreeData, state.activeDir);
      renderDirGrid(items || []);
    }
  } catch (e) {
    fileTreeEl.innerHTML = '';
    if (e.message !== 'cancelled') console.error('Tree load failed:', e);
  }
}

function saveTreeSnapshot() {
  withToken(token => ghSave('_tree.json', JSON.stringify(fileTreeData), token))
    .catch(e => console.warn('tree snapshot failed:', e.message));
}

function collectFilePaths(items) {
  const paths = [];
  for (const item of items) {
    if (item.type === 'file') paths.push(item.path);
    else if (item.children) paths.push(...collectFilePaths(item.children));
  }
  return paths;
}

// ── Open file ──────────────────────────────────────────────

async function openFile(filePath) {
  if (state.isDirty && state.currentFile) {
    const fileToSave = state.currentFile;
    const contentToSave = getMarkdown();
    state.isDirty = false;
    saveFileInBackground(fileToSave, contentToSave);
  }

  editorContainer.style.display = 'none';
  dirView.style.display = 'none';
  skeletonLoader.style.display = '';

  let content;
  try {
    content = await withToken(token => fetchFile(filePath, token));
  } catch (e) {
    skeletonLoader.style.display = 'none';
    setStatus('파일 열기 실패', 'error');
    return;
  }

  skeletonLoader.style.display = 'none';
  state.currentFile = filePath;
  state.activeDir = null;
  state.isDirty = false;
  setCurrentFilePath(filePath);
  btnGithubFile.href = `https://github.com/zipdoki/library/blob/pages/${filePath}`;
  btnGithubFile.style.display = '';

  setContent(content.replace(/\(\/images\//g, `(${RAW_BASE}/images/`));

  editorContainer.style.display = '';
  dirView.style.display = 'none';

  pathDisplay.textContent = filePath;
  pathDisplay.classList.remove('placeholder');
  pathInput.style.display = 'none';
  pathDisplay.style.display = '';
  btnSave.disabled = false;
  setStatus('');

  history.pushState(null, '', BASE + filePath);

  if (window.innerWidth <= 640) setSidebarCollapsed(true);
  renderFileTree(fileTreeData, fileTreeEl, openFile, state.currentFile, moveItem, deleteFile, doCreateFile, renameItem, state.activeDir);
  focusEditor();
}

// ── Save file ──────────────────────────────────────────────

// 저장을 직렬화하여 동시 저장으로 인한 SHA 충돌 방지
let saveQueue = Promise.resolve();

function chainSave(saveFn) {
  const next = saveQueue.then(saveFn, saveFn); // 이전 실패 여부 관계없이 실행
  saveQueue = next.catch(() => {});            // 체인이 끊기지 않도록
  return next;
}

async function saveFile() {
  if (!state.currentFile) return;

  setStatus('저장 중…');
  btnSave.disabled = true;

  const filePath = state.currentFile;
  const content = getMarkdown();

  try {
    await chainSave(() => withToken((token) => ghSave(filePath, content, token)));
    state.isDirty = false;
    setStatus(`저장됨 ${hhmm()}`);
  } catch (e) {
    if (e.message !== 'cancelled') {
      setStatus(`저장 실패: ${e.message}`, 'error');
      console.error(e);
    } else {
      setStatus('');
    }
  }

  btnSave.disabled = false;
}

async function saveFileInBackground(filePath, content) {
  try {
    await chainSave(() => withToken((token) => ghSave(filePath, content, token)));
    if (state.currentFile === filePath) setStatus(`저장됨 ${hhmm()}`);
  } catch (e) {
    if (e.message !== 'cancelled' && state.currentFile === filePath) {
      setStatus(`저장 실패: ${e.message}`, 'error');
      console.error(e);
    }
  }
}

// ── Create file ────────────────────────────────────────────

async function doCreateFile(raw) {
  const filePath = raw.endsWith('.md') ? raw : raw + '.md';
  try {
    await withToken((token) => ghCreate(filePath, token));
    localAddFile(filePath);
    rerender();
    saveTreeSnapshot();
    await openFile(filePath);
  } catch (e) {
    if (e.message !== 'cancelled') setStatus(`파일 생성 실패: ${e.message}`, 'error');
  }
}

// ── Delete file ────────────────────────────────────────────

async function deleteFile(filePath) {
  const ok = await showConfirm(`"${filePath}" 을(를) 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`, '파일 삭제');
  if (!ok) return;

  try {
    await withToken((token) => ghDelete(filePath, token));
    if (state.currentFile === filePath) {
      state.currentFile = null;
      state.isDirty = false;
      setContent('');
      pathDisplay.textContent = '파일을 선택하거나 + 로 생성하세요';
      pathDisplay.classList.add('placeholder');
      btnSave.disabled = true;
      setStatus('');
    }
    localRemoveNode(fileTreeData, filePath);
    rerender();
    saveTreeSnapshot();
  } catch (e) {
    if (e.message !== 'cancelled') await showAlert(`삭제 실패: ${e.message}`, '오류');
  }
}

// ── Rename ─────────────────────────────────────────────────

async function renameItem(oldPath, newName, type) {
  const parts = oldPath.split('/');
  parts[parts.length - 1] = (type === 'file' && !newName.endsWith('.md'))
    ? newName + '.md'
    : newName;
  const newPath = parts.join('/');
  if (newPath === oldPath) return;

  try {
    if (type === 'dir') {
      const allPaths = getKnownPaths(oldPath);
      await withToken(async (token) => {
        for (const fp of allPaths) {
          await ghRename(fp, newPath + fp.slice(oldPath.length), token);
        }
      });
      if (state.currentFile?.startsWith(oldPath + '/')) {
        state.currentFile = newPath + state.currentFile.slice(oldPath.length);
        pathDisplay.textContent = state.currentFile;
      }
      if (state.activeDir === oldPath || state.activeDir?.startsWith(oldPath + '/')) {
        state.activeDir = newPath + (state.activeDir.slice(oldPath.length) || '');
      }
    } else {
      await withToken((token) => ghRename(oldPath, newPath, token));
      if (state.currentFile === oldPath) {
        state.currentFile = newPath;
        pathDisplay.textContent = state.currentFile;
      }
    }
    setStatus('이름 변경됨');
    localRenameNode(oldPath, newPath);
    rerender();
    saveTreeSnapshot();
  } catch (e) {
    if (e.message !== 'cancelled') {
      await showAlert(`이름 변경 실패: ${e.message}`, '오류');
      await refreshTree(); // 실패 시 서버 상태로 복구
    }
  }
}

// ── Move (drag & drop) ─────────────────────────────────────

async function moveItem(oldPath, newPath, type = 'file') {
  setStatus('이동 중…');
  const srcEl = fileTreeEl.querySelector(`[data-path="${oldPath}"], [data-dir-path="${oldPath}"]`);
  if (srcEl) srcEl.classList.add('moving');
  try {
    let movedCurrentFile = null;
    let movedActiveDir   = null;

    if (type === 'dir') {
      const allPaths = getKnownPaths(oldPath);
      await withToken(async (token) => {
        for (const fp of allPaths) {
          const destFp = newPath + fp.slice(oldPath.length);
          await ghRename(fp, destFp, token);
        }
      });
      if (state.currentFile?.startsWith(oldPath + '/')) {
        movedCurrentFile = newPath + state.currentFile.slice(oldPath.length);
      }
      if (state.activeDir === oldPath || state.activeDir?.startsWith(oldPath + '/')) {
        movedActiveDir = newPath + (state.activeDir.slice(oldPath.length) || '');
      }
    } else {
      await withToken((token) => ghRename(oldPath, newPath, token));
      if (state.currentFile === oldPath) {
        movedCurrentFile = newPath;
      }
    }
    setStatus('이동됨');
    localRenameNode(oldPath, newPath);
    rerender();
    saveTreeSnapshot();

    if (movedCurrentFile) {
      await openFile(movedCurrentFile);
    } else if (movedActiveDir !== null) {
      openDir(movedActiveDir);
    }
  } catch (e) {
    if (e.message !== 'cancelled') setStatus(`이동 실패: ${e.message}`, 'error');
  }
}

// ── Local tree mutations (GitHub API 재조회 없이 즉시 반영) ─

function rerender() {
  renderFileTree(fileTreeData, fileTreeEl, openFile, state.currentFile, moveItem, deleteFile, doCreateFile, renameItem, state.activeDir);
}

function insertSorted(arr, node) {
  // 폴더 먼저, 그 다음 파일 / 각 타입 안에서 알파벳 순 (github.js sortTree와 동일 기준)
  const idx = arr.findIndex(n => {
    if (n.type !== node.type) return node.type === 'dir';
    return n.name > node.name;
  });
  if (idx === -1) arr.push(node);
  else arr.splice(idx, 0, node);
}

function ensureDirPath(dirPath) {
  let arr = fileTreeData;
  let cur = '';
  for (const part of dirPath.split('/')) {
    cur = cur ? `${cur}/${part}` : part;
    let node = arr.find(n => n.type === 'dir' && n.path === cur);
    if (!node) {
      node = { name: part, path: cur, type: 'dir', children: [] };
      insertSorted(arr, node);
    }
    arr = node.children;
  }
  return arr;
}

function parentArrFor(path) {
  const parts = path.split('/');
  return parts.length === 1 ? fileTreeData : ensureDirPath(parts.slice(0, -1).join('/'));
}

function pruneEmptyDirs(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (item.type !== 'dir') continue;
    pruneEmptyDirs(item.children);
    if (item.children.length === 0) arr.splice(i, 1);
  }
}

function localAddFile(filePath) {
  const parts = filePath.split('/');
  const node = { name: parts.at(-1), path: filePath, type: 'file' };
  insertSorted(parentArrFor(filePath), node);
}

function localRemoveNode(arr, path) {
  const idx = arr.findIndex(n => n.path === path);
  if (idx !== -1) {
    arr.splice(idx, 1);
    pruneEmptyDirs(fileTreeData);
    return true;
  }
  for (const item of arr) {
    if (item.type === 'dir' && localRemoveNode(item.children, path)) return true;
  }
  return false;
}

function updateAllPaths(node, oldPrefix, newPrefix) {
  node.path = newPrefix + node.path.slice(oldPrefix.length);
  node.name = node.path.split('/').pop();
  if (node.children) node.children.forEach(c => updateAllPaths(c, oldPrefix, newPrefix));
}

function localRenameNode(oldPath, newPath) {
  function extract(arr) {
    const idx = arr.findIndex(n => n.path === oldPath);
    if (idx !== -1) return arr.splice(idx, 1)[0];
    for (const item of arr) {
      if (item.type === 'dir') { const n = extract(item.children); if (n) return n; }
    }
    return null;
  }
  const node = extract(fileTreeData);
  if (!node) return;
  pruneEmptyDirs(fileTreeData); // 원래 있던 폴더가 비었으면 정리
  updateAllPaths(node, oldPath, newPath);
  insertSorted(parentArrFor(newPath), node);
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
  editorContainer.style.display = 'none';
  dirView.style.display = '';
  state.currentFile = null;
  btnSave.disabled = true;
  setStatus('');
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
  renderFileTree(fileTreeData, fileTreeEl, openFile, state.currentFile, moveItem, deleteFile, doCreateFile, renameItem, state.activeDir);
}

function openRootDir() {
  state.activeDir = '';
  showDirView('', fileTreeData);
  history.pushState(null, '', BASE);
  if (window.innerWidth <= 640) setSidebarCollapsed(true);
  renderFileTree(fileTreeData, fileTreeEl, openFile, state.currentFile, moveItem, deleteFile, doCreateFile, renameItem, state.activeDir);
}

function handleDirTap(e) {
  const header = e.target.closest('.tree-item.dir');
  if (!header || e.target.closest('.tree-add-btn') || e.target.closest('.tree-chevron')) return;
  const dirPath = header.dataset.dirPath;
  if (dirPath) openDir(dirPath);
}
fileTreeEl.addEventListener('click', handleDirTap);
fileTreeEl.addEventListener('touchend', (e) => {
  const header = e.target.closest('.tree-item.dir');
  if (!header || e.target.closest('.tree-add-btn') || e.target.closest('.tree-chevron')) return;
  e.preventDefault();
  const dirPath = header.dataset.dirPath;
  if (dirPath) openDir(dirPath);
}, { passive: false });

// ── Rename via toolbar path ────────────────────────────────

async function renameFromPath(newRel) {
  if (!state.currentFile || !newRel || newRel === state.currentFile) {
    pathDisplay.textContent = state.currentFile || '';
    return;
  }
  const newPath = newRel.endsWith('.md') ? newRel : newRel + '.md';
  try {
    await withToken((token) => ghRename(state.currentFile, newPath, token));
    localRenameNode(state.currentFile, newPath);
    state.currentFile = newPath;
    pathDisplay.textContent = state.currentFile;
    setStatus('경로 변경됨');
    saveTreeSnapshot();
    await refreshTree();
  } catch (e) {
    if (e.message !== 'cancelled') setStatus(`경로 변경 실패: ${e.message}`, 'error');
    pathDisplay.textContent = state.currentFile || '';
  }
}

// ── Path edit interactions ─────────────────────────────────

pathDisplay.addEventListener('dblclick', () => {
  if (!state.currentFile) return;
  pathInput.value = state.currentFile;
  pathDisplay.style.display = 'none';
  pathInput.style.display = '';
  pathInput.focus();
  pathInput.select();
});

pathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pathInput.blur();
  if (e.key === 'Escape') {
    pathInput.value = state.currentFile || '';
    pathInput.style.display = 'none';
    pathDisplay.style.display = '';
  }
});

pathInput.addEventListener('blur', async () => {
  const newPath = pathInput.value.trim();
  pathInput.style.display = 'none';
  pathDisplay.style.display = '';
  await renameFromPath(newPath);
});

// ── Keyboard shortcut ──────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (!btnSave.disabled) saveFile();
  }
});

// ── Theme picker ───────────────────────────────────────────

const THEMES = [
  { id: 'default', label: '기본',     bg: '#fff',     fg: '#37352f' },
  { id: 'ocean',   label: '오션',     bg: '#e0f2fe',  fg: '#0080ff' },
  { id: 'forest',  label: '포레스트', bg: '#dcfce7',  fg: '#05A600FF' },
  { id: 'rose',    label: '로즈',     bg: '#ffe0da',  fg: '#ff2600' },
  { id: 'mono',    label: '모노',     bg: '#f5f5f5',  fg: '#000' },
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
  panel.style.top  = (rect.bottom + 6) + 'px';
  panel.style.right = (window.innerWidth - rect.right) + 'px';

  const close = (e) => {
    if (!panel.contains(e.target) && e.target !== anchorEl) {
      panel.remove();
      document.removeEventListener('mousedown', close);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// ── Button handlers ────────────────────────────────────────

document.querySelector('.app-identity').addEventListener('click', openRootDir);
btnSave.addEventListener('click', saveFile);
btnNew.addEventListener('click', () => showInlineCreate(fileTreeEl, doCreateFile));
$('btn-theme').addEventListener('click', (e) => buildThemePicker(e.currentTarget));
btnToken.addEventListener('click', async () => {
  const token = await showTokenInput();
  if (!token) return;
  saveToken(token);
  updateTokenBtn();
  await refreshTree();
  if (!state.currentFile && !state.activeDir) openRootDir();
});

// ── Editor width toggle ─────────────────────────────────────

const btnWidth = $('btn-width');
if (localStorage.getItem('sc-wide') === 'true') editorContainer.classList.add('wide');

btnWidth.addEventListener('click', () => {
  const isWide = editorContainer.classList.toggle('wide');
  localStorage.setItem('sc-wide', isWide);
});

// ── URL navigation ────────────────────────────────────────

async function openFromHash() {
  const hash = decodeURIComponent(window.location.pathname.slice(BASE.length));
  await refreshTree();
  if (!hash) { openRootDir(); return; }
  if (hash.endsWith('.md')) await openFile(hash);
  else openDir(hash);
}

window.addEventListener('popstate', () => {
  const hash = decodeURIComponent(window.location.pathname.slice(BASE.length));
  if (!hash) return;
  if (hash.endsWith('.md')) { if (hash !== state.currentFile) openFile(hash); }
  else openDir(hash);
});

// ── Sidebar resize & collapse ──────────────────────────────

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

// ── Init ───────────────────────────────────────────────────

initEditor(
  () => { if (state.currentFile) state.isDirty = true; },
  undefined,
  async (base64, ext) => {
    const token = await ensureToken();
    const imgPath = await ghUpload(base64, ext, token);
    return `${RAW_BASE}/${imgPath}`;
  },
  () => { if (!btnSave.disabled) saveFile(); },
);

async function handlePageResume() {
  updateTokenBtn();
  if (window.innerWidth <= 640) setSidebarCollapsed(true);
  await refreshTree();
  if (!state.currentFile && !state.activeDir) openRootDir();
  else if (state.currentFile) renderFileTree(fileTreeData, fileTreeEl, openFile, state.currentFile, moveItem, deleteFile, doCreateFile, renameItem, state.activeDir);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') handlePageResume();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) handlePageResume();
});

updateTokenBtn();
openFromHash();
