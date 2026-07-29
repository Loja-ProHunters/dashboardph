# 🔍 DIAGNÓSTICO DO ERRO - API KEY UNDEFINED

## ❌ ERRO QUE VOCÊ ENCONTROU:
```
Erro ao extrair dados da NF: Invalid value "undefined" for header "x-api-key"
```

---

## 🎯 CAUSA RAIZ:

A variável de ambiente `ANTHROPIC_API_KEY` não está sendo lida corretamente no `config.js`.

O arquivo `config.js` está tentando ler:
```javascript
anthropicApiKey: process.env.ANTHROPIC_API_KEY || ''
```

Mas retorna vazio ou undefined, e o código tenta usar isso como header.

---

## ✅ SOLUÇÃO APLICADA:

O arquivo `config.js` foi atualizado para:
```javascript
anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
```

E em `api/index.js`, o código que usa a chave foi revisado para:
1. Verificar se a chave existe
2. Se não existir, retornar erro apropriado

---

## 🔐 IMPORTANTE:

**Para o sistema funcionar 100%, você DEVE:**

1. Abra https://vercel.com/Loja-ProHunters/dashboardph
2. Vá para "Settings" → "Environment Variables"
3. Verifique se existe: `ANTHROPIC_API_KEY`
4. Se não existir, clique "Add" e adicione:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** [sua chave de API da Anthropic]
5. Clique "Save"
6. Vercel vai fazer redeploy automaticamente

---

## 📝 SEM A CHAVE:
- ❌ Extração de dados de NF (IA)
- ❌ Extração de dados de Pedido (IA)
- ✅ Tudo o resto funciona normal

## COM A CHAVE:
- ✅ **TUDO** funciona 100%

---

## 📞 PRÓXIMAS AÇÕES:

1. Upload os arquivos do ZIP
2. Adicione a ANTHROPIC_API_KEY em Vercel Settings
3. Teste o portal
4. Deve funcionar perfeitamente!

