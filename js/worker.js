// Worker dashboard logic.
// Six tabs: Dashboard, Stock, Log Movement, Parts (read-only),
// Movements, Maintenance. The dashboard hides the inventory-value KPI
// and the parts table omits Unit Cost; otherwise much of the read logic
// mirrors js/dashboard.js so workers and managers see the same data.
import { supabase } from './supabase.js';
import { requireRole, logout, showBanner } from './auth.js';
import { startQRScan } from './qr.js';

// Guard: any signed-in user can reach this page.
const user = requireRole();
if (!user) throw new Error('not signed in');

document.querySelector('#user-name').textContent = user.name;
document.querySelector('#logout-btn').addEventListener('click', logout);

// ---------- Tab switching ----------
const navLinks = document.querySelectorAll('#main-nav a');
const sections = {
  dashboard: document.querySelector('#tab-dashboard'),
  stock: document.querySelector('#tab-stock'),
  movement: document.querySelector('#tab-movement'),
  parts: document.querySelector('#tab-parts'),
  movements: document.querySelector('#tab-movements'),
  maintenance: document.querySelector('#tab-maintenance'),
};

/** Show one tab and trigger that tab's data load. */
function activateTab(name) {
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  Object.entries(sections).forEach(([k, el]) =>
    el.classList.toggle('active', k === name)
  );
  if (name === 'dashboard') loadDashboard();
  if (name === 'stock') loadStock();
  if (name === 'parts') loadParts();
  if (name === 'movements') loadMovements();
  if (name === 'maintenance') loadMaintenance();
  // The Log Movement form has no "load on activate" step — its dropdowns
  // are populated once at boot from loadLookups().
  if (name === 'movement') stopScannerIfRunning();
}
navLinks.forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    activateTab(a.dataset.tab);
  });
});

// ---------- Caches (shared across tabs) ----------
let machinesCache = [];
let usersCache = [];
let partsCache = [];
let allMovementsCache = [];

/** Load lookup tables once and reuse them. */
async function loadLookups() {
  const [m, u] = await Promise.all([
    supabase.from('machines').select('id, name').order('name'),
    supabase.from('users').select('id, name, role').order('name'),
  ]);
  if (m.error) throw m.error;
  if (u.error) throw u.error;
  machinesCache = m.data || [];
  usersCache = u.data || [];

  // Populate the worker dropdowns now that we have the data.
  fillUserSelect(document.querySelector('#requested-by'));
  fillMachineSelect(document.querySelector('#machine'));
}

function fillUserSelect(selectEl) {
  if (!selectEl) return;
  selectEl.innerHTML =
    '<option value="">— Select worker —</option>' +
    usersCache
      .map(
        (u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`
      )
      .join('');
}
function fillMachineSelect(selectEl) {
  if (!selectEl) return;
  selectEl.innerHTML =
    '<option value="">— Select machine —</option>' +
    machinesCache
      .map(
        (m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`
      )
      .join('');
}

// ---------- Helpers ----------

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

/** Compute current stock map (part_id -> quantity) from movement rows. */
function buildStockMap(moves) {
  const map = {};
  for (const m of moves || []) {
    const sign = m.move_type === 'IN' || m.move_type === 'ADJUST+' ? 1 : -1;
    map[m.part_id] = (map[m.part_id] || 0) + sign * (m.quantity || 0);
  }
  return map;
}

function statusFor(stock, reorderPoint) {
  if (stock <= reorderPoint) return { label: 'REORDER', cls: 'red' };
  if (stock <= reorderPoint * 1.5) return { label: 'LOW', cls: 'yellow' };
  return { label: 'OK', cls: 'green' };
}

function moveTypePill(type) {
  let cls = 'navy';
  if (type === 'IN') cls = 'green';
  else if (type === 'OUT') cls = 'red';
  else if (type && type.startsWith('ADJUST')) cls = 'yellow';
  return `<span class="pill ${cls}">${escapeHtml(type)}</span>`;
}

/** Wrap a button click with spinner + disabled state. */
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

// ---------- Dashboard tab (no Inventory Value) ----------
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
    }

    document.querySelector('#kpi-total').textContent = total;
    document.querySelector('#kpi-reorder').textContent = reorder;
    document.querySelector('#kpi-low').textContent = low;

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

// ---------- Stock tab (card list) ----------
const stockListEl = document.querySelector('#stock-list');
const stockSearch = document.querySelector('#stock-search');
let allStock = [];

async function loadStock() {
  stockListEl.innerHTML = '<div class="card">Loading stock...</div>';
  try {
    const [partsRes, movesRes] = await Promise.all([
      supabase.from('parts').select('*').order('name'),
      supabase.from('movement_log').select('part_id, move_type, quantity'),
    ]);
    if (partsRes.error) throw partsRes.error;
    if (movesRes.error) throw movesRes.error;

    const stockMap = buildStockMap(movesRes.data || []);
    allStock = (partsRes.data || []).map((p) => ({
      ...p,
      current_stock: stockMap[p.part_id] || 0,
    }));
    renderStock(stockSearch.value);
  } catch (err) {
    console.error(err);
    stockListEl.innerHTML = '';
    showBanner('Failed to load stock: ' + (err.message || err), 'error');
  }
}

function renderStock(filter = '') {
  const q = filter.trim().toLowerCase();
  const items = q
    ? allStock.filter((p) => (p.name || '').toLowerCase().includes(q))
    : allStock;

  if (!items.length) {
    stockListEl.innerHTML = '<div class="card">No parts found.</div>';
    return;
  }

  stockListEl.innerHTML = items
    .map((p) => {
      const st = statusFor(p.current_stock, p.reorder_point || 0);
      return `
        <div class="stock-item">
          <div class="info">
            <div class="name">${escapeHtml(p.name || '')}</div>
            <div class="meta">${escapeHtml(p.part_id || '')}</div>
          </div>
          <div class="right">
            <div class="qty-num">${p.current_stock}</div>
            <span class="pill ${st.cls}">${st.label}</span>
          </div>
        </div>`;
    })
    .join('');
}

stockSearch.addEventListener('input', (e) => renderStock(e.target.value));

// ---------- Log Movement tab ----------
const moveTypeBtns = document.querySelectorAll('#move-type button');
const moveTypeVal = document.querySelector('#move-type-val');
const rowRequestedBy = document.querySelector('#row-requested-by');
const rowMachine = document.querySelector('#row-machine');
const rowMaintToggle = document.querySelector('#row-maint-toggle');
const rowMaintFields = document.querySelector('#row-maint-fields');
const maintToggle = document.querySelector('#maint-toggle');

/**
 * Show OUT-only fields (Requested by, Machine, maintenance toggle) when the
 * move type is OUT. The maintenance fields sub-card additionally requires the
 * toggle to be checked.
 */
function syncOutOnlyFields() {
  const isOut = moveTypeVal.value === 'OUT';
  rowRequestedBy.style.display = isOut ? '' : 'none';
  rowMachine.style.display = isOut ? '' : 'none';
  rowMaintToggle.style.display = isOut ? '' : 'none';
  rowMaintFields.style.display = isOut && maintToggle.checked ? '' : 'none';
}
moveTypeBtns.forEach((b) => {
  b.addEventListener('click', () => {
    moveTypeBtns.forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    moveTypeVal.value = b.dataset.val;
    syncOutOnlyFields();
  });
});
maintToggle.addEventListener('change', syncOutOnlyFields);
syncOutOnlyFields();

const qtyDisplay = document.querySelector('#qty-display');
const qtyVal = document.querySelector('#qty-val');
function setQty(n) {
  const next = Math.max(1, Math.floor(n));
  qtyDisplay.textContent = String(next);
  qtyVal.value = String(next);
}
document
  .querySelector('#qty-minus')
  .addEventListener('click', () => setQty(Number(qtyVal.value) - 1));
document
  .querySelector('#qty-plus')
  .addEventListener('click', () => setQty(Number(qtyVal.value) + 1));

const partIdInput = document.querySelector('#part-id');
const partNameHint = document.querySelector('#part-name-hint');

/** Look up the part by part_id and show its name beneath the input. */
async function lookupPart(partId) {
  if (!partId) {
    partNameHint.textContent = '';
    return;
  }
  try {
    const { data, error } = await supabase
      .from('parts')
      .select('name')
      .eq('part_id', partId)
      .maybeSingle();
    if (error) throw error;
    partNameHint.textContent = data
      ? `✔ ${data.name}`
      : '⚠ No part with that ID';
    partNameHint.style.color = data ? 'var(--green)' : 'var(--red)';
  } catch (err) {
    partNameHint.textContent = 'Lookup error: ' + (err.message || err);
    partNameHint.style.color = 'var(--red)';
  }
}
partIdInput.addEventListener('change', (e) =>
  lookupPart(e.target.value.trim())
);

// ---------- QR Scanning ----------
const scannerBox = document.querySelector('#scanner');
const scanBtn = document.querySelector('#scan-btn');
const cancelScanBtn = document.querySelector('#cancel-scan');
const videoEl = document.querySelector('#qr-video');
const canvasEl = document.querySelector('#qr-canvas');
let stopScanFn = null;

function stopScannerIfRunning() {
  if (stopScanFn) {
    try { stopScanFn(); } catch {}
    stopScanFn = null;
  }
  scannerBox.classList.remove('active');
  cancelScanBtn.style.display = 'none';
  scanBtn.disabled = false;
}

scanBtn.addEventListener('click', async () => {
  scanBtn.disabled = true;
  scannerBox.classList.add('active');
  cancelScanBtn.style.display = 'inline-flex';
  try {
    stopScanFn = await startQRScan(videoEl, canvasEl, (text) => {
      partIdInput.value = text;
      stopScannerIfRunning();
      lookupPart(text);
      showBanner('Scanned: ' + text, 'success');
    });
  } catch (err) {
    showBanner('Camera error: ' + (err.message || err), 'error');
    stopScannerIfRunning();
  }
});
cancelScanBtn.addEventListener('click', stopScannerIfRunning);

// ---------- Submit movement ----------
const movementForm = document.querySelector('#movement-form');
const submitBtn = document.querySelector('#submit-mv');

movementForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitBtn.disabled) return;

  const isOut = moveTypeVal.value === 'OUT';
  const payload = {
    part_id: partIdInput.value.trim(),
    move_type: moveTypeVal.value,
    quantity: Number(qtyVal.value),
    location: document.querySelector('#location').value.trim(),
    reference_no:
      document.querySelector('#reference_no').value.trim() || null,
    remarks: document.querySelector('#remarks').value.trim() || null,
    user_id: user.id,
    // Only send these for OUT movements; null for IN / ADJUST.
    requested_by: isOut
      ? document.querySelector('#requested-by').value || null
      : null,
    machine_id: isOut
      ? document.querySelector('#machine').value || null
      : null,
    created_at: new Date().toISOString(),
  };

  if (!payload.part_id || !payload.location || payload.quantity < 1) {
    showBanner('Please fill in part, quantity, and location', 'error');
    return;
  }

  const originalText = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spinner"></span> Saving...';

  try {
    const { error } = await supabase.from('movement_log').insert(payload);
    if (error) throw error;

    // Optional: also create a maintenance_log row when the OUT was for
    // maintenance. The two inserts are sequential, not atomic; if this
    // second one fails we surface a clear error so the user knows the
    // movement was saved but the maintenance entry was not.
    if (isOut && maintToggle.checked) {
      const today = new Date().toISOString().slice(0, 10);
      const partRow = partsCache.find((p) => p.part_id === payload.part_id);
      const partsUsedText =
        `${payload.quantity} x ${payload.part_id}` +
        (partRow?.name ? ` (${partRow.name})` : '');

      const maintPayload = {
        date: today,
        machine_id: payload.machine_id,
        type: document.querySelector('#maint-type').value,
        work_done:
          document.querySelector('#maint-work-done').value.trim() || null,
        parts_used: partsUsedText,
        technician:
          document.querySelector('#maint-technician').value.trim() || null,
        downtime_hrs: document.querySelector('#maint-downtime').value
          ? Number(document.querySelector('#maint-downtime').value)
          : null,
        cost: document.querySelector('#maint-cost').value
          ? Number(document.querySelector('#maint-cost').value)
          : null,
        next_service_date:
          document.querySelector('#maint-next').value || null,
      };

      const { error: mErr } = await supabase
        .from('maintenance_log')
        .insert(maintPayload);
      if (mErr) {
        throw new Error(
          'Movement saved, but maintenance entry failed: ' + mErr.message
        );
      }
    }

    showBanner('Movement logged!', 'success');
    movementForm.reset();
    setQty(1);
    moveTypeBtns.forEach((b) =>
      b.classList.toggle('active', b.dataset.val === 'IN')
    );
    moveTypeVal.value = 'IN';
    // Reset the maintenance toggle to its default-on state.
    maintToggle.checked = true;
    syncOutOnlyFields();
    partNameHint.textContent = '';
  } catch (err) {
    console.error(err);
    showBanner('Save failed: ' + (err.message || err), 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
});

// ---------- Parts tab (read-only, no Unit Cost) ----------
const partsTbody = document.querySelector('#parts-tbody');
const partsSearchEl = document.querySelector('#parts-search');
let suppliersCacheLocal = [];

async function loadParts() {
  try {
    if (!machinesCache.length) await loadLookups();
    if (!suppliersCacheLocal.length) {
      const sup = await supabase.from('suppliers').select('id, name').order('name');
      if (sup.error) throw sup.error;
      suppliersCacheLocal = sup.data || [];
    }

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
      '<tr><td colspan="8" style="text-align:center;">No parts.</td></tr>';
    return;
  }

  partsTbody.innerHTML = items
    .map((p) => {
      const machine =
        machinesCache.find((m) => m.id === p.machine_id)?.name || '';
      const supplier =
        suppliersCacheLocal.find((s) => s.id === p.supplier_id)?.name || '';
      const stock = stockMap[p.part_id] || 0;
      const st = statusFor(stock, p.reorder_point || 0);
      return `<tr>
        <td>${escapeHtml(p.part_id)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(machine)}</td>
        <td>${escapeHtml(p.category || '')}</td>
        <td>${escapeHtml(supplier)}</td>
        <td>${p.reorder_point ?? ''}</td>
        <td>${p.target_stock ?? ''}</td>
        <td>${stock} <span class="pill ${st.cls}" style="margin-left:4px;">${st.label}</span></td>
      </tr>`;
    })
    .join('');
}

partsSearchEl.addEventListener('input', () => loadParts());

// ---------- Movements tab (read-only, with new columns) ----------
async function loadMovements() {
  try {
    if (!usersCache.length || !machinesCache.length) await loadLookups();
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

// ---------- Maintenance tab (read-only) ----------
// Maintenance entries are now created via the Log Movement OUT flow.
async function loadMaintenance() {
  try {
    if (!machinesCache.length) await loadLookups();

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

// ---------- Boot ----------
(async () => {
  try {
    await loadLookups();
  } catch (err) {
    console.error(err);
    showBanner('Failed to load lookups: ' + (err.message || err), 'error');
  }
  // Honor #hash on first load (e.g. /worker.html#movement).
  const hash = window.location.hash.replace('#', '');
  const valid = [
    'dashboard', 'stock', 'movement', 'parts', 'movements', 'maintenance',
  ];
  activateTab(valid.includes(hash) ? hash : 'dashboard');
})();
