# Pro Hunters — Portal Interno

## Estrutura de arquivos

```
prohunters-portal/
├── api/
│   └── index.js               ← handler serverless (não mexer)
├── vercel.json                ← configuração do Vercel (não mexer)
├── config.js                  ← ÚNICO arquivo que você edita
├── package.json               ← configuração do projeto
├── dashboard_prohunters.html  ← o dashboard (atualizado pelo Claude)
└── README.md
```

---

## O que editar no config.js

| Campo | O que faz |
|-------|-----------|
| `anthropicKey` | Chave da API — troque se gerar uma nova |
| `model` | `claude-sonnet-4-6` (padrão) ou `claude-haiku-4-5-20251001` (mais barato) |
| `maxTokens` | Tamanho das respostas (padrão 1000) |
| `sessionHours` | Horas que o login fica ativo (padrão 8h) |
| `users` | Lista de usuários — adicione ou remova linhas |

---

## Gerenciar usuários

```js
users: [
  { usuario: 'luis',    senha: 'phunters2025', nome: 'Luis'     },
  { usuario: 'vendas',  senha: 'vendas2025',   nome: 'Vendedor'  },
]
```

---

## Deploy — GitHub + Vercel

### Primeira vez

1. Suba a pasta num repositório GitHub **privado**
2. Acesse vercel.com → **Add New Project** → selecione o repositório
3. Clique em **Deploy** — Vercel detecta o Node.js automaticamente
4. Ao terminar, você recebe a URL pública (ex: `prohunters.vercel.app`)
5. Compartilhe a URL com a equipe

### Atualizar depois (novo dashboard, novo usuário, nova regra)

```bash
git add .
git commit -m "descrição da mudança"
git push
```

Vercel redeploya automaticamente em ~30 segundos.

---

## Credenciais padrão

| Usuário | Senha | Perfil |
|---------|-------|--------|
| luis | phunters2025 | Luis |
| vendas | vendas2025 | Vendedor |
| admin | admin2025 | Admin |

> Altere as senhas no `config.js` após o primeiro acesso.

---

## Fluxo de acesso

```
Acessa a URL → Tela de login → Digita usuário + senha
→ Servidor valida → Sessão criada → Dashboard carrega
→ Sessão expira após 8h → Login novamente
```
