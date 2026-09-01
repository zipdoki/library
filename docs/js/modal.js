// Generic modal utilities — replace all native alert/confirm/prompt

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function mount(html) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

// showAlert(message) → Promise<void>
export function showAlert(message, title = '알림') {
  return new Promise((resolve) => {
    const overlay = mount(`
      <p class="modal-title">${esc(title)}</p>
      <p class="modal-message">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn-confirm" autofocus>확인</button>
      </div>
    `);

    const close = () => { overlay.remove(); resolve(); };

    overlay.querySelector('.btn-confirm').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); close(); }
    });

    overlay.querySelector('.btn-confirm').focus();
  });
}

// showTokenInput() → Promise<string|null>
export function showTokenInput() {
  return new Promise((resolve) => {
    const overlay = mount(`
      <p class="modal-title">GitHub 토큰 필요</p>
      <p class="modal-message">파일을 수정하려면 GitHub Personal Access Token이 필요합니다.<br>토큰은 이 기기의 localStorage에만 저장됩니다.</p>
      <input class="modal-input" type="password" placeholder="ghp_..." spellcheck="false" autocomplete="off">
      <div class="modal-actions">
        <button class="btn-cancel">취소</button>
        <button class="btn-confirm">확인</button>
      </div>
    `);

    const input = overlay.querySelector('.modal-input');
    const close = (val) => { overlay.remove(); resolve(val); };
    const confirm = () => { const v = input.value.trim(); if (v) close(v); };

    overlay.querySelector('.btn-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('.btn-confirm').addEventListener('click', confirm);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });

    input.focus();
  });
}

// showConfirm(message) → Promise<boolean>
export function showConfirm(message, title = '확인') {
  return new Promise((resolve) => {
    const overlay = mount(`
      <p class="modal-title">${esc(title)}</p>
      <p class="modal-message">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn-cancel">취소</button>
        <button class="btn-confirm">확인</button>
      </div>
    `);

    const close = (result) => { overlay.remove(); resolve(result); };

    overlay.querySelector('.btn-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.btn-confirm').addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
    });

    overlay.querySelector('.btn-confirm').focus();
  });
}
