#!/usr/bin/env node
//
// Scrapes Rainbet's full slot catalog using a stealthed Chromium and merges
// any newly-discovered slots into rainbet_slots.json. Idempotent — re-running
// makes no changes if everything is already present.
//
// Designed to run inside GitHub Actions (see .github/workflows/check-rainbet-slots.yml).
// Locally: `node scripts/check_new_slots.js` from the backend repo root.
//
// Rainbet is a Next.js SPA behind Cloudflare. Slot data is loaded client-side
// (not in __NEXT_DATA__), paginated 64 at a time via a "Load more" button with
// no network calls (all in-memory JS). We click through the full catalog, then
// extract slug/name/thumb from the DOM.

const fs = require('fs');
const path = require('path');
const { addExtra } = require('playwright-extra');
const { chromium } = require('playwright');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const stealthChromium = addExtra(chromium);
stealthChromium.use(StealthPlugin());

const SLOTS_URL = 'https://rainbet.com/casino/slots';
const SLOTS_FILE = path.join(process.cwd(), 'rainbet_slots.json');
const MAX_VERIFY_PARALLEL = 6;

async function scrapeAllSlots() {
  const browser = await stealthChromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  console.log(`[check] navigating to ${SLOTS_URL}`);
  await page.goto(SLOTS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wait for slot cards to appear (the page hydrates client-side)
  await page.waitForSelector('a[href*="/casino/slots/"]', { timeout: 45_000 }).catch(() => {});

  // Give it a moment for initial render
  await page.waitForTimeout(2000);

  // Click "Load more" until it disappears to reveal the full catalog
  let clicks = 0;
  const maxClicks = 500; // safety limit (~32k slots at 64/page)
  while (clicks < maxClicks) {
    const loadMore = await page.$('button:has-text("Load more"), button:has-text("load more")');
    if (!loadMore) break;

    const visible = await loadMore.isVisible().catch(() => false);
    if (!visible) break;

    await loadMore.scrollIntoViewIfNeeded().catch(() => {});
    await loadMore.click().catch(() => {});
    clicks++;
    await page.waitForTimeout(400);

    if (clicks % 20 === 0) {
      const count = await page.$$eval('a[href*="/casino/slots/"]', els => {
        const slugs = new Set();
        for (const a of els) {
          const s = a.getAttribute('href')?.replace('/casino/slots/', '');
          if (s && s.length > 1 && !s.includes('?')) slugs.add(s);
        }
        return slugs.size;
      });
      console.log(`  … ${clicks} clicks, ${count} slots loaded`);
    }
  }
  console.log(`[check] finished loading (${clicks} "Load more" clicks)`);

  // Extract all slot data from the DOM
  const games = await page.$$eval('a[href*="/casino/slots/"]', els => {
    const seen = new Set();
    const results = [];
    for (const a of els) {
      const href = a.getAttribute('href') || '';
      const slug = href.replace('/casino/slots/', '');
      if (!slug || slug.length < 2 || slug.includes('?') || seen.has(slug)) continue;
      seen.add(slug);

      const img = a.querySelector('img');
      let thumb = null;
      if (img) {
        // img src is often a Next.js image optimizer URL like:
        // /_next/image?url=https%3A%2F%2Fcdn.rainbet.com%2Fslots%2FName.png&w=256&q=75
        const src = img.getAttribute('src') || '';
        try {
          const u = new URL(src, 'https://rainbet.com');
          const original = u.searchParams.get('url');
          thumb = original ? decodeURIComponent(original) : src;
        } catch {
          thumb = src;
        }
      }

      const name = img?.alt || slug.replace(/^[a-z]+-[a-z]+-/, '').replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

      results.push({ rainbetSlug: slug, name, thumb });
    }
    return results;
  });

  await browser.close();
  return games;
}

// HEAD-check a thumb URL to make sure CDN hosts it before we commit the entry.
async function verifyThumb(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return r.ok;
  } catch { return false; }
}

async function verifyAll(entries) {
  const out = [];
  for (let i = 0; i < entries.length; i += MAX_VERIFY_PARALLEL) {
    const batch = entries.slice(i, i + MAX_VERIFY_PARALLEL);
    const results = await Promise.all(batch.map(e =>
      e.thumb ? verifyThumb(e.thumb) : Promise.resolve(false)
    ));
    batch.forEach((e, idx) => {
      if (results[idx]) out.push(e);
      else console.log(`  ! skipping (thumb unreachable): ${e.name}`);
    });
  }
  return out;
}

(async () => {
  const games = await scrapeAllSlots();
  if (!Array.isArray(games) || games.length === 0) {
    console.error('[check] failed to extract games from page. Cloudflare may have blocked us.');
    process.exit(1);
  }
  console.log(`[check] scraped ${games.length} slots from the full catalog`);

  if (!fs.existsSync(SLOTS_FILE)) {
    console.error(`[check] ${SLOTS_FILE} not found — run from backend repo root`);
    process.exit(1);
  }
  const existing = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));
  const seenSlugs = new Set(existing.map(s => (s.rainbetSlug || '').toLowerCase()));

  // Also detect slots that were REMOVED from Rainbet
  const liveSlugs = new Set(games.map(g => g.rainbetSlug.toLowerCase()));
  const removed = existing.filter(s => !liveSlugs.has((s.rainbetSlug || '').toLowerCase()));
  if (removed.length > 0 && removed.length < existing.length * 0.5) {
    // Only prune if less than 50% would be removed (safety: a scrape failure
    // that returns partial data shouldn't wipe the file)
    console.log(`[check] ${removed.length} slot(s) no longer on Rainbet — removing`);
    for (const r of removed.slice(0, 20)) console.log(`  - ${r.name}`);
    if (removed.length > 20) console.log(`  … and ${removed.length - 20} more`);
  }

  // Build new file: keep existing entries that are still live (preserves any
  // manual edits to name/thumb), then append genuinely new slots.
  const kept = removed.length < existing.length * 0.5
    ? existing.filter(s => liveSlugs.has((s.rainbetSlug || '').toLowerCase()))
    : existing; // safety: keep all if too many would be removed

  const candidates = [];
  for (const g of games) {
    if (seenSlugs.has(g.rainbetSlug.toLowerCase())) continue;
    if (!g.thumb) continue;

    // Re-encode the path portion for safety
    try {
      const u = new URL(g.thumb);
      u.pathname = u.pathname.split('/').map(seg =>
        encodeURIComponent(decodeURIComponent(seg))
      ).join('/');
      g.thumb = u.toString();
    } catch { /* leave as-is */ }

    candidates.push(g);
  }

  if (candidates.length === 0 && removed.length === 0) {
    console.log('[check] no new slots and nothing removed — DB already up to date');
    return;
  }

  if (candidates.length > 0) {
    console.log(`[check] ${candidates.length} candidate(s) not in DB; verifying thumbnails…`);
    const verified = await verifyAll(candidates);
    console.log(`[check] ${verified.length} passed thumbnail verification`);

    for (const v of verified) {
      kept.push(v);
      console.log(`  + ${v.name}  [${v.rainbetSlug}]`);
    }
  }

  fs.writeFileSync(SLOTS_FILE, JSON.stringify(kept, null, 2) + '\n');
  console.log(`[check] done — file now has ${kept.length} slots (was ${existing.length})`);
})().catch(err => {
  console.error('[check] error:', err);
  process.exit(1);
});
