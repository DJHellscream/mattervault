const { Scheduler } = require('./scheduler');

describe('Scheduler', () => {
  test('schedules a job and executes callback', (done) => {
    const scheduler = new Scheduler();
    let callCount = 0;

    const service = {
      id: 'test',
      interval: 1 // 1 second for testing
    };

    scheduler.schedule(service, () => {
      callCount++;
      if (callCount >= 1) {
        scheduler.stop(service.id);
        expect(callCount).toBeGreaterThanOrEqual(1);
        done();
      }
    });

    // The callback should fire immediately on schedule
  }, 5000);

  test('stops a scheduled job', () => {
    const scheduler = new Scheduler();
    const service = { id: 'test', interval: 60 };

    scheduler.schedule(service, () => {});
    expect(scheduler.isRunning(service.id)).toBe(true);

    scheduler.stop(service.id);
    expect(scheduler.isRunning(service.id)).toBe(false);
  });

  test('stops all scheduled jobs', () => {
    const scheduler = new Scheduler();

    scheduler.schedule({ id: 'test1', interval: 60 }, () => {});
    scheduler.schedule({ id: 'test2', interval: 60 }, () => {});

    scheduler.stopAll();

    expect(scheduler.isRunning('test1')).toBe(false);
    expect(scheduler.isRunning('test2')).toBe(false);
  });
});
