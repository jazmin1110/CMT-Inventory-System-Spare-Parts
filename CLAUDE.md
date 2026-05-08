# CLAUDE.md — CMT Inventory System (Spare Parts)

## What this project is

Plain-HTML/CSS/JS spare-parts inventory app for a garment factory in the Philippines.
No build step, no npm, no bundler. Static files served from Vercel, backed by Supabase.

**Three screens:**
- `index.html` — PIN-pad login (SHA-256 hashed, client-side)
- `worker.html` + `js/worker.js` — warehouse worker home (log movements, view stock, view maintenance)
- `dashboard.html` + `js/dashboard.js` — manager home (full CRUD on parts, view movements/maintenance, manage users)

---

## Tech stack

| Layer | Detail |
|---|---|
| Frontend | Vanilla JS (ES modules), plain HTML, `css/style.css` |
| Auth | PIN → SHA-256 (Web Crypto) → Supabase `users.pin` lookup. Session stored in `localStorage` as `cmt_user`. No Supabase Auth. |
| Database | Supabase (PostgreSQL). Anon key is public by design; RLS protects data. |
| CDN libs | `@supabase/supabase-js@2` via `esm.sh`, `jsQR@1.4.0` (worker), `qrcodejs@1.0.0` (dashboard) |
| Deploy | Vercel static site (`vercel.json` — `cleanUrls: true`) |

---

## Database schema (must exist in Supabase)

```sql
users        (id uuid, name text, pin text /* sha-256 hex */, role text /* 'worker'|'manager' */)
parts        (id uuid, part_id text UNIQUE, name text, machine_id uuid, category text,
              supplier_id uuid, unit_cost numeric, reorder_point int, target_stock int)
movement_log (id uuid, created_at timestamptz, part_id text, move_type text
              /* 'IN'|'OUT'|'ADJUST+'|'ADJUST-' */, quantity int, location text,
              user_id uuid, reference_no text, remarks text, requested_by text, machine_id uuid)
maintenance_log (id uuid, date date, machine_id uuid, type text, work_done text,
                 parts_used text, technician text, downtime_hrs numeric, cost numeric, next_service_date date)
machines     (id uuid, name text)
suppliers    (id uuid, name text)
```

**Stock calculation:** computed on-the-fly by `buildStockMap()` — sums all movement rows.
No dedicated stock column exists.

---

## File map

```
index.html        login screen (PIN pad)
worker.html       worker home (tabs: Dashboard, Log Movement, Parts, Movements, Maintenance)
dashboard.html    manager home (tabs: Dashboard, Parts, Movements, Maintenance, Users)
css/style.css     shared styles + CSS custom properties (color tokens)
js/supabase.js    single Supabase client instance (ESM)
js/auth.js        sha256Hex, saveUser, getUser, logout, requireRole, initLoginScreen,
                  changePin, setUserPin, showBanner
js/worker.js      all worker-screen logic
js/dashboard.js   all manager-screen logic
js/qr.js          startQRScan() — opens rear camera, feeds jsQR frame-by-frame
vercel.json       static site config (cleanUrls, no trailing slash)
```

---

## Key patterns to follow

### Auth guard
Every page-level JS file calls `requireRole()` at the top (before any DOM work).
Workers use `requireRole()` (any role OK), managers use `requireRole('manager')`.

### HTML escaping
Always pass untrusted strings through `escapeHtml()` before inserting into innerHTML.
The function lives in both `worker.js` and `dashboard.js` (duplicated — known issue).

### Caches
`machinesCache`, `suppliersCache`, `usersCache`, `partsCache`, `allMovementsCache` are
module-level arrays. `loadLookups()` populates the lookup tables once per page load.
Guards like `if (!machinesCache.length) await loadLookups()` prevent redundant fetches.

### Supabase error handling
All Supabase calls follow: `const { data, error } = await supabase.from(...)`
Always check `if (error) throw error` immediately. Never ignore errors silently.

### Spinner pattern (dashboard only)
`withBusyButton(btn, asyncFn)` disables the button and shows a spinner while `asyncFn` runs.
Worker.js handles this inline (no shared helper) — a known duplication.

### Move types
`IN` / `OUT` / `ADJUST+` / `ADJUST-`
Stock sign: `IN` and `ADJUST+` = +1; `OUT` and `ADJUST-` = -1.

### Maintenance log creation
Maintenance entries are created automatically as a side-effect of an OUT movement when the
worker enables the maintenance toggle. The two inserts are sequential, not atomic.

---

## Running locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```
Camera/QR scanning requires `http://localhost` or HTTPS (Chrome blocks getUserMedia on plain HTTP).

## Creating the first manager (no UI)

```sql
insert into users (name, pin, role) values (
  'Admin',
  '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',  -- SHA-256 of '1234'
  'manager'
);
```

---

## Known issues / tech debt

1. **Massive duplication between `worker.js` and `dashboard.js`** — `formatDateTime`,
   `escapeHtml`, `buildStockMap`, `statusFor`, `moveTypePill`, `renderMovements`,
   `loadMovements`, `populateMaintFilters`, `renderMaintenance`, `loadMaintenance`,
   `renderParts`, `populatePartsFilters`, and the Change PIN modal block are all
   copy-pasted. Extract to a shared `js/shared.js` when the app grows.

2. **No movement_log limit** — `loadDashboard` and `loadMovements` fetch all rows from
   `movement_log` with no `.limit()`. Will slow down as the log grows; add pagination or
   a date-range default filter.

3. **`partsCache` may be empty on first maintenance OUT** — if a worker goes straight to
   Log Movement without visiting Dashboard or Parts first, `partsCache` is empty and the
   auto-populated `parts_used` field in the maintenance log will lack the part name.

4. **No stock validation on OUT** — workers can log OUT more units than are in stock,
   driving stock negative. This is a UX gap, not a crash bug.

5. **No user deletion** — the Users tab only supports add + reset PIN, not remove.

---

## Color tokens (css/style.css)

| Token | Value |
|---|---|
| `--navy` | `#1e3a5f` |
| `--navy-light` | `#2d5282` |
| `--navy-dark` | `#0f172a` |
| `--green` | `#16a34a` |
| `--red` | `#dc2626` |
| `--yellow` | `#d97706` |
| `--gray-bg` | `#f1f5f9` |
