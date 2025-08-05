const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());

const PORT = process.env.PORT || 10000;

app.get('/api/livescores', async (req, res) => {
  try {
    const response = await axios.get('https://api.sofascore.com/api/v1/sport/football/events/live', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
      }
    });

    if (!response.data || !Array.isArray(response.data.events)) {
      return res.status(500).json({ error: 'Invalid data format received from upstream.' });
    }

    res.json({ events: response.data.events });
  } catch (error) {
    console.error('❌ Error fetching live scores:', error.message);
    res.status(500).json({ error: 'Failed to fetch live scores.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
