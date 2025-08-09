const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

let browser;
const CACHE_DURATION = 60000;
let cachedLiveData = null;
let cachedScheduledData = null;
let lastLiveFetch = 0;
let lastScheduledFetch = 0;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function delay(ms) {
  const jitter = Math.random() * 1000;
  return new Promise(resolve => setTimeout(resolve, ms + jitter));
}

async function createBrowser() {
  if (browser && browser.isConnected()) {
    return browser;
  }
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    });
    console.log('✅ Puppeteer browser launched');
  } catch (err) {
    console.error('❌ Failed to launch Puppeteer:', err);
    browser = null;
  }
  return browser;
}

async function createPage() {
  try {
    const browserInstance = await createBrowser();
    if (!browserInstance) throw new Error('Browser not available');
    const page = await browserInstance.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setDefaultTimeout(30000);
    await page.setDefaultNavigationTimeout(30000);
    await page.setRequestInterception(true);

    page.on('request', req => {
      const resourceType = req.resourceType();
      const url = req.url();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else if (url.includes('analytics') || url.includes('tracking') || url.includes('ads')) {
        req.abort();
      } else {
        req.continue({
          headers: {
            ...req.headers(),
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.9',
            'referer': 'https://api.sofascore.com/',
            'origin': 'https://api.sofascore.com',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'cache-control': 'no-cache',
            'pragma': 'no-cache'
          }
        });
      }
    });

    await page.setUserAgent(getRandomUserAgent());
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) window.chrome.runtime = {};
    });
    return page;
  } catch (err) {
    console.error('❌ createPage error:', err.message);
    browser = null;
    throw err;
  }
}

async function fetchJson(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    return await page.evaluate(() => {
      try {
        return JSON.parse(document.body.innerText);
      } catch {
        return null;
      }
    });
  } catch (err) {
    console.error('fetchJson error:', err.message);
    return null;
  }
}

async function fetchGoalScorersSinglePage(page, matchId, match) {
  const url = `https://api.sofascore.com/api/v1/event/${matchId}/incidents`;
  const data = await fetchJson(page, url);
  if (!data || !data.incidents) {
    return { homeScorers: [], awayScorers: [], finalScores: null };
  }
  const homeScorers = [];
  const awayScorers = [];
  let finalScores = null;
  data.incidents.forEach(incident => {
    if (incident.incidentType === 'goal' && incident.player?.name) {
      const scorer = { name: incident.player.name, minute: incident.time || 0 };
      incident.isHome ? homeScorers.push(scorer) : awayScorers.push(scorer);
    }
    if (incident.incidentType === 'period' && incident.text === 'FT') {
      finalScores = {
        home: incident.homeScore || 0,
        away: incident.awayScore || 0
      };
    }
  });
  return { homeScorers, awayScorers, finalScores };
}

async function batchFetchGoalScorers(matchIds, matchesMap) {
  const results = new Map();
  const page = await createPage();
  for (const matchId of matchIds) {
    await delay(500);
    const match = matchesMap.get(matchId);
    results.set(matchId, await fetchGoalScorersSinglePage(page, matchId, match));
  }
  await page.close();
  return results;
}

async function fetchLiveScores() {
  const page = await createPage();
  try {
    const data = await fetchJson(page, 'https://api.sofascore.com/api/v1/sport/football/events/live');
    if (!data?.events) return [];
    const basicMatches = data.events.map(event => ({
      id: event.id,
      home: event.homeTeam?.name || '',
      away: event.awayTeam?.name || '',
      homeScore: event.homeScore?.current || 0,
      awayScore: event.awayScore?.current || 0,
      status: event.status?.description || '',
      timestamp: event.startTimestamp
    }));
    const matchesMap = new Map(basicMatches.map(m => [m.id, m]));
    const scorersMap = await batchFetchGoalScorers(basicMatches.map(m => m.id), matchesMap);
    basicMatches.forEach(match => {
      const sc = scorersMap.get(match.id);
      match.homeScorers = sc.homeScorers;
      match.awayScorers = sc.awayScorers;
      if ((match.homeScore === 0 && match.awayScore === 0) && sc.finalScores) {
        match.homeScore = sc.finalScores.home;
        match.awayScore = sc.finalScores.away;
      }
    });
    return basicMatches;
  } finally {
    await page.close();
  }
}

async function fetchScheduledMatches() {
  const page = await createPage();
  try {
    const today = new Date().toISOString().split('T')[0];
    const data = await fetchJson(page, `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${today}`);
    if (!data?.events) return [];
    return data.events.map(event => ({
      id: event.id,
      home: event.homeTeam?.name || '',
      away: event.awayTeam?.name || '',
      homeScore: 0,
      awayScore: 0,
      status: event.status?.description || '',
      timestamp: event.startTimestamp
    }));
  } finally {
    await page.close();
  }
}

async function safeFetch(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.message.includes('Target closed')) {
      console.warn('⚠ Puppeteer target closed, retrying...');
      browser = null;
      return await fn();
    }
    throw err;
  }
}

app.get('/api/livescores', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedLiveData && (now - lastLiveFetch) < CACHE_DURATION) return res.json(cachedLiveData);
    const matches = await safeFetch(fetchLiveScores);
    cachedLiveData = { matches, timestamp: now };
    lastLiveFetch = now;
    res.json(cachedLiveData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scheduled', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedScheduledData && (now - lastScheduledFetch) < CACHE_DURATION) return res.json(cachedScheduledData);
    const matches = await safeFetch(fetchScheduledMatches);
    cachedScheduledData = { matches, timestamp: now };
    lastScheduledFetch = now;
    res.json(cachedScheduledData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
  browser = null;
});
process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
  browser = null;
});
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down...');
  if (browser) await browser.close();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
});
  
