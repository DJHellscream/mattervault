const fs = require('fs');
const path = require('path');

class Storage {
  constructor(filePath) {
    this.filePath = filePath;
    this.ensureDirectory();
  }

  ensureDirectory() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return {};
      }
      const content = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      console.error('Error loading storage:', error.message);
      return {};
    }
  }

  save(data) {
    const tempPath = this.filePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  updateService(serviceId, result) {
    const data = this.load();

    if (!data[serviceId]) {
      data[serviceId] = { current: null, history: [] };
    }

    data[serviceId].current = result;
    data[serviceId].history.push({
      timestamp: result.lastCheck,
      status: result.status,
      responseTime: result.responseTime
    });

    this.save(data);
  }

  pruneHistory(retentionHours) {
    const data = this.load();
    const cutoff = Date.now() - (retentionHours * 60 * 60 * 1000);

    for (const serviceId of Object.keys(data)) {
      if (data[serviceId].history) {
        data[serviceId].history = data[serviceId].history.filter(entry => {
          return new Date(entry.timestamp).getTime() > cutoff;
        });
      }
    }

    this.save(data);
  }

  getServiceData(serviceId) {
    const data = this.load();
    return data[serviceId] || null;
  }

  getAllServices() {
    return this.load();
  }
}

module.exports = { Storage };
