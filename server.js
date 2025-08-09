const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

app.use(cors());

let browser;
let mainPage; // Persistent page for all requests
const CONCURRENT_LIMIT = 3;
const CACHE_DURATION = 30000;
let cachedLiveData = null;
let cachedScheduledData = null;
let lastLiveFetch = 0;
let lastScheduledFetch = 0;

// Launch browser
async function createBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ],
    });
  }
  return browser;
}

// Create and reuse one page with cookies/session
async function getMainPage() {
  if (mainPage) return mainPage;

  const b = await createBrowser();
  mainPage = await b.newPage();

  await mainPage.setDefaultTimeout(15000);
  await mainPage.setDefaultNavigationTimeout(15000);

  await mainPage.setRequestInterception(true);
  mainPage.on('request', (req) => {
    const resourceType = req.resourceType();
    if (['image', 'stylesheet', 'font'].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await mainPage.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Load Sofascore once to set cookies/session
  await mainPage.goto('https://www.sofascore.com/football', {
    waitUntil: 'domcontentloaded'
  });

  return mainPage;
}

// Fetch JSON inside browser context
async function fetchJson(url, retries = 3) {
  const page = await getMainPage();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const content = await page.evaluate(async (fetchUrl) => {
        try {
          const res = await fetch(fetchUrl, {
            method: 'GET',
            headers: {
              'accept': 'application/json, text/plain, */*',
              'referer': 'https://www.sofascore.com',
            },
            credentials: 'include'
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        } catch (err) {
          return { error: err.message };
        }
      }, url);

      if (content && !content.error) return content;
      throw new Error(content?.error || 'Unknown fetch error');

    } catch (error) {
      console.error(`❌ Attempt ${attempt + 1} failed for: ${url}`, error.message);
      if (attempt === retries) return null;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

// Delay helper
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// Calculate match time
function calculateActualMatchTime(startTimestamp, status, incidentTime, addedTime) {
  const now = Date.now();
  const startTime = startTimestamp * 1000;
  const elapsedMs = now - startTime;
  const elapsedMinutes = Math.floor(elapsedMs / 60000);

  if (elapsedMs < 0) return null;

  const statusLower = (status || '').toLowerCase();
  if (statusLower === 'finished' || statusLower === 'ended') return incidentTime || 90;
  if (statusLower.includes('1st half') || statusLower === 'started') return Math.min(elapsedMinutes, 50);
  if (statusLower === 'halftime') return 45;
  if (statusLower.includes('2nd half')) return Math.min(45 + Math.max(0, elapsedMinutes - 60), 95);
  if (statusLower.includes('extra time')) {
    const extraTime = Math.max(0, elapsedMinutes - 105);
    if (statusLower.includes('1st half')) return Math.min(90 + extraTime, 105);
    if (statusLower.includes('2nd half')) return Math.min(105 + extraTime, 120);
    return Math.min(90 + extraTime, 120);
  }

  return Math.min(elapsedMinutes, 120);
}

// Fetch goal scorers
async function fetchGoalScorers(matchId, match) {
  const url = `https://www.sofascore.com/api/v1/event/${matchId}/incidents`;
  const data = await fetchJson(url);

  if (!data || !data.incidents) {
    return { homeScorers: [], awayScorers: [], currentTime: null, addedTime: null, finalScores: null };
  }

  const homeScorers = [];
  const awayScorers = [];
  let currentTime = null;
  let addedTime = null;
  let lastPeriod = null;
  let finalScores = null;

  const sortedIncidents = data.incidents.sort((a, b) => (b.time || 0) - (a.time || 0));
  const ftIncident = sortedIncidents.find(i => i.incidentType === 'period' && i.text === 'FT');
  if (ftIncident) {
    finalScores = {
      home: ftIncident.homeScore || 0,
      away: ftIncident.awayScore || 0
    };
  }

  for (const incident of sortedIncidents) {
    if (incident.incidentType === 'period' && !lastPeriod) {
      lastPeriod = incident;
      if (incident.text === 'FT') {
        currentTime = incident.time || 90;
        addedTime = incident.addedTime && incident.addedTime !== 999 ? incident.addedTime : null;
      } else if (incident.isLive) {
        if (incident.addedTime === 999 || !incident.time) {
          currentTime = calculateActualMatchTime(
            match.timestamp, match.status, incident.time, incident.addedTime
          );
        } else {
          currentTime = incident.time;
          addedTime = incident.addedTime;
        }
      }
    }
    if (incident.incidentType === 'goal' && incident.player?.name) {
      const scorer = { name: incident.player.name, minute: incident.time || 0 };
      incident.isHome ? homeScorers.push(scorer) : awayScorers.push(scorer);
    }
  }

  if (!currentTime && match?.timestamp) {
    currentTime = calculateActualMatchTime(match.timestamp, match.status, null, null);
  }

  return { homeScorers, awayScorers, currentTime, addedTime, finalScores };
}

// Batch fetch scorers
async function batchFetchGoalScorers(matchIds, matchesMap) {
  const results = new Map();
  const chunks = [];
  for (let i = 0; i < matchIds.length; i += CONCURRENT_LIMIT) {
    chunks.push(matchIds.slice(i, i + CONCURRENT_LIMIT));
  }
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const promises = chunk.map(async (matchId, index) => {
      await delay(index * 200);
      try {
        const match = matchesMap.get(matchId);
        const scorers = await fetchGoalScorers(matchId, match);
        results.set(matchId, scorers);
      } catch {
        results.set(matchId, { homeScorers: [], awayScorers: [], currentTime: null, addedTime: null, finalScores: null });
      }
    });
    await Promise.all(promises);
    if (chunkIndex < chunks.length - 1) await delay(500);
  }
  return results;
}

// Live scores
async function fetchLiveScores() {
  const data = await fetchJson('https://www.sofascore.com/api/v1/sport/football/events/live');
  if (!data?.events?.length) return [];

  const basicMatches = data.events.map(event => {
    const status = event.status?.description || 'Unknown';
    const isActuallyLive = !['finished', 'ended'].includes(status.toLowerCase());
    let homeScore = event.homeScore?.current ?? event.homeScore ?? 0;
    let awayScore = event.awayScore?.current ?? event.awayScore ?? 0;
    return {
      id: event.id,
      home: event.homeTeam?.name || 'Unknown',
      away: event.awayTeam?.name || 'Unknown',
      homeScore,
      awayScore,
      status,
      timestamp: event.startTimestamp,
      homeScorers: [],
      awayScorers: [],
      isActuallyLive
    };
  });

  const matchesMap = new Map();
  basicMatches.forEach(match => matchesMap.set(match.id, match));
  const scorersMap = await batchFetchGoalScorers(basicMatches.map(m => m.id), matchesMap);

  for (const match of basicMatches) {
    if (scorersMap.has(match.id)) {
      const mData = scorersMap.get(match.id);
      match.homeScorers = mData.homeScorers;
      match.awayScorers = mData.awayScorers;
      match.currentTime = mData.currentTime;
      match.addedTime = mData.addedTime;
      if (match.homeScore === 0 && match.awayScore === 0 && mData.finalScores) {
        match.homeScore = mData.finalScores.home;
        match.awayScore = mData.finalScores.away;
      }
    }
  }
  return basicMatches;
}

// Scheduled matches
async function fetchScheduledMatches() {
  const today = new Date().toISOString().split('T')[0];
  const data = await fetchJson(`https://www.sofascore.com/api/v1/sport/football/scheduled-events/${today}`);
  if (!data?.events?.length) return [];
  return data.events.map(event => ({
    id: event.id,
    home: event.homeTeam?.name || 'Unknown',
    away: event.awayTeam?.name || 'Unknown',
    homeScore: 0,
    awayScore: 0,
    status: event.status?.description || 'Scheduled',
    timestamp: event.startTimestamp,
    homeScorers: [],
    awayScorers: [],
    isScheduled: true
  }));
}

// API endpoints
app.get('/api/livescores', async (req, res) => {
  const now = Date.now();
  if (cachedLiveData && (now - lastLiveFetch) < CACHE_DURATION) {
    return res.json(cachedLiveData);
  }
  const matches = await fetchLiveScores();
  cachedLiveData = { type: 'live', matches, timestamp: now, count: matches.length };
  lastLiveFetch = now;
  res.json(cachedLiveData);
});

app.get('/api/scheduled', async (req, res) => {
  const now = Date.now();
  if (cachedScheduledData && (now - lastScheduledFetch) < CACHE_DURATION) {
    return res.json(cachedScheduledData);
  }
  const matches = await fetchScheduledMatches();
  cachedScheduledData = { type: 'scheduled', matches, timestamp: now, count: matches.length };
  lastScheduledFetch = now;
  res.json(cachedScheduledData);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    cache: {
      live: { hasData: !!cachedLiveData, lastFetch: lastLiveFetch, age: Date.now() - lastLiveFetch },
      scheduled: { hasData: !!cachedScheduledData, lastFetch: lastScheduledFetch, age: Date.now() - lastScheduledFetch }
    }
  });
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`🔄 Received ${signal}, shutting down gracefully...`);
  if (browser) {
    try {
      await browser.close();
      console.log('✅ Browser closed');
    } catch (error) {
      console.error('❌ Error closing browser:', error);
    }
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`📋 Cache duration: ${CACHE_DURATION / 1000}s`);
  console.log(`🔄 Concurrent limit: ${CONCURRENT_LIMIT}`);
  console.log(`📊 Endpoints ready`);
});
                                           
