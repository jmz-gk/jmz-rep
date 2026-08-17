async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email:', subject);
    return;
  }
  const from = process.env.EMAIL_FROM || 'Halyard House <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to, subject, html })
    });
    if (!res.ok) {
      console.error('Email send failed:', res.status, await res.text());
    }
  } catch (e) {
    console.error('Email send error:', e.message);
  }
}

module.exports = { sendEmail };
