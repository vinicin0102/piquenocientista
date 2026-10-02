# Guia +100 Experimentos Científicos para Fazer com Seu Filho 🧪🔬

Página de vendas de alta conversão para o produto digital **Guia +100 Experimentos Científicos para Fazer com Seu Filho**.

## 🚀 Sobre o Projeto
Uma página moderna, responsiva e focada na transformação familiar: trocar o tempo excessivo nas telas por experiências práticas, divertidas e educativas entre pais e filhos.

### ✨ Recursos da Página
- **Headline Emocional & Direta**: Focada na dor real dos pais (tempo de qualidade vs. telas).
- **Showcase de Categorias**: 8 áreas temáticas de experimentos (Água, Cores, Ar, Magnetismo, Reações, Luz & Som, Natureza, Descobertas do Dia a Dia).
- **Exemplo Prático**: Demonstração completa do experimento "Vulcão Caseiro" com materiais, passo a passo, explicação científica e desafio.
- **Quebra de Objeções**: Seções desmistificando a necessidade de conhecimento prévio ou materiais caros.
- **Seção de Oferta & Bônus**: Card de checkout claro com ancoragem de valor (R$ 9,90) e 4 bônus inclusos.
- **FAQ Interativo**: Accordion com as dúvidas mais comuns respondidas de forma transparente.
- **Responsividade & UX Mobile**: Botão Sticky CTA para conversão em smartphones.

## 🛠️ Tecnologias
- HTML5 Semântico
- CSS3 Moderno (Custom Properties, Flexbox, Grid, Animações Suaves)
- JavaScript Vanilla (Interatividade do FAQ, animações de scroll e sticky CTA)
- Google Fonts (Baloo 2 & Nunito)

---
Desenvolvido para máxima conversão e experiência de usuário fluida.

## 💳 Checkout (ZuckPay)

Mesma estrutura dos outros projetos: a página abre um checkout próprio e as
funções em `api/` (Vercel, Node 20+, sem dependências) falam com a ZuckPay.
No checkout, o comprador preenche os dados e escolhe a forma de pagamento; só
então aparecem os order bumps e o botão de pagar.

```
index.html                página + modal de checkout (PLANOS / EXTRAS no fim do HTML)
lib/config.js             planos, order bumps e preços (em centavos), cartão
lib/core.js               chamada à ZuckPay, validações, Redis, assinatura do webhook
api/pix.js                POST /api/pix             cria a cobrança PIX
api/cartao.js             POST /api/cartao          cobra no cartão (desligado: CARTAO_ATIVO=false)
api/status.js             GET  /api/status          situação do pagamento
api/webhook.js            POST /api/webhook         confirmação da ZuckPay
api/formas-pagamento.js   GET  /api/formas-pagamento PIX / cartão disponíveis
api/diagnostico.js        GET  /api/diagnostico     confere a configuração (com token)
```

**Planos:** Essencial R$ 9,90 e Completo R$ 27,00.
**Order bumps (nos dois planos):** Kit Cientista em Casa (R$ 4,90),
50 Atividades Educativas Sem Tela (R$ 5,90), Desafios do Pequeno Cientista
(R$ 4,90), Caderno de Experimentos (R$ 3,90), Passaporte do Pequeno Cientista
(R$ 4,90), Kit Experimentos com Cores (R$ 4,90) e Pequeno Cientista — Natureza
(R$ 4,90).

Quem cobra é o servidor (`lib/config.js`). Se mudar preço ou extra lá, mude
também `PLANOS` / `EXTRAS` no fim do `index.html` e os cards da oferta.

### Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Variável | Obrigatória | Para quê |
|---|---|---|
| `CLIENT_ID`, `CLIENT_SECRET` | sim | Credenciais da API ZuckPay. |
| `WEBHOOK_SECRET` | recomendada | *Integrações > Webhook Secret* no painel. Com ela, o webhook recusa POST que não venha da ZuckPay. |
| `SITE_URL` | recomendada | Ex.: `https://seudominio.com.br`. Base da URL do webhook enviada em cada cobrança. |
| `PRODUCT_ID_ESSENCIAL`, `PRODUCT_ID_COMPLETO` | opcional | Ids dos produtos no painel (vincula as vendas nos relatórios). |
| `ZUCKPAY_API_BASE` | opcional | Padrão `https://www.zuckpay.com.br/conta/v3`. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | recomendada | Redis (Upstash): deduplica o webhook e limita tentativas no cartão. |
| `DEBUG_TOKEN` | opcional | Libera `/api/diagnostico?token=...`. Sem ela, responde 404. |
| `DEBUG` | não em produção | `1` devolve o erro real da ZuckPay para a página. |

Depois de mudar variáveis, faça um **Redeploy**. Cadastre
`https://SEU-SITE/api/webhook` no painel da ZuckPay.

**Pendente — entrega do produto:** o `TODO` em `api/webhook.js` é onde entra o
envio do material (e-mail com o link, liberação do app/PDF e dos extras).
O `external_id_client` (ex.: `PQC-cp-kn-<pedido>`) diz o plano, a forma de
pagamento e os extras comprados.
