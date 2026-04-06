const SyncJob = require('../db/models/job.model');

async function createJob(entity, hsObjectId, eventType, payload) {
  const job = new SyncJob({
    entity,
    hsObjectId: hsObjectId.toString(),
    eventType,
    payload,
    status: 'PENDING',
  });
  await job.save();
  return job;
}

async function markCompleted(jobId) {
  await SyncJob.findByIdAndUpdate(jobId, {
    status: 'COMPLETED',
    completedAt: new Date(),
  });
}

async function markFailed(jobId, errorMessage) {
  await SyncJob.findByIdAndUpdate(jobId, {
    status: 'FAILED',
    lastError: errorMessage,
    $inc: { attempts: 1 },
  });
}

module.exports = { createJob, markCompleted, markFailed };