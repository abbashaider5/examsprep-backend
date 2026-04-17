import express from 'express';
import { createOrder, getMySubscription, getMyTransactions, verifyPayment } from '../controllers/paymentController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.use(protect);
router.post('/create-order', createOrder);
router.post('/verify', verifyPayment);
router.get('/subscription', getMySubscription);
router.get('/transactions', getMyTransactions);

export default router;
