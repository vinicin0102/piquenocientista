/**
 * GET /api/formas-pagamento -> { pix: true, cartao: boolean }
 *
 * A página só mostra o cartão (e o "5% OFF") quando a ZuckPay diz que ele
 * está ativo para a conta. Quando a ZuckPay ativar, o cartão aparece sozinho.
 */
import { rota, json, configCartao } from '../lib/core.js';
import { CARTAO_ATIVO } from '../lib/config.js';

export const GET = rota(async () => {
  if (!CARTAO_ATIVO) return json(200, { pix: true, cartao: false }, { 'Cache-Control': 'public, s-maxage=120' });
  const { habilitado } = await configCartao();
  // Desconhecido (null) conta como disponível: a cobrança trata o erro.
  return json(200, { pix: true, cartao: habilitado !== false }, { 'Cache-Control': 'public, s-maxage=120' });
});
