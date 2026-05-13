import { getSettings } from '../models/SystemSettings.js';

/**
 * Line-item breakdown for enterprise monthly estimate (INR paise).
 * Aligns with computeEnterpriseMonthlyCost in enterpriseController.
 */
export async function getEnterpriseBillingBreakdown(ent) {
  if (!ent) return null;
  const s = await getSettings();
  const perTeacher = Number(s.enterpriseCostPerTeacher) || 0;
  const perExam = Number(s.enterpriseCostPerExam) || 0;
  const perQuestion = Number(s.enterpriseCostPerQuestion) || 0;
  const proctorCost = Number(s.enterpriseCostAiProctoring) || 0;

  const teacherSeats = Math.max(0, Math.floor(Number(ent.teacherLimit) || 0));
  const examsPerTeacher = Math.max(0, Math.floor(Number(ent.examsPerTeacherLimit) || 0));
  const questionsPerExam = Math.max(0, Math.floor(Number(ent.questionsPerExamLimit) || 0));
  const proctorOn = ent.aiProctoringEnabled !== false;

  const lineTeacherSeats = teacherSeats * perTeacher;
  const examSlots = teacherSeats * examsPerTeacher;
  const lineExamOps = examSlots * perExam;
  const questionSlots = examSlots * questionsPerExam;
  const lineQuestionOps = questionSlots * perQuestion;
  const lineProctoring = proctorOn ? proctorCost : 0;
  const formulaTotal = lineTeacherSeats + lineExamOps + lineQuestionOps + lineProctoring;

  const storedFormula = Math.round(Number(ent.estimatedMonthlyCost) || 0);
  const formulaMonthlyPaise = storedFormula > 0 ? storedFormula : formulaTotal;

  const usesManualOverride = ent.estimatedMonthlyCostManualPaise != null && Number(ent.estimatedMonthlyCostManualPaise) >= 100;
  const manualPaise = usesManualOverride ? Math.round(Number(ent.estimatedMonthlyCostManualPaise)) : null;
  const effectiveMonthlyPaise = usesManualOverride ? manualPaise : formulaMonthlyPaise;

  return {
    currency: 'INR',
    unit: 'paise',
    usesManualOverride,
    manualMonthlyPaise: manualPaise,
    formulaMonthlyPaise,
    effectiveMonthlyPaise,
    rateCardPaise: {
      perTeacherSeat: perTeacher,
      perExamAllocation: perExam,
      perQuestionSlot: perQuestion,
      aiProctoringFlat: proctorCost,
    },
    limits: {
      teacherSeats: teacherSeats,
      examsPerTeacherMonth: examsPerTeacher,
      questionsPerExam: questionsPerExam,
      studentCap: ent.studentLimit ?? 2000,
      aiProctoringIncluded: proctorOn,
    },
    lines: [
      {
        id: 'teacher_seats',
        label: 'Teacher seats',
        detail: `${teacherSeats} licensed seats × ₹${(perTeacher / 100).toFixed(0)} / seat`,
        subtotalPaise: lineTeacherSeats,
      },
      {
        id: 'exam_capacity',
        label: 'AI exam capacity',
        detail: `${examSlots} exam slots / mo (${teacherSeats} × ${examsPerTeacher}) × ₹${(perExam / 100).toFixed(0)}`,
        subtotalPaise: lineExamOps,
      },
      {
        id: 'question_capacity',
        label: 'Question-generation capacity',
        detail: `${questionSlots.toLocaleString('en-IN')} question-slots / mo × ₹${(perQuestion / 100).toFixed(0)}`,
        subtotalPaise: lineQuestionOps,
      },
      {
        id: 'proctoring',
        label: 'AI proctoring',
        detail: proctorOn ? `Platform add-on × ₹${(proctorCost / 100).toFixed(0)} / mo` : 'Not included in formula',
        subtotalPaise: lineProctoring,
      },
    ],
    formulaSubtotalPaise: formulaTotal,
  };
}
