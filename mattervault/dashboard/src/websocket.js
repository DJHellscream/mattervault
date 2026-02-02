const WebSocket = require('ws');

function setupWebSocket(server, setBroadcast) {
  const wss = new WebSocket.Server({ server, path: '/ws' });
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('WebSocket client connected');

    ws.on('close', () => {
      clients.delete(ws);
      console.log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
      clients.delete(ws);
    });
  });

  // Set up broadcast function
  const broadcast = (message) => {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  };

  setBroadcast(broadcast);

  return wss;
}

module.exports = { setupWebSocket };
