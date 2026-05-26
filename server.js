const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'ec9a38adc2d89cdf3b9a699a346b9ee6';
const API_HOST = 'v3.football.api-sports.io';

// ── CORS — allow all origins so your iPhone can call this ──
app.use(cors());
app.use(express.json());

// ── In-memory cache to protect API quota ──
const cache = new Map();

function getCached(key, ttlSeconds) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlSeconds * 1000) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ── API-Football proxy helper ──
async function apiFetch(endpoint) {
  const url = `https://${API_HOST}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'x-apisports-key': API_KEY,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(JSON.stringify(data.errors));
  }
  return data.response || [];
}

// ────────────────────────────────────────────────
// ROUTES
// ────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Unders Pro Server running' });
});

// GET /live — all live fixtures right now
// Cache: 45 seconds (live data changes fast)
app.get('/live', async (req, res) => {
  try {
    const cached = getCached('live', 45);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await apiFetch('/fixtures?live=all');
    setCache('live', data);
    res.json({ source: 'api', data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /upcoming — today's not-started fixtures
// Cache: 10 minutes
app.get('/upcoming', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const cacheKey = `upcoming_${today}`;
    const cached = getCached(cacheKey, 600);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await apiFetch(`/fixtures?date=${today}&status=NS`);
    setCache(cacheKey, data);
    res.json({ source: 'api', data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /prematch — today's fixtures for pre-match scanning
// Cache: 15 minutes
app.get('/prematch', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const cacheKey = `prematch_${today}`;
    const cached = getCached(cacheKey, 900);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await apiFetch(`/fixtures?date=${today}`);
    setCache(cacheKey, data);
    res.json({ source: 'api', data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /h2h?home=ID&away=ID — head to head stats
// Cache: 24 hours (H2H doesn't change mid-match)
app.get('/h2h', async (req, res) => {
  try {
    const { home, away } = req.query;
    if (!home || !away) return res.status(400).json({ error: 'home and away required' });
    const cacheKey = `h2h_${home}_${away}`;
    const cached = getCached(cacheKey, 86400);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await apiFetch(`/fixtures/headtohead?h2h=${home}-${away}&last=10`);
    setCache(cacheKey, data);
    res.json({ source: 'api', data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /teamstats?team=ID&league=ID&season=YEAR — team season stats
// Cache: 6 hours
app.get('/teamstats', async (req, res) => {
  try {
    const { team, league, season } = req.query;
    if (!team || !league) return res.status(400).json({ error: 'team and league required' });
    const yr = season || new Date().getFullYear();
    const cacheKey = `teamstats_${team}_${league}_${yr}`;
    const cached = getCached(cacheKey, 21600);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await apiFetch(`/teams/statistics?team=${team}&league=${league}&season=${yr}`);
    setCache(cacheKey, data);
    res.json({ source: 'api', data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /odds?fixture=ID — live in-play odds
// Cache: 30 seconds
app.get('/odds', async (req, res) => {
  try {
    const { fixture } = req.query;
    if (!fixture) return res.status(400).json({ error: 'fixture required' });
    const cacheKey = `odds_${fixture}`;
    const cached = getCached(cacheKey, 30);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await apiFetch(`/odds/live?fixture=${fixture}&bet=5`);
    setCache(cacheKey, data);
    res.json({ source: 'api', data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /multiodds?fixture=ID — pre-match odds from multiple bookmakers
// Cache: 5 minutes
app.get('/multiodds', async (req, res) => {
  try {
    const { fixture } = req.query;
    if (!fixture) return res.status(400).json({ error: 'fixture required' });
    const cacheKey = `multiodds_${fixture}`;
    const cached = getCached(cacheKey, 300);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await apiFetch(`/odds?fixture=${fixture}&bet=5`);
    setCache(cacheKey, data);
    res.json({ source: 'api', data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /lineups?fixture=ID — starting lineups and formations
// Cache: 10 minutes
app.get('/lineups', async (req, res) => {
  try {
    const { fixture } = req.query;
    if (!fixture) return res.status(400).json({ error: 'fixture required' });
    const cacheKey = `lineups_${fixture}`;
    const cached = getCached(cacheKey, 600);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await apiFetch(`/fixtures/lineups?fixture=${fixture}`);
    setCache(cacheKey, data);
    res.json({ source: 'api', data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /injuries?team=ID&fixture=ID — player injuries
// Cache: 1 hour
app.get('/injuries', async (req, res) => {
  try {
    const { team, fixture } = req.query;
    if (!team) return res.status(400).json({ error: 'team required' });
    const cacheKey = `injuries_${team}_${fixture||''}`;
    const cached = getCached(cacheKey, 3600);
    if (cached) return res.json({ source: 'cache', data: cached });
    const endpoint = fixture
      ? `/injuries?team=${team}&fixture=${fixture}`
      : `/injuries?team=${team}`;
    const data = await apiFetch(endpoint);
    setCache(cacheKey, data);
    res.json({ source: 'api', data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /research?homeId=&awayId=&leagueId=&fixtureId=
// Combined endpoint — fetches everything in parallel, returns full research object
// This is the main endpoint the bot uses — one call instead of 6
// Cache: 10 minutes per fixture
app.get('/research', async (req, res) => {
  try {
    const { homeId, awayId, leagueId, fixtureId } = req.query;
    if (!homeId || !awayId || !leagueId || !fixtureId) {
      return res.status(400).json({ error: 'homeId, awayId, leagueId, fixtureId all required' });
    }

    const cacheKey = `research_${fixtureId}`;
    const cached = getCached(cacheKey, 600);
    if (cached) return res.json({ source: 'cache', ...cached });

    const season = new Date().getFullYear();

    // Fetch everything in parallel — server has no CORS, no browser limits
    const [h2h, homeStats, awayStats, lineups, odds] = await Promise.allSettled([
      apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`),
      apiFetch(`/teams/statistics?team=${homeId}&league=${leagueId}&season=${season}`),
      apiFetch(`/teams/statistics?team=${awayId}&league=${leagueId}&season=${season}`),
      apiFetch(`/fixtures/lineups?fixture=${fixtureId}`),
      apiFetch(`/odds/live?fixture=${fixtureId}&bet=5`),
    ]);

    // ── Process H2H ──
    const h2hData = h2h.status === 'fulfilled' ? h2h.value : [];
    const h2hGames = h2hData.slice(0, 10);
    const h2hTotal = h2hGames.length;
    const h2hGoalsArr = h2hGames.map(f => (f.goals?.home || 0) + (f.goals?.away || 0));
    const h2hAvgGoals = h2hTotal ? +(h2hGoalsArr.reduce((a,b)=>a+b,0)/h2hTotal).toFixed(2) : 2.5;

    // Count under results for each line
    const h2hUnder25 = h2hGames.filter(f => (f.goals?.home||0)+(f.goals?.away||0) < 2.5).length;
    const h2hUnder35 = h2hGames.filter(f => (f.goals?.home||0)+(f.goals?.away||0) < 3.5).length;
    const h2hUnder45 = h2hGames.filter(f => (f.goals?.home||0)+(f.goals?.away||0) < 4.5).length;

    // Last 5 H2H scores
    const last5H2H = h2hGames.slice(0,5).map(f => ({
      home: f.teams?.home?.name,
      away: f.teams?.away?.name,
      score: `${f.goals?.home||0}:${f.goals?.away||0}`,
      total: (f.goals?.home||0)+(f.goals?.away||0),
      date: f.fixture?.date?.split('T')[0],
    }));

    // ── Process Home Team Stats ──
    const hSt = homeStats.status === 'fulfilled' ? homeStats.value[0] : null;
    const homeFor     = parseFloat(hSt?.goals?.for?.average?.home || 1.4);
    const homeAgainst = parseFloat(hSt?.goals?.against?.average?.home || 1.3);
    const homeWinRate = hSt ? (hSt.fixtures?.wins?.home || 0) / Math.max(hSt.fixtures?.played?.home || 1, 1) : 0.4;
    const homeCleanSheets = hSt?.clean_sheet?.home || 0;
    const homeGamesPlayed = hSt?.fixtures?.played?.home || 1;
    const homeCleanSheetRate = +(homeCleanSheets / homeGamesPlayed).toFixed(2);
    // Last 5 home form
    const homeLast5 = hSt?.form ? hSt.form.slice(-5) : 'DDDDD';

    // ── Process Away Team Stats ──
    const aSt = awayStats.status === 'fulfilled' ? awayStats.value[0] : null;
    const awayFor     = parseFloat(aSt?.goals?.for?.average?.away || 1.2);
    const awayAgainst = parseFloat(aSt?.goals?.against?.average?.away || 1.3);
    const awayWinRate = aSt ? (aSt.fixtures?.wins?.away || 0) / Math.max(aSt.fixtures?.played?.away || 1, 1) : 0.3;
    const awayCleanSheets = aSt?.clean_sheet?.away || 0;
    const awayGamesPlayed = aSt?.fixtures?.played?.away || 1;
    const awayCleanSheetRate = +(awayCleanSheets / awayGamesPlayed).toFixed(2);
    const awayLast5 = aSt?.form ? aSt.form.slice(-5) : 'DDDDD';

    // Expected goals model
    const xG = +(homeFor + awayFor).toFixed(2);
    const defensiveXG = +((homeAgainst + awayAgainst) / 2).toFixed(2);

    // ── Process Lineups ──
    const lineupData = lineups.status === 'fulfilled' ? lineups.value : [];
    const homeLineup = lineupData[0] || null;
    const awayLineup = lineupData[1] || null;
    const homeFormation = homeLineup?.formation || null;
    const awayFormation = awayLineup?.formation || null;
    const defensiveForms = ['4-5-1','5-4-1','5-3-2','4-4-2','3-5-2','4-1-4-1'];
    const homeDefensive = homeFormation ? defensiveForms.some(f => homeFormation === f) : false;
    const awayDefensive = awayFormation ? defensiveForms.some(f => awayFormation === f) : false;

    // ── Process Live Odds ──
    const oddsData = odds.status === 'fulfilled' ? odds.value : [];
    const liveOdds = {};
    for (const bk of (oddsData[0]?.odds || [])) {
      for (const bet of (bk.bets || [])) {
        if (bet.id === 5 || (bet.name||'').toLowerCase().includes('over/under')) {
          for (const v of (bet.values || [])) {
            const lbl = (v.value||'').toLowerCase();
            ['under 2.5','under 3.5','under 4.5','under 5.5','under 6.5'].forEach(u => {
              if (lbl === u) liveOdds[u.charAt(0).toUpperCase()+u.slice(1)] = parseFloat(v.odd);
            });
          }
        }
      }
    }

    const result = {
      fixtureId,
      h2h: {
        total: h2hTotal,
        avgGoals: h2hAvgGoals,
        under25: h2hUnder25,
        under35: h2hUnder35,
        under45: h2hUnder45,
        under25Rate: h2hTotal ? +(h2hUnder25/h2hTotal).toFixed(2) : 0.5,
        under35Rate: h2hTotal ? +(h2hUnder35/h2hTotal).toFixed(2) : 0.5,
        under45Rate: h2hTotal ? +(h2hUnder45/h2hTotal).toFixed(2) : 0.5,
        last5: last5H2H,
      },
      home: {
        avgFor: +homeFor.toFixed(2),
        avgAgainst: +homeAgainst.toFixed(2),
        winRate: +homeWinRate.toFixed(2),
        cleanSheetRate: homeCleanSheetRate,
        last5: homeLast5,
        formation: homeFormation,
        defensive: homeDefensive,
      },
      away: {
        avgFor: +awayFor.toFixed(2),
        avgAgainst: +awayAgainst.toFixed(2),
        winRate: +awayWinRate.toFixed(2),
        cleanSheetRate: awayCleanSheetRate,
        last5: awayLast5,
        formation: awayFormation,
        defensive: awayDefensive,
      },
      model: {
        xG,
        defensiveXG,
        bothDefensive: homeDefensive && awayDefensive,
      },
      liveOdds,
      hasRealOdds: Object.keys(liveOdds).length > 0,
    };

    setCache(cacheKey, result);
    res.json({ source: 'api', ...result });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /quota — check remaining API calls
app.get('/quota', async (req, res) => {
  try {
    const data = await apiFetch('/status');
    res.json({ data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Unders Pro Server running on port ${PORT}`);
  console.log(`📡 API Key: ${API_KEY.slice(0,8)}...`);
  console.log(`🌐 CORS: enabled for all origins`);
});
