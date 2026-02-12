const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

console.log('Starting test server...');
console.log('PORT:', PORT);

app.get('/health', (req, res) => {
  console.log('Health check received');
  res.status(200).json({ status: 'ok' });
});

app.get('/', (req, res) => {
  console.log('Root request received');
  res.send('Test server is running!');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Test server listening on 0.0.0.0:${PORT}`);
});
