/**
 * Utilitários compartilhados pelas funções em api/.
 * Tudo que envolve credencial roda só aqui, no servidor.
 */
import crypto from 'node:crypto';
import { PLANOS, EXTRAS, PREFIXO, DESCONTO_CARTAO } from './config.js';

/* ------------------------------------------------------------------ */
/* Ambiente                                                            */
/* ------------------------------------------------------------------ */

export const env = (nome, padrao = '') => (process.env[nome] ?? '').trim() || padrao;

// Base da API. A ZuckPay diverge entre www e sem www: com o host errado ela
// responde um redirect e o POST autenticado se perde (ver diagnostico).
export const apiBase = () => env('ZUCKPAY_API_BASE', 'https://www.zuckpay.com.br/conta/v3').replace(/\/+$/, '');

const debugLigado = () => env('DEBUG') === '1';

/* ------------------------------------------------------------------ */
/* Respostas                                                           */
/* ------------------------------------------------------------------ */

export const json = (status, dados, cabecalhos = {}) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cabecalhos },
  });

/** Erro que as funções lançam para responder e encerrar. */
export class Falha extends Error {
  constructor(status, dados) { super(dados.erro || 'erro'); this.status = status; this.dados = dados; }
}

/** Envolve um handler: Falha vira resposta; qualquer outra exceção vira 500 genérico. */
export const rota = (fn) => async (request) => {
  try {
    return await fn(request);
  } catch (e) {
    if (e instanceof Falha) return json(e.status, e.dados);
    const ref = crypto.randomBytes(4).toString('hex');
    console.error(`[erro] ref=${ref}`, e);
    return json(500, { erro: 'Erro inesperado. Tente novamente em instantes.', ref });
  }
};

export async function corpoJson(request) {
  try {
    const dados = await request.json();
    return dados && typeof dados === 'object' ? dados : {};
  } catch {
    return {};
  }
}

export const ipDe = (request) =>
  (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || '0.0.0.0';

/* ------------------------------------------------------------------ */
/* ZuckPay                                                             */
/* ------------------------------------------------------------------ */

/**
 * Chamada autenticada à API. O client_secret nunca sai do servidor.
 *
 * Redirects NÃO são seguidos: seguir um 3xx num POST autenticado reenviaria
 * o Authorization a outro host e o corpo costuma se perder. O destino é
 * devolvido para o api_base ser corrigido.
 *
 * @returns {Promise<{status:number, dados:object, redirect:string}>}
 */
// Só estes hosts recebem as credenciais, mesmo quando a própria ZuckPay
// informa um endpoint absoluto (ex.: nationalCard.endpoint do /card/keys).
const HOSTS_ZUCKPAY = new Set(['www.zuckpay.com.br', 'zuckpay.com.br']);

export async function zuckpay(metodo, caminho, payload) {
  let url = apiBase() + caminho;
  if (/^https:\/\//i.test(caminho)) {
    try {
      if (!HOSTS_ZUCKPAY.has(new URL(caminho).hostname)) throw new Error('host');
      url = caminho;
    } catch {
      console.error('[zuckpay] endpoint recusado (host fora da ZuckPay):', caminho);
      return { status: 0, dados: {}, redirect: '' };
    }
  }

  const id = env('CLIENT_ID', env('ZUCKPAY_CLIENT_ID'));
  const segredo = env('CLIENT_SECRET', env('ZUCKPAY_CLIENT_SECRET'));
  if (!id || !segredo) {
    console.error('[zuckpay] CLIENT_ID / CLIENT_SECRET não configurados');
    return { status: 0, dados: {}, redirect: '' };
  }

  const cabecalhos = {
    Accept: 'application/json',
    Authorization: 'Basic ' + Buffer.from(`${id}:${segredo}`).toString('base64'),
  };
  if (payload) cabecalhos['Content-Type'] = 'application/json';

  let resp;
  try {
    resp = await fetch(url, {
      method: metodo,
      headers: cabecalhos,
      body: payload ? JSON.stringify(payload) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    console.error('[zuckpay] falha de conexão:', e.message);
    return { status: 0, dados: {}, redirect: '' };
  }

  const redirect = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') || '' : '';
  if (redirect) console.error(`[zuckpay] HTTP ${resp.status} -> ${redirect} (confira ZUCKPAY_API_BASE)`);

  let dados = {};
  try { dados = await resp.json(); } catch { /* corpo não-JSON */ }
  return { status: resp.status, dados: dados && typeof dados === 'object' ? dados : {}, redirect };
}

/**
 * Como a ZuckPay diz que o cartão está configurado PARA ESTAS credenciais
 * (GET /card/keys). Guardado 5 min na memória da função.
 *
 * @returns {Promise<{status:number, habilitado:boolean|null, endpoint:string, resumo:object}>}
 */
let cacheCartao = null;
export async function configCartao() {
  if (cacheCartao && cacheCartao.expira > Date.now()) return cacheCartao.valor;
  const { status, dados } = await zuckpay('GET', '/card/keys');
  const nc = dados.nationalCard && typeof dados.nationalCard === 'object' ? dados.nationalCard : {};
  const valor = {
    status,
    // Desligado só quando a ZuckPay diz isso: enabled:false, ou 403/503 no
    // próprio /card/keys ("Pagamento via cartão está desativado."). Falha de
    // rede ou formato inesperado = desconhecido (null): não bloqueia.
    habilitado: status === 200 && typeof nc.enabled === 'boolean' ? nc.enabled
      : status === 403 || status === 503 ? false : null,
    endpoint: typeof nc.endpoint === 'string' ? nc.endpoint : '',
    // Resumo para logs/diagnóstico (sem a publishableKey).
    resumo: status === 200
      ? { gateway: dados.gateway ?? null, nationalCard: { enabled: nc.enabled ?? null, mode: nc.mode ?? null, requires: nc.requires ?? null, endpoint: nc.endpoint ?? null }, stripe: { enabled: dados.stripe?.enabled ?? null } }
      : { http: status, mensagem: dados.message ?? dados.erro ?? null },
  };
  // Guarda respostas definitivas (inclusive "desativado"); falha de rede não.
  if (status === 200 || status === 403 || status === 503) cacheCartao = { valor, expira: Date.now() + 5 * 60 * 1000 };
  return valor;
}

/* ------------------------------------------------------------------ */
/* Redis (Upstash, via REST) — opcional                                */
/* ------------------------------------------------------------------ */

const kvUrl = () => env('KV_REST_API_URL', env('UPSTASH_REDIS_REST_URL'));
const kvToken = () => env('KV_REST_API_TOKEN', env('UPSTASH_REDIS_REST_TOKEN'));
export const kvConfigurado = () => Boolean(kvUrl() && kvToken());

/** Executa um comando Redis. Sem Redis configurado (ou com erro), devolve undefined. */
export async function kv(...comando) {
  if (!kvConfigurado()) return undefined;
  try {
    const r = await fetch(kvUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(comando),
      signal: AbortSignal.timeout(5000),
    });
    const dados = await r.json();
    if (dados.error) throw new Error(dados.error);
    return dados.result;
  } catch (e) {
    console.error('[kv]', comando[0], e.message);
    return undefined;
  }
}

/**
 * Limite de tentativas por IP numa janela. Sem Redis, não limita (e avisa no
 * log): melhor vender sem o limite do que bloquear todo mundo.
 */
export async function dentroDoLimite(acao, ip, maximo, janela) {
  const chave = `limite:${acao}:${crypto.createHash('sha1').update(ip).digest('hex')}`;
  const total = await kv('INCR', chave);
  if (total === undefined) {
    console.warn(`[limite] Redis não configurado: sem limite de tentativas para ${acao}`);
    return true;
  }
  if (total === 1) await kv('EXPIRE', chave, janela);
  return total <= maximo;
}

/* ------------------------------------------------------------------ */
/* Validação                                                           */
/* ------------------------------------------------------------------ */

export function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let pos = 9; pos < 11; pos++) {
    let soma = 0;
    for (let i = 0; i < pos; i++) soma += Number(cpf[i]) * (pos + 1 - i);
    if (((10 * soma) % 11) % 10 !== Number(cpf[pos])) return false;
  }
  return true;
}

/** Algoritmo de Luhn: descarta número de cartão digitado errado antes da API. */
export function luhnValido(numero) {
  let soma = 0, dobrar = false;
  for (let i = numero.length - 1; i >= 0; i--) {
    let d = Number(numero[i]);
    if (dobrar) { d *= 2; if (d > 9) d -= 9; }
    soma += d;
    dobrar = !dobrar;
  }
  return soma % 10 === 0;
}

/** "maria clara" -> "Maria". Só letras, até 20 caracteres. */
export function primeiroNome(nome) {
  const p = String(nome || '').trim().split(/\s+/)[0].replace(/[^\p{L}'-]/gu, '').slice(0, 20);
  return p ? p[0].toLocaleUpperCase('pt-BR') + p.slice(1).toLocaleLowerCase('pt-BR') : '';
}

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

/* ------------------------------------------------------------------ */
/* Pedido                                                              */
/* ------------------------------------------------------------------ */

/**
 * external_id_client carrega o que foi comprado, em códigos de 1 letra:
 *   PQC-<plano><metodo>-<extras>-<pedido>    ex.: PQC-cp-kn-3f2a...
 * Assim o webhook sabe o que entregar mesmo sem banco de dados.
 */
export function montarExternalId(planoId, metodo, extrasIds, pedido) {
  const extras = extrasIds.map((id) => EXTRAS[id].codigo).join('') || '0';
  return `${PREFIXO}-${PLANOS[planoId].codigo}${metodo === 'cartao' ? 'c' : 'p'}-${extras}-${pedido}`;
}

export function lerExternalId(externalId) {
  const m = /^[A-Z]+-([a-z])([cp])-([a-z0]+)-[A-Za-z0-9-]+$/.exec(String(externalId || ''));
  if (!m) return null;
  const plano = Object.keys(PLANOS).find((id) => PLANOS[id].codigo === m[1]);
  if (!plano) return null;
  const extras = m[3] === '0' ? [] : [...m[3]].map((c) => Object.keys(EXTRAS).find((id) => EXTRAS[id].codigo === c)).filter(Boolean);
  return { plano, metodo: m[2] === 'c' ? 'cartao' : 'pix', extras };
}

/**
 * Valida plano, extras e comprador e calcula o valor NO SERVIDOR.
 * Lança Falha(400/422) quando algo não bate.
 */
export function montarPedido(corpo, metodo) {
  const planoId = typeof corpo.plano === 'string' ? corpo.plano : '';
  if (!Object.hasOwn(PLANOS, planoId)) throw new Falha(400, { erro: 'Plano inválido.' });
  const plano = PLANOS[planoId];

  const pedidos = corpo.extras ?? [];
  if (!Array.isArray(pedidos) || pedidos.length > Object.keys(EXTRAS).length) throw new Falha(400, { erro: 'Extras inválidos.' });
  const extrasIds = [];
  for (const id of pedidos) {
    if (typeof id !== 'string' || !Object.hasOwn(EXTRAS, id)) throw new Falha(400, { erro: 'Extras inválidos.' });
    if (!extrasIds.includes(id)) extrasIds.push(id);
  }

  const bruto = plano.centavos + extrasIds.reduce((s, id) => s + EXTRAS[id].centavos, 0);
  const desconto = metodo === 'cartao' ? Math.round(bruto * DESCONTO_CARTAO) : 0;
  const centavos = bruto - desconto;
  const itens = [plano.nome, ...extrasIds.map((id) => EXTRAS[id].nome)];

  const nome = String(corpo.nome ?? '').trim();
  const cpf = soDigitos(corpo.cpf);
  const email = String(corpo.email ?? '').trim();
  const telefone = soDigitos(corpo.telefone);

  const campos = {};
  if (nome.length < 3 || nome.length > 100) campos.nome = 'Informe seu nome completo.';
  if (!cpfValido(cpf)) campos.cpf = 'CPF inválido.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 150) campos.email = 'E-mail inválido.';
  if (telefone.length < 10 || telefone.length > 11) campos.telefone = 'Telefone inválido. Use DDD + número.';
  if (Object.keys(campos).length) throw new Falha(422, { erro: 'Dados inválidos.', campos });

  // Idempotência: o mesmo "pedido" (clique duplo, recarregar) devolve a mesma
  // cobrança na ZuckPay em vez de criar — ou cobrar — outra.
  let pedido = String(corpo.pedido ?? '').replace(/[^A-Za-z0-9-]/g, '');
  if (pedido.length < 8 || pedido.length > 60) pedido = crypto.randomBytes(12).toString('hex');

  const externalId = montarExternalId(planoId, metodo, extrasIds, pedido);

  const payload = {
    nome, cpf, email, telefone,
    valor: centavos / 100,
    descricao: (itens.join(' + ') + (desconto ? ' (5% off no cartão)' : '')).slice(0, 250),
    external_id_client: externalId,
  };
  const productId = Number(env(plano.productIdEnv));
  if (productId) payload.product_id = productId;

  const rastreio = corpo.rastreio && typeof corpo.rastreio === 'object' ? corpo.rastreio : {};
  for (const chave of ['utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'utm_term',
    'fbc', 'fbp', 'fbclid', 'gclid', 'ttclid', 'wbraid', 'gbraid', 'kclid', 'click_id', 'src', 'sck']) {
    const v = rastreio[chave];
    if (typeof v === 'string' && v) payload[chave] = v.slice(0, 255);
  }

  return { planoId, plano, extrasIds, itens, centavos, desconto, nome, pedido, externalId, payload };
}

/** URL pública do webhook: SITE_URL, ou a origem desta requisição. */
export const urlWebhook = (request) => (env('SITE_URL') || new URL(request.url).origin).replace(/\/+$/, '') + '/api/webhook';

/** Guarda plano/extras/primeiro nome do pedido (7 dias) para o webhook. */
export const registrarPedido = (externalId, dados) =>
  kv('SET', `pedido:${externalId}`, JSON.stringify(dados), 'EX', 7 * 86400);

export async function lerPedido(externalId) {
  const bruto = externalId ? await kv('GET', `pedido:${externalId}`) : null;
  try { return bruto ? JSON.parse(bruto) : null; } catch { return null; }
}

/** Detalhe do erro, só com DEBUG=1 (e nunca com dados do cartão). */
export const detalheDebug = (dados) => (debugLigado() ? { debug: dados } : {});

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */

/**
 * X-ZuckPay-Signature: t=<timestamp>,v1=<hmac_sha256_hex>
 * HMAC-SHA256("<timestamp>.<corpo_raw>", WEBHOOK_SECRET), janela de 5 min.
 */
export function assinaturaValida(header, corpoRaw, segredo) {
  if (!header) return [false, 'header X-ZuckPay-Signature ausente'];
  const partes = Object.fromEntries(header.split(',').map((p) => p.split('=').map((s) => s.trim())));
  const ts = partes.t || '', v1 = partes.v1 || '';
  if (!/^\d+$/.test(ts) || !/^[a-f0-9]{64}$/i.test(v1)) return [false, 'header malformado'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return [false, 'timestamp fora da janela de 5 minutos'];
  const esperado = crypto.createHmac('sha256', segredo).update(`${ts}.${corpoRaw}`).digest();
  const recebido = Buffer.from(v1, 'hex');
  if (recebido.length !== esperado.length || !crypto.timingSafeEqual(esperado, recebido)) return [false, 'assinatura não confere'];
  return [true, ''];
}
