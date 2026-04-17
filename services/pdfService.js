import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

export const generateCertificatePDF = async ({
  userName, examName, score, percentage, certId, issuedAt,
  proctored, instructorName = null, certSettings = {},
  totalQuestions = null, timeTaken = null, difficulty = null,
}) => {
  const {
    certShowQRCode = true,
    certShowProctoredBadge = true,
    certShowInstructorName = true,
    certPrimaryColor = '#0366AC',
    certAccentColor = '#E3BE2C',
    certOrganizationName = 'ExamPrep AI',
    certFooterText = '',
  } = certSettings;

  const verifyUrl = `${CLIENT_URL}/verify/${certId}`;
  const qrBuffer = certShowQRCode
    ? await QRCode.toBuffer(verifyUrl, { type: 'png', width: 100, margin: 1, color: { dark: certPrimaryColor, light: '#ffffff' } })
    : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const buffers = [];

    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const W = doc.page.width;   // 841.89
    const H = doc.page.height;  // 595.28
    const PAD = 40;

    // ── Background ────────────────────────────────────────────
    doc.rect(0, 0, W, H).fill('#f8fafc');

    // Subtle diagonal pattern strips
    doc.save();
    doc.fillColor('#e2e8f0').opacity(0.4);
    for (let x = -H; x < W + H; x += 28) {
      doc.rect(x, 0, 8, H).fill();
    }
    doc.restore();

    // ── Outer double border ───────────────────────────────────
    doc.rect(PAD, PAD, W - PAD * 2, H - PAD * 2).lineWidth(3).strokeColor(certPrimaryColor).stroke();
    doc.rect(PAD + 6, PAD + 6, W - (PAD + 6) * 2, H - (PAD + 6) * 2).lineWidth(1).strokeColor(certAccentColor).stroke();

    // ── Top accent bar ────────────────────────────────────────
    doc.rect(PAD + 7, PAD + 7, W - (PAD + 7) * 2, 8).fill(certPrimaryColor);

    // ── Logo area ─────────────────────────────────────────────
    const logoY = PAD + 22;
    doc.fillColor(certPrimaryColor).roundedRect(W / 2 - 22, logoY, 44, 26, 4).fill();
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13).text('EP', W / 2 - 22, logoY + 6, { width: 44, align: 'center' });
    doc.fillColor(certPrimaryColor).font('Helvetica-Bold').fontSize(15).text(certOrganizationName, 0, logoY + 30, { align: 'center' });
    doc.fillColor(certAccentColor).font('Helvetica').fontSize(8).text('AI-POWERED EXAM PREPARATION', 0, logoY + 47, { align: 'center', characterSpacing: 2 });

    // ── Decorative title band ─────────────────────────────────
    const bandY = logoY + 64;
    doc.rect(0, bandY, W, 1.5).fill('#e2e8f0');
    doc.rect(0, bandY + 4, W, 1.5).fill('#e2e8f0');

    // Centered text block (not full-width)
    const titleBandW = 340;
    const titleBandX = W / 2 - titleBandW / 2;
    doc.fillColor('#334155').font('Helvetica-Bold').fontSize(11)
      .text('CERTIFICATE OF ACHIEVEMENT', titleBandX, bandY + 8, { width: titleBandW, align: 'center', characterSpacing: 2 });

    doc.rect(0, bandY + 24, W, 1.5).fill('#e2e8f0');
    doc.rect(0, bandY + 28, W, 1.5).fill('#e2e8f0');

    // ── Main content ──────────────────────────────────────────
    const contentY = bandY + 40;
    doc.fillColor('#475569').font('Helvetica').fontSize(11).text('This is to certify that', 0, contentY, { align: 'center' });

    // Name
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(26).text(userName, 0, contentY + 16, { align: 'center' });

    // Underline under name
    const nameW = Math.min(doc.widthOfString(userName, { fontSize: 26 }) + 40, W - 200);
    doc.moveTo(W / 2 - nameW / 2, contentY + 48)
      .lineTo(W / 2 + nameW / 2, contentY + 48)
      .lineWidth(1.5).strokeColor(certAccentColor).stroke();

    doc.fillColor('#475569').font('Helvetica').fontSize(11).text('has successfully completed', 0, contentY + 56, { align: 'center' });

    // Exam name — constrained width for centering
    doc.fillColor(certPrimaryColor).font('Helvetica-Bold').fontSize(17)
      .text(examName, PAD + 60, contentY + 72, { width: W - (PAD + 60) * 2, align: 'center' });

    // ── Score line ────────────────────────────────────────────
    const scoreY = contentY + 100;
    const scoreLine = `Score: ${percentage}%${score ? ` (${score})` : ''}`;
    doc.fillColor('#374151').font('Helvetica').fontSize(11)
      .text(scoreLine, 0, scoreY, { align: 'center' });

    // ── Date ──────────────────────────────────────────────────
    const dateStr = new Date(issuedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.fillColor('#64748b').font('Helvetica').fontSize(10)
      .text(`Issued on ${dateStr}`, 0, scoreY + 16, { align: 'center' });

    // ── Additional details row ────────────────────────────────
    const detailY = scoreY + 32;
    const details = [];
    if (totalQuestions) details.push(`${totalQuestions} Questions`);
    if (timeTaken) {
      const mins = Math.floor(timeTaken / 60);
      const secs = timeTaken % 60;
      details.push(`Time: ${mins}m ${secs}s`);
    }
    if (difficulty) details.push(`${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)} Difficulty`);
    if (proctored) details.push('AI Proctored');

    if (details.length > 0) {
      const detailText = details.join('  ·  ');
      doc.fillColor('#94a3b8').font('Helvetica').fontSize(8.5)
        .text(detailText, 0, detailY, { align: 'center', characterSpacing: 0.3 });
    }

    // ── Instructor line ───────────────────────────────────────
    const showInstructor = instructorName && certShowInstructorName;
    const instrY = detailY + (details.length > 0 ? 14 : 0);
    if (showInstructor) {
      doc.fillColor('#64748b').font('Helvetica').fontSize(9)
        .text(`Instructor: ${instructorName}`, 0, instrY, { align: 'center' });
    }

    // ── Proctored badge ───────────────────────────────────────
    if (proctored && certShowProctoredBadge) {
      const badgeW = 130;
      const badgeX = W / 2 - badgeW / 2;
      const badgeY = instrY + (showInstructor ? 16 : 2);
      doc.save().fillColor(certPrimaryColor).roundedRect(badgeX, badgeY, badgeW, 18, 4).fill();
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8)
        .text('VERIFIED  ·  AI PROCTORED', badgeX, badgeY + 5, { width: badgeW, align: 'center' });
      doc.restore();
    }

    // ── Footer text ───────────────────────────────────────────
    if (certFooterText) {
      doc.fillColor('#94a3b8').font('Helvetica').fontSize(7.5)
        .text(certFooterText, PAD + 10, H - PAD - 48, { width: W - PAD * 2 - 20, align: 'center' });
    }

    // ── QR Code ───────────────────────────────────────────────
    if (certShowQRCode && qrBuffer) {
      const qrSize = 64;
      const qrX = W - PAD - 28 - qrSize;
      const qrY = H - PAD - 28 - qrSize;
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
      doc.fillColor('#94a3b8').font('Helvetica').fontSize(6.5)
        .text('Scan to verify', qrX, qrY + qrSize + 2, { width: qrSize, align: 'center' });

      const idY = H - PAD - 22;
      doc.fillColor('#94a3b8').font('Helvetica').fontSize(7.5)
        .text(`Certificate ID: ${certId}`, PAD + 10, idY, { width: qrX - PAD - 20, align: 'left' });
      doc.fillColor('#94a3b8').font('Helvetica').fontSize(7)
        .text(verifyUrl, PAD + 10, idY + 11, { width: qrX - PAD - 20, align: 'left' });
    } else {
      const idY = H - PAD - 22;
      doc.fillColor('#94a3b8').font('Helvetica').fontSize(7.5)
        .text(`Certificate ID: ${certId}  ·  Verify: ${verifyUrl}`, PAD + 10, idY, { width: W - PAD * 2 - 20, align: 'center' });
    }

    // ── Bottom accent bar ────────────────────────────────────
    doc.rect(PAD + 7, H - PAD - 14, W - (PAD + 7) * 2, 7).fill(certPrimaryColor);

    doc.end();
  });
};
