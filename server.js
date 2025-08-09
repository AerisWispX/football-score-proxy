const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DURATION = 60 * 1000; // 60s
const COOKIE_FILE = path.join(__dirname, "cookies.json");

let browser, page;
let scheduledCache = { data: null, timestamp: 0 };
let liveCache = { data: null, timestamp: 0 };

// Load cookies from file
async function loadCookies() {
    if (fs.existsSync(COOKIE_FILE)) {
        const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
        if (cookies.length) {
            await page.setCookie(...cookies);
            console.log(`🍪 Loaded ${cookies.length} cookies from file.`);
        }
    }
}

// Save cookies to file
async function saveCookies() {
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    console.log(`💾 Saved ${cookies.length} cookies to file.`);
}

// Puppeteer setup
async function launchBrowser() {
    console.log("🚀 Launching Puppeteer...");
    browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    page = await browser.newPage();
    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36"
    );

    // Load Sofascore to pass Cloudflare
    await page.goto("https://www.sofascore.com/football", {
        waitUntil: "networkidle2",
    });

    await saveCookies();
}

// Fetch JSON from inside the browser
async function sofascoreFetchJson(url) {
    try {
        return await page.evaluate(async (fetchUrl) => {
            const res = await fetch(fetchUrl, {
                headers: { "accept": "application/json" },
            });
            return await res.json();
        }, url);
    } catch (err) {
        console.error(`⚠ Fetch failed for ${url}:`, err.message);
        return null;
    }
}

// Get scheduled matches
async function getScheduled(dateStr) {
    const now = Date.now();
    if (scheduledCache.data && now - scheduledCache.timestamp < CACHE_DURATION) {
        return scheduledCache.data;
    }
    console.log(`📅 Fetching scheduled matches for ${dateStr}...`);
    const url = `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${dateStr}`;
    const json = await sofascoreFetchJson(url);
    scheduledCache = { data: json, timestamp: now };
    return json;
}

// Get live matches
async function getLive() {
    const now = Date.now();
    if (liveCache.data && now - liveCache.timestamp < CACHE_DURATION) {
        return liveCache.data;
    }
    console.log("📡 Fetching live matches...");
    const url = "https://api.sofascore.com/api/v1/sport/football/events/live";
    const json = await sofascoreFetchJson(url);
    liveCache = { data: json, timestamp: now };
    return json;
}

// Routes
app.use(cors());

app.get("/api/scheduled/:date", async (req, res) => {
    const data = await getScheduled(req.params.date);
    res.json(data || {});
});

app.get("/api/live", async (req, res) => {
    const data = await getLive();
    res.json(data || {});
});

// Start server
(async () => {
    await launchBrowser();
    await loadCookies();
    app.listen(PORT, () => {
        console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
    });
})();
