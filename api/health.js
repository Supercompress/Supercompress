const { json } = require("./_lib/http");

function normalizeDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Enter a website domain.');
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname.includes('@') || !url.hostname.includes('.')) throw new Error('Only public website domains can be assessed.');
  return url.hostname.toLowerCase();
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    fit_score: { type: 'integer', minimum: 64, maximum: 96, description: 'Rate how well SuperCompress fits this product from 64 to 96. Be constructive and fairly optimistic when a plausible AI or context-heavy workflow is visible.' },
    ai_workflow_strength: { type: 'integer', minimum: 0, maximum: 10, description: 'How strongly the public site indicates an AI workflow, where 0 is none and 10 is clearly central to the product.' },
    context_volume_signal: { type: 'integer', minimum: 0, maximum: 10, description: 'How strongly the public site indicates growing chat, retrieval, memory, documents, tool output, or other model context.' },
    compression_opportunity: { type: 'integer', minimum: 0, maximum: 10, description: 'How promising context compression appears for this product, where 0 is weak and 10 is highly promising.' },
    company_summary: { type: 'string', description: 'In one or two sentences, what does this company or product do?' },
    ai_surface: { type: 'string', description: 'What AI, machine learning, chatbot, search, copilot, agent, RAG, automation, or API capabilities are visible?' },
    context_sources: { type: 'string', description: 'What sources could create repeated or oversized LLM context here, such as chat history, documents, retrieval results, support tickets, tool output, logs, or memory?' },
    implementation_plan: { type: 'string', description: 'Write a practical 3-step SuperCompress implementation plan specific to this product. Mention the likely insertion point before the model call and what context should be compressed first.' },
    fit_rationale: { type: 'string', description: 'Why could SuperCompress be useful for this product? Be generous but evidence-based. If evidence is limited, describe the opportunity as a pilot rather than rejecting it.' }
  },
  required: ['fit_score', 'ai_workflow_strength', 'context_volume_signal', 'compression_opportunity', 'company_summary', 'ai_surface', 'context_sources', 'implementation_plan', 'fit_rationale'],
  additionalProperties: false
};

async function scoreWithContextDev(req, res) {
  try {
    const raw = typeof req.body === 'string' ? JSON.parse(req.body).url : req.body?.url;
    const domain = normalizeDomain(raw);
    const apiKey = process.env.CONTEXT_DEV_API_KEY;
    if (!apiKey) return json(res, 503, { error: 'Context.dev is not configured yet.' });
    const response = await fetch('https://api.context.dev/v1/web/extract', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `https://${domain}`,
        schema: EXTRACTION_SCHEMA,
        instructions: 'Analyze this website as a potential SuperCompress customer. Use only evidence from the public site. Keep each field concise and specific. Give a constructive, fairly optimistic fit assessment: do not reject a plausible pilot just because implementation details are not public.',
        maxPages: 5,
        maxDepth: 2,
        timeoutMS: 120000,
        stopAfterMs: 90000,
        factCheck: false,
        tags: ['supercompress-aiscore']
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return json(res, response.status === 401 ? 502 : response.status, { error: response.status === 401 ? 'Context.dev rejected the assessment key.' : 'Context.dev could not analyze that website.' });
    const extracted = payload.data && typeof payload.data === 'object' ? payload.data : {};
    const text = Object.values(extracted).join('\n');
    if (!text) return json(res, 422, { error: 'Context.dev returned no readable findings for that website.' });
    return json(res, 200, { domain, source: 'context.dev', extracted, text });
  } catch (error) {
    return json(res, 400, { error: error.message || 'We could not assess that website.' });
  }
}

module.exports = (req, res) => {
  if (req.query?.op === 'aiscore') return scoreWithContextDev(req, res);
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "GET") return json(res, 405, { detail: "Method not allowed", allow: "GET" });
  return json(res, 200, { ok: true, service: "supercompress-vercel" });
};
