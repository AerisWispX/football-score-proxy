const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const CACHE_DURATION = 60 * 1000; // 60s cache

let browser;
let page;
let cache = { scheduled: null, live: null, time: { scheduled: 0, live: 0 } };

async function launchBrowser() {
  if (browser && page) return;
  console.log("🔄 Launching Puppeteer browser...");
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  page = await browser.newPage();
  console.log("✅ Puppeteer launched.");

  console.log("🌐 Visiting Sofascore homepage to get cookies...");
  await page.goto("https://www.sofascore.com/football", { waitUntil: "domcontentloaded" });
  const cookies = await page.cookies();
  console.log(`🔐 Sofascore cookies (${cookies.length}): ${cookies.map(c => c.name).join(", ")}`);
}

async function sofascoreFetchJson(apiUrl) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await launchBrowser();
      console.log(`🌍 Fetching from Sofascore API (Attempt ${attempt}): ${apiUrl}`);

      const jsonData = await page.evaluate(async (url) => {
        const res = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: { "x-requested-with": "XMLHttpRequest" }
        });
        return await res.json();
      }, apiUrl);

      if (jsonData) {
        console.log(`📦 JSON preview: ${JSON.stringify(jsonData).slice(0, 200)}...`);
        return jsonData;
      }
    } catch (err) {
      console.warn(`⚠ sofascoreFetchJson attempt ${attempt} failed for ${apiUrl}: ${err.message}`);
    }
  }
  return null;
}

async function getScheduledMatches() {
  const now = Date.now();
  if (cache.scheduled && now - cache.time.scheduled < CACHE_DURATION) {
    console.log("⏳ Using cached scheduled matches.");
    return cache.scheduled;
  }

  const today = new Date().toISOString().split("T")[0];
  const data = await sofascoreFetchJson(`https://api.sofascore.com/api/v1/sport/football/scheduled-events/${today}`);

  if (data?.events) {
    cache.scheduled = data.events;
    cache.time.scheduled = now;
  }
  return cache.scheduled || [];
}

async function getLiveMatches() {
  const now = Date.now();
  if (cache.live && now - cache.time.live < CACHE_DURATION) {
    console.log("⏳ Using cached live matches.");
    return cache.live;
  }

  const data = await sofascoreFetchJson(`https://api.sofascore.com/api/v1/sport/football/events/live`);

  if (data?.events) {
    cache.live = data.events;
    cache.time.live = now;
  }
  return cache.live || [];
}

async function getGoalScorers(matchId) {
  const data = await sofascoreFetchJson(`https://api.sofascore.com/api/v1/event/${matchId}/incidents`);
  if (!data?.incidents) return [];
  return data.incidents
    .filter(inc => inc.incidentType === "goal")
    .map(g => `${g.player?.name || "Unknown"} (${g.homeScore}-${g.awayScore})`);
}

// Routes
app.get("/api/scheduled", async (req, res) => {
  const matches = await getScheduledMatches();
  res.json(matches);
});

app.get("/api/live", async (req, res) => {
  const matches = await getLiveMatches();
  res.json(matches);
});

app.get("/api/goals/:id", async (req, res) => {
  const goals = await getGoalScorers(req.params.id);
  res.json(goals);
});

app.listen(PORT, async () => {
  console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
  console.log(`📋 Cache duration: ${CACHE_DURATION / 1000}s`);
  await launchBrowser();
});
