const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

let browser;
let cache = {
    scheduled: { data: null, timestamp: 0 },
    live: { data: null, timestamp: 0 }
};
const CACHE_DURATION = 60 * 1000; // 60s cache

async function launchBrowser() {
    if (!browser) {
        console.log("🔄 Launching Puppeteer browser...");
        browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"]
        });
        console.log("✅ Puppeteer launched.");
    }
}

// Core fetch function using Puppeteer navigation
async function sofascoreFetchJson(apiUrl) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await launchBrowser();
            console.log(`🌍 Puppeteer navigating to API (Attempt ${attempt}): ${apiUrl}`);

            const apiPage = await browser.newPage();
            await apiPage.setExtraHTTPHeaders({
                "referer": "https://www.sofascore.com/",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36"
            });

            await apiPage.goto(apiUrl, { waitUntil: "networkidle0" });

            const bodyText = await apiPage.evaluate(() => document.body.innerText);
            await apiPage.close();

            const jsonData = JSON.parse(bodyText);
            console.log(`📦 JSON fetched: ${apiUrl}`);
            return jsonData;

        } catch (err) {
            console.warn(`⚠ sofascoreFetchJson attempt ${attempt} failed for ${apiUrl}: ${err.message}`);
        }
    }
    return null;
}

// Scheduled matches endpoint
app.get("/api/scheduled", async (req, res) => {
    const today = new Date().toISOString().split("T")[0];
    if (Date.now() - cache.scheduled.timestamp < CACHE_DURATION) {
        return res.json(cache.scheduled.data);
    }

    const url = `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${today}`;
    const data = await sofascoreFetchJson(url);

    if (data && data.events) {
        cache.scheduled = { data, timestamp: Date.now() };
        res.json(data);
    } else {
        res.status(500).json({ error: "No scheduled events or invalid structure" });
    }
});

// Live matches endpoint
app.get("/api/live", async (req, res) => {
    if (Date.now() - cache.live.timestamp < CACHE_DURATION) {
        return res.json(cache.live.data);
    }

    const url = `https://api.sofascore.com/api/v1/sport/football/events/live`;
    const data = await sofascoreFetchJson(url);

    if (data && data.events) {
        cache.live = { data, timestamp: Date.now() };
        res.json(data);
    } else {
        res.status(500).json({ error: "No live events or invalid structure" });
    }
});

// Goal scorers for a specific match
app.get("/api/match/:id/incidents", async (req, res) => {
    const matchId = req.params.id;
    const url = `https://api.sofascore.com/api/v1/event/${matchId}/incidents`;
    const data = await sofascoreFetchJson(url);

    if (data && data.incidents) {
        res.json(data);
    } else {
        res.status(500).json({ error: "No incidents found or invalid structure" });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
    console.log(`📋 Cache duration: ${CACHE_DURATION / 1000}s`);
});
