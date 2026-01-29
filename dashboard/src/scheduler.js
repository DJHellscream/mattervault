const cron = require('node-cron');

class Scheduler {
  constructor() {
    this.jobs = new Map();
  }

  schedule(service, callback) {
    if (this.jobs.has(service.id)) {
      this.stop(service.id);
    }

    // Convert seconds to cron expression
    // For intervals < 60s, use setInterval instead
    if (service.interval < 60) {
      const intervalId = setInterval(callback, service.interval * 1000);
      this.jobs.set(service.id, { type: 'interval', id: intervalId });
      // Run immediately on schedule
      callback();
    } else {
      // For 60+ seconds, use cron with minute-level granularity
      const minutes = Math.floor(service.interval / 60);
      const cronExpression = `*/${minutes} * * * *`;

      const job = cron.schedule(cronExpression, callback);
      this.jobs.set(service.id, { type: 'cron', job });
      // Run immediately on schedule
      callback();
    }
  }

  stop(serviceId) {
    const jobInfo = this.jobs.get(serviceId);
    if (jobInfo) {
      if (jobInfo.type === 'interval') {
        clearInterval(jobInfo.id);
      } else if (jobInfo.type === 'cron') {
        jobInfo.job.stop();
      }
      this.jobs.delete(serviceId);
    }
  }

  stopAll() {
    for (const serviceId of this.jobs.keys()) {
      this.stop(serviceId);
    }
  }

  isRunning(serviceId) {
    return this.jobs.has(serviceId);
  }
}

module.exports = { Scheduler };
