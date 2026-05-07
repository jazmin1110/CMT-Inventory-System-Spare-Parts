# CMT Inventory System — Spare Parts

A simple spare parts inventory web app for a garment factory in the Philippines.
Plain HTML / CSS / JavaScript built with [Vite](https://vitejs.dev), backed by
[Supabase](https://supabase.com) (Postgres + REST + auth).

> Three screens:
>
> - **Login (PIN pad)** — `index.html`
> - **Worker home** — `worker.html` (log movements, view stock)
> - **Manager dashboard** — `dashboard.html` (parts / movements / maintenance / users)

## Project structure

```
/src
  index.html         ← login screen (PIN pad)
  worker.html        ← warehouse worker home
  dashboard.html     ← manager dashboard
  /js
    supabase.js      ← Supabase client init
    auth.js          ← PIN login + role guards
    worker.js        ← worker screen logic
    dashboard.js     ← manager dashboard logic
    qr.js            ← QR scanning logic (jsQR)
  /css
    style.css        ← shared styles (CSS custom properties)
vite.config.js
package.json
.env                 ← VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
```

## Database tables (must already exist in Supabase)

- `users (id, name, pin /* sha-256 hex */, role /* 'worker' | 'manager' */)`
- `parts (id, part_id text unique, name, machine_id, category, supplier_id, unit_cost, reorder_point, target_stock)`
- `movement_log (id, created_at, part_id, move_type IN/OUT/ADJUST+/ADJUST-, quantity, location, user_id, reference_no, remarks)`
- `maintenance_log (id, date, machine_id, type, work_done, parts_used, technician, downtime_hrs, cost, next_service_date)`
- `machines (id, name)`
- `suppliers (id, name)`

The current PIN values stored in `users.pin` must be **SHA-256 hex** (lowercase)
of the 4-digit PIN — the login screen hashes whatever the user types and looks
up the hash directly.

## Running locally

```bash
npm install
npm run dev      # http://localhost:5173
```

Builds:

```bash
npm run build    # outputs to /dist
npm run preview  # serve the production build
```

## Configuration

The Supabase project URL and anon key are read from `.env`:

```env
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-KEY
```

`.env.example` is checked in for reference. Do **not** commit `.env`.

## QR scanning

- Worker movement form uses **jsQR** (loaded from CDN in `worker.html`) and
  `navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })`.
- Manager parts page generates QR codes with **qrcode.js** (CDN in `dashboard.html`)
  for printing onto bin labels.

The app targets Chrome on Android tablet and works on laptop / phone too.

## Adding the first manager

Insert one row directly into the `users` table where `pin` is the SHA-256 of
the 4-digit PIN you want to use, e.g. for PIN `1234`:

```sql
insert into users (name, pin, role)
values ('Admin', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', 'manager');
```

Then log in with `1234` from the PIN pad.

## Color tokens

Defined in `src/css/style.css`:

| Token            | Value     |
| ---------------- | --------- |
| `--navy`         | `#1e3a5f` |
| `--navy-light`   | `#2d5282` |
| `--navy-dark`    | `#0f172a` |
| `--green`        | `#16a34a` |
| `--red`          | `#dc2626` |
| `--yellow`       | `#d97706` |
| `--gray-bg`      | `#f1f5f9` |
