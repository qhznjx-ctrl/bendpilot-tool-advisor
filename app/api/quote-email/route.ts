import { env } from "cloudflare:workers";

type QuoteEmailPayload = {
  quoteNo?: string;
  filename?: string;
  pdfBase64?: string;
  projectName?: string;
  punchArticle?: string;
  dieArticle?: string;
  customer?: {
    company?: string;
    contact?: string;
    phone?: string;
    email?: string;
    address?: string;
    note?: string;
  };
};

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function runtimeValue(name: string) {
  const runtimeEnv = env as unknown as Record<string, unknown>;
  return cleanText(runtimeEnv[name], 500);
}

export async function POST(request: Request) {
  let payload: QuoteEmailPayload;
  try {
    payload = await request.json() as QuoteEmailPayload;
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }

  const quoteNo = cleanText(payload.quoteNo, 80);
  const filename = cleanText(payload.filename, 140).replace(/[\\/:*?"<>|]/g, "-");
  const rawPdfBase64 = typeof payload.pdfBase64 === "string" ? payload.pdfBase64.trim() : "";
  if (rawPdfBase64.length > 12_000_000) {
    return Response.json({ error: "PDF 附件超过 9 MB 限制" }, { status: 413 });
  }
  const pdfBase64 = rawPdfBase64;
  const company = cleanText(payload.customer?.company, 120);
  const contact = cleanText(payload.customer?.contact, 80);
  const phone = cleanText(payload.customer?.phone, 80);
  const email = cleanText(payload.customer?.email, 160);
  const address = cleanText(payload.customer?.address, 200);
  const note = cleanText(payload.customer?.note, 500);
  const projectName = cleanText(payload.projectName, 120);
  const punchArticle = cleanText(payload.punchArticle, 80);
  const dieArticle = cleanText(payload.dieArticle, 80);

  if (!quoteNo || !filename || !pdfBase64 || !company || !contact) {
    return Response.json({ error: "询价单编号、PDF、客户名称和联系人不能为空" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(pdfBase64)) {
    return Response.json({ error: "PDF 附件编码无效" }, { status: 400 });
  }
  const resendApiKey = runtimeValue("RESEND_API_KEY");
  const recipientText = runtimeValue("QUOTE_RECIPIENT_EMAIL");
  const from = runtimeValue("QUOTE_FROM_EMAIL");
  if (!resendApiKey || !recipientText || !from) {
    return Response.json({
      emailed: false,
      configured: false,
      message: "PDF 已在本地生成；配置后台邮件变量后将自动发送副本。",
    });
  }

  const recipients = recipientText.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 5);
  if (recipients.length === 0) {
    return Response.json({ error: "后台收件邮箱配置无效" }, { status: 500 });
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: recipients,
      reply_to: email || undefined,
      subject: `【模具询价】${quoteNo} · ${company} · ${projectName}`,
      html: `
        <div style="font-family:Arial,'Microsoft YaHei',sans-serif;color:#243b31;line-height:1.65">
          <h2 style="color:#176f49">BendPilot 模具询价单</h2>
          <p><strong>询价单号：</strong>${escapeHtml(quoteNo)}</p>
          <p><strong>客户：</strong>${escapeHtml(company)} · ${escapeHtml(contact)}</p>
          <p><strong>联系方式：</strong>${escapeHtml(phone || "-")} / ${escapeHtml(email || "-")}</p>
          <p><strong>地址：</strong>${escapeHtml(address || "-")}</p>
          <p><strong>项目：</strong>${escapeHtml(projectName)}</p>
          <p><strong>所选模具：</strong>上模 ${escapeHtml(punchArticle)}；下模 ${escapeHtml(dieArticle)}</p>
          <p><strong>客户备注：</strong>${escapeHtml(note || "无")}</p>
          <p style="color:#6f7f77">正式 PDF 已作为附件随本邮件发送。</p>
        </div>
      `,
      attachments: [{ filename, content: pdfBase64 }],
    }),
  });

  if (!response.ok) {
    const detail = cleanText(await response.text(), 800);
    return Response.json({ error: `邮件服务发送失败：${detail || response.status}` }, { status: 502 });
  }

  const result = await response.json() as { id?: string };
  return Response.json({ emailed: true, configured: true, emailId: result.id ?? null });
}
