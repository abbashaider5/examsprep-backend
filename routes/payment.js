import express from 'express';
import {
  createOrder,
  getBillingCatalog,
  getMySubscription,
  getMyTransactions,
  getTransactionInvoice,
  verifyPayment,
} from '../controllers/paymentController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.use(protect);
router.post('/create-order', createOrder);
router.post('/verify', verifyPayment);
router.get('/subscription', getMySubscription);
router.get('/billing-catalog', getBillingCatalog);
router.get('/transactions/:transactionId/invoice', getTransactionInvoice);
router.get('/transactions', getMyTransactions);

export default router;
