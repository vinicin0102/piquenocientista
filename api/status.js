/**
 * GET /api/status?transactionId=... — situação da cobrança (PIX e cartão).
 * -> { status, pago, final, proxima_consulta }
 */
import { rota, json, zuckpay, kv } from '../lib/core.js';

export const GET = rota(async (request) => {
  const id = new URL(request.url).searchParams.get('transactionId') || '';
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(id)) return json(400, { erro: 'transactionId inválido.' });

  // Cache curto: várias abas consultando não estouram o rate limit da ZuckPay.
  const cache = await kv('GET', `status:${id}`);
  if (cache) return json(200, { ...JSON.parse(cache), cache: true });

  const { status, dados } = await zuckpay('GET', `/pix/status?transactionId=${encodeURIComponent(id)}`);

  // 429 = rate limit: pede à página para consultar mais devagar.
  if (status === 429) return json(200, { status: 'PENDING', pago: false, final: false, proxima_consulta: 30 });
  if (status !== 200 || dados.status === undefined) {
    console.error(`[status] HTTP ${status} para ${id}`);
    return json(502, { erro: 'Não foi possível consultar o pagamento.' });
  }

  const situacao = String(dados.status).toUpperCase();
  const saida = {
    status: situacao,
    pago: situacao === 'PAID',
    final: ['PAID', 'FAILED', 'REFUSED', 'EXPIRADO', 'REFUNDED'].includes(situacao),
    proxima_consulta: 5,
  };
  await kv('SET', `status:${id}`, JSON.stringify(saida), 'EX', 8);
  return json(200, saida);
});
