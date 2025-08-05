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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
        'Referer': 'https://www.sofascore.com/',
        'Origin': 'https://www.sofascore.com'
      }
    });

    // Check if valid response
    if (!response.data || !Array.isArray(response.data.events)) {
      return res.status(500).json({ error: 'Invalid response format from SofaScore.' });
    }

    res.json({ events: response.data.events });

  } catch (error) {
    console.error('❌ Proxy fetch failed:', error.message);
    if (error.response) {
      res.status(error.response.status).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Unknown server error occurred.' });
    }
  }
});

app.listen(PORT, () => {
  console.log(`✅ Proxy server running on port ${PORT}`);
});
