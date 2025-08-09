// server.js
// Fixed persistent Puppeteer server for SofaScore APIs
// - single persistent browser instance
// - avoids overlapping fetches
// - reuses a single page for batch operations
// - auto-restarts browser on disconnect
// - safer request interception and backoff

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// === Configuration ===
const CACHE_DURATION = 60 * 1000; // 60s
const CONCURRENT_LIMIT = 2; // Not used for parallel pages here, kept for future use
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// === State ===
let browser = null;
let browserLaunching = false;
let cachedLiveData = null;
let cachedScheduledData = null;
let lastLiveFetch = 0;
let lastScheduledFetch = 0;
let scheduledFetchInProgress = false;
let liveFetchInProgress = false;

// === Helpers ===
function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
const jitterDelay = (ms) => new Promise(r => setTimeout(r, ms + Math.random() * 800));

// === Puppeteer management ===
async function createBrowser() {
  // if browser already ok, return it
  if (browser && browser.isConnected && browser.isConnected()) return browser;

  // Prevent multiple parallel launches
  if (browserLaunching) {
    // wait until launched (or timeout)
    const start = Date.now();
    while (browserLaunching) {
      if (Date.now() - start > 20000) break; // 20s timeout
      // eslint-disable-next-line no-await-in-loop
      await jitterDelay(200);
    }
    if (browser && browser.isConnected && browser.isConnected()) return browser;
  }

  browserLaunching = true;
  try {
    console.log('🔄 Launching Puppeteer browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-dev-shm-usage'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      defaultViewport: { width: 1366, height: 768 }
    });

    // Watch for disconnects — mark browser null so next call recreates it
    browser.on('disconnected', () => {
      console.warn('⚠ Puppeteer browser disconnected. Marking for restart.');
      browser = null;
    });

    console.log('✅ Puppeteer launched.');
    return browser;
  } catch (err) {
    console.error('❌ Failed to launch Puppeteer:', err && err.message ? err.message : err);
    browser = null;
    throw err;
  } finally {
    browserLaunching = false;
  }
}

async function createStealthPage() {
  const b = await createBrowser();
  if (!b) throw new Error('No browser available');

  const page = await b.newPage();
  // Timeouts
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);

  // Block heavy resources & add headers
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    const resourceType = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) return req.abort();
    if (url.includes('analytics') || url.includes('tracking') || url.includes('ads')) return req.abort();

    const extra = {
      ...req.headers(),
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
      'sec-ch-ua-mobile': '?0'
    };
    try { req.continue({ headers: extra }); } catch (e) { req.continue(); }
  });

  await page.setUserAgent(randomUserAgent());

  // Some stealthy navigator overrides
  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) window.chrome.runtime = {};
    } catch (e) {
      // ignore
    }
  });

  return page;
}

// Helper to safely goto JSON endpoint and parse text body as JSON
async function pageFetchJson(page, url, opts = {}) {
  const maxRetries = opts.retries ?? 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // small warm-up navigate to origin for cookies/session on first attempt
      if (attempt === 0) {
        try {
          await page.goto('https://api.sofascore.com/', { waitUntil: 'domcontentloaded', timeout: 12000 });
          await jitterDelay(400 + Math.random() * 800);
        } catch (e) {
          // ignore; not fatal
        }
      }

      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      if (!resp) throw new Error('No response object from page.goto');
      const status = resp.status ? resp.status() : 0;
      if (status === 403) throw new Error('403 Forbidden');
      if (status >= 400 && status !== 304) throw new Error(`HTTP ${status}`);

      // read body (as text) and parse
      const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');
      if (!bodyText) return null;
      try {
        return JSON.parse(bodyText);
      } catch (parseErr) {
        // If parse fails, return null and let caller handle
        return null;
      }
    } catch (err) {
      console.warn(`⚠ pageFetchJson attempt ${attempt + 1} failed for ${url}: ${err && err.message ? err.message : err}`);
      if (attempt < maxRetries) {
        await jitterDelay(800 + attempt * 500);
        continue;
      }
      return null;
    }
  }
  return null;
}

// === Fetchers with concurrency & caching protections ===

async function fetchScheduledMatches() {
  // Prevent overlapping scheduled fetches
  if (scheduledFetchInProgress) {
    console.debug('⏳ Scheduled fetch already running — returning cached scheduled data if available.');
    return (cachedScheduledData && cachedScheduledData.matches) ? cachedScheduledData.matches : [];
  }

  scheduledFetchInProgress = true;
  let page;
  try {
    page = await createStealthPage();
    const today = new Date().toISOString().split('T')[0];
    const url = `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${today}`;
    console.log('🔄 Fetching scheduled matches for', today);
    const data = await pageFetchJson(page, url, { retries: 2 });
    if (!data || !Array.isArray(data.events)) {
      console.warn('⚠ No scheduled events or invalid structure');
      return [];
    }
    const matches = data.events.map(ev => ({
      id: ev.id,
      home: ev.homeTeam?.name || '',
      away: ev.awayTeam?.name || '',
      homeScore: 0,
      awayScore: 0,
      status: ev.status?.description || 'Scheduled',
      timestamp: ev.startTimestamp || null,
      isScheduled: true
    }));
    return matches;
  } catch (err) {
    console.error('❌ Scheduled fetch error:', err && err.message ? err.message : err);
    return [];
  } finally {
    scheduledFetchInProgress = false;
    if (page) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
  }
}

async function fetchGoalIncidentsSinglePage(page, matchId) {
  // page must be created & passed in; this avoids opening many pages
  const url = `https://api.sofascore.com/api/v1/event/${matchId}/incidents`;
  const data = await pageFetchJson(page, url, { retries: 2 });
  if (!data || !Array.isArray(data.incidents)) return { homeScorers: [], awayScorers: [], finalScores: null, currentTime: null, addedTime: null };

  const homeScorers = [];
  const awayScorers = [];
  let finalScores = null;
  let currentTime = null;
  let addedTime = null;

  // iterate incidents (newest first doesn't matter here)
  for (const incident of data.incidents) {
    if (incident.incidentType === 'goal' && incident.player?.name) {
      const scorer = { name: incident.player.name, minute: incident.time || 0 };
      if (incident.isHome) homeScorers.push(scorer); else awayScorers.push(scorer);
    }
    if (incident.incidentType === 'period' && incident.text === 'FT') {
      finalScores = { home: incident.homeScore || 0, away: incident.awayScore || 0 };
      currentTime = incident.time || 90;
      addedTime = (incident.addedTime && incident.addedTime !== 999) ? incident.addedTime : null;
    }
    if (!currentTime && incident.incidentType === 'period' && incident.isLive) {
      currentTime = incident.time || null;
      addedTime = (incident.addedTime && incident.addedTime !== 999) ? incident.addedTime : null;
    }
  }

  return { homeScorers, awayScorers, finalScores, currentTime, addedTime };
}

async function batchFetchGoalScorers(matchIds, matchesMap) {
  // Reuse a single page to fetch incidents sequentially (reduces resource churn)
  const results = new Map();
  let page;
  try {
    page = await createStealthPage();

    for (let i = 0; i < matchIds.length; i++) {
      const id = matchIds[i];
      try {
        // small stagger
        await jitterDelay(200 + (i % 3) * 150);

        const match = matchesMap.get(id) || {};
        const info = await fetchGoalIncidentsSinglePage(page, id);

        // as a safety, if scores are zero and incidents contain finalScores, patch them
        results.set(id, info);
      } catch (err) {
        console.warn(`⚠ Failed to fetch incidents for match ${id}: ${err && err.message ? err.message : err}`);
        results.set(id, { homeScorers: [], awayScorers: [], finalScores: null, currentTime: null, addedTime: null });
        // continue to next match
      }
    }
  } catch (err) {
    console.error('❌ batchFetchGoalScorers fatal:', err && err.message ? err.message : err);
  } finally {
    if (page) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
  }
  return results;
}

async function fetchLiveMatches() {
  if (liveFetchInProgress) {
    console.debug('⏳ Live fetch already running — returning cached live data if available.');
    return (cachedLiveData && cachedLiveData.matches) ? cachedLiveData.matches : [];
  }

  liveFetchInProgress = true;
  let page;
  try {
    page = await createStealthPage();
    const liveUrl = 'https://api.sofascore.com/api/v1/sport/football/events/live';
    console.log('🔄 Fetching live scores...');
    const data = await pageFetchJson(page, liveUrl, { retries: 2 });

    if (!data || !Array.isArray(data.events)) {
      console.warn('⚠ No live events or invalid response structure');
      return [];
    }

    const basicMatches = data.events.map(ev => {
      const homeScore = (ev.homeScore && typeof ev.homeScore.current === 'number') ? ev.homeScore.current :
                        (typeof ev.homeScore === 'number' ? ev.homeScore : 0);
      const awayScore = (ev.awayScore && typeof ev.awayScore.current === 'number') ? ev.awayScore.current :
                        (typeof ev.awayScore === 'number' ? ev.awayScore : 0);
      const status = ev.status?.description || '';
      return {
        id: ev.id,
        home: ev.homeTeam?.name || '',
        away: ev.awayTeam?.name || '',
        homeScore,
        awayScore,
        status,
        timestamp: ev.startTimestamp || null,
        homeScorers: [],
        awayScorers: [],
        currentTime: null,
        addedTime: null
      };
    });

    const matchesMap = new Map(basicMatches.map(m => [m.id, m]));
    const matchIds = Array.from(matchesMap.keys());

    // Fetch incidents for all matches (sequentially via single page)
    const incidentsMap = await batchFetchGoalScorers(matchIds, matchesMap);

    // Merge incident data into matches
    for (const m of basicMatches) {
      const info = incidentsMap.get(m.id);
      if (!info) continue;
      m.homeScorers = info.homeScorers || [];
      m.awayScorers = info.awayScorers || [];
      m.currentTime = info.currentTime || m.currentTime;
      m.addedTime = info.addedTime || m.addedTime;

      // If both scores 0 but finalScores exist, patch
      if ((m.homeScore === 0 && m.awayScore === 0) && info.finalScores) {
        m.homeScore = info.finalScores.home || m.homeScore;
        m.awayScore = info.finalScores.away || m.awayScore;
      }
    }

    return basicMatches;
  } catch (err) {
    console.error('❌ fetchLiveMatches error:', err && err.message ? err.message : err);
    return [];
  } finally {
    liveFetchInProgress = false;
    if (page) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
  }
}

// === API endpoints with caching ===

app.get('/api/livescores', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedLiveData && (now - lastLiveFetch) < CACHE_DURATION) {
      return res.json({ ...cachedLiveData, cached: true });
    }
    const matches = await fetchLiveMatches();
    cachedLiveData = { type: 'live', matches, timestamp: Date.now(), count: matches.length };
    lastLiveFetch = Date.now();
    res.json(cachedLiveData);
  } catch (err) {
    console.error('API /api/livescores error:', err && err.message ? err.message : err);
    if (cachedLiveData) return res.json({ ...cachedLiveData, warning: 'stale due to error' });
    res.status(500).json({ error: 'Unable to fetch live scores', message: err && err.message ? err.message : String(err) });
  }
});

app.get('/api/scheduled', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedScheduledData && (now - lastScheduledFetch) < CACHE_DURATION) {
      return res.json({ ...cachedScheduledData, cached: true });
    }
    const matches = await fetchScheduledMatches();
    cachedScheduledData = { type: 'scheduled', matches, timestamp: Date.now(), count: matches.length };
    lastScheduledFetch = Date.now();
    res.json(cachedScheduledData);
  } catch (err) {
    console.error('API /api/scheduled error:', err && err.message ? err.message : err);
    if (cachedScheduledData) return res.json({ ...cachedScheduledData, warning: 'stale due to error' });
    res.status(500).json({ error: 'Unable to fetch scheduled matches', message: err && err.message ? err.message : String(err) });
  }
});

// Health & debug endpoints
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    browser: !!(browser && browser.isConnected && browser.isConnected()),
    cache: {
      live: { hasData: !!cachedLiveData, lastFetch: lastLiveFetch },
      scheduled: { hasData: !!cachedScheduledData, lastFetch: lastScheduledFetch }
    }
  });
});

app.get('/debug/test', async (req, res) => {
  let page;
  try {
    page = await createStealthPage();
    const resp = await page.goto('https://api.sofascore.com/api/v1/sport/football/events/live', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const status = resp ? resp.status() : null;
    const preview = await page.evaluate(() => (document.body && document.body.innerText) ? document.body.innerText.slice(0, 400) : '');
    res.json({ status, preview, timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  } finally {
    if (page) try { await page.close(); } catch (e) {}
  }
});

// === Auto-watchdog: if browser is null, try to create it in background ===
async function ensureBrowserWarm() {
  try {
    await createBrowser();
  } catch (e) {
    console.warn('watchdog: createBrowser failed:', e && e.message ? e.message : e);
  }
}
// attempt warm launch on start
ensureBrowserWarm();

// Graceful shutdown
async function shutdown() {
  console.log('🔄 Shutting down...');
  if (browser) {
    try { await browser.close(); console.log('✅ Browser closed'); } catch (e) { console.error('❌ Error closing browser:', e); }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err && err.stack ? err.stack : err);
  // let watchdog recreate as needed, but do not exit immediately to allow debug
  browser = null;
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
  browser = null;
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
  console.log(`📋 Cache duration: ${CACHE_DURATION / 1000}s`);
});
