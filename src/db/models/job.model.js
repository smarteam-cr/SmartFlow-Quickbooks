const mongoose = require('mongoose');

const syncJobSchema = new mongoose.Schema(
  {
    entity: {
      type: String,
      required: true,
      enum: ['contact', 'company', 'product', 'invoice', 'payment'],
    },
    hsObjectId: {
      type: String,
      required: true,
    },
    eventType: {
      type: String,
      required: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED'],
      default: 'PENDING',
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('SyncJob', syncJobSchema);