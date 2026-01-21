const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Health Dashboard - Coming Soon');
});

app.listen(PORT, () => {
  console.log(`Health dashboard running on port ${PORT}`);
});
