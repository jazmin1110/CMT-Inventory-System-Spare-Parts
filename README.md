# CMT Inventory System — Spare Parts

A simple spare parts inventory web app for a garment factory in the Philippines.
Plain HTML, CSS, and JavaScript — **no build step**, no `npm install`, no
bundler. Backed by [Supabase](https://supabase.com), deployable to
[Vercel](https://vercel.com) by uploading the folder.

## Screens

- **Login (PIN pad)** — `index.html`
- **Worker home** — `worker.html` (log movements, view stock)
- **Manager dashboard** — `dashboard.html` (parts / movements / maintenance / users)

## Project layout

```
index.html          login screen (PIN pad)
worker.html         warehouse worker home
dashboard.html      manager dashboard
css/style.css       shared styles
js/supabase.js      Supabase client (loaded from esm.sh CDN)
js/auth.js          PIN login + role guards
js/worker.js        worker screen logic
js/dashboard.js     manager dashboard logic
js/qr.js            QR scanning helper (jsQR via CDN)
```

External libraries are loaded straight from CDNs:
- `@supabase/supabase-js@2` from `https://esm.sh/`
- `jsQR` from `cdnjs.cloudflare.com` (in `worker.html`)
- `qrcodejs` from `cdnjs.cloudflare.com` (in `dashboard.html`)

## Database tables (must already exist in Supabase)

- `users (id, name, pin /* sha-256 hex */, role /* 'worker' | 'manager' */)`
- `parts (id, part_id text unique, name, machine_id, category, supplier_id, unit_cost, reorder_point, target_stock)`
- `movement_log (id, created_at, part_id, move_type IN/OUT/ADJUST+/ADJUST-, quantity, location, user_id, reference_no, remarks)`
- `maintenance_log (id, date, machine_id, type, work_done, parts_used, technician, downtime_hrs, cost, next_service_date)`
- `machines (id, name)`
- `suppliers (id, name)`

The `users.pin` column stores the **SHA-256 hex** (lowercase) of the 4-digit
PIN — the login screen hashes whatever the user types and looks up the hash
directly.

> **Row Level Security**: the Supabase anon key is publicly embedded in
> `js/supabase.js` (it's designed to be public). What actually protects the
> data is RLS — make sure the `anon` role has the policies it needs to
> `select` / `insert` / `update` on each table for the app to work.

## Run locally

You need **any** static file server. The simplest options:

```bash
# Option 1 — npx (no install needed, requires Node)
npx serve

# Option 2 — Python (built into macOS)
python3 -m http.server 8000

# Option 3 — VS Code "Live Server" extension: right-click index.html → "Open with Live Server"
```

Then open `http://localhost:8000` (or whatever port the tool prints).

> **Camera/QR scanning** requires either `http://localhost` or HTTPS — Chrome
> blocks `getUserMedia` on plain HTTP from any other origin. Use `localhost`
> for development; in production Vercel gives you HTTPS automatically.

## Deploy to Vercel

No build step needed. Two ways:

```bash
# Option 1 — Vercel CLI
npm i -g vercel
vercel        # follow the prompts; "What's your project's framework preset?" → Other
```

Or **drag-and-drop**: go to <https://vercel.com/new>, drop the project folder
in, accept defaults. Vercel detects it as a static site, uploads the files,
and gives you a URL on `*.vercel.app` immediately.

## Adding the first manager

There's no UI for creating the first manager (the Users tab requires you to
already be logged in as a manager). Insert one row directly into the `users`
table where `pin` is the SHA-256 of the 4-digit PIN you want to use, e.g.
for PIN `1234`:

```sql
insert into users (name, pin, role)
values (
  'Admin',
  '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',
  'manager'
);
```

Then log in with `1234` from the PIN pad.

## Color tokens

Defined in [`css/style.css`](css/style.css):

| Token            | Value     |
| ---------------- | --------- |
| `--navy`         | `#1e3a5f` |
| `--navy-light`   | `#2d5282` |
| `--navy-dark`    | `#0f172a` |
| `--green`        | `#16a34a` |
| `--red`          | `#dc2626` |
| `--yellow`       | `#d97706` |
| `--gray-bg`      | `#f1f5f9` |
