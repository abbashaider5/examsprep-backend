import express from 'express';
import {
  getHelpTopic,
  listHelpTopics,
} from '../controllers/helpTopicController.js';
import { optionalProtect } from '../middleware/auth.js';

const router = express.Router();

router.get('/topics', optionalProtect, listHelpTopics);
router.get('/topics/:topicId', optionalProtect, getHelpTopic);

export default router;
