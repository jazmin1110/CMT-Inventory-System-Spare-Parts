// Worker dashboard logic.
// Five tabs: Dashboard, Log Movement, Parts (read-only),
// Movements, Maintenance. The dashboard hides the inventory-value KPI
// and the parts table omits Unit Cost; otherwise much of the read logic
// mirrors js/dashboard.js so workers and managers see the same data.
import { supabase } from './supabase.js';
import { requireRole, logout, showBanner, changePin } from './auth.js';
import { startQRScan } from './qr.js';

// Guard: any signed-in user can reach this page.
const user = requireRole();
if (!user) throw new Error('not signed in');

document.querySelector('#user-name').textContent = user.name;
document.querySelector('#logout-btn').addEventListener('click', logout);

// ---------- Change PIN (self-service) ----------
const changePinModal = document.querySelector('#change-pin-modal');
const changePinForm = document.querySelector('#change-pin-form');
const cpOld = document.querySelector('#cp-old');
const cpNew = document.querySelector('#cp-new');
const cpNew2 = document.querySelector('#cp-new2');
const cpSaveBtn = document.querySelector('#cp-save');

function openChangePinModal() {
  changePinForm.reset();
  changePinModal.classList.add('open');
  setTimeout(() => cpOld.focus(), 0);
}
function closeChangePinModal() {
  changePinModal.classList.remove('open');
  changePinForm.reset();
}
document.querySelector('#change-pin-btn').addEventListener('click', openChangePinModal);
document.querySelector('#cp-cancel').addEventListener('click', closeChangePinModal);
changePinModal.addEventListener('click', (e) => {
  if (e.target === changePinModal) closeChangePinModal();
});

changePinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const oldPin = cpOld.value.trim();
  const newPin = cpNew.value.trim();
  const newPin2 = cpNew2.value.trim();

  if (newPin !== newPin2) {
    showBanner('New PINs do not match.', 'error');
    return;
  }

  const original = cpSaveBtn.innerHTML;
  cpSaveBtn.disabled = true;
  cpSaveBtn.innerHTML = '<span class="spinner"></span> Saving...';
  try {
    await changePin(oldPin, newPin);
    showBanner('PIN updated. Use the new PIN next time you log in.', 'success');
    closeChangePinModal();
  } catch (err) {
    console.error(err);
    showBanner(err.message || String(err), 'error');
  } finally {
    cpSaveBtn.disabled = false;
    cpSaveBtn.innerHTML = original;
  }
});

// ---------- Tab switching ----------
const navLinks = document.querySelectorAll('#main-nav a');
const sections = {
  dashboard: document.querySelector('#tab-dashboard'),
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
  if (name === 'parts') loadParts();
  if (name === 'movements') loadMovements();
  if (name === 'maintenance') loadMaintenance();
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
    // We still need the users list for resolving the "Logged By" column on
    // the movements page (m.user_id -> name).
    supabase.from('users').select('id, name, role').order('name'),
  ]);
  if (m.error) throw m.error;
  if (u.error) throw u.error;
  machinesCache = m.data || [];
  usersCache = u.data || [];

  // Populate the Machine dropdown in the Log Movement form.
  fillMachineSelect(document.querySelector('#machine'));
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
    // requested_by is now free-form text (any name, not necessarily a user row).
    requested_by: isOut
      ? document.querySelector('#requested-by').value.trim() || null
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
const partsFilterMachineEl = document.querySelector('#parts-filter-machine');
const partsFilterCategoryEl = document.querySelector('#parts-filter-category');
const partsFilterStatusEl = document.querySelector('#parts-filter-status');
const partsClearFilterBtn = document.querySelector('#parts-clear-filter');
let suppliersCacheLocal = [];
let partsStockMap = {};

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
    partsStockMap = buildStockMap(movesRes.data || []);
    populatePartsFilters();
    renderParts();
  } catch (err) {
    console.error(err);
    showBanner('Failed to load parts: ' + (err.message || err), 'error');
  }
}

/** Fill the Machine + Category dropdowns from cached data, preserving the
 *  current selection so a re-render doesn't reset the user's filter. */
function populatePartsFilters() {
  const prevMachine = partsFilterMachineEl.value;
  const prevCategory = partsFilterCategoryEl.value;

  partsFilterMachineEl.innerHTML =
    '<option value="">All machines</option>' +
    machinesCache
      .map(
        (m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`
      )
      .join('');
  if (prevMachine) partsFilterMachineEl.value = prevMachine;

  const cats = Array.from(
    new Set(partsCache.map((p) => p.category).filter(Boolean))
  ).sort();
  partsFilterCategoryEl.innerHTML =
    '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  if (prevCategory) partsFilterCategoryEl.value = prevCategory;
}

function renderParts() {
  const q = partsSearchEl.value.trim().toLowerCase();
  const machineId = partsFilterMachineEl.value;
  const category = partsFilterCategoryEl.value;
  const status = partsFilterStatusEl.value;

  const items = partsCache.filter((p) => {
    if (machineId && p.machine_id !== machineId) return false;
    if (category && p.category !== category) return false;
    if (status) {
      const st = statusFor(partsStockMap[p.part_id] || 0, p.reorder_point || 0);
      if (st.label !== status) return false;
    }
    if (q) {
      const hay = [p.part_id, p.name, p.category]
        .map((v) => (v || '').toLowerCase())
        .join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!items.length) {
    partsTbody.innerHTML =
      '<tr><td colspan="8" style="text-align:center;">No parts match the filter.</td></tr>';
    return;
  }

  partsTbody.innerHTML = items
    .map((p) => {
      const machine =
        machinesCache.find((m) => m.id === p.machine_id)?.name || '';
      const supplier =
        suppliersCacheLocal.find((s) => s.id === p.supplier_id)?.name || '';
      const stock = partsStockMap[p.part_id] || 0;
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

partsSearchEl.addEventListener('input', renderParts);
partsFilterMachineEl.addEventListener('change', renderParts);
partsFilterCategoryEl.addEventListener('change', renderParts);
partsFilterStatusEl.addEventListener('change', renderParts);
partsClearFilterBtn.addEventListener('click', () => {
  partsSearchEl.value = '';
  partsFilterMachineEl.value = '';
  partsFilterCategoryEl.value = '';
  partsFilterStatusEl.value = '';
  renderParts();
});

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
        <td>${escapeHtml(m.requested_by || '')}</td>
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

// ---------- Maintenance tab (read-only, with filters) ----------
// Maintenance entries are now created via the Log Movement OUT flow.
const maintFilterMachineEl = document.querySelector('#maint-filter-machine');
const maintFilterTypeEl = document.querySelector('#maint-filter-type');
const maintFilterFromEl = document.querySelector('#maint-filter-from');
const maintFilterToEl = document.querySelector('#maint-filter-to');
const maintClearFilterBtn = document.querySelector('#maint-clear-filter');
let maintenanceCache = [];

async function loadMaintenance() {
  try {
    if (!machinesCache.length) await loadLookups();

    const { data, error } = await supabase
      .from('maintenance_log')
      .select('*')
      .order('date', { ascending: false });
    if (error) throw error;
    maintenanceCache = data || [];
    populateMaintFilters();
    renderMaintenance();
  } catch (err) {
    console.error(err);
    showBanner('Failed to load maintenance: ' + (err.message || err), 'error');
  }
}

/** Fill the Machine + Type dropdowns from cached data, preserving selection. */
function populateMaintFilters() {
  const prevMachine = maintFilterMachineEl.value;
  const prevType = maintFilterTypeEl.value;

  maintFilterMachineEl.innerHTML =
    '<option value="">All machines</option>' +
    machinesCache
      .map(
        (m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`
      )
      .join('');
  if (prevMachine) maintFilterMachineEl.value = prevMachine;

  const types = Array.from(
    new Set(maintenanceCache.map((r) => r.type).filter(Boolean))
  ).sort();
  maintFilterTypeEl.innerHTML =
    '<option value="">All types</option>' +
    types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  if (prevType) maintFilterTypeEl.value = prevType;
}

function renderMaintenance() {
  const tbody = document.querySelector('#maint-tbody');
  const machineId = maintFilterMachineEl.value;
  const typeVal = maintFilterTypeEl.value;
  const fromVal = maintFilterFromEl.value;
  const toVal = maintFilterToEl.value;
  const fromTs = fromVal ? new Date(fromVal + 'T00:00:00').getTime() : null;
  const toTs = toVal ? new Date(toVal + 'T23:59:59').getTime() : null;

  const rows = maintenanceCache.filter((r) => {
    if (machineId && r.machine_id !== machineId) return false;
    if (typeVal && r.type !== typeVal) return false;
    if (r.date) {
      const t = new Date(r.date).getTime();
      if (fromTs && t < fromTs) return false;
      if (toTs && t > toTs) return false;
    } else if (fromTs || toTs) {
      // No date on the row but a date filter is set — exclude.
      return false;
    }
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" style="text-align:center;">No maintenance entries match the filter.</td></tr>';
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
        <td>${escapeHtml(r.next_service_date || '')}</td>
      </tr>`;
    })
    .join('');
}

maintFilterMachineEl.addEventListener('change', renderMaintenance);
maintFilterTypeEl.addEventListener('change', renderMaintenance);
maintFilterFromEl.addEventListener('change', renderMaintenance);
maintFilterToEl.addEventListener('change', renderMaintenance);
maintClearFilterBtn.addEventListener('click', () => {
  maintFilterMachineEl.value = '';
  maintFilterTypeEl.value = '';
  maintFilterFromEl.value = '';
  maintFilterToEl.value = '';
  renderMaintenance();
});

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
    'dashboard', 'movement', 'parts', 'movements', 'maintenance',
  ];
  activateTab(valid.includes(hash) ? hash : 'dashboard');
})();
