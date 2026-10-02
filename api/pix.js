/**
 * POST /api/pix — cria a cobrança PIX.
 * { plano, extras?, pedido?, nome, cpf, email, telefone, rastreio? }
 * -> { transactionId, qrcode, qrcode_image, expiracao, valor, itens, pedido }
 */
import { rota, json, corpoJson, montarPedido, zuckpay, urlWebhook, registrarPedido, primeiroNome, detalheDebug } from '../lib/core.js';
import crypto from 'node:crypto';

export const POST = rota(async (request) => {
  const p = montarPedido(await corpoJson(request), 'pix');
  const payload = { ...p.payload, urlnoty: urlWebhook(request) };

  const { status, dados } = await zuckpay('POST', '/pix/qrcode', payload);

  if (status === 429) return json(429, { erro: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.' });
  if (status === 403) {
    console.error('[pix] HTTP 403 — provável IP whitelist bloqueando o servidor');
    return json(502, { erro: 'Pagamento indisponível no momento. Já estamos verificando.' });
  }
  if (status !== 200 || !dados.transactionId) {
    const ref = crypto.randomBytes(4).toString('hex');
    console.error(`[pix] ref=${ref} HTTP ${status}`, JSON.stringify(dados));
    return json(502, {
      erro: 'Não foi possível gerar o PIX agora. Tente novamente em instantes.', ref,
      ...detalheDebug({ http: status, resposta: dados }),
    });
  }

  await registrarPedido(p.externalId, {
    plano: p.planoId, metodo: 'pix', primeiro_nome: primeiroNome(p.nome), extras: p.extrasIds, valor: p.centavos / 100,
  });

  // Só o que o navegador precisa: nada de credencial, nada de valor líquido.
  return json(200, {
    transactionId: String(dados.transactionId),
    qrcode: String(dados.qrcode ?? dados.pix_code ?? ''),
    qrcode_image: String(dados.qrcode_image ?? ''),
    expiracao: Number(dados.calendar?.expiration ?? 1200),
    valor: p.centavos / 100,
    itens: p.itens,
    pedido: p.pedido,
  });
});
