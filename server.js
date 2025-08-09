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
const CONCURRENT_LIMIT = 2; // Reduced further for stealth
const CACHE_DURATION = 60000; // Increased cache to 60 seconds
let cachedLiveData = null;
let cachedScheduledData = null;
let lastLiveFetch = 0;
let lastScheduledFetch = 0;

// Enhanced user agents pool
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// Get random user agent
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Enhanced delay with jitter
async function delay(ms) {
  const jitter = Math.random() * 1000; // Add up to 1 second jitter
  return new Promise(resolve => setTimeout(resolve, ms + jitter));
}

async function createBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
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
        '--disable-default-apps'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });
  }
  return browser;
}

async function createPage() {
  const browser = await createBrowser();
  const page = await browser.newPage();
  
  // Enhanced viewport and timeout settings
  await page.setViewport({ width: 1366, height: 768 });
  await page.setDefaultTimeout(30000);
  await page.setDefaultNavigationTimeout(30000);
  
  // Enhanced request interception with better stealth
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    const url = req.url();
    
    // Block unnecessary resources but allow API calls
    if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font' || resourceType === 'media') {
      req.abort();
    } else if (url.includes('analytics') || url.includes('tracking') || url.includes('ads')) {
      req.abort();
    } else {
      // Add realistic headers to API requests
      const headers = {
        ...req.headers(),
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'referer': 'https://api.sofascore.com/',
        'origin': 'https://api.sofascore.com',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'cache-control': 'no-cache',
        'pragma': 'no-cache'
      };
      
      req.continue({ headers });
    }
  });

  // Set realistic user agent
  await page.setUserAgent(getRandomUserAgent());
  
  // Add extra stealth measures
  await page.evaluateOnNewDocument(() => {
    // Override the `plugins` property to use a custom getter
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5].map(() => 'Plugin'),
    });
    
    // Override the `languages` property to use a custom getter
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    
    // Override the `webdriver` property to use a custom getter
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });

    // Mock chrome runtime
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }
  });

  return page;
}

// Enhanced fetchJson with better error handling and stealth
async function fetchJson(page, url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`🔄 Attempt ${attempt + 1} for: ${url}`);
      
      // Add random delay between attempts
      if (attempt > 0) {
        await delay(2000 * attempt); // Progressive backoff with jitter
      }

      // First, visit the main site to establish session
      if (attempt === 0) {
        try {
          await page.goto('https://api.sofascore.com/', { 
            waitUntil: 'domcontentloaded',
            timeout: 15000 
          });
          await delay(1000 + Math.random() * 2000); // Random delay 1-3 seconds
        } catch (e) {
          console.log('⚠️ Could not visit main site, continuing...');
        }
      }
      
      // Now make the API request
      const response = await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 25000 
      });
      
      console.log(`📊 Response status: ${response.status()}`);
      
      // Handle different response codes
      if (response.status() === 403) {
        console.log('🚫 Got 403, trying with different approach...');
        
        // Try to get fresh session cookies
        await page.goto('https://api.sofascore.com/football', {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        });
        await delay(2000 + Math.random() * 3000); // Wait 2-5 seconds
        
        // Retry the API call
        const retryResponse = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 25000
        });
        
        if (!retryResponse.ok() && retryResponse.status() !== 304) {
          throw new Error(`HTTP ${retryResponse.status()}`);
        }
      } else if (response.status() === 304) {
        console.log(`📋 Got cached response (304) for: ${url}`);
      } else if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}`);
      }

      // Extract JSON content
      const content = await page.evaluate(() => {
        try {
          const bodyText = document.body.innerText.trim();
          if (!bodyText) return null;
          return JSON.parse(bodyText);
        } catch (e) {
          console.error('JSON parse error:', e.message);
          return null;
        }
      });
      
      if (content) {
        console.log(`✅ Successfully fetched data for: ${url}`);
        return content;
      } else {
        throw new Error('No valid JSON content found');
      }
      
    } catch (error) {
      console.error(`❌ Attempt ${attempt + 1} failed for: ${url}`, error.message);
      
      if (attempt === retries) {
        // On final failure, try one more time with extended delay
        console.log(`🔄 Final attempt with extended delay for: ${url}`);
        await delay(5000 + Math.random() * 5000); // 5-10 second delay
        
        try {
          const finalResponse = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          
          if (finalResponse.ok() || finalResponse.status() === 304) {
            const content = await page.evaluate(() => {
              try {
                return JSON.parse(document.body.innerText);
              } catch (e) {
                return null;
              }
            });
            
            if (content) return content;
          }
        } catch (finalError) {
          console.error(`❌ Final attempt failed: ${finalError.message}`);
        }
        
        return null;
      }
    }
  }
  return null;
}

// Calculate actual match time based on start timestamp and current time
function calculateActualMatchTime(startTimestamp, status, incidentTime, addedTime) {
  const now = Date.now();
  const startTime = startTimestamp * 1000; // Convert to milliseconds
  const elapsedMs = now - startTime;
  const elapsedMinutes = Math.floor(elapsedMs / 60000); // Convert to minutes

  // If match hasn't started yet or is scheduled
  if (elapsedMs < 0) {
    return null;
  }

  const statusLower = (status || '').toLowerCase();
  
  // For finished matches, use the incident time if available
  if (statusLower === 'finished' || statusLower === 'ended') {
    return incidentTime || 90;
  }

  // For live matches, calculate based on status and elapsed time
  if (statusLower.includes('1st half') || statusLower === 'started') {
    // First half: 0-45+ minutes
    const actualTime = Math.min(elapsedMinutes, 50); // Cap at 50 to handle added time
    return actualTime;
  } else if (statusLower === 'halftime') {
    return 45;
  } else if (statusLower.includes('2nd half')) {
    // Second half: 45-90+ minutes
    // Assume 15 minute halftime break
    const secondHalfTime = Math.max(0, elapsedMinutes - 60); // Subtract ~60 for first half + break
    const actualTime = Math.min(45 + secondHalfTime, 95); // 45 + second half time, cap at 95
    return actualTime;
  } else if (statusLower.includes('extra time')) {
    // Extra time: 90+ minutes
    const extraTime = Math.max(0, elapsedMinutes - 105); // Subtract ~105 for regular time + break
    if (statusLower.includes('1st half')) {
      return Math.min(90 + extraTime, 105);
    } else if (statusLower.includes('2nd half')) {
      return Math.min(105 + extraTime, 120);
    }
    return Math.min(90 + extraTime, 120);
  }

  // Default: use elapsed time but cap it reasonably
  return Math.min(elapsedMinutes, 120);
}

// Updated fetchGoalScorers function to also return final scores
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

  // Sort incidents by time to get the latest period info
  const sortedIncidents = data.incidents.sort((a, b) => (b.time || 0) - (a.time || 0));

  // Find the final scores from FT period incident
  const ftIncident = sortedIncidents.find(incident => 
    incident.incidentType === 'period' && incident.text === 'FT'
  );
  
  if (ftIncident) {
    finalScores = {
      home: ftIncident.homeScore || 0,
      away: ftIncident.awayScore || 0
    };
    console.log(`📊 Found final scores from FT incident for match ${matchId}: ${finalScores.home}-${finalScores.away}`);
  }

  for (const incident of sortedIncidents) {
    // Get current match time from the latest period incident
    if (incident.incidentType === 'period' && !lastPeriod) {
      lastPeriod = incident;
      
      // For finished matches, use the final time from FT period
      if (incident.text === 'FT') {
        currentTime = incident.time || 90;
        addedTime = incident.addedTime && incident.addedTime !== 999 ? incident.addedTime : null;
      } 
      // For live matches, calculate actual time if addedTime is 999 (unknown)
      else if (incident.isLive) {
        if (incident.addedTime === 999 || !incident.time) {
          // Calculate actual time based on match start and current time
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
    
    // Get goal scorers
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

  // If no period incidents found but match is live, calculate time from timestamp
  if (!currentTime && match && match.timestamp) {
    currentTime = calculateActualMatchTime(match.timestamp, match.status, null, null);
    if (currentTime !== null) {
      console.log(`📊 Match ${matchId}: No period data, calculated time from timestamp: ${currentTime}'`);
    }
  }

  return { homeScorers, awayScorers, currentTime, addedTime, finalScores };
}

// Batch process goal scorers with limited concurrency and enhanced delays
async function batchFetchGoalScorers(matchIds, matchesMap) {
  const results = new Map();
  const chunks = [];
  
  // Split into even smaller chunks for better stealth
  for (let i = 0; i < matchIds.length; i += CONCURRENT_LIMIT) {
    chunks.push(matchIds.slice(i, i + CONCURRENT_LIMIT));
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    
    console.log(`🔄 Processing chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} matches)`);
    
    const promises = chunk.map(async (matchId, index) => {
      // Longer stagger between requests
      await delay(index * 1000 + Math.random() * 2000);
      
      const page = await createPage();
      try {
        const match = matchesMap.get(matchId);
        const scorers = await fetchGoalScorers(page, matchId, match);
        results.set(matchId, scorers);
      } catch (error) {
        console.error(`Failed to fetch scorers for match ${matchId}:`, error.message);
        results.set(matchId, { homeScorers: [], awayScorers: [], currentTime: null, addedTime: null, finalScores: null });
      } finally {
        await page.close();
      }
    });

    await Promise.all(promises);
    
    // Longer delay between chunks
    if (chunkIndex < chunks.length - 1) {
      await delay(3000 + Math.random() * 2000); // 3-5 seconds between chunks
    }
  }

  return results;
}

// Enhanced fetchLiveScores function
async function fetchLiveScores() {
  console.log('🔄 Fetching live scores...');
  const startTime = Date.now();
  
  const page = await createPage();
  
  try {
    // Fetch main live scores data
    const liveUrl = 'https://api.sofascore.com/api/v1/sport/football/events/live';
    const data = await fetchJson(page, liveUrl);
    
    if (!data || !data.events || !Array.isArray(data.events)) {
      console.log('❌ No live events found or invalid response structure');
      return [];
    }

    console.log(`📊 Found ${data.events.length} live events`);

    // Process basic match info first
    const basicMatches = data.events.map(event => {
      // Determine if match is actually live or finished
      const status = event.status?.description || 'Unknown';
      const isActuallyLive = status.toLowerCase() !== 'finished' && status.toLowerCase() !== 'ended';
      
      // Parse scores properly - check multiple possible score formats
      let homeScore = 0;
      let awayScore = 0;
      
      // Method 1: Check homeScore.current and awayScore.current
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

    // Create a map for quick lookup
    const matchesMap = new Map();
    basicMatches.forEach(match => matchesMap.set(match.id, match));

    // Fetch goal scorers and match time for all matches (both live and recently finished)
    const matchIds = basicMatches.map(match => match.id);
    console.log(`🥅 Fetching detailed info for ${matchIds.length} matches...`);

    if (matchIds.length > 0) {
      const scorersMap = await batchFetchGoalScorers(matchIds, matchesMap);

      // Update matches with scorer data and match time
      for (const match of basicMatches) {
        if (scorersMap.has(match.id)) {
          const matchData = scorersMap.get(match.id);
          match.homeScorers = matchData.homeScorers;
          match.awayScorers = matchData.awayScorers;
          match.currentTime = matchData.currentTime;
          match.addedTime = matchData.addedTime;
          
          // Double-check scores from incidents if they seem wrong
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
    // Get today's date in YYYY-MM-DD format
    const today = new Date().toISOString().split('T')[0];
    const scheduledUrl = `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${today}`;
    
    const data = await fetchJson(page, scheduledUrl);
    
    if (!data || !data.events || !Array.isArray(data.events)) {
      console.log('❌ No scheduled events found or invalid response structure');
      return [];
    }

    console.log(`📊 Found ${data.events.length} scheduled events`);

    // Process scheduled match info
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

app.get('/api/livescores', async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached data if still valid
    if (cachedLiveData && (now - lastLiveFetch) < CACHE_DURATION) {
      console.log('📋 Returning cached live data');
      return res.json(cachedLiveData);
    }

    const matches = await fetchLiveScores();
    
    // Update cache
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
    
    // Return cached data if available, even if stale
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
    
    // Return cached data if still valid
    if (cachedScheduledData && (now - lastScheduledFetch) < CACHE_DURATION) {
      console.log('📋 Returning cached scheduled data');
      return res.json(cachedScheduledData);
    }

    const matches = await fetchScheduledMatches();
    
    // Update cache
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
    
    // Return cached data if available, even if stale
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: Date.now(),
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

// Debug endpoint to check if browser is working
app.get('/debug/test', async (req, res) => {
  try {
    const page = await createPage();
    
    // Visit main site first
    await page.goto('https://api.sofascore.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    
    await delay(2000);
    
    const response = await page.goto('https://api.sofascore.com/api/v1/sport/football/events/live', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    
    const status = response.status();
    const content = await page.evaluate(() => document.body.innerText.substring(0, 200));
    
    await page.close();
    
    res.json({
      status,
      contentPreview: content,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      timestamp: Date.now()
    });
  }
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

// Handle uncaught exceptions
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
  console.log(`🔧 Debug endpoints:`);
  console.log(`   - Test: http://localhost:${PORT}/debug/test`);
  console.log(`📊 API endpoints:`);
  console.log(`   - Live scores: http://localhost:${PORT}/api/livescores`);
  console.log(`   - Scheduled: http://localhost:${PORT}/api/scheduled`);
});
