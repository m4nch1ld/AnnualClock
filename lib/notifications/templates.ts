/**
 * Email templates: short, branded, table-based HTML that renders in Outlook,
 * plus a plain-text alternative. Pure functions, no I/O.
 */
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface Button {
  label: string;
  url: string;
  primary?: boolean;
}

function button(b: Button) {
  const bg = b.primary ? "#26645F" : "#ffffff";
  const fg = b.primary ? "#ffffff" : "#26645F";
  return `<a href="${esc(b.url)}" style="display:inline-block;padding:10px 18px;margin:0 8px 8px 0;border-radius:6px;border:1px solid #26645F;background:${bg};color:${fg};font-weight:600;text-decoration:none;font-size:14px">${esc(b.label)}</a>`;
}

export function layout(opts: { preheader: string; heading: string; bodyHtml: string; buttons?: Button[]; footer?: string }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(opts.heading)}</title></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:Poppins,Segoe UI,Arial,sans-serif;color:#212529">
<span style="display:none;max-height:0;overflow:hidden">${esc(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #D9E0E6;border-radius:10px;overflow:hidden">
<tr><td style="background:#12191D;padding:14px 24px;color:#F8FAFC;font-size:14px;letter-spacing:.04em">ESL SHIPPING &middot; ANNUAL CLOCK</td></tr>
<tr><td style="height:3px;background:#1AB24B;line-height:3px;font-size:0">&nbsp;</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:20px;font-weight:600;color:#212529">${esc(opts.heading)}</h1>
${opts.bodyHtml}
${opts.buttons?.length ? `<div style="margin-top:20px">${opts.buttons.map(button).join("")}</div>` : ""}
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #D9E0E6;color:#515B65;font-size:12px">${opts.footer ?? "You receive this because you are subscribed to this clock. Manage notifications in the Annual Clock settings."}</td></tr>
</table></td></tr></table></body></html>`;
}

export function renderSignInEmail(p: { url: string; email: string }): RenderedEmail {
  return {
    subject: "Your sign-in link for ESL Annual Clock",
    html: layout({
      preheader: "Sign in to ESL Annual Clock",
      heading: "Sign in to ESL Annual Clock",
      bodyHtml: `<p style="margin:0;font-size:14px;line-height:1.6">Use the button below to sign in as <strong>${esc(p.email)}</strong>. The link can be used once and expires in one hour.</p>`,
      buttons: [{ label: "Sign in", url: p.url, primary: true }],
      footer: "If you did not request this, you can ignore this email.",
    }),
    text: `Sign in to ESL Annual Clock as ${p.email}:\n${p.url}\n\nThe link can be used once and expires in one hour.`,
  };
}

export function renderInviteEmail(p: { url: string; clockName: string; role: string; inviter: string }): RenderedEmail {
  return {
    subject: `You have been invited to the ${p.clockName} annual clock`,
    html: layout({
      preheader: `${p.inviter} invited you to ${p.clockName}`,
      heading: `Invitation: ${p.clockName}`,
      bodyHtml: `<p style="margin:0;font-size:14px;line-height:1.6">${esc(p.inviter)} gave you <strong>${esc(p.role)}</strong> access to the <strong>${esc(p.clockName)}</strong> annual clock.</p>`,
      buttons: [{ label: "Open the clock", url: p.url, primary: true }],
      footer: "The sign-in link can be used once. You can always request a new one on the sign-in page.",
    }),
    text: `${p.inviter} gave you ${p.role} access to the ${p.clockName} annual clock.\nOpen: ${p.url}`,
  };
}
