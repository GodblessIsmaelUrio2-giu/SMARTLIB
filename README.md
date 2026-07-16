# KIUT SmartLib Pass — Supabase + Render setup

This package turns your check-in/check-out/dashboard mockup into a working app:
a small Node/Express API backed by Supabase (Postgres), deployable on Render.

## Folder contents

```
kiut-smartlib/
├── server.js              # Express API (checkin/checkout/logs/stats)
├── package.json
├── render.yaml            # Render deploy blueprint
├── .env.example           # env vars you need to set
├── supabase/
│   └── schema.sql         # run this in Supabase to create tables + seed data
└── public/                # your kiosk pages, now wired to the API
    ├── dashboard.html
    └── assets/style.css
```

## 1. Create the Supabase project

1. Go to https://supabase.com, create a new project (pick any region close to you).
2. Once it's provisioned, open **SQL Editor → New query**.
3. Paste the contents of `supabase/schema.sql` and run it. This creates:
   - `students` — reg number, name, initials
   - `entry_logs` — one row per visit (time in/out, status, flag reason)
   - `v_entry_log` — a view joining the two, used by the dashboard
   - Seed rows matching the demo names already in your HTML
4. Go to **Project Settings → API** and copy:
   - **Project URL** → this is `SUPABASE_URL`
   - **service_role key** (not the anon key) → this is `SUPABASE_SERVICE_ROLE_KEY`

The service role key bypasses Row Level Security so your backend can read/write
freely — keep it secret, never put it in frontend code (it's only used in
`server.js`, which runs on Render, not in the browser).

## 2. Run it locally (optional)

```bash
cd kiut-smartlib
cp .env.example .env
# edit .env and paste in your Supabase URL + service role key
npm install
npm start
```

Visit `http://localhost:3000/dashboard.html` — check-in/check-out are now
done from the dashboard's **Manual override** tab rather than standalone
kiosk pages.

## 3. Deploy to Render

1. Push this folder to a GitHub repo (or use Render's "public Git URL" option).
2. In Render, click **New → Web Service**, connect the repo.
3. Render will detect `render.yaml` automatically. If not, set manually:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Runtime:** Node
4. Add environment variables (Render dashboard → your service → Environment):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
5. Deploy. Render gives you a URL like `https://kiut-smartlib-pass.onrender.com`.
   - `/dashboard.html` is your librarian dashboard (check-in/check-out is done via its Manual override tab)
   - `/api/checkin`, `/api/checkout`, `/api/logs`, `/api/stats` are the API routes

## How manual check-in/check-out works now

Check-in and check-out no longer have dedicated kiosk pages (`checkin.html` /
`checkout.html` were removed). Use the **Manual override** tab in
`dashboard.html` to check a student in or out by registration number instead.

## Notes / next steps

- `entry_logs.status` can be `inside`, `checked_out`, or `flagged`. The
  checkout flow currently doesn't set `flagged` automatically — you'd want to
  add real baggage-tag logic (e.g. a `baggage_tag` column on `students`, or a
  separate `library_items` table) for that check to be meaningful rather than
  a random demo state.
- Add authentication (e.g. Supabase Auth) in front of the dashboard if it
  should not be publicly viewable.
- The `Export CSV` button in the dashboard is still a no-op — happy to wire it
  up to hit `/api/logs` and generate a CSV client-side if useful.