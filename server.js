const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const HOST = 'v3.football.api-sports.io';

app.use(cors());
app.use(express.json());

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

app.get('/research', async (req, res) => {
  try {
    const { homeId, awayId, leagueId, fixtureId } = req.query;
    if (!homeId || !awayId || !leagueId || !fixtureId)
      return res.status(400).json({ error: 'homeId, awayId, leagueId, fixtureId required' });

    const k = `r_${fixtureId}`;
    const cached = getCached(k, 90);  // 90s — live stats change fast
    if (cached) return res.json({ source: 'cache', ...cached });

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
      available: !!(hStat && aStat),
    };

    // ── LIVE EVENTS — red cards, recent goals ──
    const events = eventsRaw || [];
    const goals = events.filter(e => e.type === 'Goal');
    const redCards = events.filter(e => e.type === 'Card' && (e.detail||'').includes('Red'));
    const recentGoals = goals.filter(e => (e.time?.elapsed||0) >= 45); // 2nd half goals
    const lastGoalMin = goals.length ? Math.max(...goals.map(e => e.time?.elapsed||0)) : 0;

    // ── PRESSURE / MOMENTUM SCORE ──
    // Combines live attacking threat into one number (0-100)
    // High pressure = next goal likely = BAD for under
    const totalShotsOnGoal = liveStats.home.shotsOnGoal + liveStats.away.shotsOnGoal;
    const totalDangerAttacks = liveStats.home.dangerAttacks + liveStats.away.dangerAttacks;
    const totalShots = liveStats.home.shotsTotal + liveStats.away.shotsTotal;
    const liveXgTotal = +(liveStats.home.xg + liveStats.away.xg).toFixed(2);

    // Pressure index — higher means more goal threat right now
    let pressure = 0;
    if (liveStats.available) {
      pressure = Math.min(100, Math.round(
        (totalShotsOnGoal * 6) +
        (totalDangerAttacks * 0.4) +
        (totalShots * 1.5) +
        (recentGoals.length * 8)
      ));
    }

    const liveAnalysis = {
      available: liveStats.available,
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

    const result = {
      h2h: { total:h2hTotal, avgGoals:h2hAvg, u25, u35, u45,
        u25Rate:h2hTotal?+(u25/h2hTotal).toFixed(2):0.45,
        u35Rate:h2hTotal?+(u35/h2hTotal).toFixed(2):0.60,
        u45Rate:h2hTotal?+(u45/h2hTotal).toFixed(2):0.75,
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
    res.json({ source:'api', ...result });
  } catch(e) {
    console.error('Research error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Unders Pro Server on port ${PORT}`);
  console.log(`🔑 Key: ${API_KEY ? API_KEY.slice(0,8)+'...' : 'NOT SET — add API_KEY env var'}`);
});
