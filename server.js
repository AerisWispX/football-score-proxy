const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/api/livescores', async (req, res) => {
  try {
    const response = await axios.get('https://api.sofascore.com/api/v1/sport/football/events/live');
    res.json(response.data);
  } catch (error) {
    console.error('❌ Error fetching live scores:', error.message);
    res.status(500).json({ error: 'Failed to fetch live scores' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
