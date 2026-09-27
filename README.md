# Resource Pack Builder

A Vanilla Tweaks–style site: visitors pick the tweaks they want, click **Download**, and get one merged Minecraft resource pack built in their browser. Hosted free on Cloudflare (Workers with static assets), deployed on every push to `main`.

- **Static front end** — plain HTML/CSS/JS, no framework. The pack is assembled client-side with JSZip.
- **Tiny build step** — scans `/versions`, so versions, categories and modules appear automatically when you add folders.
- **A tiny Worker** (`src/worker.js`) — serves the site and two download-counter endpoints backed by Cloudflare D1 (free tier). Without the database the site works fine; the counters just stay hidden.

## Adding content

Everything lives under `versions/`. Folder names drive the site:

```
versions/
  26.3/                          ← a Minecraft version (shows in the top-right picker)
    version.json                 ← required: pack.mcmeta "pack" values for this version
    pack.png                     ← optional pack icon (falls back to site/pack.png)
    01-aesthetic/                ← a category; "01-" sets the order and is stripped
      category.json              ← optional: { "name", "description" }
      icon.png                   ← optional category icon
      01-lush-grass/             ← a module; its id is "lush-grass"
        module.json              ← optional: { "name", "description", "incompatible": [] }
        icon.png                 ← optional card icon (16×16 or larger, shown pixelated)
        assets/minecraft/...     ← the actual resource-pack files
```

Rules the build follows:

- **Versions** are sorted newest first (`26.3` > `26.2.1` > `1.21.9`); the newest is the default.
- **Module ids** come from the folder name minus the number prefix, or `"id"` in `module.json`. Ids must be unique within a version. Keep the same id across versions so download counts carry over.
- Everything in a module folder goes into the pack except `module.json`, `icon.png`, `pack.mcmeta`, `pack.png`, and top-level `.md`/`.txt` files.
- Folders starting with `_` or `.` are ignored — rename a module to `_wip-thing` to hide it without deleting it.
- Names default to the folder slug in Title Case if there's no `name` in the JSON.

### version.json

The `pack` object is copied straight into the downloaded `pack.mcmeta`, so put whatever that Minecraft version expects in it:

```json
{
  "label": "26.3",
  "pack": { "pack_format": 0, "min_format": 0, "max_format": 0 }
}
```

⚠️ **The sample files use placeholder `0`s.** Replace them with the real format numbers for each version (the Minecraft Wiki's "Pack format" page lists them). Keys starting with `_` are treated as notes and stripped. The build prints a warning while the numbers look unset.

### Overlapping files

- **Automatic conflicts:** if two modules contain the same file path, the build marks them as conflicting. On the site, picking one deselects the other with a notice, and the cards show a ⚠ badge.
- **Manual conflicts:** add `"incompatible": ["other-id"]` to `module.json` for modules that don't share files but still don't work together.
- **Merged files:** these JSON files are merged instead of conflicting, so several modules can each add a few entries:
  `assets/*/lang/*.json`, `assets/*/atlases/*.json`, `assets/*/font/*.json`, `assets/*/sounds.json`.
  Objects merge key by key, arrays are concatenated, and if two modules set the same key the one listed later on the page wins.

### The downloaded pack

```
pack.mcmeta           ← your version.json "pack" + an "installed_modules" block
pack.png
Selected Tweaks.txt   ← human-readable list (plus a rebuild link if "url" is set)
assets/...
```

`pack.mcmeta` looks like:

```json
{
  "pack": { "...": "from version.json", "description": "Tweaks for 26.3 · 4 tweaks" },
  "installed_modules": {
    "builder": "Resource Packs",
    "minecraft_version": "26.3",
    "generated": "2026-09-27T12:47:30.732Z",
    "modules": ["lush-grass", "dark-inventory", "shorter-names", "clearer-names"]
  }
}
```

Minecraft ignores the extra `installed_modules` section.

### Site settings

Edit `site.config.json`:

| Key | Used for |
|---|---|
| `title` | Page title and header |
| `tagline` | Line under the title |
| `packName` | Download filename and pack description (`Tweaks-26.3-4tweaks.zip`) |
| `author` | Footer credit |
| `url` | Your live URL, e.g. `https://self-serve.you.workers.dev` — enables the rebuild link in `Selected Tweaks.txt` |

Replace `site/favicon.png` and `site/pack.png` with your own art. The sample content in `versions/` is placeholder — delete it and drop in your real packs.

## Running locally

```bash
npm install
npm run build          # writes dist/
npm run dev            # build + local Cloudflare server at http://localhost:8787
```

`npm run dev` downloads Wrangler on first use. Stats work locally once the D1 block in `wrangler.jsonc` is enabled.

## Deploying to Cloudflare

1. Dashboard → **Workers & Pages** → **Create** → **Import a repository** → pick the GitHub repo.
2. Settings:
   - **Project name:** must match `"name"` in `wrangler.jsonc` (currently `self-serve`)
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy`
   - **Non-production branch deploy command:** `npx wrangler versions upload` (the default)
3. **Deploy.** The site goes live at `https://self-serve.<your-subdomain>.workers.dev`.

Every push to `main` rebuilds and deploys. Pushes to other branches get preview URLs if preview builds are on. Node 22 is pinned via `.node-version`.

### Download stats (optional, free)

1. Dashboard → **Storage & Databases** → **D1 SQL Database** → **Create** → name it `pack-stats`.
2. Copy its **Database ID**.
3. In `wrangler.jsonc`, uncomment the `d1_databases` block and paste the ID.
4. Commit and push.

Add bindings in `wrangler.jsonc`, not the dashboard: each deploy applies the file and would remove dashboard-only bindings. The table is created automatically on first request.

How counting works:

- Each download bumps a total counter and one counter per included module.
- Counts are keyed by module id, so they span all versions.
- Only ids present in the deployed manifest are counted.
- The endpoint isn't rate-limited, so someone determined could inflate numbers.
- D1's free tier (100k writes/day) is far beyond what a pack site needs.

## How it works

```
build.mjs          scans versions/, zips each module, detects conflicts, writes dist/manifest.json
site/              index.html, style.css, app.js — copied to dist/
src/worker.js      serves dist/ plus GET /api/stats and POST /api/download
lib/stats.js       D1 helpers used by the worker
wrangler.jsonc     Cloudflare config: worker name, assets folder, D1 binding
```

A static site can't list folders in the browser, so the build step does the scanning at deploy time. Each module is pre-zipped, so a download is one request per selected module rather than one per texture. The browser then unpacks those, merges the shared JSON files, adds `pack.mcmeta`, and hands back a single zip.
