import { body, validationResult } from 'express-validator';

export const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: 'Validation failed', errors: errors.array() });
  }
  next();
};

// gmail_remove_dots: false — preserve dots in email addresses (e.g. abbas.haider@gmail.com)
const emailNormalizeOpts = { gmail_remove_dots: false, all_lowercase: true };

export const signupValidation = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 60 }),
  body('email').isEmail().normalizeEmail(emailNormalizeOpts).withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

export const loginValidation = [
  body('email').isEmail().normalizeEmail(emailNormalizeOpts),
  body('password').notEmpty().withMessage('Password required'),
];

export const examValidation = [
  body('title').trim().notEmpty().withMessage('Exam title is required'),
  body('subject').trim().notEmpty().withMessage('Subject is required'),
  body('difficulty').isIn(['easy', 'medium', 'hard']).withMessage('Invalid difficulty'),
  body('numQuestions').isInt({ min: 5, max: 30 }).withMessage('Questions must be between 5 and 30'),
];
