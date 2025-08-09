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
const CONCURRENT_LIMIT = 1; // Reduced to 1 for better stability
const CACHE_DURATION = 60000; // 60 seconds cache
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
  const jitter = Math.random() * 1000;
  return new Promise(resolve => setTimeout(resolve, ms + jitter));
}

// Improved browser creation with better error handling and resource management
async function createBrowser() {
  // Always create a new browser instance to avoid connection issues
  if (browser) {
    try {
      await browser.close();
      console.log('🔄 Closed existing browser instance');
    } catch (error) {
      console.log('⚠️ Warning: Could not close existing browser:', error.message);
    }
    browser = null;
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
        '--single-process', // Important for container stability
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
        '--memory-pressure-off', // Prevent memory-based shutdowns
        '--max_old_space_size=512', // Limit memory usage
        '--disable-ipc-flooding-protection' // Prevent IPC flooding errors
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      timeout: 60000, // Increase launch timeout
      protocolTimeout: 30000, // Increase protocol timeout
    });

    console.log('✅ Browser instance created successfully');
    
    // Add browser disconnect handler
    browser.on('disconnected', () => {
      console.log('⚠️ Browser disconnected, will create new instance on next request');
      browser = null;
    });

    return browser;
  } catch (error) {
    console.error('❌ Failed to create browser:', error.message);
    browser = null;
    throw error;
  }
}

async function createPage() {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      const browserInstance = await createBrowser();
      const page = await browserInstance.newPage();
      
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
            'sec-ch-ua-platform': '"Linux"', // Changed to match container
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

      console.log('✅ Page created successfully');
      return page;
    } catch (error) {
      attempts++;
      console.error(`❌ Attempt ${attempts} failed to create page:`, error.message);
      
      if (attempts >= maxAttempts) {
        throw new Error(`Failed to create page after ${maxAttempts} attempts: ${error.message}`);
      }
      
      await delay(2000 * attempts); // Progressive delay
    }
  }
}

// Enhanced fetchJson with better error handling and retry logic
async function fetchJson(page, url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`🔄 Attempt ${attempt + 1} for: ${url}`);
      
      // Add random delay between attempts
      if (attempt > 0) {
        await delay(3000 * attempt); // Progressive backoff
      }

      // Check if page is still connected
      if (page.isClosed()) {
        throw new Error('Page is closed');
      }

      // First, visit the main site to establish session (only on first attempt)
      if (attempt === 0) {
        try {
          console.log('🔄 Establishing session with main site...');
          await page.goto('https://www.sofascore.com/football', { 
            waitUntil: 'domcontentloaded',
            timeout: 20000 
          });
          await delay(2000 + Math.random() * 2000);
        } catch (e) {
          console.log('⚠️ Could not visit main site, continuing...');
        }
      }
      
      // Now make the API request
      console.log(`🌐 Fetching: ${url}`);
      const response = await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      
      console.log(`📊 Response status: ${response.status()}`);
      
      // Handle different response codes
      if (response.status() === 403) {
        console.log('🚫 Got 403, trying with different approach...');
        
        // Try to get fresh session cookies
        await page.goto('https://www.sofascore.com/football', {
          waitUntil: 'domcontentloaded',
          timeout: 20000
        });
        await delay(3000 + Math.random() * 2000);
        
        // Retry the API call
        const retryResponse = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        
        if (!retryResponse.ok() && retryResponse.status() !== 304) {
          throw new Error(`HTTP ${retryResponse.status()}`);
        }
      } else if (response.status() === 304) {
        console.log(`📋 Got cached response (304) for: ${url}`);
      } else if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}`);
      }

      // Extract JSON content with better error handling
      const content = await page.evaluate(() => {
        try {
          const bodyText = document.body.innerText.trim();
          if (!bodyText) return null;
          if (bodyText.length < 10) return null; // Too short to be valid JSON
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
        console.log(`❌ All attempts failed for: ${url}`);
        return null;
      }
      
      // Wait longer between failed attempts
      await delay(5000 + Math.random() * 3000);
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

// Updated fetchGoalScorers function with better error handling
async function fetchGoalScorers(page, matchId, match) {
  try {
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
  } catch (error) {
    console.error(`❌ Error fetching goal scorers for match ${matchId}:`, error.message);
    return { homeScorers: [], awayScorers: [], currentTime: null, addedTime: null, finalScores: null };
  }
}

// Simplified batch processing - sequential instead of parallel
async function batchFetchGoalScorers(matchIds, matchesMap) {
  const results = new Map();
  
  console.log(`🔄 Processing ${matchIds.length} matches sequentially for better stability`);
  
  for (let i = 0; i < matchIds.length; i++) {
    const matchId = matchIds[i];
    console.log(`🔄 Processing match ${i + 1}/${matchIds.length}: ${matchId}`);
    
    let page = null;
    try {
      page = await createPage();
      const match = matchesMap.get(matchId);
      const scorers = await fetchGoalScorers(page, matchId, match);
      results.set(matchId, scorers);
      
      console.log(`✅ Successfully processed match ${matchId}`);
    } catch (error) {
      console.error(`❌ Failed to process match ${matchId}:`, error.message);
      results.set(matchId, { 
        homeScorers: [], 
        awayScorers: [], 
        currentTime: null, 
        addedTime: null, 
        finalScores: null 
      });
    } finally {
      if (page && !page.isClosed()) {
        try {
          await page.close();
        } catch (closeError) {
          console.error(`⚠️ Warning: Could not close page for match ${matchId}:`, closeError.message);
        }
      }
    }
    
    // Add delay between matches to avoid overwhelming the server
    if (i < matchIds.length - 1) {
      await delay(2000 + Math.random() * 1000); // 2-3 seconds between matches
    }
  }

  return results;
}

// Enhanced fetchLiveScores function with better error handling
async function fetchLiveScores() {
  console.log('🔄 Fetching live scores...');
  const startTime = Date.now();
  
  let page = null;
  
  try {
    page = await createPage();
    
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

    // Fetch goal scorers and match time for matches (limit to first 10 to avoid timeouts)
    const limitedMatchIds = basicMatches.slice(0, 10).map(match => match.id);
    console.log(`🥅 Fetching detailed info for ${limitedMatchIds.length} matches...`);

    if (limitedMatchIds.length > 0) {
      const scorersMap = await batchFetchGoalScorers(limitedMatchIds, matchesMap);

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
    if (page && !page.isClosed()) {
      try {
        await page.close();
      } catch (closeError) {
        console.error('⚠️ Warning: Could not close live scores page:', closeError.message);
      }
    }
  }
}

async function fetchScheduledMatches() {
  console.log('🔄 Fetching scheduled matches...');
  const startTime = Date.now();
  
  let page = null;
  
  try {
    page = await createPage();
    
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
    if (page && !page.isClosed()) {
      try {
        await page.close();
      } catch (closeError) {
        console.error('⚠️ Warning: Could not close scheduled matches page:', closeError.message);
      }
    }
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
    },
    browserStatus: browser ? 'connected' : 'disconnected'
  });
});

// Debug endpoint to check if browser is working
app.get('/debug/test', async (req, res) => {
  let page = null;
  try {
    page = await createPage();
    
    // Visit main site first
    await page.goto('https://www.sofascore.com/football', {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    
    await delay(2000);
    
    const response = await page.goto('https://api.sofascore.com/api/v1/sport/football/events/live', {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    
    const status = response.status();
    const content = await page.evaluate(() => document.body.innerText.substring(0, 200));
    
    res.json({
      status,
      contentPreview: content,
      timestamp: Date.now(),
      browserConnected: !!(browser && !browser._process?.killed)
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      timestamp: Date.now(),
      browserConnected: !!(browser && !browser._process?.killed)
    });
  } finally {
    if (page && !page.isClosed()) {
      try {
        await page.close();
      } catch (closeError) {
        console.error('⚠️ Warning: Could not close debug page:', closeError.message);
      }
    }
  }
});

// Graceful shutdown with better cleanup
async function gracefulShutdown(signal) {
  console.log(`🔄 Received ${signal}, shutting down gracefully...`);
  
  if (browser) {
    try {
      const pages = await browser.pages();
      console.log(`📋 Closing ${pages.length} pages...`);
      
      // Close all pages first
      for (const page of pages) {
        try {
          if (!page.isClosed()) {
            await page.close();
          }
        } catch (error) {
          console.error('⚠️ Error closing page:', error.message);
        }
      }
      
      // Then close the browser
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
  console.log(`   - Health: http://localhost:${PORT}/health`);
  console.log(`📊 API endpoints:`);
  console.log(`   - Live scores: http://localhost:${PORT}/api/livescores`);
  console.log(`   - Scheduled: http://localhost:${PORT}/api/scheduled`);
});
