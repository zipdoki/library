import { Extension } from 'https://esm.sh/@tiptap/core@2';

// ─── PM helpers ──────────────────────────────────────────────────────────────

function rowIndexOf(cell) {
  return [...cell.closest('table').querySelectorAll('tr')].indexOf(cell.closest('tr'));
}

function colIndexOf(cell) {
  return [...cell.closest('tr').querySelectorAll('td, th')].indexOf(cell);
}

function getTablePmPos(view, domTable) {
  const cell = domTable.querySelector('td, th');
  if (!cell) return -1;
  try {
    const pos = view.posAtDOM(cell, 0);
    const $p = view.state.doc.resolve(pos);
    for (let d = $p.depth; d >= 0; d--) {
      if ($p.node(d).type.name === 'table') return $p.before(d);
    }
  } catch { /* ignore */ }
  return -1;
}

function reorderRows(editor, domTable, from, insertAt) {
  const pos = getTablePmPos(editor.view, domTable);
  if (pos < 0) return;
  const { state, view } = editor;
  const table = state.doc.nodeAt(pos);
  if (!table) return;
  const rows = [];
  table.forEach(r => rows.push(r));
  const [moved] = rows.splice(from, 1);
  rows.splice(insertAt > from ? insertAt - 1 : insertAt, 0, moved);
  view.dispatch(state.tr.replaceWith(pos, pos + table.nodeSize,
    table.type.create(table.attrs, rows, table.marks)));
}

function reorderCols(editor, domTable, from, insertAt) {
  const pos = getTablePmPos(editor.view, domTable);
  if (pos < 0) return;
  const { state, view } = editor;
  const table = state.doc.nodeAt(pos);
  if (!table) return;
  const newRows = [];
  table.forEach(row => {
    const cells = [];
    row.forEach(c => cells.push(c));
    const [moved] = cells.splice(from, 1);
    cells.splice(insertAt > from ? insertAt - 1 : insertAt, 0, moved);
    newRows.push(row.type.create(row.attrs, cells, row.marks));
  });
  view.dispatch(state.tr.replaceWith(pos, pos + table.nodeSize,
    table.type.create(table.attrs, newRows, table.marks)));
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

const px = n => n + 'px';

function mkDiv(cls, html = '') {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  return d;
}

function place(el, top, left, w, h) {
  el.style.display = 'flex';
  el.style.top  = px(top);
  el.style.left = px(left);
  if (w != null) el.style.width  = px(w);
  if (h != null) el.style.height = px(h);
}

function runAt(editor, domCell, cmdName) {
  try {
    const p = editor.view.posAtDOM(domCell, 0);
    const chain = editor.chain().focus().setTextSelection(p);
    if (typeof chain[cmdName] === 'function') chain[cmdName]().run();
  } catch { /* ignore */ }
}

// ─── Extension ───────────────────────────────────────────────────────────────

export const TableUI = Extension.create({
  name: 'tableUI',
  onCreate()  { this._cleanup = mount(this.editor); },
  onDestroy() { this._cleanup?.(); },
});

function mount(editor) {
  const root = editor.view.dom;

  // Floating elements
  const rowGrip   = mkDiv('tui-row-grip', '⠿');
  const rowDel    = mkDiv('tui-row-del',  '×');
  const colGrip   = mkDiv('tui-col-grip', '⠿');
  const colDel    = mkDiv('tui-col-del',  '×');
  const addRowBtn = mkDiv('tui-add-row',  '+ 행 추가');
  const addColBtn = mkDiv('tui-add-col',  '+');
  const delTblBtn = mkDiv('tui-del-table','표 삭제');
  const dropLine  = mkDiv('tui-drop-line');

  const interactive = [rowGrip, rowDel, colGrip, colDel, addRowBtn, addColBtn, delTblBtn];
  const allEls = [...interactive, dropLine];
  allEls.forEach(e => { e.style.display = 'none'; document.body.appendChild(e); });

  // State
  let curTable = null, curCell = null, hideTimer = null, drag = null;

  const schedHide  = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hideUI, 150); };
  const cancelHide = () => clearTimeout(hideTimer);

  function hideUI() {
    allEls.forEach(e => e.style.display = 'none');
    curTable = curCell = null;
  }

  function updateUI(cell) {
    if (cell === curCell) return;
    curCell  = cell;
    curTable = cell.closest('table');

    const sy = window.scrollY, sx = window.scrollX;
    const tR = curTable.getBoundingClientRect();
    const rR = cell.closest('tr').getBoundingClientRect();
    const cR = cell.getBoundingClientRect();
    const ri = rowIndexOf(cell);
    const ci = colIndexOf(cell);

    rowGrip.dataset.ri = ri;  rowDel.dataset.ri = ri;
    colGrip.dataset.ci = ci;  colDel.dataset.ci = ci;

    // Left of row: drag grip + delete
    place(rowGrip, rR.top + sy + (rR.height - 16) / 2, tR.left + sx - 44);
    place(rowDel,  rR.top + sy + (rR.height - 16) / 2, tR.left + sx - 22);
    // Above col: drag grip + delete
    place(colGrip, tR.top + sy - 40, cR.left + sx + (cR.width - 16) / 2);
    place(colDel,  tR.top + sy - 20, cR.left + sx + (cR.width - 16) / 2);
    // Bottom: add row (full-width)
    place(addRowBtn, tR.bottom + sy + 4, tR.left + sx, tR.width, 26);
    // Right: add col
    place(addColBtn, tR.top + sy, tR.right + sx + 4, 26, tR.height);
    // Top-right: delete table
    place(delTblBtn, tR.top + sy - 26, tR.right + sx - 68, 66, 22);
  }

  // ── Mouse events ─────────────────────────────────────────────────────────

  function onHover(e) {
    const cell = e.target.closest?.('td, th');
    if (!cell || !root.contains(cell)) return;
    cancelHide();
    updateUI(cell);
  }

  const onScroll = () => hideUI();

  root.addEventListener('mouseover', onHover);
  root.addEventListener('mouseleave', schedHide);
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  interactive.forEach(e => {
    e.addEventListener('mouseenter', cancelHide);
    e.addEventListener('mouseleave', schedHide);
  });

  // ── Button actions ────────────────────────────────────────────────────────

  addRowBtn.addEventListener('mousedown', e => {
    e.preventDefault();
    const cell = curTable?.querySelector('tr:last-child td:last-child, tr:last-child th:last-child');
    if (cell) runAt(editor, cell, 'addRowAfter');
  });

  addColBtn.addEventListener('mousedown', e => {
    e.preventDefault();
    const cell = curTable?.querySelector('tr:first-child td:last-child, tr:first-child th:last-child');
    if (cell) runAt(editor, cell, 'addColumnAfter');
  });

  rowDel.addEventListener('mousedown', e => {
    e.preventDefault();
    const row  = curTable?.querySelectorAll('tr')[parseInt(rowDel.dataset.ri)];
    const cell = row?.querySelector('td, th');
    if (cell) runAt(editor, cell, 'deleteRow');
  });

  colDel.addEventListener('mousedown', e => {
    e.preventDefault();
    const cells = curTable?.querySelector('tr')?.querySelectorAll('td, th');
    const cell  = cells?.[parseInt(colDel.dataset.ci)];
    if (cell) runAt(editor, cell, 'deleteColumn');
  });

  delTblBtn.addEventListener('mousedown', e => {
    e.preventDefault();
    const cell = curTable?.querySelector('td, th');
    if (cell) runAt(editor, cell, 'deleteTable');
    hideUI();
  });

  // ── Row drag ─────────────────────────────────────────────────────────────

  rowGrip.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!curTable) return;
    const from = parseInt(rowGrip.dataset.ri);
    drag = {
      type: 'row', from,
      table: curTable,
      rects: [...curTable.querySelectorAll('tr')].map(r => r.getBoundingClientRect()),
      insertAt: from + 1,
    };
    rowGrip.classList.add('is-dragging');
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  });

  // ── Col drag ─────────────────────────────────────────────────────────────

  colGrip.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!curTable) return;
    const from = parseInt(colGrip.dataset.ci);
    drag = {
      type: 'col', from,
      table: curTable,
      rects: [...(curTable.querySelector('tr')?.querySelectorAll('td, th') ?? [])].map(c => c.getBoundingClientRect()),
      insertAt: from + 1,
    };
    colGrip.classList.add('is-dragging');
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  });

  function onDragMove(e) {
    if (!drag) return;
    const sy = window.scrollY, sx = window.scrollX;
    const tR = drag.table.getBoundingClientRect();

    if (drag.type === 'row') {
      let ins = 0;
      drag.rects.forEach((r, i) => { if (e.clientY > r.top + r.height / 2) ins = i + 1; });
      drag.insertAt = ins;
      const lineY = ins < drag.rects.length ? drag.rects[ins].top : drag.rects.at(-1).bottom;
      dropLine.style.display = 'block';
      Object.assign(dropLine.style, { top: px(lineY + sy - 1), left: px(tR.left + sx), width: px(tR.width), height: '2px' });
    } else {
      let ins = 0;
      drag.rects.forEach((r, i) => { if (e.clientX > r.left + r.width / 2) ins = i + 1; });
      drag.insertAt = ins;
      const lineX = ins < drag.rects.length ? drag.rects[ins].left : drag.rects.at(-1).right;
      dropLine.style.display = 'block';
      Object.assign(dropLine.style, { left: px(lineX + sx - 1), top: px(tR.top + sy), height: px(tR.height), width: '2px' });
    }
  }

  function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    dropLine.style.display = 'none';
    rowGrip.classList.remove('is-dragging');
    colGrip.classList.remove('is-dragging');

    if (drag && drag.from !== drag.insertAt && drag.from + 1 !== drag.insertAt) {
      const { type, from, insertAt, table } = drag;
      if (type === 'row') reorderRows(editor, table, from, insertAt);
      else                reorderCols(editor, table, from, insertAt);
    }
    drag = null;
    curCell = null;
  }

  return () => {
    root.removeEventListener('mouseover', onHover);
    root.removeEventListener('mouseleave', schedHide);
    document.removeEventListener('scroll', onScroll, { capture: true });
    allEls.forEach(e => e.remove());
  };
}
