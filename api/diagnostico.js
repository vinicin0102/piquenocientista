/**
 * GET /api/diagnostico?token=... — confere a configuração sem cobrar nada.
 * Só responde com a variável DEBUG_TOKEN definida e o token certo.
 */
import crypto from 'node:crypto';
import { rota, json, env, apiBase, zuckpay, kvConfigurado, kv, configCartao } from '../lib/core.js';

const mascarar = (v) => (v ? v.slice(0, 4) + '…' + v.slice(-2) : '(vazio)');

export const GET = rota(async (request) => {
  const token = env('DEBUG_TOKEN');
  const recebido = new URL(request.url).searchParams.get('token') || '';
  const iguais = token && recebido.length === token.length &&
    crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(token));
  if (!iguais) return new Response('Not Found', { status: 404 });

  const r = {
    client_id: mascarar(env('CLIENT_ID', env('ZUCKPAY_CLIENT_ID'))),
    client_secret: env('CLIENT_SECRET', env('ZUCKPAY_CLIENT_SECRET')) ? 'definido' : '(vazio)',
    api_base: apiBase(),
    webhook_secret: env('WEBHOOK_SECRET') ? 'definido' : 'AUSENTE — webhook validado só pela API',
    site_url: env('SITE_URL') || '(origem da requisição)',
    product_ids: { essencial: env('PRODUCT_ID_ESSENCIAL') || '(nenhum)', completo: env('PRODUCT_ID_COMPLETO') || '(nenhum)' },
    redis: kvConfigurado() ? ((await kv('PING')) === 'PONG' ? 'OK' : 'configurado, mas sem resposta') : 'AUSENTE — sem limite de cartão e deduplicação do webhook',
  };

  // Chamada sem efeito colateral: lista os gateways de cartão da conta.
  const { status, dados, redirect } = await zuckpay('GET', '/card/keys');
  r.zuckpay = redirect ? `REDIRECIONAMENTO para ${redirect} — ajuste ZUCKPAY_API_BASE`
    : status === 200 ? 'OK (credenciais aceitas)'
    : status === 401 ? 'NAO AUTORIZADO — CLIENT_ID/CLIENT_SECRET errados'
    : status === 403 ? 'BLOQUEADO — IP whitelist ou permissão'
    : status === 0 ? 'FALHA DE CONEXÃO' : `HTTP ${status}`;
  r.cartao_nacional = dados.nationalCard?.enabled === true ? 'habilitado' : 'NÃO habilitado na conta';
  r.card_keys = (await configCartao()).resumo;

  return json(200, r);
});
