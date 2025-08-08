const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

app.use(cors());

let browser;
const CONCURRENT_LIMIT = 3; // Reduced for stability
const CACHE_DURATION = 30000; // 30 seconds cache
let cachedLiveData = null;
let cachedScheduledData = null;
let lastLiveFetch = 0;
let lastScheduledFetch = 0;

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

async function createPage() {
  const browser = await createBrowser();
  const page = await browser.newPage();
  
  // Optimize page settings
  await page.setDefaultTimeout(15000); // Increased timeout
  await page.setDefaultNavigationTimeout(15000);
  
  // Block unnecessary resources
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font') {
      req.abort();
    } else {
      req.continue();
    }
  });

  // More realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  
  // Remove conditional headers that cause 304 responses
  await page.setExtraHTTPHeaders({
    'accept': 'application/json, text/plain, */*',
    'referer': 'https://www.sofascore.com',
    'cache-control': 'no-cache', // Force fresh response
    'pragma': 'no-cache'
  });

  return page;
}

async function fetchJson(page, url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 15000 
      });
      
      // Handle 304 as success since it means data exists
      if (response.status() === 304) {
        console.log(`📋 Got cached response (304) for: ${url}`);
        // Try to get cached content from page
        const content = await page.evaluate(() => {
          try {
            return JSON.parse(document.body.innerText);
          } catch (e) {
            return null;
          }
        });
        
        if (content) return content;
        
        // If no content, try with cache-busting
        const cacheBustUrl = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
        const freshResponse = await page.goto(cacheBustUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        });
        
        if (!freshResponse.ok() && freshResponse.status() !== 304) {
          throw new Error(`HTTP ${freshResponse.status()}`);
        }
      } else if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}`);
      }

      const content = await page.evaluate(() => {
        try {
          return JSON.parse(document.body.innerText);
        } catch (e) {
          return null;
        }
      });
      
      if (content) {
        return content;
      } else {
        throw new Error('No valid JSON content found');
      }
      
    } catch (error) {
      console.error(`❌ Attempt ${attempt + 1} failed for: ${url}`, error.message);
      if (attempt === retries) return null;
      
      // Progressive backoff
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  return null;
}

// Add delay between requests to avoid rate limiting
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const url = `https://www.sofascore.com/api/v1/event/${matchId}/incidents`;
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

// Batch process goal scorers with limited concurrency
async function batchFetchGoalScorers(matchIds, matchesMap) {
  const results = new Map();
  const chunks = [];
  
  // Split into smaller chunks for better stability
  for (let i = 0; i < matchIds.length; i += CONCURRENT_LIMIT) {
    chunks.push(matchIds.slice(i, i + CONCURRENT_LIMIT));
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    
    console.log(`🔄 Processing chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} matches)`);
    
    const promises = chunk.map(async (matchId, index) => {
      // Stagger requests within chunk
      await delay(index * 200);
      
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
    
    // Delay between chunks
    if (chunkIndex < chunks.length - 1) {
      await delay(500);
    }
  }

  return results;
}

// Fixed fetchLiveScores function with better score parsing
async function fetchLiveScores() {
  console.log('🔄 Fetching live scores...');
  const startTime = Date.now();
  
  const page = await createPage();
  
  try {
    // Fetch main live scores data
    const liveUrl = 'https://www.sofascore.com/api/v1/sport/football/events/live';
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
    const scheduledUrl = `https://www.sofascore.com/api/v1/sport/football/scheduled-events/${today}`;
    
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
    const response = await page.goto('https://www.sofascore.com/api/v1/sport/football/events/live', {
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

// Debug endpoint for scheduled matches
app.get('/debug/scheduled', async (req, res) => {
  try {
    const page = await createPage();
    const today = new Date().toISOString().split('T')[0];
    const response = await page.goto(`https://www.sofascore.com/api/v1/sport/football/scheduled-events/${today}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    
    const status = response.status();
    const content = await page.evaluate(() => document.body.innerText.substring(0, 500));
    
    await page.close();
    
    res.json({
      status,
      contentPreview: content,
      date: today,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      timestamp: Date.now()
    });
  }
});

// Debug endpoint to test incident parsing for a specific match
app.get('/debug/incidents/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const page = await createPage();
    
    // Create a mock match object for testing
    const mockMatch = {
      id: parseInt(matchId),
      timestamp: Math.floor(Date.now() / 1000) - 2100, // Started 35 minutes ago
      status: '1st half'
    };
    
    const scorersData = await fetchGoalScorers(page, matchId, mockMatch);
    
    await page.close();
    
    res.json({
      matchId,
      mockMatch,
      scorersData,
      calculatedTime: calculateActualMatchTime(mockMatch.timestamp, mockMatch.status, null, null),
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      matchId: req.params.matchId,
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

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`📋 Cache duration: ${CACHE_DURATION / 1000}s`);
  console.log(`🔄 Concurrent limit: ${CONCURRENT_LIMIT}`);
  console.log(`🔧 Debug endpoints:`);
  console.log(`   - Live: http://localhost:${PORT}/debug/test`);
  console.log(`   - Scheduled: http://localhost:${PORT}/debug/scheduled`);
  console.log(`   - Incidents: http://localhost:${PORT}/debug/incidents/{matchId}`);
  console.log(`📊 API endpoints:`);
  console.log(`   - Live scores: http://localhost:${PORT}/api/livescores`);
  console.log(`   - Scheduled: http://localhost:${PORT}/api/scheduled`);
});
