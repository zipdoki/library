const REPO = 'zipdoki/library';
const BRANCH = 'pages';
const BASE = 'https://api.github.com';

export const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const shaCache = {};

export function getToken() {
  return localStorage.getItem('sc-github-token') || null;
}

export function saveToken(token) {
  localStorage.setItem('sc-github-token', token);
}

export function clearToken() {
  localStorage.removeItem('sc-github-token');
}

function ghHeaders(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function encPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function b64decode(str) {
  const raw = atob(str.replace(/\n/g, ''));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function buildTree(items) {
  const map = {};
  const root = [];
  const neededDirs = new Set();

  for (const item of items) {
    if (item.type === 'blob') {
      if (item.sha) shaCache[item.path] = item.sha;
      const topLevel = item.path.split('/')[0];
      if (topLevel === 'images') continue;
      const parts = item.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        neededDirs.add(parts.slice(0, i).join('/'));
      }
    }
  }

  for (const dirPath of neededDirs) {
    map[dirPath] = { name: dirPath.split('/').pop(), path: dirPath, type: 'dir', children: [] };
  }

  for (const item of items) {
    if (item.type === 'blob' && item.path.endsWith('.md')) {
      map[item.path] = { name: item.path.split('/').pop(), path: item.path, type: 'file' };
    }
  }

  for (const [p, node] of Object.entries(map)) {
    const parts = p.split('/');
    if (parts.length === 1) {
      root.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      if (map[parentPath]) map[parentPath].children.push(node);
      else root.push(node);
    }
  }

  return sortTree(root);
}

function sortTree(items) {
  return items
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .map(item => item.type === 'dir' ? { ...item, children: sortTree(item.children) } : item);
}

export async function fetchTree(token) {
  const res = await fetch(`${BASE}/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) throw new Error('파일 목록 로드 실패');
  const data = await res.json();
  return buildTree(data.tree || []);
}

export async function fetchFile(path, token) {
  const res = await fetch(`${BASE}/repos/${REPO}/contents/${encPath(path)}?ref=${BRANCH}`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) throw new Error('파일 로드 실패');
  const data = await res.json();
  if (data.sha) shaCache[path] = data.sha;
  return b64decode(data.content);
}

async function getSha(path, token) {
  if (shaCache[path]) return shaCache[path];
  const res = await fetch(`${BASE}/repos/${REPO}/contents/${encPath(path)}?ref=${BRANCH}`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) return null;
  const d = await res.json();
  shaCache[path] = d.sha;
  return d.sha;
}

export async function saveFile(path, content, token, _retry = false) {
  const sha = await getSha(path, token);
  const body = {
    message: sha ? `Update ${path}` : `Create ${path}`,
    content: b64encode(content),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(`${BASE}/repos/${REPO}/contents/${encPath(path)}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    if (!_retry && (data.message || '').includes('does not match')) {
      delete shaCache[path];
      return saveFile(path, content, token, true);
    }
    throw new Error(data.message || '저장 실패');
  }
  if (data.content?.sha) shaCache[path] = data.content.sha;
}

export async function createFile(path, token) {
  const res = await fetch(`${BASE}/repos/${REPO}/contents/${encPath(path)}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Create ${path}`, content: b64encode(''), branch: BRANCH }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '파일 생성 실패');
  if (data.content?.sha) shaCache[path] = data.content.sha;
}

export async function deleteFile(path, token, _retry = false) {
  const sha = await getSha(path, token);
  if (!sha) throw new Error('파일을 찾을 수 없습니다');
  const res = await fetch(`${BASE}/repos/${REPO}/contents/${encPath(path)}`, {
    method: 'DELETE',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Delete ${path}`, sha, branch: BRANCH }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (!_retry && (data.message || '').includes('does not match')) {
      delete shaCache[path];
      return deleteFile(path, token, true);
    }
    throw new Error(data.message || '삭제 실패');
  }
  delete shaCache[path];
}

export async function renameFile(oldPath, newPath, token) {
  const res = await fetch(`${BASE}/repos/${REPO}/contents/${encPath(oldPath)}?ref=${BRANCH}`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) throw new Error('파일 읽기 실패');
  const old = await res.json();

  const createRes = await fetch(`${BASE}/repos/${REPO}/contents/${encPath(newPath)}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Rename ${oldPath} → ${newPath}`,
      content: old.content.replace(/\n/g, ''),
      branch: BRANCH,
    }),
  });
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error(createData.message || '이름 변경 실패');
  if (createData.content?.sha) shaCache[newPath] = createData.content.sha;

  // PUT이 새 커밋을 만든 이후 SHA가 바뀔 수 있으므로 다시 조회
  const shaRes = await fetch(`${BASE}/repos/${REPO}/contents/${encPath(oldPath)}?ref=${BRANCH}`, {
    headers: ghHeaders(token),
  });
  const currentSha = shaRes.ok ? (await shaRes.json()).sha : old.sha;

  const delRes = await fetch(`${BASE}/repos/${REPO}/contents/${encPath(oldPath)}`, {
    method: 'DELETE',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Remove ${oldPath} (renamed)`, sha: currentSha, branch: BRANCH }),
  });
  const delData = await delRes.json().catch(() => ({}));
  if (!delRes.ok) throw new Error(delData.message || '이전 파일 삭제 실패');
  delete shaCache[oldPath];
}

export async function createDir(dirPath, token) {
  const path = `${dirPath}/.gitkeep`;
  const res = await fetch(`${BASE}/repos/${REPO}/contents/${encPath(path)}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Create directory ${dirPath}`, content: b64encode(''), branch: BRANCH }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '폴더 생성 실패');
  if (data.content?.sha) shaCache[path] = data.content.sha;
}

export function getKnownPaths(prefix) {
  return Object.keys(shaCache).filter(p => p === prefix || p.startsWith(prefix + '/'));
}

export async function uploadImage(base64Data, ext, token) {
  const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const filename = `${Date.now()}.${safeExt}`;
  const path = `images/${filename}`;
  const res = await fetch(`${BASE}/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Add image ${path}`, content: base64Data, branch: BRANCH }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '이미지 업로드 실패');
  return path;
}
