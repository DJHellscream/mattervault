/**
 * Alerter - Rule-based alerting system with pluggable transports
 * Evaluates service status and metrics against rules, sends notifications
 */

const fs = require('fs');
const path = require('path');

class Alerter {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.transports = config.transports || ['console'];
    this.cooldownMinutes = config.cooldownMinutes || 5;
    this.alertsFile = path.join(__dirname, '../data/alerts.log');

    // Track when alerts were last fired to avoid spam
    this.lastAlertTime = {};

    // Default alert rules
    this.rules = [
      {
        id: 'service-down',
        name: 'Service Down',
        severity: 'critical',
        condition: (service, status) => status.status === 'down',
        message: (service) => `${service.name} is DOWN`
      },
      {
        id: 'qdrant-empty',
        name: 'Qdrant Empty',
        severity: 'critical',
        condition: (service, status, metrics) =>
          service.type === 'qdrant' && metrics?.vector_count === 0,
        message: (service) => `Qdrant has 0 vectors - search will not work!`
      },
      {
        id: 'paperless-empty',
        name: 'Paperless Empty',
        severity: 'warning',
        condition: (service, status, metrics) =>
          service.type === 'paperless' && metrics?.document_count === 0,
        message: (service) => `Paperless has 0 documents`
      },
      {
        id: 'chatui-db-down',
        name: 'Chat-UI Database Down',
        severity: 'critical',
        condition: (service, status, metrics) =>
          service.type === 'chatui' && metrics?.db_connected === false,
        message: (service) => `Chat-UI database connection is down`
      },
      {
        id: 'chatui-redis-down',
        name: 'Chat-UI Redis Down',
        severity: 'warning',
        condition: (service, status, metrics) =>
          service.type === 'chatui' && metrics?.redis_connected === false,
        message: (service) => `Chat-UI Redis connection is down (sessions may not work)`
      },
      {
        id: 'no-recent-queries',
        name: 'No Recent Queries',
        severity: 'info',
        condition: (service, status, metrics) => {
          if (service.type !== 'chatui' || !metrics?.last_query_at) return false;
          const lastQuery = new Date(metrics.last_query_at);
          const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
          return lastQuery < hourAgo;
        },
        message: (service, status, metrics) => {
          const lastQuery = new Date(metrics.last_query_at);
          const minutesAgo = Math.round((Date.now() - lastQuery) / 60000);
          return `No chat queries in the last ${minutesAgo} minutes`;
        }
      },
      {
        id: 'high-redis-memory',
        name: 'High Redis Memory',
        severity: 'warning',
        condition: (service, status, metrics) =>
          service.type === 'redis' && metrics?.memory_used_mb > 500,
        message: (service, status, metrics) =>
          `Redis memory usage is high: ${metrics.memory_used_mb}MB`
      }
    ];
  }

  /**
   * Evaluate all rules for a service
   * @param {Object} service - Service config
   * @param {Object} status - Health check status
   * @param {Object} metrics - Collected metrics (optional)
   * @returns {Array} Array of triggered alerts
   */
  evaluate(service, status, metrics = {}) {
    if (!this.enabled) return [];

    const alerts = [];

    for (const rule of this.rules) {
      try {
        if (rule.condition(service, status, metrics)) {
          const alertKey = `${service.id}:${rule.id}`;

          // Check cooldown
          if (this.isInCooldown(alertKey)) {
            continue;
          }

          const alert = {
            id: `${Date.now()}-${alertKey}`,
            ruleId: rule.id,
            ruleName: rule.name,
            serviceId: service.id,
            serviceName: service.name,
            severity: rule.severity,
            message: typeof rule.message === 'function'
              ? rule.message(service, status, metrics)
              : rule.message,
            timestamp: new Date().toISOString(),
            status,
            metrics
          };

          alerts.push(alert);
          this.lastAlertTime[alertKey] = Date.now();
        }
      } catch (err) {
        console.error(`Error evaluating rule ${rule.id} for ${service.id}:`, err.message);
      }
    }

    return alerts;
  }

  /**
   * Check if alert is in cooldown period
   */
  isInCooldown(alertKey) {
    const lastTime = this.lastAlertTime[alertKey];
    if (!lastTime) return false;

    const cooldownMs = this.cooldownMinutes * 60 * 1000;
    return Date.now() - lastTime < cooldownMs;
  }

  /**
   * Send alerts through configured transports
   * @param {Array} alerts - Array of alert objects
   */
  async send(alerts) {
    if (!alerts || alerts.length === 0) return;

    for (const alert of alerts) {
      for (const transport of this.transports) {
        try {
          await this.sendViaTransport(transport, alert);
        } catch (err) {
          console.error(`Failed to send alert via ${transport}:`, err.message);
        }
      }
    }
  }

  /**
   * Send alert via specific transport
   */
  async sendViaTransport(transport, alert) {
    switch (transport) {
      case 'console':
        this.sendToConsole(alert);
        break;
      case 'file':
        this.sendToFile(alert);
        break;
      case 'webhook':
        await this.sendToWebhook(alert);
        break;
      case 'email':
        // Deprecated: Use 'webhook' transport with n8n instead
        console.log('[ALERT] Use webhook transport for email alerts via n8n');
        break;
      default:
        console.warn(`Unknown alert transport: ${transport}`);
    }
  }

  /**
   * Webhook transport - POST alert to n8n for email/notifications
   */
  async sendToWebhook(alert) {
    const webhookUrl = process.env.ALERT_WEBHOOK_URL;

    if (!webhookUrl) {
      console.warn('[ALERT] Webhook transport enabled but ALERT_WEBHOOK_URL not set');
      return;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert)
      });

      if (!response.ok) {
        console.error(`[ALERT] Webhook failed: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      console.error(`[ALERT] Webhook error: ${err.message}`);
    }
  }

  /**
   * Console transport - log alert to stdout
   */
  sendToConsole(alert) {
    const severityColors = {
      critical: '\x1b[31m', // Red
      warning: '\x1b[33m',  // Yellow
      info: '\x1b[36m',     // Cyan
    };
    const reset = '\x1b[0m';
    const color = severityColors[alert.severity] || '';

    console.log(
      `${color}[ALERT ${alert.severity.toUpperCase()}]${reset} ` +
      `[${alert.serviceName}] ${alert.message} ` +
      `(${alert.timestamp})`
    );
  }

  /**
   * File transport - append alert to alerts.log
   */
  sendToFile(alert) {
    const logEntry = JSON.stringify({
      timestamp: alert.timestamp,
      severity: alert.severity,
      service: alert.serviceName,
      rule: alert.ruleName,
      message: alert.message
    }) + '\n';

    // Ensure data directory exists
    const dataDir = path.dirname(this.alertsFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.appendFileSync(this.alertsFile, logEntry);
  }

  /**
   * Get recent alerts from file
   * @param {number} limit - Max number of alerts to return
   * @returns {Array} Recent alerts
   */
  getRecentAlerts(limit = 50) {
    try {
      if (!fs.existsSync(this.alertsFile)) {
        return [];
      }

      const content = fs.readFileSync(this.alertsFile, 'utf8');
      const lines = content.trim().split('\n').filter(l => l);
      const alerts = lines
        .slice(-limit)
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(a => a !== null)
        .reverse(); // Most recent first

      return alerts;
    } catch (err) {
      console.error('Error reading alerts file:', err.message);
      return [];
    }
  }

  /**
   * Clear all alerts from file
   */
  clearAlerts() {
    try {
      if (fs.existsSync(this.alertsFile)) {
        fs.writeFileSync(this.alertsFile, '');
        console.log('[ALERT] Alerts cleared');
      }
    } catch (err) {
      console.error('Error clearing alerts file:', err.message);
    }
  }

  /**
   * Clear old alerts from file (keep last N days)
   * @param {number} days - Number of days to keep
   */
  pruneAlerts(days = 7) {
    try {
      if (!fs.existsSync(this.alertsFile)) return;

      const content = fs.readFileSync(this.alertsFile, 'utf8');
      const lines = content.trim().split('\n').filter(l => l);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const filtered = lines.filter(line => {
        try {
          const alert = JSON.parse(line);
          return new Date(alert.timestamp) > cutoff;
        } catch {
          return false;
        }
      });

      fs.writeFileSync(this.alertsFile, filtered.join('\n') + '\n');
    } catch (err) {
      console.error('Error pruning alerts file:', err.message);
    }
  }

  /**
   * Clear an alert from cooldown (for recovery notifications)
   */
  clearCooldown(serviceId, ruleId) {
    const alertKey = `${serviceId}:${ruleId}`;
    delete this.lastAlertTime[alertKey];
  }

  /**
   * Handle service recovery - clear cooldowns and optionally notify
   */
  handleRecovery(service, previousStatus, currentStatus) {
    if (previousStatus?.status === 'down' && currentStatus?.status === 'up') {
      this.clearCooldown(service.id, 'service-down');

      // Log recovery
      console.log(
        `\x1b[32m[RECOVERY]\x1b[0m ` +
        `[${service.name}] Service is back UP`
      );
    }
  }
}

module.exports = { Alerter };
