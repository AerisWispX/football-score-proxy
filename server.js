// server.js
// Persistent Puppeteer + Sofascore-in-page fetching to avoid 403s
// - single persistent browser instance
// - sofascoreFetchJson: visits sofascore frontend then runs fetch() in page context
// - reuses pages, avoids overlapping fetches
// - debug logs for cookies and successful API calls

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// === Config ===
const CACHE_DURATION = 60 * 1000; // 60s
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
  if (browser && browser.isConnected && browser.isConnected()) return browser;

  // prevent parallel launches
  if (browserLaunching) {
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
        '--disable-renderer-backgrounding'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      defaultViewport: { width: 1366, height: 768 }
    });

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
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);

  // Request interception: block heavy resources and add realistic headers
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

    try {
      req.continue({ headers: extra });
    } catch (e) {
      // fallback
      try { req.continue(); } catch (_) { req.abort(); }
    }
  });

  await page.setUserAgent(randomUserAgent());

  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) window.chrome.runtime = {};
    } catch (e) { /* ignore */ }
  });

  return page;
}

// === Sofascore in-page fetch ===
// visits the Sofascore frontend to get cookies/session then runs fetch(url) inside the page
async function sofascoreFetchJson(page, apiUrl, { retries = 2, originPage = 'https://www.sofascore.com/football' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Open sofascore frontend (warm-up) to get cookies/sessions/tokens
      await page.goto(originPage, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await jitterDelay(400 + Math.random() * 800);

      // debug: show relevant cookies (not printing all headers to avoid noise)
      try {
        const cookies = await page.cookies();
        const sessionCookies = cookies.filter(c => /sofascore|api|session|token|_ga|_gid/i.test(c.name));
        console.log(`🔐 Sofascore cookies (${sessionCookies.length}):`, sessionCookies.map(c => c.name).join(', ') || '(none visible)');
      } catch (e) {
        console.warn('⚠ Could not read cookies:', e && e.message ? e.message : e);
      }

      // perform fetch inside page context so request carries cookies & real headers
      const data = await page.evaluate(async (url) => {
        const headers = {
          'accept': 'application/json, text/plain, */*',
          'x-requested-with': 'XMLHttpRequest',
          'referer': 'https://www.sofascore.com/',
          'origin': 'https://www.sofascore.com'
        };
        try {
          const res = await fetch(url, { method: 'GET', credentials: 'include', headers });
          if (!res.ok) {
            // throw with status to be caught below
            throw { status: res.status, text: await res.text().catch(() => '') };
          }
          return await res.json();
        } catch (err) {
          // Re-throw shape the caller expects
          if (err && err.status) throw new Error('HTTP ' + err.status + ' - ' + (err.text || ''));
          throw err;
        }
      }, apiUrl);

      // debug success
      console.log(`✅ sofascoreFetchJson success: ${apiUrl} (attempt ${attempt + 1})`);
      return data;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn(`⚠ sofascoreFetchJson attempt ${attempt + 1} failed for ${apiUrl}: ${msg}`);
      // If 403 or similar, try again after a backoff
      if (attempt < retries) {
        await jitterDelay(800 + attempt * 700);
        continue;
      }
      // final failure: return null so caller can handle
      return null;
    }
  }
  return null;
}

// === Incident fetching with in-page fetch ===
async function fetchGoalIncidentsSinglePage(page, matchId) {
  const url = `https://api.sofascore.com/api/v1/event/${matchId}/incidents`;
  const data = await sofascoreFetchJson(page, url, { retries: 2 });
  if (!data || !Array.isArray(data.incidents)) {
    return { homeScorers: [], awayScorers: [], finalScores: null, currentTime: null, addedTime: null };
  }

  const homeScorers = [];
  const awayScorers = [];
  let finalScores = null;
  let currentTime = null;
  let addedTime = null;

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

// reuse a single page sequentially for incidents
async function batchFetchGoalScorers(matchIds, matchesMap) {
  const results = new Map();
  let page;
  try {
    page = await createStealthPage();
    for (let i = 0; i < matchIds.length; i++) {
      const id = matchIds[i];
      try {
        await jitterDelay(200 + (i % 3) * 150);
        const info = await fetchGoalIncidentsSinglePage(page, id);
        results.set(id, info);
      } catch (err) {
        console.warn(`⚠ Failed to fetch incidents for match ${id}:`, err && err.message ? err.message : err);
        results.set(id, { homeScorers: [], awayScorers: [], finalScores: null, currentTime: null, addedTime: null });
      }
    }
  } catch (err) {
    console.error('❌ batchFetchGoalScorers fatal:', err && err.message ? err.message : err);
  } finally {
    if (page) try { await page.close(); } catch (e) { /* ignore */ }
  }
  return results;
}

// === Fetchers ===
async function fetchScheduledMatches() {
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

    const data = await sofascoreFetchJson(page, url, { retries: 2 });
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

    console.log(`✅ Fetched ${matches.length} scheduled matches for ${today}`);
    return matches;
  } catch (err) {
    console.error('❌ Scheduled fetch error:', err && err.message ? err.message : err);
    return [];
  } finally {
    scheduledFetchInProgress = false;
    if (page) try { await page.close(); } catch (e) { /* ignore */ }
  }
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
    const data = await sofascoreFetchJson(page, liveUrl, { retries: 2 });

    if (!data || !Array.isArray(data.events)) {
      console.warn('⚠ No live events or invalid response structure');
      return [];
    }

    const basicMatches = data.events.map(ev => {
      const homeScore = (ev.homeScore && typeof ev.homeScore.current === 'number') ? ev.homeScore.current :
                        (typeof ev.homeScore === 'number' ? ev.homeScore : 0);
      const awayScore = (ev.awayScore && typeof ev.awayScore.current === 'number') ? ev.awayScore.current :
                        (typeof ev.awayScore === 'number' ? ev.awayScore : 0);
      return {
        id: ev.id,
        home: ev.homeTeam?.name || '',
        away: ev.awayTeam?.name || '',
        homeScore,
        awayScore,
        status: ev.status?.description || '',
        timestamp: ev.startTimestamp || null,
        homeScorers: [],
        awayScorers: [],
        currentTime: null,
        addedTime: null
      };
    });

    const matchesMap = new Map(basicMatches.map(m => [m.id, m]));
    const matchIds = Array.from(matchesMap.keys());
    const incidentsMap = await batchFetchGoalScorers(matchIds, matchesMap);

    for (const m of basicMatches) {
      const info = incidentsMap.get(m.id);
      if (!info) continue;
      m.homeScorers = info.homeScorers || [];
      m.awayScorers = info.awayScorers || [];
      m.currentTime = info.currentTime || m.currentTime;
      m.addedTime = info.addedTime || m.addedTime;
      if ((m.homeScore === 0 && m.awayScore === 0) && info.finalScores) {
        m.homeScore = info.finalScores.home || m.homeScore;
        m.awayScore = info.finalScores.away || m.awayScore;
      }
    }

    console.log(`✅ Fetched ${basicMatches.length} live matches`);
    return basicMatches;
  } catch (err) {
    console.error('❌ fetchLiveMatches error:', err && err.message ? err.message : err);
    return [];
  } finally {
    liveFetchInProgress = false;
    if (page) try { await page.close(); } catch (e) { /* ignore */ }
  }
}

// === API endpoints (caching) ===
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
    const resp = await page.goto('https://www.sofascore.com/football', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await jitterDelay(400);
    // try the live endpoint via in-page fetch
    const data = await sofascoreFetchJson(page, 'https://api.sofascore.com/api/v1/sport/football/events/live', { retries: 1 });
    res.json({ ok: !!data, preview: data ? JSON.stringify(data).slice(0, 400) : null, timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  } finally {
    if (page) try { await page.close(); } catch (e) { /* ignore */ }
  }
});

// Warm the browser on start
async function ensureBrowserWarm() {
  try {
    await createBrowser();
  } catch (e) {
    console.warn('watchdog: createBrowser failed:', e && e.message ? e.message : e);
  }
}
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
