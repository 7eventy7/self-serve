// Build step for the resource-pack builder.
//
// A static site can't list folders at runtime, so this script does it at
// deploy time: it scans /versions, pre-zips every module, detects which
// modules overwrite each other's files, and writes dist/manifest.json.
// Cloudflare Pages runs it on every push (build command: `npm run build`).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSIONS_DIR = path.join(ROOT, 'versions');
const SITE_DIR = path.join(ROOT, 'site');
const DIST = path.join(ROOT, 'dist');

// Files at these paths are JSON that several modules can safely share: the
// browser deep-merges them instead of letting one module overwrite another.
export const MERGEABLE =
  /^assets\/[^/]+\/(?:lang\/[^/]+\.json|atlases\/[^/]+\.json|font\/[^/]+\.json|sounds\.json)$/;

// Files at the top of a module folder that describe the module rather than
// belong in the pack.
const MODULE_META = new Set(['module.json', 'icon.png', 'pack.mcmeta', 'pack.png']);

const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn(`  ! ${msg}`); };

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readJson(p, fallback = null) {
  if (!(await exists(p))) return fallback;
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch (e) { throw new Error(`Invalid JSON in ${path.relative(ROOT, p)}: ${e.message}`); }
}

// Folders starting with "." or "_" are ignored, so "_wip-thing" is an easy
// way to keep a module in the repo without publishing it.
async function listDirs(p) {
  const entries = await fs.readdir(p, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !/^[._]/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// "02-gui" -> { order: 2, slug: "gui" }; "gui" -> { order: Infinity, slug: "gui" }
function parseName(name) {
  const m = name.match(/^(\d+)[-_ ](.+)$/);
  return m ? { order: Number(m[1]), slug: m[2] } : { order: Infinity, slug: name };
}

const titleCase = (s) =>
  s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Newest first: "26.3" > "26.2.1" > "26.2" > "1.21.9"
function compareVersionsDesc(a, b) {
  const pa = a.split(/[.\-]/), pb = b.split(/[.\-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    const nx = Number(x), ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny) && x !== '' && y !== '') {
      if (nx !== ny) return ny - nx;
    } else if (x !== y) {
      return y.localeCompare(x);
    }
  }
  return 0;
}

async function copyIfExists(src, dest) {
  if (!(await exists(src))) return false;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  return true;
}

async function buildVersion(versionId) {
  const vDir = path.join(VERSIONS_DIR, versionId);
  const outDir = path.join(DIST, 'packs', versionId);
  const url = (...parts) => ['packs', versionId, ...parts].map(encodeURIComponent).join('/');

  const vJson = await readJson(path.join(vDir, 'version.json'));
  if (!vJson?.pack || typeof vJson.pack !== 'object') {
    warn(`versions/${versionId} skipped: version.json with a "pack" object is required`);
    return null;
  }

  const packPng = (await copyIfExists(path.join(vDir, 'pack.png'), path.join(outDir, 'pack.png')))
    ? url('pack.png') : null;

  const categories = [];
  const seenIds = new Map();      // module id -> folder, to catch duplicates
  const owners = new Map();       // file path -> [module ids] (non-mergeable only)
  const byId = new Map();

  for (const catFolder of await listDirs(vDir)) {
    const cDir = path.join(vDir, catFolder);
    const { order, slug } = parseName(catFolder);
    const cJson = (await readJson(path.join(cDir, 'category.json'), {})) ?? {};
    const catId = cJson.id ?? slug;

    const category = {
      id: catId,
      name: cJson.name ?? titleCase(slug),
      description: cJson.description ?? '',
      icon: (await copyIfExists(path.join(cDir, 'icon.png'), path.join(outDir, 'icons', `_category-${catId}.png`)))
        ? url('icons', `_category-${catId}.png`) : null,
      order: cJson.order ?? order,
      modules: [],
    };

    for (const modFolder of await listDirs(cDir)) {
      const mDir = path.join(cDir, modFolder);
      const { order: mOrder, slug: mSlug } = parseName(modFolder);
      const mJson = (await readJson(path.join(mDir, 'module.json'), {})) ?? {};
      const id = mJson.id ?? mSlug;

      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
        throw new Error(`versions/${versionId}/${catFolder}/${modFolder}: module id "${id}" may only use letters, numbers, . _ -`);
      }
      if (seenIds.has(id)) {
        throw new Error(`versions/${versionId}: duplicate module id "${id}" (${seenIds.get(id)} and ${catFolder}/${modFolder})`);
      }
      seenIds.set(id, `${catFolder}/${modFolder}`);

      const files = (await walk(mDir)).filter((f) => !(MODULE_META.has(f) || (!f.includes('/') && /\.(md|txt)$/i.test(f))));
      if (files.length === 0) {
        warn(`versions/${versionId}/${catFolder}/${modFolder} skipped: no pack files`);
        continue;
      }

      const zip = new JSZip();
      let merges = 0;
      for (const f of files) {
        zip.file(f, await fs.readFile(path.join(mDir, f)));
        if (MERGEABLE.test(f)) { merges++; continue; }
        if (!owners.has(f)) owners.set(f, []);
        owners.get(f).push(id);
      }
      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(outDir, `${id}.zip`), buf);

      const mod = {
        id,
        name: mJson.name ?? titleCase(mSlug),
        description: mJson.description ?? '',
        icon: (await copyIfExists(path.join(mDir, 'icon.png'), path.join(outDir, 'icons', `${id}.png`)))
          ? url('icons', `${id}.png`) : null,
        zip: url(`${id}.zip`),
        size: buf.length,
        files: files.length,
        merges,
        order: mJson.order ?? mOrder,
        conflicts: {},            // other id -> { count, examples[] }
        _incompatible: Array.isArray(mJson.incompatible) ? mJson.incompatible : [],
      };
      category.modules.push(mod);
      byId.set(id, mod);
    }

    category.modules.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    if (category.modules.length) categories.push(category);
  }

  // Modules that write the same (non-mergeable) file can't both be installed.
  const addConflict = (a, b, file) => {
    const entry = (a.conflicts[b.id] ??= { count: 0, examples: [] });
    if (file) {
      entry.count++;
      if (entry.examples.length < 3) entry.examples.push(file);
    }
  };
  for (const [file, ids] of owners) {
    for (const a of ids) for (const b of ids) if (a !== b) addConflict(byId.get(a), byId.get(b), file);
  }
  // Plus anything declared by hand in module.json "incompatible".
  for (const mod of byId.values()) {
    for (const other of mod._incompatible) {
      const o = byId.get(other);
      if (!o) { warn(`${versionId}/${mod.id}: incompatible module "${other}" not found`); continue; }
      addConflict(mod, o); addConflict(o, mod);
    }
  }
  for (const mod of byId.values()) {
    delete mod._incompatible;
    delete mod.order;
  }

  categories.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  categories.forEach((c) => delete c.order);

  const conflictPairs = [...byId.values()].reduce((n, m) => n + Object.keys(m.conflicts).length, 0) / 2;
  console.log(`  ${versionId}: ${categories.length} categories, ${byId.size} modules, ${conflictPairs} conflicting pairs`);

  // Keys starting with "_" are notes for you, not Minecraft.
  const pack = Object.fromEntries(Object.entries(vJson.pack).filter(([k]) => !k.startsWith('_')));
  if (!pack.pack_format && !pack.min_format) {
    warn(`versions/${versionId}/version.json: pack format numbers look unset — Minecraft will flag the pack as incompatible`);
  }

  return {
    id: versionId,
    label: vJson.label ?? versionId,
    pack,
    packPng,
    categories,
  };
}

async function main() {
  console.log('Building resource-pack site…');
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.cp(SITE_DIR, DIST, { recursive: true });

  const jszipSrc = path.join(ROOT, 'node_modules', 'jszip', 'dist', 'jszip.min.js');
  await fs.mkdir(path.join(DIST, 'vendor'), { recursive: true });
  await fs.copyFile(jszipSrc, path.join(DIST, 'vendor', 'jszip.min.js'));

  const config = (await readJson(path.join(ROOT, 'site.config.json'), {})) ?? {};

  if (!(await exists(VERSIONS_DIR))) throw new Error('No /versions folder found');
  const versionIds = (await listDirs(VERSIONS_DIR)).sort(compareVersionsDesc);

  const versions = [];
  for (const v of versionIds) {
    const built = await buildVersion(v);
    if (built) versions.push(built);
  }
  if (!versions.length) throw new Error('No valid versions were built — see warnings above');

  const manifest = {
    generated: new Date().toISOString(),
    site: {
      title: config.title ?? 'Resource Packs',
      tagline: config.tagline ?? '',
      packName: config.packName ?? 'Tweaks',
      author: config.author ?? '',
      url: config.url ?? '',
    },
    latest: versions[0].id,
    versions,
  };
  await fs.writeFile(path.join(DIST, 'manifest.json'), JSON.stringify(manifest));

  console.log(`Done: ${versions.length} version(s) → dist/` + (warnings.length ? ` (${warnings.length} warning(s))` : ''));
}

main().catch((e) => {
  console.error(`\nBuild failed: ${e.message}`);
  process.exit(1);
});
