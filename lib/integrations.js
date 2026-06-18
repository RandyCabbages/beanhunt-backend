// External integrations: Twitch live status, beantwitch leaderboard proxy, Discord import/parse.
// These are the functions that become per-tenant in the multi-tenancy work — isolated here
// so that change edits one small module instead of the main server file.

// ── Twitch live check ──────────────────────────────────────────────
let beanLive = { isLive: false, title: '', updatedAt: null };

async function checkBeanLive(io) {
  const cid = process.env.TWITCH_CLIENT_ID;
  const sec = process.env.TWITCH_CLIENT_SECRET;
  if (!cid || !sec) return;
  try {
    const tr = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${cid}&client_secret=${sec}&grant_type=client_credentials`
    });
    const td = await tr.json();
    const sr = await fetch('https://api.twitch.tv/helix/streams?user_login=bean', {
      headers: { 'Client-ID': cid, 'Authorization': `Bearer ${td.access_token}` }
    });
    const sd = await sr.json();
    beanLive = { isLive: !!(sd.data?.length), title: sd.data?.[0]?.title||'', updatedAt: new Date().toISOString() };
    io.emit('bean:live', beanLive);
  } catch(e) { console.error('Twitch check error:', e.message); }
}
function getBeanLive() { return beanLive; }
function startTwitchPolling(io) {
  checkBeanLive(io);
  setInterval(() => checkBeanLive(io), 5 * 60 * 1000);
}

// ── BeanTwitch leaderboard proxy ───────────────────────────────────
// The beantwitch.com leaderboard API (https://api.beantwitch.com) is public
// but CORS-allowlists only beantwitch.com, so the browser can't call it from
// communityhunts.gg. We proxy it server-side, merge in prize/config metadata,
// and cache the result so the homepage can render the synced standings.
let lbCache = { data: null, fetchedAt: 0 };
const LB_API = 'https://api.beantwitch.com';

async function getLeaderboard() {
  const CACHE_MS = 90 * 1000; // 90s — matches the upstream cache cadence
  if (lbCache.data && Date.now() - lbCache.fetchedAt < CACHE_MS) return lbCache.data;

  // beantwitch returns 500 unless the Origin is on its allowlist.
  const headers = { 'User-Agent': 'Mozilla/5.0 Chrome/120', 'Origin': 'https://beantwitch.com', 'Accept': 'application/json' };
  const [lbRes, cfgRes] = await Promise.all([
    fetch(`${LB_API}/api/leaderboard`, { headers }),
    fetch(`${LB_API}/api/config`,      { headers }),
  ]);
  if (!lbRes.ok)  throw new Error(`leaderboard upstream ${lbRes.status}`);
  if (!cfgRes.ok) throw new Error(`config upstream ${cfgRes.status}`);
  const lbJson  = await lbRes.json();
  const cfg     = await cfgRes.json();

  const prizes = Array.isArray(cfg.leaderboard_prizes) ? cfg.leaderboard_prizes : [];
  const rows   = (lbJson?.data?.leaderboard || []).map(r => ({
    rank:    r.rank,
    player:  r.username,                 // already masked upstream (e.g. "2A***r")
    wagered: r.wager,
    prize:   prizes[r.rank - 1] ?? null, // prize by rank (1-indexed)
  }));

  const data = {
    prizePool:   cfg.leaderboard_prize_pool ?? null,
    currency:    cfg.currency || 'USD',
    startDay:    cfg.leaderboard_start_day || null,
    endDay:      cfg.leaderboard_end_day   || null,
    syncedAt:    lbJson?.data?.cache_updated_at || null, // upstream cache timestamp
    fetchedAt:   new Date().toISOString(),
    standings:   rows,
    fullUrl:     'https://beantwitch.com/leaderboard',
  };
  lbCache = { data, fetchedAt: Date.now() };
  return data;
}
function getLeaderboardCache() { return lbCache.data; }

// ── Discord Import ────────────────────────────────────────────────
const DISCORD_BOT_TOKEN       = process.env.DISCORD_BOT_TOKEN || '';
const DISCORD_CALLS_CHANNEL   = process.env.DISCORD_CALLS_CHANNEL_ID || '';
const DISCORD_WINNERS_CHANNEL = process.env.DISCORD_WINNERS_CHANNEL_ID || '';

async function fetchDiscordMessages(channelId, limit = 100) {
  if (!DISCORD_BOT_TOKEN || !channelId) throw new Error('Discord bot not configured');
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Discord API error: ${res.status}`);
  return res.json();
}

// Import slot calls from last 20 mins — only from equity members of the given hunt.
// `hunt` is the active hunt object; `normalizeSlot` is injected to avoid importing server state.
async function importCalls(hunt, normalizeSlot) {
  const messages = await fetchDiscordMessages(DISCORD_CALLS_CHANNEL, 100);
  const cutoff   = Date.now() - 20 * 60 * 1000;
  const recent = messages.filter(m => new Date(m.timestamp).getTime() > cutoff);

  // Both hunt types: only import calls from equity members
  const equityNames = (hunt.equity || []).filter(e => e.name).map(e => e.name.toLowerCase().trim());

  const imported = [];
  const existingSlots = new Set((hunt.calls || []).map(c => normalizeSlot(c.slot)));

  for (const msg of recent) {
    const callerName = msg.member?.nick || msg.author?.global_name || msg.author?.username || '';
    const author     = (msg.author?.username || '').toLowerCase().trim();
    const nick       = (msg.member?.nick || '').toLowerCase().trim();
    const globalName = (msg.author?.global_name || '').toLowerCase().trim();
    const inEquity   = equityNames.some(n =>
      n === author || n === nick || n === globalName ||
      author.includes(n) || nick.includes(n) || n.includes(author)
    );
    if (!inEquity) continue;

    // Strip @mentions and leading/trailing whitespace from content
    let content = msg.content
      .replace(/<@!?\d+>/g, '')   // strip discord @mentions
      .replace(/@\w+/g, '')       // strip plain @mentions
      .trim();

    if (!content) continue;

    // Split by comma or newline — each part is a slot call
    const parts = content.split(/[,\n]/).map(p => p.trim()).filter(p => p.length > 1 && p.length < 80);

    for (const part of parts) {
      const slotName = part.replace(/^[#\-•*\d.]+\s*/, '').trim();
      const nsName = normalizeSlot(slotName);
      if (slotName && nsName && !existingSlots.has(nsName)) {
        imported.push({
          id: `dc_${msg.id}_${imported.length}`,
          slot: slotName,
          caller: callerName,
          status: 'pending',
          source: 'discord'
        });
        existingSlots.add(nsName);
      }
    }
  }

  return { imported, count: imported.length };
}

// Parse VIP winners from Discord — finds latest results message and extracts names.
async function parseWinners() {
  const messages = await fetchDiscordMessages(DISCORD_WINNERS_CHANNEL, 50);

  // Find the most recent message containing winner results (has "#1" and "Checked-In")
  const resultsMsg = messages.find(m =>
    m.content.includes('Checked-In') && m.content.includes('#1')
  );
  if (!resultsMsg) return { winners: [], count: 0, raw: 'No results message found in last 50 messages' };

  // Parse lines like: #1    Jaycsk    144.949925    +45    Checked-In
  const winners = [];
  const lines = resultsMsg.content.split('\n');
  for (const line of lines) {
    const match = line.match(/^#(\d+)\s+(.+?)\s+(\d+\.\d+)\s+([+-]?\d+)/);
    if (match) {
      winners.push({
        place: parseInt(match[1]),
        name:  match[2].trim(),
        roll:  parseFloat(match[3]),
        luck:  parseInt(match[4]),
      });
    }
  }

  return { winners, count: winners.length };
}

module.exports = {
  getBeanLive, startTwitchPolling,
  getLeaderboard, getLeaderboardCache,
  fetchDiscordMessages, importCalls, parseWinners,
};
