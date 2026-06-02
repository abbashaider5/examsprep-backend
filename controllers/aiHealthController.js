import { AppError } from '../middleware/errorHandler.js';
import { formatAiTraceTree, getAiRequestReport } from '../services/ai/aiRequestTrace.js';
import {
  getActiveIncidentSummary,
  getIncidentById,
  listRecentIncidents,
} from '../services/aiHealthService.js';

export async function getActiveAiHealth(req, res, next) {
  try {
    const active = await getActiveIncidentSummary();
    res.json({ active });
  } catch (err) {
    next(err);
  }
}

export async function listAiIncidents(req, res, next) {
  try {
    const incidents = await listRecentIncidents(30);
    res.json({ incidents });
  } catch (err) {
    next(err);
  }
}

/** Last request AI trace (current async context — useful right after createExam in same worker). */
export async function getLastAiRequestTrace(req, res) {
  const report = getAiRequestReport();
  res.json({ ...report, tree: formatAiTraceTree(report) });
}

export async function getAiIncidentDetail(req, res, next) {
  try {
    const data = await getIncidentById(req.params.id);
    if (!data) return next(new AppError('AI incident not found', 404));
    res.json(data);
  } catch (err) {
    next(err);
  }
}
