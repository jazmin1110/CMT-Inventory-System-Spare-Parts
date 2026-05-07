// Worker screen logic — Log Movement form + View Stock list.
import { supabase } from './supabase.js';
import { requireRole, logout, showBanner } from './auth.js';
import { startQRScan } from './qr.js';

// Guard: must be signed in. (Workers and managers can both reach this page.)
const user = requireRole();
if (!user) throw new Error('not signed in');

document.querySelector('#user-name').textContent = user.name;
document.querySelector('#logout-btn').addEventListener('click', logout);

// ---------- Section navigation ----------
const sections = {
  home: document.querySelector('#home-section'),
  movement: document.querySelector('#movement-section'),
  stock: document.querySelector('#stock-section'),
};

/** Show one of the section panels and hide the others. */
function showSection(name) {
  Object.entries(sections).forEach(([k, el]) => {
    el.classList.toggle('active', k === name);
  });
  if (name === 'stock') loadStock();
}

document.querySelectorAll('[data-go]').forEach((b) => {
  b.addEventListener('click', () => showSection(b.dataset.go));
});
document
  .querySelector('#back-from-movement')
  .addEventListener('click', () => {
    stopScannerIfRunning();
    showSection('home');
  });
document
  .querySelector('#back-from-stock')
  .addEventListener('click', () => showSection('home'));

// ---------- Move-type segmented control ----------
const moveTypeBtns = document.querySelectorAll('#move-type button');
const moveTypeVal = document.querySelector('#move-type-val');
moveTypeBtns.forEach((b) => {
  b.addEventListener('click', () => {
    moveTypeBtns.forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    moveTypeVal.value = b.dataset.val;
  });
});

// ---------- Quantity stepper ----------
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

// ---------- Part ID lookup ----------
const partIdInput = document.querySelector('#part-id');
const partNameHint = document.querySelector('#part-name-hint');

/** Fetch the part by part_id and show its name beneath the input. */
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

  const payload = {
    part_id: partIdInput.value.trim(),
    move_type: moveTypeVal.value,
    quantity: Number(qtyVal.value),
    location: document.querySelector('#location').value.trim(),
    reference_no:
      document.querySelector('#reference_no').value.trim() || null,
    remarks: document.querySelector('#remarks').value.trim() || null,
    user_id: user.id,
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
    showBanner('Movement logged!', 'success');
    movementForm.reset();
    setQty(1);
    moveTypeBtns.forEach((b) =>
      b.classList.toggle('active', b.dataset.val === 'IN')
    );
    moveTypeVal.value = 'IN';
    partNameHint.textContent = '';
  } catch (err) {
    console.error(err);
    showBanner('Save failed: ' + (err.message || err), 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
});

// ---------- View Stock ----------
const stockListEl = document.querySelector('#stock-list');
const stockSearch = document.querySelector('#stock-search');
let allStock = [];

/**
 * Compute current stock for every part by summing movement_log rows:
 * IN + ADJUST+ add to stock, OUT + ADJUST- subtract.
 */
async function loadStock() {
  stockListEl.innerHTML = '<div class="card">Loading stock...</div>';
  try {
    const [partsRes, movesRes] = await Promise.all([
      supabase.from('parts').select('*').order('name'),
      supabase.from('movement_log').select('part_id, move_type, quantity'),
    ]);
    if (partsRes.error) throw partsRes.error;
    if (movesRes.error) throw movesRes.error;

    const stockMap = {};
    for (const m of movesRes.data || []) {
      const sign =
        m.move_type === 'IN' || m.move_type === 'ADJUST+' ? 1 : -1;
      stockMap[m.part_id] = (stockMap[m.part_id] || 0) + sign * (m.quantity || 0);
    }

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

/** Status pill + class based on reorder thresholds. */
function stockStatus(stock, reorderPoint) {
  if (stock <= reorderPoint) return { label: 'REORDER', cls: 'red' };
  if (stock <= reorderPoint * 1.5) return { label: 'LOW', cls: 'yellow' };
  return { label: 'OK', cls: 'green' };
}

/** Render the stock list, optionally filtered by part name. */
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
      const st = stockStatus(p.current_stock, p.reorder_point || 0);
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

/** Escape user-provided strings before injecting into HTML. */
function escapeHtml(s) {
  return String(s).replace(
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
