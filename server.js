const express = require('express');
const axios = require('axios');
const app = express();
const PORT = 3000;

app.use(express.static(__dirname));

app.get('/api/livescores', async (req, res) => {
  try {
    const response = await axios.get(
      'https://api.sofascore.com/api/v1/sport/football/events/live',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      }
    );
    res.json(response.data);
  } catch (err) {
    console.error('❌ Error fetching live scores:', err.message);
    res.status(500).json({ error: 'Failed to fetch live data' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
