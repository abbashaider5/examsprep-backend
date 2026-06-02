import express from 'express';
import {
  cancelAutoRenew,
  createOrder,
  createSubscriptionCheckout,
  disableAutoRenew,
  enableAutoRenew,
  getBillingCatalog,
  getMySubscription,
  getMyTransactions,
  getSubscriptionManagementPortal,
  getUpgradeQuote,
  getTransactionInvoice,
  razorpayWebhook,
  verifyPayment,
} from '../controllers/paymentController.js';
import { listPublicPlans } from '../controllers/planController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Webhook must be public and signature-verified.
router.post('/webhook', razorpayWebhook);

router.use(protect);
router.get('/plans', listPublicPlans);
router.post('/create-order', createOrder);
router.post('/create-subscription', createSubscriptionCheckout);
router.post('/verify', verifyPayment);
router.post('/autopay/enable', enableAutoRenew);
router.post('/autopay/disable', disableAutoRenew);
router.post('/autopay/cancel', cancelAutoRenew);
router.post('/upgrade-quote', getUpgradeQuote);
router.get('/autopay/management', getSubscriptionManagementPortal);
router.get('/subscription', getMySubscription);
router.get('/billing-catalog', getBillingCatalog);
router.get('/transactions/:transactionId/invoice', getTransactionInvoice);
router.get('/transactions', getMyTransactions);

export default router;
