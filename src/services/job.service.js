const SyncJob = require('../db/models/job.model');

async function createJob(jobData) {
    const job = new SyncJob({
        source: jobData.source,
        entity: jobData.entity,
        entityId: jobData.entityId,
        eventType: jobData.eventType,
        payload: jobData.payload,
        status: 'PENDING'
    });
    return await job.save();
}

async function markCompleted(jobId) {
  await SyncJob.findByIdAndUpdate(jobId, {
    status: 'COMPLETED',
    completedAt: new Date(),
  });
}

async function markFailed(jobId, errorMessage) {
  const updatedJob = await SyncJob.findByIdAndUpdate(
    jobId,
    {
      lastError: errorMessage,
      $inc: { attempts: 1 },
      status: 'FAILED', 
    },
    { new: true } // Esto nos devuelve el documento ya incrementado
  );

  return updatedJob;
}

module.exports = { createJob, markCompleted, markFailed };