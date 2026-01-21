const express = require('express');

function createApiRouter(storage, config, scheduler, healthChecker, broadcast) {
  const router = express.Router();

  // GET /api/status - all services status
  router.get('/status', (req, res) => {
    const data = storage.getAllServices();
    const services = {};
    let up = 0;
    let down = 0;

    for (const service of config.services) {
      const serviceData = data[service.id];
      if (serviceData && serviceData.current) {
        services[service.id] = serviceData.current;
        if (serviceData.current.status === 'up') up++;
        else down++;
      } else {
        services[service.id] = { status: 'unknown', lastCheck: null };
      }
    }

    res.json({
      services,
      summary: { total: config.services.length, up, down }
    });
  });

  // GET /api/status/:serviceId - single service with history
  router.get('/status/:serviceId', (req, res) => {
    const serviceData = storage.getServiceData(req.params.serviceId);
    if (!serviceData) {
      return res.status(404).json({ error: 'Service not found' });
    }
    res.json(serviceData);
  });

  // GET /api/config - current configuration
  router.get('/config', (req, res) => {
    res.json(config);
  });

  // PUT /api/config/services/:serviceId - update service config
  router.put('/config/services/:serviceId', (req, res) => {
    const serviceIndex = config.services.findIndex(s => s.id === req.params.serviceId);
    if (serviceIndex === -1) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const updates = req.body;
    const allowed = ['url', 'interval', 'timeout', 'name'];

    for (const key of Object.keys(updates)) {
      if (allowed.includes(key)) {
        config.services[serviceIndex][key] = updates[key];
      }
    }

    // Reschedule if interval changed
    if (updates.interval) {
      const service = config.services[serviceIndex];
      scheduler.schedule(service, async () => {
        const result = await healthChecker.check(service);
        storage.updateService(service.id, result);
        broadcast({ type: 'status', service: service.id, data: result });
      });
    }

    res.json(config.services[serviceIndex]);
  });

  // POST /api/check/:serviceId - trigger immediate check
  router.post('/check/:serviceId', async (req, res) => {
    const service = config.services.find(s => s.id === req.params.serviceId);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const result = await healthChecker.check(service);
    storage.updateService(service.id, result);
    broadcast({ type: 'status', service: service.id, data: result });

    res.json(result);
  });

  return router;
}

module.exports = { createApiRouter };
