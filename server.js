const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
 
const app = express();
const PORT = process.env.PORT || 3000;
const BSD_KEY = process.env.API_KEY || '';
const BSD_BASE = 'https://sports.bzzoiro.com/api/v2';
 
app.use(cors());
app.use(express.json());
 
// ── Cache ──────────────────────────────────────
const cache = new Map();
function getCached(key, ttl) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > ttl * 1000) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }
 
// ── BSD API helper ──────────────────────────────
async function bsd(path) {
  const res = await fetch(`${BSD_BASE}${path}`, {
    headers: { 'Authorization': `Token ${BSD_KEY}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`BSD ${res.status}: ${res.statusText} — ${path}`);
  return res.json();
}
 
// ── Health ──────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  message: 'Unders Pro Server — powered by BSD (Bzzoiro Sports Data)',
  api: 'No rate limits, no bans, completely free',
}));
 
// ── LIVE EVENTS ─────────────────────────────────
// BSD live endpoint: /api/v2/events/live/
// Returns all games currently in their live window
// Cache: 45 seconds
app.get('/live', async (req, res) => {
  try {
    const cached = getCached('live', 45);
    if (cached) return res.json({ source: 'cache', data: cached });
 
    const data = await bsd('/events/live/');
    const events = data.events || [];
 
    // Map BSD format to our bot's expected format
    const mapped = events
      .filter(e => e.status === 'inprogress')
      .map(e => ({
        fixture: {
          id: e.id,
          status: {
            short: e.period === '1st_half' ? '1H' :
                   e.period === '2nd_half' ? '2H' :
                   e.period === 'halftime' ? 'HT' :
                   e.period === 'extra_time' ? 'ET' : '2H',
            elapsed: e.current_minute || 0,
          },
        },
        league: { id: e.league_id, name: e.league_name, country: '' },
        teams: {
          home: { id: e.home_team_id, name: e.home_team },
          away: { id: e.away_team_id, name: e.away_team },
        },
        goals: { home: e.home_score ?? 0, away: e.away_score ?? 0 },
        // Keep BSD fields for research
        _bsd: e,
      }));
 
    setCache('live', mapped);
    res.json({ source: 'api', data: mapped });
  } catch(e) {
    console.error('Live error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// ── UPCOMING / TODAY ────────────────────────────
// BSD: /api/v2/events/?status=notstarted&date_from=today&date_to=today
// Cache: 10 minutes
app.get('/upcoming', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const cacheKey = `upcoming_${today}`;
    const cached = getCached(cacheKey, 600);
    if (cached) return res.json({ source: 'cache', data: cached });
 
    const data = await bsd(`/events/?status=notstarted&date_from=${today}&date_to=${today}&limit=200`);
    const events = data.results || [];
 
    const mapped = events.map(e => ({
      fixture: {
        id: e.id,
        date: e.event_date,
        status: { short: 'NS', elapsed: 0 },
      },
      league: { id: e.league_id, name: e.league_name, country: '' },
      teams: {
        home: { id: e.home_team_id, name: e.home_team },
        away: { id: e.away_team_id, name: e.away_team },
      },
      goals: { home: null, away: null },
    }));
 
    setCache(cacheKey, mapped);
    res.json({ source: 'api', data: mapped });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
 
// ── FULL RESEARCH ───────────────────────────────
// Single endpoint — fetches everything in parallel:
// H2H via team fixtures, team stats via standings,
// lineups, injuries, ML prediction, live odds
// Cache: 10 minutes per fixture
app.get('/research', async (req, res) => {
  try {
    const { homeId, awayId, leagueId, fixtureId } = req.query;
    if (!homeId || !awayId || !fixtureId) {
      return res.status(400).json({ error: 'homeId, awayId, fixtureId required' });
    }
 
    const cacheKey = `research_${fixtureId}`;
    const cached = getCached(cacheKey, 600);
    if (cached) return res.json({ source: 'cache', ...cached });
 
    // Fetch everything in parallel — BSD has no rate limits
    const [
      homeFixtures,
      awayFixtures,
      lineupData,
      oddsData,
      predictionData,
    ] = await Promise.allSettled([
      // Last 10 home team matches for form analysis
      bsd(`/teams/${homeId}/fixtures/?status=finished&limit=10`),
      // Last 10 away team matches for form analysis
      bsd(`/teams/${awayId}/fixtures/?status=finished&limit=10`),
      // Confirmed or predicted lineups + injuries
      bsd(`/events/${fixtureId}/lineups/`),
      // Consensus odds from 15+ bookmakers
      bsd(`/events/${fixtureId}/odds/`),
      // ML prediction (CatBoost xG model)
      bsd(`/events/${fixtureId}/prediction/`),
    ]);
 
    // ── H2H: find matches where both teams played ──
    const homeFix = homeFixtures.status === 'fulfilled' ? homeFixtures.value : { results: [] };
    const awayFix = awayFixtures.status === 'fulfilled' ? awayFixtures.value : { results: [] };
 
    const homeMatches = homeFix.results || homeFix.fixtures || [];
    const awayMatches = awayFix.results || awayFix.fixtures || [];
 
    // Find H2H: matches where both teams appeared
    const awayTeamId = parseInt(awayId);
    const homeTeamId = parseInt(homeId);
 
    const h2hMatches = homeMatches.filter(m =>
      m.home_team_id === awayTeamId || m.away_team_id === awayTeamId
    ).slice(0, 8);
 
    const h2hTotal = h2hMatches.length;
    const h2hGoals = h2hMatches.map(m => (m.home_score || 0) + (m.away_score || 0));
    const h2hAvgGoals = h2hTotal ? +(h2hGoals.reduce((a,b)=>a+b,0)/h2hTotal).toFixed(2) : 2.4;
    const h2hUnder25 = h2hMatches.filter(m => (m.home_score||0)+(m.away_score||0) < 2.5).length;
    const h2hUnder35 = h2hMatches.filter(m => (m.home_score||0)+(m.away_score||0) < 3.5).length;
    const h2hUnder45 = h2hMatches.filter(m => (m.home_score||0)+(m.away_score||0) < 4.5).length;
 
    const last5H2H = h2hMatches.slice(0,5).map(m => ({
      home: m.home_team || '', away: m.away_team || '',
      score: `${m.home_score||0}:${m.away_score||0}`,
      total: (m.home_score||0)+(m.away_score||0),
      date: (m.event_date||'').split('T')[0],
    }));
 
    // ── HOME TEAM FORM (last 10 matches) ──
    // Calculate avg goals scored/conceded at home
    const homeHomeMatches = homeMatches.filter(m => m.home_team_id === homeTeamId);
    const homeAwayMatches = homeMatches.filter(m => m.away_team_id === homeTeamId);
 
    const homeFor = homeHomeMatches.length
      ? +(homeHomeMatches.reduce((s,m) => s+(m.home_score||0), 0) / homeHomeMatches.length).toFixed(2)
      : 1.3;
    const homeAgainst = homeHomeMatches.length
      ? +(homeHomeMatches.reduce((s,m) => s+(m.away_score||0), 0) / homeHomeMatches.length).toFixed(2)
      : 1.2;
 
    // Form string from last 5 matches
    const allHomeMatches = [...homeHomeMatches, ...homeAwayMatches]
      .sort((a,b) => new Date(b.event_date||0) - new Date(a.event_date||0))
      .slice(0,5);
    const homeLast5 = allHomeMatches.map(m => {
      const isHome = m.home_team_id === homeTeamId;
      const scored = isHome ? (m.home_score||0) : (m.away_score||0);
      const conceded = isHome ? (m.away_score||0) : (m.home_score||0);
      return scored > conceded ? 'W' : scored < conceded ? 'L' : 'D';
    }).join('') || 'DDDDD';
 
    // Clean sheet rate
    const homeCleanSheets = homeHomeMatches.filter(m => (m.away_score||0) === 0).length;
    const homeCleanSheetRate = homeHomeMatches.length
      ? +(homeCleanSheets/homeHomeMatches.length).toFixed(2) : 0.25;
 
    // ── AWAY TEAM FORM (last 10 matches) ──
    const awayHomeMatches = awayMatches.filter(m => m.home_team_id === awayTeamId);
    const awayAwayMatches = awayMatches.filter(m => m.away_team_id === awayTeamId);
 
    const awayFor = awayAwayMatches.length
      ? +(awayAwayMatches.reduce((s,m) => s+(m.away_score||0), 0) / awayAwayMatches.length).toFixed(2)
      : 1.1;
    const awayAgainst = awayAwayMatches.length
      ? +(awayAwayMatches.reduce((s,m) => s+(m.home_score||0), 0) / awayAwayMatches.length).toFixed(2)
      : 1.3;
 
    const allAwayMatches = [...awayHomeMatches, ...awayAwayMatches]
      .sort((a,b) => new Date(b.event_date||0) - new Date(a.event_date||0))
      .slice(0,5);
    const awayLast5 = allAwayMatches.map(m => {
      const isHome = m.home_team_id === awayTeamId;
      const scored = isHome ? (m.home_score||0) : (m.away_score||0);
      const conceded = isHome ? (m.away_score||0) : (m.home_score||0);
      return scored > conceded ? 'W' : scored < conceded ? 'L' : 'D';
    }).join('') || 'DDDDD';
 
    const awayCleanSheets = awayAwayMatches.filter(m => (m.home_score||0) === 0).length;
    const awayCleanSheetRate = awayAwayMatches.length
      ? +(awayCleanSheets/awayAwayMatches.length).toFixed(2) : 0.20;
 
    // ── ML PREDICTION (xG) ──
    const pred = predictionData.status === 'fulfilled' ? predictionData.value : null;
    const xGHome = pred?.markets?.expected_goals?.home || homeFor;
    const xGAway = pred?.markets?.expected_goals?.away || awayFor;
    const xG = +(xGHome + xGAway).toFixed(2);
    const mlUnderProb = pred ? {
      under15: 100 - (pred.markets?.over_under?.prob_over_15 || 50),
      under25: 100 - (pred.markets?.over_under?.prob_over_25 || 40),
      under35: 100 - (pred.markets?.over_under?.prob_over_35 || 30),
    } : null;
    const mlConfidence = pred?.model?.confidence || null;
 
    // ── LINEUPS ──
    const lineup = lineupData.status === 'fulfilled' ? lineupData.value : null;
    const lineupStatus = lineup?.lineup_status || 'unavailable';
    const homeFormation = lineup?.lineups?.home?.formation || null;
    const awayFormation = lineup?.lineups?.away?.formation || null;
    const defensiveForms = ['4-5-1','5-4-1','5-3-2','4-4-2','3-5-2','4-1-4-1','4-1-3-2'];
    const homeDefensive = homeFormation ? defensiveForms.some(f => homeFormation === f) : false;
    const awayDefensive = awayFormation ? defensiveForms.some(f => awayFormation === f) : false;
 
    // Injured/suspended players
    const homeUnavailable = lineup?.unavailable_players?.home || [];
    const awayUnavailable = lineup?.unavailable_players?.away || [];
 
    // ── LIVE ODDS (BSD consensus from 15+ bookmakers) ──
    const odds = oddsData.status === 'fulfilled' ? oddsData.value : null;
    const liveOdds = {};
    if (odds?.odds) {
      // BSD returns odds directly in the response
      if (odds.odds.under_25_goals) liveOdds['Under 2.5'] = odds.odds.under_25_goals;
      if (odds.odds.under_35_goals) liveOdds['Under 3.5'] = odds.odds.under_35_goals;
      // Under 4.5 and 5.5 not in BSD consensus — use ml model to estimate
    }
 
    const result = {
      fixtureId,
      h2h: {
        total: h2hTotal,
        avgGoals: h2hAvgGoals,
        under25: h2hUnder25,
        under35: h2hUnder35,
        under45: h2hUnder45,
        under25Rate: h2hTotal ? +(h2hUnder25/h2hTotal).toFixed(2) : 0.45,
        under35Rate: h2hTotal ? +(h2hUnder35/h2hTotal).toFixed(2) : 0.60,
        under45Rate: h2hTotal ? +(h2hUnder45/h2hTotal).toFixed(2) : 0.75,
        last5: last5H2H,
      },
      home: {
        avgFor: homeFor,
        avgAgainst: homeAgainst,
        cleanSheetRate: homeCleanSheetRate,
        last5: homeLast5,
        formation: homeFormation,
        defensive: homeDefensive,
        unavailable: homeUnavailable.map(p => ({ name: p.name, status: p.status, reason: p.reason })),
      },
      away: {
        avgFor: awayFor,
        avgAgainst: awayAgainst,
        cleanSheetRate: awayCleanSheetRate,
        last5: awayLast5,
        formation: awayFormation,
        defensive: awayDefensive,
        unavailable: awayUnavailable.map(p => ({ name: p.name, status: p.status, reason: p.reason })),
      },
      model: {
        xG,
        xGHome: +xGHome.toFixed(2),
        xGAway: +xGAway.toFixed(2),
        defensiveXG: +((homeAgainst + awayAgainst) / 2).toFixed(2),
        bothDefensive: homeDefensive && awayDefensive,
        mlUnderProb,
        mlConfidence,
      },
      lineup: {
        status: lineupStatus,
        homeFormation,
        awayFormation,
      },
      liveOdds,
      hasRealOdds: Object.keys(liveOdds).length > 0,
    };
 
    setCache(cacheKey, result);
    console.log(`Research for fixture ${fixtureId}: xG=${xG} H2H=${h2hTotal}games avg=${h2hAvgGoals}g`);
    res.json({ source: 'api', ...result });
 
  } catch(e) {
    console.error('Research error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
// ── ODDS (detailed multi-bookmaker) ─────────────
app.get('/odds', async (req, res) => {
  try {
    const { fixture } = req.query;
    if (!fixture) return res.status(400).json({ error: 'fixture required' });
    const cacheKey = `odds_${fixture}`;
    const cached = getCached(cacheKey, 30);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await bsd(`/events/${fixture}/odds/`);
    setCache(cacheKey, data);
    res.json({ source: 'api', data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
// ── LINEUPS ─────────────────────────────────────
app.get('/lineups', async (req, res) => {
  try {
    const { fixture } = req.query;
    if (!fixture) return res.status(400).json({ error: 'fixture required' });
    const cacheKey = `lineups_${fixture}`;
    const cached = getCached(cacheKey, 600);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await bsd(`/events/${fixture}/lineups/`);
    setCache(cacheKey, data);
    res.json({ source: 'api', data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
// ── PREDICTION ──────────────────────────────────
app.get('/prediction', async (req, res) => {
  try {
    const { fixture } = req.query;
    if (!fixture) return res.status(400).json({ error: 'fixture required' });
    const cacheKey = `pred_${fixture}`;
    const cached = getCached(cacheKey, 300);
    if (cached) return res.json({ source: 'cache', data: cached });
    const data = await bsd(`/events/${fixture}/prediction/`);
    setCache(cacheKey, data);
    res.json({ source: 'api', data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
// ── QUOTA STATUS ─────────────────────────────────
app.get('/quota', (req, res) => {
  res.json({
    api: 'BSD (Bzzoiro Sports Data)',
    rateLimit: 'None — completely unlimited',
    cost: 'Free forever',
    note: 'No bans, no suspensions, no request caps',
  });
});
 
app.listen(PORT, () => {
  console.log(`✅ Unders Pro Server running on port ${PORT}`);
  console.log(`📡 Using BSD API — no rate limits, no bans, completely free`);
  console.log(`🔑 BSD Key: ${BSD_KEY ? BSD_KEY.slice(0,8)+'...' : 'NOT SET — add API_KEY env var'}`);
});
 
