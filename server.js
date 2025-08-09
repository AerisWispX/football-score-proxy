const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Configure stealth plugin with enhanced settings
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

let browser;
const CONCURRENT_LIMIT = 1; // Reduced to 1 for maximum stealth
const CACHE_DURATION = 120000; // Increased cache to 2 minutes
const REQUEST_DELAY = 5000; // 5 second delay between requests
let cachedLiveData = null;
let cachedScheduledData = null;
let lastLiveFetch = 0;
let lastScheduledFetch = 0;
let requestCount = 0;

// Rotating proxies (if you have access to proxy services)
const PROXY_LIST = [
  // Add your proxy servers here if available
  // 'http://proxy1:port',
  // 'http://proxy2:port',
];

// Enhanced user agents pool with more realistic options
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// Realistic referrer URLs
const REFERRERS = [
  'https://www.google.com/',
  'https://www.bing.com/',
  'https://duckduckgo.com/',
  'https://www.sofascore.com/',
  'https://www.espn.com/',
  ''
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomReferrer() {
  return REFERRERS[Math.floor(Math.random() * REFERRERS.length)];
}

// Enhanced delay with exponential backoff
async function delay(ms, exponential = false) {
  const baseDelay = exponential ? ms * Math.pow(2, requestCount % 4) : ms;
  const jitter = Math.random() * 2000; // Add up to 2 seconds jitter
  const totalDelay = baseDelay + jitter;
  console.log(`⏱️ Waiting ${Math.round(totalDelay)}ms...`);
  return new Promise(resolve => setTimeout(resolve, totalDelay));
}

async function createBrowser() {
  if (!browser) {
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-client-side-phishing-detection',
        '--disable-crash-reporter',
        '--disable-oopr-debug-crash-dump',
        '--no-crash-upload',
        '--disable-low-res-tiling',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-blink-features=AutomationControlled',
        '--disable-automation',
        '--disable-dev-tools',
        '--no-default-browser-check',
        '--no-pings',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-ipc-flooding-protection'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    };

    // Add proxy if available
    if (PROXY_LIST.length > 0) {
      const randomProxy = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
      launchOptions.args.push(`--proxy-server=${randomProxy}`);
      console.log(`🔀 Using proxy: ${randomProxy}`);
    }

    browser = await puppeteer.launch(launchOptions);
  }
  return browser;
}

async function createPage() {
  const browser = await createBrowser();
  const page = await browser.newPage();
  
  // Set viewport to common screen resolution
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 }
  ];
  const randomViewport = viewports[Math.floor(Math.random() * viewports.length)];
  await page.setViewport(randomViewport);
  
  // Set timeouts
  await page.setDefaultTimeout(45000);
  await page.setDefaultNavigationTimeout(45000);
  
  // Set realistic user agent and headers
  const userAgent = getRandomUserAgent();
  await page.setUserAgent(userAgent);
  
  // Set extra headers for more realistic requests
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0'
  });

  // Enhanced request interception
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    const url = req.url();
    
    // Block unnecessary resources
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      req.abort();
    } else if (url.includes('analytics') || url.includes('tracking') || url.includes('ads') || url.includes('facebook') || url.includes('twitter') || url.includes('google-analytics')) {
      req.abort();
    } else {
      // Modify headers for API requests
      const headers = {
        ...req.headers(),
        'referer': getRandomReferrer(),
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      };
      
      req.continue({ headers });
    }
  });

  // Enhanced stealth measures
  await page.evaluateOnNewDocument(() => {
    // Remove webdriver property
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    // Mock plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5].map((x, i) => ({
        0: {type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null},
        description: "Portable Document Format",
        filename: "internal-pdf-viewer",
        length: 1,
        name: "Chrome PDF Plugin"
      })),
    });

    // Mock languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    // Mock chrome object
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }

    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // Mock connection
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        downlink: 10,
        effectiveType: '4g',
        rtt: 50,
        saveData: false
      })
    });
  });

  return page;
}

// Enhanced session establishment
async function establishSession(page) {
  const sessionUrls = [
    'https://www.sofascore.com/',
    'https://www.sofascore.com/football',
    'https://www.sofascore.com/live-scores'
  ];

  for (const url of sessionUrls) {
    try {
      console.log(`🌐 Visiting ${url} to establish session...`);
      
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      
      // Simulate human behavior
      await delay(2000 + Math.random() * 3000);
      
      // Random mouse movements and scrolling
      await page.evaluate(() => {
        window.scrollBy(0, Math.random() * 500);
      });
      
      await delay(1000 + Math.random() * 2000);
      
      // Check if we got blocked
      const title = await page.title();
      if (title.toLowerCase().includes('access denied') || title.toLowerCase().includes('forbidden')) {
        console.log(`🚫 Got blocked on ${url}, trying next...`);
        continue;
      }
      
      console.log(`✅ Successfully visited ${url}`);
      break;
      
    } catch (error) {
      console.log(`⚠️ Could not visit ${url}: ${error.message}`);
      continue;
    }
  }
}

// Enhanced fetchJson with better anti-detection
async function fetchJson(page, url, retries = 3) {
  requestCount++;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`🔄 Attempt ${attempt + 1}/${retries + 1} for: ${url}`);
      
      // Progressive delay with exponential backoff
      if (attempt > 0) {
        await delay(REQUEST_DELAY * attempt, true);
      } else {
        await delay(2000);
      }

      // Establish session on first attempt or after 403 errors
      if (attempt === 0 || attempt === Math.floor(retries / 2)) {
        await establishSession(page);
        await delay(3000 + Math.random() * 2000);
      }
      
      // Make the API request
      console.log(`📡 Making request to: ${url}`);
      const response = await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      
      const status = response.status();
      console.log(`📊 Response status: ${status}`);
      
      // Handle different response codes
      if (status === 403) {
        console.log('🚫 Got 403, implementing enhanced retry strategy...');
        
        if (attempt < retries) {
          // Try to clear cookies and establish fresh session
          await page.deleteCookie(...(await page.cookies()));
          await delay(5000 + Math.random() * 5000);
          continue;
        }
      } else if (status === 429) {
        console.log('⏰ Rate limited (429), waiting longer...');
        await delay(10000 + Math.random() * 10000);
        continue;
      } else if (status === 304) {
        console.log(`📋 Got cached response (304)`);
      } else if (!response.ok()) {
        throw new Error(`HTTP ${status}`);
      }

      // Extract JSON content
      const content = await page.evaluate(() => {
        try {
          const bodyText = document.body.innerText.trim();
          if (!bodyText || bodyText.includes('Access Denied') || bodyText.includes('Forbidden')) {
            return null;
          }
          return JSON.parse(bodyText);
        } catch (e) {
          console.error('JSON parse error:', e.message);
          return null;
        }
      });
      
      if (content) {
        console.log(`✅ Successfully fetched data`);
        return content;
      } else {
        throw new Error('No valid JSON content found or access denied');
      }
      
    } catch (error) {
      console.error(`❌ Attempt ${attempt + 1} failed: ${error.message}`);
      
      if (attempt === retries) {
        console.log(`🔄 All attempts failed for: ${url}`);
        return null;
      }
    }
  }
  return null;
}

// Alternative API approach - try different endpoints
async function fetchLiveScoresAlternative(page) {
  const alternativeEndpoints = [
    'https://api.sofascore.com/api/v1/sport/football/events/live',
    'https://api.sofascore.com/api/v1/sport/1/events/live', // football = sport ID 1
    'https://www.sofascore.com/api/v1/sport/football/events/live'
  ];

  for (const endpoint of alternativeEndpoints) {
    console.log(`🔄 Trying alternative endpoint: ${endpoint}`);
    const data = await fetchJson(page, endpoint);
    if (data && data.events) {
      console.log(`✅ Success with endpoint: ${endpoint}`);
      return data;
    }
  }

  return null;
}

// Calculate actual match time based on start timestamp and current time
function calculateActualMatchTime(startTimestamp, status, incidentTime, addedTime) {
  const now = Date.now();
  const startTime = startTimestamp * 1000;
  const elapsedMs = now - startTime;
  const elapsedMinutes = Math.floor(elapsedMs / 60000);

  if (elapsedMs < 0) {
    return null;
  }

  const statusLower = (status || '').toLowerCase();
  
  if (statusLower === 'finished' || statusLower === 'ended') {
    return incidentTime || 90;
  }

  if (statusLower.includes('1st half') || statusLower === 'started') {
    const actualTime = Math.min(elapsedMinutes, 50);
    return actualTime;
  } else if (statusLower === 'halftime') {
    return 45;
  } else if (statusLower.includes('2nd half')) {
    const secondHalfTime = Math.max(0, elapsedMinutes - 60);
    const actualTime = Math.min(45 + secondHalfTime, 95);
    return actualTime;
  } else if (statusLower.includes('extra time')) {
    const extraTime = Math.max(0, elapsedMinutes - 105);
    if (statusLower.includes('1st half')) {
      return Math.min(90 + extraTime, 105);
    } else if (statusLower.includes('2nd half')) {
      return Math.min(105 + extraTime, 120);
    }
    return Math.min(90 + extraTime, 120);
  }

  return Math.min(elapsedMinutes, 120);
}

async function fetchGoalScorers(page, matchId, match) {
  const url = `https://api.sofascore.com/api/v1/event/${matchId}/incidents`;
  const data = await fetchJson(page, url);
  
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

  const ftIncident = sortedIncidents.find(incident => 
    incident.incidentType === 'period' && incident.text === 'FT'
  );
  
  if (ftIncident) {
    finalScores = {
      home: ftIncident.homeScore || 0,
      away: ftIncident.awayScore || 0
    };
    console.log(`📊 Found final scores for match ${matchId}: ${finalScores.home}-${finalScores.away}`);
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
            match.timestamp, 
            match.status, 
            incident.time, 
            incident.addedTime
          );
          console.log(`📊 Match ${matchId}: Calculated time ${currentTime}' (was ${incident.time}')`);
        } else {
          currentTime = incident.time;
          addedTime = incident.addedTime;
        }
      }
    }
    
    if (incident.incidentType === 'goal' && incident.player?.name) {
      const scorer = {
        name: incident.player.name,
        minute: incident.time || 0
      };
      
      if (incident.isHome) {
        homeScorers.push(scorer);
      } else {
        awayScorers.push(scorer);
      }
    }
  }

  if (!currentTime && match && match.timestamp) {
    currentTime = calculateActualMatchTime(match.timestamp, match.status, null, null);
    if (currentTime !== null) {
      console.log(`📊 Match ${matchId}: Calculated time from timestamp: ${currentTime}'`);
    }
  }

  return { homeScorers, awayScorers, currentTime, addedTime, finalScores };
}

async function batchFetchGoalScorers(matchIds, matchesMap) {
  const results = new Map();
  
  // Process one by one for maximum stealth
  for (let i = 0; i < matchIds.length; i++) {
    const matchId = matchIds[i];
    console.log(`🔄 Processing match ${i + 1}/${matchIds.length}: ${matchId}`);
    
    const page = await createPage();
    try {
      const match = matchesMap.get(matchId);
      const scorers = await fetchGoalScorers(page, matchId, match);
      results.set(matchId, scorers);
      
      // Longer delay between requests
      if (i < matchIds.length - 1) {
        await delay(REQUEST_DELAY + Math.random() * 3000);
      }
    } catch (error) {
      console.error(`Failed to fetch scorers for match ${matchId}:`, error.message);
      results.set(matchId, { homeScorers: [], awayScorers: [], currentTime: null, addedTime: null, finalScores: null });
    } finally {
      await page.close();
    }
  }

  return results;
}

async function fetchLiveScores() {
  console.log('🔄 Fetching live scores...');
  const startTime = Date.now();
  
  const page = await createPage();
  
  try {
    // Try alternative endpoints
    const data = await fetchLiveScoresAlternative(page);
    
    if (!data || !data.events || !Array.isArray(data.events)) {
      console.log('❌ No live events found or invalid response structure');
      return [];
    }

    console.log(`📊 Found ${data.events.length} live events`);

    const basicMatches = data.events.map(event => {
      const status = event.status?.description || 'Unknown';
      const isActuallyLive = status.toLowerCase() !== 'finished' && status.toLowerCase() !== 'ended';
      
      let homeScore = 0;
      let awayScore = 0;
      
      if (event.homeScore && typeof event.homeScore.current === 'number') {
        homeScore = event.homeScore.current;
      } else if (event.homeScore && typeof event.homeScore === 'number') {
        homeScore = event.homeScore;
      }
      
      if (event.awayScore && typeof event.awayScore.current === 'number') {
        awayScore = event.awayScore.current;
      } else if (event.awayScore && typeof event.awayScore === 'number') {
        awayScore = event.awayScore;
      }
      
      console.log(`📊 Match ${event.id}: ${event.homeTeam?.name} ${homeScore}-${awayScore} ${event.awayTeam?.name} (Status: ${status})`);
      
      return {
        id: event.id,
        home: event.homeTeam?.name || 'Unknown',
        away: event.awayTeam?.name || 'Unknown',
        homeScore: homeScore,
        awayScore: awayScore,
        status: status,
        timestamp: event.startTimestamp,
        homeScorers: [],
        awayScorers: [],
        isActuallyLive: isActuallyLive
      };
    });

    const matchesMap = new Map();
    basicMatches.forEach(match => matchesMap.set(match.id, match));

    // Limit detailed fetching to reduce requests
    const matchIds = basicMatches.slice(0, 10).map(match => match.id); // Only process first 10 matches
    console.log(`🥅 Fetching detailed info for ${matchIds.length} matches...`);

    if (matchIds.length > 0) {
      const scorersMap = await batchFetchGoalScorers(matchIds, matchesMap);

      for (const match of basicMatches) {
        if (scorersMap.has(match.id)) {
          const matchData = scorersMap.get(match.id);
          match.homeScorers = matchData.homeScorers;
          match.awayScorers = matchData.awayScorers;
          match.currentTime = matchData.currentTime;
          match.addedTime = matchData.addedTime;
          
          if ((match.homeScore === 0 && match.awayScore === 0) && matchData.finalScores) {
            match.homeScore = matchData.finalScores.home || match.homeScore;
            match.awayScore = matchData.finalScores.away || match.awayScore;
            console.log(`🔄 Updated scores from incidents for match ${match.id}: ${match.homeScore}-${match.awayScore}`);
          }
        }
      }
    }

    const endTime = Date.now();
    console.log(`✅ Fetched ${basicMatches.length} matches in ${endTime - startTime}ms`);

    return basicMatches;
  } catch (error) {
    console.error('❌ Error in fetchLiveScores:', error);
    return [];
  } finally {
    await page.close();
  }
}

async function fetchScheduledMatches() {
  console.log('🔄 Fetching scheduled matches...');
  const startTime = Date.now();
  
  const page = await createPage();
  
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Try alternative endpoints for scheduled matches
    const scheduledEndpoints = [
      `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${today}`,
      `https://api.sofascore.com/api/v1/sport/1/scheduled-events/${today}`,
      `https://www.sofascore.com/api/v1/sport/football/scheduled-events/${today}`
    ];

    let data = null;
    for (const endpoint of scheduledEndpoints) {
      console.log(`🔄 Trying scheduled endpoint: ${endpoint}`);
      data = await fetchJson(page, endpoint);
      if (data && data.events) {
        console.log(`✅ Success with scheduled endpoint: ${endpoint}`);
        break;
      }
    }
    
    if (!data || !data.events || !Array.isArray(data.events)) {
      console.log('❌ No scheduled events found or invalid response structure');
      return [];
    }

    console.log(`📊 Found ${data.events.length} scheduled events`);

    const scheduledMatches = data.events.map(event => ({
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

    const endTime = Date.now();
    console.log(`✅ Fetched ${scheduledMatches.length} scheduled matches in ${endTime - startTime}ms`);

    return scheduledMatches;
  } catch (error) {
    console.error('❌ Error in fetchScheduledMatches:', error);
    return [];
  } finally {
    await page.close();
  }
}

// API endpoints remain the same
app.get('/api/livescores', async (req, res) => {
  try {
    const now = Date.now();
    
    if (cachedLiveData && (now - lastLiveFetch) < CACHE_DURATION) {
      console.log('📋 Returning cached live data');
      return res.json(cachedLiveData);
    }

    const matches = await fetchLiveScores();
    
    cachedLiveData = { 
      type: 'live', 
      matches,
      timestamp: now,
      count: matches.length
    };
    lastLiveFetch = now;
    
    res.json(cachedLiveData);
  } catch (error) {
    console.error('❌ Live API error:', error);
    
    if (cachedLiveData) {
      console.log('📋 Returning stale cached live data due to error');
      return res.json({
        ...cachedLiveData,
        warning: 'Data may be stale due to fetch error'
      });
    }
    
    res.status(500).json({ 
      error: 'Unable to fetch live scores',
      message: error.message 
    });
  }
});

app.get('/api/scheduled', async (req, res) => {
  try {
    const now = Date.now();
    
    if (cachedScheduledData && (now - lastScheduledFetch) < CACHE_DURATION) {
      console.log('📋 Returning cached scheduled data');
      return res.json(cachedScheduledData);
    }

    const matches = await fetchScheduledMatches();
    
    cachedScheduledData = { 
      type: 'scheduled', 
      matches,
      timestamp: now,
      count: matches.length
    };
    lastScheduledFetch = now;
    
    res.json(cachedScheduledData);
  } catch (error) {
    console.error('❌ Scheduled API error:', error);
    
    if (cachedScheduledData) {
      console.log('📋 Returning stale cached scheduled data due to error');
      return res.json({
        ...cachedScheduledData,
        warning: 'Data may be stale due to fetch error'
      });
    }
    
    res.status(500).json({ 
      error: 'Unable to fetch scheduled matches',
      message: error.message 
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: Date.now(),
    requestCount,
    cache: {
      live: {
        hasData: !!cachedLiveData,
        lastFetch: lastLiveFetch,
        age: Date.now() - lastLiveFetch
      },
      scheduled: {
        hasData: !!cachedScheduledData,
        lastFetch: lastScheduledFetch,
        age: Date.now() - lastScheduledFetch
      }
    }
  });
});

app.get('/debug/test', async (req, res) => {
  try {
    const page = await createPage();
    
    await establishSession(page);
    
    const response = await page.goto('https://api.sofascore.com/api/v1/sport/football/events/live', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    const status = response.status();
    const content = await page.evaluate(() => document.body.innerText.substring(0, 200));
    
    await page.close();
    
    res.json({
      status,
      contentPreview: content,
      timestamp: Date.now(),
      requestCount
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      timestamp: Date.now(),
      requestCount
    });
  }
});

// Reset request count endpoint
app.get('/debug/reset', (req, res) => {
  requestCount = 0;
  cachedLiveData = null;
  cachedScheduledData = null;
  lastLiveFetch = 0;
  lastScheduledFetch = 0;
  
  res.json({
    message: 'Reset successful',
    timestamp: Date.now()
  });
});

// Manual cache clear endpoint
app.get('/debug/clear-cache', (req, res) => {
  cachedLiveData = null;
  cachedScheduledData = null;
  lastLiveFetch = 0;
  lastScheduledFetch = 0;
  
  res.json({
    message: 'Cache cleared',
    timestamp: Date.now()
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

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
  console.log(`📋 Cache duration: ${CACHE_DURATION / 1000}s`);
  console.log(`🔄 Concurrent limit: ${CONCURRENT_LIMIT}`);
  console.log(`⏱️ Request delay: ${REQUEST_DELAY / 1000}s`);
  console.log(`🔧 Debug endpoints:`);
  console.log(`   - Test: http://localhost:${PORT}/debug/test`);
  console.log(`   - Reset: http://localhost:${PORT}/debug/reset`);
  console.log(`   - Clear Cache: http://localhost:${PORT}/debug/clear-cache`);
  console.log(`📊 API endpoints:`);
  console.log(`   - Live scores: http://localhost:${PORT}/api/livescores`);
  console.log(`   - Scheduled: http://localhost:${PORT}/api/scheduled`);
  console.log(`   - Health: http://localhost:${PORT}/health`);
});
