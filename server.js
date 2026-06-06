const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const HOST = 'v3.football.api-sports.io';

// Telegram — set these as env vars in Render
const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT = process.env.TG_CHAT || '';

app.use(cors());
app.use(express.json());

// Send a Telegram message (silently no-ops if not configured)
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return { ok: false, reason: 'not configured' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const d = await res.json();
    return { ok: d.ok === true, result: d };
  } catch(e) {
    console.error('Telegram error:', e.message);
    return { ok: false, reason: e.message };
  }
}

// Cache
const cache = new Map();
function getCached(k, ttl) {
  const e = cache.get(k);
  if (!e || Date.now() - e.ts > ttl * 1000) { cache.delete(k); return null; }
  return e.data;
}
function setCache(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

// Rate limiter — Pro plan allows 300/min. We cap at 250 for safety headroom.
const RATE_MAX = parseInt(process.env.RATE_MAX || '250', 10);
// ── Daily budget guard ──
// Pro = 7500/day. Cap server auto-scanner at 6500, leaving ~1000 for manual.
const DAILY_BUDGET = parseInt(process.env.DAILY_BUDGET || '6500', 10);
let callsToday = 0;
let budgetDay = new Date().toISOString().split('T')[0];
function trackCall() {
  const today = new Date().toISOString().split('T')[0];
  if (today !== budgetDay) { budgetDay = today; callsToday = 0; }  // reset at UTC midnight
  callsToday++;
}
function budgetLeft() {
  const today = new Date().toISOString().split('T')[0];
  if (today !== budgetDay) { budgetDay = today; callsToday = 0; }
  return DAILY_BUDGET - callsToday;
}

const times = [];
async function call(endpoint) {
  const now = Date.now();
  while (times.length && now - times[0] > 60000) times.shift();
  if (times.length >= RATE_MAX) {
    const wait = 60000 - (now - times[0]) + 200;
    console.log(`Rate limit wait: ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
  }
  times.push(Date.now());
  trackCall();
  const res = await fetch(`https://${HOST}${endpoint}`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const d = await res.json();
  if (d.errors && Object.keys(d.errors).length) throw new Error(JSON.stringify(d.errors));
  return d.response || [];
}

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Unders Pro — API-Football' }));

app.get('/live', async (req, res) => {
  try {
    const cached = getCached('live', 45);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await call('/fixtures?live=all');
    setCache('live', data);
    res.json({ source: 'api', data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/upcoming', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const k = `up_${today}`;
    const cached = getCached(k, 600);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await call(`/fixtures?date=${today}&status=NS`);
    setCache(k, data);
    res.json({ source: 'api', data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function doResearch(homeId, awayId, leagueId, fixtureId) {
  const k = `r_${fixtureId}`;
  const cached = getCached(k, 90);  // 90s — live stats change fast
  if (cached) return { source: 'cache', ...cached };

  const season = new Date().getFullYear();

    // Pro plan — fire all calls in parallel for speed
    const [h2hRaw, homeSt, awaySt, lineups, odds, statsRaw, eventsRaw] = await Promise.all([
      call(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`),
      call(`/teams/statistics?team=${homeId}&league=${leagueId}&season=${season}`),
      call(`/teams/statistics?team=${awayId}&league=${leagueId}&season=${season}`),
      call(`/fixtures/lineups?fixture=${fixtureId}`),
      call(`/odds/live?fixture=${fixtureId}&bet=5`),
      call(`/fixtures/statistics?fixture=${fixtureId}`),   // LIVE in-game stats
      call(`/fixtures/events?fixture=${fixtureId}`),        // LIVE events timeline
    ]);

    // H2H
    const h2h = h2hRaw.slice(0, 10);
    const h2hTotal = h2h.length;
    const h2hAvg = h2hTotal ? +(h2h.reduce((s,f)=>s+(f.goals?.home||0)+(f.goals?.away||0),0)/h2hTotal).toFixed(2) : 2.4;
    const u25 = h2h.filter(f=>(f.goals?.home||0)+(f.goals?.away||0)<2.5).length;
    const u35 = h2h.filter(f=>(f.goals?.home||0)+(f.goals?.away||0)<3.5).length;
    const u45 = h2h.filter(f=>(f.goals?.home||0)+(f.goals?.away||0)<4.5).length;
    const last5 = h2h.slice(0,5).map(f=>({
      home:f.teams?.home?.name, away:f.teams?.away?.name,
      score:`${f.goals?.home||0}:${f.goals?.away||0}`,
      total:(f.goals?.home||0)+(f.goals?.away||0),
      date:(f.fixture?.date||'').split('T')[0]
    }));

    // Home stats
    const h = homeSt[0] || {};
    const homeFor     = parseFloat(h.goals?.for?.average?.home || 1.3);
    const homeAgainst = parseFloat(h.goals?.against?.average?.home || 1.2);
    const homeForm    = h.form ? h.form.slice(-5) : 'DDDDD';
    const homeCS      = +(( h.clean_sheet?.home||0) / Math.max(h.fixtures?.played?.home||1,1)).toFixed(2);
    const homeWin     = +((h.fixtures?.wins?.home||0) / Math.max(h.fixtures?.played?.home||1,1)).toFixed(2);

    // Away stats
    const a = awaySt[0] || {};
    const awayFor     = parseFloat(a.goals?.for?.average?.away || 1.1);
    const awayAgainst = parseFloat(a.goals?.against?.average?.away || 1.3);
    const awayForm    = a.form ? a.form.slice(-5) : 'DDDDD';
    const awayCS      = +((a.clean_sheet?.away||0) / Math.max(a.fixtures?.played?.away||1,1)).toFixed(2);

    // Lineups
    const homeL = lineups[0] || {};
    const awayL = lineups[1] || {};
    const homeFm = homeL.formation || null;
    const awayFm = awayL.formation || null;
    const defForms = ['4-5-1','5-4-1','5-3-2','4-4-2','3-5-2','4-1-4-1'];
    const homeDef = homeFm ? defForms.includes(homeFm) : false;
    const awayDef = awayFm ? defForms.includes(awayFm) : false;

    // Live odds
    const liveOdds = {};
    for (const bk of (odds[0]?.odds||[])) {
      for (const bet of (bk.bets||[])) {
        if (bet.id===5||(bet.name||'').toLowerCase().includes('over/under')) {
          for (const v of (bet.values||[])) {
            const l=(v.value||'').toLowerCase();
            if(l==='under 2.5') liveOdds['Under 2.5']=parseFloat(v.odd);
            if(l==='under 3.5') liveOdds['Under 3.5']=parseFloat(v.odd);
            if(l==='under 4.5') liveOdds['Under 4.5']=parseFloat(v.odd);
            if(l==='under 5.5') liveOdds['Under 5.5']=parseFloat(v.odd);
            if(l==='under 6.5') liveOdds['Under 6.5']=parseFloat(v.odd);
          }
        }
      }
    }

    // ── LIVE IN-GAME STATS (the real edge) ──
    // statsRaw is array of 2 teams, each with statistics array
    function getStat(teamStats, type) {
      if (!teamStats?.statistics) return 0;
      const s = teamStats.statistics.find(x => (x.type||'').toLowerCase() === type.toLowerCase());
      if (!s) return 0;
      const v = s.value;
      if (v === null || v === undefined) return 0;
      if (typeof v === 'string' && v.includes('%')) return parseInt(v) || 0;
      return parseInt(v) || 0;
    }
    const hStat = statsRaw[0] || null;
    const aStat = statsRaw[1] || null;

    const liveStats = {
      home: {
        shotsTotal:    getStat(hStat, 'Total Shots'),
        shotsOnGoal:   getStat(hStat, 'Shots on Goal'),
        dangerAttacks: getStat(hStat, 'Dangerous Attacks'),
        attacks:       getStat(hStat, 'Attacks'),
        possession:    getStat(hStat, 'Ball Possession'),
        corners:       getStat(hStat, 'Corner Kicks'),
        xg:            parseFloat((hStat?.statistics?.find(x=>(x.type||'').toLowerCase()==='expected_goals')?.value)||0),
      },
      away: {
        shotsTotal:    getStat(aStat, 'Total Shots'),
        shotsOnGoal:   getStat(aStat, 'Shots on Goal'),
        dangerAttacks: getStat(aStat, 'Dangerous Attacks'),
        attacks:       getStat(aStat, 'Attacks'),
        possession:    getStat(aStat, 'Ball Possession'),
        corners:       getStat(aStat, 'Corner Kicks'),
        xg:            parseFloat((aStat?.statistics?.find(x=>(x.type||'').toLowerCase()==='expected_goals')?.value)||0),
      },
      available: false,  // set below after checking for real data
    };
    // A stats response can come back as two empty team objects for leagues
    // without live-stats coverage. Only treat as "available" if there's REAL data.
    const totalStatsSignal =
      (liveStats.home.shotsTotal + liveStats.away.shotsTotal) +
      (liveStats.home.attacks + liveStats.away.attacks) +
      (liveStats.home.dangerAttacks + liveStats.away.dangerAttacks) +
      (liveStats.home.possession + liveStats.away.possession);
    liveStats.available = !!(hStat && aStat) && totalStatsSignal > 0;

    // ── LIVE EVENTS — red cards, recent goals, subs ──
    const events = eventsRaw || [];
    const goals = events.filter(e => e.type === 'Goal');
    const redCards = events.filter(e => e.type === 'Card' && (e.detail||'').includes('Red'));
    const recentGoals = goals.filter(e => (e.time?.elapsed||0) >= 45); // 2nd half goals
    const lastGoalMin = goals.length ? Math.max(...goals.map(e => e.time?.elapsed||0)) : 0;
    const eventsAvailable = events.length > 0;
    // Goals in the last ~15 min = game is currently open/end-to-end
    const veryRecentGoals = goals.filter(e => (e.time?.elapsed||0) >= 55).length;
    const subs = events.filter(e => e.type === 'subst').length;

    // ── PRESSURE / MOMENTUM SCORE ──
    const totalShotsOnGoal = liveStats.home.shotsOnGoal + liveStats.away.shotsOnGoal;
    const totalDangerAttacks = liveStats.home.dangerAttacks + liveStats.away.dangerAttacks;
    const totalShots = liveStats.home.shotsTotal + liveStats.away.shotsTotal;
    const liveXgTotal = +(liveStats.home.xg + liveStats.away.xg).toFixed(2);

    // Pressure index — higher means more goal threat right now
    let pressure = 0;
    let pressureSource = 'none';
    if (liveStats.available) {
      // FULL pressure — real shot/attack data (covered leagues)
      pressure = Math.min(100, Math.round(
        (totalShotsOnGoal * 6) +
        (totalDangerAttacks * 0.4) +
        (totalShots * 1.5) +
        (recentGoals.length * 8)
      ));
      pressureSource = 'full';
    } else if (eventsAvailable) {
      // PARTIAL pressure — events only (lower leagues without stats coverage)
      // Recent goals are the strongest live signal that a game is opening up.
      pressure = Math.min(100, Math.round(
        (veryRecentGoals * 30) +     // a goal in last ~35min = strong open-game signal
        (recentGoals.length * 12)    // 2nd-half goals generally
      ));
      pressureSource = 'events';
    }

    const liveAnalysis = {
      available: liveStats.available,           // true only when FULL shot/attack stats present
      eventsAvailable,                          // true when at least events are present
      pressureSource,                           // 'full' | 'events' | 'none'
      hasAnyLiveData: pressureSource !== 'none',
      pressure,                       // 0-100, lower is better for under
      totalShotsOnGoal,
      totalDangerAttacks,
      totalShots,
      liveXgTotal,
      redCards: redCards.length,
      redCardTeam: redCards.length ? (redCards[0].team?.name || null) : null,
      recentGoalCount: recentGoals.length,
      lastGoalMin,
    };

    // ── H2H rates with shrinkage toward a neutral prior ──
    // A single meeting that went under should NOT read as 100%. We pull small
    // samples toward a sensible baseline so 1 game can't fake a strong signal.
    // shrunk = (under + K*prior) / (total + K).  K=4 = needs ~4 games to trust fully.
    const K = 4;
    const shrink = (under, total, prior) => +(((under||0) + K*prior) / ((total||0) + K)).toFixed(2);

    const result = {
      h2h: { total:h2hTotal, avgGoals:h2hAvg, u25, u35, u45,
        u25Rate: shrink(u25, h2hTotal, 0.45),
        u35Rate: shrink(u35, h2hTotal, 0.60),
        u45Rate: shrink(u45, h2hTotal, 0.75),
        last5 },
      home: { avgFor:+homeFor.toFixed(2), avgAgainst:+homeAgainst.toFixed(2),
        form:homeForm, csRate:homeCS, winRate:homeWin,
        formation:homeFm, defensive:homeDef },
      away: { avgFor:+awayFor.toFixed(2), avgAgainst:+awayAgainst.toFixed(2),
        form:awayForm, csRate:awayCS,
        formation:awayFm, defensive:awayDef },
      model: { xG:+(homeFor+awayFor).toFixed(2),
        bothDefensive:homeDef&&awayDef },
      live: liveAnalysis,
      liveStats,
      liveOdds,
      hasRealOdds: Object.keys(liveOdds).length > 0,
    };

    setCache(k, result);
    console.log(`Research ${fixtureId}: xG=${result.model.xG} H2H=${h2hTotal}g pressure=${pressure} liveXg=${liveXgTotal}`);
    return { source:'api', ...result };
}

app.get('/research', async (req, res) => {
  try {
    const { homeId, awayId, leagueId, fixtureId } = req.query;
    if (!homeId || !awayId || !leagueId || !fixtureId)
      return res.status(400).json({ error: 'homeId, awayId, leagueId, fixtureId required' });
    const result = await doResearch(homeId, awayId, leagueId, fixtureId);
    res.json(result);
  } catch(e) {
    console.error('Research error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TELEGRAM ──
// Test endpoint — visit in browser to confirm setup
app.get('/tg-test', async (req, res) => {
  const r = await sendTelegram('✅ <b>Unders Pro connected!</b>\nYou will now get alerts here when picks fire.');
  res.json({ configured: !!(TG_TOKEN && TG_CHAT), sent: r.ok, detail: r.reason || 'sent' });
});

// Notify endpoint — bot POSTs a pick, server forwards to Telegram
// Shares ONE dedup set with the auto-scanner so the same pick is never
// sent twice even if both the bot and the server scanner catch it.
const sentAlerts = new Set();
function alertKey(fixtureId, market) { return `${fixtureId}_${market}`; }
app.post('/notify', async (req, res) => {
  try {
    const p = req.body || {};
    if (!p.fixtureId || !p.market) return res.status(400).json({ error: 'missing fields' });

    // Best-of-best gate — same strict bar as the auto-scanner.
    const gate = passesTelegramGate(
      { score:p.score||0, hasEdge:p.hasEdge, h2hCount:p.h2hCount??0,
        h2hAvgGoals:(p.h2hAvgGoals===undefined?null:p.h2hAvgGoals),
        homeFor:p.homeFor??9, awayFor:p.awayFor??9 },
      { home:p.home||'', away:p.away||'' }
    );
    if (!gate) return res.json({ ok: true, skipped: 'below best-of-best bar' });

    const dedupeKey = alertKey(p.fixtureId, p.market);
    if (sentAlerts.has(dedupeKey)) return res.json({ ok: true, skipped: 'already sent' });
    sentAlerts.add(dedupeKey);
    if (sentAlerts.size > 300) sentAlerts.clear();

    const edgeLine = p.edge ? `\n📊 Edge: <b>+${p.edge}%</b> (model ${p.edgeModel}% vs bookie ${p.edgeBookie}%)` : '';
    const pressureLine = (p.pressure !== null && p.pressure !== undefined)
      ? `\n⚡ Live pressure: <b>${p.pressure}/100</b>`
      : `\n⚠️ No live stats — pre-match analysis only`;
    const kellyLine = p.kellyStake ? `\n💰 Suggested stake: <b>$${p.kellyStake}</b>` : '';

    const msg =
      `🎯 <b>UNDERS PICK — Grade ${p.grade}</b>\n\n` +
      `<b>${p.home} vs ${p.away}</b>\n` +
      `${p.league}\n` +
      `⏱ ${p.minute}' | Score ${p.homeGoals}:${p.awayGoals}\n\n` +
      `⬇ <b>${p.market}</b> @ <b>${p.odds}</b>\n` +
      (p.reason ? `💡 <b>Why:</b> ${p.reason}\n` : '') +
      `Confidence: <b>${p.score}%</b>${edgeLine}${pressureLine}${kellyLine}\n\n` +
      `<i>Always 2 goals to bust. Place manually on your bookie.</i>`;

    const r = await sendTelegram(msg);
    res.json({ ok: r.ok });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// AUTONOMOUS SCANNER
// Runs server-side during active hours, sends
// Telegram alerts hands-free. Budget-capped.
// ════════════════════════════════════════════
const SCAN = {
  enabled: (process.env.AUTO_SCAN || 'true') === 'true',
  startHour: parseInt(process.env.ACTIVE_START || '14', 10),  // CAT hours
  endHour: parseInt(process.env.ACTIVE_END || '23', 10),
  tzOffset: parseInt(process.env.TZ_OFFSET || '2', 10),       // CAT = UTC+2
  minMin: 60, maxMin: 75,
  minScore: 55, minEdge: 3, maxPressure: 55,
  minOdds: parseFloat(process.env.MIN_ODDS || '1.30'),
  maxOdds: parseFloat(process.env.MAX_ODDS || '2.50'),
  bankroll: parseFloat(process.env.BANKROLL || '100'),
  // ── TELEGRAM = BEST OF THE BEST ONLY ──
  // Phone alerts fire only for the most reliable, genuinely low-scoring setups.
  // The on-screen bot still shows everything that passes the normal filters.
  tgMinScore: parseInt(process.env.TG_MIN_SCORE || '82', 10),     // 82 = Grade A only
  tgRequireEdge: (process.env.TG_REQUIRE_EDGE || 'true') === 'true',
  tgMaxH2hAvg: parseFloat(process.env.TG_MAX_H2H_AVG || '2.3'),   // H2H must be low-scoring
  tgMaxTeamAvg: parseFloat(process.env.TG_MAX_TEAM_AVG || '1.4'), // each team low-scoring
  tgMinH2hCount: parseInt(process.env.TG_MIN_H2H || '3', 10),     // need real history
};

function catHour() {
  const utc = new Date();
  return (utc.getUTCHours() + SCAN.tzOffset) % 24;
}
function inActiveHours() {
  const h = catHour();
  return SCAN.startHour <= SCAN.endHour
    ? (h >= SCAN.startHour && h < SCAN.endHour)
    : (h >= SCAN.startHour || h < SCAN.endHour);
}

const LG = {'Serie A':7,'Ligue 1':6,'La Liga':5,'Premier League':2,'Bundesliga':-7,'Eredivisie':-6,'Botola':9,'Serie B':8,'NB II':6,'SuperLiga':3};
function lgAdj(name){for(const k in LG){if((name||'').includes(k))return LG[k];}return 0;}
function fact(n){return n<=1?1:n*fact(n-1);}

function evaluate(g, r) {
  const total = g.homeGoals + g.awayGoals;
  const tl = 90 - g.minute;
  let market, ob;
  if(total===0){market='Under 2.5';ob=1.55;}
  else if(total===1){market='Under 2.5';ob=1.65;}
  else if(total===2){market='Under 3.5';ob=1.45;}
  else if(total===3){market='Under 4.5';ob=1.28;}
  else if(total===4){market='Under 5.5';ob=1.16;}
  else if(total===5){market='Under 6.5';ob=1.10;}
  else return null;

  const realOdds = r.liveOdds?.[market] || null;
  const finalOdds = realOdds ? +realOdds.toFixed(3) : Math.max(1.05, +(ob-(1-tl/30)*0.05).toFixed(3));
  if (finalOdds < SCAN.minOdds || finalOdds > SCAN.maxOdds) return null;

  // ════════════════════════════════════════════
  // HARD VETOES — absolute blocks on high-scoring situations.
  // These fire BEFORE scoring, so no amount of other positives
  // can sneak a high-scoring matchup through.
  // ════════════════════════════════════════════
  const h2hAvgGoals = r.h2h?.avgGoals ?? null;
  const h2hCount = r.h2h?.total || 0;
  const homeFor = r.home?.avgFor ?? 1.3;
  const awayFor = r.away?.avgFor ?? 1.1;
  const combinedXG = r.model?.xG ?? 2.2;

  // 1. H2H history is high-scoring → these teams score against each other
  if (h2hCount >= 3 && h2hAvgGoals !== null && h2hAvgGoals >= 3.0) {
    console.log(`VETO ${g.home} v ${g.away}: H2H avg ${h2hAvgGoals}g too high`);
    return null;
  }
  // 2. Either team is a high-scoring side this season
  if (homeFor >= 2.0 || awayFor >= 2.0) {
    console.log(`VETO ${g.home} v ${g.away}: high-scoring team (${homeFor}/${awayFor})`);
    return null;
  }
  // 3. Combined attacking output too high
  if ((homeFor + awayFor) >= 3.2) {
    console.log(`VETO ${g.home} v ${g.away}: combined attack ${(homeFor+awayFor).toFixed(1)} too high`);
    return null;
  }
  // 4. Model expected goals too high
  if (combinedXG >= 3.0) {
    console.log(`VETO ${g.home} v ${g.away}: xG ${combinedXG} too high`);
    return null;
  }
  // 5. Thin H2H sample → require real meetings. Don't bet on a near-empty history.
  //    Exception only if we have FULL live stats (real shots/attacks) to read the
  //    game directly — events-only data is NOT enough to override thin history.
  if (h2hCount < 3 && !(r.live && r.live.available)) {
    console.log(`VETO ${g.home} v ${g.away}: only ${h2hCount} H2H meetings, no full live stats`);
    return null;
  }

  // Goals that BUST each line (floor+1). Under 4.5 busts at 5 goals.
  const lineMap={'Under 2.5':3,'Under 3.5':4,'Under 4.5':5,'Under 5.5':6,'Under 6.5':7};
  const gn = lineMap[market] - total;
  const rate = (r.model?.xG||2.2)*(tl/90);
  let mp=0; for(let k=0;k<gn;k++) mp+=(Math.pow(rate,k)*Math.exp(-rate))/fact(k);
  const h2hR = total<=1?(r.h2h?.u25Rate||.5):total<=2?(r.h2h?.u35Rate||.6):(r.h2h?.u45Rate||.72);
  const blend = mp*.55 + h2hR*.45;
  const bp = realOdds ? 1/realOdds : 1/ob;
  const rawEdge = +((blend-bp)*100).toFixed(1);
  // Sanity: a genuine edge above ~15% essentially never exists on a real market.
  // If the model claims more, it's almost certainly wrong, not gold — cap it and
  // refuse to treat it as a strong signal.
  const edge = Math.min(rawEdge, 15);
  const edgeSuspicious = rawEdge > 15;
  const hasEdge = edge >= SCAN.minEdge;
  if (realOdds && !hasEdge) return null;
  // Don't bet on an implausible edge with thin history — that's model error.
  if (edgeSuspicious && (r.h2h?.total || 0) < 4 && !(r.live && r.live.available)) {
    console.log(`VETO ${g.home} v ${g.away}: implausible +${rawEdge}% edge on thin data`);
    return null;
  }

  let score = 65;
  if(h2hR>=.75)score+=14; else if(h2hR>=.55)score+=6; else score-=12;
  const h2hAvg=r.h2h?.avgGoals||2.5;
  if(h2hAvg<=1.8)score+=11; else if(h2hAvg<=2.5)score+=4; else score-=9;
  const hf=r.home?.avgFor||1.3, af=r.away?.avgFor||1.1;
  if(hf<=1.0)score+=8; else if(hf>=1.7)score-=10;
  if(af<=0.9)score+=8; else if(af>=1.6)score-=10;
  if((r.home?.csRate||0)>=.35)score+=6;
  if((r.away?.csRate||0)>=.30)score+=5;
  const xG=r.model?.xG||2.2;
  if(xG<=1.8)score+=9; else if(xG>=2.5)score-=12; else score+=3;
  if(hasEdge)score+=11;
  if(r.model?.bothDefensive)score+=8;

  const lv=r.live;
  if(lv&&lv.available){
    // FULL live stats — strongest signal
    if(lv.pressure>=SCAN.maxPressure)score-=14;
    else if(lv.pressure>=35)score-=5;
    else score+=10;
    if(lv.liveXgTotal>0){
      if(lv.liveXgTotal < total-0.8)score+=6;
      else if(lv.liveXgTotal > total+1.0)score-=8;
    }
    if(lv.redCards>0)score+=8;
    if(lv.recentGoalCount>=2)score-=6;
  } else if(lv&&lv.pressureSource==='events'){
    // PARTIAL — events only. Lighter weight since it's less complete.
    if(lv.pressure>=50)score-=10;       // recent goals = game opening up
    else if(lv.pressure>=25)score-=4;
    else score+=4;                       // quiet on events = mild positive
    if(lv.redCards>0)score+=8;
    if(lv.recentGoalCount>=2)score-=6;
  }
  if(tl<=20)score+=6;
  if(g.homeGoals!==g.awayGoals)score+=4;
  score += lgAdj(g.leagueName);
  score = Math.max(30, Math.min(97, score));

  if(score < SCAN.minScore) return null;
  if(lv&&lv.available&&lv.pressure>=75) return null;   // hard skip only on FULL data
  // Hard skip when a game is ACTIVELY opening up — overrides strong pre-match stats.
  // 2+ second-half goals OR very high live pressure means the game is end-to-end now.
  if(lv&&lv.hasAnyLiveData&&(lv.recentGoalCount>=2||(lv.pressureSource==='events'&&lv.pressure>=60))) return null;

  const grade = score>=82?'A':score>=68?'B':'C';
  let kelly=0;
  if(hasEdge&&finalOdds>1){
    const b=finalOdds-1, p=blend, q=1-p;
    const halfKelly=SCAN.bankroll*Math.max(0,(b*p-q)/b)*0.5;
    const hardCap=SCAN.bankroll*0.05; // never more than 5% on a single bet
    kelly=+Math.min(halfKelly,hardCap).toFixed(2);
  }

  // ── PLAIN-ENGLISH REASON ──
  // Build a short one-liner from the strongest factors that made this a pick.
  const bits = [];
  if(h2hR>=.75) bits.push(`${r.h2h?.u35||'most'}/${r.h2h?.total||'10'} past meetings went under`);
  else if(h2hR>=.55) bits.push('decent under record between these teams');
  if(h2hAvg<=1.8) bits.push(`they average just ${h2hAvg} goals head-to-head`);
  if(hf<=1.0 && af<=0.9) bits.push('both teams score very little');
  else if(hf<=1.0) bits.push(`${g.home} barely scores at home`);
  else if(af<=0.9) bits.push(`${g.away} barely scores away`);
  if(xG<=1.8) bits.push(`low expected goals (${xG})`);
  if(hasEdge) bits.push(`bookie odds give +${edge}% value`);
  if(r.model?.bothDefensive) bits.push('both set up defensively');
  if(lv&&lv.available&&lv.pressure<35) bits.push('game is quiet right now');
  if(lv&&lv.redCards>0) bits.push('a red card should slow the game');
  if(tl<=20) bits.push(`only ${tl} mins left`);
  if(lgAdj(g.leagueName)>=7) bits.push('low-scoring league');

  // Take the 3 strongest, make a sentence
  let reason;
  if(bits.length){
    reason = bits.slice(0,3).join(', ');
    reason = reason.charAt(0).toUpperCase() + reason.slice(1) + '.';
  } else {
    reason = `Scoreline gives a 2-goal safety buffer with ${tl} mins left.`;
  }

  return { market, odds:finalOdds, score, grade, edge, hasEdge,
    edgeModel:(blend*100).toFixed(0), edgeBookie:(bp*100).toFixed(0),
    pressure: (lv && lv.hasAnyLiveData) ? lv.pressure : null,
    pressureSource: lv ? lv.pressureSource : 'none',
    reason,
    // Numbers the Telegram best-of-best gate inspects:
    h2hAvgGoals, h2hCount, homeFor, awayFor, combinedXG,
    kellyStake:kelly };
}

// Best-of-best gate — decides if a pick is reliable enough for a phone alert.
// Far stricter than the on-screen bot: Grade A, low-scoring H2H, low-scoring
// teams, real edge, and enough history to trust.
function passesTelegramGate(ev, g) {
  const tag = `${g.home} v ${g.away}`;
  if (ev.score < SCAN.tgMinScore) { console.log(`TG-SKIP ${tag}: score ${ev.score} < ${SCAN.tgMinScore} (not Grade A)`); return false; }
  if (SCAN.tgRequireEdge && !ev.hasEdge) { console.log(`TG-SKIP ${tag}: no real edge`); return false; }
  if (ev.h2hCount < SCAN.tgMinH2hCount) { console.log(`TG-SKIP ${tag}: only ${ev.h2hCount} H2H meetings`); return false; }
  if (ev.h2hAvgGoals !== null && ev.h2hAvgGoals > SCAN.tgMaxH2hAvg) { console.log(`TG-SKIP ${tag}: H2H avg ${ev.h2hAvgGoals} too high`); return false; }
  if (ev.homeFor > SCAN.tgMaxTeamAvg || ev.awayFor > SCAN.tgMaxTeamAvg) { console.log(`TG-SKIP ${tag}: team scoring ${ev.homeFor}/${ev.awayFor} too high`); return false; }
  return true;
}

async function autoScan() {
  if (!SCAN.enabled) return;
  if (!inActiveHours()) return;
  if (budgetLeft() < 100) { console.log('Budget nearly exhausted, skipping scan'); return; }

  try {
    const live = await call('/fixtures?live=all');
    const inWindow = live.filter(f => {
      const m = f.fixture?.status?.elapsed || 0;
      const s = f.fixture?.status?.short || '';
      return ['1H','2H','ET','BT','P','INT'].includes(s) && m >= SCAN.minMin && m <= SCAN.maxMin;
    });

    if (inWindow.length) console.log(`AutoScan: ${inWindow.length} in window | budget left: ${budgetLeft()}`);

    for (const f of inWindow) {
      if (budgetLeft() < 50) break;  // hard stop near budget limit
      const g = {
        id: f.fixture.id,
        home: f.teams.home.name, away: f.teams.away.name,
        homeGoals: f.goals?.home ?? 0, awayGoals: f.goals?.away ?? 0,
        minute: f.fixture.status.elapsed || 0,
        leagueName: f.league?.name || '',
        league: `${f.league?.name||''} ${f.league?.country||''}`,
      };

      const r = await doResearch(f.teams.home.id, f.teams.away.id, f.league.id, f.fixture.id);
      const ev = evaluate(g, r);
      if (!ev) continue;

      // ── BEST-OF-BEST GATE (Telegram only) ──
      // Only the most reliable, genuinely low-scoring setups reach your phone.
      if (!passesTelegramGate(ev, g)) continue;

      // Shared dedup with /notify — won't double-send if bot already alerted
      const dedupe = alertKey(g.id, ev.market);
      if (sentAlerts.has(dedupe)) continue;
      sentAlerts.add(dedupe);
      if (sentAlerts.size > 300) sentAlerts.clear();

      const edgeLine = ev.edge ? `\n📊 Edge: <b>+${ev.edge}%</b>` : '';
      const pressLine = ev.pressureSource === 'full'
        ? `\n⚡ Live pressure: <b>${ev.pressure}/100</b>`
        : ev.pressureSource === 'events'
        ? `\n⚡ Live pressure: <b>${ev.pressure}/100</b> (events only — no full stats)`
        : `\n⚠️ No live data — pre-match analysis only`;
      const kellyLine = ev.kellyStake ? `\n💰 Stake: <b>$${ev.kellyStake}</b>` : '';
      await sendTelegram(
        `🎯 <b>AUTO PICK — Grade ${ev.grade}</b>\n\n` +
        `<b>${g.home} vs ${g.away}</b>\n${g.league}\n` +
        `⏱ ${g.minute}' | Score ${g.homeGoals}:${g.awayGoals}\n\n` +
        `⬇ <b>${ev.market}</b> @ <b>${ev.odds}</b>\n` +
        `💡 <b>Why:</b> ${ev.reason}\n` +
        `Confidence: <b>${ev.score}%</b>${edgeLine}${pressLine}${kellyLine}\n\n` +
        `<i>Always 2 goals to bust. Place manually.</i>`
      );
      console.log(`AUTO ALERT: ${g.home} vs ${g.away} | ${ev.market} @ ${ev.odds} | ${ev.score}%`);
    }
  } catch(e) {
    console.error('AutoScan error:', e.message);
  }
}

// Status endpoint — check scanner state and budget
app.get('/status', (req, res) => {
  res.json({
    autoScan: SCAN.enabled,
    activeNow: inActiveHours(),
    catHour: catHour(),
    activeHours: `${SCAN.startHour}:00–${SCAN.endHour}:00 CAT`,
    callsToday,
    budgetLeft: budgetLeft(),
    dailyBudget: DAILY_BUDGET,
  });
});

app.listen(PORT, () => {
  console.log(`✅ Unders Pro Server on port ${PORT}`);
  console.log(`🔑 Key: ${API_KEY ? API_KEY.slice(0,8)+'...' : 'NOT SET'}`);
  console.log(`📲 Telegram: ${TG_TOKEN && TG_CHAT ? 'configured' : 'not set'}`);
  console.log(`🤖 Auto-scan: ${SCAN.enabled ? `ON (${SCAN.startHour}-${SCAN.endHour} CAT, budget ${DAILY_BUDGET})` : 'OFF'}`);

  // Adaptive scan loop: every 60s in active hours, checks budget itself
  if (SCAN.enabled) {
    setInterval(autoScan, 60000);
    // Keep-alive ping to stop Render free tier sleeping during active hours
    setInterval(() => {
      if (inActiveHours()) console.log(`Heartbeat | CAT ${catHour()}:00 | budget ${budgetLeft()}`);
    }, 5 * 60000);
  }
});
