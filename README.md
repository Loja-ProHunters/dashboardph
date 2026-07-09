# Pro Hunters — Portal Interno

## Estrutura de arquivos

```
prohunters-portal/
├── server.js                  ← servidor (não mexer)
├── config.js                  ← ÚNICO arquivo que você edita
├── package.json               ← configuração do projeto
└── dashboard_prohunters.html  ← o dashboard
```

---

## Rodar localmente

```bash
node server.js
```
Acesse: http://localhost:3000

---

## O que você pode mudar no config.js

| Campo | O que faz |
|-------|-----------|
| `anthropicKey` | Chave da API — troque se gerar uma nova |
| `model` | `claude-sonnet-4-6` ou `claude-haiku-4-5-20251001` (mais barato) |
| `maxTokens` | Tamanho das respostas (padrão 1000) |
| `port` | Porta do servidor (padrão 3000) |
| `sessionHours` | Horas que o login fica ativo (padrão 8h) |
| `users` | Lista de usuários — adicione ou remova à vontade |

Após editar → **Ctrl+C** para parar → `node server.js` para reiniciar.

---

## Gerenciar usuários (config.js)

```js
users: [
  { usuario: 'luis',   senha: 'suasenha',   nome: 'Luis'     },
  { usuario: 'vendas', senha: 'outrasenha', nome: 'Vendedor'  },
]
```

Adicione uma linha por pessoa. Reinicie o servidor após salvar.

---

## Deploy — GitHub + Vercel

### 1. Adicionar vercel.json na pasta do projeto

Crie um arquivo `vercel.json` com o conteúdo abaixo — ele diz ao Vercel para rodar o server.js:

```json
{
  "version": 2,
  "builds": [{ "src": "server.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "server.js" }]
}
```

### 2. Subir para o GitHub

```bash
git init
git add .
git commit -m "Portal Pro Hunters"
git remote add origin https://github.com/SEU_USUARIO/prohunters-portal.git
git push -u origin main
```

> Use um repositório **privado** — o config.js com a chave API e senhas fica protegido.

### 3. Conectar ao Vercel

1. Acesse https://vercel.com e faça login com sua conta GitHub
2. Clique em **Add New → Project**
3. Selecione o repositório `prohunters-portal`
4. Clique em **Deploy** — Vercel detecta o Node.js automaticamente
5. Ao finalizar, você recebe uma URL pública (ex: `prohunters.vercel.app`)
6. Compartilhe essa URL com a equipe

### 4. Atualizar depois

Sempre que quiser atualizar (novo dashboard, novo usuário, nova regra):

```bash
git add .
git commit -m "descrição da mudança"
git push
```

O Vercel detecta o push e redeploya automaticamente em ~30 segundos.

---

## Fluxo de acesso

```
Vendedor acessa a URL
        ↓
   Tela de login
        ↓
   Digita usuário + senha
        ↓
   Servidor valida → sessão criada (cookie seguro)
        ↓
   Dashboard carrega
        ↓
   Sessão expira após X horas (configurável)
```
