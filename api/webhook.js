/**
 * POST /api/webhook — notificações da ZuckPay (urlnoty de cada cobrança).
 *
 * Duas camadas:
 * 1. Assinatura HMAC (X-ZuckPay-Signature), quando WEBHOOK_SECRET existe.
 * 2. Reconsulta do status na API: o corpo do POST nunca é a fonte da verdade.
 */
import { rota, json, env, zuckpay, kv, lerPedido, lerExternalId, primeiroNome, assinaturaValida } from '../lib/core.js';
import { PLANOS } from '../lib/config.js';

export const POST = rota(async (request) => {
  // Corpo cru ANTES do parse: o HMAC é calculado sobre os bytes exatos.
  const corpoRaw = await request.text();

  const segredo = env('WEBHOOK_SECRET');
  if (segredo) {
    const [valida, motivo] = assinaturaValida(request.headers.get('x-zuckpay-signature') || '', corpoRaw, segredo);
    if (!valida) {
      console.error('[webhook] assinatura recusada:', motivo);
      return json(401, { erro: 'Assinatura inválida.' });
    }
  } else {
    console.warn('[webhook] WEBHOOK_SECRET não configurado — validando só pela API');
  }

  let corpo = {};
  try { corpo = JSON.parse(corpoRaw) || {}; } catch { /* inválido */ }

  // Pagamento: { event, transaction: { id, ... } }. SPEI: { transactionId, ... }.
  const t = corpo.transaction && typeof corpo.transaction === 'object' ? corpo.transaction : {};
  const id = String(t.id ?? corpo.transactionId ?? corpo.transaction_id ?? '');
  const evento = String(corpo.event ?? '');

  if (!/^[A-Za-z0-9._-]{8,128}$/.test(id)) {
    console.error('[webhook] id ausente no payload:', corpoRaw.slice(0, 300));
    return json(400, { erro: 'transactionId ausente ou inválido.' });
  }

  // Eventos que não exigem entrega: responde sem gastar chamada de API.
  if (['payment_refused', 'payment_pending', 'checkout_abandoned'].includes(evento)) {
    return json(200, { ok: true, ignorado: evento });
  }

  const { status, dados } = await zuckpay('GET', `/pix/status?transactionId=${encodeURIComponent(id)}`);
  if (status !== 200 || dados.status === undefined) {
    console.error(`[webhook] falha ao verificar ${id} (HTTP ${status})`);
    return json(502, { erro: 'Não foi possível verificar a transação.' });
  }
  // Ainda não pago: 200 para a ZuckPay não ficar reenviando.
  if (String(dados.status).toUpperCase() !== 'PAID') return json(200, { ok: true, ignorado: 'nao_pago' });

  // Idempotência: a ZuckPay reenvia notificações; só a primeira segue.
  // Sem Redis (kv devolve undefined) não há como deduplicar: segue sempre.
  const primeira = await kv('SET', `pago:${id}`, new Date().toISOString(), 'NX', 'EX', 90 * 86400);
  if (primeira === null) return json(200, { ok: true, duplicado: true });

  const externalId = String(t.external_id_client ?? corpo.external_id_client ?? '');
  const pedido = (await lerPedido(externalId)) || lerExternalId(externalId) || {};
  const venda = {
    transactionId: id,
    externalId,
    plano: pedido.plano ?? null,
    metodo: pedido.metodo ?? null,
    extras: pedido.extras ?? [],
    primeiro_nome: pedido.primeiro_nome || primeiroNome(t.nome),
    valor: dados.amount ?? t.amount ?? pedido.valor ?? null,
    confirmado_em: dados.confirmed_date ?? t.confirmed_date ?? null,
    registrado_em: new Date().toISOString(),
  };

  // Aparece nos logs da Vercel (sem e-mail, CPF ou telefone).
  console.log('[venda]', JSON.stringify({ ...venda, plano_nome: PLANOS[venda.plano]?.nome ?? null }));

  /*
   * TODO — entrega do produto (e-mail com o link / liberação de acesso).
   * Roda uma vez por transação (com Redis). venda.plano e venda.extras dizem
   * o que entregar; o e-mail do comprador está em t.email / dados.email.
   */

  return json(200, { ok: true });
});
