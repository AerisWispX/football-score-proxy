const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 3000;

app.use(cors());

async function fetchJsonWithPuppeteer(url, page) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2' });
    return await page.evaluate(() => JSON.parse(document.querySelector('body').innerText));
  } catch (err) {
    console.error(`❌ Failed to fetch URL: ${url}`, err.message);
    return null;
  }
}

async function fetchLiveScores() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'accept': 'application/json, text/plain, */*',
    'referer': 'https://www.sofascore.com',
  });

  // Get live matches
  const liveUrl = 'https://www.sofascore.com/api/v1/sport/football/events/live';
  const content = await fetchJsonWithPuppeteer(liveUrl, page);
  if (!content || !content.events) {
    await browser.close();
    return [];
  }

  const matches = [];

  for (const event of content.events) {
    const detailUrl = `https://www.sofascore.com/api/v1/event/${event.id}`;
    const detail = await fetchJsonWithPuppeteer(detailUrl, page);

    const currentPeriodStart = detail?.event?.time?.currentPeriodStartTimestamp || event.startTimestamp;

    matches.push({
      id: event.id,
      home: event.homeTeam.name,
      away: event.awayTeam.name,
      homeScore: event.homeScore.current,
      awayScore: event.awayScore.current,
      status: event.status.description,
      timestamp: currentPeriodStart
    });
  }

  await browser.close();
  return matches;
}

app.get('/api/livescores', async (req, res) => {
  try {
    const matches = await fetchLiveScores();
    res.json({ type: "live", matches });
  } catch (err) {
    console.error('❌ Failed to fetch live scores:', err.message);
    res.status(500).json({ error: "Failed to fetch live scores" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
