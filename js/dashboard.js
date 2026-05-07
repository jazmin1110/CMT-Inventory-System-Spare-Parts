// Manager dashboard logic.
// Handles all five tabs (Dashboard, Parts, Movements, Maintenance, Users).
import { supabase } from './supabase.js';
import { requireRole, logout, showBanner, sha256Hex } from './auth.js';

// Guard: only managers can see this page.
const user = requireRole('manager');
if (!user) throw new Error('not a manager');

document.querySelector('#user-name').textContent = user.name;
document.querySelector('#logout-btn').addEventListener('click', logout);

// ---------- Tab switching ----------
const navLinks = document.querySelectorAll('#main-nav a');
const sections = {
  dashboard: document.querySelector('#tab-dashboard'),
  parts: document.querySelector('#tab-parts'),
  movements: document.querySelector('#tab-movements'),
  maintenance: document.querySelector('#tab-maintenance'),
  users: document.querySelector('#tab-users'),
};

/** Show one tab and load that tab's data. */
function activateTab(name) {
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  Object.entries(sections).forEach(([k, el]) =>
    el.classList.toggle('active', k === name)
  );
  if (name === 'dashboard') loadDashboard();
  if (name === 'parts') loadParts();
  if (name === 'movements') loadMovements();
  if (name === 'maintenance') loadMaintenance();
  if (name === 'users') loadUsers();
}
navLinks.forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    activateTab(a.dataset.tab);
  });
});

// ---------- Caches ----------
let machinesCache = [];
let suppliersCache = [];
let usersCache = [];
let allMovementsCache = [];

/** Fetch lookup tables once and reuse them. */
async function loadLookups() {
  const [m, s, u] = await Promise.all([
    supabase.from('machines').select('id, name').order('name'),
    supabase.from('suppliers').select('id, name').order('name'),
    supabase.from('users').select('id, name, role').order('name'),
  ]);
  if (m.error) throw m.error;
  if (s.error) throw s.error;
  if (u.error) throw u.error;
  machinesCache = m.data || [];
  suppliersCache = s.data || [];
  usersCache = u.data || [];
}

// ---------- Helpers ----------

/** Render PHP currency, e.g. ₱12,345.50. */
function formatPHP(n) {
  const num = Number(n) || 0;
  return (
    '₱' +
    num.toLocaleString('en-PH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/** Human-readable timestamp from ISO. */
function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c])
  );
}

/** Compute current stock map (part_id → quantity) from a movement list. */
function buildStockMap(moves) {
  const map = {};
  for (const m of moves || []) {
    const sign = m.move_type === 'IN' || m.move_type === 'ADJUST+' ? 1 : -1;
    map[m.part_id] = (map[m.part_id] || 0) + sign * (m.quantity || 0);
  }
  return map;
}

/** Status pill helper used by stock-related views. */
function statusFor(stock, reorderPoint) {
  if (stock <= reorderPoint) return { label: 'REORDER', cls: 'red' };
  if (stock <= reorderPoint * 1.5) return { label: 'LOW', cls: 'yellow' };
  return { label: 'OK', cls: 'green' };
}

/** Move-type colored pill. */
function moveTypePill(type) {
  let cls = 'navy';
  if (type === 'IN') cls = 'green';
  else if (type === 'OUT') cls = 'red';
  else if (type && type.startsWith('ADJUST')) cls = 'yellow';
  return `<span class="pill ${cls}">${escapeHtml(type)}</span>`;
}

/** Wrap a button click with a spinner + disabled state. */
async function withBusyButton(btn, fn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving...';
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ---------- Dashboard tab ----------
let partsCache = [];

async function loadDashboard() {
  try {
    if (!machinesCache.length || !usersCache.length) await loadLookups();
    const [partsRes, movesRes] = await Promise.all([
      supabase.from('parts').select('*'),
      supabase
        .from('movement_log')
        .select('*')
        .order('created_at', { ascending: false }),
    ]);
    if (partsRes.error) throw partsRes.error;
    if (movesRes.error) throw movesRes.error;

    partsCache = partsRes.data || [];
    allMovementsCache = movesRes.data || [];
    const stockMap = buildStockMap(allMovementsCache);

    let total = partsCache.length;
    let reorder = 0;
    let low = 0;
    let value = 0;
    const reorderRows = [];

    for (const p of partsCache) {
      const stock = stockMap[p.part_id] || 0;
      const st = statusFor(stock, p.reorder_point || 0);
      if (st.label === 'REORDER') {
        reorder++;
        reorderRows.push({ ...p, current_stock: stock });
      } else if (st.label === 'LOW') {
        low++;
      }
      value += (p.unit_cost || 0) * stock;
    }

    document.querySelector('#kpi-total').textContent = total;
    document.querySelector('#kpi-reorder').textContent = reorder;
    document.querySelector('#kpi-low').textContent = low;
    document.querySelector('#kpi-value').textContent = formatPHP(value);

    // Reorder table
    const reorderTbody = document.querySelector('#reorder-tbody');
    if (!reorderRows.length) {
      reorderTbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;">All parts above reorder point.</td></tr>';
    } else {
      reorderTbody.innerHTML = reorderRows
        .map((p) => {
          const machine =
            machinesCache.find((m) => m.id === p.machine_id)?.name || '';
          const suggested = Math.max(
            0,
            (p.target_stock || 0) - p.current_stock
          );
          return `<tr>
            <td>${escapeHtml(p.part_id)}</td>
            <td>${escapeHtml(p.name)}</td>
            <td>${escapeHtml(machine)}</td>
            <td>${p.current_stock}</td>
            <td>${p.reorder_point ?? ''}</td>
            <td><strong>${suggested}</strong></td>
          </tr>`;
        })
        .join('');
    }

    // Recent movements (last 20)
    const recent = allMovementsCache.slice(0, 20);
    const recentTbody = document.querySelector('#recent-mv-tbody');
    if (!recent.length) {
      recentTbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;">No movements yet.</td></tr>';
    } else {
      recentTbody.innerHTML = recent
        .map((m) => {
          const part = partsCache.find((p) => p.part_id === m.part_id);
          const usr = usersCache.find((u) => u.id === m.user_id);
          return `<tr>
            <td>${formatDateTime(m.created_at)}</td>
            <td>${escapeHtml(m.part_id)}</td>
            <td>${escapeHtml(part?.name || '')}</td>
            <td>${moveTypePill(m.move_type)}</td>
            <td>${m.quantity}</td>
            <td>${escapeHtml(usr?.name || '')}</td>
          </tr>`;
        })
        .join('');
    }
  } catch (err) {
    console.error(err);
    showBanner('Failed to load dashboard: ' + (err.message || err), 'error');
  }
}

// ---------- Parts tab ----------
const partsTbody = document.querySelector('#parts-tbody');
const partsSearchEl = document.querySelector('#parts-search');

/** Fill a <select> with [{id, name}] entries. */
function fillSelect(selectEl, items, blank = '— Select —') {
  selectEl.innerHTML =
    `<option value="">${blank}</option>` +
    items
      .map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`)
      .join('');
}

async function loadParts() {
  try {
    if (!machinesCache.length || !suppliersCache.length) await loadLookups();
    fillSelect(document.querySelector('#add-machine'), machinesCache);
    fillSelect(document.querySelector('#add-supplier'), suppliersCache);

    const [partsRes, movesRes] = await Promise.all([
      supabase.from('parts').select('*').order('name'),
      supabase.from('movement_log').select('part_id, move_type, quantity'),
    ]);
    if (partsRes.error) throw partsRes.error;
    if (movesRes.error) throw movesRes.error;
    partsCache = partsRes.data || [];
    const stockMap = buildStockMap(movesRes.data || []);
    renderParts(stockMap, partsSearchEl.value);
  } catch (err) {
    console.error(err);
    showBanner('Failed to load parts: ' + (err.message || err), 'error');
  }
}

/** Render the parts table with optional search filter. */
function renderParts(stockMap, search = '') {
  const q = search.trim().toLowerCase();
  const items = q
    ? partsCache.filter((p) =>
        [p.part_id, p.name, p.category]
          .map((v) => (v || '').toLowerCase())
          .some((v) => v.includes(q))
      )
    : partsCache;

  if (!items.length) {
    partsTbody.innerHTML =
      '<tr><td colspan="10" style="text-align:center;">No parts.</td></tr>';
    return;
  }

  partsTbody.innerHTML = items
    .map((p) => {
      const machine =
        machinesCache.find((m) => m.id === p.machine_id)?.name || '';
      const supplier =
        suppliersCache.find((s) => s.id === p.supplier_id)?.name || '';
      const stock = stockMap[p.part_id] || 0;
      const st = statusFor(stock, p.reorder_point || 0);
      return `<tr data-id="${p.id}">
        <td>${escapeHtml(p.part_id)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(machine)}</td>
        <td>${escapeHtml(p.category || '')}</td>
        <td>${escapeHtml(supplier)}</td>
        <td>${formatPHP(p.unit_cost || 0)}</td>
        <td>${p.reorder_point ?? ''}</td>
        <td>${p.target_stock ?? ''}</td>
        <td>${stock} <span class="pill ${st.cls}" style="margin-left:4px;">${st.label}</span></td>
        <td>
          <button class="btn btn-secondary btn-edit" data-id="${p.id}">Edit</button>
          <button class="btn btn-secondary btn-qr" data-pid="${escapeHtml(p.part_id)}" data-name="${escapeHtml(p.name)}">QR</button>
        </td>
      </tr>`;
    })
    .join('');
}

partsSearchEl.addEventListener('input', () => loadParts());

// Show/hide add part form
document.querySelector('#show-add-part').addEventListener('click', () => {
  document.querySelector('#add-part-card').style.display = 'block';
});
document.querySelector('#cancel-add-part').addEventListener('click', () => {
  document.querySelector('#add-part-card').style.display = 'none';
  document.querySelector('#add-part-form').reset();
});

// Add part submit
document.querySelector('#add-part-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const payload = {
    part_id: fd.get('part_id').trim(),
    name: fd.get('name').trim(),
    machine_id: fd.get('machine_id') || null,
    category: fd.get('category'),
    supplier_id: fd.get('supplier_id') || null,
    unit_cost: Number(fd.get('unit_cost')) || 0,
    reorder_point: Number(fd.get('reorder_point')) || 0,
    target_stock: Number(fd.get('target_stock')) || 0,
  };
  await withBusyButton(document.querySelector('#save-part-btn'), async () => {
    try {
      const { error } = await supabase.from('parts').insert(payload);
      if (error) throw error;
      showBanner('Part added!', 'success');
      form.reset();
      document.querySelector('#add-part-card').style.display = 'none';
      await loadParts();
    } catch (err) {
      console.error(err);
      showBanner('Failed: ' + (err.message || err), 'error');
    }
  });
});

// Inline edit + QR row buttons
partsTbody.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('.btn-edit');
  const qrBtn = e.target.closest('.btn-qr');
  if (qrBtn) {
    openQrModal(qrBtn.dataset.pid, qrBtn.dataset.name);
    return;
  }
  if (editBtn) {
    const id = editBtn.dataset.id;
    const part = partsCache.find((p) => String(p.id) === String(id));
    if (!part) return;
    enterInlineEdit(editBtn.closest('tr'), part);
  }
});

/**
 * Replace a parts row with editable inputs.
 * On Save, update the row in Supabase and reload.
 */
function enterInlineEdit(tr, part) {
  const machineOptions = machinesCache
    .map(
      (m) =>
        `<option value="${m.id}" ${m.id === part.machine_id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
    )
    .join('');
  const supplierOptions = suppliersCache
    .map(
      (s) =>
        `<option value="${s.id}" ${s.id === part.supplier_id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`
    )
    .join('');
  const categories = [
    'Mechanical', 'Electrical', 'Pneumatic', 'Hydraulic',
    'Consumable', 'Cutting', 'Sewing', 'Printing', 'Embroidery',
  ];
  const categoryOptions = categories
    .map(
      (c) =>
        `<option ${c === part.category ? 'selected' : ''}>${c}</option>`
    )
    .join('');

  tr.innerHTML = `
    <td><input data-f="part_id" value="${escapeHtml(part.part_id)}" /></td>
    <td><input data-f="name" value="${escapeHtml(part.name || '')}" /></td>
    <td><select data-f="machine_id"><option value="">—</option>${machineOptions}</select></td>
    <td><select data-f="category">${categoryOptions}</select></td>
    <td><select data-f="supplier_id"><option value="">—</option>${supplierOptions}</select></td>
    <td><input type="number" step="0.01" data-f="unit_cost" value="${part.unit_cost || 0}" /></td>
    <td><input type="number" data-f="reorder_point" value="${part.reorder_point ?? 0}" /></td>
    <td><input type="number" data-f="target_stock" value="${part.target_stock ?? 0}" /></td>
    <td>—</td>
    <td>
      <button class="btn btn-green btn-save">Save</button>
      <button class="btn btn-secondary btn-cancel">Cancel</button>
    </td>`;

  tr.querySelector('.btn-cancel').addEventListener('click', () => loadParts());
  tr.querySelector('.btn-save').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const inputs = tr.querySelectorAll('[data-f]');
    const update = {};
    inputs.forEach((i) => {
      let v = i.value;
      if (i.type === 'number') v = Number(v) || 0;
      if (['machine_id', 'supplier_id'].includes(i.dataset.f) && !v) v = null;
      update[i.dataset.f] = v;
    });
    await withBusyButton(btn, async () => {
      try {
        const { error } = await supabase
          .from('parts')
          .update(update)
          .eq('id', part.id);
        if (error) throw error;
        showBanner('Part updated!', 'success');
        await loadParts();
      } catch (err) {
        console.error(err);
        showBanner('Update failed: ' + (err.message || err), 'error');
      }
    });
  });
}

// ---------- QR modal ----------
const qrModal = document.querySelector('#qr-modal');
const qrCanvas = document.querySelector('#qr-modal-canvas');
const qrText = document.querySelector('#qr-modal-text');

function openQrModal(partId, partName) {
  if (!window.QRCode) {
    showBanner('QR library not loaded yet, please retry.', 'error');
    return;
  }
  qrCanvas.innerHTML = '';
  // qrcode.js renders into an empty container element.
  // eslint-disable-next-line no-new
  new window.QRCode(qrCanvas, {
    text: partId,
    width: 220,
    height: 220,
    correctLevel: window.QRCode.CorrectLevel.M,
  });
  qrText.innerHTML = `<strong>${escapeHtml(partName)}</strong><br/>${escapeHtml(partId)}`;
  qrModal.classList.add('open');
}
document.querySelector('#qr-close').addEventListener('click', () => {
  qrModal.classList.remove('open');
});
document.querySelector('#qr-print').addEventListener('click', () => {
  window.print();
});
qrModal.addEventListener('click', (e) => {
  if (e.target === qrModal) qrModal.classList.remove('open');
});

// ---------- Movements tab ----------
async function loadMovements() {
  try {
    if (!usersCache.length) await loadLookups();
    const { data, error } = await supabase
      .from('movement_log')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    allMovementsCache = data || [];

    if (!partsCache.length) {
      const r = await supabase.from('parts').select('part_id, name');
      if (!r.error) partsCache = r.data || [];
    }
    renderMovements();
  } catch (err) {
    console.error(err);
    showBanner('Failed to load movements: ' + (err.message || err), 'error');
  }
}

function renderMovements() {
  const tbody = document.querySelector('#all-mv-tbody');
  const filterType = document.querySelector('#filter-move-type').value;
  const fromVal = document.querySelector('#filter-from').value;
  const toVal = document.querySelector('#filter-to').value;
  const fromTs = fromVal ? new Date(fromVal + 'T00:00:00').getTime() : null;
  const toTs = toVal ? new Date(toVal + 'T23:59:59').getTime() : null;

  const items = allMovementsCache.filter((m) => {
    if (filterType && m.move_type !== filterType) return false;
    const t = new Date(m.created_at).getTime();
    if (fromTs && t < fromTs) return false;
    if (toTs && t > toTs) return false;
    return true;
  });

  if (!items.length) {
    tbody.innerHTML =
      '<tr><td colspan="11" style="text-align:center;">No movements match the filter.</td></tr>';
    return;
  }
  tbody.innerHTML = items
    .map((m) => {
      const part = partsCache.find((p) => p.part_id === m.part_id);
      const usr = usersCache.find((u) => u.id === m.user_id);
      const reqUsr = usersCache.find((u) => u.id === m.requested_by);
      const mach = machinesCache.find((mc) => mc.id === m.machine_id);
      return `<tr>
        <td>${formatDateTime(m.created_at)}</td>
        <td>${escapeHtml(m.part_id)}</td>
        <td>${escapeHtml(part?.name || '')}</td>
        <td>${moveTypePill(m.move_type)}</td>
        <td>${m.quantity}</td>
        <td>${escapeHtml(m.location || '')}</td>
        <td>${escapeHtml(m.reference_no || '')}</td>
        <td>${escapeHtml(m.remarks || '')}</td>
        <td>${escapeHtml(usr?.name || '')}</td>
        <td>${escapeHtml(reqUsr?.name || '')}</td>
        <td>${escapeHtml(mach?.name || '')}</td>
      </tr>`;
    })
    .join('');
}

document.querySelector('#apply-mv-filter').addEventListener('click', renderMovements);
document.querySelector('#clear-mv-filter').addEventListener('click', () => {
  document.querySelector('#filter-move-type').value = '';
  document.querySelector('#filter-from').value = '';
  document.querySelector('#filter-to').value = '';
  renderMovements();
});

// ---------- Maintenance tab ----------
async function loadMaintenance() {
  try {
    if (!machinesCache.length) await loadLookups();
    fillSelect(document.querySelector('#maint-machine'), machinesCache);

    const { data, error } = await supabase
      .from('maintenance_log')
      .select('*')
      .order('date', { ascending: false });
    if (error) throw error;
    renderMaintenance(data || []);
  } catch (err) {
    console.error(err);
    showBanner('Failed to load maintenance: ' + (err.message || err), 'error');
  }
}

function renderMaintenance(rows) {
  const tbody = document.querySelector('#maint-tbody');
  if (!rows.length) {
    tbody.innerHTML =
      '<tr><td colspan="9" style="text-align:center;">No maintenance entries.</td></tr>';
    return;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in14Days = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);

  tbody.innerHTML = rows
    .map((r) => {
      const machine =
        machinesCache.find((m) => m.id === r.machine_id)?.name || '';
      let cls = '';
      if (r.next_service_date) {
        const ns = new Date(r.next_service_date);
        if (ns < today) cls = 'row-red';
        else if (ns <= in14Days) cls = 'row-yellow';
      }
      return `<tr class="${cls}">
        <td>${escapeHtml(r.date || '')}</td>
        <td>${escapeHtml(machine)}</td>
        <td>${escapeHtml(r.type || '')}</td>
        <td>${escapeHtml(r.work_done || '')}</td>
        <td>${escapeHtml(r.parts_used || '')}</td>
        <td>${escapeHtml(r.technician || '')}</td>
        <td>${r.downtime_hrs ?? ''}</td>
        <td>${formatPHP(r.cost || 0)}</td>
        <td>${escapeHtml(r.next_service_date || '')}</td>
      </tr>`;
    })
    .join('');
}

document.querySelector('#show-add-maint').addEventListener('click', () => {
  document.querySelector('#add-maint-card').style.display = 'block';
});
document.querySelector('#cancel-add-maint').addEventListener('click', () => {
  document.querySelector('#add-maint-card').style.display = 'none';
  document.querySelector('#add-maint-form').reset();
});
document.querySelector('#add-maint-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    date: fd.get('date'),
    machine_id: fd.get('machine_id') || null,
    type: fd.get('type'),
    work_done: fd.get('work_done') || null,
    parts_used: fd.get('parts_used') || null,
    technician: fd.get('technician') || null,
    downtime_hrs: fd.get('downtime_hrs') ? Number(fd.get('downtime_hrs')) : null,
    cost: fd.get('cost') ? Number(fd.get('cost')) : null,
    next_service_date: fd.get('next_service_date') || null,
  };
  await withBusyButton(document.querySelector('#save-maint-btn'), async () => {
    try {
      const { error } = await supabase.from('maintenance_log').insert(payload);
      if (error) throw error;
      showBanner('Maintenance entry saved!', 'success');
      e.target.reset();
      document.querySelector('#add-maint-card').style.display = 'none';
      await loadMaintenance();
    } catch (err) {
      console.error(err);
      showBanner('Save failed: ' + (err.message || err), 'error');
    }
  });
});

// ---------- Users tab ----------
async function loadUsers() {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, role')
      .order('name');
    if (error) throw error;
    usersCache = data || [];
    const tbody = document.querySelector('#users-tbody');
    if (!usersCache.length) {
      tbody.innerHTML =
        '<tr><td colspan="3" style="text-align:center;">No users.</td></tr>';
      return;
    }
    tbody.innerHTML = usersCache
      .map(
        (u) => `<tr>
          <td>${escapeHtml(u.name)}</td>
          <td>${escapeHtml(u.role)}</td>
          <td>••••</td>
        </tr>`
      )
      .join('');
  } catch (err) {
    console.error(err);
    showBanner('Failed to load users: ' + (err.message || err), 'error');
  }
}

document.querySelector('#show-add-user').addEventListener('click', () => {
  document.querySelector('#add-user-card').style.display = 'block';
});
document.querySelector('#cancel-add-user').addEventListener('click', () => {
  document.querySelector('#add-user-card').style.display = 'none';
  document.querySelector('#add-user-form').reset();
});
document.querySelector('#add-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const name = (fd.get('name') || '').trim();
  const pin = (fd.get('pin') || '').trim();
  const role = fd.get('role');
  if (!/^\d{4}$/.test(pin)) {
    showBanner('PIN must be exactly 4 digits.', 'error');
    return;
  }
  await withBusyButton(document.querySelector('#save-user-btn'), async () => {
    try {
      const hash = await sha256Hex(pin);
      const { error } = await supabase
        .from('users')
        .insert({ name, pin: hash, role });
      if (error) throw error;
      showBanner('User added!', 'success');
      e.target.reset();
      document.querySelector('#add-user-card').style.display = 'none';
      await loadUsers();
    } catch (err) {
      console.error(err);
      showBanner('Save failed: ' + (err.message || err), 'error');
    }
  });
});

// ---------- Boot ----------
(async () => {
  try {
    await loadLookups();
  } catch (err) {
    console.error(err);
    showBanner('Failed to load lookups: ' + (err.message || err), 'error');
  }
  // Honor #hash on first load (e.g. /dashboard.html#parts).
  const hash = window.location.hash.replace('#', '');
  const valid = ['dashboard', 'parts', 'movements', 'maintenance', 'users'];
  activateTab(valid.includes(hash) ? hash : 'dashboard');
})();
